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

## Fase 1 — diseño v1 (21-sep, noche): «qué plan incluye cada función» pasa a ser dato

**Qué se resuelve:** hoy la regla «FREE ⊂ PRO ⊂ PREMIUM, y PRO se lleva todo lo que no esté en
`PREMIUM_ONLY_CODES`» vive escrita **cinco veces en el servidor** y una en el dashboard:

| Copia | Dónde |
|---|---|
| resolver individual | `basePlan.service.ts` `venueHasFeatureAccess` |
| resolver por lote | `basePlan.service.ts` `venuesWithFeatureAccess` |
| predicado puro | `basePlan.service.ts` `elPlanConcede` (lo usan absorción y el portero) |
| portero, 2 sitios | `checkFeatureAccess.middleware.ts` ~:118 y ~:513 |
| payload del dashboard | `venueFeature.dashboard.service.ts` `tierGrants` ~:446 |
| metadata de funciones | `access/feature-metadata.service.ts` `tierGrants` ~:127 |
| espejo ESTÁTICO | dashboard `src/config/plan-catalog.ts` `getTierForFeature` (FeatureGate, sidebar, `use-tier-feature-access`) |

Mover una función de plan exige hoy editar esas siete, y si una se olvida la plataforma contesta
distinto según quién pregunte (familia `una-regla-copiada-en-n-sitios`).

### Modelo

- **Nivel mínimo, no pares (tier, código).** `FeatureInclusion { featureCode String @id, minTier
  FeatureInclusionTier, updatedAt @updatedAt, updatedByStaffId String? }` con
  `enum FeatureInclusionTier { FREE PRO PREMIUM NONE }`. Un nivel mínimo hace **imposible por
  construcción** que PREMIUM tenga menos que PRO; una tabla de pares lo permitiría. `NONE` = ningún
  plan la incluye (sólo se vende suelta). Tabla aparte de `Feature` porque 17 de los ~28 códigos que
  gatean no tienen fila en `Feature`, y crearles una los metería al catálogo vendible.
- **La tabla guarda sólo las EXCEPCIONES que decide el founder.** El valor por defecto de cada código
  vive en código (`INCLUSION_POR_DEFECTO`), derivado de las listas actuales: `FREE_TIER_CODES` →
  FREE, `PREMIUM_ONLY_CODES` → PREMIUM, el resto de los códigos conocidos → PRO. **Al desplegar, la
  tabla está vacía y el comportamiento es idéntico al de hoy**: no hay migración de datos.
- **Código no declarado ⇒ PRO (la regla de hoy) + `logger.warn` una vez por código.** Cambiarlo a
  «nadie» (modo estricto) quitaría acceso a clientes que pagan si alguien olvidó declarar un código;
  es decisión del founder, no de esta fase. Lo que cierra #5 es una **prueba de arquitectura** que
  recorre `src/` buscando literales en `checkFeatureAccess('X')` / `venueHasFeatureAccess(…, 'X')` /
  `venuesWithFeatureAccess(…, 'X')` y falla si `X` no está en `INCLUSION_POR_DEFECTO`: quien agrega
  una función nueva tiene que decidir su plan en el mismo cambio.

### Un solo lector

`src/services/access/planPolicy.ts`:

- `concede(tier: BaseTier | null, code, politica): boolean` — PURA. Códigos de plan → false; FREE →
  true; NONE → false; PRO → tier PRO o PREMIUM; PREMIUM → sólo PREMIUM.
- `obtenerPolitica(): Promise<Politica>` — lee **todas** las filas (`take: 500`, la tabla tiene
  ~30) y las cachea en memoria **60 s**. Si la base falla: sirve la última foto buena; si nunca hubo
  una, la política por defecto. **Nunca lanza**: el portero no puede ganar un modo de fallo nuevo.
  Tras escribir se invalida la caché local; las otras instancias de Render tardan ≤60 s.
- Los siete lectores pasan a llamar a `concede` con la foto. `elPlanConcede(tier, code)` se conserva
  como envoltura sobre la política por defecto para no romper firmas; `sueltasAbsorbidasPorElPlan`
  recibe la política.
- `PREMIUM_ONLY_CODES` y `FREE_TIER_CODES` **se conservan** como la definición de los valores por
  defecto (tienen los comentarios que explican cada decisión y pruebas que las anclan).

### Quién la cambia (el switch NO vive sólo en la base)

- **Superadmin** (`avoqado-superadmin`, pantalla nueva «Planes»): lista cada código con su nivel
  efectivo, de dónde sale (defecto · decidido) y su precio suelto si lo tiene.
- `GET /api/v1/superadmin/plan-policy` y `PUT /api/v1/superadmin/plan-policy/:code { minTier }`,
  montadas bajo `superadmin.routes.ts` (el padre ya exige SUPERADMIN).
- 🔴 **Dos pasos, como el MCP:** el PUT sin `confirm` devuelve el IMPACTO — cuántos venues ganan y
  cuántos PIERDEN la función (conteo por `VenueFeature` activo de `PLAN_PRO`/`PLAN_PREMIUM`, sin
  contar los exentos ni los que la compraron suelta) — y sólo con `confirm: true` escribe. Subir una
  función de PRO a PREMIUM se la quita a clientes que ya la usan: eso no puede pasar de un clic.
- `ActivityLog` `PLAN_POLICY_UPDATED` con `{ code, antes, después, venuesQueGanan, venuesQuePierden }`.
- **Customer MCP: sólo lectura, sin escritura.** Es configuración de la plataforma, no del negocio.

### Lo que ve el dashboard

- `GET /venues/:venueId/plan-tier` agrega `includedFrom: Record<code, 'FREE'|'PRO'|'PREMIUM'|'NONE'>`
  (~30 entradas, opcional: los clientes viejos lo ignoran).
- `getTierForFeature(code)` usa ese mapa cuando llega y cae al espejo estático cuando no.

### Declarado fuera de esta fase

- **Grandfathering al subir una función de plan:** hoy se le quita a quien la tenía por su plan. El
  aviso de impacto lo hace visible; conservárselo a los actuales es decisión del founder.
- **La copia comercial no se mueve sola:** landing, presentación de ventas, guía `avoqado_help` y
  las tarjetas de plan (`featureKeys`) dicen qué incluye cada plan con texto fijo. Mover una función
  en la pantalla deja esos textos viejos: la pantalla lo recuerda después de confirmar.
- **Precios (fase 3):** la pantalla muestra el precio suelto, no lo edita.

### 🔴 Veredicto de Codex sobre el diseño v1: RECHAZADO (6 P1 · 5 P2)

El «dato editable» no es una tabla y una pantalla: es un contrato entre SEIS lectores.

| # | Sev | Lo que el v1 no resolvía |
|---|---|---|
| 1 | P1 | La cotización y el cambio de plan pueden leer políticas distintas (caché por instancia): el cliente acepta un importe y se ejecuta otro. Hace falta una **revisión de política** ligada a la cotización |
| 2 | P1 | «Nunca lanza» convierte una caída de base en una decisión comercial falsa (`AUTO_REORDER=NONE` vuelve a PREMIUM en una instancia recién arrancada). Y en el replay offline un `FEATURE_LOCKED` por política desconocida mata el intento: debe ser `RETRY` |
| 3 | P1 | **Mover una función de plan crea solapes sin que nadie cambie de plan**: un PRO que paga inventario suelto queda pagando doble si inventario baja a PRO — y el conteo de impacto lo excluía |
| 4 | P1 | **TPV, Android e iOS tienen su propia copia** de qué incluye cada plan (`VenuePlanInfo.kt:67`, `PlanManager.kt:79`, `PlanManager.swift:85`) |
| 5 | P1 | `NONE` no cabe en el `TierId` del dashboard (`?? 'PRO'`, índice −1) |
| 6 | P1 | El preview omitía a los venues sin plan (CHATBOT FREE→PRO) y `confirm:true` no ata la aprobación a lo visto |
| 7-11 | P2 | La equivalencia «tabla vacía = hoy» tiene un contraejemplo (`SCALE_INTEGRATION`); la prueba por literales no ve gates con constantes; `minTier` no describe módulos (COMMISSIONS dual, SERIALIZED_INVENTORY); `autoReorder.service.ts:512` exige PREMIUM a mano; `take:500` trunca en silencio |

🟡 **DECISIÓN DEL FOUNDER PENDIENTE — la fase 1 NO se construye hasta que la tome:**

| Opción | Qué es | Costo |
|---|---|---|
| **A · Editor en superadmin** | el founder mueve funciones de plan con un clic | 6 repos (server · dashboard · superadmin · tpv · android · ios), política versionada, releases de las 3 apps |
| **B · Registro único en código** (recomendada) | un solo archivo tipado con el nivel de cada función; mover una = cambio de 1 línea + deploy + actualizar las 3 apps | server + dashboard; cierra #5 (nada nuevo queda PRO por descarte) |

Mientras tanto: **no mover funciones de plan sin medir antes en producción quién las paga suelto** (hallazgo 3).

