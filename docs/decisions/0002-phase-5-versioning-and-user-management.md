# ADR 0002: Fase 5 — Versionado Real sobre Dolt, Gestión de Usuarios en Admin UI y
# Preferencias de Sincronización

- **Status**: **Fase 5 completa** — mantener este ADR sincronizado con la implementación vigente.
- **Date**: 2026-08-27 (Draft)
- **Owner**: @SammyBytes
- **Scope**: Deltix-Server (contextos `versioning`, `auth`, `admin-ui`) y Deltix-Client
  (nuevos comandos CLI).
- **Related**: Fases 1-4 (completas, `main`), `docs/pilot-plan.md`.

> Este documento existe para que todo el alcance de Fase 5 tenga un rastro escrito
> antes de que se escriba código. Se actualiza a medida que se toman decisiones — no
> se cambia el alcance en código sin actualizar este archivo primero.

---

## 1. Problema / motivación

Fases 1-4 dejaron a Deltix como un motor de **transferencia segura de archivos** con
licenciamiento y addons — pero **no versiona el contenido de las bases de datos**
(confirmado: `dolt log` sobre el repo usado en pruebas solo muestra el commit inicial
vacío; el push/pull actual solo copia bytes con checksum a una carpeta simulada de NAS).

Fase 5 cierra esa brecha y agrega tres capacidades que el usuario pidió explícitamente
el 2026-08-27:

1. **Versionado real** (commits/branches/merge/diff reales en Dolt).
2. **Gestión de usuarios vía Admin Web UI** — hoy no existe forma visual de crear,
   remover o ver actividad de usuarios; los usuarios se definen estáticamente en
   `DELTIX_LOCAL_USERS` (env var), sin analítica de "quién está activo" más allá de
   contar sesiones vivas por slot de licencia.
3. **Preferencias de sincronización** — elegir "solo schema" vs "schema + datos", y
   elegir qué tablas sincronizar (arrastrando automáticamente las tablas relacionadas
   por FK para no corromper integridad referencial).

## 2. Alcance de Fase 5 (sub-fases, orden de dependencia)

Cada sub-fase se implementa con TDD completo (unit → integración con Dolt real →
smoke) y se mergea a `main` de forma independiente antes de empezar la siguiente —
mismo patrón que Fases 1-4. Ninguna sub-fase empieza sin luz verde explícita del owner.

| # | Sub-fase | Qué agrega | Repo(s) |
|---|---|---|---|
| 5.1 | **Repo Dolt real por proyecto** | `dolt init` aislado por repo lógico; tabla `repo_id ↔ ruta Dolt` en libSQL (mismo patrón que `addon-trust.db`) | Server |
| 5.2 | **Commit real en push** | Al llegar el payload a staging y verificarse el checksum, aplicarlo a las tablas Dolt y ejecutar `dolt add -A && dolt commit` con autor = usuario autenticado | Server, Client (mostrar `commit_id`) |
| 5.3 | **Branching** | `dolt branch` / `dolt checkout` reales, expuestos vía API y CLI | Server, Client |


## 3.1. Sub-fase 5.3 — Branching (detalle)

### Problema actual
- Fase 5.1/5.2 ya provisionan un repo Dolt real y registran commits reales, pero todo ocurre sobre la rama actualmente activa del working directory sin una API explícita para crear, listar, cambiar o borrar ramas.
- Sin branching real, no existe todavía el flujo Git-style mínimo para aislar cambios de schema/datos antes de futuros merge/conflict workflows.

### Alcance propuesto
1. **Crear rama**:
   - Exponer `POST /api/v1/versioning/repos/:repoId/branches` para crear una rama real usando `dolt branch <branchName>`.
   - La creación no hace checkout implícito: crear y cambiar de rama se modelan como operaciones distintas para mantener una API explícita y predecible.
2. **Listar ramas**:
   - Exponer `GET /api/v1/versioning/repos/:repoId/branches`.
   - Leer la lista estructurada desde la system table `dolt_branches` vía `dolt sql`, evitando parsear el listado humano del CLI para el inventario de ramas.
   - Resolver la rama actual leyendo el marcador `*` de `dolt branch`, porque en Dolt 2.3.0 `dolt_branches` no expone una columna booleana `current`.
3. **Rama actual / checkout**:
   - Exponer `GET /api/v1/versioning/repos/:repoId/branches/current` y `POST /api/v1/versioning/repos/:repoId/branches/:name/checkout`.
   - `checkout` ejecuta un `dolt checkout <branchName>` real sobre el working directory provisionado para ese repo.
