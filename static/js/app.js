/* ============================================================
   InstaClean — Client-Side JavaScript
   ============================================================ */

let currentTab = 'nfb';
let currentUsers = { pending: [], nfb: [], sent: [] };
let allSelected = false;

// Helper: proxy Instagram profile pics through our server
function proxyImg(url) {
    if (!url) return '/static/img/default-avatar.svg';
    return '/api/proxy-image?url=' + encodeURIComponent(url);
}

// ============================================================
// Login
// ============================================================

async function handleLogin(event) {
    event.preventDefault();
    const btn = document.getElementById('login-btn');
    const errorEl = document.getElementById('login-error');
    const btnText = btn.querySelector('.btn-text');
    const btnLoading = btn.querySelector('.btn-loading');

    btn.disabled = true;
    btnText.style.display = 'none';
    btnLoading.style.display = 'inline-flex';
    errorEl.style.display = 'none';

    try {
        const resp = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: document.getElementById('sessionId').value,
                ds_user_id: document.getElementById('dsUserId').value,
                csrf_token: document.getElementById('csrfToken').value,
            }),
        });
        const data = await resp.json();

        if (data.success) {
            window.location.href = '/dashboard';
        } else {
            errorEl.textContent = data.error || 'Login failed';
            errorEl.style.display = 'block';
        }
    } catch (e) {
        errorEl.textContent = 'Network error. Check your connection.';
        errorEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btnText.style.display = 'inline';
        btnLoading.style.display = 'none';
    }
}

async function logout() {
    await fetch('/logout', { method: 'POST' });
    window.location.href = '/login';
}

function toggleGuide() {
    const content = document.getElementById('guide-content');
    const toggle = document.querySelector('.guide-toggle');
    if (content.style.display === 'none') {
        content.style.display = 'block';
        toggle.classList.add('open');
    } else {
        content.style.display = 'none';
        toggle.classList.remove('open');
    }
}

// ============================================================
// Tabs
// ============================================================

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');
    document.getElementById(`panel-${tab}`).classList.add('active');
    updateActionBar();

    // Auto-fetch if not loaded yet
    if (tab === 'nfb' && currentUsers.nfb.length === 0) fetchNotFollowingBack();
    // sent tab requires user input, no auto-fetch
    if (tab === 'pending' && currentUsers.pending.length === 0) fetchPending();
}

// ============================================================
// Fetch Data
// ============================================================

