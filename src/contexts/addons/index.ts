/**
 * Placeholder for the "addons" bounded context.
 *
 * This is the ONLY file other contexts/modules are allowed to import from
 * (ACL boundary). Internals of this context must never be imported directly
 * from outside (e.g. `contexts/addons/some-internal-file`).
 *
 * Implementation lands in Fase 4 of the roadmap (dynamic Add-on loading via
 * `import()`, gated by the active license — see `contexts/licensing`).
 * See README.md at the repo root and .github/copilot-instructions.md for
 * architecture rules.
 */
export {};
