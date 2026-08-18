# Uber Eats — integración directa (v1, piloto)

**Fecha:** 2026-08-17 · **Repo:** `avoqado-server` · **Reemplaza** al documento anterior, que queda
como `2026-08-17-delivery-uber-eats-ANEXO-investigacion.md` (histórico, no ejecutar desde ahí).

> **Cómo leer esto.** Cada afirmación técnica lleva su origen:
> **`[código]`** verificado en este repo con `archivo:línea` · **`[doc]`** documentación pública de
> Uber, con enlace · **`[api]`** probado contra la API real el 2026-08-17 · **`[supuesto]`** todavía
> sin verificar — **si no lleva etiqueta, es supuesto**.
> Nada de historial de correcciones: esto dice qué construir, no cómo llegamos aquí.

---

## 1. Qué se construye

Un pedido hecho en Uber Eats entra a Avoqado como una venta más del negocio: se registra el cobro,
descuenta inventario, imprime su comanda, aparece en los reportes y se acepta ante Uber dentro del
plazo. Una tienda piloto, México, pesos.

Deliverect queda apagado como plan B; su código no se rediseña.

## 2. Decisiones tomadas (founder, 2026-08-17)

| Decisión | Detalle |
| --- | --- |
| **Se aceptan todos los pedidos** | No se rechaza por modalidad de pago. Los casos que el contrato no sabe interpretar con certeza entran **marcados para revisión**, nunca procesados a medias ni inventados |
| **Inventario al recibir el pedido** | No al entregarlo. Ya es así `[código]` y coincide con Fudo ("los ingredientes se descuentan cuando la venta se registra") y con Square (al completar la orden, sin reserva intermedia) `[doc]` |
| **Facturación al confirmar** | El CFDI y el ingreso confirmado esperan a saber que el pedido terminó. Uber **no avisa la entrega** `[doc]`, así que se consulta el estado con un job |
| **Aceptación automática configurable desde el dashboard** | `OrderAcceptanceMode` ya existe con `AUTO`/`MANUAL` `[código]`. Falta la pantalla y que `MANUAL` funcione. Default **AUTO** — decisión de quien implementa: es el default de la industria y `MANUAL` sin UI móvil dejaría pedidos sin atender |
| **Tipo de pago auto-provisionado** | Al activar el canal se crea o reutiliza el `VenueTenderType` del proveedor. El dueño no tiene que crearlo antes de su primer pedido |
| **Una sola generación de API** | Uber tiene dos (la previa y la 1.0.0). Se elige **una** y se construye contra ella. Mezclarlas es el origen de buena parte del desorden del documento anterior |

## 3. Estado real del código (verificado)

### Funciona hoy

| Pieza | Dónde |
| --- | --- |
| Scaffolding multi-canal: `DeliveryProvider`, `OrderSource.UBER_EATS`, `OriginSystem.DELIVERY_PLATFORM` | `schema.prisma:7558,7578,7590` `[código]` |
| Body crudo en `/api/v1/webhooks` (necesario para verificar HMAC sin alterar bytes) | `app.ts:119` `[código]` |
| ACK persist-first: 200 solo tras persistir el evento | `deliverect.webhook.controller.ts` `[código]` |
| Dedup de eventos + backoff con descarte de veneno | `DeliveryOrderEvent` `[código]` |
| **Descuento de inventario durable** en la ingesta | `deliveryOrderIngestion.service.ts:260,276` (commit `ca6ef88c`) `[código]` |
| Motor de ruteo de impresión: `buildTicketPlans()` devuelve un plan por estación | `printRouting.engine.ts:90` `[código]` |
| Gateway designado por sucursal | `PrintGateway.venueId @unique` `[código]` |

### Roto o desconectado

