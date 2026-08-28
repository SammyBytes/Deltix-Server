let accessToken = null;
let currentUsername = null;
let currentIsGlobalAdmin = false;
let pendingDeleteUsername = null;
let selectedRolesRepoId = '';
const auditEvents = [];

// DOM References
const form = document.getElementById('login-form');
const errorMessage = document.getElementById('error-message');
const loginView = document.getElementById('login-view');
const sessionPanel = document.getElementById('session-panel');
const sessionUsername = document.getElementById('session-username');
const logoutButton = document.getElementById('logout-button');
const notAdminNotice = document.getElementById('not-admin-notice');
const toastOutlet = document.getElementById('toast-outlet');

// Navigation Tabs
const navTabs = document.querySelectorAll('.nav-tab');
const tabContents = document.querySelectorAll('.tab-content');

// Repositories & Roles
const rolesScreen = document.getElementById('roles-screen');
const rolesRepoSelect = document.getElementById('roles-repo-select');
const roleGrantForm = document.getElementById('role-grant-form');
const roleMessage = document.getElementById('role-message');
const rolesList = document.getElementById('roles-list');
const knownUsernamesList = document.getElementById('known-usernames');
const reposTableBody = document.getElementById('repos-table-body');
const repoCreateForm = document.getElementById('repo-create-form');
const repoCreateMessage = document.getElementById('repo-create-message');

// Users
const usersScreen = document.getElementById('users-screen');
const userCreateForm = document.getElementById('user-create-form');
const userMessage = document.getElementById('user-message');
const userList = document.getElementById('user-list');
const seatsUsed = document.getElementById('seats-used');
const deleteConfirmPanel = document.getElementById('delete-confirm-panel');
const deleteUsername = document.getElementById('delete-username');
const confirmDeleteButton = document.getElementById('confirm-delete-button');
const cancelDeleteButton = document.getElementById('cancel-delete-button');

// Addons
const addonsScreen = document.getElementById('addons-screen');
const trustForm = document.getElementById('trust-form');
const trustMessage = document.getElementById('trust-message');
const trustList = document.getElementById('trust-list');

// Setup form (for setup.html)
const setupForm = document.getElementById('setup-form');
const setupMessage = document.getElementById('setup-message');

// Dashboard metrics
const dashRepoCount = document.getElementById('dash-repo-count');
const dashActiveSeats = document.getElementById('dash-active-seats');
const dashTotalUsers = document.getElementById('dash-total-users');
const dashAddonsCount = document.getElementById('dash-addons-count');

// Audit & Diagnostics
const auditLogContainer = document.getElementById('audit-log-container');
const copySupportBundleBtn = document.getElementById('copy-support-bundle-btn');

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Inline action icons (row-level table actions) — icons instead of text
// buttons so 3 actions never wrap onto a second line on narrow tables.
const ICON_PLAY = '<path d="M6 4l10 6-10 6V4z" stroke-linecap="round" stroke-linejoin="round" />';
const ICON_PAUSE = '<path d="M7 5v10M13 5v10" stroke-linecap="round" stroke-linejoin="round" />';
const ICON_SHIELD =
  '<path d="M10 3l6 2v5c0 4-2.5 6.5-6 7-3.5-.5-6-3-6-7V5l6-2z" stroke-linecap="round" stroke-linejoin="round" /><path d="M7.5 10l1.8 1.8L12.5 8" stroke-linecap="round" stroke-linejoin="round" />';
const ICON_TRASH =
  '<path d="M4 6h12M8 6V4.5A1.5 1.5 0 019.5 3h1A1.5 1.5 0 0112 4.5V6M6 6l.6 9.4A1.5 1.5 0 008.1 17h3.8a1.5 1.5 0 001.5-1.6L14 6" stroke-linecap="round" stroke-linejoin="round" />';

function iconButton(iconSvgPath, title, extraClass) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.className =
    'inline-flex items-center justify-center w-7 h-7 rounded-md border border-neutral-800 bg-neutral-900 text-neutral-400 hover:bg-neutral-800 transition ' +
    (extraClass || '');
  btn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" class="w-4 h-4">' +
    iconSvgPath +
    '</svg>';
  return btn;
}

function withViewTransition(mutate) {
  if (typeof document.startViewTransition === 'function') {
    // startViewTransition can throw synchronously (a transition is already
    // running) or, on newer Chromium, return a promise that rejects with
    // AbortError when the transition is skipped/interrupted. Attach a catch so
    // rejected transitions are not logged as "Uncaught (in promise)"; the DOM
    // mutation still runs inside the callback.
    try {
      const transition = document.startViewTransition(() => {
        mutate();
      });
      const finished = transition && transition.finished ? transition.finished : transition;
      if (finished && typeof finished.catch === 'function') {
        finished.catch(() => {});
      }
    } catch {
      mutate();
    }
  } else {
    mutate();
  }
}

