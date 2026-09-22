# Coexistencia: planes por tier ↔ funciones sueltas (à-la-carte)

**Origen:** el founder quiere reactivar la venta por funcionalidad conviviendo con los planes
(21-sep-2026). Pregunta literal: *«¿va a haber conflictos ahora que lo vamos a volver a activar
coexistiendo con plan tier?»*
**Auditoría:** Codex gpt-6-astra xhigh sobre `develop`, 10 hallazgos (8 P1), ejecutando las
funciones reales con Prisma y Stripe simulados. Evidencia completa en la bitácora de la sesión.
**Repos:** server · web-dashboard · MCP.

## 🔑 Lo que más se malentiende

**No son dos sistemas.** Los planes son filas de la MISMA tabla `Feature` (`PLAN_PRO`,
`PLAN_PREMIUM`), con su precio y su suscripción de Stripe, igual que lealtad o inventario. Por eso
coexisten sin rediseño: `venueHasFeatureAccess()` ya resuelve **la compra suelta ANTES que el
plan**, que es justo lo que se quiere («comprar sólo inventario sin contratar Pro»).

**Lo que falta no es arquitectura: es que COBRAR y DAR ACCESO coincidan.** Hoy el sistema une los
accesos correctamente y no reconcilia los cobros.

## Los conflictos, en dos familias

### A. De negocio — el catálogo compite contra sí mismo

Medido el 21-sep: **5 de las 7 funciones con precio son gratis para un PRO**.

| Función | Precio suelto | Qué pasa hoy |
|---|---|---|
| `LOYALTY_PROGRAM` | $599 | un PRO ($999) ya la tiene gratis |
| `REFERRAL_PROGRAM` | $299 | un PRO ya la tiene gratis |
| `ONLINE_ORDERING` | $99 | un PRO ya la tiene gratis |
| `CHATBOT` | $199 | está en `FREE_TIER_CODES`: **gratis para todos** |
| `INVENTORY_TRACKING` | $89 | correcto — es PREMIUM_ONLY |
| `AVAILABLE_BALANCE` · `CASH_RECONCILIATION` | $0 | sin precio real |

Y **17 de los 21 códigos que se usan para gatear no tienen fila en `Feature`**: no se pueden
vender sueltos aunque el motor lo permita.

🔴 **La regla que debe cumplirse siempre: armar a la carta tiene que salir MÁS CARO que el plan
que incluye lo mismo.** Si no, el plan deja de venderse solo.

### B. Técnicos — los 10 hallazgos de Codex

| # | Sev | Qué pasa | Dónde |
|---|---|---|---|
| 1 | P1 💰 | **Subir de plan deja cobrando las sueltas que el plan ya incluye.** La cotización y el cambio miran sólo la suscripción elegida | `venueFeature.dashboard.controller.ts:288,391` · `stripe.service.ts:1125` |
| 2 | P1 💰 | Dos compras concurrentes crean **dos suscripciones de Stripe** del mismo código; `subscriptions.create()` va sin `idempotencyKey` | `stripe.service.ts:308,446,499` |
| 3 | P1 💰 | **Se puede contratar `PLAN_PREMIUM` por la ruta de sueltas**, saltándose el guard del checkout; y `updateSubscription` convierte `PLAN_PRO → LOYALTY_PROGRAM` (reproducido, 200) | `venueFeature.dashboard.service.ts:65` · `controller:359` |
| 4 | P1 🔒 | **Una suelta con trial vencido y `active:true` da 403 aunque el plan PREMIUM la cubra** — el middleware no usa el resolver canónico | `checkFeatureAccess.middleware.ts:111,149,169` |
| 5 | P2 | Poner precio a una función nueva **no decide quién la paga**: PRO se lleva todo lo que no esté en `PREMIUM_ONLY_CODES` | `basePlan.service.ts:243` |
| 6 | P1 💰 | **Cancelar responde «éxito» aunque Stripe siga cobrando**: el fallo se captura y se escribe `active:false` igual | `venueFeature.dashboard.service.ts:229,242` |
| 7 | P1 💰 | Recomprar una suelta `past_due` **sobrescribe** una recuperación ya procesada (upsert sin CAS) | `stripe.service.ts:331,497` |
| 8 | P1 💰 | **El comprador se elige hasta 365 días gratis**: `trialPeriodDays` viene del body | `venue.schema.ts:179` |
| 9 | P1 💰 | Un **MANAGER** cambia una suscripción: el PUT exige `features:write`, no `billing:subscriptions:manage` | `dashboard.routes.ts:3101` |
| 10 | P1 🔒 | **Un empleado ve paywall sobre una suelta YA pagada**: las compras viven tras `billing:subscriptions:read` y el hook cae a FREE | `dashboard.routes.ts:2650` · `use-tier-feature-access.ts:67` |

