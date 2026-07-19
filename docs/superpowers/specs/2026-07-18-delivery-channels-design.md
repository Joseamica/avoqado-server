# Delivery Channels — Diseño (Deliverect como primer adapter)

**Fecha:** 2026-07-18 **Estado:** Aprobado por founder (diseño); pendiente credenciales de staging de Deliverect **Scope:** Solo backend
(avoqado-server). Dashboard teaser y UI de gestión = fase posterior.

## 1. Contexto y objetivo

Avoqado se expande a restaurantes y necesita gestión de pedidos de delivery (Uber Eats, Rappi, DiDi Food). La ruta elegida es **Deliverect
como agregador** (una integración → los 3 canales; su página MX confirma los 3 como partners). Estrategia a mediano plazo: si el volumen lo
justifica, migrar canales a integración directa — por eso la arquitectura es **core genérico + adapters por proveedor**, donde Deliverect es
solo el adapter #1.

La aplicación de partner está en `deliverect.com/en/become-a-partner` (categoría POS Systems). Staging Client ID/Secret los emite su API
team tras aplicar; producción requiere certificación. **Este scaffold se construye contra la doc pública ANTES de tener credenciales** —
todo queda listo para conectar a staging el día 1.

Referencias clave:

- Guía POS: <https://developers.deliverect.com/docs/building-a-pos-integration>
- HMAC: <https://developers.deliverect.com/docs/validating-orders-in-pos-using-hmac>
- Status mapping: <https://developers.deliverect.com/docs/how-to-match-order-statuses>
- Canal de origen: <https://developers.deliverect.com/docs/how-do-i-know-which-channel-an-order-comes-from>
- Certificación: <https://developers.deliverect.com/docs/certification-process>
- MCP de docs de Deliverect: `https://developers.deliverect.com/mcp` (+ índice `llms.txt`) — usar durante implementación

## 2. Decisiones de producto (founder, 2026-07-18)

| Decisión              | Valor                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tier                  | **PREMIUM** — Feature `DELIVERY_CHANNELS` (Feature/VenueFeature, NO Module)                                                                                                                |
| Visibilidad           | Teaser con candado en dashboard (fase posterior, alineado a paywall-visible rework)                                                                                                        |
| Scope v1              | Solo backend                                                                                                                                                                               |
| Aceptación de pedidos | `orderAcceptanceMode: AUTO \| MANUAL` por canal, default **AUTO**. v1 implementa solo AUTO. MANUAL requiere UI en avoqado-android + avoqado-ios (juntas) — v2                              |
| Dinero                | Pedido llega pagado en plataforma → **Payment externo marcado** (sin dinero por Avoqado): entra a reportes/analytics, dispara deducción FIFO, se excluye de cortes de caja y liquidaciones |
| Principio rector      | El pedido de delivery entra al MISMO torrente que todo Avoqado (Order/Payment/KDS/reportes/MCP), no a un silo. Y: sincronizado sin romper procesos existentes                              |

## 3. Arquitectura

```
src/services/delivery-channels/
  core/
    deliveryOrderIngestion.service.ts   # payload normalizado → Order+Payment (tx)
    menuSnapshot.service.ts             # menú completo del venue → snapshot JSON genérico
    statusDispatcher.service.ts         # cambios de estado de Order → adapter del canal
    deliveryChannelLink.service.ts      # CRUD de vínculos (gestión)
  providers/
    deliverect/
      deliverect.adapter.ts             # implementa DeliveryProviderAdapter
      deliverect.mapper.ts              # payload Deliverect ⇄ formato normalizado; menú → su formato
      deliverect.client.ts              # API client (OAuth client-credentials, baseURL configurable)
      deliverect.hmac.ts                # verificación HMAC (timingSafeEqual)
src/controllers/delivery-channels/      # webhook controller + gestión
src/routes/ → webhook.routes.ts (webhooks) + delivery-channels.routes.ts (gestión, en routes/index.ts)
src/jobs/delivery-webhook-reconciliation.job.ts   # retry de eventos FAILED (patrón blumon)
```

Interfaz `DeliveryProviderAdapter` (contrato del core con cada proveedor): `parseOrderWebhook(raw, link)` → orden normalizada ·
`verifySignature(rawBody, headers, link)` · `pushMenu(snapshot, link)` · `sendStatusUpdate(order, status, link)` ·
`setChannelPaused(link, paused)`. Adapters futuros: `providers/didi/`, `providers/rappi/`, `providers/ubereats/` — cero cambios al core.