function showToast(message, isError) {
  if (!toastOutlet) return;
  const toast = document.createElement('div');
  toast.className = 'toast-item';
  const dotColor = isError ? 'bg-red-400' : 'bg-emerald-400';
  toast.innerHTML =
    '<span class="w-2 h-2 rounded-full ' + dotColor + '"></span>' +
    '<span>' + escapeHtml(message) + '</span>';
  toastOutlet.append(toast);
  window.setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toast.style.transition = 'all 150ms ease-out';
    window.setTimeout(() => toast.remove(), 160);
  }, 3500);
}

function logAuditEvent(action, details) {
  const event = {
    timestamp: new Date().toISOString(),
    action: action,
    details: details || {},
    actor: currentUsername || 'anonymous',
  };
  auditEvents.unshift(event);
  renderAuditLogs();
}

function renderAuditLogs() {
  if (!auditLogContainer) return;
  if (auditEvents.length === 0) {
    auditLogContainer.innerHTML =
      '<div class="text-xs text-neutral-500 py-3 text-center">Session initialized. Actions will be logged here.</div>';
    return;
  }
  auditLogContainer.innerHTML = '';
  for (const ev of auditEvents.slice(0, 15)) {
    const item = document.createElement('div');
    item.className = 'p-2.5 rounded-lg border border-neutral-800/80 bg-neutral-950/60 text-xs space-y-1';
    item.innerHTML =
      '<div class="flex items-center justify-between text-neutral-300 font-medium">' +
      '<span>' + escapeHtml(ev.action) + '</span>' +
      '<span class="text-[10px] font-mono text-neutral-500">' + new Date(ev.timestamp).toLocaleTimeString() + '</span>' +
      '</div>' +
      '<div class="text-[11px] font-mono text-neutral-500 truncate">' + escapeHtml(JSON.stringify(ev.details)) + '</div>';
    auditLogContainer.append(item);
  }
}

// Per-element auto-dismiss timers so inline status text (e.g. "User created
// successfully") does not stay on screen forever while the operator keeps
// navigating — mirrors the toast auto-dismiss behavior above.
const inlineMessageTimers = new WeakMap();

function setInlineMessage(element, text, isError) {
  if (!element) return;
  const existingTimer = inlineMessageTimers.get(element);
  if (existingTimer) window.clearTimeout(existingTimer);
  element.textContent = text;
  element.classList.remove('hidden', 'text-red-400', 'text-emerald-400');
  element.classList.add(isError ? 'text-red-400' : 'text-emerald-400');
  const timer = window.setTimeout(() => clearInlineMessage(element), isError ? 8000 : 5000);
  inlineMessageTimers.set(element, timer);
}

function clearInlineMessage(element) {
  if (!element) return;
  const existingTimer = inlineMessageTimers.get(element);
  if (existingTimer) {
    window.clearTimeout(existingTimer);
    inlineMessageTimers.delete(element);
  }
  element.textContent = '';
  element.classList.add('hidden');
}

function renderTableLoadError(tbody, colspan, label) {
  if (!tbody) return;
  tbody.innerHTML =
    '<tr><td colspan="' + colspan + '" class="px-3 py-4 text-center text-red-400">' +
    'Failed to load ' + label + ' — your session may have expired. Try refreshing the page.' +
    '</td></tr>';
}

function authHeaders() {
  return accessToken ? { authorization: 'Bearer ' + accessToken } : {};
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// Resilient fetch for the initial page/data loads. The server may briefly
// be unreachable right after a (re)start while libSQL/session stores warm up,
// so network errors and 5xx responses are retried with a short backoff. Any
// HTTP status < 500 (e.g. a 401 for a truly expired session) is returned as-is
// in the final attempt so callers keep their existing error handling.
async function fetchWithRetry(input, init, retries, baseDelayMs) {
  const maxAttempts = Math.max(1, Number.isFinite(retries) ? retries : 3);
  const delayMs = Math.max(100, Number.isFinite(baseDelayMs) ? baseDelayMs : 500);
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(input, init);
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      await sleep(delayMs * attempt);
      continue;
    }
    if (res.ok || res.status < 500 || attempt >= maxAttempts) return res;
    await sleep(delayMs * attempt);
  }
}

function cssSafe(value) {
  return value.replace(/[^a-zA-Z0-9-]/g, '-');
}

// Tab Switching System
function switchTab(targetTabId) {
  withViewTransition(() => {
    navTabs.forEach((tab) => {
      const isActive = tab.getAttribute('data-target') === targetTabId;
      tab.classList.toggle('active', isActive);
    });
    tabContents.forEach((content) => {
      const isTarget = content.id === targetTabId;
      content.classList.toggle('active', isTarget);
    });
  });
  const hash = targetTabId.replace('tab-', '');
  window.location.hash = hash;
}

navTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const targetId = tab.getAttribute('data-target');
    if (targetId) switchTab(targetId);
  });
});

document.querySelectorAll('[data-jump]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-jump');
    if (target) switchTab(target);
  });
});

function applyGlobalAdminGating() {
  const show = (el, visible) => {
    if (!el) return;
    el.classList.toggle('hidden', !visible);
  };
  show(usersScreen, currentIsGlobalAdmin);
  show(rolesScreen, currentIsGlobalAdmin);
  show(addonsScreen, currentIsGlobalAdmin);
  show(notAdminNotice, !currentIsGlobalAdmin);
}

function showSession(username, isGlobalAdmin) {
  withViewTransition(() => {
    currentUsername = username;
    currentIsGlobalAdmin = Boolean(isGlobalAdmin);
    if (loginView) loginView.classList.add('hidden');
    if (sessionPanel) sessionPanel.classList.remove('hidden');
    if (sessionUsername) sessionUsername.textContent = username;
    applyGlobalAdminGating();
  });
  logAuditEvent('Session authenticated', { username: username, isGlobalAdmin: currentIsGlobalAdmin });

  // Hash navigation check
  const hash = window.location.hash.replace('#', '');
  if (hash && document.getElementById('tab-' + hash)) {
    switchTab('tab-' + hash);
  }

  // Load data FIRST. Any exception in the (cosmetic, non-essential) tour or
  // audit code below must never abort the initial data population, otherwise
  // a fully healthy admin logs in to empty tables until the next write
  // triggers a re-fetch. Data loading is the critical path here.
  if (currentIsGlobalAdmin) {
    void loadUsers();
    void loadTrustedAddons();
    void loadReposAndDirectory();
  }

  runNonCritical(() => maybeRunDashboardTour());
  runNonCritical(() => {
    if (currentIsGlobalAdmin) {
      maybeRunAddonsTour();
      maybeRunUsersTour();
    }
  });
}

// Wraps cosmetic/side-effect work (onboarding tours, etc.) so a runtime error
// there can never break the sessions flow or the data load that follows.
function runNonCritical(task) {
  try {
    task();
  } catch (err) {
    console.error('Non-critical UI step failed:', err);
  }
}

function showForm() {
  withViewTransition(() => {
    currentUsername = null;
    currentIsGlobalAdmin = false;
    accessToken = null;
    if (sessionPanel) sessionPanel.classList.add('hidden');
    if (loginView) loginView.classList.remove('hidden');
    if (form) form.reset();
  });
}

// Login
if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearInlineMessage(errorMessage);
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        setInlineMessage(errorMessage, 'Invalid credentials.', true);
        showToast('Invalid username or password', true);
        return;
      }
      const data = await res.json();
      accessToken = data.accessToken;
      showSession(data.username, data.isGlobalAdmin);
      showToast('Signed in successfully as ' + data.username, false);
    } catch {
      setInlineMessage(errorMessage, 'Could not reach the Deltix-Server.', true);
      showToast('Could not reach the Deltix-Server', true);
    }
  });
}

