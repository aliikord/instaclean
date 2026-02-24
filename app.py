"""
InstaClean — Instagram Follow Request Manager
Flask web application.
"""

import json
import time
import random
import queue
import threading
import os
import re
import zipfile
import io
from functools import wraps
from urllib.parse import unquote

from flask import (
    Flask, render_template, request, jsonify,
    session, redirect, url_for, Response, stream_with_context,
)
from config import Config
from instagram_api import (
    InstagramAPI, InstagramAPIError,
    RateLimitError, AuthenticationError,
)

app = Flask(__name__)
app.config.from_object(Config)

# In-memory store for active tasks (auto-cleaned after 10 min)
cancel_tasks = {}


def _cleanup_old_tasks():
    """Remove tasks older than 10 minutes to prevent memory leaks."""
    now = time.time()
    expired = [k for k, v in cancel_tasks.items()
               if now - float(k.split("_")[-1]) > 600]
    for k in expired:
        cancel_tasks.pop(k, None)
    threading.Timer(300, _cleanup_old_tasks).start()

_cleanup_old_tasks()


# ------------------------------------------------------------------
# Auth helper
# ------------------------------------------------------------------

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "ig_session_id" not in session:
            if request.path.startswith("/api/"):
                return jsonify({"error": "Not logged in", "auth_expired": True}), 401
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated


def get_ig_api():
    return InstagramAPI(
        session_id=session["ig_session_id"],
        ds_user_id=session["ig_ds_user_id"],
        csrf_token=session["ig_csrf_token"],
    )


# ------------------------------------------------------------------
# Pages
# ------------------------------------------------------------------

@app.route("/")
def index():
    if "ig_session_id" in session:
        return redirect(url_for("dashboard"))
    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        return render_template("login.html")

    data = request.form if request.form else request.get_json()
    session_id = (data.get("session_id") or "").strip()
    ds_user_id = (data.get("ds_user_id") or "").strip()
    csrf_token = (data.get("csrf_token") or "").strip()

    if not all([session_id, ds_user_id, csrf_token]):
        return jsonify({"error": "All three cookies are required."}), 400

    try:
        api = InstagramAPI(session_id, ds_user_id, csrf_token)
        user_info = api.validate_session()
    except AuthenticationError as e:
        return jsonify({"error": str(e)}), 401
    except Exception as e:
        return jsonify({"error": f"Connection error: {e}"}), 500

    session.permanent = True
    session["ig_session_id"] = session_id
    session["ig_ds_user_id"] = ds_user_id
    session["ig_csrf_token"] = csrf_token
    session["ig_username"] = user_info.get("username", "")
    session["ig_profile_pic"] = user_info.get("profile_pic_url", "")
    session["ig_user_id"] = user_info.get("user_id", "")

    return jsonify({"success": True, "username": user_info["username"]})


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"success": True})


@app.route("/dashboard")
@login_required
def dashboard():
    return render_template(
        "dashboard.html",
        username=session.get("ig_username", ""),
        profile_pic=session.get("ig_profile_pic", ""),
    )


# ------------------------------------------------------------------
# API — Data
# ------------------------------------------------------------------

@app.route("/api/extract-zip", methods=["POST"])
@login_required
def api_extract_zip():
    """Extract pending_follow_requests.html from an uploaded Instagram data export zip."""
    uploaded = request.files.get("zip_file")
    if not uploaded or not uploaded.filename:
        return jsonify({"error": "No file uploaded."}), 400

    try:
        zip_bytes = io.BytesIO(uploaded.read())
        with zipfile.ZipFile(zip_bytes, "r") as zf:
            # Find any file matching pending_follow_requests.html
            target = None
            for name in zf.namelist():
                if name.endswith("pending_follow_requests.html"):
                    target = name
                    break

            if not target:
                # List what's in the zip for debugging
                html_files = [n for n in zf.namelist() if n.endswith(".html")]
                return jsonify({
                    "error": f"Could not find pending_follow_requests.html in the zip. Found {len(html_files)} HTML files.",
                    "html_files": html_files[:20],
                }), 400

            html = zf.read(target).decode("utf-8", errors="ignore")
            usernames = []
            username_dates = {}
            # Try to extract username + date pairs
            pairs = re.findall(
                r'href="https://www\.instagram\.com/([^"/?]+)"[^<]*</a></div>\s*<div>([^<]+)</div>',
                html,
            )
            if pairs:
                for uname, date_str in pairs:
                    if uname not in usernames:
                        usernames.append(uname)
                        username_dates[uname] = date_str.strip()
            else:
                for match in re.findall(r'href="https://www\.instagram\.com/([^"/?]+)"', html):
                    if match not in usernames:
                        usernames.append(match)

            return jsonify({"usernames": usernames, "dates": username_dates, "count": len(usernames), "file": target})

    except zipfile.BadZipFile:
        return jsonify({"error": "Not a valid zip file."}), 400
    except Exception as e:
        return jsonify({"error": f"Failed to process zip: {e}"}), 500