4. **Borrado seguro**:
   - Exponer `DELETE /api/v1/versioning/repos/:repoId/branches/:name`.
   - Rechazar el borrado de la rama actualmente checked out.
   - Rechazar el borrado de la rama protegida por defecto `main`.
5. **Validación defensiva**:
   - Validar nombres de rama antes de shell-out con un allow-list conservador (`/^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,127}$/`) y rechazar además espacios, `..`, y `/` al inicio/fin.
   - Esto complementa el auto-quoting de `Bun.$`; no lo reemplaza.

### Decisiones de diseño resueltas
- **Fuente de verdad para listar ramas**: se usa `dolt_branches` por ser salida estructurada y más robusta que parsear el listado humano completo. Solo se parsea `dolt branch` para saber cuál está marcada con `*`, porque Dolt 2.3.0 no expone esa señal en la tabla.
- **Checkout y concurrencia**: dado que cada repo provisionado tiene un único working directory real, `checkout` no es una vista virtual por request sino una mutación real del filesystem. Se agrega un mutex en memoria por `repoId` dentro de `BranchService` para serializar create/checkout/delete y evitar carreras entre mutaciones de rama concurrentes dentro del mismo proceso.
- **Impacto en commits de push**: `CommitService.recordPush()` sigue siendo branch-agnostic en 5.3. Los pushes graban commits sobre la rama que esté actualmente checked out en ese working directory al momento del commit. No se cambia todavía el contrato del push para fijar una rama explícita porque eso pertenece naturalmente a futuras sub-fases de autorización/merge.
- **Regla de protección**: se protege `main` explícitamente aunque Dolt ya falle si se intenta borrar la rama activa; así la API devuelve un error de dominio claro y consistente antes del shell-out.

### Implicaciones / límites conocidos
- El mutex es **in-process**, suficiente para la topología actual de un único proceso Bun. Si en el futuro hubiera múltiples instancias apuntando al mismo repo físico, haría falta un lock distribuido o por filesystem.
- Los comandos CLI del cliente para branching siguen fuera de alcance en esta sub-fase; solo se habilita la superficie server-side.
| 5.4 | **Merge y conflictos** | `dolt merge`, traduciendo conflictos SQL crudos a JSON estructurado y legible | Server, Client |
| 5.5 | **Historial / diff navegable** | `dolt_log` / `dolt_diff` expuestos vía REST server-side como `GET /repos/:repoId/log` y `GET /repos/:repoId/diff` (CLI client queda fuera de alcance por ahora) | Server |
| 5.6 | **Autorización por repo/branch** | Extensión de `auth` con ACL nueva hacia `versioning` (rol simple por repo: lector/escritor/admin — NO RBAC granular todavía, mantener simple) | Server |
| **5.7** | **Gestión de usuarios en Admin UI** (nuevo, pedido 2026-08-27) | CRUD visual de usuarios (crear/editar/desactivar/eliminar), listado de sesiones activas por usuario, setup inicial de primer admin | Server (admin-ui + auth) |
| **5.8** | **Preferencias de sincronización** (nuevo, pedido 2026-08-27) | Selección de "solo schema" vs "schema + datos"; selección de tablas a sincronizar con expansión automática por FK y dry-run server-side | Server (versioning), Client (flags de `push`) |

Las sub-fases 5.7 y 5.8 dependen de 5.1-5.2 (necesitan un repo Dolt real y un modelo
de commit para tener sentido), por eso van después en el orden de ejecución aunque se
documenten aquí juntas. Sugerencia de orden real de trabajo: **5.1 → 5.2 → 5.7 (setup
inicial + CRUD básico) → 5.8 → 5.3 → 5.4 → 5.5 → 5.6 (RBAC fino al final, una vez el
modelo de usuarios ya existe de verdad)**.

---

## 3.2. Sub-fase 5.4 — Merge y conflictos (detalle)
## 3.3. Sub-fase 5.5 — Log y diff (detalle)

### Problema actual
- Fase 5.3/5.4 ya permiten crear ramas y reconciliarlas con merges reales, pero todavía no existe una forma server-side de inspeccionar el historial de commits o comparar dos refs sin entrar manualmente al CLI de Dolt.
- El output humano de `dolt log` / `dolt diff` no es un contrato API estable ni legible para consumidores REST. El contexto `versioning` ya resolvió este problema para conflictos en 5.4, así que 5.5 debe seguir la misma filosofía: leer tablas/funciones SQL crudas y traducirlas a JSON estructurado.
- Sin paginación defensiva, un repo con historial largo podría devolver respuestas no acotadas y costosas.