// Logout
if (logoutButton) {
  logoutButton.addEventListener('click', async () => {
    try {
      await fetch('/api/v1/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
    } finally {
      showForm();
      showToast('Signed out', false);
    }
  });
}

// ==================== REPOSITORIES & ROLES ====================

async function loadReposAndDirectory() {
  if (!accessToken) return;
  try {
    const res = await fetchWithRetry('/api/v1/versioning/repos', { headers: authHeaders(), cache: 'no-store' });
    if (!res.ok) {
      if (rolesRepoSelect) rolesRepoSelect.innerHTML = '<option value="">Failed to load repositories</option>';
      if (reposTableBody) renderTableLoadError(reposTableBody, 4, 'repositories');
      return;
    }
    const data = await res.json();
    const repos = data.repos || [];
    if (dashRepoCount) dashRepoCount.textContent = String(repos.length);
    renderReposDirectory(repos);
    populateRepoSelect(repos);
  } catch {
    if (reposTableBody) renderTableLoadError(reposTableBody, 4, 'repositories');
  }
}

function populateRepoSelect(repos) {
  if (!rolesRepoSelect) return;
  const previouslySelected = rolesRepoSelect.value;
  rolesRepoSelect.innerHTML = '<option value="">Select a repository…</option>';
  for (const repo of repos) {
    const option = document.createElement('option');
    option.value = repo.repoId;
    option.textContent = repo.repoId;
    rolesRepoSelect.append(option);
  }
  if (previouslySelected && repos.some((r) => r.repoId === previouslySelected)) {
    rolesRepoSelect.value = previouslySelected;
  }
}

function renderReposDirectory(repos) {
  if (!reposTableBody) return;
  reposTableBody.innerHTML = '';
  if (repos.length === 0) {
    reposTableBody.innerHTML =
      '<tr><td colspan="4" class="px-3 py-4 text-center text-neutral-500">No repositories provisioned yet.</td></tr>';
    return;
  }
  for (const repo of repos) {
    const row = document.createElement('tr');
    row.className = 'border-b border-neutral-800 last:border-0 hover:bg-neutral-800/30 transition';
    row.innerHTML =
      '<td class="px-3 py-2.5 font-medium font-mono text-neutral-200"></td>' +
      '<td class="px-3 py-2.5 font-mono text-neutral-400"></td>' +
      '<td class="px-3 py-2.5 text-neutral-300"></td>' +
      '<td class="px-3 py-2.5 text-neutral-500 font-mono text-[11px]"></td>';
    row.children[0].textContent = repo.repoId;
    row.children[1].textContent = repo.defaultBranch || 'main';
    row.children[2].textContent = repo.description || '—';
    row.children[3].textContent = new Date(repo.createdAt).toLocaleString();
    reposTableBody.append(row);
  }
}

if (repoCreateForm) {
  repoCreateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearInlineMessage(repoCreateMessage);
    const repoId = document.getElementById('new-repo-id').value.trim();
    const description = document.getElementById('new-repo-desc').value.trim();
    try {
      const res = await fetch('/api/v1/versioning/repos', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ repoId, description }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setInlineMessage(repoCreateMessage, data.error || 'Could not create repository.', true);
        showToast(data.error || 'Failed to create repository', true);
        return;
      }
      setInlineMessage(repoCreateMessage, 'Repository created successfully.', false);
      showToast('Repository "' + repoId + '" provisioned', false);
      logAuditEvent('Repository created', { repoId: repoId });
      repoCreateForm.reset();
      await loadReposAndDirectory();
    } catch {
      setInlineMessage(repoCreateMessage, 'Could not reach server.', true);
    }
  });
}

if (rolesRepoSelect) {
  rolesRepoSelect.addEventListener('change', () => {
    selectedRolesRepoId = rolesRepoSelect.value;
    clearInlineMessage(roleMessage);
    void loadRepoRoles(selectedRolesRepoId);
  });
}

async function loadRepoRoles(repoId) {
  if (!rolesList) return;
  if (!repoId) {
    renderRepoRoles([]);
    return;
  }
  try {
    const res = await fetch('/api/v1/versioning/repos/' + encodeURIComponent(repoId) + '/roles', {
      headers: authHeaders(),
    });
    if (!res.ok) {
      renderTableLoadError(rolesList, 5, 'repo roles');
      return;
    }
    const data = await res.json();
    renderRepoRoles(data.roles || []);
  } catch {
    renderTableLoadError(rolesList, 5, 'repo roles');
  }
}

function renderRepoRoles(roles) {
  if (!rolesList) return;
  rolesList.innerHTML = '';
  if (roles.length === 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.id = 'roles-empty-row';
    emptyRow.innerHTML =
      '<td colspan="5" class="px-3 py-4 text-center text-neutral-500">' +
      (selectedRolesRepoId ? 'No roles granted for this repository yet.' : 'Select a repository to view its roles.') +
      '</td>';
    rolesList.append(emptyRow);
    return;
  }
  for (const assignment of roles) {
    const row = document.createElement('tr');
    row.className = 'border-b border-neutral-800 last:border-0 hover:bg-neutral-800/30 transition';
    const revokeBtn = document.createElement('button');
    revokeBtn.type = 'button';
    revokeBtn.textContent = 'Revoke';
    revokeBtn.className = 'text-xs text-neutral-400 hover:text-red-400 transition';
    revokeBtn.addEventListener('click', () => revokeRepoRole(assignment.username));
    row.innerHTML =
      '<td class="px-3 py-2 font-medium text-neutral-200"></td>' +
      '<td class="px-3 py-2"><span class="px-2 py-0.5 rounded font-mono text-[11px] bg-neutral-800 text-neutral-300"></span></td>' +
      '<td class="px-3 py-2 text-neutral-400"></td>' +
      '<td class="px-3 py-2 text-neutral-400"></td>' +
      '<td class="px-3 py-2 text-right"></td>';
    row.children[0].textContent = assignment.username;
    row.children[1].children[0].textContent = assignment.role;
    row.children[2].textContent = new Date(assignment.grantedAt).toLocaleString();
    row.children[3].textContent = assignment.grantedBy;
    row.children[4].append(revokeBtn);
    rolesList.append(row);
  }
}

