# Plan de Piloto: Deltix en un caso real (validación de Dolt)

Estado del proyecto en este punto: Fases 1-5 completas en `main` (ambos repos),
versión `v0.2.0` publicada (imágenes `ghcr.io/sammybytes/deltix-server:0.2.0`
y `ghcr.io/sammybytes/deltix-client:0.2.0`), CI/CD verde, addons con TOFU
funcionando, versionado real con Dolt (branches/merge/log/diff), roles por
repo, Admin Web UI con wizard de primer arranque y preferencias de sync.
Este documento es el plan operativo para desplegar un piloto controlado —
**NO** es un despliegue de producción crítico (ver advertencias en la
sección 0).

## 0. Alcance y advertencias (léelo primero)

- Este piloto es para **validar el flujo real** (Dolt como motor de versionado,
  el control plane, el CLI, addons) con datos **no críticos** de la empresa,
  en una red interna/VPN, con backups manuales como red de seguridad.
- **NO** usar todavía para datos de producción irremplazables sin respaldo
  externo. Faltan (deuda conocida, no bloqueante para un piloto):
  HA/clustering, backups automatizados, pentest externo, SSO/RBAC (tier
  Enterprise no implementado aún), monitoreo/alerting, runbook de incidentes.
- Corta duración recomendada: 2-4 semanas, con un checkpoint de decisión
  ("¿seguimos, ajustamos, o abortamos?") al final.

## 0.1 Novedades de Fase 5 relevantes para el piloto

- **Primer arranque**: si no hay usuarios en la base de datos, configura
  `DELTIX_BOOTSTRAP_ADMIN_USERNAME` / `DELTIX_BOOTSTRAP_ADMIN_PASSWORD` para
  crear el usuario admin inicial de forma segura (hash argon2id real). Con
  ese usuario se entra al wizard de la Admin Web UI (Driver.js) para crear
  al resto de usuarios del piloto y asignarles acceso a addons.
- **Roles por repo**: cada repo Dolt tiene roles `reader`/`writer`/`admin`
  independientes. El creador de un repo queda `admin` automáticamente.
  Fail-closed: sin rol asignado no hay acceso, ni siquiera de lectura.
  Gestionar roles desde la Admin UI o `deltix roles list|grant|revoke`.
- **Preferencias de sync**: antes del piloto, definir con el equipo si
  cada repo sincroniza solo schema o schema+data, y qué tablas (las
  relacionadas por FK se incluyen automáticamente para evitar corrupción
  parcial). Usar `deltix sync-prefs get|set|dry-run` o la Admin UI —
  recomendado correr `dry-run` antes del primer push real para confirmar
  el conjunto de tablas exacto.
- **CLI parity**: `deltix branch`, `deltix merge`, `deltix log`, `deltix diff`
  ya están disponibles en Deltix-Client `v0.2.0` — no hace falta usar la API
  REST directamente para las operaciones de versionado del día a día.

## 1. Preparar el entorno del piloto

1. **Elegir el host**: una VM/servidor interno (Linux x86_64), acceso SSH,
   Docker + Docker Compose instalados. No se requiere Kubernetes para un
   piloto de un solo nodo.
2. **Generar material criptográfico REAL** (no usar `scripts/setup-local-demo.ts`,
   es solo para desarrollo local — usa claves de prueba):
   - Par de llaves Ed25519 para firmar la licencia (`node:crypto` /
     `openssl genpkey -algorithm ed25519`). La llave privada se queda fuera
     del repo y del servidor; solo firma el payload de licencia una vez.
   - Par de llaves Ed25519 para JWT (sesiones del control plane).
   - Certificados TLS para el puerto gRPC (`50051`) — para el piloto, un
     certificado autofirmado con CA propia es aceptable; para producción real,
     usar una CA interna de la empresa o Let's Encrypt si hay dominio público.
3. **Firmar una licencia real** con tier acorde al piloto (`community` si es
   solo para validar el flujo, `enterprise` si se quieren probar addons
   oficiales de pago). Guardar el payload firmado (`DELTIX_LICENSE_KEY`) y la
   llave pública (`DELTIX_LICENSE_PUBLIC_KEY`) — la privada NUNCA se despliega.
4. **Inicializar el repositorio Dolt** en un volumen persistente del host
   (`dolt init` dentro del volumen que se montará en el contenedor).

## 2. Desplegar Deltix-Server

1. `docker pull ghcr.io/sammybytes/deltix-server:latest` (publicado por
   `.github/workflows/cd.yml` al crear un tag `vX.Y.Z`).