@app.route("/api/pending-sent", methods=["POST"])
@login_required
def api_pending_sent():
    """
    Parse usernames from uploaded file or pasted text.
    Returns the usernames list — actual checking is done via SSE stream.
    """
    usernames = []

    content_type = request.content_type or ""

    username_dates = {}  # username -> date string from data export

    if "multipart/form-data" in content_type:
        uploaded = request.files.get("export_file")
        if uploaded and uploaded.filename:
            html = uploaded.read().decode("utf-8", errors="ignore")
            # Try to extract username + date pairs first
            pairs = re.findall(
                r'href="https://www\.instagram\.com/([^"/?]+)"[^<]*</a></div>\s*<div>([^<]+)</div>',
                html,
            )
            if pairs:
                for uname, date_str in pairs:
                    if uname not in usernames:
                        usernames.append(uname)
                        username_dates[uname] = date_str.strip()
            else:
                # Fallback: just usernames
                for match in re.findall(r'href="https://www\.instagram\.com/([^"/?]+)"', html):
                    if match not in usernames:
                        usernames.append(match)
        raw = request.form.get("usernames", "")
        if raw:
            for u in re.split(r'[\n,\s]+', raw):
                u = u.strip().lstrip("@")
                if u and u not in usernames:
                    usernames.append(u)
    else:
        data = request.get_json() or {}
        raw_list = data.get("usernames", [])
        for u in raw_list:
            u = u.strip().lstrip("@")
            if u and u not in usernames:
                usernames.append(u)

    if not usernames:
        return jsonify({"error": "No usernames provided."}), 400

    # Store usernames and dates in session for the SSE stream to pick up
    task_id = f"sent_{session['ig_ds_user_id']}_{int(time.time())}"
    cancel_tasks[task_id] = {
        "usernames": usernames,
        "username_dates": username_dates,
        "status": "pending",
    }

    return jsonify({"task_id": task_id, "total": len(usernames)})


@app.route("/api/check-sent/<task_id>")
@login_required
def api_check_sent(task_id):
    """SSE stream: check each username and stream results in real time."""
    task = cancel_tasks.get(task_id)
    if not task or "usernames" not in task:
        return jsonify({"error": "Task not found"}), 404

    usernames = task["usernames"]
    username_dates = task.get("username_dates", {})
    cookies = {
        "session_id": session["ig_session_id"],
        "ds_user_id": session["ig_ds_user_id"],
        "csrf_token": session["ig_csrf_token"],
    }

    def generate():
        api = InstagramAPI(cookies["session_id"], cookies["ds_user_id"], cookies["csrf_token"])
        total = len(usernames)

        for i, username in enumerate(usernames):
            user_data = {"username": username, "index": i, "total": total}
            # Include date from data export if available
            if username in username_dates:
                user_data["request_date"] = username_dates[username]

            try:
                user = api.get_user_by_username(username)
                if user:
                    try:
                        status = api.check_friendship(user["user_id"])
                        if status and status.get("outgoing_request"):
                            user["status"] = "pending"
                        elif status and status.get("following"):
                            user["status"] = "accepted"
                        else:
                            user["status"] = "not_pending"
                    except Exception:
                        user["status"] = "unknown"
                    user_data.update(user)
                else:
                    user_data.update({
                        "user_id": None, "full_name": "", "profile_pic_url": "",
                        "is_private": False, "is_verified": False, "status": "not_found",
                    })
            except RateLimitError:
                user_data["status"] = "rate_limited"
                yield f"data: {json.dumps(user_data)}\n\n"
                yield f"data: {json.dumps({'type': 'complete', 'reason': 'rate_limited'})}\n\n"
                return
            except AuthenticationError:
                user_data["status"] = "auth_error"
                yield f"data: {json.dumps(user_data)}\n\n"
                yield f"data: {json.dumps({'type': 'complete', 'reason': 'auth_error'})}\n\n"
                return
            except Exception as e:
                user_data["status"] = "error"

            yield f"data: {json.dumps(user_data)}\n\n"

            if i < total - 1:
                time.sleep(Config.FETCH_PAGE_DELAY)

        yield f"data: {json.dumps({'type': 'complete', 'reason': 'done'})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.route("/api/cancel-all-sent/<task_id>")