async function fetchPending() {
    const btn = document.getElementById('fetch-pending-btn');
    const list = document.getElementById('pending-list');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
    list.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i><p>Loading pending requests...</p></div>';
    document.getElementById('auto-cancel-btn').style.display = 'none';
    document.getElementById('pending-summary').style.display = 'none';

    try {
        const resp = await fetch('/api/pending-received');
        if (resp.status === 401) { window.location.href = '/login'; return; }
        const data = await resp.json();

        if (data.error) {
            list.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>${data.error}</p></div>`;
            return;
        }

        if (data.count === 0) {
            list.innerHTML = '<div class="empty-state"><i class="fas fa-check-circle"></i><p>No received follow requests!</p></div>';
            updateBadge('pending-count', 0);
            return;
        }

        currentUsers.pending = data.users;
        renderUserList('pending-list', data.users, 'Decline');
        updateBadge('pending-count', data.count);

        if (data.count > 0) {
            document.getElementById('auto-cancel-btn').style.display = 'inline-flex';
            document.getElementById('pending-summary').style.display = 'flex';
            document.getElementById('pending-total').textContent = data.count;
        }
    } catch (e) {
        list.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Failed to fetch. Try again.</p></div>';
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh';
    }
}

function autoCancelAll() {
    const users = currentUsers.pending;
    if (!users || users.length === 0) {
        showToast('No pending requests', 'error');
        return;
    }

    const count = users.length;
    if (!confirm(`Decline all ${count} pending follow requests?\n\nThis will take approximately ${Math.ceil(count * 7.5 / 60)} minutes.`)) {
        return;
    }

    const userIds = users.map(u => u.user_id);
    const usernameMap = {};
    users.forEach(u => { usernameMap[u.user_id] = u.username; });

    document.getElementById('progress-title').textContent = 'Declining Requests...';
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('progress-text').textContent = `0 / ${count}`;
    document.getElementById('progress-pct').textContent = '0%';
    document.getElementById('progress-succeeded').textContent = '0';
    document.getElementById('progress-failed').textContent = '0';
    document.getElementById('progress-log').innerHTML = '';
    document.getElementById('progress-close-btn').style.display = 'none';
    document.getElementById('progress-overlay').style.display = 'flex';

    fetch('/api/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_ids: userIds }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) { showToast(data.error, 'error'); closeProgress(); return; }
        const es = new EventSource(`/api/progress/${data.task_id}`);
        es.onmessage = function (event) {
            const msg = JSON.parse(event.data);
            if (msg.type === 'progress') {
                const pct = Math.round((msg.completed / msg.total) * 100);
                document.getElementById('progress-bar').style.width = pct + '%';
                document.getElementById('progress-text').textContent = `${msg.completed} / ${msg.total}`;
                document.getElementById('progress-pct').textContent = pct + '%';
                document.getElementById('progress-succeeded').textContent = msg.succeeded;
                document.getElementById('progress-failed').textContent = msg.failed;
                const username = usernameMap[msg.user_id] || msg.user_id;
                addLogEntry(`@${username}`, msg.result_status === 'cancelled' ? 'Declined' : msg.result_status, msg.result_status === 'cancelled' ? 'success' : 'fail');
                const row = document.querySelector(`#pending-list [data-user-id="${msg.user_id}"]`);
                if (row) row.classList.add('completed');
            }
            if (msg.type === 'complete') {
                es.close();
                document.getElementById('progress-bar').style.width = '100%';
                document.getElementById('progress-pct').textContent = '100%';
                document.getElementById('progress-title').textContent =
                    msg.status === 'completed' ? `Done! Declined ${msg.succeeded} requests` :
                    msg.status === 'rate_limited' ? 'Rate Limited — Try again later' : 'Stopped';
                document.getElementById('progress-close-btn').style.display = 'inline-flex';
            }
        };
        es.onerror = function () {
            es.close();
            document.getElementById('progress-title').textContent = 'Connection Lost';
            document.getElementById('progress-close-btn').style.display = 'inline-flex';
        };
    })
    .catch(() => { showToast('Failed to start', 'error'); closeProgress(); });
}