2. Crear un `docker-compose.yml` en el host del piloto (fuera de este repo,
   vive en el servidor del piloto) que:
   - Monte el volumen del repo Dolt, el volumen `/app/data` (libSQL: sesiones,
     tickets, transfer jobs, addon trust store), y los certificados TLS
     como solo-lectura.
   - Pase las env vars reales (licencia, JWT, usuarios locales, CORS
     allow-list del dominio interno, `DELTIX_ADMIN_UI_ENABLED=true` si el
     operador quiere la UI web).
   - Publique el puerto HTTP (control plane) y el gRPC (motor de transferencia).
3. `docker compose up -d`, verificar `docker compose logs -f` hasta ver
   `"HTTP control plane listening"` y `"gRPC transfer engine listening"`.
4. Verificar el healthcheck: `docker inspect --format='{{.State.Health.Status}}' <container>`
   debe reportar `healthy` en menos de 30s.

## 3. Smoke test manual del piloto (checklist)

- [ ] `curl https://<host>:<port>/admin` responde 200 (si la UI está habilitada).
- [ ] Completar el wizard de primer arranque (Driver.js) con el usuario
      bootstrap-admin y crear al menos un usuario adicional real del equipo.
- [ ] Asignar rol (`reader`/`writer`/`admin`) al usuario adicional sobre el
      repo del piloto — confirmar que sin rol asignado el acceso es denegado
      (fail-closed) y que con `reader` no se puede hacer push.
- [ ] Login vía Admin UI o `POST /api/v1/auth/login` con un usuario local real.
- [ ] Configurar preferencias de sync del repo (`deltix sync-prefs set` o UI)
      y correr `deltix sync-prefs dry-run` para confirmar el conjunto de
      tablas antes del primer push real.
- [ ] Crear un ticket de transferencia real y hacer `push`/`pull` desde
      Deltix-Client (binario compilado o imagen `ghcr.io/.../deltix-client`)
      apuntando al host del piloto.
- [ ] Verificar en `dolt log` (dentro del volumen) o vía `deltix log` que
      aparece el commit generado por la transferencia — esto es lo que
      realmente valida que Dolt está funcionando como motor de versionado
      real bajo carga.
- [ ] Crear una branch de prueba (`deltix branch create`), hacer un cambio,
      y mergearla (`deltix merge`) — confirmar que un conflicto real se
      reporta correctamente si se fuerza uno.
- [ ] Forzar un reinicio del contenedor y confirmar que el anti-tamper
      (chequeo de reloj vs. `dolt_log`) no bloquea un arranque legítimo.
- [ ] (Opcional) Registrar un addon comunitario de prueba vía TOFU y
      confirmar que aparece en el panel de confianza.

## 4. Backups (mitigación manual mientras no hay automatización)

- Cron diario simple en el host: `tar` del volumen Dolt + volumen `/app/data`
  hacia almacenamiento externo (NAS/S3/backup existente de la empresa).
  Esto NO reemplaza una solución real de backups pero cubre el gap durante
  el piloto.

## 5. Rollback / desmontaje del piloto

- `docker compose down` detiene los contenedores sin perder los volúmenes.
- Si se decide abortar el piloto: exportar el historial Dolt
  (`dolt_log`/`dolt_diff`) como evidencia antes de borrar los volúmenes.
- Revocar la licencia del piloto (dejar de usar esa llave) y destruir las
  llaves privadas generadas específicamente para este piloto.

## 6. Al finalizar (checkpoint de decisión)

Evaluar junto al equipo/patrocinador del piloto:
- ¿El flujo Dolt + control plane + CLI + roles + sync preferences se
  comportó como se esperaba bajo uso real (no solo tests automatizados)?
- ¿Qué gaps de la lista de "no crítico para producción" (sección 0)
  bloquean avanzar?
- ¿Se justifica invertir en HA/backups automatizados/SSO/pentest externo
  antes de un despliegue más amplio, ahora que Fase 5 (versionado real,
  roles, sync preferences) ya está completa?

## Referencia rápida de comandos CD

- Publicar una nueva imagen de Deltix-Server: `git tag vX.Y.Z && git push --tags`
  → dispara `.github/workflows/cd.yml` → imagen en
  `ghcr.io/sammybytes/deltix-server:X.Y.Z` y `:latest`.
- Publicar una nueva versión de Deltix-Client: mismo mecanismo de tag en ese
  repo → dispara `.github/workflows/release.yml` → binarios adjuntos al
  GitHub Release (Linux/macOS/Windows, x64/arm64) + imagen
  `ghcr.io/sammybytes/deltix-client:X.Y.Z`.
- Ambos workflows también soportan `workflow_dispatch` manual (sin necesidad
  de tag) desde la pestaña Actions de GitHub.