@login_required
def api_cancel_all_sent(task_id):
    """SSE stream: resolve each username and immediately cancel the follow request."""
    task = cancel_tasks.get(task_id)
    if not task or "usernames" not in task:
        return jsonify({"error": "Task not found"}), 404

    usernames = task["usernames"]
    username_dates = task.get("username_dates", {})
    cookies = {
        "session_id": session["ig_session_id"],
        "ds_user_id": session["ig_ds_user_id"],
        "csrf_token": session["ig_csrf_token"],
    }

    def generate():
        api = InstagramAPI(cookies["session_id"], cookies["ds_user_id"], cookies["csrf_token"])
        total = len(usernames)
        succeeded = 0
        failed = 0
        skipped = 0

        for i, username in enumerate(usernames):
            result = {"username": username, "index": i, "total": total}
            if username in username_dates:
                result["request_date"] = username_dates[username]

            try:
                user = api.get_user_by_username(username)
                if user and user.get("user_id"):
                    result["user_id"] = user["user_id"]
                    result["profile_pic_url"] = user.get("profile_pic_url", "")
                    result["full_name"] = user.get("full_name", "")
                    try:
                        api.cancel_follow_request(user["user_id"])
                        result["status"] = "cancelled"
                        succeeded += 1
                    except Exception as e:
                        result["status"] = "cancel_failed"
                        result["error"] = str(e)
                        failed += 1
                else:
                    result["status"] = "not_found"
                    skipped += 1
            except RateLimitError:
                result["status"] = "rate_limited"
                failed += 1
                result["succeeded"] = succeeded
                result["failed"] = failed
                result["skipped"] = skipped
                yield f"data: {json.dumps(result)}\n\n"
                yield f"data: {json.dumps({'type': 'complete', 'reason': 'rate_limited', 'succeeded': succeeded, 'failed': failed, 'skipped': skipped})}\n\n"
                return
            except AuthenticationError:
                result["status"] = "auth_error"
                failed += 1
                result["succeeded"] = succeeded
                result["failed"] = failed
                result["skipped"] = skipped
                yield f"data: {json.dumps(result)}\n\n"
                yield f"data: {json.dumps({'type': 'complete', 'reason': 'auth_error', 'succeeded': succeeded, 'failed': failed, 'skipped': skipped})}\n\n"
                return
            except Exception:
                result["status"] = "error"
                failed += 1

            result["succeeded"] = succeeded
            result["failed"] = failed
            result["skipped"] = skipped
            yield f"data: {json.dumps(result)}\n\n"

            if i < total - 1:
                time.sleep(random.uniform(Config.CANCEL_DELAY_MIN, Config.CANCEL_DELAY_MAX))

        yield f"data: {json.dumps({'type': 'complete', 'reason': 'done', 'succeeded': succeeded, 'failed': failed, 'skipped': skipped})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.route("/api/pending-received")
@login_required
def api_pending_received():
    """Fetch incoming pending requests — people who requested to follow YOU."""
    try:
        api = get_ig_api()
        users = api.get_incoming_pending_requests()
        return jsonify({"users": users, "count": len(users)})
    except AuthenticationError as e:
        session.clear()
        return jsonify({"error": str(e), "auth_expired": True}), 401
    except RateLimitError as e:
        return jsonify({"error": str(e)}), 429
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/not-following-back")
@login_required
def api_not_following_back():
    try:
        users = get_ig_api().get_not_following_back()
        return jsonify({"users": users, "count": len(users)})
    except AuthenticationError as e:
        session.clear()
        return jsonify({"error": str(e), "auth_expired": True}), 401
    except RateLimitError as e:
        return jsonify({"error": str(e)}), 429
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ------------------------------------------------------------------
# API — Actions (batch cancel / unfollow)
# ------------------------------------------------------------------

@app.route("/api/cancel", methods=["POST"])
@login_required
def api_cancel():
    return _start_batch(request.get_json(), "cancel")


@app.route("/api/unfollow", methods=["POST"])
@login_required
def api_unfollow():
    return _start_batch(request.get_json(), "unfollow")