async function resolveUsernames() {
    const textarea = document.getElementById('username-input');
    const btn = document.getElementById('resolve-btn');
    const list = document.getElementById('pending-list');

    const raw = textarea.value.trim();
    if (!raw) {
        showToast('Paste some usernames first', 'error');
        return;
    }

    // Parse usernames: split by newlines, commas, or spaces; remove @ prefix
    const usernames = raw.split(/[\n,\s]+/)
        .map(u => u.trim().replace(/^@/, ''))
        .filter(u => u.length > 0);

    if (usernames.length === 0) {
        showToast('No valid usernames found', 'error');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Looking up ' + usernames.length + ' users...';
    list.innerHTML = `<div class="loading-state"><i class="fas fa-spinner fa-spin"></i><p>Resolving ${usernames.length} usernames...<br><small>This takes ~1 second per username</small></p></div>`;

    try {
        const resp = await fetch('/api/resolve-usernames', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usernames }),
        });
        if (resp.status === 401) { window.location.href = '/login'; return; }
        const data = await resp.json();

        if (data.error) {
            list.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>${data.error}</p></div>`;
            showToast(data.error, 'error');
            return;
        }

        allPendingUsers = data.users || [];
        currentUsers.pending = allPendingUsers.filter(u => u.user_id);

        const counts = countByStatus(allPendingUsers);
        document.getElementById('filter-all-count').textContent = allPendingUsers.length;
        document.getElementById('filter-pending-count').textContent = counts.pending;
        document.getElementById('filter-not-pending-count').textContent = counts.not_pending;
        document.getElementById('filter-not-found-count').textContent = counts.not_found;
        document.getElementById('filter-bar').style.display = 'flex';

        currentFilter = 'all';
        setActiveFilter('all');
        renderUserListWithStatus('pending-list', allPendingUsers, 'Cancel');
        updateBadge('pending-count', counts.pending);
    } catch (e) {
        list.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Failed to resolve. Try again.</p></div>';
        showToast('Network error', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-search"></i> Look Up Usernames';
    }
}

let sentFile = null;
let sentExtractedUsernames = null;
let allSentUsers = [];

function switchSentInput(mode) {
    document.querySelectorAll('.sent-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sent-input-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`sent-tab-${mode}`).classList.add('active');
    document.getElementById(`sent-input-${mode}`).classList.add('active');
}

function handleSentFile(input) {
    const files = Array.from(input.files);
    if (!files.length) return;

    // Find the pending_follow_requests.html in the folder
    const target = files.find(f =>
        f.name === 'pending_follow_requests.html' ||
        f.webkitRelativePath?.includes('pending_follow_requests.html')
    );

    if (target) {
        sentFile = target;
        const area = document.getElementById('upload-area');
        area.innerHTML = `<i class="fas fa-check-circle" style="color:var(--success);font-size:2rem"></i><p><strong>pending_follow_requests.html</strong> found!</p><small class="text-muted">Click "Check Requests" below</small>`;
    } else {
        // Maybe they uploaded a single HTML file
        const htmlFile = files.find(f => f.name.endsWith('.html') || f.name.endsWith('.htm'));
        if (htmlFile) {
            sentFile = htmlFile;
            const area = document.getElementById('upload-area');
            area.innerHTML = `<i class="fas fa-file-code" style="color:var(--purple);font-size:2rem"></i><p><strong>${htmlFile.name}</strong></p><small class="text-muted">Click "Check Requests" below</small>`;
        } else {
            showToast('Could not find pending_follow_requests.html in the folder', 'error');
        }
    }
}

async function handleSentZip(input) {
    const file = input.files[0];
    if (!file) return;

    const area = document.getElementById('upload-area');
    area.innerHTML = `<i class="fas fa-spinner fa-spin" style="font-size:2rem"></i><p>Extracting zip...</p>`;

    // Send zip to server to extract
    const formData = new FormData();
    formData.append('zip_file', file);

    try {
        const resp = await fetch('/api/extract-zip', { method: 'POST', body: formData });
        const data = await resp.json();

        if (data.error) {
            area.innerHTML = `<i class="fas fa-exclamation-triangle" style="color:var(--danger);font-size:2rem"></i><p>${data.error}</p>`;
            showToast(data.error, 'error');
            return;
        }

        // Store the extracted usernames directly
        sentExtractedUsernames = data.usernames;
        area.innerHTML = `<i class="fas fa-check-circle" style="color:var(--success);font-size:2rem"></i><p>Found <strong>${data.usernames.length} usernames</strong> in zip</p><small class="text-muted">Click "Check Requests" below</small>`;
    } catch (e) {
        area.innerHTML = `<i class="fas fa-exclamation-triangle" style="color:var(--danger);font-size:2rem"></i><p>Failed to extract zip</p>`;
        showToast('Failed to process zip file', 'error');
    }
}

async function fetchSentRequests() {
    const btn = document.getElementById('fetch-sent-btn');
    const list = document.getElementById('sent-list');

    // Build request
    const formData = new FormData();
    let hasInput = false;

    if (sentExtractedUsernames && sentExtractedUsernames.length > 0) {
        formData.append('usernames', sentExtractedUsernames.join('\n'));
        hasInput = true;
    } else if (sentFile) {
        formData.append('export_file', sentFile);
        hasInput = true;
    }

    const pasteText = (document.getElementById('sent-username-input')?.value || '').trim();
    if (pasteText) {
        formData.append('usernames', pasteText);
        hasInput = true;
    }

    if (!hasInput) {
        showToast('Upload a file/folder or paste usernames first', 'error');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking...';
    list.innerHTML = '';
    allSentUsers = [];
    document.getElementById('auto-cancel-sent-btn').style.display = 'none';
    document.getElementById('sent-filter-bar').style.display = 'none';

    try {
        // Step 1: Upload file and get task_id
        const resp = await fetch('/api/pending-sent', { method: 'POST', body: formData });
        if (resp.status === 401) { window.location.href = '/login'; return; }
        const data = await resp.json();

        if (data.error) {
            list.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>${data.error}</p></div>`;
            showToast(data.error, 'error');
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-search"></i> Check Requests';
            return;
        }

        // Step 2: Stream results via SSE
        const total = data.total;
        list.innerHTML = `<div class="sent-progress-header"><span id="sent-checking-text">Checking 0 / ${total}...</span></div>`;

        const es = new EventSource(`/api/check-sent/${data.task_id}`);

        es.onmessage = function (event) {
            const msg = JSON.parse(event.data);

            if (msg.type === 'complete') {
                es.close();
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-search"></i> Check Requests';

                // Update counts & show filters
                const counts = { pending: 0, accepted: 0, not_found: 0, other: 0 };
                allSentUsers.forEach(u => {
                    if (u.status === 'pending') counts.pending++;
                    else if (u.status === 'accepted') counts.accepted++;
                    else if (u.status === 'not_found') counts.not_found++;
                    else counts.other++;
                });
                document.getElementById('sent-filter-all-count').textContent = allSentUsers.length;
                document.getElementById('sent-filter-pending-count').textContent = counts.pending;
                document.getElementById('sent-filter-accepted-count').textContent = counts.accepted;
                document.getElementById('sent-filter-not-found-count').textContent = counts.not_found;
                document.getElementById('sent-filter-bar').style.display = 'flex';
                updateBadge('sent-count', counts.pending);

                if (counts.pending > 0) {
                    document.getElementById('auto-cancel-sent-btn').style.display = 'inline-flex';
                }

                // Remove progress header
                const header = document.querySelector('.sent-progress-header');
                if (header) header.remove();

                currentUsers.sent = allSentUsers.filter(u => u.user_id);
                showToast(`Done! ${allSentUsers.length} checked (${counts.pending} pending)`, 'success');
                return;
            }

            // It's a user result — add to list in real time
            allSentUsers.push(msg);

            // Update progress text
            const progText = document.getElementById('sent-checking-text');
            if (progText) progText.textContent = `Checking ${msg.index + 1} / ${msg.total}...`;

            // Append user row to list
            const statusClass = msg.status === 'pending' ? 'status-pending' :
                               msg.status === 'accepted' ? 'status-accepted' :
                               msg.status === 'not_found' ? 'status-not-found' : 'status-not-pending';
            const statusText = msg.status === 'pending' ? 'Pending' :
                              msg.status === 'accepted' ? 'Accepted' :
                              msg.status === 'not_found' ? 'Not Found' : 'Not Pending';
            const hasId = msg.user_id != null;

            const row = document.createElement('div');
            row.className = 'user-row';
            row.setAttribute('data-user-id', msg.user_id || '');
            row.setAttribute('data-status', msg.status);
            row.innerHTML = `
                <input type="checkbox" class="user-checkbox" value="${msg.user_id || ''}" onchange="updateActionBar()" ${hasId ? '' : 'disabled'}>
                <img src="${proxyImg(msg.profile_pic_url)}" class="avatar" onerror="this.src='/static/img/default-avatar.svg'" loading="lazy">
                <div class="user-info">
                    <span>
                        <span class="username">@${msg.username}</span>
                        ${msg.is_verified ? '<i class="fas fa-check-circle verified"></i>' : ''}
                        ${msg.is_private ? '<i class="fas fa-lock private"></i>' : ''}
                    </span>
                    ${msg.full_name ? `<span class="fullname">${msg.full_name}</span>` : ''}
                </div>
                <span class="status-badge ${statusClass}">${statusText}</span>
                ${hasId ? `<button class="btn btn-ghost btn-sm" onclick="cancelSingle(${msg.user_id}, '${msg.username}', this)">Cancel</button>` : ''}
            `;
            list.appendChild(row);
        };

        es.onerror = function () {
            es.close();
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-search"></i> Check Requests';
            showToast('Connection lost', 'error');
        };

    } catch (e) {
        list.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Failed to check. Try again.</p></div>';
        showToast('Network error', 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-search"></i> Check Requests';
    }
}