| Defecto | Dónde | Consecuencia |
| --- | --- | --- |
| El core decide "pagado" leyendo `raw.orderIsAlreadyPaid`, campo **de Deliverect** | `deliveryOrderIngestion.service.ts:127` `[código]` | Ningún pedido de Uber se marcaría pagado |
| Propina contada dos veces: `total` (que ya la incluye) → `Payment.amount`, y `tip` → `tipAmount` | `:218-219` `[código]` | Ventas infladas |
| `Order.paidAmount` / `remainingBalance` quedan en 0/0 | `:122-124` `[código]` | Cuentas por cobrar incoherentes |
| El auto-accept es `void dispatch(...).catch()` — fire-and-forget fuera de la transacción | `:311` `[código]` | El "acepto" se pierde y Uber cancela por plazo vencido |
| Sin outbox: un aviso saliente fallido se loguea y se pierde | `statusDispatcher.service.ts:68` `[código]` | Cada aviso perdido cuenta contra el 99.9% exigido |
| `pushMenu` no tiene **ningún** caller | grep vacío en `src/` `[código]` | El menú nunca se publica |
| El job de reconciliación aplica el parser de Deliverect a **cualquier** evento | `delivery-webhook-reconciliation.job.ts:8,193` `[código]` | Un evento de Uber se reintenta como Deliverect |
| Las cancelaciones entrantes se marcan procesadas **sin cancelar nada** | `deliverect.webhook.controller.ts:125-153` `[código]` | Pedido cancelado en la app, cobrado en Avoqado |
| **Nadie imprime un pedido de delivery**: el server emite `ORDER_CREATED` y ninguna app lo escucha | `ingestion:287` emite; grep vacío en android/ios `[código]` | Con aceptación automática, el local nunca se entera |
| El `Payment` se crea con `method: OTHER` y **sin `tenderTypeId`** | `:222-224` `[código]` | Se pierden comisión, forma SAT y clasificación de arqueo |
| El resumen suma órdenes pendientes y canceladas como ingreso | `deliverySummary.service.ts:31` `[código]` | Ingreso ficticio en el panel |

## 3.bis 🔴 Deliverect no se toca — camino propio para Uber

**Decisión del founder (2026-08-17): la integración de Deliverect es aparte y no se modifica.**

El código está partido así `[código]`:

| Carpeta | De quién | Qué se hace |
| --- | --- | --- |
| `providers/deliverect/**` (4 archivos) | solo Deliverect | **Nada.** Congelado |
| `core/**` (7 archivos) | **compartido** — lo usa `deliverect.webhook.controller.ts:159` y `delivery-webhook-reconciliation.job.ts:194` | **Nada.** Ver abajo |
| `providers/uber-eats/**` | nuevo | Todo el trabajo de esta spec |

**Uber estrena camino propio.** No se reescribe el core compartido para que sirva a dos proveedores;
se construye el de Uber al lado, correcto desde el inicio. Consecuencias, todas deliberadas:

- Los defectos de dinero del core (propina doble, `paidAmount` en cero, `raw.orderIsAlreadyPaid`)
  **se quedan donde están**. Son de Deliverect y Deliverect está apagado — nunca se conectó, no hay
  credenciales de staging ni pedidos reales. No hay dinero en riesgo.
- El job de reconciliación **no se generaliza**: Uber tiene el suyo. Tocar el job compartido para
  hacerlo multi-proveedor es exactamente lo que se está evitando.
- Sí hay duplicación, y es el precio. A cambio: encender Deliverect algún día no rompe nada de Uber,
  y arreglar Uber no puede romper Deliverect.
- Lo único que se comparte son **tablas** (`DeliveryChannelLink`, `DeliveryOrderEvent`) y sus columnas
  nuevas son **aditivas y nullable** — no cambian el comportamiento de las filas existentes.

Si algún día hay un tercer proveedor, ahí se extrae la abstracción, con dos implementaciones reales
enfrente en vez de con una y una suposición.


## 3.ter 🔴 Coexistencia de proveedores — un canal, un camino, por venue

**El riesgo (founder, 2026-08-17):** si mañana se enciende Deliverect y además hay Uber/DiDi/Rappi
directos, **el mismo pedido puede entrar DOS veces** — una por el webhook de Deliverect (que traduce
Uber) y otra por el webhook directo. Dos órdenes, doble stock, doble ingreso. El namespace del
`externalId` (`UBER_EATS:` vs `DELIVERECT:`) NO protege de esto: son ids distintos, crearía las dos.

**La regla, obligatoria desde v1:** por venue y por marketplace, **exactamente un camino de
ingestión**. Se aplica al ACTIVAR un link (§5.6): activar `UBER_EATS` directo exige que ningún link
`DELIVERECT` activo de ese venue tenga mapeado el canal Uber Eats, y viceversa. El guard vive en el
servicio de activación, con mensaje que diga cuál link estorba. Test: activar el segundo camino del
mismo marketplace → 409 con explicación, nunca dos links vivos para el mismo canal.

Así el orden futuro es seguro: hoy Uber directo → después DiDi directo → después Rappi directo, y
Deliverect apagado o limitado a canales que nadie tiene directo.