if (roleGrantForm) {
  roleGrantForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearInlineMessage(roleMessage);
    if (!selectedRolesRepoId) {
      setInlineMessage(roleMessage, 'Select a repository first.', true);
      return;
    }
    const username = document.getElementById('role-grant-username').value.trim();
    const role = document.getElementById('role-grant-role').value;
    try {
      const res = await fetch(
        '/api/v1/versioning/repos/' + encodeURIComponent(selectedRolesRepoId) + '/roles',
        {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, authHeaders()),
          body: JSON.stringify({ username, role }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setInlineMessage(roleMessage, data.error || 'Could not grant role.', true);
        showToast(data.error || 'Failed to grant role', true);
        return;
      }
      setInlineMessage(roleMessage, 'Granted "' + role + '" to ' + username + '.', false);
      showToast('Role ' + role + ' granted to ' + username, false);
      logAuditEvent('Repo role granted', { repoId: selectedRolesRepoId, username, role });
      roleGrantForm.reset();
      await loadRepoRoles(selectedRolesRepoId);
    } catch {
      setInlineMessage(roleMessage, 'Could not reach server.', true);
    }
  });
}

async function revokeRepoRole(username) {
  if (!selectedRolesRepoId) return;
  try {
    const res = await fetch(
      '/api/v1/versioning/repos/' +
        encodeURIComponent(selectedRolesRepoId) +
        '/roles/' +
        encodeURIComponent(username),
      { method: 'DELETE', headers: authHeaders() },
    );
    if (!res.ok && res.status !== 204) {
      const data = await res.json().catch(() => ({}));
      setInlineMessage(roleMessage, data.error || 'Could not revoke role.', true);
      showToast('Could not revoke role', true);
      return;
    }
    setInlineMessage(roleMessage, 'Revoked role for ' + username + '.', false);
    showToast('Role revoked for ' + username, false);
    logAuditEvent('Repo role revoked', { repoId: selectedRolesRepoId, username });
    await loadRepoRoles(selectedRolesRepoId);
  } catch {
    setInlineMessage(roleMessage, 'Could not reach server.', true);
  }
}

// ==================== USERS MANAGEMENT ====================

async function loadUsers() {
  if (!userList || !accessToken) return;
  try {
    const res = await fetchWithRetry('/api/v1/auth/users', { headers: authHeaders(), cache: 'no-store' });
    if (!res.ok) {
      renderTableLoadError(userList, 7, 'users');
      return;
    }
    const data = await res.json();
    renderUsers(data.users || []);
  } catch {
    renderTableLoadError(userList, 7, 'users');
  }
}

function renderUsers(users) {
  if (!userList) return;
  const activeSeats = users.filter((user) => user.activeSessions > 0).length;
  if (seatsUsed) seatsUsed.textContent = String(activeSeats);
  if (dashActiveSeats) dashActiveSeats.textContent = String(activeSeats);
  if (dashTotalUsers) dashTotalUsers.textContent = String(users.length);

  if (knownUsernamesList) {
    knownUsernamesList.innerHTML = users
      .map((user) => '<option value="' + escapeHtml(user.username) + '"></option>')
      .join('');
  }

  userList.innerHTML = '';
  if (users.length === 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.id = 'user-empty-row';
    emptyRow.innerHTML = '<td colspan="7" class="px-3 py-4 text-center text-neutral-500">No users created yet.</td>';
    userList.append(emptyRow);
    return;
  }
  for (const user of users) {
    const row = document.createElement('tr');
    row.className = 'border-b border-neutral-800 last:border-0 hover:bg-neutral-800/30 transition';
    const actions = document.createElement('td');
    actions.className = 'px-3 py-2 text-right';
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'inline-flex items-center gap-1';

    const toggleBtn = iconButton(
      user.active ? ICON_PAUSE : ICON_PLAY,
      user.active ? 'Deactivate user' : 'Reactivate user',
      'hover:text-amber-400 hover:border-amber-900/60',
    );
    toggleBtn.addEventListener('click', () => toggleUser(user));

    const adminToggleBtn = iconButton(
      ICON_SHIELD,
      user.isGlobalAdmin ? 'Revoke global admin' : 'Grant global admin',
      user.isGlobalAdmin ? 'text-emerald-400 hover:text-neutral-300' : 'hover:text-emerald-400',
    );
    adminToggleBtn.addEventListener('click', () => toggleGlobalAdmin(user));

    const deleteBtn = iconButton(ICON_TRASH, 'Delete user', 'hover:text-red-400 hover:border-red-900/60');
    deleteBtn.addEventListener('click', () => promptDeleteUser(user.username));

    actionsWrap.append(toggleBtn, adminToggleBtn, deleteBtn);
    actions.append(actionsWrap);

    const statusBadge = user.active
      ? '<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] bg-neutral-900 border border-neutral-800 text-neutral-300"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>Active</span>'
      : '<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] bg-neutral-900 border border-neutral-800 text-neutral-500"><span class="w-1.5 h-1.5 rounded-full bg-neutral-600"></span>Inactive</span>';

    row.innerHTML =
      '<td class="px-3 py-2 font-medium text-neutral-200"></td>' +
      '<td class="px-3 py-2">' + statusBadge + '</td>' +
      '<td class="px-3 py-2 text-neutral-300 font-mono text-[11px]"></td>' +
      '<td class="px-3 py-2 text-neutral-500 font-mono text-[11px]"></td>' +
      '<td class="px-3 py-2 font-mono text-neutral-300"></td>' +
      '<td class="px-3 py-2 text-neutral-500 font-mono text-[11px]"></td>';

    row.children[0].textContent = user.username;
    row.children[2].textContent = user.isGlobalAdmin ? 'Yes (Global)' : 'No';
    row.children[3].textContent = new Date(user.createdAt).toLocaleString();
    row.children[4].textContent = String(user.activeSessions);
    row.children[5].textContent = user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never';
    row.append(actions);
    userList.append(row);
  }
}