function filterSent(filter) {
    document.querySelectorAll('#panel-sent .filter-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`sent-filter-${filter}`).classList.add('active');

    let filtered;
    if (filter === 'all') filtered = allSentUsers;
    else if (filter === 'pending') filtered = allSentUsers.filter(u => u.status === 'pending');
    else if (filter === 'accepted') filtered = allSentUsers.filter(u => u.status === 'accepted');
    else if (filter === 'not_found') filtered = allSentUsers.filter(u => u.status === 'not_found');

    currentUsers.sent = (filtered || []).filter(u => u.user_id);
    renderUserListWithStatus('sent-list', filtered || [], 'Cancel');
}

function autoCancelSent() {
    const users = allSentUsers.filter(u => u.status === 'pending' && u.user_id);
    if (!users || users.length === 0) { showToast('No pending requests to cancel', 'error'); return; }

    const count = users.length;
    if (!confirm(`Cancel all ${count} sent follow requests?\n\nThis will take approximately ${Math.ceil(count * 7.5 / 60)} minutes.`)) return;

    const userIds = users.map(u => u.user_id);
    const usernameMap = {};
    users.forEach(u => { usernameMap[u.user_id] = u.username; });

    document.getElementById('progress-title').textContent = 'Cancelling Sent Requests...';
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('progress-text').textContent = `0 / ${count}`;
    document.getElementById('progress-pct').textContent = '0%';
    document.getElementById('progress-succeeded').textContent = '0';
    document.getElementById('progress-failed').textContent = '0';
    document.getElementById('progress-log').innerHTML = '';
    document.getElementById('progress-close-btn').style.display = 'none';
    document.getElementById('progress-overlay').style.display = 'flex';

    fetch('/api/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_ids: userIds }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) { showToast(data.error, 'error'); closeProgress(); return; }
        const es = new EventSource(`/api/progress/${data.task_id}`);
        es.onmessage = function (event) {
            const msg = JSON.parse(event.data);
            if (msg.type === 'progress') {
                const pct = Math.round((msg.completed / msg.total) * 100);
                document.getElementById('progress-bar').style.width = pct + '%';
                document.getElementById('progress-text').textContent = `${msg.completed} / ${msg.total}`;
                document.getElementById('progress-pct').textContent = pct + '%';
                document.getElementById('progress-succeeded').textContent = msg.succeeded;
                document.getElementById('progress-failed').textContent = msg.failed;
                const username = usernameMap[msg.user_id] || msg.user_id;
                addLogEntry(`@${username}`, msg.result_status === 'cancelled' ? 'Cancelled' : msg.result_status, msg.result_status === 'cancelled' ? 'success' : 'fail');
                const row = document.querySelector(`#sent-list [data-user-id="${msg.user_id}"]`);
                if (row) row.classList.add('completed');
            }
            if (msg.type === 'complete') {
                es.close();
                document.getElementById('progress-bar').style.width = '100%';
                document.getElementById('progress-pct').textContent = '100%';
                document.getElementById('progress-title').textContent =
                    msg.status === 'completed' ? `Done! Cancelled ${msg.succeeded} requests` :
                    msg.status === 'rate_limited' ? 'Rate Limited — Try again later' : 'Stopped';
                document.getElementById('progress-close-btn').style.display = 'inline-flex';
            }
        };
        es.onerror = function () { es.close(); document.getElementById('progress-title').textContent = 'Connection Lost'; document.getElementById('progress-close-btn').style.display = 'inline-flex'; };
    })
    .catch(() => { showToast('Failed to start', 'error'); closeProgress(); });
}

