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

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.remove('hidden');
}

function showSession(username) {
  currentUsername = username;
  form.classList.add('hidden');
  sessionPanel.classList.remove('hidden');
  sessionUsername.textContent = username;
}

function showForm() {
  currentUsername = null;
  accessToken = null;
  sessionPanel.classList.add('hidden');
  form.classList.remove('hidden');
  form.reset();
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