🔴 **Restricción del founder (21-sep): no usamos Redis.** La consistencia entre instancias que pide el hallazgo 1
(cotización y cambio leyendo la misma política) se resuelve con una revisión en Postgres, nunca con una caché compartida en Redis.

## Ronda 4 y 5 (21-sep, noche) — mis arreglos de #2, #7 y #10 abrieron defectos

Codex RECHAZÓ los cierres de #2/#7/#10 con 6 P1 + 2 P2. **Cinco de los ocho venían de mis propios arreglos.**

| R4 | Qué rompí o dejé | Ronda 5 |
|---|---|---|
| 2 | la llave derivada del vínculo (`…:none`) hacía que una recompra recibiera el cuerpo GUARDADO de una suscripción ya cancelada | llave **única por invocación** (`randomUUID`) |
| 3 | cambiar de tarjeta en un reintento daba `idempotency_error` | ídem |
| 4 | la compensación podía cancelar la suscripción que la OTRA compra ligó (las dos recibían la misma) | las compras se **serializan** con `pg_advisory_xact_lock` por (venue, función); se compensa sólo lo creado en esta llamada, y sólo si la relectura confirma que no quedó ligado |
| 5 | cancelar no devuelve un cobro hecho | se crea con `default_incomplete` y se compensa antes de intentar cobrar: no hay cargo |
| 6 | ampliar el barrido a sueltas reactivaba bajas deliberadas de superadmin | **revertido** |
| 7 | la recompra activa conservaba `suspendedAt` del ciclo anterior (previo) | al ligar una suscripción nueva o al día se limpian las banderas de cobranza |
| 8 | la caché vieja de `/features` ganaba a una denegación fresca de `/plan-tier` | `grantedFeatureCodes` es la única fuente; la clave del plan-tier cuelga de `venueFeatures` (las 16 invalidaciones la refrescan) |
| 1 | un proceso que muere entre Stripe y el commit deja una suscripción sin vínculo (previo) | ⬜ **abierto, declarado**: cerrarlo exige persistir el intento antes de crear |

**Dos candados nuevos contra el cobro doble** (sin que nadie los reportara):

- `FEATURE_INCLUDED_IN_PLAN` — no se vende suelto lo que el plan ya incluye (un PRO pagaba $599 por lealtad; CHATBOT a $199 siendo gratis).
- `PLAN_ABSORBS_ALA_CARTE` — **el parche inicial del #1**: no se sube de plan (cambio PRO↔PREMIUM ni checkout) con una suelta que el plan
  incluye y que sigue cobrando en Stripe; el mensaje dice cuál y pide escribir a soporte. Onboarding sin candado a propósito: el negocio es
  nuevo y no puede tener sueltas.

🔴 **La fase 2 completa («como lo hace Claude») sigue pendiente de medir en Stripe de prueba** cómo sale el crédito al cancelar con
prorrateo y si entra en la MISMA factura del plan (la documentación confirma que el saldo a favor se aplica antes de calcular lo que se
cobra, pero no documenta con claridad el crédito del prorrateo al cancelar). Requiere permiso del founder, como la medición 7B-2.0.

## Ronda 5 (21-sep, noche): RECHAZADO con 6 P1 + 1 P2 — y dónde se para

Codex dio por CERRADOS R4-2, R4-3, R4-5, R4-6 y R4-8 (el dashboard queda aprobado). Lo que encontró se parte en dos:

**Cerrado en la ronda 6 acotada (TDD, cada arreglo roto a propósito y cazado):**

| R5 | Qué pasaba | Arreglo |
|---|---|---|
| P2-7 | el candado se ESPERABA reteniendo conexiones del pool, y Stripe (80 s × 2 reintentos del SDK) no cabía en los 60 s de la transacción | `pg_try_advisory_xact_lock`: la segunda compra falla YA («ya hay una compra en curso»); cada llamada a Stripe dentro del candado lleva `timeout: 15 s` y `maxNetworkRetries: 0`; transacción de 90 s con el peor caso medido en ~63 s |
| P1-5 | la compensación podía releer ANTES de que el commit en vuelo terminara y cancelar una suscripción que sí quedó ligada | antes de releer vuelve a tomar el MISMO candado esperando (`lock_timeout 15 s`); si no lo logra, no cancela |
| P1-6 | si la relectura tras pagar fallaba se escribía la foto vieja (`active:false`) sobre la fila que el webhook ya activó | se aborta sin tocar el vínculo; manda el webhook |
| P1-3 | cambiar una suelta por OTRA que el plan ya incluye se cobraba aparte | `assertNoIncluidaEnElPlan` también en cotizar y cambiar suelta→suelta |

**🔴 NO se parcha — exige rediseñar la compra (decisión del founder):**

| R5 | Qué pasa |
|---|---|
| P1-1 | abrir el checkout de PREMIUM, comprar inventario suelto, y LUEGO pagar el checkout: los dos candados pasan en su momento y quedan las dos suscripciones |
| P1-2 | el onboarding SÍ puede tener sueltas: `ensureVenueForOnboarding` reutiliza un venue existente y el OWNER provisional puede comprar |
| P1-4 | un plan SUSPENDIDO que sigue `past_due` en Stripe no cuenta: se puede comprar suelto lo que ese plan cubrirá al recuperarse |
| R4-1 | Stripe crea la suscripción y se pierden TODAS las respuestas (reintentos incluidos): queda una suscripción que nadie conoce |

Los cuatro tienen la misma raíz: **no existe una OPERACIÓN DE CONTRATACIÓN persistida por negocio** que coordine planes y sueltas
antes de tocar Stripe. Es la lección del 20-sep otra vez: el carril se escribió sin control de concurrencia y cada ronda de
parches destapa la siguiente. Hoy **nadie compra funciones sueltas** y nada de esto está pusheado, así que el riesgo real es cero
mientras la venta suelta no se abra.

## Venta suelta CERRADA (decisión del founder, 21-sep: opción A, «hasta que quede todo bien hecho»)

- **Raíz:** `createTrialSubscriptions` se niega a crear si `ventaSueltaAbierta()` (`src/services/access/ventaSuelta.ts`) es `false`.
- **API:** `POST /venues/:id/features` y el cambio suelta→suelta responden 409 `ALA_CARTE_SALES_CLOSED` con «escríbenos a hola@avoqado.io».
- **Rutas legacy que vendían sueltas sin pasar por la compra** (las destapó el inventario): el alta V1 (`/onboarding`, viva: ahí manda
  `SignupForm`) y la conversión de demo. Las dos SALTAN las funciones antes de intentarlo — el respaldo del alta V1 las habría creado
  sin cobro por 5 días.
- **Dashboard:** el candado enseña el precio suelto con «escríbenos»; el paso de funciones del onboarding V1 ya no vende.
- Los planes se siguen vendiendo. Reabrir = cambiar `ventaSueltaAbierta()` (server) y `VENTA_SUELTA_ABIERTA` (dashboard) en el MISMO
  cambio que traiga el rediseño de abajo.

🔴 **De paso, un defecto de aislamiento entre negocios (objetivo, ya cerrado):** descargar o reintentar una factura NO comprobaba que
fuera del cliente de Stripe del negocio. Con el id de una factura ajena se obtenía su PDF o se cobraba a la tarjeta de otro negocio.
Ahora responde 404 `INVOICE_NOT_FOUND` (`exigirFacturaDelCliente`, prueba `stripe.facturaDeOtroNegocio.test.ts`).

## Rediseño de la compra — diseño v1: la OPERACIÓN DE CONTRATACIÓN

**Qué cierra:** P1-1 (checkout abierto + suelta en medio), P1-2 (suelta durante el onboarding), P1-4 (plan suspendido que sigue
cobrando), R4-1 (Stripe crea y se pierden todas las respuestas) y P2-7 de raíz (ninguna llamada a Stripe dentro de una transacción).
Es requisito para reabrir la venta suelta. **Sin Redis** (restricción del founder): todo en Postgres.

**Inventario de partida (21-sep):** 14 caminos crean o cambian suscripciones de un venue y **ninguno comparte candado, lease ni llave
con otro**. No existe tabla de intento de compra. El análogo más cercano es `TerminalPaymentRequest` (UNKNOWN, nunca se libera a ciegas).

### Modelo

`SubscriptionIntent { id, venueId, kind, featureCodes String[], status, stripeObjectId?, stripeCustomerId, createdByStaffId?,
expiresAt, attempts, lastError?, createdAt, updatedAt }`

- `kind`: `ALA_CARTE_ADD` · `ALA_CARTE_CHANGE` · `PLAN_CHECKOUT` · `PLAN_CHANGE` (los que se abren al rediseñar).
- `status`: `OPEN` · `UNKNOWN` · `COMPLETED` · `FAILED` · `EXPIRED`.
- 🔑 **Índice único PARCIAL `(venueId) WHERE status IN ('OPEN','UNKNOWN')`**: una sola contratación viva por negocio, entre planes y
  sueltas. Es lo que serializa sin candados largos: la segunda recibe el P2002 y responde 409 `SUBSCRIPTION_INTENT_IN_PROGRESS`
  diciendo qué está en curso.