async function fetchNotFollowingBack() {
    const btn = document.getElementById('fetch-nfb-btn');
    const list = document.getElementById('nfb-list');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing...';
    list.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i><p>Analyzing followers and following...<br><small>This may take a moment for large accounts</small></p></div>';
    document.getElementById('auto-unfollow-btn').style.display = 'none';
    document.getElementById('nfb-summary').style.display = 'none';

    try {
        const resp = await fetch('/api/not-following-back');
        if (resp.status === 401) { window.location.href = '/login'; return; }
        const data = await resp.json();

        if (data.error) {
            list.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>${data.error}</p></div>`;
            showToast(data.error, 'error');
            return;
        }

        currentUsers.nfb = data.users;
        renderUserList('nfb-list', data.users, 'Unfollow');
        updateBadge('nfb-count', data.count);

        if (data.count > 0) {
            document.getElementById('auto-unfollow-btn').style.display = 'inline-flex';
            document.getElementById('nfb-summary').style.display = 'flex';
            document.getElementById('nfb-total').textContent = data.count;
        }

        showToast(`Found ${data.count} users not following you back`, 'success');
    } catch (e) {
        list.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Failed to fetch. Try again.</p></div>';
        showToast('Network error', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-magnifying-glass"></i> Analyze';
    }
}

function autoUnfollowAll() {
    const users = currentUsers.nfb;
    if (!users || users.length === 0) {
        showToast('No users to unfollow', 'error');
        return;
    }

    const count = users.length;
    if (!confirm(`Are you sure you want to unfollow ${count} users who don't follow you back?\n\nThis will take approximately ${Math.ceil(count * 7.5 / 60)} minutes.`)) {
        return;
    }

    const userIds = users.map(u => u.user_id);
    const usernameMap = {};
    users.forEach(u => { usernameMap[u.user_id] = u.username; });

    // Show progress overlay
    document.getElementById('progress-title').textContent = 'Auto Unfollowing...';
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('progress-text').textContent = `0 / ${count}`;
    document.getElementById('progress-pct').textContent = '0%';
    document.getElementById('progress-succeeded').textContent = '0';
    document.getElementById('progress-failed').textContent = '0';
    document.getElementById('progress-log').innerHTML = '';
    document.getElementById('progress-close-btn').style.display = 'none';
    document.getElementById('progress-overlay').style.display = 'flex';

    fetch('/api/unfollow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_ids: userIds }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) {
            showToast(data.error, 'error');
            closeProgress();
            return;
        }

        const es = new EventSource(`/api/progress/${data.task_id}`);

        es.onmessage = function (event) {
            const msg = JSON.parse(event.data);

            if (msg.type === 'progress') {
                const pct = Math.round((msg.completed / msg.total) * 100);
                document.getElementById('progress-bar').style.width = pct + '%';
                document.getElementById('progress-text').textContent = `${msg.completed} / ${msg.total}`;
                document.getElementById('progress-pct').textContent = pct + '%';
                document.getElementById('progress-succeeded').textContent = msg.succeeded;
                document.getElementById('progress-failed').textContent = msg.failed;

                const username = usernameMap[msg.user_id] || msg.user_id;
                const status = msg.result_status === 'cancelled' ? 'success' : 'fail';
                const statusText = msg.result_status === 'cancelled' ? 'Unfollowed' : msg.result_status;
                addLogEntry(`@${username}`, statusText, status);

                const row = document.querySelector(`#nfb-list [data-user-id="${msg.user_id}"]`);
                if (row) row.classList.add('completed');
            }

            if (msg.type === 'complete') {
                es.close();
                document.getElementById('progress-bar').style.width = '100%';
                document.getElementById('progress-pct').textContent = '100%';
                document.getElementById('progress-title').textContent =
                    msg.status === 'completed' ? `Done! Unfollowed ${msg.succeeded} users` :
                    msg.status === 'rate_limited' ? 'Rate Limited — Try again later' : 'Stopped';
                document.getElementById('progress-close-btn').style.display = 'inline-flex';
            }
        };

        es.onerror = function () {
            es.close();
            document.getElementById('progress-title').textContent = 'Connection Lost';
            document.getElementById('progress-close-btn').style.display = 'inline-flex';
        };
    })
    .catch(() => {
        showToast('Failed to start auto unfollow', 'error');
        closeProgress();
    });
}

