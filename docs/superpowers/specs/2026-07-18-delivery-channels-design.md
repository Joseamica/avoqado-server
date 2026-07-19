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

- Contrato exacto de webhooks que Deliverect llama al POS (paths/métodos/campos de registro de location) — la doc pública lo describe pero
  la verificación adversarial no lo cerró al 100%; NO asumir superficie exacta hasta staging.
- Mecánica precisa del product sync (pull de Deliverect vs push nuestro) y del snooze API.
- Formato de montos por campo (confirmar centavos en todos los endpoints).
- Manejo de CANCELACIONES entrantes (cancel webhook / status de cancelación del canal): mecanismo exacto depende del contrato de staging; el
  scaffold ingiere y persiste eventos `order` — el handler de cancel se implementa en la fase de staging junto con la revalidación del
  contrato de webhooks.
- Transiciones de status POS→canal (PREPARING/READY/PICKED_UP): el dispatcher las soporta pero solo el AUTO-accept está cableado (en la
  ingesta); propagar cambios de estado del KDS/TPV requiere tocar controllers compartidos — fase staging.
- Hook billing→canal: feature suspendido debería pausar el canal en el proveedor (enforcement a nivel canal del spec §7); sin canales reales
  aún — fase staging, junto al flujo de onboarding que entregue el webhookSecret a Deliverect.
- Menu snapshot traversal simplificado: lee MenuCategory directo (ignora la cadena Menu→MenuCategoryAssignment y su scheduling) y el flag
  autoSyncMenu aún no dispara re-sync (dead-code hasta el trigger debounced) — fase staging con la mecánica real de product sync.