### Protocolo (compra suelta; los demás igual)

1. **Antes de abrir** (fuera de transacción, lecturas): ¿el plan del negocio la incluye? **contando también los planes que todavía
   pueden cobrar** —vínculo a Stripe con estado distinto de `canceled`/`incomplete_expired`, aunque en local estén suspendidos (P1-4)—.
   ¿El negocio terminó su alta? Si no, 409 (P1-2: la venta suelta sólo existe para venues operativos).
2. **Transacción corta:** crear el intento `OPEN` (P2002 ⇒ 409). Nada más.
3. **Stripe, sin transacción abierta:** `idempotencyKey = subscription-intent:<id>`, `metadata.subscriptionIntentId = <id>`.
4. **Transacción corta:** CAS del vínculo en `VenueFeature` + intento `COMPLETED`.
5. **Si el desenlace de Stripe es incierto** (red, timeout, todas las respuestas perdidas): intento → `UNKNOWN`, **nunca se libera a
   ciegas**. Un barrido (cada 5 min) lista las suscripciones del cliente (la lista es consistente; la Search API no) y busca
   `metadata.subscriptionIntentId`: si la encuentra, ejecuta el paso 4; si pasados 15 min no existe, `FAILED`. Mientras siga
   `UNKNOWN`, el negocio no puede abrir otra contratación: eso es lo que evita el cobro doble (R4-1).

### Checkout de plan (P1-1)

- Crea su intento `PLAN_CHECKOUT` con `expiresAt` = el `expires_at` que se le pone a la sesión (30 min, el mínimo de Stripe; hoy no se
  pone y dura 24 h). Llave de idempotencia y `metadata.subscriptionIntentId`.
- `checkout.session.completed` ⇒ `COMPLETED`. **`checkout.session.expired` hoy no tiene handler**: se agrega ⇒ `EXPIRED`. El barrido
  vence los `OPEN` pasados de `expiresAt` consultando la sesión (patrón de los depósitos de reservación).
- Una compra suelta con un checkout de plan abierto: se **expira** esa sesión (`checkout.sessions.expire`) y se sigue, o 409 si Stripe
  no lo confirma. Así un checkout abandonado no bloquea 30 min.

### Fuera del v1, declarado

- La absorción «como lo hace Claude» (fase 2) se engancha a este mismo intento (`PLAN_CHANGE`/`PLAN_CHECKOUT` guardan qué sueltas
  absorben), pero exige medir antes en Stripe de prueba cómo entra el crédito en la factura del plan. Mientras, sigue el 409
  `PLAN_ABSORBS_ALA_CARTE`.
- La carrera `activate-plan` ↔ `completeV2Onboarding` (los dos pueden cobrar el plan del onboarding) es del carril del lanzamiento: se
  reporta, no se toca aquí.
- `grantVenuePlanTrial` (superadmin) deja huérfana una suscripción viva al borrar el vínculo; `findPlanProFeature` elige con
  `findFirst` si hay dos filas de plan. Se reportan.

### 🔴 Codex sobre el v1: RECHAZADO (7 P1 · 3 P2). Resumen de por qué

Validaba ANTES de reservar · «alta terminada» no es barrera (el onboarding la marca antes de cobrar) · «15 min sin aparecer ⇒ FAILED»
reabre R4-1 (un 500 de Stripe es indeterminado) · una ficha con UNA llave no representa varias suscripciones ni cambios de precio · los
procesos que mueren dejan `OPEN` sin dueño · los grants de superadmin y el job de cancelación borran vínculos a obligaciones vivas · los
checkouts de antes del despliegue y el Billing Portal quedan fuera del serializador · barrido sin presupuesto · sin salida visible.

## Rediseño de la compra — diseño v2

**Principios (lo que el v1 violaba):** (1) se RESERVA primero y se valida DESPUÉS, dentro de la reserva; (2) ningún estado terminal por
reloj: sólo con evidencia o con resolución humana auditada; (3) cada efecto en Stripe se persiste ANTES de mandarse, con su llave y sus
parámetros congelados; (4) una sola función de conciliación la usan la petición, el webhook y el barrido; (5) ninguna llamada a Stripe
dentro de una transacción; (6) sin Redis.

### Modelo

- **`SubscriptionIntent`** (la ficha, una por contratación): `id, venueId, kind, status, requestKey, requestFingerprint, version,
  leaseOwner?, leaseUntil?, nextCheckAt?, attempts, escalatedAt?, createdByStaffId?, createdAt, updatedAt`.
  - `status`: `OPEN` · `UNKNOWN` · `CONFLICT` · `COMPLETED` · `FAILED` · `EXPIRED`.
  - Índice único parcial `(venueId) WHERE status IN ('OPEN','UNKNOWN','CONFLICT')`: una contratación viva por negocio.
  - `@@unique([venueId, requestKey])`: la API es idempotente. Misma llave + misma huella ⇒ devuelve el intento y su resultado; otra
    huella ⇒ 409.
- **`SubscriptionIntentEffect`** (cada cosa que se le pide a Stripe): `id, intentId, seq, type, targetStripeId?, params Json
  (congelados: precio, prueba, cupón, `proration_date`, metadata), idempotencyKey @unique = subint:<intentId>:<effectId>, status,
  resultStripeIds Json?, sentAt?, resolvedAt?, lastError?`.
  - `type`: `SUBSCRIPTION_CREATE` · `SUBSCRIPTION_UPDATE` · `INVOICE_PAY` · `CHECKOUT_CREATE` · `CHECKOUT_EXPIRE` (y reservados para la
    fase 2: `SUBSCRIPTION_CANCEL`, `CREDIT`).
  - `status`: `PENDING` (nunca salió: se puede declarar no aplicado) · `SENT` · `APPLIED` · `NOT_APPLIED` (rechazo definitivo de Stripe) ·
    `UNKNOWN`.
  - Metadata en todo objeto creado: `subscriptionIntentId` y `subscriptionIntentEffectId` (en checkout, también en
    `subscription_data.metadata`).

### Protocolo

1. **Reservar** (transacción corta): insertar el intento `OPEN`. P2002 del índice parcial ⇒ 409 `SUBSCRIPTION_INTENT_IN_PROGRESS` con el
   intento en curso.
2. **Validar DENTRO de la reserva**, con lecturas frescas: plan que incluye la función contando **todos los planes que pueden cobrar**
   (tabla de abajo), sueltas absorbibles, destino, vínculos. Si falla ⇒ `FAILED` (nada salió: es evidencia suficiente).
3. **Registrar los efectos** `PENDING` con parámetros congelados (el `proration_date` se calcula UNA vez aquí).
4. **Por cada efecto:** marcar `SENT` (transacción) → llamar a Stripe con su llave y sus parámetros, fuera de transacción →
   `APPLIED` / `NOT_APPLIED` (rechazo definitivo) / `UNKNOWN` (500, red, timeout).
5. **`conciliarIntento(intentId)`**, la única función que liga: CAS del vínculo en `VenueFeature` + intento `COMPLETED` en una
   transacción corta. CAS perdido ⇒ relee: «ya quedó aplicado» (éxito) o «otro vínculo ganó» (`CONFLICT`, alerta, la reserva se queda).
   Un error tardío de la petición nunca degrada un `COMPLETED`.
6. **Algún efecto `UNKNOWN`** ⇒ intento `UNKNOWN`. La reserva se queda hasta resolverlo.

| Estado del plan ligado en Stripe | ¿Bloquea una contratación solapada? |
|---|---|
| `active`, `trialing`, `past_due`, `incomplete`, `unpaid`, `paused`, con `cancel_at_period_end` o `pause_collection` | Sí |
| `canceled`, `incomplete_expired` | No |
| Consulta fallida o estado desconocido | Sí: no se autoriza el solape |

### Recuperación (barrido cada 5 min, reclamado en Postgres)

- Lotes de 25, `nextCheckAt` con backoff, lease por fila, presupuesto de llamadas por corrida. Topar el recorrido = «no verificado», nunca
  «no existe».
- `OPEN` con lease vencido (proceso muerto): los efectos `PENDING` no salieron ⇒ se reanudan o se declaran no aplicados; los `SENT` se
  tratan como `UNKNOWN`.
- `UNKNOWN`: dentro de 24 h se reenvía la MISMA petición (misma llave, mismos parámetros); después, se busca por metadata (consulta
  directa si hay id; si no, lista paginada `status: 'all'`) y en un cambio se verifica el estado del objeto conocido. **Nunca pasa a
  `FAILED` por ausencia o por tiempo**: a los 15 min se **escala** (visible en superadmin y en el dashboard del negocio) y lo resuelve una
  persona con una acción auditada.
- **Evidencia tardía** (webhook o barrido que encuentra un objeto de un intento `FAILED`/`EXPIRED`): `CONFLICT` + alerta; nada se
  cancela solo.

### Webhooks

