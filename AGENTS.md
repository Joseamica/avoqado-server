# AGENTS.md - Avoqado Server Agent Roles

Agent configurations for Claude Code subagents working on this codebase. This file is NOT auto-loaded — read it when adopting a role.

**Auto-loaded guardrails** (`.claude/rules/`) apply to ALL roles. Rules below are role-specific additions only.

## 🔴 Antes de construir: tier + activación (dos decisiones, no una)

Este archivo NO reemplaza al `CLAUDE.md` de este repo — léelo. Lo que más se rompe si lo saltas:

- **Tier** ("¿lo pagó?") y **activación** ("¿lo quiere prendido?") son ejes DISTINTOS: se componen con AND.
- Un switch se justifica **solo** si puedes nombrar dos clientes reales que quieran lo contrario. Si no, es comportamiento core y va **sin**
  toggle — la app no se construye por toggles.
- El switch canónico vive en `avoqado-web-dashboard`. 🔴 **Nunca solo un `UPDATE` en Postgres.**
- El default ON/OFF lo decides tú midiendo el riesgo; pregunta al founder solo si toca dinero, fiscal, permisos, stock o algo irreversible
  (ahí el default es OFF).
- 🔴 **Apagado se VE y se EXPLICA** — nunca desaparecer en silencio.

Regla completa: `avoqado-server/.claude/rules/feature-gating.md` · cross-repo: `CLAUDE.md` del workspace.

## Entorno: varias sesiones de IA trabajan en paralelo (contexto, no un bloqueo)

Casi siempre hay 2+ agentes editando este workspace al mismo tiempo. Es lo normal: **no es una anomalía, no es motivo para detenerte,
preguntar ni "arreglar" nada.** Solo cambia cómo interpretas lo que ves:

- **Archivos modificados que tú no tocaste** en `git status` / `git diff` = WIP de otra sesión. Normal.
- 🔴 **Nunca** `git reset --hard`, `git checkout .`, `git clean`, `git stash` ni cambies de rama "para dejar limpio": el árbol de trabajo es
  compartido y eso sí destruye trabajo ajeno irrecuperable. Es la única regla dura de esta sección.
- **Commitea por rutas explícitas** (`git add <ruta>`), nunca `git add -A` / `git add .`. Si aun así se cuela WIP ajeno en tu commit, **no
  es grave**: no lo reviertas ni lo reescribas — dilo en el reporte.
- **Ruido que no viene de tu cambio**: el dev server hace hot-reload o se reinicia solo, un test/build truena en un archivo que no tocaste,
  un puerto ocupado. Verifica con `git diff <archivo>`: si ese cambio no es tuyo, **no lo debuggees ni lo corrijas** — reintenta una vez y,
  si sigue, anótalo en el reporte y continúa con lo tuyo.
- **No mates procesos, servidores, emuladores ni daemons de build que no arrancaste tú**, ni reinicies o borres bases de datos locales:
  otras sesiones están usándolas.
- Si un `Edit` falla porque el archivo cambió debajo de ti, relee y reaplica. Sin drama.
- ¿Quién más está adentro? MCP **Huella**: `quien_trabaja(repo)` y `actividad_reciente(repo)`.

**Asume concurrencia, no conflicto. Sigue programando.**

## Verificar sí; cuánto verificar lo decide la máquina

Esta Mac (10 núcleos / 32 GB) está compartida con las demás sesiones y vive cerca del límite.

**Pasan por el chequeo de capacidad, y SOLO estas:** `./gradlew assemble*` / `bundle*`, `xcodebuild`, la suite de tests completa, el
typecheck de todo el monorepo. **No pasan nunca — se corren siempre, aunque la máquina esté saturada:** typecheck o build de UN proyecto, UN
archivo de test, lint. Cuestan segundos: la carga NO es excusa para saltárselos.

```bash
sysctl -n hw.ncpu vm.loadavg   # núcleos y { 1min 5min 15min }
sysctl -n vm.swapusage         # 'free' es la señal que más importa
pgrep -fl "GradleDaemon|KotlinCompileDaemon|xcodebuild|jest|vitest|tsc" | head
```

- **Si swap `free` < 2 GB, o load de 1 min > 2× núcleos, o ya hay un build ajeno corriendo: no arranques.** Adelanta lo que no dependa de
  eso y reintenta (cada ~2 min, tope ~10 min). Si sigue saturado, corre la verificación corta y reporta la larga como pendiente — no te
  quedes esperando indefinidamente.
- **Nunca dos builds pesados a la vez**: dos daemons de Kotlin a `-Xmx6g` tumban la máquina.
- Única excepción a "no mates procesos ajenos": si `pgrep` no muestra ningún build activo, `./gradlew --stop` libera daemons ociosos (4–6 GB
  cada uno, viven 2 h sin usarse) — dilo en el reporte. Los servidores de dev, emuladores y bases de datos NO se tocan.
