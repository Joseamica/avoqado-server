# RELEVO — V5-A (planes ↔ funciones sueltas: la regla común de compra y UN solo camino que concede un plan)

> Escrito el 2026-09-22 (tarde) por Claude Opus 5 al cambiar de LLM, a pedido del founder: «pon todo el contexto que
> hemos hecho, que estamos por hacer, todo para poder continuar». **Léelo entero antes de tocar una línea.**
> Nada de V5-A está commiteado. Nada está desplegado. El árbol de `avoqado-server` es COMPARTIDO con ~20 sesiones.

---

## 0. Qué hacer PRIMERO al retomar (en este orden)

> **Actualizado el 2026-09-22 (tarde-noche) por Claude Opus 5.** El founder eligió la **opción A** de la §8
> («seguir ronda tras ronda hasta que Codex apruebe»), así que **R1–R14 están TODOS cerrados** — no sólo las
> regresiones. Nada commiteado, nada desplegado.

1. Lee §1 (el porqué), §3 (git: cómo NO romper el índice compartido) y §5 (el estado de R1–R14).
2. Carga el contexto del repo: `avoqado-server/CLAUDE.md`, `avoqado-server/.claude/rules/*.md` y la memoria
   `~/.claude/projects/-Users-amieva-Documents-Programming-Avoqado/memory/relevo-v5a-planes-22-sep.md`.
3. **Lee el veredicto de la ronda 3 de Codex** (§9) y cierra lo que traiga.
4. Verificación completa por `avq-verify` (§7) y pide permiso para el commit local por rutas (§3).

### 🔴 DECISIÓN DEL FOUNDER (22-sep, noche, tras la RONDA 3 de Codex): se CIERRA el cambio de plan directo

Codex **RECHAZÓ** la ronda 3 con **20 hallazgos (6 P1 · 14 P2)**, de los cuales **10 eran NUEVOS: los abrieron mis
propios arreglos de la ronda 2**. Se cerraron en el momento cuatro —**#1 (prorrateo), #3, #12 y #13**, los cuatro
regresiones de esa misma tanda— y el founder eligió entonces **cortar la raíz en vez de seguir parchando**:

> **El botón «cambiar de plan» del panel responde 409 `CAMBIO_DE_PLAN_CERRADO`** («escríbenos y te lo cambiamos el
> mismo día»), como ya estaba la venta suelta, hasta que el cambio pase por Checkout o el portal de Stripe.