// ============================================================
// Render User List
// ============================================================

function renderUserList(containerId, users, actionLabel) {
    const container = document.getElementById(containerId);

    if (users.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-check-circle"></i><p>No users found. You\'re all clean!</p></div>';
        return;
    }

    container.innerHTML = users.map((user, i) => `
        <div class="user-row" data-user-id="${user.user_id}" data-index="${i}">
            <input type="checkbox" class="user-checkbox" value="${user.user_id}"
                   onchange="updateActionBar()">
            <img src="${proxyImg(user.profile_pic_url)}" class="avatar"
                 onerror="this.src='/static/img/default-avatar.svg'" loading="lazy">
            <div class="user-info">
                <span>
                    <span class="username">@${user.username}</span>
                    ${user.is_verified ? '<i class="fas fa-check-circle verified"></i>' : ''}
                    ${user.is_private ? '<i class="fas fa-lock private"></i>' : ''}
                </span>
                ${user.full_name ? `<span class="fullname">${user.full_name}</span>` : ''}
            </div>
            <button class="btn btn-ghost btn-sm" onclick="cancelSingle(${user.user_id}, '${user.username}', this)">
                ${actionLabel}
            </button>
        </div>
    `).join('');
}

function renderUserListWithStatus(containerId, users, actionLabel) {
    const container = document.getElementById(containerId);

    if (users.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-check-circle"></i><p>No users found.</p></div>';
        return;
    }

    container.innerHTML = users.map((user, i) => {
        const statusClass = user.status === 'pending' ? 'status-pending' :
                           user.status === 'accepted' ? 'status-accepted' :
                           user.status === 'not_found' ? 'status-not-found' : 'status-not-pending';
        const statusText = user.status === 'pending' ? 'Pending' :
                          user.status === 'accepted' ? 'Accepted' :
                          user.status === 'not_found' ? 'Not Found' : 'Not Pending';
        const hasId = user.user_id != null;
        const disabled = !hasId ? 'disabled' : '';

        return `
        <div class="user-row" data-user-id="${user.user_id || ''}" data-index="${i}">
            <input type="checkbox" class="user-checkbox" value="${user.user_id || ''}"
                   onchange="updateActionBar()" ${disabled}>
            <img src="${proxyImg(user.profile_pic_url)}" class="avatar"
                 onerror="this.src='/static/img/default-avatar.svg'" loading="lazy">
            <div class="user-info">
                <span>
                    <span class="username">@${user.username}</span>
                    ${user.is_verified ? '<i class="fas fa-check-circle verified"></i>' : ''}
                    ${user.is_private ? '<i class="fas fa-lock private"></i>' : ''}
                </span>
                ${user.full_name ? `<span class="fullname">${user.full_name}</span>` : ''}
            </div>
            <span class="status-badge ${statusClass}">${statusText}</span>
            ${hasId ? `<button class="btn btn-ghost btn-sm" onclick="cancelSingle(${user.user_id}, '${user.username}', this)">${actionLabel}</button>` : ''}
        </div>`;
    }).join('');
}

