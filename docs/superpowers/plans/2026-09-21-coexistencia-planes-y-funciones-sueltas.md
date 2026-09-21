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

1. **Solapes al subir de plan:** ¿cancelar la suelta y acreditar la diferencia (lo que proponía el
   spec de junio), o dejar las dos cobrando?
2. **Los 5 precios que un PRO ya tiene gratis:** ¿suben por encima del plan, se sacan del catálogo,
   o se mueven a PREMIUM_ONLY?
3. **`CHATBOT` a $199 siendo gratis para todos:** ¿se retira del catálogo o deja de ser Free?
4. **Solapes que ya existan en producción** (sin medir todavía: hace falta lectura de prod).