async function toggleGlobalAdmin(user) {
  try {
    const res = await fetch(
      '/api/v1/auth/users/' + encodeURIComponent(user.username) + '/global-admin',
      { method: user.isGlobalAdmin ? 'DELETE' : 'POST', headers: authHeaders() },
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setInlineMessage(userMessage, data.error || 'Could not update global admin status.', true);
      showToast('Could not update admin status', true);
      return;
    }
    const msg = user.isGlobalAdmin ? 'Global admin revoked' : 'Global admin granted';
    setInlineMessage(userMessage, msg, false);
    showToast(msg + ' for ' + user.username, false);
    logAuditEvent('User global-admin toggled', { username: user.username, isGlobalAdmin: !user.isGlobalAdmin });
    await loadUsers();
  } catch {
    setInlineMessage(userMessage, 'Could not reach server.', true);
  }
}

async function toggleUser(user) {
  try {
    const res = await fetch('/api/v1/auth/users/' + encodeURIComponent(user.username) + '/' + (user.active ? 'deactivate' : 'reactivate'), {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setInlineMessage(userMessage, data.error || 'Could not update user.', true);
      showToast('Could not update user', true);
      return;
    }
    const msg = user.active ? 'User deactivated' : 'User reactivated';
    setInlineMessage(userMessage, msg, false);
    showToast(msg + ': ' + user.username, false);
    logAuditEvent('User active status toggled', { username: user.username, active: !user.active });
    await loadUsers();
  } catch {
    setInlineMessage(userMessage, 'Could not reach server.', true);
  }
}

function promptDeleteUser(username) {
  pendingDeleteUsername = username;
  if (deleteUsername) deleteUsername.textContent = username;
  if (deleteConfirmPanel) deleteConfirmPanel.classList.remove('hidden');
}

function clearDeletePrompt() {
  pendingDeleteUsername = null;
  if (deleteConfirmPanel) deleteConfirmPanel.classList.add('hidden');
}

if (confirmDeleteButton) {
  confirmDeleteButton.addEventListener('click', async () => {
    if (!pendingDeleteUsername) return;
    const target = pendingDeleteUsername;
    try {
      const res = await fetch('/api/v1/auth/users/' + encodeURIComponent(target), {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setInlineMessage(userMessage, data.error || 'Could not delete user.', true);
        showToast('Could not delete user', true);
        return;
      }
      setInlineMessage(userMessage, 'User deleted', false);
      showToast('User "' + target + '" permanently deleted', false);
      logAuditEvent('User deleted', { username: target });
      clearDeletePrompt();
      await loadUsers();
    } catch {
      setInlineMessage(userMessage, 'Could not reach server.', true);
    }
  });
}

if (cancelDeleteButton) {
  cancelDeleteButton.addEventListener('click', clearDeletePrompt);
}

if (userCreateForm) {
  userCreateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearInlineMessage(userMessage);
    const username = document.getElementById('new-username').value.trim();
    const password = document.getElementById('new-password').value;
    try {
      const res = await fetch('/api/v1/auth/users', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setInlineMessage(userMessage, data.error || 'Could not create user.', true);
        showToast(data.error || 'Failed to create user', true);
        return;
      }
      setInlineMessage(userMessage, 'User created successfully', false);
      showToast('User "' + username + '" created', false);
      logAuditEvent('User created', { username: username });
      userCreateForm.reset();
      await loadUsers();
    } catch {
      setInlineMessage(userMessage, 'Could not reach server.', true);
    }
  });
}

// ==================== ADD-ONS (TOFU) ====================

async function loadTrustedAddons() {
  if (!trustList || !accessToken) return;
  try {
    const res = await fetchWithRetry('/api/v1/addons/trust', { headers: authHeaders(), cache: 'no-store' });
    if (!res.ok) {
      renderTableLoadError(trustList, 5, 'trusted addons');
      return;
    }
    const data = await res.json();
    const trusted = data.trusted || [];
    if (dashAddonsCount) dashAddonsCount.textContent = String(trusted.length);
    renderTrustedAddons(trusted);
  } catch {
    renderTableLoadError(trustList, 5, 'trusted addons');
  }
}