## 3.quater Contrato de completitud — qué hace un pedido de delivery en CADA subsistema

**Principio (founder): que nada quede a medias y que ningún reporte mienta.** La forma de lograrlo
no es magia: cada subsistema tiene una regla explícita, y lo que no se pueda procesar con certeza
entra **marcado para revisión** — nunca silencioso.

| Subsistema | Regla para pedidos de delivery | Estado |
| --- | --- | --- |
| **Inventario** | Descuenta al recibir el pedido (motor durable ya conectado) | `[código]` |
| **Pagos** | `Payment` con tender del canal, `fundsFlow=EXTERNAL_RECORDED`: nunca cuenta como efectivo de cajón ni como dinero que Avoqado deposita — `tenderSemantics` es la única autoridad | `[código]` regla del repo |
| **Descuentos de Uber** | El pedido llega con la promo YA aplicada (`sub_total_promo_applied`); `promo_funding_split` dice quién la financió. Si la financió Uber, NO es descuento del venue en reportes | `[doc]` split pendiente de fixture |
| **Promociones locales de Avoqado** | **NO se aplican** a pedidos de delivery — el precio lo fijó el menú de Uber. La ingesta no llama al motor de promociones y así debe quedarse | `[código]` verificado hoy |
| **Combos** | Uber los manda como `bundled_items`. Sin mapeo estable combo→`Product.sku` el pedido entra **marcado para revisión**, no adivinado | `[doc]` mapeo abierto |
| **Referidos / lealtad** | **No aplican**: el cliente viene anonimizado (teléfono proxy, apellido inicial). No hay identidad que acreditar | `[doc]` |
| **Meseros** | `servedById` queda **nulo** — no hay mesero. Ningún reporte de desempeño por mesero debe incluirlos como "sin asignar" que ensucie promedios | `[código]` hoy ya es null |
| **Propinas** | **Configurable por venue** (founder, 2026-08-17): switch en `VenueSettings` — ¿la propina de delivery entra al pool de propinas del staff? **Default OFF** (toca dinero ⇒ conservador). Switch canónico en el dashboard; el reporte de propinas etiqueta el origen (canal vs piso) para que el corte cuadre con cualquiera de las dos elecciones | decidido |
| **Comisiones de staff** | No se generan — no hay vendedor | decisión, coherente con meseros |
| **Comisión de Uber (~30%)** | NO viene en el pedido (`total` excluye marketplace fees `[doc]`). El tender la estima si el venue la captura; la real llega por la API de reporting (fase F). **Los reportes dicen "estimada" hasta entonces — jamás la presentan como exacta** | `[doc]` |
| **Turnos / corte** | `shiftId` queda nulo. 🔴 El corte del día DEBE mostrar delivery como sección propia (bruto por plataforma, como pidió el levantamiento de Testarudo) — si el corte por turnos lo omite y el reporte del día lo incluye, al dueño "no le cuadra": ese cruce lleva test | `[código]` hoy null; regla nueva |
| **Facturación / CFDI** | Al confirmar el pedido terminado (paso 13). **Configurable por venue** (founder, 2026-08-17): switch en `VenueSettings` — ¿los pedidos de delivery entran a la factura global? **Default OFF** (riesgo de doble facturación; mismo criterio conservador que `includeInGlobal=false`). Switch canónico en el dashboard, junto al de propinas | decidido |

**El invariante que protege al dueño, y lleva tests de cruce:** el mismo peso contado por dos
reportes distintos da el mismo total. Ventas del día = ventas con turno + ventas de delivery sin
turno; total por canal = Σ `Payment` COMPLETED de ese canal; y el corte nunca mezcla dinero de
plataforma con efectivo del cajón. Un pedido que no cuadre al centavo no pasa el test.

## 4. El trabajo, en orden de dependencia

Cada paso se prueba antes de pasar al siguiente. Los pasos 0 a 2 no dependen de que Uber conteste.

### Paso 0 — Congelar una generación y capturar fixtures reales

Uber mantiene dos generaciones de la API de pedidos. Se elige **una** —confirmando con `GET pos_data`
qué espera hoy para integraciones nuevas— y todo se construye contra ella. Se capturan fixtures reales
bajo `tests/fixtures/delivery/uber/`: payload firmado crudo, respuesta de `GET order`, y la respuesta
de menú. Sin fixtures, cualquier contrato es supuesto.