**Tabla de transiciones, medida:**

| Transición | Acceso | Cobro |
|---|---|---|
| Subir a PRO / PREMIUM | conserva | 🔴 la suelta se sigue cobrando aunque el plan la incluya |
| Bajar PREMIUM → PRO | conserva | sigue su cobro independiente |
| Cancelar o suspender el plan | conserva por compra propia ✅ | sigue su cobro independiente |

No existe revocación general de sueltas al cancelar el plan, y eso es correcto.

🔑 **Esto ya era una decisión pendiente del founder, no un bug nuevo.** El spec
`2026-06-02-venue-base-subscription-design.md:439` lo dejó escrito: *«si sube a un tier que lo
incluye, ¿cancelamos la suelta o dejamos las dos? Probablemente: cancelar la agrupada y acreditar
la diferencia»*, con la nota «resolver cuando lleguemos ahí». Ya llegamos.

## Plan por fases

| # | Fase | Repos | Por qué en ese orden |
|---|---|---|---|
| 0 | **Cerrar lo explotable HOY** — #3 (excluir `PLAN_*` de la ruta de sueltas y prohibir cruces plan↔suelta), #8 (el trial lo decide el servidor), #9 (exigir `billing:subscriptions:manage`), #6 (no mentir al cancelar) | server | No dependen de ninguna decisión y hoy están abiertos. #3 y #8 los puede usar cualquiera con permiso de compra |
| 1 | **El plan pasa a ser DATO** — tabla `PlanFeatureGrant(tier, featureCode)` única por ambos; poblarla con las inclusiones de **TODOS los códigos desplegados** (21), no sólo los 7 del catálogo; los lectores (resolver, batch, middleware, payloads) consultan esa política. Sin inclusión declarada ⇒ ningún plan la concede | server | Es lo que permite mover una función de plan sin programar. Y quita el default permisivo que regala lo nuevo |
| 2 | **Reconciliar plan ↔ suelta** — la cotización de subir de plan incluye las sueltas absorbidas; al quedar efectivo el plan, se cancelan con crédito, de forma reintentable. Parche inicial: bloquear la transición con solape y resolver por soporte | server | Cierra #1. La maquinaria ya existe: `cancelSubscription` + `proration_behavior:'always_invoice'` |
| 3 | **Precios** — cargar los 17 códigos que faltan y corregir los 5 que hoy un PRO tiene gratis, con la regla «a la carta > plan» comprobada por prueba | datos · server | Es lo que hace vendible el modelo. Cada precio se propone con lo que cobra el mercado (regla nueva del `CLAUDE.md`) |
| 4 | **Que el paywall vea lo pagado** — #10 y #4: exponer los códigos concedidos en `/plan-tier` (abierto a `features:read`, sin filtrar precios) y que el middleware use el resolver canónico | server · dashboard | Sin esto, un empleado ve «contrátala» sobre algo que el negocio ya pagó |
| 5 | Guía de cliente · presentación de ventas · esta tabla | HQ · workspace | Regla del workspace |

🔴 **La fase 3 no se suelta sin la 1**: poner precio a una función que PRO ya regala no la vuelve
vendible.

🔴 **No migrar cancelando suscripciones existentes junto con el cambio de datos** (Codex): primero
se identifican los solapes reales en producción y su tratamiento económico.

## Decisiones que necesita el founder

~~1. **Solapes al subir de plan**~~ → 🟢 **DECIDIDO por el founder (21-sep): opción A, «como lo
   hace Claude».** Al subir de plan a mitad de ciclo se **cancela la suelta absorbida, se acreditan
   los días no usados y se cobra la diferencia** — nunca el plan completo tirando lo ya pagado.
   Sus palabras: *«si tengo una suscripción de Max de $100 y quiero aumentar a $200, me descuentan
   al mes corriente lo que llevo»*. Ejemplo con los precios reales, subiendo el día 15 de 30:
   inventario $89 → crédito $44.50 · Premium $1,699 → $849.50 por esos días · **cobro hoy: $805**.
   🔑 El mecanismo ya existe (`proration_behavior: 'always_invoice'`, el mismo del cambio de plan).
   Lo que falta NO es el descuento: es que la cotización y la ejecución **miren también las sueltas
   que el plan absorbe** — hoy son dos suscripciones distintas que nadie relacionó.
2. **Los 5 precios que un PRO ya tiene gratis:** ¿suben por encima del plan, se sacan del catálogo,
   o se mueven a PREMIUM_ONLY?
3. **`CHATBOT` a $199 siendo gratis para todos:** ¿se retira del catálogo o deja de ser Free?
4. **Solapes que ya existan en producción** (sin medir todavía: hace falta lectura de prod).