### Alcance propuesto
1. **Historial estructurado**:
   - Exponer `GET /api/v1/versioning/repos/:repoId/log`.
   - `?branch=<name>` es opcional; sin ese query param se lee el historial de la rama/working tree actual.
   - `?limit=<n>` pagina el resultado con default `50` y clamp server-side a `200`.
   - La fuente de verdad es `dolt_log`, no el texto de `dolt log`. En Dolt 2.3.0 se confirmaron las columnas: `commit_hash`, `committer`, `email`, `date`, `message`, `commit_order`, `parents`, `refs`, `signature`, `author`, `author_email`, `author_date`.
2. **Diff estructurado entre refs**:
   - Exponer `GET /api/v1/versioning/repos/:repoId/diff?from=<ref>&to=<ref>`.
   - Primero se consulta `dolt_diff_summary(from,to)` para descubrir qué tablas cambiaron y si el cambio fue de datos y/o schema.
   - Luego, por cada tabla, se consulta `dolt_diff(from,to,table)` y se traduce a JSON por tabla con cambios fila a fila. En Dolt 2.3.0 se confirmó que una tabla `items(id,name)` devuelve columnas prefijadas `to_*`, `from_*`, más `to_commit`, `to_commit_date`, `from_commit`, `from_commit_date`, y `diff_type`.
3. **Validación defensiva**:
   - Reutilizar la allow-list exacta de ramas de 5.3/5.4 (`VALID_BRANCH`) para cualquier query param que represente una rama.
   - Aceptar hashes de commit Dolt solo si cumplen el shape real observado en Dolt 2.3.0: 32 caracteres lowercase alfanuméricos (`^[0-9a-z]{32}$`).
   - Validar también nombres de tabla derivados de `dolt_diff_summary` con `^[A-Za-z_][A-Za-z0-9_]*$` antes de interpolarlos en `dolt sql -q`.
4. **Errores tipados / fail-closed**:
   - Repo inexistente: `RepoNotFoundError`.
   - Rama inexistente: reutilizar `BranchNotFoundError`.
   - Ref inválida (branch/hash con shape no permitida): `InvalidCommitReferenceError`.
   - Límite inválido: `InvalidPaginationLimitError`.

### Decisiones de diseño resueltas
- **Sin mutex para log/diff**: a diferencia de create/checkout/delete/merge, estas operaciones solo ejecutan `SELECT`/funciones de lectura sobre `dolt_log` y `dolt_diff*`. No mutan el working tree compartido ni dejan estado intermedio, así que pueden correr concurrentemente sin usar `RepoBranchMutex`. Esto se documenta explícitamente para evitar sobreservializar lecturas inocuas.
- **Shape del log JSON**: cada commit se expone como `{ commitHash, author, authorEmail, timestamp, message, parents }`. Se eligió `author*` en vez de `committer*` porque el commit de push ya modela la autoría como parte del dominio visible al usuario, y `parents` se normaliza a `string[]` para evitar que el consumidor tenga que parsear la lista cruda de Dolt.
- **Shape del diff JSON**: la respuesta se modela como `{ fromRef, toRef, tables }`, donde cada tabla es `{ table, diffType, dataChange, schemaChange, changes }` y cada cambio fila a fila es `{ diffType, oldValues, newValues }`. Igual que en 5.4, se preserva agnosticismo de schema usando mapas columna→valor en vez de columnas fijas.
- **Paginación simple y defensiva**: no se introduce cursoring todavía; `limit` entero con default 50 y max 200 es suficiente para esta sub-fase server-only y evita respuestas no acotadas.
- **Server-only por ahora**: aunque la fila original mencionaba también `deltix log` / `deltix diff`, esta entrega implementa primero la superficie REST del server. El cliente CLI queda fuera de alcance para no mezclar contextos/repositorios en esta sub-fase.

### Implicaciones / límites conocidos
- `GET /log` sobre una rama usa `dolt_log AS OF '<branch>'`, por lo que refleja el historial alcanzable desde esa ref sin cambiar el checkout global del repo.
- `GET /diff` hoy devuelve cambios estructurados por tabla, pero no intenta renderizar un patch textual tipo unified diff; ese formato humano puede agregarse después en el cliente si hiciera falta.
- La validación del hash está basada en el shape real observado en Dolt 2.3.0 durante esta implementación; si una futura versión de Dolt cambia el formato, habrá que actualizar el regex de allow-list antes de aceptar el nuevo shape.