Todo evento con `metadata.subscriptionIntentId` de un intento no terminal llama a `conciliarIntento`, aunque todavía no exista el
vínculo en `VenueFeature`. El barrido de acceso de planes NO se amplía (repetiría R4-6).

### Checkout de plan

- Efecto `CHECKOUT_CREATE` con `expires_at` a 30 min y metadata en la sesión y en `subscription_data`.
- `expiresAt` dispara una CONSULTA, no una liberación. Sesión `expired` confirmada ⇒ `EXPIRED`. Sesión `complete` ⇒ conciliar el plan;
  la reserva se suelta sólo cuando la obligación quedó registrada.
- Handler nuevo de `checkout.session.expired`.
- Una compra suelta con un checkout abierto: efecto `CHECKOUT_EXPIRE`; si Stripe confirma `expired` se cierra ese intento y se reserva la
  compra (y se revalida); si responde `complete`, la compra se detiene.
- `fulfillPlanCheckout` con el intento local `EXPIRED`: consulta la sesión real; si hay cobro ⇒ `CONFLICT`, nunca concede ni descarta en
  silencio.

### Qué caminos entran (la frontera, sobre el inventario de 14)

| Camino | Tratamiento |
|---|---|
| Compra suelta · cambio suelta→suelta · checkout de plan · cambio plan→plan | Intento obligatorio |
| `activatePlan` y el tramo que cobra de `completeV2Onboarding` | Toman la MISMA reserva (hoy su lease es aparte) |
| Alta V1 · conversión de demo | Siguen cerradas con su propia bandera, independiente de la reapertura, hasta incorporarse |
| Fulfillment · webhooks · barrido | Continúan un intento; no crean otro |
| Grants de trial y extensión de superadmin | **R0:** no borran el vínculo a una suscripción que puede cobrar |
| Job de cancelación | **R0:** CAS contra el id que procesó |
| Cancelar al fin del periodo · reactivar · downgrade · retención · pagar factura · tarjeta · renovaciones | Fuera de la reserva de alta: actúan sobre una obligación ya identificada, y siguen contando para detectar solapes |
| Billing Portal | Configuración fija que NO permita cambiar de plan/precio (hoy no se fija ninguna; la remota no se ha verificado) |

### Despliegue

Protocolo con la venta suelta CERRADA → adoptar o expirar las sesiones de checkout abiertas de antes → verificar que no quede ninguna
sin intento → recién entonces reabrir. Esperar un plazo no sustituye comprobarlo.

### Visibilidad

Estado del intento (qué se pidió, qué se sabe, última comprobación, siguiente acción) en el dashboard de facturación y en las tools del
MCP `subscription_status` / `get_venue_plan_status` (sólo lectura, por venue, con permiso de facturación).

### Por fases

| # | Qué | Por qué en este orden |
|---|---|---|
| R0 | Grants que no borran vínculos vivos · CAS en el job de cancelación · Billing Portal con configuración fija | Son defectos de HOY, sin venta suelta |
| R1 | Modelo, protocolo, `conciliarIntento`, barrido, webhooks — sobre compra suelta y cambio plan→plan | El núcleo |
| R2 | Checkout de plan + despliegue de sesiones viejas | Cierra P1-1 |
| R3 | `activatePlan` y `completeV2` en la misma reserva | Cierra P1-2; toca el carril del lanzamiento |
| R4 | Visibilidad (dashboard, superadmin, MCP) y la resolución humana auditada | La salida de `UNKNOWN` |
| R5 | Fase 2 «como Claude» sobre efectos `SUBSCRIPTION_CANCEL`/`CREDIT` | Necesita la medición en Stripe de prueba |

### 🔴 Codex sobre el v2: RECHAZADO (7 P1 · 2 P2) — pero autoriza R0 por separado

Cerrados del v1: validar antes de reservar · onboarding (en el diseño final) · `UNKNOWN→FAILED` por tiempo · barrido sin presupuesto.
Parciales: efectos, procesos muertos, grants, portal, visibilidad. Nuevos: un lease vencido no impide que el ejecutor viejo cobre ·
falta el conjunto estable de pasos y sus dependencias · la evidencia tardía choca con el índice parcial · faltan escritores
(baja de suelta, trials locales del job, cortesía, vigencia, borrar venue) · las sesiones de portal ya emitidas · no hay barrera
entre desplegar y habilitar tráfico.

## R0 — HECHO (21-sep, sin commitear): defectos de HOY, sin venta suelta

Regla de Codex: **rechazar** (409 `LIVE_SUBSCRIPTION_LINKED`, 503 `SUBSCRIPTION_STATE_UNVERIFIED` si Stripe no contesta), nunca
«conservar el vínculo y conceder igual», nunca cancelar por debajo. Helper `suscripcionPuedeCobrar` (SI · NO · INCIERTO) +
`exigirSinObligacionViva` en `stripe.service.ts`.

| Escritor | Qué hacía | Ahora |
|---|---|---|
| `grantVenuePlanTrial` · `grantTrialForVenue` | borraban el vínculo a una suscripción que seguía cobrando | rechazan; sobre un vínculo muerto limpian con CAS |
| `deactivateVenuePlan` · `disableFeatureForVenue` (y `assignCompPlan` a FREE, que la usa) | apagaban acceso pagado | rechazan; `disableFeatureForVenue` ya no convierte el 409 en un «Failed» genérico |
| `adjustVenuePlanEndDate` | ponía vencimiento a un plan que Stripe cobra | rechaza; los trials locales se siguen ajustando |
| `deleteVenue` (TRIAL) | se llevaba vínculos a suscripciones vivas | un negocio con cliente de Stripe NO se borra (se cierra); re-comprobado con la fila bloqueada (ronda 3) |
| Job de cancelación, rama de suspendidas | limpiaba el vínculo por `id` (borraba el de una recompra) | CAS contra el id cancelado |
| Job de cancelación, rama de trials locales | apagaba por `id` (y avisaba «tu prueba terminó» a quien acababa de pagar) | CAS contra «sigue siendo trial vencido»; si no, ni lo toca ni avisa |
| `removeFeatureFromVenue` | apagaba por `id` tras cancelar | CAS contra la suscripción cancelada |
| Billing Portal (2 emisores) | sin configuración fija | mandan `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` si existe |

🔴 **Paso humano pendiente (founder), sin él el portal sigue igual:** en Stripe → Settings → Billing → Customer portal, crear una
configuración **sin «Subscription update»** (dejar tarjeta y facturas), copiar su id `bpc_…` a Render como
`STRIPE_BILLING_PORTAL_CONFIGURATION_ID` (ya declarada en `render.yaml`) y **desactivar** la configuración vieja. Las sesiones de portal
ya emitidas NO quedan neutralizadas por esto (Codex): antes de reabrir la venta suelta hay que comprobarlo.

Pruebas: `stripe.obligacionViva.test.ts` (14) · `superadmin/r0.obligacionesVivas.test.ts` (9) · `subscription-cancellation.cas.test.ts` (3)
· `stripe.portalConfiguracion.test.ts` (3) · baja con CAS en `venueFeature.alaCarte.test.ts`. Siete sabotajes, todos cazados.
Declarado sin tocar: `findPlanProFeature` elige con `findFirst` si hay dos filas de plan; `saveVenueFeatures` (ruta tapada).

## Rediseño de la compra — diseño v3 (sobre el v2; aquí sólo lo que cambia)

### 1 · Quién puede enviar: generación del lease (v2-P1-1)

- El intento lleva `leaseGeneration Int`. Reclamarlo (petición o barrido) la incrementa con CAS; el ejecutor recuerda su `g`.
- `PENDING→SENT` es un `UPDATE … WHERE id = efecto AND status = 'PENDING' AND intento.leaseGeneration = g AND intento.leaseUntil > now()`.
  Sólo con 1 fila afectada se llama a Stripe. El perdedor **no envía**.
- `PENDING→NOT_APPLIED` (recuperación) exige haber reclamado el lease primero: la generación nueva invalida el `PENDING→SENT` del
  ejecutor viejo.
- `SENT` nunca vuelve a `PENDING`. Cada `SENT` guarda `sendDeadline = sentAt + 2 min`; justo antes del `fetch` el ejecutor compara y, si
  ya pasó, **no envía** (queda `SENT`, que la recuperación trata como `UNKNOWN`). Si el commit de `SENT` es ambiguo, se relee; nunca se envía
  sin haber visto el `SENT` confirmado.

### 2 · El plan de la operación es fijo (v2-P1-2)

- Al reservar se guarda la solicitud normalizada y la **lista completa de pasos** (`seq`, tipo, parámetros congelados, `dependsOn`), en
  la MISMA transacción que crea sus efectos, con `@@unique([intentId, seq])`. Nunca se regeneran: una reanudación ejecuta los mismos.
- Un paso no corre hasta que su dependencia está `APPLIED`. El `INVOICE_PAY` congela el id de la factura en sus parámetros ANTES de
  pagarla (nunca se vuelve a leer `latest_invoice`).