def _start_batch(data, action_type):
    user_ids = data.get("user_ids", [])
    if not user_ids:
        return jsonify({"error": "No users selected."}), 400
    if len(user_ids) > Config.MAX_CANCELS_PER_SESSION:
        return jsonify({"error": f"Max {Config.MAX_CANCELS_PER_SESSION} per session."}), 400

    task_id = f"{action_type}_{session['ig_ds_user_id']}_{int(time.time())}"
    cancel_tasks[task_id] = {
        "status": "running",
        "total": len(user_ids),
        "completed": 0,
        "succeeded": 0,
        "failed": 0,
        "results": [],
        "queue": queue.Queue(),
    }

    cookies = {
        "session_id": session["ig_session_id"],
        "ds_user_id": session["ig_ds_user_id"],
        "csrf_token": session["ig_csrf_token"],
    }
    threading.Thread(
        target=_run_batch, args=(task_id, user_ids, cookies), daemon=True
    ).start()

    return jsonify({"task_id": task_id, "total": len(user_ids)})


def _run_batch(task_id, user_ids, cookies):
    task = cancel_tasks[task_id]
    api = InstagramAPI(cookies["session_id"], cookies["ds_user_id"], cookies["csrf_token"])

    for i, uid in enumerate(user_ids):
        result = {"user_id": uid, "index": i}
        try:
            api.cancel_follow_request(uid)
            result["status"] = "cancelled"
            task["succeeded"] += 1
        except RateLimitError:
            result["status"] = "rate_limited"
            task["failed"] += 1
            task["completed"] += 1
            task["results"].append(result)
            task["queue"].put(result)
            task["status"] = "rate_limited"
            task["queue"].put(None)
            return
        except AuthenticationError:
            result["status"] = "auth_error"
            task["failed"] += 1
            task["completed"] += 1
            task["results"].append(result)
            task["queue"].put(result)
            task["status"] = "auth_error"
            task["queue"].put(None)
            return
        except Exception as e:
            result["status"] = "error"
            result["error"] = str(e)
            task["failed"] += 1

        task["completed"] += 1
        task["results"].append(result)
        task["queue"].put(result)

        if i < len(user_ids) - 1:
            time.sleep(random.uniform(Config.CANCEL_DELAY_MIN, Config.CANCEL_DELAY_MAX))

    task["status"] = "completed"
    task["queue"].put(None)


# ------------------------------------------------------------------
# API — SSE progress
# ------------------------------------------------------------------

@app.route("/api/progress/<task_id>")
@login_required
def api_progress(task_id):
    task = cancel_tasks.get(task_id)
    if not task:
        return jsonify({"error": "Task not found"}), 404

    def generate():
        while True:
            try:
                result = task["queue"].get(timeout=60)
            except queue.Empty:
                yield f"data: {json.dumps({'type': 'keepalive'})}\n\n"
                continue

            if result is None:
                yield f"data: {json.dumps({'type': 'complete', 'status': task['status'], 'total': task['total'], 'succeeded': task['succeeded'], 'failed': task['failed']})}\n\n"
                break

            yield f"data: {json.dumps({'type': 'progress', 'user_id': result['user_id'], 'index': result['index'], 'result_status': result['status'], 'completed': task['completed'], 'total': task['total'], 'succeeded': task['succeeded'], 'failed': task['failed']})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# ------------------------------------------------------------------
# API — Image proxy (Instagram blocks cross-origin image loading)
# ------------------------------------------------------------------

@app.route("/api/proxy-image")
@login_required
def api_proxy_image():
    image_url = request.args.get("url", "")
    if not image_url or "instagram" not in image_url and "fbcdn" not in image_url and "cdninstagram" not in image_url:
        return "", 404

    try:
        api = get_ig_api()
        content, content_type = api.fetch_image(image_url)
        if content:
            return Response(content, mimetype=content_type,
                            headers={"Cache-Control": "public, max-age=3600"})
    except Exception:
        pass
    return "", 404


# ------------------------------------------------------------------
# API — Resolve usernames to user info (for manual input / data export)
# ------------------------------------------------------------------

@app.route("/api/resolve-usernames", methods=["POST"])
@login_required
def api_resolve_usernames():
    data = request.get_json()
    usernames = data.get("usernames", [])
    if not usernames:
        return jsonify({"error": "No usernames provided."}), 400
    if len(usernames) > 200:
        return jsonify({"error": "Max 200 usernames at a time."}), 400

    try:
        api = get_ig_api()
        users = api.get_pending_from_usernames(usernames)
        return jsonify({"users": users, "count": len(users)})
    except AuthenticationError as e:
        session.clear()
        return jsonify({"error": str(e), "auth_expired": True}), 401
    except RateLimitError as e:
        return jsonify({"error": str(e)}), 429
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_ENV") != "production"
    app.run(debug=debug, host="0.0.0.0", port=port, threaded=True)