// ============================================================
// Selection & Action Bar
// ============================================================

function updateActionBar() {
    const checkboxes = document.querySelectorAll(`#panel-${currentTab} .user-checkbox:not(:disabled)`);
    const checked = document.querySelectorAll(`#panel-${currentTab} .user-checkbox:checked`);
    const bar = document.getElementById('action-bar');
    const countEl = document.getElementById('selected-count');
    const actionText = document.getElementById('batch-action-text');

    if (checked.length > 0) {
        bar.style.display = 'flex';
        countEl.textContent = checked.length;
        actionText.textContent = currentTab === 'nfb'
            ? `Unfollow Selected (${checked.length})`
            : `Cancel Selected (${checked.length})`;
    } else {
        bar.style.display = 'none';
    }

    allSelected = checked.length === checkboxes.length && checkboxes.length > 0;
    document.getElementById('select-all-text').textContent = allSelected ? 'Deselect All' : 'Select All';
}

function toggleSelectAll() {
    const checkboxes = document.querySelectorAll(`#panel-${currentTab} .user-checkbox:not(:disabled)`);
    allSelected = !allSelected;
    checkboxes.forEach(cb => cb.checked = allSelected);
    updateActionBar();
}

// ============================================================
// Single Cancel/Unfollow
// ============================================================

async function cancelSingle(userId, username, btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

    const endpoint = currentTab === 'nfb' ? '/api/unfollow' : '/api/cancel';
    try {
        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_ids: [userId] }),
        });
        const data = await resp.json();

        if (data.error) {
            showToast(data.error, 'error');
            btn.disabled = false;
            btn.innerHTML = currentTab === 'pending' ? 'Cancel' : 'Unfollow';
            return;
        }

        const es = new EventSource(`/api/progress/${data.task_id}`);
        es.onmessage = function (event) {
            const msg = JSON.parse(event.data);
            if (msg.type === 'complete' || msg.type === 'progress') {
                es.close();
                const row = document.querySelector(`[data-user-id="${userId}"]`);
                if (row) {
                    row.classList.add('completed');
                    btn.innerHTML = '<i class="fas fa-check"></i> Done';
                    btn.style.color = 'var(--success)';
                }
                showToast(`@${username} — done`, 'success');
            }
        };
        es.onerror = function () {
            es.close();
            btn.disabled = false;
            btn.innerHTML = 'Retry';
        };
    } catch (e) {
        showToast('Network error', 'error');
        btn.disabled = false;
        btn.innerHTML = 'Retry';
    }
}

