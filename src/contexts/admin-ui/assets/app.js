let accessToken = null;
let currentUsername = null;
let currentIsGlobalAdmin = false;
let pendingDeleteUsername = null;
let selectedRolesRepoId = '';

const form = document.getElementById('login-form');
const errorMessage = document.getElementById('error-message');
const loginView = document.getElementById('login-view');
const sessionPanel = document.getElementById('session-panel');
const sessionUsername = document.getElementById('session-username');
const logoutButton = document.getElementById('logout-button');
const notAdminNotice = document.getElementById('not-admin-notice');
const trustForm = document.getElementById('trust-form');
const trustMessage = document.getElementById('trust-message');
const trustList = document.getElementById('trust-list');
const addonsScreen = document.getElementById('addons-screen');
const setupForm = document.getElementById('setup-form');
const setupMessage = document.getElementById('setup-message');
const usersScreen = document.getElementById('users-screen');
const userCreateForm = document.getElementById('user-create-form');
const userMessage = document.getElementById('user-message');
const userList = document.getElementById('user-list');
const seatsUsed = document.getElementById('seats-used');
const deleteConfirmPanel = document.getElementById('delete-confirm-panel');
const deleteUsername = document.getElementById('delete-username');
const confirmDeleteButton = document.getElementById('confirm-delete-button');
const cancelDeleteButton = document.getElementById('cancel-delete-button');
const rolesScreen = document.getElementById('roles-screen');
const rolesRepoSelect = document.getElementById('roles-repo-select');
const roleGrantForm = document.getElementById('role-grant-form');
const roleMessage = document.getElementById('role-message');
const rolesList = document.getElementById('roles-list');

function withViewTransition(mutate) {
  if (typeof document.startViewTransition === 'function') {
    document.startViewTransition(() => mutate());
  } else {
    mutate();
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

function authHeaders() {
  return accessToken ? { authorization: 'Bearer ' + accessToken } : {};
}

function cssSafe(value) {
  return value.replace(/[^a-zA-Z0-9-]/g, '-');
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
  if (!currentIsGlobalAdmin) return;
  void loadUsers();
  void loadTrustedAddons();
  void loadReposForRoles();
  maybeRunAddonsTour();
  maybeRunUsersTour();
}

/**
 * Global admin gates the entire management surface of the Admin Web UI —
 * Users, Repository roles, and Community addon trust. A user who is
 * authenticated but not a global admin sees only the "signed in as" header
 * and an explanatory notice; none of the management API calls fire for
 * them (defense in depth: the server-side endpoints already reject with
 * 403, this just avoids a confusing wall of failed requests in the UI).
 */
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
        return;
      }
      const data = await res.json();
      accessToken = data.accessToken;
      showSession(data.username, data.isGlobalAdmin);
    } catch {
      setInlineMessage(errorMessage, 'Could not reach the Deltix-Server.', true);
    }
  });
}

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
    }
  });
}

async function loadTrustedAddons() {
  if (!trustList || !accessToken) return;
  try {
    const res = await fetch('/api/v1/addons/trust', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    renderTrustedAddons(data.trusted || []);
  } catch {}
}

function renderTrustedAddons(trusted) {
  if (!trustList) return;
  withViewTransition(() => {
    trustList.innerHTML = '';
    if (trusted.length === 0) {
      const emptyRow = document.createElement('tr');
      emptyRow.id = 'trust-empty-row';
      emptyRow.innerHTML = '<td class="px-3 py-4 text-center text-neutral-500" colspan="5">No community addons trusted yet.</td>';
      trustList.append(emptyRow);
      return;
    }
    for (const record of trusted) {
      const row = document.createElement('tr');
      row.className = 'border-b border-neutral-800 last:border-0 hover:bg-neutral-800/40';
      row.dataset.vt = 'trust-row';
      row.style.setProperty('--vt-name', 'trust-row-' + cssSafe(record.addonName));
      row.innerHTML =
        '<td class="px-3 py-2 font-mono"></td>' +
        '<td class="max-w-[220px] truncate px-3 py-2 font-mono text-neutral-400"></td>' +
        '<td class="hidden px-3 py-2 text-neutral-400 sm:table-cell"></td>' +
        '<td class="hidden px-3 py-2 text-neutral-400 sm:table-cell"></td>' +
        '<td class="px-3 py-2 text-right"></td>';
      row.children[0].textContent = record.addonName;
      row.children[1].textContent = record.authorPublicKey;
      row.children[1].title = record.authorPublicKey;
      row.children[2].textContent = new Date(record.trustedAt).toLocaleString();
      row.children[3].textContent = record.trustedBy;
      const revokeBtn = document.createElement('button');
      revokeBtn.type = 'button';
      revokeBtn.textContent = 'Revoke';
      revokeBtn.className = 'text-red-400 hover:text-red-300';
      revokeBtn.addEventListener('click', () => revokeTrust(record.addonName));
      row.children[4].append(revokeBtn);
      trustList.append(row);
    }
  });
}

async function revokeTrust(addonName) {
  try {
    await fetch('/api/v1/addons/revoke', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ addonName }),
    });
    await loadTrustedAddons();
  } catch {
    setInlineMessage(trustMessage, 'Could not reach the Deltix-Server.', true);
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
        return;
      }
      setInlineMessage(trustMessage, 'Trusted "' + addonName + '". Takes effect on next server restart.', false);
      trustForm.reset();
      await loadTrustedAddons();
    } catch {
      setInlineMessage(trustMessage, 'Could not reach the Deltix-Server.', true);
    }
  });
}