### Problema actual
- Fase 5.3 ya permite crear/cambiar/borrar ramas reales, pero todavía no existe una operación server-side para reconciliar dos líneas de trabajo sobre el mismo repo Dolt.
- Un `dolt merge` con conflictos deja el repo en estado "merge in progress"; en un servidor que comparte un único working directory real por `repoId`, dejar ese estado colgando entre requests vuelve impredecibles las siguientes operaciones concurrentes (commit, checkout, otro merge, push).
- El output humano del CLI no sirve como contrato API estable: el consumidor necesita JSON estructurado, no texto crudo con `CONFLICT (content): ...`.

### Alcance propuesto
1. **Merge real sobre el working directory provisionado**:
   - Exponer `POST /api/v1/versioning/repos/:repoId/merge` con body `{ sourceBranch, targetBranch? }`.
   - Si `targetBranch` no viene, el merge ocurre sobre la rama actualmente checked out.
   - Si `targetBranch` viene, el server hace checkout real de esa rama antes del merge y el resultado queda persistido en ese working directory.
2. **Validación defensiva**:
   - `sourceBranch` y `targetBranch` reutilizan exactamente la misma convención allow-list de 5.3 (`VALID_BRANCH`) y las mismas exclusiones de whitespace, `..`, y `/` en extremos.
   - `dolt_conflicts_<table>` se consulta solo después de validar el nombre de tabla contra un regex conservador (`^[A-Za-z_][A-Za-z0-9_]*$`) antes de interpolarlo en `dolt sql -q`.
3. **Traducción de conflictos a JSON estructurado**:
   - Primero se lee `SELECT table, num_conflicts FROM dolt_conflicts`.
   - Luego, por cada tabla, se lee `SELECT * FROM dolt_conflicts_<table>` y se traduce a:
     - `{ table, count, conflicts }`
     - Cada conflicto contiene `{ fromRootIsh, base, ours, theirs, ourDiffType, theirDiffType, conflictId }`
   - `base` / `ours` / `theirs` son mapas columna→valor, para no hardcodear schemas de negocio en el servidor.
4. **Outcomes explícitos**:
   - Merge limpio / fast-forward: `status: 'merged'` + `commitHash` leído desde `dolt_log`.
   - Already up-to-date: `status: 'up_to_date'`, distinguible de un merge real.
   - Conflicto: `409` con payload estructurado y sin exponer solo texto crudo del CLI.
   - Rama inexistente: `BranchNotFoundError` traducido a `404`.

### Decisiones de diseño resueltas
- **Auto-abort al detectar conflictos**: se eligió capturar `dolt_conflicts*` y luego ejecutar inmediatamente `dolt merge --abort`. Razón: el servidor opera sobre un working directory compartido por repo; dejar merges a medio resolver entre requests haría que la siguiente operación herede estado implícito y no determinista. El contrato queda fail-closed: la API reporta el conflicto completo, pero el repo vuelve a un estado limpio y conocido antes de liberar el mutex.
- **Mutex compartido con branching**: `BranchService` y `MergeService` importan la misma instancia `sharedRepoBranchMutex` desde un módulo nuevo `repo-branch-mutex.ts`. Duplicar mutexes separados hubiera sido incorrecto: dos locks distintos en memoria no protegen el mismo repo físico y permitirían interleavings peligrosos (`checkout` mientras otro request mergea).
- **Shape del JSON de conflictos**: se resolvió no aplanar a strings ni modelar columnas fijas por tabla. Usar mapas `base/ours/theirs` hace que la API siga siendo legible pero también agnóstica al schema del repo versionado; eso evita acoplar el contexto `versioning` a tablas de negocio futuras.
- **Modelado de "up to date"**: se modela como discriminated union de retorno (`MergeResult`) y no como excepción. No es un error de dominio; es un no-op explícito que el cliente/API debe poder distinguir de `merged` sin depender del texto del CLI.

### Implicaciones / límites conocidos
- La serialización sigue siendo **in-process**. Es correcta para la topología actual de un único proceso Bun; múltiples instancias sobre el mismo repo físico requerirían un lock distribuido o de filesystem.
- El cliente CLI (`Deltix-Client`) permanece fuera de alcance en 5.4; esta sub-fase habilita solo la superficie REST server-side.



## 3.4. Sub-fase 5.6 — Autorización por repo/branch (detalle)