function renderTrustedAddons(trusted) {
  if (!trustList) return;
  trustList.innerHTML = '';
  if (trusted.length === 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.id = 'trust-empty-row';
    emptyRow.innerHTML = '<td class="px-3 py-4 text-center text-neutral-500" colspan="5">No community add-ons trusted yet.</td>';
    trustList.append(emptyRow);
    return;
  }
  for (const record of trusted) {
    const row = document.createElement('tr');
    row.className = 'border-b border-neutral-800 last:border-0 hover:bg-neutral-800/30 transition';
    row.innerHTML =
      '<td class="px-3 py-2 font-mono text-neutral-200"></td>' +
      '<td class="max-w-[200px] truncate px-3 py-2 font-mono text-neutral-400"></td>' +
      '<td class="px-3 py-2 text-neutral-500 font-mono text-[11px]"></td>' +
      '<td class="px-3 py-2 text-neutral-400"></td>' +
      '<td class="px-3 py-2 text-right"></td>';
    row.children[0].textContent = record.addonName;
    row.children[1].textContent = record.authorPublicKey;
    row.children[1].title = record.authorPublicKey;
    row.children[2].textContent = new Date(record.trustedAt).toLocaleString();
    row.children[3].textContent = record.trustedBy;
    const revokeBtn = document.createElement('button');
    revokeBtn.type = 'button';
    revokeBtn.textContent = 'Revoke';
    revokeBtn.className = 'text-xs text-neutral-400 hover:text-red-400 transition';
    revokeBtn.addEventListener('click', () => revokeTrust(record.addonName));
    row.children[4].append(revokeBtn);
    trustList.append(row);
  }
}

async function revokeTrust(addonName) {
  try {
    await fetch('/api/v1/addons/revoke', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ addonName }),
    });
    showToast('Trust revoked for "' + addonName + '"', false);
    logAuditEvent('Addon trust revoked', { addonName });
    await loadTrustedAddons();
  } catch {
    setInlineMessage(trustMessage, 'Could not reach server.', true);
  }
}

if (trustForm) {
  trustForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearInlineMessage(trustMessage);
    const addonName = document.getElementById('trust-addon-name').value.trim();
    const authorPublicKey = document.getElementById('trust-public-key').value.trim();
    try {
      const res = await fetch('/api/v1/addons/trust', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ addonName, authorPublicKey }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setInlineMessage(trustMessage, data.error || 'Could not trust this key.', true);
        showToast(data.error || 'Failed to trust addon', true);
        return;
      }
      setInlineMessage(trustMessage, 'Trusted "' + addonName + '". Takes effect on restart.', false);
      showToast('Key trusted for "' + addonName + '"', false);
      logAuditEvent('Addon key trusted', { addonName });
      trustForm.reset();
      await loadTrustedAddons();
    } catch {
      setInlineMessage(trustMessage, 'Could not reach server.', true);
    }
  });
}

// ==================== AUDIT & SUPPORT EXPORT ====================

if (copySupportBundleBtn) {
  copySupportBundleBtn.addEventListener('click', async () => {
    const bundle = {
      deltixVersion: serverVersion || 'unknown',
      timestamp: new Date().toISOString(),
      user: currentUsername,
      isGlobalAdmin: currentIsGlobalAdmin,
      engine: {
        controlPlane: 'HTTP REST :9090 (HonoJS)',
        grpcTransfer: 'gRPC Engine :50051 (TLS)',
        storage: 'Dolt commit-graph',
        auth: 'libSQL + Argon2id',
      },
      recentSessionEvents: auditEvents.slice(0, 10),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      showToast('Diagnostic report copied to clipboard!', false);
    } catch {
      showToast('Unable to copy to clipboard', true);
    }
  });
}

// ==================== SETUP FLOW ====================

if (setupForm) {
  setupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearInlineMessage(setupMessage);
    const username = document.getElementById('setup-username').value.trim();
    const password = document.getElementById('setup-password').value;
    const confirmation = document.getElementById('setup-password-confirm').value;
    if (password !== confirmation) {
      setInlineMessage(setupMessage, 'Passwords must match.', true);
      return;
    }
    try {
      const res = await fetch('/api/v1/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setInlineMessage(setupMessage, data.error || 'Could not complete setup.', true);
        return;
      }
      setInlineMessage(setupMessage, 'Admin created. Redirecting to sign in…', false);
      localStorage.setItem('deltix-admin-setup-tour-seen', 'true');
      window.setTimeout(() => {
        window.location.href = '/admin';
      }, 600);
    } catch {
      setInlineMessage(setupMessage, 'Could not reach server.', true);
    }
  });
}

// ==================== VERSION BADGE ====================