- Si el typecheck pelón (`npx tsc --noEmit`) revienta por memoria, usa el script del repo (`npm run build`).

**La carga nunca compra "no lo verifiqué" — compra "lo verifiqué en corto".** Si cambiaste código, se comprueba antes de decir que está
listo. Lo que la máquina decide es el _tamaño_: typecheck solo del proyecto tocado, el archivo de test en vez de la suite completa,
`assembleDebug` en vez de `assembleRelease`. **Lo que difieras va explícito en el reporte, con el comando exacto para correrlo.** Un "listo"
que esconde lo que no se corrió es un reporte falso.

| Qué tocaste                                                                             | Mínimo obligatorio                                                                                        |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Dinero, fechas/timezone, tiers, permisos, stock, pagos/reembolsos, migraciones de datos | **Test primero (TDD)** + suite del módulo. No negociable: esto no se difiere ni con la máquina en llamas. |
| Cualquier otro código                                                                   | Que compile / typechee el proyecto tocado. Un cambio que no compila no es un cambio.                      |
| Cambio amplio, o antes de commitear/lanzar                                              | Suite completa + build completo. Aquí sí se espera capacidad.                                             |
| Markdown, docs, comentarios, copy sin lógica                                            | Nada.                                                                                                     |

"No era importante" es una conclusión que se justifica en el reporte, no un default. Si dudas, córrelo.

## Operational Notes

- Backend runtime logs live in `logs/` at the repo root. Check `logs/development.log` first when debugging local backend behavior; when the
  log rotates it may continue as `development1.log`, `development2.log`, etc.

---

## Backend Developer

**Scope:** Feature implementation, bug fixes, API endpoints.

**Context to load:**

- `docs/guides/PERMISSIONS_GUIDE.md` when adding features with auth
- `docs/DATABASE_SCHEMA.md` when modifying models
- `docs/ARCHITECTURE_OVERVIEW.md` when adding new services
- `docs/guides/EMAIL_STANDARDS.md` when creating/modifying email templates

**Role-specific rules:**

- Follow layered architecture: Routes → Controllers (thin) → Services (logic) → Prisma
- Run `npm run pre-deploy` before declaring work complete

---

## Database Architect

**Scope:** Schema changes, migrations, seed data.

**Context to load:**

- `docs/DATABASE_SCHEMA.md`
- `prisma/schema.prisma`
- `docs/BUSINESS_TYPES.md` when modifying VenueType/MCC

**Role-specific rules:**

- Update `prisma/seed.ts` and `src/services/onboarding/demoSeed.service.ts` for new features
- Check cross-repo impact: TPV Android depends on API response shapes
- New fields MUST be optional with defaults (backward compat)

---

## Payment Specialist

**Scope:** Blumon TPV/E-commerce, Stripe subscriptions, order payments, inventory deduction.

**Context to load:**

- `docs/guides/PAYMENT_FLOW_GUIDE.md`
- `docs/PAYMENT_ARCHITECTURE.md`
- `docs/BLUMON_TWO_INTEGRATIONS.md`
- `docs/STRIPE_INTEGRATION.md`

**Role-specific rules:**

- Test with `npm run test:tpv` and `npm run test:workflows`
- All other payment rules auto-load via `.claude/rules/payments.md`

---

## Security Auditor

**Scope:** Permissions, auth, access control, tenant isolation.

**Context to load:**

- `docs/guides/PERMISSIONS_GUIDE.md`
- `docs/PERMISSIONS_SYSTEM.md`
- `src/lib/permissions.ts`
- `src/services/access/access.service.ts`

**Role-specific rules:**

- Verify frontend-backend permission sync (`defaultPermissions.ts` must match `permissions.ts`)
- Check `PERMISSION_TO_FEATURE_MAP` for white-label features
- Run `bash scripts/check-permission-migration.sh` to verify

---

## Code Reviewer

**Scope:** PR review, quality checks, regression prevention.

**Context to load:**

- Relevant `docs/` files based on changed areas
- `docs/guides/EMAIL_STANDARDS.md` when reviewing email template changes

**Role-specific rules:**

- All quality/regression rules auto-load via `.claude/rules/testing-and-git.md`
- All critical warnings auto-load via `.claude/rules/critical-warnings.md`

---

## Inventory Specialist

**Scope:** FIFO batches, recipes, stock deduction, serialized items.

**Context to load:**

- `docs/guides/PAYMENT_FLOW_GUIDE.md`
- `docs/INVENTORY_REFERENCE.md`
- `docs/INVENTORY_TESTING.md`
- `docs/features/SERIALIZED_INVENTORY.md`

**Role-specific rules:**

- Serialized items use `serializedInventoryService.markAsSold()`
- Test with `npm run test:workflows`
- All FIFO/inventory rules auto-load via `.claude/rules/payments.md`