### Problema actual
- Fases 5.1-5.5 ya exponen repos Dolt reales, branching, merge, log, diff y preferencias de sincronización, pero todo usuario autenticado podía operar sobre cualquier repo provisionado.
- Eso viola el principio A01 de OWASP/ASVS para un control plane multiusuario: autenticación sin autorización server-side por recurso sigue siendo broken access control.
- El ADR original pidió explícitamente una “extensión de `auth` con ACL nueva hacia `versioning`” y además aclaró “NO RBAC granular todavía, mantener simple”, por lo que esta sub-fase debe cerrar el hueco sin inventar un sistema de permisos complejo.

### Alcance propuesto
1. **Modelo simple de roles por repo**:
   - Cada asignación se modela como `(username, repoId, role)`.
   - `role` solo puede ser `reader`, `writer` o `admin`.
   - No se implementan permisos por branch ni matriz granular por acción en esta entrega, aunque la fila resumida diga `repo/branch`; se resuelve deliberadamente a **per-repo only** por consistencia con “mantener simple”.
2. **Persistencia dentro de `auth`**:
   - La tabla nueva `repo_roles` vive en la misma libSQL del contexto `auth` (`DELTIX_USER_DB_PATH`).
   - `versioning` no sabe nada del storage físico; solo consume métodos públicos expuestos por el barrel de `auth` (`getRepoRole`, `grantRepoRole`, `revokeRepoRole`, `listRepoRoles`).
   - Esta decisión sigue la regla ACL del repositorio: nada de imports cruzados a internals, y la autorización sigue siendo responsabilidad del contexto `auth` aunque proteja recursos del contexto `versioning`.
3. **Bootstrap del primer acceso**:
   - `POST /api/v1/versioning/repos` sigue siendo la única operación de creación sin ACL previa sobre ese repo, porque el repo todavía no existe.
   - Después de provisionar exitosamente, el server auto-otorga `admin` al usuario creador del repo.
   - Esto evita el problema clásico de “¿quién concede el primer permiso?” sin abrir bypasses globales ni superusers implícitos.
4. **REST de administración de roles**:
   - `GET /api/v1/versioning/repos/:repoId/roles` lista asignaciones del repo.
   - `POST /api/v1/versioning/repos/:repoId/roles` crea/actualiza `{ username, role }`.
   - `DELETE /api/v1/versioning/repos/:repoId/roles/:username` revoca el acceso.
   - Solo `admin` puede mutar roles; la lectura se permite a `reader+` porque ya implica acceso autorizado al repo.
5. **Fail-closed total**:
   - Un usuario autenticado sin asignación para un repo recibe `403` en todos los endpoints de `versioning` (lectura y escritura) salvo la creación de un repo nuevo.
   - No se introduce bypass legacy, “owner global”, ni seed implícito para repos existentes. Los tests/fixtures se actualizan para otorgar el rol requerido explícitamente.

### Matriz de permisos resuelta
| Operación / endpoint | reader | writer | admin |
|---|---|---|---|
| `GET /repos` (solo los visibles) | ✅ | ✅ | ✅ |
| `GET /repos/:repoId` | ✅ | ✅ | ✅ |
| `GET /repos/:repoId/roles` | ✅ | ✅ | ✅ |
| `GET /repos/:repoId/branches` | ✅ | ✅ | ✅ |
| `GET /repos/:repoId/branches/current` | ✅ | ✅ | ✅ |
| `GET /repos/:repoId/log` | ✅ | ✅ | ✅ |
| `GET /repos/:repoId/diff` | ✅ | ✅ | ✅ |
| `POST /repos/:repoId/branches` | ❌ | ✅ | ✅ |
| `POST /repos/:repoId/branches/:name/checkout` | ❌ | ✅ | ✅ |
| `POST /repos/:repoId/merge` | ❌ | ✅ | ✅ |
| `DELETE /repos/:repoId/branches/:name` | ❌ | ❌ | ✅ |
| `GET/PUT/POST /repos/:repoId/sync-preferences*` | ❌ | ❌ | ✅ |
| `POST /repos/:repoId/roles` | ❌ | ❌ | ✅ |
| `DELETE /repos/:repoId/roles/:username` | ❌ | ❌ | ✅ |

### Decisiones de diseño resueltas
- **Dónde vive la ACL**: se eligió `auth` y no `versioning` porque la propia fila 5.6 habla de una “extensión de `auth`”. Además, `auth` ya es dueño de usernames, sesiones y user DB; sumar `repo_roles` ahí mantiene identidad + autorización juntas y evita filtrar detalles de storage al contexto consumidor.
- **`GET /repos` filtrado, no 403 global**: para el listado se devuelve solo el subconjunto visible al usuario, en vez de fallar si existe algún repo inaccesible. Esto hace al endpoint útil como inventario de “mis repos” sin exponer metadatos de repos ajenos.
- **Repos inexistentes vs no autorizados**: una vez aplicada la ACL, `GET /repos/:repoId` devuelve `403` si el usuario no tiene acceso, incluso si no existe asignación previa para ese repoId. Esto prioriza no filtrar existencia de recursos a usuarios no autorizados.
- **Error tipado nuevo**: `RepoAccessDeniedError` vive en `versioning/errors.ts` porque la traducción HTTP 403 y el contrato REST pertenecen al contexto `versioning`, aunque la decisión de autorización se consulte a `auth`.