## Estado (21-sep-2026, tarde)

| # | Hallazgo | Estado | Dónde |
|---|---|---|---|
| 3 | Plan contratable por la puerta de sueltas | 🟢 cerrado (TDD) | `addFeaturesToVenue` rechaza `PLAN_*` antes de tocar base o Stripe |
| 8 | Trial de 0-365 días elegido por el cliente | 🟢 cerrado (TDD) | `TRIAL_ALA_CARTE_DIAS = 5`; el campo del body se acepta y se ignora |
| 9 | MANAGER cambia una suscripción | 🟢 cerrado (TDD) | el PUT exige `billing:subscriptions:manage` |
| 6 | Cancelar responde éxito con Stripe caído | 🟢 cerrado (TDD) | sólo sigue si `stripeAfirmaQueNoExiste`; cualquier otro fallo detiene la baja |
| 4 | El portero niega lo que el plan cubre | 🟢 cerrado (TDD) | el middleware consulta `elPlanConcede` antes de negar por caducidad o suspensión |
| 1 | Subir de plan cobra la suelta absorbida | 🟡 **piezas hechas, sin enchufar** | `sueltasAbsorbidasPorElPlan` (pura) + `sueltasQueAbsorbeElPlan` (lectura). Falta la cotización y la cancelación con crédito |
| 2 | Dos compras concurrentes = dos suscripciones | ⬜ | |
| 7 | Recomprar `past_due` pisa una recuperación | ⬜ | |
| 5 | El plan vive en código | ⬜ fase 1 | `elPlanConcede` ya es el punto único al que migrarán los otros dos sitios |
| 10 | Empleado ve paywall sobre lo pagado | ⬜ fase 4 | 🔑 hallazgo nuevo: la ruta abierta (`features:read`) **existe y está tapada** por la de facturación, registrada antes en `dashboard.routes.ts` |

🔴 **Por qué el #1 no se enchufó en esta sesión:** conectar la cancelación automática es tocar el
carril de suscripciones que acaba de pasar 22 rondas de auditoría. Las dos piezas son puras o de
sólo lectura y están probadas; el enganche merece su propia auditoría de Codex antes de mover dinero.

Pruebas nuevas: `tests/unit/services/venueFeature.alaCarte.test.ts` (9) · `venueFeature.absorcion.test.ts` (6) ·
`basePlan.sueltasAbsorbidas.test.ts` (7) · `tests/unit/routes/venueFeatureSubscription.permissions.test.ts` (3) ·
`tests/unit/middlewares/checkFeatureAccess.planCubre.test.ts` (4). Vecinas: 56 suites / 740 y 52 / 583 en verde.

## Ronda 2 (21-sep, noche) — dos rechazos de Codex y una aprobación

Codex auditó la fase 0 en dos pasadas y RECHAZÓ: 3 P1 + 5 P2. Todos cerrados con TDD y la tercera pasada
dio **AUTORIZADO** con los 8 cerrados y ningún hallazgo nuevo.

| Hallazgo | Arreglo |
|---|---|
| P1 · el 2º reintento de `activate-plan` volvía a cobrar (la regla comparaba el LEASE, que se renueva) | `buscarSuscripcionDelIntento` recorre TODAS las suscripciones del cliente, sin ventana; tope 1000 ⇒ 503 |
| P1 · el PUT seguía convirtiendo plan↔suelta | `cruzaPlanYSuelta` en cotizar y cambiar, 400 `PLAN_CROSSING_NOT_ALLOWED` antes de Stripe |
| P1 · el portero negaba CHATBOT con una fila vieja | delega en `venueHasFeatureAccess`; la prueba usa el resolver REAL |
| P2 · la absorción descartaba sueltas suspendidas que siguen cobrando | candidatas = ligadas a Stripe o con acceso; el ejecutor verifica en Stripe |
| P2 · cancelar con Stripe caído daba 400 y podía trabarse | consulta `estadoDeLaSuscripcion`; `canceled` ⇒ completa la baja; si no, 503 `SUBSCRIPTION_CANCEL_PENDING` |
| P2 · el cartel ofrecía «$0», «+ IVA» en la suelta y el botón a quien sólo lee | precio sólo con `stripePriceId`; «+ IVA» sólo en planes; botón con `billing:subscriptions:manage` |

🔑 La salvedad que dejó Codex sobre el doble cobro: la etiqueta `metadata.planActivationKey` la estampa todo
`activate-plan` desde `b1b57c43`, pero **el onboarding legacy y el Checkout no la ponen**. No son parte de
este protocolo de recuperación, así que no reabre el hueco; no se inspeccionaron suscripciones de producción.