async function loadUsers() {
  if (!userList || !accessToken) return;
  try {
    const res = await fetch('/api/v1/auth/users', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    renderUsers(data.users || []);
  } catch {}
}

function renderUsers(users) {
  if (!userList) return;
  const activeSeats = users.filter((user) => user.activeSessions > 0).length;
  if (seatsUsed) {
    seatsUsed.textContent = String(activeSeats);
  }
  withViewTransition(() => {
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
      row.className = 'border-b border-neutral-800 last:border-0 hover:bg-neutral-800/40';
      row.dataset.vt = 'user-row';
      row.style.setProperty('--vt-name', 'user-row-' + cssSafe(user.username));
      const actions = document.createElement('td');
      actions.className = 'px-3 py-2 text-right';
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'mr-2 rounded-md border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800';
      toggleBtn.textContent = user.active ? 'Deactivate' : 'Reactivate';
      toggleBtn.setAttribute('aria-label', user.active ? 'Deactivate ' + user.username : 'Reactivate ' + user.username);
      toggleBtn.addEventListener('click', () => toggleUser(user));
      const adminToggleBtn = document.createElement('button');
      adminToggleBtn.type = 'button';
      adminToggleBtn.className = 'mr-2 rounded-md border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800';
      adminToggleBtn.textContent = user.isGlobalAdmin ? 'Revoke admin' : 'Make admin';
      adminToggleBtn.setAttribute(
        'aria-label',
        (user.isGlobalAdmin ? 'Revoke global admin from ' : 'Make ') + user.username + (user.isGlobalAdmin ? '' : ' a global admin'),
      );
      adminToggleBtn.addEventListener('click', () => toggleGlobalAdmin(user));
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'rounded-md border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950/50';
      deleteBtn.textContent = 'Delete';
      deleteBtn.setAttribute('aria-label', 'Delete ' + user.username);
      deleteBtn.addEventListener('click', () => promptDeleteUser(user.username));
      actions.append(toggleBtn, adminToggleBtn, deleteBtn);
      row.innerHTML =
        '<td class="px-3 py-2 font-medium"></td>' +
        '<td class="px-3 py-2"></td>' +
        '<td class="px-3 py-2"></td>' +
        '<td class="px-3 py-2 text-neutral-400"></td>' +
        '<td class="px-3 py-2"></td>' +
        '<td class="px-3 py-2 text-neutral-400"></td>';
      row.children[0].textContent = user.username;
      row.children[1].textContent = user.active ? 'Active' : 'Inactive';
      row.children[2].textContent = user.isGlobalAdmin ? 'Yes' : 'No';
      row.children[3].textContent = new Date(user.createdAt).toLocaleString();
      row.children[4].textContent = String(user.activeSessions);
      row.children[5].textContent = user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never';
      row.append(actions);
      userList.append(row);
    }
  });
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
      return;
    }
    setInlineMessage(
      userMessage,
      user.isGlobalAdmin ? 'Global admin revoked' : 'Global admin granted',
      false,
    );
    await loadUsers();
  } catch {
    setInlineMessage(userMessage, 'Could not reach the Deltix-Server.', true);
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
      return;
    }
    setInlineMessage(userMessage, user.active ? 'Usuario desactivado' : 'Usuario reactivado', false);
    await loadUsers();
  } catch {
    setInlineMessage(userMessage, 'Could not reach the Deltix-Server.', true);
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
    try {
      const res = await fetch('/api/v1/auth/users/' + encodeURIComponent(pendingDeleteUsername), {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setInlineMessage(userMessage, data.error || 'Could not delete user.', true);
        return;
      }
      setInlineMessage(userMessage, 'Usuario eliminado', false);
      clearDeletePrompt();
      await loadUsers();
    } catch {
      setInlineMessage(userMessage, 'Could not reach the Deltix-Server.', true);
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
        return;
      }
      setInlineMessage(userMessage, 'Usuario creado', false);
      userCreateForm.reset();
      await loadUsers();
    } catch {
      setInlineMessage(userMessage, 'Could not reach the Deltix-Server.', true);
    }
  });
}

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
      setInlineMessage(setupMessage, 'Could not reach the Deltix-Server.', true);
    }
  });
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