### Implicaciones / límites conocidos
- No hay permisos por branch todavía. El texto “repo/branch” del resumen se documenta aquí como shorthand histórico; la implementación real es repo-scoped hasta una futura fase de RBAC granular.
- `CommitService.recordPush()` sigue sin revalidar ACL por sí mismo porque hoy se dispara desde el flujo de tickets/storage ya autenticado; esta sub-fase cubre completamente la superficie REST existente de `versioning`, que era el hueco explícito del ADR.
- Los repos creados antes de 5.6 quedan inaccesibles hasta que un admin les asigne roles manualmente. Se acepta como comportamiento fail-closed de MVP en lugar de introducir migraciones mágicas o bypasses inseguros.

## 3. Sub-fase 5.7 — Gestión de usuarios en Admin UI (detalle)

### Problema actual
- Usuarios definidos en `DELTIX_LOCAL_USERS` (JSON en env var) — cualquier cambio
  requiere reiniciar el proceso y editar el `.env` a mano.
- No hay forma de ver cuántos "seats" de licencia están ocupados ni por quién.
- No hay "primer arranque guiado" — hoy `setup-local-demo.ts` es solo para dev/demo,
  no para un primer boot de producción.

### Alcance propuesto
1. **Setup inicial (first-boot wizard)**:
   - Si el servidor arranca sin ningún usuario admin creado, expone *solo* la ruta
     `/admin/setup` (todas las demás rutas de la API siguen fail-closed) para crear
     el primer usuario admin (username + password, hasheado con Argon2id como ya
     hacemos).
   - Una vez creado el primer admin, `/admin/setup` deja de estar disponible
     (idempotente, no se puede re-ejecutar para tomar control de una instancia ya
     inicializada — mitigación OWASP A01/A07).
2. **CRUD de usuarios** (solo accesible para rol admin):
   - Crear usuario (username, password inicial, rol).
   - Desactivar/reactivar usuario (soft-delete — nunca borrar filas de auditoría).
   - Eliminar usuario permanentemente (con confirmación, solo si no tiene historial
     de commits activo, o marcándolo igual como autor histórico inmutable).
   - Ver lista de usuarios con: último login, estado (activo/inactivo), sesiones
     vivas actuales.
3. **Analítica de uso de seats**:
   - Endpoint que responda "seats usados / seats de licencia" contando sesiones con
     refresh token vigente (no solo usuarios creados) — hoy la licencia ya trackea
     `seats` pero nada lo cruza con sesiones reales.
   - Vista en Admin UI: tabla de usuarios activos ahora mismo (sesión no expirada)
     vs. total de usuarios creados vs. tope de la licencia.
4. **Persistencia**: migrar de `DELTIX_LOCAL_USERS` (env var estática) a una tabla
   libSQL (`users.db`, mismo patrón que `addon-trust.db` / `transfer-jobs.db`) —
   la env var puede mantenerse como *seed* opcional para bootstrap sin UI (útil en
   Docker/CI), pero la fuente de verdad en producción pasa a ser la base de datos.

### UI/UX y onboarding (driver.js)
- Sigue el patrón ya establecido en `src/contexts/admin-ui/assets/app.js`: cada
  feature nueva de la Admin UI trae su propio tour de `driver.js`, activado una
  sola vez vía una key propia de `localStorage` (ej. `deltix-admin-setup-tour-seen`,
  `deltix-admin-users-tour-seen`), independiente de los tours existentes (login,
  addons) para no repetir onboarding ya visto.
- El wizard de primer arranque (`/admin/setup`) es, en sí mismo, un flujo guiado
  paso a paso (no un tour superpuesto sobre una UI ya construida) — usar `driver.js`
  aquí para acompañar al usuario a través de "crear admin → confirmar → ir a login",
  ya que es la primera impresión del producto y debe sentirse guiada, no un
  formulario suelto.
- El panel de gestión de usuarios recibe su propio tour (`driver.js`) que explique:
  tabla de usuarios, botón "crear usuario", indicador de seats usados/disponibles,
  columna de sesiones activas, y el flujo de desactivar/eliminar.