- **Resultado parcial** (ej. la suscripción se creó y el cobro fue rechazado): la obligación creada SE REGISTRA en `VenueFeature` aunque
  no dé acceso (`active:false`, con su vínculo), y el intento queda `CONFLICT` con la reserva puesta. Nunca se libera como fracaso total.
- El éxito tras perder un CAS compara destino, precio y versión esperados — no sólo el id de la suscripción, que en un cambio de precio es
  el mismo antes y después.

### 3 · La evidencia tardía no choca con la reserva (v2-P1-3)

- La exclusión deja de vivir sólo en el índice parcial del intento: una fila **`VenueBillingGuard { venueId @id, version }`** se bloquea
  (`SELECT … FOR UPDATE`) en toda reserva y en todo registro de incidencia.
- **`SubscriptionIncident { id, venueId, intentId, kind, evidence Json, status OPEN|RESOLVED, resolution?, resolvedByStaffId? }`**: la
  evidencia tardía de un intento `FAILED`/`EXPIRED` se guarda aquí aunque haya otro intento vivo. Con una incidencia `OPEN` el negocio no
  puede reservar otra contratación.
- **La resolución humana exige evidencia**, por tipo: `LINK` (se adopta el objeto encontrado), `COMPENSATE` (cancelación con desenlace
  confirmado), `CLOSE_WITH_EVIDENCE` (Stripe confirma sobre el id conocido que no quedó obligación). No existe «marcar fallido para destrabar».

### 4 · Evidencia por tipo de efecto y plazo de reenvío (v2-P2-1)

| Efecto | Evidencia positiva | Reenvío |
|---|---|---|
| `SUBSCRIPTION_CREATE` | la suscripción por id, o por `metadata.subscriptionIntentEffectId` (lista completa) | misma llave y parámetros, hasta 20 h desde el PRIMER `SENT` |
| `SUBSCRIPTION_UPDATE` | los items/precio de ESA suscripción + la factura del cambio (`latest_invoice` tras el cambio, con su `proration_date`) | ídem |
| `INVOICE_PAY` | la factura congelada: `status`, `amount_paid`, cargos | ídem; un «ya pagada» no prueba que NO se pagó dos veces antes: se lee la factura |
| `CHECKOUT_CREATE` | la sesión por id | ídem |

Se busca evidencia positiva desde el primer momento, sin esperar 24 h. Pasadas las 20 h no hay reenvío automático: sólo evidencia o
incidencia. Un error del reintento nunca convierte un `UNKNOWN` en `NOT_APPLIED`.

### 5 · Escritores (v2-P1-4) y portal (v2-P1-6)

- R0 cubre ya: grants, desactivar, cortesía, vigencia, borrar venue, baja de suelta y las dos ramas del job de cancelación.
- R1 añade: `findPlanProFeature` y todo lector financiero recorren TODAS las filas de plan (no `findFirst`); `saveVenueFeatures` se retira.
- Antes de reabrir la venta suelta, una auditoría de sólo lectura sobre Stripe: suscripciones con `pending_update`, `subscription
  schedules` y sesiones de checkout que pasaron a `complete` sin obligación local registrada. Todo hallazgo ⇒ incidencia.

### 6 · Desplegar ≠ habilitar (v2-P1-7)

- Cada camino tiene su interruptor de protocolo (`OFF` = camino viejo, sin tráfico nuevo por el intento). R1–R3 se despliegan `OFF`.
- Se enciende un camino sólo cuando: la visibilidad y la resolución con evidencia (R4) ya están desplegadas, y **todos los escritores
  que compiten con él** participan o están cerrados.
- Reabrir la venta suelta exige R0–R4 completos y encendidos, la migración conciliada (checkouts viejos, portal, schedules) y ninguna
  instancia vieja capaz de escribir por el protocolo anterior.

### 7 · Fase 2 (v2-P2-2)

Sigue fuera: necesita su propio diseño económico (orden de pasos, factura que recibe el crédito, resultado parcial). Mientras, el 409
`PLAN_ABSORBS_ALA_CARTE`.

### 🔴 Codex sobre el v3 y sobre R0: los dos RECHAZADOS (ronda 3)

**Diseño v3** — cerrados: pasos estables y parciales · semántica de R0 · desplegar ≠ habilitar · fase 2 fuera. Siguen abiertos, y ya son
de fondo: (1) un emisor que confirmó `SENT` y se congela más de 24 h puede enviar después de que Stripe borró la llave — ningún chequeo
local antes del `fetch` lo impide; (2) registrar una incidencia no frena a un intento YA reservado; (3) no hay procedimiento verificable
para neutralizar sesiones viejas del portal; (4) la factura exacta de un prorrateo no se identifica con `latest_invoice` ni con
`proration_date`; (5) un `UNKNOWN` sin objeto conocido no tiene salida con evidencia; (6) retención y pagos siguen fuera de la frontera.

**Código R0 — corregido (ronda 2, sin commitear):**
- `escribirPlanSiVinculoIgual`: el `UPDATE … WHERE stripeSubscriptionId = comprobado` ES la comparación (antes: leer y escribir sin
  condición). `create` sólo si no hay fila, P2002 ⇒ 409; nunca `upsert`.
- `assignCompPlan`: valida los DOS tiers (también filas inactivas con vínculo) antes de tocar nada; el destino se activa con CAS.
- `deleteVenue`: pregunta a Stripe por el CLIENTE (todas sus suscripciones y los checkouts abiertos, recorrido completo o 503) y recorre
  TODOS los vínculos locales por páginas.
- Perder el CAS ya no manda «tu suscripción se canceló» ni registra una baja que no ocurrió (409).
- Residual declarado: entre la comprobación y el borrado alguien puede CREAR un checkout nuevo sobre el negocio que se borra (la
  exclusión compartida llega con el rediseño).

**Código R0 — ronda 3 (Codex ronda 4 lo RECHAZÓ con 2 P1 · 2 P2; corregido, sin commitear):**
- `assignCompPlan`: UNA lectura de las filas de los dos tiers; la escritura compara contra el vínculo de ESA lectura (la relectura
  dejaba pasar una suscripción ligada entre la validación y la escritura). Apagar el otro tier y activar el destino van en UNA
  transacción: si el destino choca, nada queda apagado. El destino limpia el vínculo ya comprobado como terminal y la cobranza
  (`suspendedAt`, `gracePeriodEndsAt`, `paymentFailureCount`) — si no, el `subscription.deleted` tardío de la vieja apagaba la cortesía.
  Auditoría sólo tras confirmar.
- `grantTrialForVenue`: limpia `paymentFailureCount`; el `create` concurrente (P2002) es 409, no un 500.
- `deleteVenue`: la contención que pidió Codex. **Un negocio con `stripeCustomerId` no se borra físicamente** (409
  `VENUE_HAS_BILLING_CUSTOMER`: se cierra). Dentro de la transacción de borrado se relee con `SELECT … FOR UPDATE`: el único camino que
  liga un cliente (`getOrCreateStripeCustomer`, UPDATE condicional sobre `stripeCustomerId IS NULL`) espera el candado y ya no encuentra
  el negocio. Storage y `VENUE_DELETED` pasaron a DESPUÉS de confirmar (antes se borraban los archivos aunque el borrado fallara).
  Costo medido en producción el 21-sep: **0** negocios borrables (LIVE_DEMO/TRIAL); de 106, 7 tienen cliente.
- `exigirClienteSinObligacionesVivas` retirada: sin cliente no hay a quién preguntar.
- Pruebas: `r0.obligacionesVivas.test.ts` pasa a 22 casos. Nueve sabotajes, cada uno tumba su prueba (quitar el CAS del destino, sacar
  el apagado de la transacción, auditar dentro, no limpiar el vínculo, quitar el CAS del trial local, quitar cada candado del borrado,
  borrar Storage antes). 🔑 Un primer sabotaje «no cayó» porque el `sed` pegó en el CAS de `grantTrialForVenue` (misma línea, misma
  sangría) — y destapó que ESE CAS no tenía prueba. Ya la tiene.


**Código R0 — ronda 4: Codex AUTORIZÓ CON CAMBIOS (lista cerrada de 2 P2), los dos cerrados, sin commitear:**
- *Dos cortesías simultáneas a tiers distintos* leían «no hay filas», creaban cada una su destino y ninguna apagaba la otra
  (la unicidad es por venue+feature, así que no hay P2002). Ahora, dentro de la transacción, primero
  `SELECT … FROM "Venue" … FOR UPDATE` y después se relee: si la huella de las filas del plan no es la que se validó, 409.
- *`getOrCreateStripeCustomer`* devolvía el cliente recién creado aunque el negocio se hubiera borrado en medio (el reclamo
  y la relectura no encuentran nada): el llamador seguía creando un SetupIntent para un negocio inexistente. Ahora 404
  `VENUE_NOT_FOUND`.
- 3 + 2 pruebas nuevas; sabotajes: quitar la comparación, candado después de releer, releer fuera de la transacción — cada
  uno tumba su prueba. Sin prueba de integración con dos transacciones reales (la serialización la da `FOR UPDATE`).