**El core trabaja en pesos (Decimal, 1:1) y fechas venue-local. Deliverect trabaja en centavos → la conversión ×100/÷100 vive EXCLUSIVAMENTE
en `deliverect.mapper.ts`** (frontera externa permitida por la regla de dinero).

## 4. Schema (Prisma — 100% aditivo)

```prisma
enum DeliveryProvider { DELIVERECT  UBER_EATS  RAPPI  DIDI_FOOD }   // directos = futuro
enum OrderAcceptanceMode { AUTO  MANUAL }
enum DeliveryChannelStatus { PENDING  ACTIVE  PAUSED  DISABLED }
enum DeliveryOrderEventStatus { RECEIVED  PROCESSED  FAILED  DUPLICATE }

model DeliveryChannelLink {
  id                  String  @id @default(cuid())
  venueId             String
  venue               Venue   @relation(...)
  provider            DeliveryProvider
  externalLocationId  String              // locationId de Deliverect / store id del proveedor
  externalAccountId   String?             // accountId de Deliverect
  webhookSecret       String              // secret HMAC por vínculo
  orderAcceptanceMode OrderAcceptanceMode @default(AUTO)
  status              DeliveryChannelStatus @default(PENDING)
  autoSyncMenu        Boolean @default(true)
  lastMenuSyncAt      DateTime?
  config              Json?               // extras por proveedor
  createdAt/updatedAt
  @@unique([provider, externalLocationId])
  @@index([venueId])
}

model DeliveryOrderEvent {                 // log de webhook, patrón BlumonWebhookEventLog
  id              String @id @default(cuid())
  provider        DeliveryProvider
  externalEventId String                   // order/event id del proveedor
  channelLinkId   String?
  venueId         String?
  eventType       String                   // 'order' | 'cancel' | ...
  payload         Json
  status          DeliveryOrderEventStatus @default(RECEIVED)
  error           String?
  orderId         String?                  // Order creada (si PROCESSED)
  receivedAt/processedAt
  @@unique([provider, externalEventId, eventType])
  @@index([status, receivedAt])
}
```

**Order: SIN cambios de modelo.** Reusa `externalId` (order id del proveedor), `posRawData` (payload crudo),
`@@unique([venueId, externalId])`, `OrderType.DELIVERY`.

**Enums existentes (aditivo):** `OrderSource` += `UBER_EATS`, `RAPPI`, `DIDI_FOOD`, `DELIVERY_PLATFORM` (fallback si el canal no se
resuelve). El adapter resuelve el canal real del payload → reportes por canal desde el día 1.

**PLU para product sync = `Product.sku`** (unique por venue, requerido — cero migración de datos).

Obligatorio en el mismo commit: `MODEL_TO_DOMAIN` en `scripts/generate-schema-map.ts` (los 2 modelos nuevos) + `npm run schema:map` +
registrar modelos nuevos en `tests/__helpers__/setup.ts` (prismaMock manual).

## 5. Flujo de pedidos

**Entrada:**

1. `POST /api/v1/webhooks/delivery/deliverect/*` — bajo el router genérico de webhooks que ya monta `express.raw` ANTES de `express.json`
   (orden de mounting intacto). El contrato exacto de paths que Deliverect llama se confirma con credenciales (único punto abierto de la doc
   pública).
2. Verificación HMAC con `webhookSecret` del link + `crypto.timingSafeEqual` (patrón MercadoPago).
3. **Contrato ACK (patrón Blumon endurecido):** persistir `DeliveryOrderEvent` PRIMERO → solo entonces 200. Fallo de persistencia → 5xx
   (fuerza retry de Deliverect). Duplicado (unique) → 200 `DUPLICATE`. Cron `delivery-webhook-reconciliation.job` reintenta `FAILED` — con
   `retry(..., shouldRetryDbConnectionError)` y minuto offset (nunca :00).

**Ingesta (`deliveryOrderIngestion.service.ts`):**

1. Resuelve link por `externalLocationId` → `venueId` (tenant isolation en la puerta; link no encontrado → evento FAILED, jamás adivinar
   venue).