// ============================================================
// Batch Cancel/Unfollow
// ============================================================

function startBatchAction() {
    const checked = document.querySelectorAll(`#panel-${currentTab} .user-checkbox:checked`);
    const userIds = Array.from(checked).map(cb => parseInt(cb.value)).filter(id => !isNaN(id));

    if (userIds.length === 0) {
        showToast('No users selected', 'error');
        return;
    }

    const endpoint = currentTab === 'nfb' ? '/api/unfollow' : '/api/cancel';
    const title = currentTab === 'nfb' ? 'Unfollowing...' : 'Cancelling Requests...';

    const users = currentUsers[currentTab];
    const usernameMap = {};
    users.forEach(u => { usernameMap[u.user_id] = u.username; });

    document.getElementById('progress-title').textContent = title;
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('progress-text').textContent = `0 / ${userIds.length}`;
    document.getElementById('progress-pct').textContent = '0%';
    document.getElementById('progress-succeeded').textContent = '0';
    document.getElementById('progress-failed').textContent = '0';
    document.getElementById('progress-log').innerHTML = '';
    document.getElementById('progress-close-btn').style.display = 'none';
    document.getElementById('progress-overlay').style.display = 'flex';

    fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_ids: userIds }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) {
            showToast(data.error, 'error');
            closeProgress();
            return;
        }

        const es = new EventSource(`/api/progress/${data.task_id}`);

        es.onmessage = function (event) {
            const msg = JSON.parse(event.data);

            if (msg.type === 'progress') {
                const pct = Math.round((msg.completed / msg.total) * 100);
                document.getElementById('progress-bar').style.width = pct + '%';
                document.getElementById('progress-text').textContent = `${msg.completed} / ${msg.total}`;
                document.getElementById('progress-pct').textContent = pct + '%';
                document.getElementById('progress-succeeded').textContent = msg.succeeded;
                document.getElementById('progress-failed').textContent = msg.failed;

                const username = usernameMap[msg.user_id] || msg.user_id;
                const status = msg.result_status === 'cancelled' ? 'success' : 'fail';
                const statusText = msg.result_status === 'cancelled' ? 'Done' : msg.result_status;
                addLogEntry(`@${username}`, statusText, status);

                const row = document.querySelector(`[data-user-id="${msg.user_id}"]`);
                if (row) row.classList.add('completed');
            }

            if (msg.type === 'complete') {
                es.close();
                document.getElementById('progress-bar').style.width = '100%';
                document.getElementById('progress-pct').textContent = '100%';
                document.getElementById('progress-title').textContent =
                    msg.status === 'completed' ? 'All Done!' :
                    msg.status === 'rate_limited' ? 'Rate Limited' : 'Stopped';
                document.getElementById('progress-close-btn').style.display = 'inline-flex';
            }
        };

        es.onerror = function () {
            es.close();
            document.getElementById('progress-title').textContent = 'Connection Lost';
            document.getElementById('progress-close-btn').style.display = 'inline-flex';
        };
    })
    .catch(() => {
        showToast('Failed to start batch operation', 'error');
        closeProgress();
    });
}

function addLogEntry(name, status, type) {
    const log = document.getElementById('progress-log');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `<span>${name}</span> — <strong>${status}</strong>`;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
}

function closeProgress() {
    document.getElementById('progress-overlay').style.display = 'none';
    document.getElementById('action-bar').style.display = 'none';
}

// ============================================================
// Utilities
// ============================================================

function updateBadge(id, count) {
    const badge = document.getElementById(id);
    badge.textContent = count;
    badge.style.display = count > 0 ? 'inline' : 'none';
}

function showToast(message, type) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// ============================================================
// Auto-load on page ready
// ============================================================

document.addEventListener('DOMContentLoaded', function () {
    // Auto-fetch "Not Following Back" when dashboard loads
    if (document.getElementById('panel-nfb')) {
        fetchNotFollowingBack();
    }
});