- Verificación del área (R0c): 194 suites / 1,782 pruebas, local = Alienware. Typecheck del CI: 1 error, AJENO
  (`tests/integration/tpv/unchargedReconciliation.integration.test.ts:776`, TS1117, de otra sesión).

**Código R0 — ronda 5 (cierre): Codex AUTORIZÓ CON CAMBIOS con UN P2, cerrado.** El 404 nuevo de
`getOrCreateStripeCustomer` se lo tragaba el `catch` del carril legacy de `completeV2Onboarding`, que respondía 201 con el
negocio borrado y marcaba la organización como terminada. Ahora `VENUE_NOT_FOUND` suelta la marca `completedAt` y se
propaga; cualquier otro tropiezo de Stripe sigue sin bloquear el alta. 2 pruebas + 2 sabotajes. **R0 queda autorizado.**

🟢 **Decisión del founder (22-sep): v4 — el cliente confirma el pago en una página de Stripe.**

## Rediseño de la compra — diseño v4 (propuesta, 21-sep): el dinero sólo se mueve en una confirmación de Stripe

**Por qué cambiar de rumbo y no parchar el v3.** Los seis hallazgos abiertos del v3 tienen la misma raíz: nuestro servidor hace
llamadas que MUEVEN dinero (`subscriptions.create`, `invoices.pay`, `subscriptions.update` con prorrateo) y sólo tiene la llave de
idempotencia de Stripe (≥24 h) para no repetirlas. Todo el aparato del v2/v3 (intentos, leases, generaciones, evidencia por efecto,
incidencias) existe para cubrir esa ventana, y Codex demostró que no la cierra (un emisor congelado envía después).

**La regla del v4:** el servidor nunca mueve dinero para comprar o cambiar de plan. Sólo crea una **confirmación alojada por Stripe**;
el cliente confirma en la página de Stripe, Stripe aplica todo de forma atómica, y nosotros damos el acceso desde el webhook (y
releyendo el objeto, cuyo id conocemos). Es el mismo camino que YA usa el checkout de plan (`createPlanCheckoutSession` +
`checkout.session.completed`), endurecido en 11 auditorías del lanzamiento.