2. Items por PLU=`sku`; PLU desconocido → producto placeholder + warning (patrón `getOrCreatePosProduct` de pos-sync) — nunca se rechaza un
   pedido pagado.
3. **Precios/impuestos/cargos/propina del payload** (lo que el cliente pagó manda), `Prisma.Decimal`, pesos (adapter ya convirtió ÷100).
4. Una `$transaction`: `Order` (DELIVERY, source=canal, `externalId`, `posRawData`) + `OrderItems` + **Payment externo marcado** →
   paymentStatus PAID → deducción FIFO existente se dispara sola (no-blocking). Mecanismo concreto del marcador: reusar el patrón existente
   de pagos externos (pagos manuales del dashboard / `externalSource` tipo 'Rappi' que ya existe en el MCP) — el plan de implementación fija
   el campo exacto tras leer el modelo `Payment` en schema; requisito duro: cortes de caja y liquidaciones deben poder excluirlo con un
   filtro simple.
5. Post-commit: `socketManager.broadcastToVenue(ORDER_CREATED)` con el MISMO shape que pos-sync (incl. `eventType` compat Android) — apps
   móviles muestran el pedido sin cambios.
6. Modo AUTO: `statusDispatcher` manda "accepted" al canal tras ingesta exitosa.

**Salida:** `statusDispatcher` traduce transiciones de Order (confirmada → preparando → lista → entregada al repartidor) al mapping de
estados del proveedor. Prep-time updates: best-effort v1.

**Cancelaciones entrantes:** Order → `CANCELLED` (si operacionalmente posible) + `ORDER_UPDATED` + ActivityLog `DELIVERY_ORDER_CANCELLED`.
Restock de inventario sigue el flujo existente de cancelación. El reembolso al cliente es de la plataforma, no de Avoqado.

## 6. Menú y sincronización

- **`menuSnapshot.service.ts` (core):** menú completo del venue
  (`Menu → MenuCategoryAssignment → MenuCategory → Product → ProductModifierGroup → ModifierGroup → Modifier`) con precios, scheduling y
  disponibilidad → snapshot JSON genérico. Nota: también tapa el gap del `public-menu` mock (reutilizable para QR/web propio — fuera de
  scope aquí, pero el service se diseña reusable).
- **`deliverect.mapper.ts`:** snapshot → formato Deliverect (products, modifier groups, PLU=sku, centavos, tax model según su doc).
- **Disponibilidad → snooze:** hook al sistema de product availability existente — producto sin stock → snooze en canal (no aparece para el
  cliente de Uber/Rappi/DiDi); restock → un-snooze.
- **Dirección del sync:** Deliverect hace product sync desde el POS; re-sync disparado por cambios de menú si `autoSyncMenu` (debounced).
  Detalle pull vs push se afina con credenciales; `menuSnapshot` es idéntico en ambos casos.

## 7. Gating, permisos, MCP, auditoría

- **Feature (no Module):** seed idempotente `DELIVERY_CHANNELS` (estilo `seed-cfdi-feature.ts`) + alta en `PREMIUM_ONLY_CODES`
  (`basePlan.service.ts`) — sin esto PRO lo recibe por blanket grant. Rutas de gestión con `checkFeatureAccess('DELIVERY_CHANNELS')`.
- **Enforcement de billing a nivel CANAL, jamás a nivel pedido:** feature suspendido → pausar canal en el proveedor (dejan de entrar
  pedidos). Pedido en vuelo SIEMPRE se procesa — el cliente ya pagó.
- **Permisos:** `delivery-channels:read` + `delivery-channels:manage` — checklist completo de `permissions-policy.md` (catálogo
  `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`, `DEFAULT_PERMISSIONS` OWNER/ADMIN=manage MANAGER=read, deps, `npm run audit:permissions` verde).
- **MCP lockstep (mismo cambio):** tool `delivery_channels` en `src/mcp/tools/` (estado de canales, lastMenuSyncAt, resumen de pedidos
  delivery del día) gateado con `venueHasFeatureAccess` (resolver de Features). Verificar que `channel_mix`, `daily_sales`, `list_payments`,
  `find_order` digieren los `OrderSource` nuevos + `scripts/mcp-money-reconcile.ts` cuadra al centavo.
