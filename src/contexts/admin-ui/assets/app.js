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

function withViewTransition(mutate) {
  if (typeof document.startViewTransition === 'function') {
    document.startViewTransition(() => mutate());
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

function setInlineMessage(element, text, isError) {
  if (!element) return;
  element.textContent = text;
  element.classList.remove('hidden', 'text-red-400', 'text-emerald-400');
  element.classList.add(isError ? 'text-red-400' : 'text-emerald-400');
}

function clearInlineMessage(element) {
  if (!element) return;
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

function cssSafe(value) {
  return value.replace(/[^a-zA-Z0-9-]/g, '-');
}

// Tab Switching System
function switchTab(targetTabId) {
  navTabs.forEach((tab) => {
    const isActive = tab.getAttribute('data-target') === targetTabId;
    tab.classList.toggle('active', isActive);
  });
  tabContents.forEach((content) => {
    const isTarget = content.id === targetTabId;
    content.classList.toggle('active', isTarget);
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

  if (!currentIsGlobalAdmin) return;
  void loadUsers();
  void loadTrustedAddons();
  void loadReposAndDirectory();
  maybeRunAddonsTour();
  maybeRunUsersTour();
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
    const res = await fetch('/api/v1/versioning/repos', { headers: authHeaders() });
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
    const res = await fetch('/api/v1/auth/users', { headers: authHeaders() });
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
    actions.className = 'px-3 py-2 text-right space-x-2';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs hover:bg-neutral-800 text-neutral-300 transition';
    toggleBtn.textContent = user.active ? 'Deactivate' : 'Reactivate';
    toggleBtn.addEventListener('click', () => toggleUser(user));

    const adminToggleBtn = document.createElement('button');
    adminToggleBtn.type = 'button';
    adminToggleBtn.className = 'rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs hover:bg-neutral-800 text-neutral-300 transition';
    adminToggleBtn.textContent = user.isGlobalAdmin ? 'Revoke Admin' : 'Make Admin';
    adminToggleBtn.addEventListener('click', () => toggleGlobalAdmin(user));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-400 hover:text-red-400 hover:border-red-900/60 transition';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => promptDeleteUser(user.username));

    actions.append(toggleBtn, adminToggleBtn, deleteBtn);

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
    const res = await fetch('/api/v1/addons/trust', { headers: authHeaders() });
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
      deltixVersion: 'v0.4.1',
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
    const res = await fetch('/api/v1/auth/refresh', {
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
