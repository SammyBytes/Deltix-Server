# ADR 0002: Fase 5 — Versionado Real sobre Dolt, Gestión de Usuarios en Admin UI y
# Preferencias de Sincronización

- **Status**: **Draft** — plan de alcance, código NO autorizado a empezar todavía.
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
| 5.4 | **Merge y conflictos** | `dolt merge`, traduciendo conflictos SQL crudos a JSON estructurado y legible | Server, Client |
| 5.5 | **Historial / diff navegable** | `dolt_log` / `dolt_diff` (mismo patrón de lectura ya usado en `licensing/dolt-commit-log.reader.ts`) expuestos como `deltix log` / `deltix diff` | Server, Client |
| 5.6 | **Autorización por repo/branch** | Extensión de `auth` con ACL nueva hacia `versioning` (rol simple por repo: lector/escritor/admin — NO RBAC granular todavía, mantener simple) | Server |
| **5.7** | **Gestión de usuarios en Admin UI** (nuevo, pedido 2026-08-27) | CRUD visual de usuarios (crear/editar/desactivar/eliminar), listado de sesiones activas por usuario, setup inicial de primer admin | Server (admin-ui + auth) |
| **5.8** | **Preferencias de sincronización** (nuevo, pedido 2026-08-27) | Selección de "solo schema" vs "schema + datos"; selección de tablas a sincronizar con expansión automática por FK | Server (versioning), Client (flags de `push`) |

Las sub-fases 5.7 y 5.8 dependen de 5.1-5.2 (necesitan un repo Dolt real y un modelo
de commit para tener sentido), por eso van después en el orden de ejecución aunque se
documenten aquí juntas. Sugerencia de orden real de trabajo: **5.1 → 5.2 → 5.7 (setup
inicial + CRUD básico) → 5.8 → 5.3 → 5.4 → 5.5 → 5.6 (RBAC fino al final, una vez el
modelo de usuarios ya existe de verdad)**.

---

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
- ¿El primer admin se crea solo vía `/admin/setup` en el navegador, o también debe
  poder crearse por variable de entorno en despliegues automatizados (Docker/CD)
  donde no hay un humano haciendo clic? → Propuesta: soportar ambos — env var
  `DELTIX_BOOTSTRAP_ADMIN_USERNAME`/`PASSWORD` para IaC, y el wizard web para
  instalaciones manuales, mutuamente excluyentes (si la env var está presente,
  `/admin/setup` queda deshabilitado desde el arranque).

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
  → Propuesta: sí, de bajo costo de implementar y buena UX/seguridad.

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
| 5.2 | ⏳ No iniciada |
| 5.3 | ⏳ No iniciada |
| 5.4 | ⏳ No iniciada |
| 5.5 | ⏳ No iniciada |
| 5.6 | ⏳ No iniciada |
| 5.7 | ⏳ No iniciada |
| 5.8 | ⏳ No iniciada |