- **ActivityLog:** `DELIVERY_CHANNEL_CONNECTED/UPDATED/PAUSED/DISABLED` (config) y `DELIVERY_ORDER_CANCELLED` (anomalía). NO loguear cada
  pedido entrante (ruido de alto volumen). `logAction` fire-and-forget fuera de la tx.

## 8. Seguridad de regresión ("sin romper nada")

1. Schema 100% aditivo — cero campos modificados/renombrados/eliminados; respuestas de API solo ganan campos opcionales (regla TPV).
2. Consumidores de `OrderSource`: grep de switches/filters existentes y test de que valores nuevos fluyen (reportes agrupan dinámicamente).
3. Webhook mounting order intacto (Stripe/MP/Blumon).
4. Socket payload shape idéntico a pos-sync (compat Android/iOS sin cambios en apps).
5. Cortes de caja: pagos externos de plataforma excluidos del efectivo esperado; verificar Cierre del día los muestra como venta (regresión
   sobre el endpoint agregador reciente).
6. Tests: sección NUEVA + sección REGRESIÓN por archivo (regla testing); fechas `TZ=UTC`; `npm run pre-deploy` antes de cualquier push;
   prismaMock actualizado.

## 9. Fuera de scope v1 (explícito)

- CFDI/fiscal de pedidos de plataforma (las plataformas emiten comprobantes al cliente; facturación restaurante↔plataforma = feature
  aparte).
- Aceptación MANUAL (requiere UI Android+iOS juntas — v2).
- UI de dashboard (teaser con candado + gestión de canales — fase siguiente, repo avoqado-web-dashboard, `plan-catalog.ts` + FeatureGate).
- Adapters directos (DiDi/Rappi/Uber) — la interfaz queda lista, la implementación es fase futura.
- Liquidaciones/conciliación de pagos de plataformas (receivables) — cuando haya volumen real.

## 10. Abierto (se resuelve con credenciales de staging)

> **Punch-list de revalidación de staging (auditoría G-Stack + Codex GPT-5, 2026-07-19).** El scaffold se construyó contra doc pública
> ANTES de tener credenciales; la auditoría cruzó el código contra la doc actual de Deliverect y encontró que **varios contratos asumidos
> difieren de lo documentado**. NO asumir la superficie: cada punto de §10.1 trae el valor **documentado** a validar el día 1 de staging
> (con URL). §10.2 es endurecimiento de concurrencia diferido. §10.3 es lo que la auditoría YA endureció (baseline). §10.4 son decisiones de
> seguridad que requieren al founder. **Ningún tenant tiene canales ACTIVE todavía**, así que nada de esto afecta prod hoy — pero TODO debe
> cerrarse antes de ingerir un pedido real.

### 10.1 Contrato Deliverect real — money/correctness (validar contra doc, día 1 staging)

Cada uno cambia dinero o el ciclo de vida del pedido. El código actual (scaffold) asumió distinto; el valor **documentado** es la referencia:

1. **HMAC — header y encoding difieren.** Código: header `x-deliverect-hmac-sha256`, Base64, secreto random por-link. Documentado: header
   **`x-server-authorization-hmac-sha256`**, **hex**, y el secreto es el **identificador de location/integración** (no un random nuestro).
   Con lo actual, TODO webhook auténtico se rechaza. `timingSafeEqual` no salva comparar la representación equivocada.
   `deliverect.hmac.ts` + `deliveryChannelLink.service.ts` (generación del secreto). Doc:
   <https://developers.deliverect.com/reference/hmac-authentication>.
2. **`orderIsAlreadyPaid` / `payment.due` ignorados → ingresos fantasma.** Deliverect manda un monto de pago para pedidos **pagados Y no
   pagados**; hay que leer `orderIsAlreadyPaid` para decidir si crear un Payment `COMPLETED`. Código: SIEMPRE marca confirmado+pagado y crea
   Payment completo → un pedido de efectivo/no-pagado se vuelve ingreso liquidado ficticio. `deliverect.mapper.ts` +
   `deliveryOrderIngestion.service.ts`. Doc: <https://developers.deliverect.com/page/glossary-pos-orders>.
