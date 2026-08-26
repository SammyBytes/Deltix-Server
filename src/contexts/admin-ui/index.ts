/**
 * The "admin-ui" bounded context: a minimal, static Admin Web UI served
 * directly by the HTTP control plane, gated behind `DELTIX_ADMIN_UI_ENABLED`
 * (default off) to keep the attack surface minimal for headless deployments.
 *
 * This is the ONLY file other modules are allowed to import from (ACL
 * boundary). Internals must never be imported directly from outside.
 */
export { createAdminUiRouter } from './admin-ui.router';