**Bloqueado por:** tienda de prueba (Uber Case# 59404262, P3).

### Paso 1 — Frontera segura: lista blanca de tiendas escribibles

🔴 **Esto va primero de todo y no depende de nadie.**

`[api]` Verificado el 2026-08-17: con credenciales de sandbox, `GET /v1/eats/stores` devolvió un
comercio **real de producción** y un `PUT /menus` **modificó su menú en vivo**; apareció en su Uber
Eats Manager y se restauró desde backup. El UUID público del restaurante decodifica al mismo
`store_id`. La guía de Uber afirma aislamiento del sandbox y **no se cumple** cuando la cuenta no
tiene test store asignada.

- `UBER_WRITABLE_STORE_IDS_SANDBOX` y `..._PRODUCTION`, separadas. Vacío ⇒ **cero escrituras**.
- Se aplica en el cliente HTTP de más bajo nivel, antes de cualquier `POST/PUT/PATCH/DELETE`
  asociado a una tienda — incluidos accept, deny y cancel, resolviendo el `storeId` desde el link.
- Se revalida al encolar **y** al emitir. Al violarse: estado terminal, alerta, **cero peticiones**.
- Las lecturas quedan fuera del candado.

⚠️ **Tensión que hay que resolver antes de producción:** Uber exige 99.9% de inyección exitosa y
puede revocar el acceso por debajo del 99% `[doc]`. Si en producción esta lista bloquea un accept
legítimo por estar mal poblada, cada pedido bloqueado cuenta en contra. En producción la lista se
puebla **desde los links activos**, no a mano.

### Paso 2 — Token de aplicación

`[api]` `POST https://sandbox-login.uber.com/oauth/v2/token` con `grant_type=client_credentials`
devuelve `expires_in: 2592000` — **entero, en segundos**, 30 días. (El ejemplo de la doc muestra
`<EXPIRY_IN_EPOCH>` y es engañoso.)

`[doc]` Límite de 100 tokens/hora; el 101º invalida el más viejo. Basta un **cache en memoria con
promesa compartida** (single-flight) y renovación anticipada. Persistirlo en base de datos es mayor
que el problema del piloto.

Base URLs, nunca mezclar `[doc]`: sandbox `test-api.uber.com` + `sandbox-login.uber.com`;
producción `api.uber.com` + `auth.uber.com`.

### Paso 3 — Webhook durable

Una sola URL por aplicación `[doc]`; el payload trae `meta.user_id` (= store) y `meta.resource_id`
(= order). El orquestador: verifica firma → extrae identidad → **un INSERT atómico** con `dedupKey`
único → responde **200 con body vacío** `[doc]`, incluso si no resuelve la tienda. Todo lo demás es
asíncrono.

`DeliveryOrderEvent` gana `externalOrderId`, `dedupKey @unique`, claim/lease y estado recuperable.

🔴 **Contradicción abierta sobre la firma.** El dashboard exige una **Signing Key** dedicada al dar
de alta el webhook con `Basic HMAC` `[api]`, y ofrece además una Secondary para rotar. La
documentación pública sigue diciendo client secret `[doc]`. **No está resuelto.** Se implementa
leyendo la llave de env (`UBER_WEBHOOK_SIGNING_KEY`, ya cargada) y se confirma con el primer webhook
real; hasta entonces es un supuesto declarado, no una decisión.

### Paso 4 — Reconciliación por proveedor

El job actual aplica el parser de Deliverect a todo `[código]`. Debe reclamar la fila, resolver el
adapter por `provider` y despachar según tipo de evento, sin reinterpretar eventos de estado.

### Paso 5 — Mapper de Uber

Traduce el pedido de Uber al contrato interno. Reglas verificadas:

- `[api]` Precios en **centavos enteros**; el ÷100 vive solo aquí.
- `[api]` Títulos bajo `title.translations.en` **aunque el texto esté en español**. Buscar `es_mx`
  no encuentra nada.
- `[api]` `tax_info.vat_rate_percentage` llegó como **15** en un restaurante mexicano. No se
  sustituye por `Product.taxRate × 100` a ciegas: `Product.taxRate` es fracción (`0.16`) `[código]`,
  y publicar un IVA inventado es un problema fiscal. Se confirma con fixture antes de publicar menú.
- `[doc]` El precio de un modificador **no** viene multiplicado por la cantidad del padre.
- Dinero en `Decimal` o string decimal, **nunca `number`** — regla del repo.
- El mapper entrega el split explícito de quién cobra qué; el core no deduce nada. Si un monto no se
  puede separar con certeza, **rechaza** (400 + evento visible) en vez de estimar.

### Paso 6 — Tipo de pago del canal

Al activar el link se crea o reutiliza el `VenueTenderType` del proveedor (idempotente: si el dueño
ya lo creó a mano, se usa el suyo). Defaults: `baseMethod = OTHER` (obligado por el schema para filas
custom `[código]`), no cuenta como efectivo, no captura propina. **`commissionPercent` y
`satFormaPago` quedan vacíos** — son decisiones fiscales del venue y no se inventan; el panel las pide
con aviso visible.

La ingesta estampa `tenderTypeId` + `tenderRevision` en el `Payment`, como el cobro rápido de TPV.

### Paso 7 — Ingesta transaccional

Orden, ítems, modificadores, `Payment` y el vínculo evento→orden **nacen en la misma transacción**.
`Order.externalId` se namespacea por proveedor (`UBER_EATS:<id>`) porque el unique es por venue
`[código]` y dos proveedores pueden repetir número de pedido. `Payment.idempotencyKey` usa el unique
que ya existe (`VarChar(64)` `[código]`), con un hash de longitud fija.

### Paso 8 — Outbox para accept / deny / ready

Modelo acotado **a acciones de orden** (no menú ni pausa). Estados, lease con `claimToken`, reintento
con backoff, y plazo: `[doc]` **11.5 minutos desde el webhook** para aceptar o rechazar, o Uber
cancela.

Reclamar solo la cabeza del stream de cada pedido (`NOT EXISTS` de predecesores no terminales), o
`READY` puede salir antes que `ACCEPTED`. El repo ya tiene ese patrón en
`catalogPublicationOutbox.service.ts:391` `[código]` — se copia de ahí.

Es **at-least-once**: si un worker muere tras aplicar el efecto y antes de persistirlo, se repite.
`[doc]` Un accept sobre un pedido ya procesado devuelve `409 resource_status_conflict`, así que el
duplicado es detectable y se trata como éxito.

### Paso 9 — Serialización entre pedido nuevo y cancelación

`NEW_ORDER` y `CANCEL` del mismo pedido son filas distintas: sin lock, dos workers los procesan a la
vez y se acepta, cobra e imprime un pedido ya cancelado. Lock por
`(provider, channelLinkId, externalOrderId)`; bajo él se releen **todos** los eventos de ese pedido y
se busca un cancel pendiente **antes** de crear pago, posting o impresión.

**Prueba obligatoria con dos conexiones PostgreSQL reales**, no con mocks.

### Paso 10 — Impresión: servidor → gateway

🔴 `PrintJob` **fluye al revés** de lo que parece: el gateway crea el id y **sube su outbox local** al
server como réplica de auditoría (`print.mobile.service.ts:36` `[código]`). No existe endpoint de
descarga ni consumidor móvil: el server puede insertar filas y ningún dispositivo se entera.

Se crea `CloudPrintIntent`, **dentro de la misma transacción** que la orden, más un endpoint de
pull/claim/ack para el gateway. `PrintJob` se conserva como está.

Activar `AUTO` exige un gateway con heartbeat reciente: sin dispositivo registrado no hay a quién
imprimirle, y comprometerse con Uber a preparar algo que nadie ve es peor que rechazarlo.

### Paso 11 — Inventario completo

El motor ya es durable y ya descuenta `[código]`. Falta que la ingesta no acepte productos
desconocidos y que entregue los modificadores estructurados al motor.

### Paso 12 — Reportes sobre pagos reales

El resumen debe sumar `Payment` COMPLETED de `source = DELIVERY_PLATFORM`, con venta y propina
separadas — no `Order.total` de órdenes pendientes `[código]`.

### Paso 13 — Facturación al confirmar

`[doc]` **Uber no manda webhook de entrega.** Sus eventos son: pedido creado, cancelado, programado,
`orders.release` (el repartidor llegó a la zona — no es la entrega), tienda aprovisionada /
desaprovisionada, cambio de estado de tienda, y sustituciones resueltas. Nada más.

Por eso el estado final se **consulta**: un job lee el pedido y actúa cuando queda `FINISHED` o
`CANCELED`. Ahí se dispara la facturación y el ingreso confirmado.

### Paso 14 — Piloto de punta a punta

Webhook real → lectura del pedido → orden y pago → posting de inventario → comanda impresa →
`ACCEPT` → `READY` → reportes. Cuadrando al centavo.

## 4.bis Idempotencia — dónde y por qué

Sí, y en **cuatro lugares distintos**. No es un adorno: cada uno protege contra un reintento que
ocurre de verdad, y sin él el reintento cobra, imprime o descuenta dos veces.

| Dónde | La llave | Qué reintento protege | Sin ella |
| --- | --- | --- | --- |
| **Webhook entrante** | `dedupKey @unique` = `UBER_EATS:{event_id}` | `[doc]` Uber reintenta **hasta 7 veces** ante 5xx o timeout, y `event_id` es su identificador único documentado para deduplicar | El mismo pedido se ingiere dos veces: dos órdenes, dos cobros, doble descuento de stock |
| **Cobro** | `Payment.idempotencyKey`, con el `@@unique([venueId, idempotencyKey])` que **ya existe** `[código]` | El job de reconciliación reprocesa un evento que sí había llegado | Doble cobro. Es el incidente que originó ese unique (5 pagos duplicados, 2026-04-08) `[código]` |
| **Salidas a Uber** (accept / deny / ready) | `dedupKey` del outbox + estado con lease | El worker muere después de que Uber aplicó el efecto y antes de persistir que lo hizo | Se reenvía un accept ya aplicado |
| **Impresión** | unique por `(venue, evento causal, destino, motivo, seq)` | El intent se reclama dos veces, o el gateway reintenta | Dos comandas idénticas del mismo pedido en la misma estación |

**El sistema es *at-least-once* y se declara así.** No se puede garantizar exactly-once contra un
tercero: entre "Uber aplicó el cambio" y "nosotros lo anotamos" siempre hay una ventana. Lo que sí se
garantiza es que repetir no haga daño.

`[doc]` Para las salidas, Uber devuelve **`409 resource_status_conflict`** al aceptar o denegar un
pedido ya procesado. Eso convierte el duplicado en detectable: **un 409 se trata como éxito**, no
como error, y el evento se marca enviado.

🔴 **Supuesto abierto:** la documentación de Uber **no menciona idempotency keys ni límites de tasa**
en ningún lado — verificado en su guía de errores. Así que no sabemos si acepta un header de
idempotencia en las llamadas salientes, ni si nos va a limitar. Con un requisito de 99.9% de
inyección exitosa encima, eso hay que preguntárselo en el caso de soporte ya abierto.


## 4.ter 🔴 Aterrizaje en el modelo de datos — cómo un pedido de Uber se vuelve una Order

**La pregunta del founder (2026-08-17):** *"¿no tendríamos que planear qué pasa cuando llega la
integración con mi arquitectura de base de datos?"* — sí, y es el hueco más grande que quedaba:
Uber manda **sus** productos con **sus** ids, y nada garantiza que existan en el catálogo del venue.

### El problema central: resolver el producto

`Product` tiene tres llaves únicas por venue `[código]`: `sku`, `gtin` y `externalId`
(`schema.prisma:202-205`). El item de Uber trae `id` y `external_data` [doc]. **El vínculo depende
de quién creó el menú en Uber:**

| Cómo nació el menú en Uber | Se puede resolver | Qué hacer |
| --- | --- | --- |
| Publicado por Avoqado (`PUT /menus`) | ✅ sí — el `id`/`external_data` los pusimos nosotros desde `Product.sku` | Camino feliz |
| Cargado a mano por el dueño (Doña Simona hoy) | ❌ no — sus ids son de Uber, no de Avoqado | Requiere mapeo |

🔴 **Consecuencia dura:** para un venue cuyo menú NO publicó Avoqado, **publicar el menú deja de ser
opcional** y se vuelve prerequisito del inventario — sin vínculo no se sabe qué descontar. Alternativa
si el dueño no quiere republicar: una tabla de mapeo `(venueId, uberItemId) → productId` que alguien
llena una vez. Cuál de las dos se elige es decisión de producto, pero **una de las dos tiene que
existir antes del primer pedido con inventario.**

### Cascada de resolución (determinista, sin adivinar)

1. `Product.externalId` = `UBER_EATS:{item_id}` → si existe, ese es
2. `Product.sku` = `external_data` del item de Uber → si existe, ese es
3. Ninguno resuelve ⇒ **el pedido entra igual**, con la línea marcada y la orden `needsReview`

🔴 **Nunca resolver por NOMBRE.** "Chilaquiles" existe tres veces en un menú real; un match por texto
descuenta el stock del producto equivocado y el dueño no tiene cómo notarlo.

### Qué se llena en cada tabla

**`OrderItem`** — la buena noticia: `productId` es **nullable** `[código]`, y hay campos de snapshot
(`productName`, `productSku`, `categoryName`) pensados justo para esto. Un pedido con un producto no
reconocido **no se pierde ni se inventa**: se guarda con nombre y precio de Uber, `productId` nulo, y
queda visible para revisión.

| Campo | De dónde sale |
| --- | --- |
| `productId` | cascada de arriba, o **null** si no resuelve |
| `productName` / `productSku` | snapshot del item de Uber (sobrevive aunque el producto cambie después) |
| `quantity`, `unitPrice`, `total` | del pedido, en pesos `Decimal` (÷100 en el mapper) |
| `taxAmount` | **0** — es lo que hace hoy toda la plataforma (`order.tpv.service.ts`), no se estrena aquí |
| `originSystem` | `DELIVERY_PLATFORM` |
| `isCortesia`, `appliedDiscountId`, `orderPromotionId`, `seat`, `course` | **null / false** — no aplican: el precio lo fijó Uber y no hay mesa ni puesto |

**`OrderItemModifier`** — `modifierId` también es nullable `[código]`: mismo trato. `name` y `price`
del snapshot de Uber. ⚠️ [doc] El precio del modificador **no** viene multiplicado por la cantidad del
padre — el mapper multiplica.

**`Order`** — `servedById` y `shiftId` nulos (§3.quater), `source = UBER_EATS`,
`originSystem = DELIVERY_PLATFORM`, `externalId = UBER_EATS:{order_id}`.

### Por qué el inventario NO se rompe con esto

El motor descuenta por `productId` `[código]`. Una línea sin resolver simplemente **no descuenta** —
y eso es lo correcto: mejor no mover el almacén que moverlo mal. Pero el pedido queda marcado, así
que el hueco es **visible**, no silencioso. Ese es el contrato: lo que el sistema no entiende se ve.

**Pruebas:** item con `externalId` conocido ⇒ resuelve y descuenta · item desconocido ⇒ `OrderItem`
con `productId` null, snapshot completo, orden marcada, **cero movimiento de inventario** · dos
productos con el mismo nombre ⇒ jamás se resuelve por texto · modificador × cantidad del padre.


## 5. Lo que NO entra en la v1

Nada de esto bloquea el primer pedido. Se difiere a propósito, no por olvido:

- **Motor genérico para DiDi y Rappi.** Hacer Uber bien primero; la abstracción se extrae cuando haya
  un segundo proveedor real, no antes.
- **Outbox compartido para menú y pausa.** El outbox de v1 cubre solo acciones de orden.
- **Publicación y auto-sync de menú.** ⚠️ Con una excepción: si no existe un mapeo estable
  `item de Uber → Product.sku`, entonces una publicación inicial o una tabla de mapeo deja de ser
  opcional y se vuelve **prerequisito del inventario** — sin ese mapeo no se sabe qué descontar.
- **OAuth self-service y selección multi-tienda.** El piloto se provisiona por ops.
- **Pausa automática por pérdida de plan.** Para el piloto se opera desde Uber Eats Manager.
- **Ticket de expedición (EXPO) y KDS.** El EXPO además exige renderer en Android **e** iOS (regla
  cross-repo del workspace), así que es trabajo de tres repos.
- **Reembolso automático y reposición tras cancelación posterior a la preparación.** No se
  implementa hasta saber si Uber sigue pagando al comercio y si el producto ya se consumió. Mientras
  tanto queda visible para conciliación manual.
- **Conciliación de depósitos y comisión real de Uber.** Requiere la API de reporting.
- **Recibo del cliente.** Para producir el pedido basta la comanda. Si "que se imprima" incluye
  también el recibo, es un segundo `CloudPrintIntent` — decisión pendiente.

## 6. Separación de verdad

### Verificado contra la API real (2026-08-17)

- `expires_in = 2592000`, entero, segundos.
- `GET /v1/eats/store/{id}/status` — con **`store` en singular**; la doc lo publica en plural y da
  404. Devuelve `{status, offlineReason}` con valores como `OUT_OF_MENU_HOURS`, `PAUSED_BY_RESTAURANT`.
- `PUT /menus` con token de sandbox **modificó una tienda de producción**.
- `GET /v2/eats/order/{id}` existe y valida el formato del id.
- Menú real: precios en centavos, `title.translations.en` con texto español, IVA 15.

### Verificado en la documentación de Uber

- 11.5 min de plazo para aceptar o rechazar.
- **99.9% de tasa de inyección exitosa**; por debajo del 99%, revocación de acceso y desactivación de
  tiendas, con revisión diaria.
- No hay webhook de entrega.
- `409 resource_status_conflict` al reprocesar un pedido.
- Uber no reintenta por defecto; el reintento es responsabilidad nuestra.
- Existe `POST /v2/eats/stores/{id}/menus/items/{item_id}` con **sparse update** y `suspension_info`:
  marcar un producto agotado **no** requiere republicar el menú.
- Existe `PATCH /v2/eats/orders/{id}/cart` para comunicar falta de stock (quitar, sustituir, ajustar
  cantidad), llamable hasta que el repartidor recoge.
- Existe `store.menu_refresh_request`: Uber puede **pedir** el menú.
- Producción exige **NDA y acuerdo de licencia** antes de desarrollar, un partner manager, y una
  **sesión conjunta de pruebas end-to-end** con Uber. No es solo trámite.

### Supuestos sin verificar — hay que cerrarlos con fixture o preguntando

- Con qué llave firma Uber los webhooks (dashboard dice Signing Key, doc dice client secret).
- Si `charges.total` incluye la propina, y si `total_fee` ya suma bolsa, envío y pedido mínimo.
- Cómo se reparte `cash_amount_due` entre lo que cobra el comercio y lo que cobra para Uber.
- Qué generación de la API espera Uber hoy para integraciones nuevas.
- Cuerpos exactos de accept, deny y cancel.
- Si existe endpoint de "listo" para pedidos entregados por Uber.
- Si Uber aplica límites de tasa: **su documentación no dice nada de rate limiting ni de
  idempotencia**, y sin embargo exige 99.9% de éxito. Hay que preguntarlo.
- Por qué el IVA llegó como 15 y no 16.

## 7. Migraciones

| Qué | Para |
| --- | --- |
| `DeliveryOrderEvent`: `externalOrderId`, `dedupKey @unique`, `claimToken`, `lockedUntil` | Paso 3 |
| `DeliveryOutboundEvent` (nuevo): acciones de orden, lease, backoff, plazo | Paso 8 |
| `CloudPrintIntent` (nuevo): intención de impresión con claim para el gateway | Paso 10 |
| Vínculo `DeliveryChannelLink` → `VenueTenderType` | Paso 6 |

Aditivas. Por regla del repo, toda edición de `schema.prisma` termina con `npm run schema:map` y
`docs/SCHEMA_MAP.md` en el **mismo** commit; los modelos nuevos necesitan su entrada en
`MODEL_TO_DOMAIN` de `scripts/generate-schema-map.ts` o el script falla.

## 8. Gating

| Eje | Valor |
| --- | --- |
| Tier | `DELIVERY_CHANNELS`, PREMIUM, ya existe `[código]`. Uber es un proveedor dentro del mismo feature |
| Permisos | `:connect` SUPERADMIN (crear/activar) · `:manage` OWNER/ADMIN (modo de aceptación) · `:read` MANAGER |
| Ajuste del venue | **Modo de aceptación** (`AUTO`/`MANUAL`), default AUTO · **Propina de delivery al pool de staff**, default OFF · **Delivery entra a factura global**, default OFF — los tres por venue, desde el dashboard |
| Auditoría | `ActivityLog` en crear, activar, cambiar modo y cancelación entrante |
| MCP | `delivery_channels` expone estado del link, modo de aceptación y pendientes del outbox |

## 9. Estado del trámite con Uber

| Qué | Estado |
| --- | --- |
| App de test (`1sC9taNVAljTqMzXtif3T1SC8dZxQ5JF`) | Creada, scopes otorgados, webhook a ngrok con HMAC |
| App de producción | Creada, scopes solicitados |
| **Tiendas de prueba** | Solicitadas — **Uber Case# 59404262 / Request #739474**, P3 (acuse 4 h, resolución 48 h) |
| **NDA + licencia + partner manager** | ❌ **Sin empezar. Probablemente el camino más largo del proyecto** |

🔴 Hasta que existan tiendas de prueba: **cero escrituras** contra la API de Uber (Paso 1).
