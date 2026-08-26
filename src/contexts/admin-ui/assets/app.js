// Access token lives only in memory for this tab's lifetime — never
// localStorage/sessionStorage/cookies, to minimize XSS token-theft blast
// radius. A page reload requires logging in again; acceptable for an
// admin console used occasionally, not the primary auth surface.
let accessToken = null;
let refreshToken = null;

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
  form.classList.add('hidden');
  sessionPanel.classList.remove('hidden');
  sessionUsername.textContent = username;
}

function showForm() {
  sessionPanel.classList.add('hidden');
  form.classList.remove('hidden');
  form.reset();
  accessToken = null;
  refreshToken = null;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorMessage.classList.add('hidden');

  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  try {
    const res = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      showError('Invalid credentials.');
      return;
    }

    const data = await res.json();
    accessToken = data.accessToken;
    refreshToken = data.refreshToken;
    showSession(username);
  } catch {
    showError('Could not reach the Deltix-Server.');
  }
});

logoutButton.addEventListener('click', async () => {
  if (!refreshToken) return;
  try {
    await fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } finally {
    showForm();
  }
});

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
