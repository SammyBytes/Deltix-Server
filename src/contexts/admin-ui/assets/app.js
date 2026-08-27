// The access token stays in memory only, for this tab's lifetime — never
// localStorage/sessionStorage, to minimize XSS token-theft blast radius.
// The refresh token is NEVER read/written by this script at all: the
// server sets it as an httpOnly, Secure, SameSite=Strict cookie on
// login/refresh, so JavaScript can never see or exfiltrate it. On page
// load we call POST /refresh (credentials included) to silently restore
// an existing session from that cookie instead of forcing a fresh login
// on every reload.
let accessToken = null;
let currentUsername = null;

const form = document.getElementById('login-form');
const errorMessage = document.getElementById('error-message');
const sessionPanel = document.getElementById('session-panel');
const sessionUsername = document.getElementById('session-username');
const logoutButton = document.getElementById('logout-button');
const trustForm = document.getElementById('trust-form');
const trustMessage = document.getElementById('trust-message');
const trustList = document.getElementById('trust-list');

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.remove('hidden');
}

/**
 * Wraps a DOM mutation in the View Transitions API when the browser
 * supports it, so swaps (login <-> session, trust list refresh) cross-fade
 * smoothly instead of popping. Falls back to a plain synchronous call on
 * browsers without support (e.g. older Firefox) — never blocks on it.
 */
function withViewTransition(mutate) {
  if (typeof document.startViewTransition === 'function') {
    document.startViewTransition(() => mutate());
  } else {
    mutate();
  }
}

function showSession(username) {
  withViewTransition(() => {
    currentUsername = username;
    form.classList.add('hidden');
    sessionPanel.classList.remove('hidden');
    sessionUsername.textContent = username;
  });
}

function showForm() {
  withViewTransition(() => {
    currentUsername = null;
    accessToken = null;
    sessionPanel.classList.add('hidden');
    form.classList.remove('hidden');
    form.reset();
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorMessage.classList.add('hidden');

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
      showError('Invalid credentials.');
      return;
    }

    const data = await res.json();
    accessToken = data.accessToken;
    showSession(data.username);
    loadTrustedAddons();
  } catch {
    showError('Could not reach the Deltix-Server.');
  }
});

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

function showTrustMessage(text, isError) {
  trustMessage.textContent = text;
  trustMessage.classList.remove('hidden', 'text-red-400', 'text-emerald-400');
  trustMessage.classList.add(isError ? 'text-red-400' : 'text-emerald-400');
}

function renderTrustedAddons(trusted) {
  withViewTransition(() => {
    trustList.innerHTML = '';

    if (trusted.length === 0) {
      const emptyRow = document.createElement('tr');
      emptyRow.id = 'trust-empty-row';
      emptyRow.innerHTML =
        '<td class="px-3 py-4 text-center text-neutral-500" colspan="5">No community addons trusted yet.</td>';
      trustList.append(emptyRow);
      return;
    }

    for (const record of trusted) {
      const row = document.createElement('tr');
      row.className = 'border-b border-neutral-800 last:border-0 hover:bg-neutral-800/40';
      row.dataset.vt = 'trust-row';
      row.style.setProperty('--vt-name', `trust-row-${cssSafe(record.addonName)}`);

      const nameCell = document.createElement('td');
      nameCell.className = 'px-3 py-2 font-mono';
      nameCell.textContent = record.addonName;

      const keyCell = document.createElement('td');
      keyCell.className = 'max-w-[220px] truncate px-3 py-2 font-mono text-neutral-400';
      keyCell.title = record.authorPublicKey;
      keyCell.textContent = record.authorPublicKey;

      const trustedAtCell = document.createElement('td');
      trustedAtCell.className = 'px-3 py-2 text-neutral-400';
      trustedAtCell.textContent = new Date(record.trustedAt).toLocaleString();

      const byCell = document.createElement('td');
      byCell.className = 'px-3 py-2 text-neutral-400';
      byCell.textContent = record.trustedBy;

      const actionCell = document.createElement('td');
      actionCell.className = 'px-3 py-2 text-right';
      const revokeBtn = document.createElement('button');
      revokeBtn.type = 'button';
      revokeBtn.textContent = 'Revoke';
      revokeBtn.className = 'text-red-400 hover:text-red-300';
      revokeBtn.addEventListener('click', () => revokeTrust(record.addonName));
      actionCell.append(revokeBtn);

      row.append(nameCell, keyCell, trustedAtCell, byCell, actionCell);
      trustList.append(row);
    }
  });
}

/** Sanitizes an addon name into a safe CSS identifier for view-transition-name. */
function cssSafe(value) {
  return value.replace(/[^a-zA-Z0-9-]/g, '-');
}

async function loadTrustedAddons() {
  try {
    const res = await fetch('/api/v1/addons/trust', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    renderTrustedAddons(data.trusted ?? []);
  } catch {
    // Non-fatal: the trust panel just stays empty/stale.
  }
}

async function revokeTrust(addonName) {
  try {
    await fetch('/api/v1/addons/revoke', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ addonName }),
    });
    await loadTrustedAddons();
  } catch {
    showTrustMessage('Could not reach the Deltix-Server.', true);
  }
}

trustForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  trustMessage.classList.add('hidden');

  const addonName = document.getElementById('trust-addon-name').value.trim();
  const authorPublicKey = document.getElementById('trust-public-key').value.trim();

  try {
    const res = await fetch('/api/v1/addons/trust', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ addonName, authorPublicKey }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showTrustMessage(data.error ?? 'Could not trust this key.', true);
      return;
    }

    showTrustMessage(`Trusted "${addonName}". Takes effect on next server restart.`, false);
    trustForm.reset();
    await loadTrustedAddons();
  } catch {
    showTrustMessage('Could not reach the Deltix-Server.', true);
  }
});

/**
 * Runs once on every page load. Attempts to restore an existing session
 * from the httpOnly refresh-token cookie via POST /refresh. If there is no
 * active session (no cookie, or it expired), this silently falls through
 * to the login form — no error is shown, since "not logged in yet" is the
 * normal state on a first visit.
 */
async function restoreSessionOnLoad() {
  try {
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return;

    const data = await res.json();
    accessToken = data.accessToken;
    showSession(data.username);
    loadTrustedAddons();
  } catch {
    // Server unreachable on load — just show the login form, same as any
    // other "not logged in" case.
  }
}

restoreSessionOnLoad();

if (!localStorage.getItem('deltix-admin-tour-seen') && window.driver) {
  const driverInstance = window.driver.js.driver({
    showProgress: true,
    steps: [
      {
        element: '#login-form',
        popover: { title: 'Sign in', description: 'Use your local Deltix account credentials.' },
      },
    ],
  });
  driverInstance.drive();
  localStorage.setItem('deltix-admin-tour-seen', 'true');
}