3. **Descuento con signo NEGATIVO.** Deliverect manda `discountTotal` negativo; el código lo guarda directo en el campo positivo
   `discountAmount` y los cálculos lo RESTAN → un descuento de `-10` sube el neto 10. Validar el signo real y normalizar a magnitud positiva
   (o restar el negativo, según cómo el resto del sistema use `discountAmount`). Doc:
   <https://developers.deliverect.com/docs/how-are-discounts-sent>. (Nota: la validación de bounds de §10.3 excluye a propósito
   `discountAmount` justo para no romper este signo — resolver los dos juntos.)
4. **Modificadores no multiplicados por la cantidad del item padre.** Dos productos con un modificador de $15 registran $15, no $30.
   Deliverect define `cantidad_modificador × cantidad_producto`. `deliverect.mapper.ts` + `deliveryOrderIngestion.service.ts`. Doc:
   <https://developers.deliverect.com/docs/how-to-interpret-modifiers-and-the-quantity-ordered>.
5. **`serviceChargeAmount` / `deliveryFeeAmount` se normalizan pero NUNCA se persisten.** El `total` los incluye pero los campos quedan en 0 →
   pedidos internamente inconsistentes + reporte/fiscal mal. Persistirlos al ingerir (Order ya tiene `serviceChargeAmount` de otra sesión;
   `deliveryFeeAmount` necesita columna o mapeo). `deliveryOrderIngestion.service.ts`.
6. **Endpoint de status POS→canal.** Código: `POST /orders/{channelOrderId}/status` con solo `{status}`. Documentado:
   **`/orderStatus/{Deliverect _id}`** con campos de body adicionales. Además los códigos: código mapea PREPARING/READY/PICKED_UP a
   **30/40/50**; documentado preparación/listo/final = **50/70/90**. `deliverect.client.ts` + `deliverect.mapper.ts`. Doc:
   <https://developers.deliverect.com/reference/update-order-status-1>.
7. **Modo ocupado (busy/snooze).** Código: `POST /locations/{id}/busy` con `{paused}`. Documentado: **`/updateStoreStatus/{locationId}`** con
   **`isActive`** (inverso de `paused`). Y `pauseChannelLink` se traga el fallo tras cambiar el estado local → la API reporta éxito mientras
   el marketplace sigue abierto. `deliverect.client.ts` + `deliveryChannelLink.service.ts`. Doc:
   <https://developers.deliverect.com/reference/update-store-status>.
8. **Cancelaciones entrantes = mismo `channelOrderId` con status 100.** El dedup actual las clasifica como DUPLICATE y ACKea; el pedido local
   queda CONFIRMED/PAID. El handler de cancel se implementa aquí, junto con la corrección del dedup de §10.2. Doc:
   <https://developers.deliverect.com/reference/create-channel-order>.
9. **Mecánica del product sync** (pull de Deliverect vs push nuestro) y del snooze API; menu snapshot traversal simplificado (lee
   MenuCategory directo, ignora la cadena Menu→MenuCategoryAssignment y su scheduling; `autoSyncMenu` es dead-code hasta el trigger
   debounced). Cerrar con la mecánica real de product sync.
10. **Formato de montos por campo** — confirmar centavos vs mayor en TODOS los endpoints (el mapper convierte a pesos en el borde; validar
    caso por caso).

### 10.2 Endurecimiento de concurrencia/lifecycle (diferido — necesita migración o contrato real)

- **Clave de dedup incompleta** (`deliveryWebhookEvent.service.ts`): omite `venueId`/`channelLinkId`, usa solo provider+`channelOrderId`+tipo.
  `channelOrderId` es del marketplace, NO el `_id` globalmente único de Deliverect → colisión cross-canal/cross-tenant hace que el segundo
  tenant reciba 200 DUPLICATE y nunca ingiera; el `eventId` devuelto puede ser de otro venue. Fix staging: dedup por el `_id` de Deliverect,
  o añadir `channelLinkId`+`venueId` al índice único (migración).
- **Reconciliación sin backoff/attempt-counter/`nextAttemptAt`** (`delivery-webhook-reconciliation.job.ts`): 50 eventos veneno ocupan cada
  batch por 24h (~720 reintentos c/u) y matan de hambre a los pedidos jóvenes. Fix: campo `attemptCount` + `nextAttemptAt` (migración) +
  backoff exponencial. (El take-limit del orphan sweep YA se puso — §10.3.)