| Acción | Confirmación | Fuente |
|---|---|---|
| Comprar una función suelta (o plan desde FREE) | Checkout Session `mode: subscription`, `customer` con la tarjeta guardada precargada, `expires_at` = 30 min | API `checkout/sessions/create` (`expires_at` «from 30 minutes to 24 hours»; con `customer`, en subscription mode «the customer's default payment method will be used») |
| Cambiar de plan (PRO↔PREMIUM) | sesión de portal con `flow_data.type = subscription_update_confirm` (un ítem, precio destino) | «Deep links in the customer portal»: Stripe muestra prorrateo y factura próxima, maneja fallos de pago y 3DS |

**Cómo cierra cada hallazgo del v3:**
1. *Emisor tardío:* crear una confirmación NO mueve dinero. Una creada tarde por un proceso congelado nunca llega a un navegador (la
   petición que la pidió ya respondió o falló), así que nadie puede confirmarla; la de Checkout además caduca sola.
2. *Incidencia vs intento reservado:* ya no hay intentos. Bajo un candado por cliente (`pg_try_advisory_xact_lock`, sin Redis):
   listar las Checkout Sessions `open` del cliente → `expire` cada una → crear la nueva. Si un `expire` falla porque la sesión ya se
   COMPLETÓ, no se crea otra: se entrega esa. Así hay como máximo UNA confirmación de compra viva por cliente.
3. *Portal viejo:* deja de ser precondición. Un cambio hecho desde cualquier portal es otra confirmación del cliente; el webhook
   traduce el estado de la suscripción a acceso. (La configuración sin «Subscription update» sigue siendo buena higiene.)
4. *Factura del prorrateo:* no hay que identificarla; el prorrateo lo calcula y cobra Stripe dentro de la confirmación. El acceso se
   deriva del estado de la suscripción, no de facturas.
5. *UNKNOWN sin objeto:* desaparece — una confirmación desconocida es inofensiva.
6. *Matriz de escritores:* lo que queda del lado del servidor es cancelar (idempotente sobre un id conocido), reintentar el pago de
   una factura existente (una factura se paga una sola vez) y ajustes de retención (fijan estado). Ninguno crea una segunda obligación.

**Lo que queda por diseñar (y auditar):** el cumplimiento de `checkout.session.completed` para funciones sueltas (idempotente por id de
sesión, CAS sobre `VenueFeature`), un barrido que recupere sesiones completadas sin webhook (`checkout.sessions.list` por cliente,
`status: complete`), qué pasa si llegan dos suscripciones vivas de la misma función por otra vía (incidencia + alerta, nunca reembolso
automático), y el onboarding del lanzamiento (tiene su propio protocolo ya auditado; se deja fuera).

**Costo para el cliente:** una pantalla más (la de Stripe, con su tarjeta ya puesta) en lugar de cobrar con un clic dentro del
dashboard. A cambio, maneja 3-D Secure (la autenticación del banco), que un cobro hecho por el servidor sin el cliente presente no
puede resolver. **Decidido por el founder el 22-sep: página de Stripe.**

**Referente (buscado en vivo el 21-sep):** así cobra Shopify las apps que los comercios contratan dentro de su panel —
`appSubscriptionCreate` devuelve un `confirmationUrl` y el comercio aprueba el cargo en una página de Shopify antes de que
empiece a cobrarse ([appSubscriptionCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/appSubscriptionCreate),
[About billing for your app](https://shopify.dev/docs/apps/launch/billing)). Es convención de producto, portable a México.

## Diseño v4 — detalle (22-sep, para auditoría)

**Inventario de lo que HOY mueve dinero de suscripciones desde el servidor** (medido con grep, 22-sep):

| Sitio | Qué hace | En v4 |
|---|---|---|
| `createTrialSubscriptions` (`stripe.service.ts` ~l.334 `subscriptions.create` + ~l.420 `invoices.pay`) — lo llaman `addFeaturesToVenue`, `convertDemoVenue`, `enablePremiumFeatures` | compra suelta | se RETIRA; hoy ya está cerrado en la raíz |
| `updateSubscriptionPrice` (~l.1787 `subscriptions.update` `always_invoice`) — lo llama el controlador `updateSubscription` | cambio de plan PRO↔PREMIUM (VIVO hoy) | se sustituye por el flujo de portal |
| `createPlanSubscription` (~l.864) — onboarding legacy y `planActivation` | plan en el alta | FUERA: protocolo propio ya auditado |
| `createPlanCheckoutSession` (~l.996) | plan desde FREE | se queda; entra a la regla de «una confirmación abierta» |
| `retryInvoicePayment` (`invoices.pay` de una factura existente) | reintento del cliente | se queda: una factura se paga una sola vez |
| cancelar / `cancel_at_period_end` / cupón de retención (~l.1342-1412) | fijan estado sobre un id conocido | se quedan |
| `token-budget` (`invoices.pay`) | tokens del chatbot | FUERA, declarado: otro producto |

Ninguna tool del MCP compra ni cambia de plan (grep sin resultados).

### v4.1 · Comprar una función suelta

1. **Endpoint nuevo** `POST /dashboard/venues/:venueId/features/:featureCode/checkout` → `{ url }`. Mismo permiso que hoy
   compra (`addVenueFeatures`). El `POST /features` viejo queda en 409 `ALA_CARTE_SALES_CLOSED` y se retira después.
2. **Validaciones antes de tocar Stripe:** `ventaSueltaAbierta()`; la función es vendible (activa, con `stripePriceId`, no es
   `PLAN_*`); no está incluida en el plan (`assertNoIncluidaEnElPlan`); el negocio no la tiene ya (fila activa, o vínculo que
   `suscripcionPuedeCobrar` no descarta ⇒ 409 `FEATURE_ALREADY_SUBSCRIBED`, 503 si INCIERTO).
3. **Una sola confirmación abierta por CLIENTE de Stripe.** Bajo `pg_try_advisory_xact_lock(hashtext('stripe-confirm:' ||
   customerId))` (sin espera: si está tomado, 409 «ya hay una compra en curso»), en este orden:
   a. `checkout.sessions.list({ customer, status: 'open', limit: 100 })` — `has_more` ⇒ 503 (no se vio todo);
   b. `checkout.sessions.expire` de cada una que sea NUESTRA (`metadata.kind` ∈ {`FEATURE_PURCHASE`, `PLAN_CHECKOUT`});
      si una ya se COMPLETÓ (el expire falla y al releerla está `complete`), NO se crea otra: 409
      `PURCHASE_ALREADY_COMPLETED` (su webhook la entrega);
   c. `checkout.sessions.create`: `mode: subscription`, `customer`, un renglón con el precio de la función,
      `expires_at = ahora + 30 min`, `metadata` y `subscription_data.metadata` = `{ kind, venueId, featureCode }`,
      `subscription_data.trial_period_days` = 5 sólo si es la primera vez (regla actual de `addFeaturesToVenue`),
      `success_url` con `{CHECKOUT_SESSION_ID}`, llave de idempotencia por petición.
   Tiempos de Stripe dentro del candado: los de `STRIPE_DENTRO_DEL_CANDADO` (15 s, sin reintentos automáticos).
4. **Por qué no hay cobro doble:** una sesión sólo cobra si alguien la confirma en Stripe; como máximo hay una abierta por
   cliente, y crear la siguiente EXPIRA la anterior (en Stripe, completar y expirar son excluyentes). Una sesión creada por un
   proceso que se congeló tras listar nunca llega a un navegador: la petición que la pidió ya respondió.
5. **Entrega:** `checkout.session.completed` con `kind = FEATURE_PURCHASE` ⇒ `fulfillFeatureCheckout`, que es
   `fulfillPlanCheckout` generalizado (misma lectura previa, misma consulta del estado vigente, mismo CAS sobre `updatedAt`,
   mismo trato de estados recuperables y terminales), con la función tomada de `metadata.featureCode` y validada como vendible.
   Si el negocio ya tiene esa función ACTIVA con OTRA suscripción viva ⇒ 🚨 + `ActivityLog DUPLICATE_SUBSCRIPTION_DETECTED`,
   sin conceder ni reembolsar solo (no debería poder ocurrir por el punto 3; queda como alarma).
6. **Webhook perdido:** el barrido existente `plan-access-reconciliation` añade un paso: `checkout.sessions.list({ status:
   'complete', created: { gte: ahora − 48 h } })` paginado y acotado por tiempo; las nuestras sin entregar ⇒ misma entrega
   (idempotente).

### v4.2 · Cambiar de plan PRO ↔ PREMIUM

1. **Endpoint** `POST /dashboard/venues/:venueId/plan/change-session` `{ targetTier }` → `{ url }`. Valida: hay un plan vivo
   ligado a una fila `PLAN_*` activa, con UN solo ítem; destino ≠ actual; `assertSinCobroDobleAlSubir` (fase 2 sigue fuera).
   El intervalo se conserva (el precio destino es `lookup_key` del tier destino con el intervalo actual).
2. **Sesión de portal** con `flow_data.type = subscription_update_confirm` (`items: [{ id, price }]`,
   `after_completion.type = redirect`) y `configuration = STRIPE_PORTAL_PLAN_CHANGE_CONFIGURATION_ID`: una configuración
   DEDICADA con `features.subscription_update` activado SÓLO para los productos de plan (Stripe exige que el precio destino
   esté en `features.subscription_update.products`) y `proration_behavior = always_invoice`; todo lo demás apagado. El portal
   genérico sigue con su configuración sin «Subscription update» (paso humano de R0).
3. **Entrega:** `handleSubscriptionUpdated` hoy NO mira el precio. Se añade: con el `vigente` ya consultado, si el precio del
   ítem corresponde a OTRO `PLAN_*` que el de la fila, se mueve el vínculo en una transacción con candado de la fila del Venue:
   si no existe fila del tier destino, CAS sobre `updatedAt` de la fila actual cambiando `featureId`, `stripePriceId` y
   `monthlyPrice` (lo que hace hoy el controlador); si existe, CAS que suelta el vínculo de la actual y CAS que lo pone en la
   del destino (`stripeSubscriptionId` es único). Cualquier CAS en 0 ⇒ se lanza y el evento se reprocesa.
4. Dos sesiones de cambio abiertas a la vez no se pueden expirar, y no hace falta: cada confirmación FIJA el precio del ítem
   (repetirla no cambia nada) y cada una es una decisión del cliente con su prorrateo mostrado por Stripe.
5. El controlador `updateSubscription` para destinos `PLAN_*` responde 409 `PLAN_CHANGE_MOVED` (el dashboard se despliega con
   el cambio); `updateSubscriptionPrice` se retira.

### v4.3 · Lo que se retira o se cierra para siempre

- `createTrialSubscriptions` y sus tres llamadores (`addFeaturesToVenue`, `convertDemoVenue`, `enablePremiumFeatures`): la
  venta suelta se REABRE sólo por v4.1; esos caminos se borran, no se esconden tras la bandera.
- `ventaSueltaAbierta()` pasa a ser el interruptor de v4.1 únicamente.

### v4.4 · Pantallas (dashboard)

- «Contratar» abre la URL de Stripe; la página de regreso sondea `/plan-tier` (`grantedFeatureCodes`) hasta ver la función,
  como ya hace el regreso del checkout de plan con `state`. Mientras no llega: «Estamos confirmando tu pago».
- «Cambiar a Premium/Pro» abre la sesión de portal; regreso igual.

### v4.5 · Por fases

- **V4-A** (server): v4.1 completo + barrido, con TDD y sabotajes. Puede ir apagado (bandera) a producción.
- **V4-B** (server): v4.2 + movimiento del vínculo en el webhook. Exige crear la configuración dedicada del portal en Stripe de
  PRUEBA y medirla (permiso del founder) antes de la de producción (paso humano).
- **V4-C** (dashboard): botones y páginas de regreso.
- **V4-D**: retirar lo viejo, precios decididos (fase 3), auditoría final de Codex, y sólo entonces encender la venta suelta.

### 🔴 Codex sobre el v4 (22-sep): RECHAZADO (8 P1 · 1 P2) — y destapó defectos VIVOS del checkout de plan

Disuelto por el cambio de enfoque: el emisor congelado en los caminos que sólo crean confirmaciones, los leases y la evidencia
por efecto, la factura del prorrateo. Lo que sigue vivo es otra cosa: **la compatibilidad entre obligaciones** (dos compras
completadas en tiempos distintos, un plan suspendido que sigue cobrando, el portal que se salta la regla de absorción, el
onboarding que compite), **la entrega** que sustituye vínculos sin saber si el viejo terminó, y **el barrido** acotado a 48 h.

🔴 **Verificado en el código el 22-sep — pasa HOY en producción, no sólo en el diseño:**
- **Dos pestañas del checkout de plan pagadas ⇒ dos suscripciones, y la primera queda cobrando sin representación.** La
  segunda entrega de `fulfillPlanCheckout` encuentra la fila activa con S1 y su rama de concesión la REAPUNTA a S2 por CAS
  (`stripe.service.ts` ~l.1236). Nada impide abrir la segunda sesión: el guard sólo mira acceso local.
- **Un plan suspendido que Stripe sigue cobrando no cuenta como «ya tiene plan»**: `createVenuePlanCheckoutSession` usa
  `getVenueBaseTier`, que excluye suspendidos y vencidos (`venue.dashboard.service.ts` ~l.1650). Se puede contratar otro.

## Diseño v5 (22-sep) = v4 + una regla común de compra + entrega que nunca pisa una obligación viva

### v5.1 · La regla común: `autorizarObligacionNueva(venue, intención)`

Todo camino que abre una confirmación de pago (checkout de plan, checkout de función, sesión de portal de cambio de plan) pasa
por UNA función, bajo `pg_try_advisory_xact_lock(hashtext('stripe-obligaciones:' || customerId))` (sin espera ⇒ 409):

1. **Expira las confirmaciones abiertas del cliente** (`checkout.sessions.list({ customer, status: 'open' })`), incluidas las
   LEGACY (reconocidas por `metadata.tierCode` además de `metadata.kind`). Si una ya se completó, 409
   `PURCHASE_ALREADY_COMPLETED` y no se abre otra.
2. **Lee las obligaciones VIVAS del cliente en Stripe**, no el acceso local: `subscriptions.list({ customer, status: 'all' })`
   recorrido completo; viva = todo estado no terminal (`active`, `trialing`, `past_due`, `unpaid`, `incomplete`, `paused`,
   también con cancelación programada). Cada una se proyecta a «qué vende» por el PRECIO de su ítem (plan PRO/PREMIUM o función
   X). Esto cuenta lo completado y todavía no entregado, lo suspendido y lo que nunca se ligó. Lectura incompleta o error ⇒ 503.
3. **Barreras locales vigentes** (v5.3): una autorización de cambio de plan emitida y no vencida.
4. **Compatibilidad** (una tabla pura, con pruebas): a lo sumo UN plan vivo; ninguna función suelta que el plan vivo o el
   destino incluya; ninguna función duplicada. Conflicto ⇒ 409 con el código que diga cuál.
5. **Sólo entonces** crea la confirmación, y la URL se devuelve después de confirmar la transacción del candado (una
   transacción abortada nunca la publica).

### v5.2 · Entrega que nunca pisa una obligación viva (plan y función, la MISMA función)

`entregarSuscripcion(subscriptionId, origen)` sustituye a `fulfillPlanCheckout` y la usan: `checkout.session.completed`, el
barrido y `customer.subscription.updated`. Deriva la función del **precio vigente** del ítem (nunca de la metadata de la
sesión, que queda vieja tras un cambio de plan). Frente a la fila de esa función clasifica el vínculo:

| Vínculo de la fila | Qué hace |
|---|---|
| igual a esta suscripción | aplica el estado vigente (lo de hoy, con CAS) |
| ausente | liga (CAS / `create` con P2002 ⇒ reintento) |
| distinto y `suscripcionPuedeCobrar = NO` (terminado) | sustituye, con CAS |
| distinto y `SI` o `INCIERTO` | **no toca nada**: 🚨 + `ActivityLog OBLIGACION_DUPLICADA` con los dos ids; queda en la bandeja del barrido hasta que alguien la resuelva |

`suscripcionVigente` pasa a devolver también el precio del ítem en la MISMA lectura (hoy sólo `status` y `trialEnd`).

**Cambio de tier** (el precio vigente es de otro plan que el de la fila ligada): en una transacción con candado de la fila del
Venue, la fila origen se DESACTIVA y suelta el vínculo; la destino se clasifica con la tabla de arriba (si trae otra obligación
viva ⇒ conflicto, nada cambia) y, si procede, recibe vínculo, precio y campos de acceso/cobranza limpios. Todo o nada.

### v5.3 · Cambio de plan por portal con barrera persistente

- Se autoriza por v5.1 y se registra una fila `PlanChangeAuthorization { venueId, portalSessionId, targetTier, expiresAt }`
  ANTES de devolver la URL. Mientras esté vigente, v5.1 rechaza comprar funciones que el destino incluya y abrir otro cambio.
- **`expiresAt` = vida máxima MEDIDA de una sesión de portal** (Stripe sólo la llama «short-lived»; se mide en Stripe de
  PRUEBA con permiso del founder). Sin esa medida, v5.3 no se enciende.
- Configuración dedicada del portal para el flujo (precios de plan permitidos, `default_allowed_updates: ['price']`, sin
  cantidades ni descuentos, cambio inmediato, `always_invoice`), y sólo se emite con la suscripción `active` (no `past_due`,
  no `trialing` — decisión a medir: qué pasa con el prorrateo de un periodo impago).
- Hasta que v5.3 esté medido y encendido, el cambio de plan de hoy (servidor, `updateSubscriptionPrice`) sigue, pero pasa por
  v5.1. Declarado: es el único camino que todavía mueve dinero desde el servidor.

### v5.4 · Fronteras con los otros carriles

- **Onboarding, frontera en los DOS sentidos:**
  - Los carriles del alta que cobran (legacy de `completeV2Onboarding` y `activate-plan`) toman el MISMO candado por cliente y
    hacen los pasos 1 y 2 de v5.1 antes de cobrar: si el cliente ya tiene un plan vivo en Stripe, no cobran y lo dicen.
  - El dashboard no abre confirmaciones mientras haya un **alta económica en curso**: marca temprana
    `OnboardingProgress.completedAt` puesta sin `Organization.onboardingCompletedAt` (que se escribe DESPUÉS del cobro), o
    `planActivationStatus = IN_PROGRESS`.
  - Por qué no «exigir alta terminada»: medido en producción (22-sep, sólo lectura), **20 organizaciones activas no tienen
    `onboardingCompletedAt`** — 16 sin `OnboardingProgress` (anteriores al wizard), 3 con progreso sin marca y 1 con la marca
    temprana puesta. Exigirla bloquearía a las 20; la regla de arriba sólo detiene a la última.
- **`updateSubscription` suelta→suelta** se cierra (409), no sólo los destinos `PLAN_*`.
- **Métodos de pago:** Checkout sólo con tarjeta (`payment_method_types: ['card']`), para que `active` signifique cobrado.
- **`retryInvoicePayment` sí mueve dinero desde el servidor** (paga una factura existente, una sola vez): se corrige la frase
  del v4. Retención y pausa alteran condiciones futuras y pasan por v5.1 cuando se construyan como autoservicio.

### v5.5 · Barrido con progreso persistente

El barrido de acceso recorre las suscripciones LIGADAS de planes y funciones (también filas activas, para detectar un precio o
tier desactualizado) y las obligaciones duplicadas registradas, con cursor persistido entre corridas y presupuesto por corrida.
Las sesiones completadas se descubren por `checkout.sessions.list` con cursor persistido (las 48 h son optimización, no límite).

### v5.6 · Orden de construcción

1. **V5-A (arregla lo vivo del plan):** v5.1 + v5.2 aplicados al checkout de plan que ya existe, y la frontera de onboarding.
   Sin tocar la venta suelta (sigue cerrada).
2. **V5-B:** checkout de funciones sueltas por v5.1/v5.2 (apagado por bandera).
3. **V5-C:** barrido persistente (v5.5).
4. **V5-D:** cambio de plan por portal (v5.3), tras la medición en Stripe de prueba.
5. **V5-E:** dashboard, retiro de lo viejo, precios, auditoría final y encendido.

### 🟢 Codex sobre el v5 (22-sep): AUTORIZADO CON CAMBIOS — V5-A puede construirse ya

Cerrados: dos compras completadas en tiempos distintos (mismo cliente, precios reconocidos) · plan suspendido que cobra ·
suelta→suelta · métodos asíncronos. Parciales: entrega (falta el conjunto de planes), movimiento de tier, onboarding, barrido.
Abierto: portal (la sesión vence 1 h después de la ÚLTIMA actividad — Stripe, «customer-management» —, no hay vida máxima fija).

**Lista cerrada de cambios para V5-A:**
1. **Identidad:** el candado va por `venueId`. El inventario incluye el cliente actual y los clientes de TODOS los vínculos
   locales. El clasificador devuelve plan · función · producto ajeno conocido · **desconocido** (bloquea + incidencia, nunca
   «no hay obligación»); reconoce precios históricos (plan por `lookup_key`) y suscripciones con varios ítems.
   Argumento verificable para no guardar historial de clientes: `stripeCustomerId` sólo pasa de nulo a valor por CAS
   (`getOrCreateStripeCustomer`) y de valor a nulo con `customer.deleted`, y borrar un cliente en Stripe cancela sus
   suscripciones. (A confirmar en la auditoría del código.)
2. **Entrega de plan revisa los DOS tiers** bajo el candado del negocio. La suscripción adicional queda como obligación
   pendiente en una tabla durable por `subscriptionId` (pendiente/resuelta), no sólo en `ActivityLog`.
3. **Conflicto ≠ conservar acceso:** si el precio vigente ya no respalda la fila activa, se retira esa concesión en la misma
   transacción aunque la otra fila tenga conflicto. La tabla de vínculos se cruza con el estado entrante (terminal ·
   recuperable · habilitante): «ausente ⇒ liga» no implica `active:true`.
4. **Portal (V5-D) apagado** hasta tener una liberación verificable que no sea por tiempo.
5. **Onboarding:** clasificar obligación del mismo intento (recuperar — se conserva la rama de recuperación de
   `planActivation`), distinta (no cobrar, explicar) y resultado desconocido (estado económico persistente que bloquea). El
   `catch` del carril legacy que sigue tras un timeout NO puede soltar la barrera. La organización con la marca temprana
   puesta necesita una salida de conciliación explícita.
6. **Los escritores de planes que siguen vivos convergen en la entrega nueva**: el controlador de cambio de plan
   (`updateSubscription` → sustitución de precio de una suscripción identificada), `asegurarAccesoDelPlan` y las
   recuperaciones de onboarding. Candado o versiones capturados ANTES de consultar Stripe.
7. **Inventario económico:** retención y pausa (`applyRetentionOffer`, `pause_collection`) existen hoy; la lectura vigente
   incluye `pause_collection`, `collection_method` y cambios programados.
8. **Recuperación:** V5-A persiste sus conflictos y conserva las recuperaciones actuales; el recorrido completo (suscripciones
   propias sin vínculo, cursor que avanza sólo tras encolar) es V5-C.

### V5-A · Orden de trabajo (TDD, cada pieza con sabotajes)

1. 🟢 **HECHO (22-sep, sin commitear) — núcleo puro, sin base ni Stripe:** `src/services/access/obligacionesDeCobro.ts`
   (`clasificarSuscripcion`, `clasificarEstado`, `evaluarCompatibilidad`, `decidirEntregaDePlan`). 40 pruebas; 6 sabotajes,
   cada uno tumba la suya: lo desconocido no bloquea · no mirar el otro tier · conservar el acceso no respaldado · vínculo sin
   respuesta leído como terminado · conceder siempre · lo desconocido convertido en ajeno.
2. **Tabla durable de obligaciones pendientes** (migración aditiva, base desechable para pruebas).
3. **`inventarioDeObligaciones(venueId)`**: clientes (actual + de los vínculos) → suscripciones `status: all` recorrido completo →
   clasificadas; incompleto ⇒ 503.
4. **`autorizarObligacionNueva`** aplicada al checkout de plan (sesiones legacy reconocidas por `metadata.tierCode`).
5. **`entregarSuscripcion`** (sustituye `fulfillPlanCheckout`; ambos tiers; retiro de acceso no respaldado).
6. **Convergencia** del cambio de plan del controlador, `asegurarAccesoDelPlan` y onboarding.
7. `/full-testing`, auditoría de Codex del código, verificación completa.