function maybeRunSetupTour() {
  if (localStorage.getItem('deltix-admin-setup-tour-seen') || !window.driver || !setupForm) return;
  const driverInstance = window.driver.js.driver({
    showProgress: true,
    steps: [
      { element: '#setup-form', popover: { title: 'Create the first admin', description: 'Set the first local administrator for this instance. This page disappears as soon as setup completes.' } },
      { element: '#setup-submit', popover: { title: 'Finish setup', description: 'Once created, sign in with this user and manage additional accounts from the Users panel.' } },
    ],
  });
  driverInstance.drive();
}

if (!localStorage.getItem('deltix-admin-tour-seen') && window.driver && form) {
  const driverInstance = window.driver.js.driver({
    showProgress: true,
    steps: [{ element: '#login-form', popover: { title: 'Sign in', description: 'Use your local Deltix account credentials.' } }],
  });
  driverInstance.drive();
  localStorage.setItem('deltix-admin-tour-seen', 'true');
}

function maybeRunAddonsTour() {
  if (localStorage.getItem('deltix-admin-addons-tour-seen') || !window.driver || !trustForm) return;
  const driverInstance = window.driver.js.driver({
    showProgress: true,
    steps: [
      { element: '#trust-form', popover: { title: 'Trust a community addon (TOFU)', description: 'Paste an addon name and the author public key to trust that community addon for the next restart.' } },
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

async function loadReposForRoles() {
  if (!rolesRepoSelect || !accessToken) return;
  try {
    const res = await fetch('/api/v1/versioning/repos', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const repos = data.repos || [];
    const previouslySelected = rolesRepoSelect.value;
    rolesRepoSelect.innerHTML = '<option value="">Select a repository…</option>';
    for (const repo of repos) {
      const option = document.createElement('option');
      option.value = repo.repoId;
      option.textContent = repo.repoId;
      rolesRepoSelect.append(option);
    }
    if (previouslySelected && repos.some((repo) => repo.repoId === previouslySelected)) {
      rolesRepoSelect.value = previouslySelected;
    }
  } catch {}
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
      renderRepoRoles([]);
      return;
    }
    const data = await res.json();
    renderRepoRoles(data.roles || []);
  } catch {
    renderRepoRoles([]);
  }
}

function renderRepoRoles(roles) {
  if (!rolesList) return;
  withViewTransition(() => {
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
      row.className = 'border-b border-neutral-800 last:border-0 hover:bg-neutral-800/40';
      const revokeBtn = document.createElement('button');
      revokeBtn.type = 'button';
      revokeBtn.textContent = 'Revoke';
      revokeBtn.className = 'text-red-400 hover:text-red-300';
      revokeBtn.addEventListener('click', () => revokeRepoRole(assignment.username));
      row.innerHTML =
        '<td class="px-3 py-2 font-medium"></td>' +
        '<td class="px-3 py-2"></td>' +
        '<td class="px-3 py-2 text-neutral-400"></td>' +
        '<td class="px-3 py-2 text-neutral-400"></td>' +
        '<td class="px-3 py-2 text-right"></td>';
      row.children[0].textContent = assignment.username;
      row.children[1].textContent = assignment.role;
      row.children[2].textContent = new Date(assignment.grantedAt).toLocaleString();
      row.children[3].textContent = assignment.grantedBy;
      row.children[4].append(revokeBtn);
      rolesList.append(row);
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
        return;
      }
      setInlineMessage(roleMessage, 'Granted "' + role + '" to ' + username + '.', false);
      roleGrantForm.reset();
      await loadRepoRoles(selectedRolesRepoId);
    } catch {
      setInlineMessage(roleMessage, 'Could not reach the Deltix-Server.', true);
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
      return;
    }
    setInlineMessage(roleMessage, 'Revoked role for ' + username + '.', false);
    await loadRepoRoles(selectedRolesRepoId);
  } catch {
    setInlineMessage(roleMessage, 'Could not reach the Deltix-Server.', true);
  }
}

restoreSessionOnLoad();