- **Reconciliación sin lock distribuido / claim atómico**: múltiples réplicas y pasadas solapadas seleccionan las mismas filas. El upsert de
  Order reduce duplicación pero sockets/status-calls/bookkeeping no son exactamente-una-vez. Fix: `SELECT … FOR UPDATE SKIP LOCKED` o flip
  atómico de status a PROCESSING.
- **Activación: check-then-create sin unique index** (`deliveryActivation.service.ts`): "una solicitud viva por venue" es una carrera; POSTs
  concurrentes crean duplicados. Además permite transiciones de status arbitrarias (revertir CONNECTED/DISMISSED a vivas). Fix: índice único
  parcial (una viva por venue) + máquina de transiciones validada.
- **statusDispatcher elige el primer link activo arbitrario** (`statusDispatcher.service.ts`), no el link/proveedor que originó el pedido →
  con múltiples canales activos, manda updates por el proveedor equivocado con un external order ID ajeno. Fix: guardar el `channelLinkId`
  originador en la Order y despachar por él.
- **`pauseChannelLink(paused:false)` mueve cualquier link (PENDING/DISABLED) directo a ACTIVE**, saltándose el lifecycle de confirmación del
  proveedor. Fix: gate de transición.

### 10.3 Ya endurecido en la auditoría (baseline al entrar a staging — 2026-07-19, 4 commits)

- **Bounds de dinero en el webhook** (`deliverect.mapper.ts`): `total`/`unitPrice`/`quantity` deben ser finitos y ≥0 (o >0 qty) → si no, 400.
  Un `total` negativo de un payload malformado ya NO puede crear una Order/Payment "PAID" con forma de reembolso. (Excluye `discountAmount` a
  propósito — ver §10.1.3.)
- **P2025 → 404** en `updateActivationStatus` (antes 500 crudo en id inexistente).
- **P2002 → 409** en `createChannelLink` (antes 500 en `(provider, externalLocationId)` duplicado).
- **Orphan sweep con `take` acotado + `updateMany` scopeado a los ids del batch** (antes cargaba todos los expirados sin límite).
- **`listActivationRequests` con filtro `venueId`/`venueIds`** + el MCP tool single-venue ya NO hace scan cross-tenant (preserva el fix de
  pool `2c9f1a86`).

### 10.4 Decisiones de seguridad para el founder (NO decididas — requieren tu llamada)

- **Confused-deputy en el link de canal (Codex lo marcó como el hallazgo más explotable).** Hoy `POST /venues/:venueId/channels` vive en el
  namespace del dashboard, gated por permiso OWNER/ADMIN — un manager de un tenant puede bindear IDs de location/cuenta arbitrarios y luego
  dispararlos (pause / menu sync) con las credenciales OAuth **platform-wide** de Deliverect; el scoping local por `venueId` solo prueba que
  es dueño del *link* de Avoqado, no del recurso externo. **Esto coincide con tu decisión de producto "ops/superadmin conecta el canal"**
  (spec §2): la recomendación natural es **mover la creación/link de canal al namespace superadmin (ops-only)** y dejar solo
  pausar/modo-accept para OWNER/ADMIN. Alternativa si algún día se quiere self-serve: verificar ownership del recurso Deliverect (claim
  OAuth del merchant) antes de bindear. Decisión tuya: ¿ops-only ya, o self-serve con verificación después?
- **Orden feature-antes-de-permiso** (`delivery-channels.routes.ts`): el feature gate corre antes del check de permiso/membresía, así que un
  autenticado que NO es miembro del `:venueId` puede sondear el plan/trial/suspensión de otro venue por los 403 distintos antes de que
  `checkPermission` lo niegue. Es un patrón transversal del repo (no solo delivery). Recomendación: permiso/membresía primero, feature
  después — pero es un cambio cross-cutting que conviene decidir a nivel plataforma, no colar en delivery.

### 10.5 Otros abiertos (contrato/mecánica, sin riesgo de dinero)

- Contrato exacto de los webhooks que Deliverect llama al POS (paths/métodos/campos de registro de location) — validar superficie completa.
- Transiciones de status POS→canal (PREPARING/READY/PICKED_UP): el dispatcher las soporta pero solo el AUTO-accept está cableado; propagar
  cambios del KDS/TPV requiere tocar controllers compartidos.
- Hook billing→canal: feature suspendido debería pausar el canal en el proveedor (§7); sin canales reales aún — junto al onboarding que
  entregue el secreto a Deliverect.