🔑 **Por qué esto no es rendirse, es el arreglo:** ese botón era **el único camino que movía dinero desde el
SERVIDOR** (`subscriptions.update` con `always_invoice`). Para que fuera seguro había que inventarle una barrera
económica durable, una llave de idempotencia estable, una fecha de prorrateo inmutable y un 202 honesto — y **cada
una de esas piezas fue una fuente de defectos**. Ocho de los dieciséis hallazgos abiertos (#1, #2, #3, #4, #5, #6,
#11 y #20) vivían ahí y **dejan de existir**, no se parchan. Además contradecía la propia decisión del v4 del
founder: *el dinero sólo se mueve en una confirmación de Stripe*.

**Qué se retiró con él** (código muerto es peor que código ausente): `cambiarDePlanPorLaRegla`,
`rechazoDefinitivoDeStripe`, la barrera `PENDING_PLAN_CHANGE` (y su valor del enum, y su consumidor en el barrido)
y las pruebas que fijaban ese camino. **Cotizar el cambio sigue abierto**: es de sólo lectura y no mueve un peso.

**Lo que queda abierto de la ronda 3 (≈8, sólo 1 P1):** #7 (parcial), #8, #9, #10, **#14 (P1, atomicidad de R4)**,
#15, #16, #17, #18, #19. Informe completo: `docs/auditorias/2026-09-22-auditoria-codex-v5a-paso6-ronda3.md`.

### Lo que se cerró en esta tanda (todo con TDD y sabotaje verificado)

| # | Cómo se cerró |
|---|---|
| R4 | `soltarLease(…, lease)`, `DECLINED` y cierre `ACTIVE` con el lease en el `where`; `liberarLugar` sólo si `count===1`; el vencimiento se mide al TOMARLO (`Date.now()`, no el `now` de antes de cinco llamadas externas) |
| R7 | `antesDeEnviar` pegado al POST (ya no antes del `retrieve`); `rechazoDefinitivoDeStripe` relanza 4xx/401/403. 🔴 **`StripeCardError` se excluye a PROPÓSITO** —divergencia deliberada de la receta original—: cuando Stripe lo devuelve, el precio YA cambió y tratarlo como «no pasó nada» invita a repetir y cobra otro prorrateo |
| R9 | `updateSubscriptionPrice` exige items completos y exactamente 1, y que venda el `planOrigen` |
| R8 | `sinTiempo()` dentro del `autoPagingEach` |
| R2 | decisión PURA `choqueAlConcederPlan` + `exigirQueSePuedaConceder`, aplicada en los 4 escritores (activar, prueba del panel, prueba genérica con candado propio, wizard). `vinculoPropioYaComprobado` conserva el camino legítimo de limpiar un vínculo MUERTO (R0) |
| R10 | `elegirFilaDelPlan` mira `endDate` y `cobroVivo`; `hayAmbiguedadDePlan`; superadmin deriva el tier de la fila elegida, no de `Venue.planTier` |
| R11 | la entrega clasifica con el catálogo COMPLETO y acotado (`catalogoCompleto`), no sólo con los dos planes |
| R12 | `cerrarConflictoTerminado` (resolución `TERMINADA`) y reapertura de los `RESOLVED/ENTREGADA` en un episodio nuevo |
| R13 | el tier sale de `tierQueVendeLaSuscripcion(sub)`, nunca de `input.tier`; `payNow` de lo cobrado cuando la suscripción no la creó este formulario |
| R14 | `customer.deleted` sólo retira filas ligadas a suscripciones DE ESE cliente, bajo candado; el cliente se limpia condicionado |
| R5 | la barrera se persiste como obligación `PENDING_PLAN_CHANGE` justo antes del POST y FUERA de la transacción de la regla (si no, un rollback se la lleva); el POST lleva `idempotencyKey` estable y `proration_date` anclado; el barrido concilia esos pendientes aunque su fila siga ACTIVA (era el consumidor que R7 pedía) |

🔴 **El enum nuevo (`PENDING_PLAN_CHANGE`) se añadió a la migración `20260922000000` que ya existía**, porque
**no está aplicada en ningún entorno**. No es una segunda migración. `docs/SCHEMA_MAP.md` regenerado (372 modelos).

### Trampas que costaron tiempo en esta tanda (no repetirlas)

- Una prueba de R11 **pasó por el motivo equivocado**: el mock de `feature.findMany` ignoraba el `where`, así que
  le entregaba el catálogo completo aunque el código pidiera sólo los planes. El mock tiene que HONRAR el `where`.
- Tres sabotajes NO cayeron a la primera (wizard, `cobroVivo===true`, el tier de R13): los tres eran **huecos
  reales**, no defensa en profundidad. Se cerraron con prueba propia. Investigar siempre, nunca asumir.
- Un `s.replace` de python demasiado amplio tocó pruebas ajenas dentro del mismo archivo. Anclar el reemplazo.
- `npx tsc` a pelo **murió por OOM**: el typecheck va SIEMPRE por `avq-verify`.

## 1. Qué es esto, en dos párrafos

Avoqado vende PLANES (PRO, PREMIUM) y quiso vender también FUNCIONES SUELTAS. Los planes son filas de la misma tabla
`Feature` (`PLAN_PRO`, `PLAN_PREMIUM`) y el acceso de un negocio vive en `VenueFeature` (una fila por función, con su
vínculo `stripeSubscriptionId`). Las auditorías de Codex destaparon defectos de dinero VIVOS en producción: dos pestañas
pagadas ⇒ dos suscripciones y la primera huérfana cobrando; un plan suspendido que sigue cobrando no contaba como plan;
escritores que borraban o apagaban el vínculo de una suscripción que seguía cobrando.

**V5-A** es el arreglo de raíz del lado servidor: (a) una **regla común de compra** (`autorizarObligacionNueva`) que,
bajo un candado por negocio, mira lo VIVO en Stripe (no el acceso local) antes de abrir cualquier cobro; y (b) **un solo
camino que concede un plan** (`entregarSuscripcionDePlan`, «la entrega»), al que convergen el checkout, los webhooks, el
barrido de acceso, el cambio de plan del panel y las dos altas (onboarding). La venta suelta está **CERRADA** (409) por
decisión del founder hasta que el rediseño completo esté hecho.

### Decisiones del founder que NO se re-litigan
- «Recuerda que **redis no usamos**». Todo candado es de Postgres (advisory lock).
- Venta suelta **CERRADA** hasta que todo quede bien hecho (opción A, 21-sep): «a, hasta que quede todo bien hecho .. continúa».
- **v4 elegido (22-sep): el dinero sólo se mueve en una confirmación de Stripe** (Checkout / portal). V5-A es la base de eso.
- Nunca esconder una pestaña. Toda función nueva necesita tier y un precio suelto sugerido investigado.
- Prorrateo al subir de plan «como lo hace Claude» (fase 2 del plan; exige medir en Stripe de prueba → permiso pendiente).
- «No, termina todo lo tuyo» (no push). Commit local sólo con permiso explícito (ya dio permiso para R0 y rondas 4-6, NO para V5-A).

---

## 2. Dónde vive todo

| Qué | Ruta |
|---|---|
| **Plan maestro** (sección «V5-A · Orden de trabajo», pasos 1-7 y la lista C1–C15) | `avoqado-server/docs/superpowers/plans/2026-09-21-coexistencia-planes-y-funciones-sueltas.md` |
| Auditoría Codex, paso 6 ronda 1 (C1–C15) | `docs/auditorias/2026-09-22-auditoria-codex-v5a-paso6-ronda1.md` (raíz del workspace) |
| Auditoría Codex, paso 6 ronda 2 (R1–R14) | `docs/auditorias/2026-09-22-auditoria-codex-v5a-paso6-ronda2.md` (raíz del workspace) |
| Encargo que se le dio a Codex en la ronda 2 (plantilla para la ronda 3) | `docs/auditorias/2026-09-22-encargo-codex-v5a-paso6-ronda2.md` (raíz del workspace) |
| Estado en la tabla de fases | `.claude/rules/proyectos-por-fases.md` → «Planes ↔ funciones sueltas» → fila «Rediseño de la compra» |
| Memoria de relevo | `~/.claude/projects/-Users-amieva-Documents-Programming-Avoqado/memory/relevo-v5a-planes-22-sep.md` |

---

## 3. Git — lee esto o romperás trabajo ajeno

- Repo `avoqado-server`, rama `develop`. HEAD al escribir: `5b79b830`. Commits previos DE ESTE PROYECTO, ya locales y sin
  push: `0ac14722` (fase 0) y `2047c2f9` (R0). **V5-A: nada commiteado.**
- 🔴 **El índice es COMPARTIDO**: tenía 30 archivos staged, casi todos de OTRAS sesiones. Un `git commit` pelón se los
  lleva. **Commitea SIEMPRE con `git commit -- <rutas>`**, revisa antes `git diff --cached --name-only` y después
  `git show --stat`. Nunca `git add -A`, `git stash`, `git checkout .`, `git reset --hard`, ni cambies de rama.
- **Archivos de V5-A** (lo que va en el commit por rutas, cuando el founder lo autorice):
  - Ya staged desde el paso 2 (son míos): `prisma/schema.prisma`, `prisma/migrations/20260922000000_billing_obligation_conflict/migration.sql`,
    `scripts/generate-schema-map.ts`, `docs/SCHEMA_MAP.md`, `docs/superpowers/plans/2026-09-21-coexistencia-planes-y-funciones-sueltas.md`.
    ⚠️ `prisma/schema.prisma` y `docs/SCHEMA_MAP.md` pueden traer también cambios de OTRA sesión (p. ej. la migración
    `20260922120000_terminal_attempt_resolution` es AJENA): revisa `git diff --cached -- prisma/schema.prisma` antes.
  - Sin stage (45 rutas; la lista viva está en `~/.claude/jobs/0f1d7b63/tmp/v5a-mios.txt`, copiada aquí):
    ```
    src/controllers/dashboard/venueFeature.dashboard.controller.ts
    src/controllers/onboarding.controller.ts
    src/jobs/plan-access-reconciliation.job.ts
    src/services/access/autorizarObligacionNueva.ts
    src/services/access/conflictosDeObligacion.service.ts
    src/services/access/filaDelPlan.ts
    src/services/access/inventarioDeObligaciones.ts
    src/services/access/obligacionesDeCobro.ts
    src/services/dashboard/feature.service.ts
    src/services/dashboard/planState.service.ts
    src/services/dashboard/superadmin.service.ts
    src/services/dashboard/venue.dashboard.service.ts
    src/services/onboarding/planActivation.service.ts
    src/services/stripe.service.ts
    src/services/stripe.webhook.service.ts
    src/services/superadmin/subscription.service.ts
    tests/__helpers__/setup.ts
    tests/unit/controllers/completeV2.confirmationEmail.test.ts
    tests/unit/controllers/completeV2.launchGates.test.ts
    tests/unit/controllers/dashboard/cambioDePlanConvergente.test.ts
    tests/unit/controllers/dashboard/cambioDeSuscripcionCruceDePlan.test.ts
    tests/unit/jobs/planAccessReconciliation.job.test.ts
    tests/unit/services/access/autorizarObligacionNueva.test.ts
    tests/unit/services/access/conflictosDeObligacion.aviso.test.ts
    tests/unit/services/access/conflictosDeObligacion.test.ts
    tests/unit/services/access/filaDelPlan.test.ts
    tests/unit/services/access/inventarioDeObligaciones.test.ts
    tests/unit/services/access/obligacionesDeCobro.test.ts
    tests/unit/services/dashboard/feature.saveVenueFeaturesRetirada.test.ts
    tests/unit/services/dashboard/planState.service.test.ts
    tests/unit/services/dashboard/venue-plan-checkout-cobroDoble.test.ts
    tests/unit/services/onboarding/planActivation.service.test.ts
    tests/unit/services/planState.retentionOffer.test.ts
    tests/unit/services/stripe.createPlanCheckoutSession.test.ts
    tests/unit/services/stripe.createPlanSubscription.test.ts
    tests/unit/services/stripe.fulfillPlanCheckout.test.ts
    tests/unit/services/stripe.updateSubscriptionPrice.test.ts
    tests/unit/services/stripe.webhook.convergenciaPlan.test.ts
    tests/unit/services/stripe.webhook.planPro.test.ts
    tests/unit/services/stripe.webhook.reactivacion.test.ts
    tests/unit/services/stripe.webhook.replay.test.ts
    tests/unit/services/stripe.webhook.seatReconciliation.test.ts
    tests/unit/services/stripe.webhook.service.test.ts
    tests/unit/services/superadmin/r0.obligacionesVivas.test.ts
    tests/unit/services/superadmin/subscription.service.test.ts
    ```
    Más, en el ROOT del workspace (otro repo git): `docs/auditorias/2026-09-22-auditoria-codex-v5a-paso6-ronda{1,2}.md`,
    esta nota vive en el server.
  - ⚠️ Varios de esos archivos (`stripe.service.ts`, `onboarding.controller.ts`, `stripe.webhook.service.ts`) pueden
    tener también cambios de OTRAS sesiones. Antes de commitear, mira `git diff HEAD -- <archivo>` y confirma que todo
    hunk es de V5-A; si no, avísale al founder (no reviertas trabajo ajeno).
- La migración `20260922000000_billing_obligation_conflict` está **SIN aplicar** a `av-db-25`. No se aplica hasta que
  entre a `develop` y el founder lo autorice. Jamás `migrate reset`/`db push` contra `av-db-25`.

---

## 4. Qué está HECHO (sin commitear, con prueba y sabotaje)

### Piezas nuevas / clave
- `src/services/access/obligacionesDeCobro.ts` — núcleo PURO: `clasificarSuscripcion` (por lookup_key `plan_(pro|premium)_`
  o producto del catálogo), `clasificarEstado` (HABILITANTE/RECUPERABLE/TERMINAL), `evaluarCompatibilidad` (C7: un
  `CAMBIO_DE_PLAN` sobre suscripción de varios ítems ⇒ `CAMBIO_AMBIGUO`).
- `src/services/access/inventarioDeObligaciones.ts` — qué cobra VIVO en Stripe para el negocio (cliente actual + vínculos
  de `VenueFeature` + conflictos PENDING, con tope y truncamiento ⇒ 503; `LECTURA` 15 s sin reintentos; `aTiempo()`).
- `src/services/access/autorizarObligacionNueva.ts` — la REGLA: `pg_try_advisory_xact_lock(hashtext('stripe-obligaciones:'||venueId))`
  (no espera: la segunda compra falla YA), paso 0 del alta (bloquea sólo con lease de `activatePlan` vivo o marca temprana
  de <15 min — caso Berthe), expira checkouts abiertos nuestros, presupuesto de lecturas 45 s, tx 150 s, opción
  `desdeElAlta`. Registra conflictos UNKNOWN_PRODUCT.
- `src/services/access/conflictosDeObligacion.service.ts` — `BillingObligationConflict` (modelo nuevo): `registrarConflictoDeObligacion`
  (`createMany`+`skipDuplicates`), `avisarConflictoCreado` (bitácora + `sendOpsAlert` a `OPS_ALERT_EMAIL`, sólo al CREAR),
  `cerrarConflictoEntregado` (RESOLVED/`ENTREGADA` en la tx de la entrega), `conflictosPendientes`.
- `src/services/access/filaDelPlan.ts` — `elegirFilaDelPlan` (C8): activa y no suspendida > ligada > activa; empate ⇒ `updatedAt` más reciente.
- `src/services/stripe.service.ts`:
  - `STRIPE_DENTRO_DEL_CANDADO = { timeout: 15_000, maxNetworkRetries: 0 }` (C3) en toda llamada bajo candado.
  - `suscripcionVigente` / `estadoDeLaSuscripcion` / `suscripcionPuedeCobrar` (SI/NO/INCIERTO) / `suscripcionVendeElPlan`.
  - `createPlanSubscription`: hook `antesDeCobrar` justo antes del POST (C15); reusa un vínculo sólo si SI; INCIERTO ⇒ 503.
  - `entregarSuscripcionDePlan` («la entrega»): TODA en una tx con `lock_timeout 15s` + `pg_advisory_xact_lock` (bloqueante)
    de la MISMA llave, 120 s. Lee las dos filas de plan, consulta Stripe, decide con `decidirEntregaDePlan` (LIGAR /
    SUSTITUIR / APLICAR_ESTADO / RETIRAR_ACCESO / SOLTAR), aplica con CAS (`updateMany where {id, updatedAt}`), traslado de
    tier conserva cobranza (C9), rama de conflicto retira lo demostrable (C10), **verifica pertenencia** (R6, ver §5).
  - 🔴 **La regla y la entrega NO se anidan**: la entrega se llama DESPUÉS de que la regla suelta su candado (misma llave;
    anidar = auto-bloqueo hasta `lock_timeout`).
- `src/services/stripe.webhook.service.ts`: `handleSubscriptionUpdated` (devuelve boolean) y `handleInvoicePaymentSucceeded`
  escriben una fila de PLAN por el camino de siempre sólo si su suscripción vende HOY ese plan; si no, `entregaDecidePorElPlan`.
  Sin fila ligada + conflicto PENDING + negocio operativo ⇒ decide la entrega (C11/R6). C14: `trialEnd` vigente en `trialing`.
- `src/jobs/plan-access-reconciliation.job.ts`: sólo cuenta/audita si el manejador concedió.
- `src/controllers/dashboard/venueFeature.dashboard.controller.ts`: `cambiarDePlanPorLaRegla` (PRO↔PREMIUM por la regla,
  `updateSubscriptionPrice` DENTRO de la regla, entrega DESPUÉS; 202 si algo falla tras enviar — C3).
- `src/services/onboarding/planActivation.service.ts` (`activatePlan`, alta corta): cobro dentro de la regla con
  `desdeElAlta`; `nuestroLease` en la adquisición y el avance (C6); tier/intervalo guardados = los COBRADOS (C12).
- `src/controllers/onboarding.controller.ts` (`completeV2Onboarding`, carril viejo del alta): regla + entrega;
  `dejarCobroEnCurso` (IN_PROGRESS + lease, 503) ante desenlace dudoso (C4/C5); `PLAN_YA_CONTRATADO` con una suscripción
  ⇒ recupera por la entrega; **R3**: el 409 `PLAN_ACTIVATION_IN_PROGRESS` exige ahora lease VIVO.
- Superadmin (C2): `runAuditedPlanMutation` y `assignCompPlan` toman el candado; `activateVenuePlan` con 409
  `PLAN_LIGADO_A_STRIPE` / `OTRO_PLAN_ACTIVO` y CAS; `enableFeatureForVenue` con código de plan pasa por `assignCompPlan`.
- C1: `saveVenueFeatures` (el POST que borraba y recreaba todo) responde 410 `FEATURES_BULK_SAVE_RETIRED`.

### Sabotajes hechos: S1–S54, cada uno tumba SÓLO su prueba
(detalle por paso en el plan maestro). Los de C11: S51 webhook sin la rama de conflicto · S52 la entrega no cierra el
conflicto · S53 avisa aunque el conflicto ya existía · S54 el aviso no manda correo.

---

## 5. Ronda 2 de Codex sobre el paso 6: RECHAZADO (6 P1 · 8 P2) — **LOS 14 CERRADOS** (22-sep, tarde-noche)

Informe completo: `docs/auditorias/2026-09-22-auditoria-codex-v5a-paso6-ronda2.md`.
**Clave para priorizar:** R1, R3, R4, R6, R7 y R9 son **regresiones o huecos que abrieron MIS arreglos** (el árbol no
puede commitearse con ellas). R2, R5, R8, R10–R14 son **defectos que ya existen en producción** que Codex destapó
mirando alrededor.

| # | Sev | Qué | Estado |
|---|---|---|---|
| R1 | P1 | `avisarConflictoCreado` exigía `conflictsWith` (error de tipos) | ✅ `conflictsWith?` opcional; typecheck lo confirmaba igual |
| R2 | P1 | Escritores administrativos que pueden dejar DOS planes activos: `grantTrialForVenue`/`extendPlanTrial` (superadmin.service ~787), `grantVenuePlanTrial` sólo revisa PRO (subscription.service ~371), el wizard de superadmin crea ambas filas (controllers/superadmin/onboarding.controller.ts ~584) | ✅ cerrado (ver §0) |
| R3 | P1 | El `IN_PROGRESS` que deja `dejarCobroEnCurso` atoraba el alta vieja para siempre (el 409 no miraba el lease) | ✅ 409 sólo con lease vivo; 2 pruebas (`completeV2.launchGates`, vencido y sin lease) · ✅ sabotaje verificado |
| R4 | P1 | El propietario del lease no se exige en `soltarLease`, en el paso a `DECLINED` ni en el cierre `ACTIVE`; y `nuestroLease` se calcula con un `now` viejo | ✅ cerrado + 4 sabotajes |
| R5 | P1 | El 202 del cambio de plan no deja barrera económica persistida (llave de idempotencia y cambio pendiente por negocio/suscripción) | ✅ cerrado (ver §0) |
| R6 | P1 | La entrega por conflicto no verificaba pertenencia ni el negocio operativo | ✅ la entrega exige `metadata.venueId === venueId` o, sin metadata, `customer === venue.stripeCustomerId` (si no: 🚨 y null, sin registrar conflicto); la rama del webhook exige negocio operativo. 4 pruebas · ✅ sabotajes verificados |
| R7 | P2 | `enviado = true` se marca antes del `retrieve`; un rechazo DEFINITIVO del POST (4xx) se trata como dudoso | ✅ cerrado + 2 sabotajes |
| R8 | P2 | El presupuesto de 45 s no se revisa dentro de `autoPagingEach` (inventarioDeObligaciones ~114) | ✅ cerrado + sabotaje |
| R9 | P2 | `updateSubscriptionPrice` vuelve a leer y cambia el PRIMER ítem sin validar la forma | ✅ cerrado + sabotaje |
| R10 | P2 | `elegirFilaDelPlan` no mira vigencia (`endDate`) ni estado económico; superadmin muestra `Venue.planTier` y no el de la fila elegida | ✅ cerrado (ver §0) |
| R11 | P2 | La entrega clasifica con catálogo de SÓLO planes: una función conocida sale `DESCONOCIDO` y no retira el tier que ya no se respalda | ✅ cerrado (ver §0) |
| R12 | P2 | Ciclo de vida del conflicto: no se cierra si operaciones CANCELA la suscripción; uno `ENTREGADA` no se reabre si reaparece | ✅ cerrado (ver §0) |
| R13 | P2 | `activatePlan` recuperado en `past_due` cae a `input.tier`; `payNow` sale del reintento | ✅ cerrado (ver §0) |
| R14 | P2 | `customer.deleted` apaga TODAS las funciones del venue, incluida una cortesía válida (stripe.webhook.service ~1097) | ✅ cerrado (ver §0) |

Codex NO encontró auto-bloqueo en `runAuditedPlanMutation` ni `assignCompPlan`. C1, C9, C13, C14, C15 los dio por cerrados.

---

## 6. Receta exacta de lo que sigue (regresiones — hazlas ya, con TDD y sabotaje)

**R4 — propietario del lease** (`src/services/onboarding/planActivation.service.ts`):
- Línea ~532: `const nuestroLease = new Date(now.getTime() + LEASE_MS)` → calcúlalo con `Date.now()` en ese momento (el
  `now` se capturó antes de varias llamadas externas y puede nacer casi vencido). Deja `now` para lo demás.
- `soltarLease` (~403, llamada en ~640, ~740, ~777): añade el parámetro `lease: Date` y ponlo en el `where`
  (`planActivationLeaseUntil: lease`).
- Paso a `DECLINED` (~745): `where` con `planActivationLeaseUntil: nuestroLease`; y **sólo si `count === 1`** llama a
  `liberarLugar` (liberar el cupo y acreditar la propiedad deben ir juntos).
- Cierre `ACTIVE` (~831): `where` con `planActivationLeaseUntil: nuestroLease` (ya comprueba `cerrado.count`).
- Pruebas en `tests/unit/services/onboarding/planActivation.service.test.ts`: que cada `updateMany` lleve el lease en el
  `where`, y que un `DECLINED` con `count: 0` NO libere el lugar.

**R7 — el 202 sólo cuando de verdad pudo haberse enviado** (`venueFeature.dashboard.controller.ts` `cambiarDePlanPorLaRegla`
~528 y `stripe.service.ts` `updateSubscriptionPrice` ~1919):
- `updateSubscriptionPrice(subscriptionId, newPriceId, opciones?: { antesDeEnviar?: () => void; planOrigen?: string })`:
  llama `opciones?.antesDeEnviar?.()` **justo antes** de `stripe.subscriptions.update` (no antes del `retrieve`).
- En el controlador: el callback ya no pone `enviado = true`; lo pasa como `antesDeEnviar: () => { enviado = true }`.
- En el `catch`: un rechazo DEFINITIVO de Stripe (`error.type` en `StripeInvalidRequestError`, `StripeCardError`,
  `StripePermissionError`, `StripeAuthenticationError`) ⇒ se relanza (error normal, no 202). Todo lo demás tras enviar ⇒ 202.
- Único otro llamador: la línea ~464 del mismo controlador (camino viejo de suelta, hoy cerrado) — el parámetro es opcional.
- Pruebas: `tests/unit/controllers/dashboard/cambioDePlanConvergente.test.ts` (ya tiene el `it.each` de C3; añade «falla el
  retrieve ⇒ error, no 202» y «StripeInvalidRequestError en el POST ⇒ error, no 202») y
  `tests/unit/services/stripe.updateSubscriptionPrice.test.ts` (el hook se llama después del retrieve y antes del update).

**R9 — validar la forma antes de cambiar** (`updateSubscriptionPrice`):
- Tras el `retrieve`: si `items.has_more` o `items.data.length !== 1` ⇒ `AppError(…, 409, true, 'CAMBIO_AMBIGUO')` sin
  tocar nada («Tu suscripción tiene más de un concepto; escríbenos para cambiar de plan»).
- Si viene `planOrigen`, exige `await suscripcionVendeElPlan(itemsDeSuscripcion(subscription), planOrigen)`; si no ⇒ el
  mismo 409. El controlador pasa `planOrigen: deCodigo`.
- Pruebas en `stripe.updateSubscriptionPrice.test.ts`: dos ítems ⇒ 409 sin `update`; `has_more` ⇒ 409; un ítem que ya no
  es el plan de origen ⇒ 409.

**R8 (barato, va con esto)**: en `inventarioDeObligaciones.ts` ~114, revisa `aTiempo()` dentro del `autoPagingEach`
(o pagina a mano con `aTiempo()` antes de cada página).

**Sabotajes pendientes**: R3 (quita la condición del lease ⇒ debe caer la prueba «vencido/sin lease»), R6 (quita
`esDelNegocio` ⇒ caen las 2 de pertenencia; quita el candado operativo ⇒ cae la de ADMIN_SUSPENDED), y uno por R4, R7,
R9. Método probado: copia el archivo a `~/.claude/jobs/<job>/tmp/`, sabotea con un script de python (no `sed` con
comillas complicadas), corre la suite, restaura con `cp` y confirma con `cmp`. Nunca dejes un sabotaje en el árbol
compartido: otra sesión puede commitearlo.

---

## 7. Verificación

**Último estado medido:**
- Suites del área (corridas directas): **106 suites / 1 197 pruebas en verde** antes de R3/R6; después: webhooks 95/95,
  fulfill 46/46, completeV2 41/41, alta 229/229.
- Typecheck del CI (`npm run typecheck`, incluye pruebas): la última corrida completa (`run-avoqado-server.vIHllh`) dio
  7 errores, local = Alienware. **5 eran míos y ya están arreglados** (tipo de `tierDe` → usa `paidTier`; `conflictsWith?`).
  **2 son AJENOS** (otra sesión, «ninguna terminal muerta»): `src/services/terminal-payment.service.ts:6261` (TS2339
  `operatorResolution`) y `src/services/tpv/no-instrument-resolution.service.ts:213` (TS2741 `previousRequest`). No los toques.
- 🟢 **Re-corrida del typecheck YA CON los arreglos de R3/R6 y de tipos** (`run-avoqado-server.go4Y4z`, 22-sep 11:4x):
  **ninguno de mis 5 errores aparece en ningún lado** — el local terminó en `errores TS: 0` (420 s) compilando todo.
- ⚠️ **PERO esa corrida salió `DIFIEREN`, por los DOS errores AJENOS**: el local dio 0 y el Alienware dio esos 2
  (`terminal-payment.service.ts:6261`, `no-instrument-resolution.service.ts:213`). Comprobado en el snapshot congelado
  de esa misma corrida: `prisma/schema.prisma` SÍ trae `operatorResolution` y el código SÍ define `previousRequest`, así
  que es la firma ya documentada en el `CLAUDE.md` del workspace («el remoto se queja de un campo de Prisma que sí
  existe y el local está limpio ⇒ gana el local, NO se planta `forzar-dual`, y se reporta»). La bandera `forzar-dual`
  ya estaba puesta desde el 10-sep por otra divergencia; esta corrida no cambió eso.
  🔴 **No es de V5-A**: los dos archivos son de la sesión de «ninguna terminal muerta». Al retomar, vuelve a correr el
  typecheck y, si el síntoma sigue, repórtaselo al founder como posible hueco del puente (no lo arregles tú).

**Comandos (desde la RAÍZ del workspace; lee el CUERPO, no el exit code):**
```bash
AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-server npm run typecheck
AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --testPathPattern "stripe\.|access/|planActivation|completeV2|cambioDePlan|planState|superadmin|feature\.|planAccessReconciliation|cambioDeSuscripcion" --ci
# un solo archivo se puede correr directo:
cd avoqado-server && npx jest --selectProjects unit --testPathPattern "<archivo>" --ci
```
- Está puesta la bandera `~/.claude/avq-verify/forzar-dual` (corre en los dos lados). No la quites sin investigar.
- Ideal antes del commit: los 4 shards de la suite unitaria (`--shard=N/4 --maxWorkers=2`) por avq-verify.
- Después: ronda 3 de Codex (§9) y, si aprueba, `/full-testing`.

---

## 8. La decisión que hay que llevarle al founder (UNA pregunta, con diagrama)

El patrón que ya vivió el 20-sep se está repitiendo: cada ronda de Codex encuentra más (pasos 2-5: 8 · paso 6 ronda 1:
15 · ronda 2: 14), y en cada ronda algunos hallazgos los abren mis propios arreglos. El 20-sep el founder decidió
«parar aquí y subir lo arreglado» por esa misma razón.

Opciones a presentarle (analogía: «tapar goteras vs. cambiar el techo»):
- **A · Seguir ronda tras ronda** hasta que Codex apruebe: cierra también R2, R5, R8, R10–R14. Más seguro, pero sin fecha:
  R5 es diseño nuevo (cambio pendiente persistido) y R11–R13 tocan la entrega otra vez.
- **B · Cerrar sólo las regresiones (R3, R4, R6, R7, R9, R8) y commitear**: el árbol queda estrictamente mejor que
  producción (que tiene R2/R10/R14 y los defectos originales). Los preexistentes quedan en una lista con dueño.
  Codex ronda 3 acotada a «¿los arreglos abrieron algo?».
- Recomendación sugerida: **B**, con R2 incluido si es barato (es el único P1 preexistente que deja dos planes activos
  por un clic de superadmin).

Otras decisiones del founder que siguen abiertas: configuración del Billing Portal de Stripe (id), fase 1 del plan
(editor en superadmin vs. registro en código — recomendado registro), permiso para medir en Stripe de prueba (prorrateo),
precios de la fase 3, y confirmar que `OPS_ALERT_EMAIL` está en Render (sin él, el aviso de conflicto sólo va al log).

**Cómo hablarle:** explícale fácil, analogía primero, diagrama si son dos caminos, una pregunta a la vez, y **cierra
SIEMPRE con 2-3 líneas en lenguaje llano** (qué pasó · qué significa para él · qué necesitas de él). Rutas absolutas.

---

## 9. Plantilla para la ronda 3 de Codex

Se lanza así (desde `avoqado-server`, en segundo plano, con `< /dev/null` o se cuelga):
```bash
codex exec -m gpt-6-astra -c model_reasoning_effort=xhigh -s read-only -C "$PWD" "$(cat <prompt>.md)" < /dev/null > <salida>.txt 2>&1
```
El veredicto está al FINAL del archivo (después de la última línea `tokens used`); `codex exec` sale 0 aunque rechace.
Encargo sugerido: el mismo formato del de la ronda 2 (read-only, español, «no Redis», qué cambió archivo por archivo, qué
atacar, «sé exhaustivo en UNA pasada», cierre con AUTORIZADO / AUTORIZADO CON CAMBIOS / RECHAZADO), listando R1–R14 con su
estado y pidiendo explícitamente: «¿alguno de estos arreglos abrió un defecto nuevo?».

---

## 10. Trampas ya pagadas en este proyecto

- Los mocks de módulo con **lista fija** (`jest.mock('…/conflictosDeObligacion.service', () => ({ … }))`) pierden las
  funciones nuevas: al añadir una exportación, agrégala a TODOS los mocks que la cubren (fulfillPlanCheckout,
  autorizarObligacionNueva, …) o la prueba truena con «is not a function».
- El `prismaMock` global es una lista manual (`createMockModel()`) en `tests/__helpers__/setup.ts`: un modelo nuevo va ahí.
- `logAction` está mockeado globalmente en las pruebas.
- Un P2002 atrapado dentro de una tx de Postgres la deja ABORTADA: usa `createMany`+`skipDuplicates` o relanza para reintentar.
- zsh no parte variables en palabras: usa `xargs < archivo` o `--pathspec-from-file`.
- Un sabotaje que «no cae» puede ser una prueba que no aísla lo que dice probar: investígalo, no lo des por defensa en profundidad.
- `npx tsc` a mano no: el typecheck va por avq-verify (pide 8 GB).
- Los tests del alta legacy: los mocks de `createPlanSubscription` deben llamar `a.antesDeCobrar?.()` antes de lanzar.