- El selector de preferencias de sincronización (5.8) recibe su propio tour que
  explique visualmente la expansión automática por FK (ej. resaltar cómo al marcar
  `orders` se auto-marcan `customers` con una animación/indicador claro de "por
  qué" se seleccionó, no solo que se seleccionó).
- Requisitos de diseño transversales (aplican a toda UI nueva de Fase 5, evaluados
  contra las Web Interface Guidelines de Vercel y el enfoque de diseño intencional
  de Anthropic — ver skills `frontend-design` y `web-design-guidelines` instalados
  en este entorno para consulta continua durante la implementación):
  - **Responsive real**: probado en viewport móvil, no solo desktop (recordar el
    bug de responsive ya corregido en la tabla de addons — no repetirlo aquí).
  - **Accesible**: labels en todos los inputs, foco visible, botones de solo-ícono
    con `aria-label`, confirmación (no borrado inmediato) en acciones destructivas
    como eliminar usuario.
  - **Feedback de carga/error consistente**: mismos patrones ya usados en
    `trust-message` (éxito/error inline, sin alerts bloqueantes).
  - **Vocabulario consistente**: un botón que dice "Crear usuario" debe resultar en
    un mensaje que diga "Usuario creado", igual que ya se hace con "Trusted ‹addon›".
  - **View Transitions**: reutilizar `withViewTransition()` ya existente para todo
    swap de UI nuevo (tabla de usuarios, wizard de setup), consistente con el resto
    de la Admin UI.

### Preguntas abiertas para antes de codificar
- ✅ Decisión tomada: soportar ambos caminos de bootstrap, mutuamente excluyentes. Si `DELTIX_BOOTSTRAP_ADMIN_USERNAME` y `DELTIX_BOOTSTRAP_ADMIN_PASSWORD` están presentes, el primer admin se crea automáticamente al boot y `/admin/setup` queda deshabilitado (404). Si no están presentes, el wizard web queda disponible solo mientras la tabla `users` siga vacía. `DELTIX_LOCAL_USERS` permanece como fallback legacy de solo lectura para compatibilidad, pero la fuente de verdad pasa a ser libSQL.

---

## 4. Sub-fase 5.8 — Preferencias de sincronización (detalle)

### Problema actual
- El `push` de hoy transfiere un archivo/payload completo sin ningún control sobre
  "qué parte" de la base de datos se sincroniza.

### Alcance propuesto
1. **Modo "solo schema"**: transferir únicamente DDL (`CREATE TABLE`, índices,
   constraints) — sin filas. Útil para pilotos de bajo riesgo o para sincronizar
   estructura entre entornos sin mover datos sensibles.
2. **Modo "schema + datos"**: comportamiento actual, pero ahora aplicado como commit
   real (ver 5.2).
3. **Selección de tablas específicas**:
   - El usuario elige un subconjunto de tablas a sincronizar.
   - **Expansión automática por integridad referencial**: si la tabla `orders`
     depende de `customers` vía FK, seleccionar `orders` arrastra automáticamente
     `customers` (y transitivamente lo que `customers` requiera) — igual que se
     pidió explícitamente ("si selecciona también toma las tablas relacionadas para
     no tener corrupción"). Esto requiere leer el catálogo de FKs del schema
     (`information_schema`-equivalente de Dolt/MySQL) y calcular el cierre
     transitivo de dependencias antes de aceptar el push.
   - Si el usuario intenta excluir una tabla requerida por FK, el sistema debe
     **rechazar la operación con un mensaje explícito** (fail-closed, no
     auto-silenciar el problema) — consistente con el principio de diseño
     "fail-closed por defecto" ya establecido en el proyecto.
4. **Dónde vive la preferencia**: configurable por repo (no global), guardada junto
   al mapeo `repo_id ↔ ruta Dolt` de 5.1. El CLI puede sobreescribir puntualmente
   con flags (`deltix push --schema-only`, `deltix push --tables orders,customers`),
   pero el server siempre re-valida el cierre transitivo de FKs server-side (nunca
   confiar en que el cliente ya lo calculó correctamente).

### Preguntas abiertas para antes de codificar
- ¿Debe existir un modo de previsualización (`deltix push --dry-run`) que muestre
  qué tablas adicionales se arrastrarían por FK antes de confirmar la operación?
  → Resuelto: sí. Se implementa preview/dry-run server-side para devolver el cierre FK calculado sin ejecutar el push real.

---

## 5. Documentación a mantener actualizada durante Fase 5

- Este ADR (`docs/decisions/0002-...md`) — actualizar la sección "Status" de cada
  sub-fase a medida que se completa.
- `README.md` (Server) — sección "Roadmap", agregar Fase 5 con sus sub-fases y
  marcar ✅ según se completen (mismo estilo que Fases 1-4).
- `docs/pilot-plan.md` — actualizar una vez 5.1/5.2/5.7 estén listas, ya que cambia
  radicalmente la sección de "cómo se ve un push real" (hoy dice explícitamente que
  Dolt no se usa para el contenido transferido).
- Admin UI: agregar los nuevos pasos (setup inicial, gestión de usuarios,
  preferencias de sincronización) como tours independientes de `driver.js`, igual
  que se hizo para el sistema de addons (una key de `localStorage` por feature).
  Validar cada nueva pantalla contra las Web Interface Guidelines (skill
  `web-design-guidelines`, fuente: `vercel-labs/agent-skills`) antes de mergear,
  y aplicar el enfoque de diseño intencional del skill `frontend-design`
  (`anthropics/skills`) para que la UI se sienta pragmática, consistente con el
  resto de la Admin UI existente, y no como un formulario genérico pegado encima.
- `Deltix-Client/README.md` — documentar los nuevos comandos (`branch`, `merge`,
  `log`, `diff`, flags de `push` para preferencias de sincronización) a medida que
  se agregan.

## 6. Explícitamente fuera de alcance de Fase 5

- RBAC granular (permisos por acción, no solo por rol) — queda para una fase
  posterior de "Enterprise features" (SSO/SAML ya está mencionado como deuda
  conocida en `docs/pilot-plan.md`).
- Auditoría exportable (SIEM, webhooks de eventos) — no pedido todavía.
- Multi-tenancy real (un servidor sirviendo múltiples organizaciones aisladas) —
  hoy es de una sola organización por instancia; no cambia en Fase 5.

## 7. Estado de las sub-fases

| Sub-fase | Estado |
|---|---|
| 5.1 | ✅ Completa — `contexts/versioning` (RepoProvisioningService + LibsqlRepoStore + `dolt init` real vía Bun.$ + router JWT-autenticado `/api/v1/versioning/repos`); 25 tests (unit+integration+smoke) en verde |
| 5.2 | ✅ Completa — `CommitService` + `runDoltCommit` real (upsert en `deltix_push_log` + `dolt add -A && dolt commit --author`), invocado best-effort tras `PushSessionHandler.finish()` vía hook inyectado (`OnPushCommitted`, ACL storage→versioning); repos sin provisionar via 5.1 quedan como no-op retrocompatible. Client `commit_id` visible queda para una iteración posterior. 34 tests nuevos (unit+integration+smoke) en verde |
| 5.3 | ✅ Completa — `BranchService` + `dolt-branch-cli` exponen create/list/current/checkout/delete reales sobre repos provisionados, con validación defensiva de nombres, protección de `main`, rechazo de borrar la rama activa y endpoints JWT `/api/v1/versioning/repos/:repoId/branches*`; operaciones mutantes serializadas por repo con mutex in-process. |
| 5.4 | ✅ Completa — `MergeService` + `dolt-merge-cli` exponen `POST /api/v1/versioning/repos/:repoId/merge`, ejecutan `dolt merge` real, traducen `dolt_conflicts*` a JSON estructurado y auto-abortan merges conflictuados tras capturar conflictos para dejar el working tree limpio y predecible. |
| 5.5 | ✅ Completada |
| 5.6 | ✅ Completa — ACL simple por repo (`reader`/`writer`/`admin`) propiedad de `auth`, aplicada a todos los endpoints de `versioning`, con bootstrap auto-admin al creador y administración de roles vía REST |
| 5.7 | ✅ Completa — `contexts/auth` migra a `LibsqlUserStore` con bootstrap env opcional + fallback legacy `DELTIX_LOCAL_USERS`; `AuthService` agrega setup inicial race-safe, CRUD/soft-delete/hard-delete con analítica de sesiones activas, y Admin UI incorpora `/admin/setup` + panel `/admin/users` con tours driver.js independientes. |
| 5.8 | ✅ Completa — `contexts/versioning` ahora persiste preferencias por repo en la misma libSQL de `repos`, expone `GET/PUT /api/v1/versioning/repos/:repoId/sync-preferences` y `POST /api/v1/versioning/repos/:repoId/sync-preferences/dry-run`, y revalida server-side el cierre transitivo de FKs antes de aceptar overrides por ticket/push. |
