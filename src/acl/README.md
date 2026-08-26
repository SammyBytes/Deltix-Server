# Anti-Corruption Layer (ACL) adapters

This folder hosts explicit adapters used whenever one bounded context needs data or behavior
from another (or from an external system such as the Dolt CLI binary or a future add-on).

Rules:
- Contexts never import each other's internals directly — only through an ACL adapter defined
  here, or through the target context's own `index.ts` barrel.
- An ACL adapter translates between the external/foreign shape and the shape the consuming
  context expects. It must not leak foreign types across the boundary.
- Keep adapters small and boring. If an adapter grows complex business logic, that logic
  belongs in the owning context, not here.
