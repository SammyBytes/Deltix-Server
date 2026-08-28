import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Regression test for the "empty tables until the first write" bug:
// In Chromium, document.startViewTransition() defers its update callback by
// one frame. showSession() used to set currentIsGlobalAdmin INSIDE that
// callback and then read it synchronously to decide whether to load data.
// With a real Chromium, the data load was skipped because the flag was still
// false when the check ran — the admin logged in to empty tables until the
// next write triggered a re-fetch. This test runs the real app.js through a
// deferred view-transition and asserts the initial data fetches actually fire.

const APP_JS = new URL('../../../src/contexts/admin-ui/assets/app.js', import.meta.url).pathname;

function makeElement(id = '') {
  const el = {
    id,
    _classes: new Set(),
    _listeners: {},
    _children: [],
    children: [],
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    className: '',
    datasetTarget: null,
    classList: {
      add: (c: string) => el._classes.add(c),
      remove: (c: string) => el._classes.delete(c),
      toggle: (c: string, force?: boolean) => {
        if (force === undefined) {
          if (el._classes.has(c)) el._classes.delete(c);
          else el._classes.add(c);
        } else if (force) el._classes.add(c);
        else el._classes.delete(c);
      },
      contains: (c: string) => el._classes.has(c),
    },
    addEventListener: (type: string, fn: unknown) => {
      el._listeners[type] = fn;
    },
    getAttribute: (name: string) => (name === 'data-target' ? el.datasetTarget : null),
    setAttribute: (name: string, value: string) => {
      if (name === 'data-target') el.datasetTarget = value;
    },
    append(...nodes: unknown[]) {
      el._children.push(...nodes);
      el.children = el._children;
    },
    remove() {},
    reset() {
      el.value = '';
    },
  };
  return el;
}

function loadUiHarness(appJsPath: string, deferStartViewTransition: boolean) {
  const calls: string[] = [];
  const elements = new Map<string, ReturnType<typeof makeElement>>();

  const ids = [
    'login-form',
    'error-message',
    'login-view',
    'session-panel',
    'session-username',
    'username',
    'password',
    'logout-button',
    'not-admin-notice',
    'toast-outlet',
    'roles-screen',
    'roles-repo-select',
    'role-grant-form',
    'role-message',
    'roles-list',
    'known-usernames',
    'repos-table-body',
    'repo-create-form',
    'repo-create-message',
    'users-screen',
    'user-create-form',
    'user-message',
    'user-list',
    'seats-used',
    'delete-confirm-panel',
    'delete-username',
    'confirm-delete-button',
    'cancel-delete-button',
    'addons-screen',
    'trust-form',
    'trust-message',
    'trust-list',
    'setup-form',
    'setup-message',
    'dash-repo-count',
    'dash-active-seats',
    'dash-total-users',
    'dash-addons-count',
    'audit-log-container',
    'copy-support-bundle-btn',
  ];
  for (const id of ids) elements.set(id, makeElement(id));

  const tabIds = [
    'tab-dashboard',
    'tab-repos',
    'tab-roles',
    'tab-users',
    'tab-addons',
    'tab-audit',
  ];
  const navTabs = tabIds.map((id) => {
    const el = makeElement(id);
    el.datasetTarget = id;
    return el;
  });
  const tabContents = tabIds.map((id) => makeElement(id));
  for (const tc of tabContents) elements.set(tc.id, tc);

  let locationHash = 'repos';
  const location = {
    set hash(v: string) {
      locationHash = v;
    },
    get hash() {
      return locationHash;
    },
  };

  function startViewTransition(cb: () => void) {
    const updateCallbackDone = new Promise<void>((resolve, reject) => {
      const run = () => {
        try {
          cb();
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      if (deferStartViewTransition) queueMicrotask(run);
      else run();
    });
    return { updateCallbackDone, ready: Promise.resolve(), finished: updateCallbackDone };
  }

  const document = {
    getElementById(id: string) {
      return elements.get(id) || null;
    },
    querySelectorAll(sel: string) {
      if (sel === '.nav-tab') return navTabs;
      if (sel === '.tab-content') return tabContents;
      return [];
    },
    createElement(_tag: string) {
      const el = makeElement(_tag);
      return el;
    },
    startViewTransition,
  };

  const fetchMock = async (url: string | URL, opts?: { method?: string }) => {
    const method = opts?.method || 'GET';
    calls.push(`${method} ${String(url)}`);
    const s = String(url);
    const ok = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    const deny = { ok: false, status: 401, json: async () => ({}), text: async () => 'denied' };
    if (s.includes('/api/v1/auth/login'))
      return ok({ accessToken: 'tok', username: 'hemiblade', isGlobalAdmin: true });
    if (s.includes('/api/v1/auth/refresh')) return deny;
    if (s.includes('/api/v1/auth/logout')) return ok({});
    if (s.includes('/api/v1/auth/users')) return ok({ users: [] });
    if (s.includes('/api/v1/addons/trust')) return ok({ addons: [] });
    if (s.includes('/api/v1/versioning/repos')) return ok({ repositories: [] });
    return ok({});
  };

  const context: Record<string, unknown> = {
    console,
    fetch: fetchMock,
    setTimeout,
    queueMicrotask,
    localStorage: { getItem: () => null, setItem: () => {} },
    URL,
    document,
  };
  context.window = {
    setTimeout,
    location,
    driver: undefined,
    fetch: fetchMock,
  };

  vm.createContext(context);
  const code = readFileSync(appJsPath, 'utf8');
  vm.runInContext(`${code}\n;this.__uiForm = form;`, context);

  return {
    calls,
    loginForm: context.__uiForm as Parameters<typeof makeElement>[0] & {
      _listeners: Record<string, unknown>;
    },
  };
}

describe('admin-ui/app.js initial data load after login', () => {
  it('fires /auth/users, addons and repos fetches after login when view transitions are DEFERRED (regex Chromium behaviour)', async () => {
    const harness = loadUiHarness(APP_JS, true);

    const submit = harness.loginForm._listeners.submit as () => Promise<void>;
    await submit.call(harness.loginForm, { preventDefault() {} });

    expect(harness.calls).toContain('POST /api/v1/auth/login');
    expect(harness.calls).toContain('GET /api/v1/auth/users');
    expect(harness.calls).toContain('GET /api/v1/addons/trust');
    expect(harness.calls).toContain('GET /api/v1/versioning/repos');
  });

  it('also fires the data fetches when view transitions run synchronously', async () => {
    const harness = loadUiHarness(APP_JS, false);

    const submit = harness.loginForm._listeners.submit as () => Promise<void>;
    await submit.call(harness.loginForm, { preventDefault() {} });

    expect(harness.calls).toContain('GET /api/v1/auth/users');
    expect(harness.calls).toContain('GET /api/v1/versioning/repos');
  });
});
