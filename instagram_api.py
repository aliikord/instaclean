"""
Instagram Private API Service Module
-------------------------------------
Direct HTTP requests to Instagram's mobile API using session cookies.
"""

import time
import requests
from config import Config


class InstagramAPIError(Exception):
    pass


class RateLimitError(InstagramAPIError):
    pass


class AuthenticationError(InstagramAPIError):
    pass


class InstagramAPI:
    """Interact with Instagram's private mobile API using session cookies."""

    def __init__(self, session_id: str, ds_user_id: str, csrf_token: str):
        self.session_id = session_id
        self.ds_user_id = ds_user_id
        self.csrf_token = csrf_token
        self.http = requests.Session()
        self._setup()

    def _setup(self):
        self.http.cookies.set("sessionid", self.session_id, domain=".instagram.com")
        self.http.cookies.set("ds_user_id", self.ds_user_id, domain=".instagram.com")
        self.http.cookies.set("csrftoken", self.csrf_token, domain=".instagram.com")
        self.http.headers.update({
            "User-Agent": Config.IG_MOBILE_USER_AGENT,
            "X-CSRFToken": self.csrf_token,
            "X-IG-App-ID": Config.IG_APP_ID,
            "X-IG-WWW-Claim": "0",
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Origin": "https://www.instagram.com",
            "Referer": "https://www.instagram.com/",
        })

    def _handle(self, resp):
        if resp.status_code == 429:
            raise RateLimitError("Rate limited by Instagram. Wait a few minutes.")
        if resp.status_code in (401, 403):
            raise AuthenticationError("Session expired or invalid cookies.")
        if resp.status_code == 400:
            try:
                data = resp.json()
            except Exception:
                raise InstagramAPIError("Bad request (status 400)")
            if data.get("message") == "checkpoint_required":
                raise AuthenticationError(
                    "Instagram requires checkpoint verification. "
                    "Open instagram.com, complete the challenge, then re-enter cookies."
                )
            raise InstagramAPIError(f"Bad request: {data.get('message', 'Unknown')}")
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------
    # Session
    # ------------------------------------------------------------------

    def validate_session(self):
        """Validate cookies by fetching the user's own profile."""
        url = f"{Config.IG_BASE_URL}/accounts/current_user/?edit=true"
        data = self._handle(self.http.get(url, timeout=15))
        user = data.get("user", {})
        return {
            "user_id": user.get("pk"),
            "username": user.get("username"),
            "full_name": user.get("full_name"),
            "profile_pic_url": user.get("profile_pic_url"),
        }

    # ------------------------------------------------------------------
    # User lookup
    # ------------------------------------------------------------------

    def get_user_by_username(self, username):
        """Look up a user's ID and info by username (tries multiple endpoints)."""
        # Try 1: Mobile API endpoint
        try:
            url = f"{Config.IG_BASE_URL}/users/{username}/usernameinfo/"
            resp = self.http.get(url, timeout=15)
            if resp.status_code == 200:
                data = resp.json()
                user = data.get("user", {})
                if user and user.get("pk"):
                    return {
                        "user_id": user.get("pk"),
                        "username": user.get("username", username),
                        "full_name": user.get("full_name", ""),
                        "profile_pic_url": user.get("profile_pic_url", ""),
                        "is_private": user.get("is_private", False),
                        "is_verified": user.get("is_verified", False),
                    }
        except Exception:
            pass

        # Try 2: Web profile info endpoint
        try:
            url = "https://www.instagram.com/api/v1/users/web_profile_info/"
            resp = self.http.get(url, params={"username": username}, timeout=15)
            if resp.status_code == 200:
                data = resp.json()
                user = data.get("data", {}).get("user", {})
                if user and user.get("id"):
                    return {
                        "user_id": user.get("id"),
                        "username": user.get("username", username),
                        "full_name": user.get("full_name", ""),
                        "profile_pic_url": user.get("profile_pic_url", ""),
                        "is_private": user.get("is_private", False),
                        "is_verified": user.get("is_verified", False),
                    }
        except Exception:
            pass

        return None

    def check_friendship(self, user_id):
        """Check relationship status with a user. Returns dict with outgoing_request, following, etc."""
        url = f"{Config.IG_BASE_URL}/friendships/show/{user_id}/"
        data = self._handle(self.http.get(url, timeout=15))
        if not data:
            return None
        return data

    # ------------------------------------------------------------------
    # Pending follow requests (outgoing)
    # ------------------------------------------------------------------

    def check_outgoing_from_usernames(self, usernames):
        """
        Check a list of usernames for outgoing pending requests.
        Returns list of user dicts with status field.
        """
        results = []
        for username in usernames:
            user = self.get_user_by_username(username)
            if user:
                try:
                    status = self.check_friendship(user["user_id"])
                    if status and status.get("outgoing_request"):
                        user["status"] = "pending"
                    elif status and status.get("following"):
                        user["status"] = "accepted"
                    else:
                        user["status"] = "not_pending"
                except Exception:
                    user["status"] = "unknown"
                results.append(user)
            else:
                results.append({
                    "user_id": None,
                    "username": username,
                    "full_name": "",
                    "profile_pic_url": "",
                    "is_private": False,
                    "is_verified": False,
                    "status": "not_found",
                })
            time.sleep(Config.FETCH_PAGE_DELAY)
        return results

    def get_incoming_pending_requests(self):
        """Fetch incoming pending follow requests (people who requested to follow YOU)."""
        users = []
        max_id = None
        while True:
            url = f"{Config.IG_BASE_URL}/friendships/pending/"
            params = {}
            if max_id:
                params["max_id"] = max_id
            try:
                data = self._handle(self.http.get(url, params=params, timeout=15))
            except InstagramAPIError:
                break
            if not data:
                break
            for user in data.get("users", []):
                users.append(self._parse_user(user))
            if not data.get("big_list") or not data.get("next_max_id"):
                break
            max_id = data["next_max_id"]
            time.sleep(Config.FETCH_PAGE_DELAY)
        return users

    # ------------------------------------------------------------------
    # Following / Followers
    # ------------------------------------------------------------------

    def get_following(self, user_id=None):
        uid = user_id or self.ds_user_id
        return list(self._paginate_friendships(f"{uid}/following"))

    def get_followers(self, user_id=None):
        uid = user_id or self.ds_user_id
        return list(self._paginate_friendships(f"{uid}/followers"))

    def _paginate_friendships(self, path):
        max_id = None
        while True:
            url = f"{Config.IG_BASE_URL}/friendships/{path}/"
            params = {"count": 200}
            if max_id:
                params["max_id"] = max_id
            data = self._handle(self.http.get(url, params=params, timeout=15))
            if not data:
                return

            for user in data.get("users", []):
                yield self._parse_user(user)

            if not data.get("big_list") or not data.get("next_max_id"):
                break
            max_id = data["next_max_id"]
            time.sleep(Config.FETCH_PAGE_DELAY)

    def get_not_following_back(self):
        following = {u["user_id"]: u for u in self.get_following()}
        followers_ids = {u["user_id"] for u in self.get_followers()}
        return [u for uid, u in following.items() if uid not in followers_ids]

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def cancel_follow_request(self, user_id):
        url = f"{Config.IG_BASE_URL}/friendships/destroy/{user_id}/"
        return self._handle(self.http.post(url, timeout=15))

    def unfollow_user(self, user_id):
        return self.cancel_follow_request(user_id)

    # ------------------------------------------------------------------
    # Image proxy
    # ------------------------------------------------------------------

    def fetch_image(self, image_url):
        """Fetch an image from Instagram's CDN. Returns (content_bytes, content_type)."""
        try:
            resp = self.http.get(image_url, timeout=10)
            resp.raise_for_status()
            return resp.content, resp.headers.get("Content-Type", "image/jpeg")
        except Exception:
            return None, None

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_user(user):
        return {
            "user_id": user.get("pk"),
            "username": user.get("username"),
            "full_name": user.get("full_name", ""),
            "profile_pic_url": user.get("profile_pic_url", ""),
            "is_private": user.get("is_private", False),
            "is_verified": user.get("is_verified", False),
        }