// Fills the `#server-version-badge` span and the support bundle with the
// real server version from the public, unauthenticated /status endpoint
// instead of a hardcoded string that drifts out of date on every release.
// The /status response shape is { version, commit, nodeEnv } (see
// src/shared/build-info.ts).
let serverVersion = null;

async function refreshServerVersion() {
  const badge = document.getElementById('server-version-badge');
  if (!badge) return;
  try {
    const res = await fetch('/status', { cache: 'no-store' });
    if (!res.ok) return;
    const info = await res.json();
    if (info.version) {
      serverVersion = 'v' + info.version;
      badge.textContent = serverVersion;
      badge.title = 'Commit ' + (info.commit || 'unknown');
    }
  } catch {
    // server may still be booting; leave the placeholder in place
  }
}

refreshServerVersion();

// ==================== TOURS & SESSION RESTORATION ====================

function maybeRunSetupTour() {
  if (localStorage.getItem('deltix-admin-setup-tour-seen') || !window.driver || !setupForm) return;
  const driverInstance = window.driver.js.driver({
    showProgress: true,
    steps: [
      { element: '#setup-form', popover: { title: 'Create the first admin', description: 'Set the first local administrator for this instance.' } },
      { element: '#setup-submit', popover: { title: 'Finish setup', description: 'Once created, sign in with this user and manage additional accounts from the Users panel.' } },
    ],
  });
  driverInstance.drive();
}

function maybeRunDashboardTour() {
  if (localStorage.getItem('deltix-admin-dashboard-tour-seen') || !window.driver || !document.getElementById('main-nav-tabs')) return;
  const steps = [
    { element: '#main-nav-tabs', popover: { title: 'Navigate the control plane', description: 'Everything lives behind these tabs: an at-a-glance dashboard, repository roles, user management, community add-ons, and the audit log.' } },
    { element: '[data-target="tab-dashboard"]', popover: { title: 'Dashboard', description: 'Live counters for repositories, active user sessions, and trusted add-ons.' } },
    { element: '[data-target="tab-repos"]', popover: { title: 'Repositories & Roles', description: 'See every Dolt repository and grant or revoke per-repository roles.' } },
  ];
  if (currentIsGlobalAdmin) {
    steps.push(
      { element: '[data-target="tab-users"]', popover: { title: 'User Management', description: 'Create local accounts and review seat usage — only visible to global administrators.' } },
      { element: '[data-target="tab-addons"]', popover: { title: 'Community Add-ons', description: 'Trust-on-first-use (TOFU) management for community add-on author keys.' } },
    );
  }
  steps.push({ element: '[data-target="tab-audit"]', popover: { title: 'Audit & Diagnostics', description: 'Session activity log and a one-click diagnostic report for support requests.' } });
  const driverInstance = window.driver.js.driver({ showProgress: true, steps });
  driverInstance.drive();
  localStorage.setItem('deltix-admin-dashboard-tour-seen', 'true');
}

function maybeRunAddonsTour() {
  if (localStorage.getItem('deltix-admin-addons-tour-seen') || !window.driver || !trustForm) return;
  const driverInstance = window.driver.js.driver({
    showProgress: true,
    steps: [
      { element: '#trust-form', popover: { title: 'Trust a community addon (TOFU)', description: 'Paste an addon name and the author public key to trust that community addon.' } },
      { element: '#trust-list', popover: { title: 'Trusted addons', description: 'Review which addon keys are currently trusted and revoke them if needed.' } },
    ],
  });
  driverInstance.drive();
  localStorage.setItem('deltix-admin-addons-tour-seen', 'true');
}

function maybeRunUsersTour() {
  if (localStorage.getItem('deltix-admin-users-tour-seen') || !window.driver || !userCreateForm) return;
  const driverInstance = window.driver.js.driver({
    showProgress: true,
    steps: [
      { element: '#users-seats-indicator', popover: { title: 'Seat usage', description: 'This indicator tracks how many users currently have active sessions.' } },
      { element: '#user-create-form', popover: { title: 'Create user', description: 'Create a new local user without restarting the server.' } },
      { element: '#user-list', popover: { title: 'User table', description: 'Review account status, creation date, last login and active sessions at a glance.' } },
    ],
  });
  driverInstance.drive();
  localStorage.setItem('deltix-admin-users-tour-seen', 'true');
}

async function restoreSessionOnLoad() {
  if (setupForm) {
    maybeRunSetupTour();
    return;
  }
  try {
    // Gate: the server may still be booting right after a restart, so a
    // transient refresh failure must not strand the operator on the login
    // screen permanently. fetchWithRetry retries network/5xx errors; a
    // genuine 401 (no valid session cookie) returns immediately.
    const res = await fetchWithRetry('/api/v1/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return;
    const data = await res.json();
    accessToken = data.accessToken;
    showSession(data.username, data.isGlobalAdmin);
  } catch {}
}

restoreSessionOnLoad();
