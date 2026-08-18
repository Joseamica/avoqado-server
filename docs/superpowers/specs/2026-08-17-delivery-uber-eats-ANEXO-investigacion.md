# Delivery directo — Uber Eats primero (sin agregador)

**Fecha:** 2026-08-17 · **Versión:** 6 (v3 auditada por Codex en 3 rondas; v4 = giro a Uber Eats primero, con el contrato leído de su
documentación pública; v5 = revisión contra el código y contra el dashboard real de Uber; v6 = pruebas reales contra la API + auditoría
adversarial de Codex, 10 bloqueantes cerrados) **Repo:** `avoqado-server` · **Después:** DiDi Food, luego Rappi (specs propios, mismo motor)

> **v6 — 10 bloqueantes cerrados.** La v5 se probó **contra la API real de Uber** y luego se auditó con Codex (`gpt-5.6-sol`, esfuerzo
> `max`, solo lectura), que devolvió 26 hallazgos: **10 bloqueantes, 12 graves, 4 menores**, y veredicto "no implementable como está". Cinco
> se verificaron a mano contra el código antes de aceptarlos; los cinco eran correctos. Los bloqueantes y dónde se cierran:
>
> 1. 🔴 **El sandbox de Uber escribe en PRODUCCIÓN** — verificado: un `PUT /menus` con token de sandbox modificó el menú en vivo de un
>    restaurante real y apareció en su Uber Eats Manager (se restauró desde backup). El UUID público del comercio decodifica al mismo
>    `store_id`. **El dominio del entorno no es garantía de aislamiento** → **§5.0**, lista blanca default-deny en el cliente HTTP.
> 2. 🔴 **Error de dinero:** `remainingBalance = cashDueSale − cashDueTip` (resta) dejaba el saldo corto por `2 × cashDueTip` — se cobraba
>    de menos toda propina en efectivo. Además todo el contrato usaba `number` en vez de `Decimal` → **§5.1**.
> 3. **El outbox no garantizaba exclusión ni orden**: `SKIP LOCKED` sin `NOT EXISTS` deja salir READY antes que ACCEPTED → **§5.4**.
> 4. **`NEW_ORDER` y `CANCEL` del mismo pedido podían procesarse a la vez** → se acepta e imprime un pedido ya cancelado → **§5.5**.
> 5. 🔴 **`PrintJob` fluye al revés de como la v5 lo diseñó**: el gateway sube su outbox al server, no al revés. No existe camino
>    server→gateway → **§5.12**, `CloudPrintIntent`.
> 6. 🔴 **El unique de `PrintJob` hace imposible una comanda por estación** — y la v5 escribió una prueba que no podía pasar → **§5.12**.
> 7. **`model Refund` no existe**; el patrón real es un `Payment` negativo. Y la reposición de inventario es aproximada y best-effort →
>    **§5.7**.
> 8. **La pausa infiere éxito del código HTTP**: la prueba real devolvió 200 sin efecto → **§5.8**, `PAUSE_PENDING`.
> 9. **El binding OAuth no tenía dónde guardar el token** antes de crear el link, ni ruta multi-tienda → **§7.2**, `UberOAuthSession`.
> 10. **El mapper de menú ignoraba el fixture real**: `title.translations.en` incluso en español, IVA 15 (no 16), `Product.taxRate` es
>     fracción (`0.16`) → **§5.9**.
>
> Quedan sin cerrar los 12 graves y 3 menores del informe. Informe completo: ver auditoría Codex del 2026-08-17.

> **v5 — qué cambió, y por qué importa.** Revisión de la v4 verificando sus afirmaciones contra el código (8 de los 20 defectos de §4
> comprobados uno por uno, más sus anclas de schema: todas exactas) y contra el dashboard de Uber ya configurado. Tres correcciones:
>
> 1. 🔴 **La firma de webhooks NO usa el client secret.** El dashboard exige una **Signing Key** dedicada al dar de alta el webhook con
>    `Basic HMAC`. La v4 afirmaba lo contrario en **cinco** lugares (§6.1, §7.3, §10.1, §10.13 y el árbol de archivos), uno de ellos
>    justificando la elección de Client Secret con esa razón falsa. Implementarlo así habría dado 401 en todos los webhooks sin causa
>    aparente. **Regalo colateral:** el campo _Secondary Signing Key_ de Uber ya es la rotación con doble secreto que §5.10 iba a construir
>    a mano.
> 2. 🔴 **Un pedido de delivery no se imprime** (defecto #21, §5.12). La v4 lo daba por heredado del venue; se verificó que ninguna app
>    escucha `ORDER_CREATED` y que la impresión solo nace de la acción del mesero. Con auto-aceptación eso significa comprometerse con Uber
>    a preparar algo que el local nunca ve. **Entra a v1.**
> 3. **Dos pruebas de §9 fijaban lo contrario del diseño**: `deadlineAt` desde `placed_at` cuando §6.2 dice `receivedAt` y lo aclara
>    explícitamente, y el orden del outbox "dentro del link" cuando §5.4 dice "un stream por PEDIDO, no por link". Como §3 designa esa suite
>    como guardia de regresión, el test se habría vuelto la autoridad equivocada. Corregidas, y ambas con la condición que las hace fallar
>    si alguien revierte el diseño.
>
> Menor: la suite de delivery son 176 tests en 11 archivos, no 177.

> **v4 — por qué Uber y no DiDi.** El founder ya creó la aplicación en el Uber Developer Dashboard (`Avoqado`, TEST APP, API Suite _Eats
> Marketplace_): aplicación creada, organización vinculada, contratos firmados, **sandbox concedido**, verificación de integración
> solicitada (resultado pendiente). La afirmación de la v1–v3 de que "Uber exige NDA + partner manager y tarda semanas" venía de la
> investigación de julio y **está desactualizada**: hoy es self-serve hasta sandbox. Además la doc de Uber es **pública**, así que §10 deja
> de ser "lo que espera la doc" y pasa a ser el contrato leído, con fuente por punto. La Fase A (reparar el motor) no cambia en nada: es
> agnóstica de proveedor.

> **Qué cambió de la v1 a la v2.** La v1 afirmaba que el motor de delivery de julio era genérico y estaba listo, y que DiDi era "cinco
> funciones encima". La auditoría demostró que no: el motor tiene defectos de dinero, un acoplamiento a Deliverect y varias piezas que la v1
> daba por existentes y no existen. La v2 agrega una **Fase A de reparación del motor**, antes del adaptador de DiDi, y corrige cada
> afirmación falsa. Los hallazgos verificados están en §4. La v3 corrige lo que la segunda ronda encontró en la propia v2: la llave de
> idempotencia no cabía en 64 caracteres, `cancelOrder` no sirve para revertir un pago, el cifrado a reusar es otro, `Order.externalId`
> colisiona entre proveedores, y el outbox necesitaba claim/lease y soportar el menú.

---

## 1. Por qué

El scaffold de delivery de julio (`docs/superpowers/specs/2026-07-18-*`) se construyó contra **Deliverect**, agregador que traduce Uber Eats
/ Rappi / DiDi Food a un solo contrato. Su costo se cotiza y resultó demasiado alto para el margen del producto.

**Deliverect nunca se conectó** (según el founder: nunca hubo credenciales de staging, nunca entró un pedido). El código no lo contradice;
se toma como supuesto declarado, no verificado en producción. Consecuencia práctica: no hay clientes ni dinero en riesgo, y el motor se
puede reparar sin migrar datos vivos.

**Orden elegido (v4):** **Uber Eats primero** — sandbox ya concedido (2026-08-17), doc pública, y es la plataforma de mayor volumen en
restaurantes en México. **DiDi Food segundo** (formulario público de desarrollador en `developer.didi-food.com/es-MX`; su doc vive detrás
del registro). Rappi tercero (TAM manual). Las tres comparten el motor reparado de la Fase A; cada una es un adapter + un spec corto de
contrato.

**Estado de la app de Uber (captura del dashboard, 2026-08-17):** Application ID `1sC9taNVAljTqMzXtif3T1SC8dZxQ5JF` (test), autenticación
por **Client Secret** (Uber recomienda llave asimétrica; se puede migrar después), Access Token TTL 30 días, Redirect URI registrada:
`https://api.avoqado.io/api/v1/delivery-channels/oauth/uber/callback`, Privacy Policy `https://avoqado.io/privacy`. Pendientes en el
dashboard: Public Display Name / Description, Tech Support Email, y **configurar la URL de webhooks** (sección "Webhooks → click here") — la
URL será la de §6.1.

## 2. Alcance

**Dentro (v1):**

- Recepción de pedidos de Uber Eats → `Order` + `Payment` correctos en Avoqado.
- Publicación del menú de Avoqado → Uber Eats (Avoqado es la fuente de verdad).
- Avisos de estado hacia Uber: aceptado / rechazado / listo / cancelado, con entrega confiable (reintentos) y dentro del SLA de aceptación
  de Uber (11.5 min).
- Vinculación de la tienda del restaurante a Avoqado por OAuth (`eats.pos_provisioning`) desde el dashboard, con el callback ya registrado
  en Uber.
- Cancelación entrante **total**: la orden se cancela, el pago se revierte, el inventario se repone.
- Pausar / reanudar la tienda, con el resultado real del proveedor visible.
- **Impresión del pedido de delivery** (§5.12): hoy un pedido entra, se auto-acepta y **nadie lo imprime**. Con
  `require_manual_acceptance: false` nadie mira una pantalla, así que sin esto Avoqado se compromete con Uber a preparar un pedido del que
  el local nunca se entera.
- Reparación del motor compartido (§5), que beneficia a cualquier proveedor.

**Fuera:**

- DiDi Food y Rappi (specs propios sobre el mismo motor).
- Aceptación manual desde el POS (`OrderAcceptanceMode.MANUAL` sigue sin UI en Android/iOS). Con Uber, AUTO = `accept_pos_order` inmediato
  tras la ingesta.
- Cancelación **parcial** / `order.fulfillment_issues` (sustituciones): se registra el evento; el manejo completo se diseña con el sandbox
  (§10.6).
- Conciliación financiera de lo que Uber liquida (comisión, promos, depósito neto): se registra como fase posterior (§12); v1 registra el
  cobro bruto y lo marca como **no depositado por Avoqado**.
- KDS de delivery (pantalla de cocina). La **impresión sí entra a v1** — ver §5.12; la v4 la dejaba fuera diciendo que "hereda el
  comportamiento del venue", y esa herencia **no existe**.
- Impuesto por línea: la plataforma entera guarda `OrderItem.taxAmount = 0` hoy (`order.tpv.service.ts:434,1143`); no se resuelve aquí.

## 3. Principio rector

Decisión del founder (2026-08-17): **"arregla lo necesario para que funcione todo perfecto".** Eso reemplaza el "no toques Deliverect"
literal de la mañana. Se traduce así:

| Zona                                                      | Regla                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers/deliverect/**` (adapter, client, hmac, mapper) | No se rediseña. Se toca **solo** lo que exige el contrato reparado (§5.1: el mapper debe llenar el nuevo campo `payment`) y lo que la auditoría marcó como falso hacia afuera (§5.11: la doc OpenAPI anuncia un header que no es el que se verifica).                                   |
| `deliverect.webhook.controller.ts`                        | Se conserva. Los proveedores directos usan un orquestador nuevo (§6.2).                                                                                                                                                                                                                 |
| `core/**`, job de reconciliación, rutas, schemas, MCP     | **Se reparan.** La suite de delivery existente (176 `it/test` en `tests/unit/services/delivery-channels/`, 11 archivos) es la guardia de regresión: sigue verde en cada cambio, salvo los tests que fijaban un comportamiento incorrecto (§4 #3), que se corrigen con su justificación. |

Deliverect queda como plan B: su código funciona sobre el motor reparado y no cuesta tenerlo apagado.

## 4. Estado real del motor (verificado, no asumido)

Cada punto fue confirmado leyendo el código el 2026-08-17. Es la lista de lo que la Fase A repara.

| #      | Defecto                                                                                                                                                                          | Evidencia                                                                                                                                       | Consecuencia con Uber (o cualquier directo)                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1      | El core decide "pagado" leyendo `raw.orderIsAlreadyPaid`, un campo **de Deliverect**                                                                                             | `core/deliveryOrderIngestion.service.ts:127`                                                                                                    | Ningún pedido de Uber se marcaría pagado                                                                                       |
| 2      | La propina se cuenta dos veces: `total` (que la incluye) → `Payment.amount`, y `tip` → `tipAmount`; los reportes suman ambos                                                     | `:218-219`, `sales-summary.dashboard.service.ts:434`                                                                                            | Ventas infladas                                                                                                                |
| 3      | El `Payment` no estampa `fundsFlow` → `paymentIsAvoqadoSettled` cae al fallback y lo cuenta como dinero que **Avoqado deposita**                                                 | `tenderSemantics.ts:70`; método `OTHER` sin `tenderTypeId`                                                                                      | Saldo "por depositar" que nunca llega                                                                                          |
| 4      | `Order.paidAmount` / `remainingBalance` quedan 0/0 pagado o no                                                                                                                   | `:122-124` (documentado como pendiente)                                                                                                         | Reportes de cuentas por cobrar incoherentes                                                                                    |
| 5      | El auto-accept tiene una carrera: `dispatchOrderStatus` busca el evento por `orderId`, pero el controller escribe ese `orderId` **después** de la ingesta; el dispatch es `void` | `statusDispatcher.service.ts:49`, `ingestion:311`, `controller:185`                                                                             | El "acepto" no sale → la app cancela por timeout                                                                               |
| 6      | Solo el auto-accept llama al despachador; preparando / listo / recogido / cancelado **no están cableados**                                                                       | único caller: `ingestion:311`                                                                                                                   | La app nunca se entera del avance                                                                                              |
| 7      | Sin outbox ni reintento para avisos salientes: un fallo se loguea y se pierde                                                                                                    | `statusDispatcher.service.ts:68`                                                                                                                | Un "acepto" perdido = pedido cancelado por la app                                                                              |
| 8      | `pushMenu` no tiene **ningún** caller: no hay endpoint, ni hook, ni cron                                                                                                         | `grep` vacío en `src/`                                                                                                                          | El menú nunca se publica                                                                                                       |
| 9      | No hay transición `PENDING → ACTIVE`: crear deja PENDING y solo existe PAUSED↔ACTIVE                                                                                            | `deliveryChannelLink.service.ts:186`                                                                                                            | Un canal nunca puede activarse                                                                                                 |
| 10     | El job de reconciliación importa `parseDeliverectOrder` y lo aplica a **cualquier** evento, sin mirar `provider` ni `eventType`                                                  | `delivery-webhook-reconciliation.job.ts:8,193`                                                                                                  | Un evento de Uber que falle se reintenta como Deliverect                                                                       |
| 11     | El snapshot de menú ignora el modelo `Menu` (toma todas las categorías del venue) y no filtra grupos de modificadores inactivos                                                  | `menuSnapshot.service.ts:41-58`; `MenuCategoryAssignment` no se consulta                                                                        | Menú de desayuno y cena publicados revueltos                                                                                   |
| 12     | Pausar cambia el estado local primero y traga el error del proveedor; y un link PAUSED deja de mandar estados de pedidos ya aceptados                                            | `deliveryChannelLink.service.ts:188,219`; `statusDispatcher:59`                                                                                 | El dueño ve "pausado" y Uber sigue abierta                                                                                     |
| 13     | Las cancelaciones entrantes se persisten y se marcan PROCESSED sin cancelar nada                                                                                                 | `deliverect.webhook.controller.ts:125-153`                                                                                                      | Pedido cancelado en la app, cobrado en Avoqado                                                                                 |
| 14     | `webhookSecret` se genera aleatorio y nunca se devuelve ni se puede sustituir por el que entregue el proveedor; `config` (Json) se devuelve en todas las lecturas                | `deliveryChannelLink.service.ts:27,68,116`                                                                                                      | No hay dónde guardar credenciales de forma segura                                                                              |
| 15     | La llave de dedup usa el id de la **orden** como `externalEventId`: dos cambios de estado de la misma orden colisionan                                                           | `schema.prisma:5472,5503`                                                                                                                       | Se pierde el segundo evento de estado                                                                                          |
| 16     | El resumen de delivery suma todas las órdenes (pendientes y canceladas incluidas) como "ingreso"                                                                                 | `deliverySummary.service.ts:31`                                                                                                                 | Ingreso ficticio en el panel                                                                                                   |
| 17     | Zod acepta cualquier `DeliveryProvider` aunque no tenga adapter; pausar atrapa el error y reporta éxito                                                                          | `delivery-channels.schema.ts:9`, `statusDispatcher:24`                                                                                          | Un link de Uber sin adapter "funciona" en falso                                                                                |
| 18     | El tier gate protege solo los endpoints administrativos; el webhook y el job siguen aunque el venue pierda PREMIUM                                                               | `delivery-channels.routes.ts:74`                                                                                                                | Servicio PREMIUM gratis tras cancelar                                                                                          |
| 19     | El job corre en cada proceso sin claim de filas: dos workers pueden procesar el mismo evento; el `Payment` se protege con `count === 0` sin unique                               | `server.ts:500`, `job:130`, `ingestion:129,216`                                                                                                 | Pago duplicado bajo concurrencia                                                                                               |
| 20     | La doc OpenAPI de Deliverect anuncia `x-deliverect-hmac-sha256`; el código verifica `x-server-authorization-hmac-sha256`                                                         | `webhook.routes.ts:403` vs `deliverect.hmac.ts:14`                                                                                              | Doc pública falsa                                                                                                              |
| **21** | **Un pedido de delivery NO se imprime.** El server emite `ORDER_CREATED` pero ninguna app escucha ese evento; la impresión solo nace de la acción del mesero de enviar una ronda | `ingestion:287` emite · `grep ORDER_CREATED` vacío en avoqado-android/ios · único caller de `printRoundComandas`: `TableOrderViewModel:461,620` | Con auto-aceptación, Avoqado se compromete a preparar un pedido del que el local nunca se entera. **Verificado en v5** — §5.12 |

Lo que **sí** está bien y se conserva: contrato ACK persist-first (200 solo tras persistir, 503 solo si no se pudo persistir), HMAC con
`timingSafeEqual` (`deliverect.hmac.ts:27`), dedup por evento, backoff con descarte de veneno, ruteo del status por el link originador,
orden permiso-antes-de-feature en las rutas, permiso `delivery-channels:connect` SUPERADMIN.

## 5. Fase A — reparar el motor (independiente del proveedor; puede empezar hoy)

Cada punto cierra uno o más defectos de §4. Todo es agnóstico de proveedor.

### 5.0 🔴 Lista blanca de tiendas escribibles (cierra #22 — BLOQUEANTE, va PRIMERO)

**El incidente que la origina (2026-08-17, verificado).** Con credenciales de sandbox (`sandbox-login.uber.com` + `test-api.uber.com`),
`GET /v1/eats/stores` devolvió un comercio **de producción** que la cuenta administra. Un `PUT /v2/eats/stores/{store_id}/menus` con ese
token **modificó el menú en vivo** y el item apareció en su Uber Eats Manager; se restauró desde backup. El UUID público del restaurante en
`ubereats.com` decodifica **al mismo `store_id`**. La guía de Uber afirma _"All sandbox activity is isolated from production merchants"_ y
**eso no se cumple cuando la cuenta no tiene test store asignada**.

Conclusión de diseño: **el dominio del entorno NO es una garantía de aislamiento.** No se puede depender de "estamos en sandbox" para que
una escritura sea inofensiva.

**Contrato, default-deny:**

| Qué             | Cómo                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config          | `UBER_WRITABLE_STORE_IDS_SANDBOX` y `UBER_WRITABLE_STORE_IDS_PRODUCTION`, separadas. Vacío ⇒ **cero escrituras permitidas**, que es el estado correcto al arrancar                    |
| Dónde se aplica | En el **cliente HTTP de más bajo nivel** (`uber.client.ts`), antes de CUALQUIER `POST/PUT/PATCH/DELETE` asociado a una tienda. No en el servicio: un caller nuevo se saltaría el gate |
| Cuántas veces   | **Dos**: al encolar en el outbox y otra vez en el worker antes de emitir. La config pudo cambiar entre una y otra, y el evento pudo encolarse hace horas                              |
| Al violarse     | El evento queda `BLOCKED_SAFETY` (estado terminal), alerta a ops, y **no se emite ninguna petición HTTP**. Nunca un fallo silencioso ni un reintento                                  |
| Alcance         | Menú (`PUT /menus`), pausa (`/status`), `pos_data` (POST/PATCH/DELETE), y **también** accept / deny / cancel / `restaurantdelivery/status`                                            |

🔑 **Los endpoints de pedido también entran**, aunque su URL lleve `order_id` y no `store_id`: el adapter resuelve el `storeId` desde el
link originador y lo pasa al cliente para que el gate pueda evaluarlo. Un accept contra un pedido de una tienda real es tan destructivo como
publicar un menú.

Las lecturas (`GET`) quedan fuera del gate: son inofensivas y son justo lo que permite investigar.

### 5.1 Contrato de pago tipado (cierra #1, #2, #4)

`NormalizedDeliveryOrder` gana un bloque obligatorio:

```ts
payment: {
  currency: 'MXN' // cualquier otra ⇒ el mapper lanza (400)
  // La cuenta del comercio (bruto, antes de comisión de marketplace):
  saleAmount: number // pesos: artículos YA con la promo financiada por el comercio, IVA incluido (MX)
  merchantFees: number // pesos: cargos cobrados al cliente que se PAGAN AL COMERCIO (bolsa, envío propio, pedido mínimo, + su tax)
  tipAmount: number // pesos: propina para el comercio/su repartidor (Uber: solo DELIVERY_BY_RESTAURANT)
  // Split EXPLÍCITO de quién cobra qué — lo entrega el MAPPER, el core NO deduce nada:
  externallyPaidSale: number // pesos: parte de (saleAmount + merchantFees) que la plataforma liquida al comercio
  externallyPaidTip: number // pesos: parte de tipAmount que la plataforma liquida
  cashDueSale: number // pesos: parte de (saleAmount + merchantFees) que el comercio cobra en efectivo en persona
  cashDueTip: number // pesos: propina que se cobra en efectivo
  cashPassThroughToPlatform: number // pesos: efectivo que el comercio cobra PARA la plataforma (cargos de Uber cobrados en efectivo) — no es venta del comercio
}
// 🔴 TIPO: los siete montos NO son `number`. Son strings decimales canónicos (o `Prisma.Decimal`),
// nunca coma flotante — regla dura del repo (`critical-warnings.md`: "Money = Decimal, Never Float").
// El `number` de arriba es la forma que tenían en v5 y es un defecto: un split en flotante puede dar
// 0.1 + 0.2 !== 0.3 y romper la invariante sin que nadie lo note. El ×100 / ÷100 de Uber vive SOLO en
// el adapter (`uber.mapper.ts`), nunca en el core.
//
// PRECONDICIONES que el mapper valida ANTES de cualquier invariante (si alguna falla ⇒ 400, jamás se
// ingiere): los siete montos son finitos, >= 0, y con a lo más 2 decimales tras cuantizar. Sin esto
// los estados PAID/PARTIAL/UNPAID no son ni exhaustivos ni excluyentes: un NaN o un negativo puede
// satisfacer dos ramas a la vez o ninguna.
//
// Invariantes verificadas con igualdad EXACTA tras cuantizar a 2 decimales (no con tolerancia ±0.01:
// una tolerancia deja pasar un centavo de descuadre por pedido, que a volumen es dinero real).
// El core las verifica y rechaza (400) si no cuadran:
//   saleAmount + merchantFees === externallyPaidSale + cashDueSale
//   tipAmount               === externallyPaidTip  + cashDueTip
// Uber: merchantReceivable (= charges.total) === saleAmount + merchantFees (+ tip si Uber lo incluye — REVALIDAR EN SANDBOX);
//       cash_amount_due === cashDueSale + cashDueTip + cashPassThroughToPlatform.
// Estado (derivado SOLO de los montos explícitos, con todos los componentes ya validados >= 0):
//   cashDue      = cashDueSale + cashDueTip
//   externalPaid = externallyPaidSale + externallyPaidTip
//   cashDue === 0                        ⇒ PAID
//   cashDue  >  0  &&  externalPaid > 0  ⇒ PARTIAL
//   cashDue  >  0  &&  externalPaid === 0 ⇒ UNPAID
// Las tres ramas son exhaustivas y mutuamente excluyentes SOLO bajo las precondiciones de arriba.
```

**Lo que NO modela el contrato, a propósito:** lo que el cliente pagó a la plataforma (comisión de marketplace, cuota de servicio de Uber,
envío de Uber). Uber no lo expone en el pedido y no es dinero del restaurante. La conciliación de comisión/promos financiadas por Uber es la
fase F.

Corrección respecto a la v3/v4-borrador (auditoría Codex + doc de Uber, 2026-08-17): `charges.total` **es lo pagadero al comercio**, no lo
que pagó el cliente; `total_fee`/`bag_fee`/`delivery_fee`/ `small_order_fee` **se pagan al comercio**; `sub_total_promo_applied` es el
subtotal **después** de la promo del comercio (no el monto de la promo). El mapeo anterior invertía los tres.

- El core **deja de leer `raw`** para cualquier decisión. `raw` solo se persiste en `posRawData`.
- Semántica, alineada con la convención del cobro rápido de TPV — el único sitio de la plataforma que fija el conjunto completo de forma
  explícita (`payment.tpv.service.ts:3419-3424`: `subtotal = base`, `total = base + tip`, `tipAmount = tip`, `paidAmount = base + tip`):
  - `Order.subtotal = saleAmount`, `Order.serviceChargeAmount`/`deliveryFeeAmount` = desglose de `merchantFees` (campos que ya existen),
    `Order.tipAmount = tipAmount`, **`Order.total = saleAmount + merchantFees + tipAmount`** — semántica canónica, independiente de cómo
    agrupe cada proveedor.
  - `Payment` externo (uno, si `externallyPaidSale + externallyPaidTip > 0`): `amount = externallyPaidSale`,
    `tipAmount = externallyPaidTip`, `netAmount = amount`, `fundsFlow = EXTERNAL_RECORDED`, COMPLETED + `PaymentAllocation`.
  - PAID: `paidAmount = Order.total`, `remainingBalance = 0`, `paymentStatus = PAID`.
  - PARTIAL: `paidAmount = externallyPaidSale + externallyPaidTip`, **`remainingBalance = cashDueSale + cashDueTip`**,
    `paymentStatus = PARTIAL`; el efectivo restante se cobra en el POS con el flujo normal (es una cuenta con saldo). 🔴 **La v5 y
    anteriores decían `cashDueSale − cashDueTip` (RESTA).** Con esa fórmula el saldo pendiente queda corto por exactamente `2 × cashDueTip`:
    se le cobra de menos al cliente toda propina en efectivo, y la invariante de coherencia deja de cerrar. Corregido en v6 (auditoría
    Codex, 2026-08-17).
  - UNPAID: sin `Payment`; `paymentStatus = PENDING`, `paidAmount = 0`, `remainingBalance = Order.total`.
  - 🔴 **`cashPassThroughToPlatform` NO tiene hoy campo, asiento de caja ni pasivo** (§11 no lo crea). Mientras no exista esa contabilidad,
    un pedido que lo traiga con valor > 0 se **rechaza** (400 + evento visible + alerta): no se "estima conservadoramente". Registrar como
    venta del comercio un efectivo que es de Uber descuadra el arqueo de caja. Esto alinea §5.1 con §10.0 (que ya ordena rechazar splits
    inciertos) y corrige §10.5, que decía lo contrario.
  - **Invariante general** (vale para los tres estados): `Order.total === Σ Payment.amount + Σ Payment.tipAmount + remainingBalance`. La
    igualdad `Order.total === paidAmount` **solo** aplica a PAID — afirmarla para PARTIAL/UNPAID es un test que falla con razón.
- Regla conservadora: si el proveedor reporta efectivo por cobrar en un tipo de pedido donde su doc no lo contempla (Uber: `cash_amount_due`
  fuera de `DELIVERY_BY_RESTAURANT`), se toma **como efectivo por cobrar** (nunca como pagado) y se alerta — jamás se inventa un cobro. El
  mapper es responsable de derivar los campos y de que la invariante cuadre; si no cuadra, lanza (400) y el evento queda visible para
  revisión.
- El mapper de Deliverect llena este bloque a partir de `orderIsAlreadyPaid` / `payment.amount` / `tip` — único cambio dentro de
  `providers/deliverect/`. Los tests que fijaban `amount = total` con `tipAmount` aparte se corrigen con nota.

### 5.2 Semántica financiera (cierra #3)

- `Payment.fundsFlow = EXTERNAL_RECORDED` en toda ingesta de delivery. Test: `paymentIsAvoqadoSettled` devuelve `false` para un pago de
  delivery; el pago no aparece en saldo disponible ni genera `VenueTransaction` de depósito.
- `Payment.idempotencyKey` usa el `@@unique([venueId, idempotencyKey])` que **ya existe** en `Payment` (`schema.prisma:3706-3712`). El campo
  es `VarChar(64)` (`:3613`), así que la llave es un hash de longitud fija: `dlv:` + `sha256(provider|channelLinkId|externalOrderId)`
  truncado a 60 hex. Reemplaza el `count === 0` (#19) sin migración. Un reembolso futuro usa su propia llave (`dlvr:` + hash del evento de
  refund).
- **`Order.externalId` se namespacea por proveedor**: `${provider}:${externalOrderId}` (p.ej. `UBER_EATS:a1b2c3…`). El
  `@@unique([venueId, externalId])` de `Order` (`schema.prisma:~3260`) es por venue, y dos proveedores distintos **sí** pueden reutilizar el
  mismo número de pedido. El mapper de Deliverect adopta el mismo prefijo (`DELIVERECT:`); no hay filas históricas que migrar (supuesto §1).

### 5.3 Vínculo evento ↔ orden y "acepto" en la misma transacción (cierra #5)

`ingestDeliveryOrder(normalized, link, { eventId })` escribe `DeliveryOrderEvent.orderId` **y encola el aviso ACCEPTED (§5.4) dentro de la
misma transacción** que crea la orden. Si el proceso muere después del commit, el aviso ya está en el outbox y el job lo entrega; si muere
antes, no hay orden ni aviso. No queda ventana en la que exista la orden sin su "acepto" encolado. El controller deja de escribir el
`orderId` después.

### 5.4 Outbox de salida (cierra #6, #7, #8 en su parte de entrega)

Nuevo modelo `DeliveryOutboundEvent` (migración):

| Campo                                                   | Para                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channelLinkId`, `venueId`                              | ruteo y tenant                                                                                                                                                                                                                                                                                                                                                                |
| `kind` enum `ORDER_STATUS · MENU_PUBLISH · STORE_PAUSE` | un solo outbox para los tres tipos de salida                                                                                                                                                                                                                                                                                                                                  |
| `orderId?`, `externalOrderId?`                          | solo ORDER_STATUS                                                                                                                                                                                                                                                                                                                                                             |
| `payload Json`                                          | status a mandar / snapshot del menú / `paused: bool`                                                                                                                                                                                                                                                                                                                          |
| `dedupKey` único                                        | `${linkId}:ORDER_STATUS:${orderId}:${status}` · `${linkId}:MENU_PUBLISH:${hash}` · `${linkId}:STORE_PAUSE:${paused}:${requestId}`                                                                                                                                                                                                                                             |
| `streamKey`                                             | clave de orden y bloqueo: `order:${orderId}` para ORDER_STATUS, `menu:${linkId}` para MENU_PUBLISH, `pause:${linkId}` para STORE_PAUSE. **Un stream por pedido**, no por link: un menú fallido jamás retrasa el ACCEPTED de otro pedido, y dos pedidos no se bloquean entre sí                                                                                                |
| `sequence` (por `streamKey`, creciente)                 | entrega **en orden** dentro del stream (READY nunca antes que ACCEPTED del mismo pedido)                                                                                                                                                                                                                                                                                      |
| `state` enum `PENDING · SENDING · SENT · FAILED · DEAD` |                                                                                                                                                                                                                                                                                                                                                                               |
| `claimToken`, `lockedUntil`                             | lease: el worker toma el evento elegible de menor `sequence` de un stream con un `UPDATE … WHERE id = (SELECT id … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING` (raw SQL, atómico), poniendo `SENDING`, `claimToken`, `lockedUntil = now+60s`; si el worker muere, el lease expira y otro lo retoma. Un stream con un evento SENDING o FAILED-en-espera no entrega el siguiente |
| `attemptCount`, `nextAttemptAt`, `lastError`, `sentAt`  | backoff y descarte de veneno (mismo patrón que `DeliveryOrderEvent`)                                                                                                                                                                                                                                                                                                          |
| `deadlineAt?`                                           | ACCEPTED lleva el SLA de aceptación del proveedor (§10.5); si llega sin SENT → alerta + la orden se marca para revisión, porque el marketplace probablemente ya la canceló                                                                                                                                                                                                    |

🔴 **El protocolo de claim de la v5 no garantizaba ni exclusión ni orden** (auditoría Codex). Cuatro huecos, y el repo **ya tiene el patrón
correcto** en `catalogPublicationOutbox.service.ts:391` (predecesor con `NOT EXISTS`) y `:430` (fencing) — se copia de ahí en vez de
reinventarlo:

| Hueco                                       | Qué pasaba                                                                                                       | Cómo se cierra                                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `sequence` sin asignación atómica ni unique | Dos eventos podían recibir el mismo número                                                                       | Fila `DeliveryOutboundStream` con contador atómico (o advisory lock transaccional por stream) + `@@unique([streamKey, sequence])` |
| `SKIP LOCKED` a secas                       | El worker B **salta** el `seq=1` bloqueado y toma el `seq=2` del mismo stream: **READY sale antes que ACCEPTED** | Reclamar **solo la cabeza**: `NOT EXISTS` de predecesores no terminales en ese `streamKey`                                        |
| `claimToken` declarado pero no exigido      | Un worker con lease vencido sobrescribe al nuevo dueño y marca SENT una ejecución ajena                          | Todo acknowledgement va con `WHERE id = ? AND state = 'SENDING' AND claimToken = ?` y **verifica `count === 1`**                  |
| Timeout HTTP sin relación con el lease      | El lease expira mientras la petición sigue viva ⇒ dos workers emiten el mismo efecto                             | **Timeout HTTP estrictamente menor que el lease**, o renovación del lease durante la petición                                     |

**El sistema es _at-least-once_, y se declara así.** Si un worker muere después de que Uber aplicó el request pero antes de persistir SENT,
el siguiente lo repite. Para `accept` / `cancel` eso importa: se usa la idempotency key del proveedor si existe, o se **consulta el estado
remoto** antes de dar un duplicado por bueno. `// REVALIDAR EN SANDBOX`: no está confirmado si Uber deduplica accept/cancel repetidos — hace
falta repetir el mismo request contra una tienda **expresamente autorizada** (§5.0) y leer el estado después.

- El job `delivery-outbound-dispatch.job.ts` procesa **un evento a la vez por stream**; un fallo bloquea los siguientes del mismo stream
  hasta reintento o DEAD (que desbloquea y alerta). Streams distintos —otros pedidos, el menú, la pausa— avanzan en paralelo, con un límite
  de concurrencia por proveedor (rate limiting) para no saturar su API.
- `dispatchOrderStatus` **encola**; nunca llama al proveedor directamente.
- **Cableado desde el POS**: un servicio autoritativo `deliveryOrderLifecycle.onOrderStatusChanged (orderId, newStatus, tx)` que se invoca
  desde el punto donde `Order.status` cambia. El plan identifica esos puntos leyendo el código (dashboard / mobile / KDS / cancelación) y
  los cubre con pruebas dirigidas por sitio de llamada. Regla: **toda transición de una `Order` con `originSystem = DELIVERY_PLATFORM` a
  PREPARING / READY / CANCELLED encola su aviso, dentro de la transacción del cambio.** Nunca para otras órdenes.
- `PICKED_UP` **no** lo dispara el POS: lo reporta el marketplace (evento entrante); `COMPLETED` en Avoqado se marca al recibirlo. Estados
  de repartidor (asignado, llegando, entrega fallida) se guardan como `DeliveryOrderEvent` de tipo `status` para trazabilidad; su UI
  detallada y qué transición local disparan se fijan con la doc (§10.5), no antes.

### 5.5 Reconciliación por proveedor (cierra #10, #19)

`DeliveryOrderEvent.eventType` pasa a ser **canónico** (`NEW_ORDER` · `CANCEL` · `ORDER_UPDATED` · `STATUS` · `STORE_PROVISIONED` ·
`STORE_DEPROVISIONED`); cada adapter traduce los nombres de su proveedor en `classifyEvent(raw)`. Los valores legacy
`'order'`/`'cancel'`/`'status'` de Deliverect se mapean 1:1 (`order→NEW_ORDER`, `cancel→CANCEL`, `status→STATUS`) en una migración de datos
trivial (no hay filas en prod según §1; igual se escribe).

El job re-procesa por `getAdapter(event.provider)`: `NEW_ORDER` → `parseOrderWebhook` (Deliverect, payload completo) o `fetchOrder` (Uber,
solo ids) → ingesta; `CANCEL` → `cancelDeliveryOrder` (§5.7); `ORDER_UPDATED` → re-fetch + `needsReview` (§6.2). Reclama filas con el mismo
esquema de lease que el outbox (`claimToken` + `lockedUntil`, columnas nuevas en `DeliveryOrderEvent`, migración) antes de tocarlas.
`STATUS` se persiste y se refleja en el panel; no se "reprocesa". Un `CANCEL` **parcial** que aún no tenga handler va a DEAD con alerta y
revisión manual — jamás a PROCESSED en silencio.

🔴 **Serialización por PEDIDO, no por evento (cierra un bloqueante de la auditoría Codex).** El lease de §5.4 es por fila, y `NEW_ORDER` y
`CANCEL` del mismo pedido son **filas distintas**: nada impide que dos workers los procesen a la vez. La ventana es real y cara — se acepta,
se descuenta stock y se imprime un pedido que ya venía cancelado. Y la carrera inversa deja el `CANCEL` en `PENDING_ORDER` para siempre
aunque la orden ya se haya confirmado.

Regla: **todo evento se procesa bajo un lock serializado por `(provider, channelLinkId, externalOrderId)`** — fila de stream o
`pg_advisory_xact_lock`. Bajo ese lock:

1. Se **releen todos** los eventos de ese pedido, no solo el que despertó al worker.
2. **Antes** de crear el ACCEPTED, el `Payment`, el posting de inventario o el `CloudPrintIntent`, se busca un `CANCEL` pendiente. Si
   existe, se aplica el estado terminal y **no se encola ni la aceptación ni la impresión**.
3. Se fija **un solo orden de adquisición** (`stream → event`, nunca al revés) para que no haya deadlock entre dos workers que tomen los
   mismos dos recursos en distinto orden.

Prueba obligatoria: ambas carreras con **dos conexiones PostgreSQL reales**, no con mocks — un mock no reproduce el entrelazado que causa el
bug.

### 5.6 Activación técnica (cierra #9)

Nueva transición ops-only `PENDING → ACTIVE` (`POST /superadmin/delivery-channels/:id/activate`, permiso `delivery-channels:connect`),
atómica y con `ActivityLog`. Precondición: el adapter confirma el binding remoto con `adapter.verifyLink(link)`. Para Uber =
`store.provisioned` recibido o `GET /v1/eats/stores/{store_id}` OK (§7.2, §10.10). Para Deliverect **no hay verificación remota**: se activa
administrativamente y así queda documentado en su adapter (`verifyLink` devuelve `{ verified: false, reason: 'ADMIN_ONLY' }` y la activación
lo permite con la bandera `force` de ops). Marcar la `DeliveryActivationRequest` como CONNECTED **no** activa el link: son cosas distintas,
y así se documenta en el schema.

### 5.7 Cancelación entrante (cierra #13)

`cancelOrder` de `order.mobile.service.ts:2874` **no sirve**: rechaza órdenes PAID (`:2886-2888`) y solo cambia `Order.status`, sin tocar
`Payment` ni inventario. Se crea un servicio de compensación propio, `cancelDeliveryOrder(orderId, { reason, source })`, transaccional:

1. `Order.status = CANCELLED`, `paymentStatus = REFUNDED` si había `Payment`.
2. 🔴 **NO existe `model Refund` en el schema** — la v5 lo daba por hecho y §11 anunciaba una migración que no aplica (auditoría Codex). El
   patrón real de la plataforma (`refund.dashboard.service.ts:429`) es otro: **el `Payment` original se queda COMPLETED** y se crea un
   **`Payment` negativo** COMPLETED con `type = REFUND`; al original solo se le agrega metadata (`:485`). Marcar el original como REFUNDED
   **y además** crear el negativo produce **doble reversión**: el reporte pasa de venta neta cero a venta negativa. Entonces: `Payment`
   negativo COMPLETED, `type = REFUND`, `fundsFlow = EXTERNAL_RECORDED`, monto = `amount + tipAmount`, `idempotencyKey = dlvr:` + hash del
   evento. El original **no se toca** salvo su metadata.
3. 🔴 **La reposición de inventario no puede reusar `restockItem` como si fuera reversión exacta.** Su propia documentación admite que es
   **aproximada** (`inventoryRestock.service.ts:19`), corre **fuera de la transacción** (`refund.dashboard.service.ts:603`), es best-effort
   y **omite serializados**. Reintentar repone dos veces; con recetas recupera insumos equivocados; los seriales no vuelven. Se crea una
   **reversión durable por las líneas originales de `InventoryPosting`**, con unique por `(posting, evento)` y worker reintentable —
   revertir lo que se descontó, no recalcular lo que se cree que se descontó.
4. Encola `ORDER_STATUS CANCELLED` en el outbox **solo si la cancelación nació en el POS**; si nació en el marketplace no se le reenvía.
5. `ActivityLog ORDER_CANCELLED_BY_CHANNEL` / `_BY_POS`.

Idempotente por orden. Solo cancelación total; parcial → §10.6 y DEAD mientras tanto.

### 5.8 Pausa honesta (cierra #12)

🔴 **Un código HTTP 2xx NO es confirmación de que la tienda quedó pausada (verificado, 2026-08-17).** Se llamó
`POST /v1/eats/store/{id}/status` con `PAUSED`: devolvió **200** (no el 204 que §10.9 afirmaba) y el estado **no cambió** ni en el sandbox
ni en el Manager. Un diseño que infiere "pausado" del código de respuesta le muestra PAUSED al dueño mientras Uber le sigue mandando pedidos
— que es exactamente el defecto #12 que esta sección venía a cerrar, reintroducido por otra puerta.

- **Un solo camino: todo por el outbox.** La v5 tenía pausa manual con llamada directa y pausa por plan por outbox; §6.3 decía que toda
  salida va por outbox. Se unifica en outbox — dos caminos para el mismo efecto es dos veces la superficie de bug.
- **Estado intermedio `PAUSE_PENDING`**, que solo pasa a PAUSED al **confirmar por lectura remota** o al recibir `store.status.changed`.
  Nunca por el 2xx.
- Si el entorno no ofrece una verificación observable (hoy el sandbox no la ofrece), **la pausa se declara no soportada ahí y la UI no
  reporta éxito**. Preferible un "no puedo confirmarlo" honesto que un PAUSED falso.
- Prueba: pausar y reanudar **observando el estado**, no el status HTTP.
- **Pausa por pérdida de PREMIUM** (sistema, §5.11): no puede llamar en línea (no hay usuario esperando), así que va por el outbox
  `STORE_PAUSE`. El link **no** cambia a PAUSED hasta que el evento esté SENT; mientras tanto se persiste `suspendedReason = 'PLAN'` +
  `suspendRequestedAt` y el panel muestra "suspensión en curso". Si el outbox llega a DEAD, alerta a ops: la tienda sigue abierta y hay que
  cerrarla a mano.
- El despachador de estados trata PAUSED como ACTIVO para pedidos ya aceptados; solo DISABLED es no-op.

### 5.9 Menú real y flujo de publicación (cierra #8, #11)

🔴 **Lo que el menú REAL de Uber desmintió (fixture capturado el 2026-08-17, 109 items de un restaurante mexicano). La v5 estaba mal en tres
puntos:**

| La v5 asumía                        | El fixture real dice                                                                     | Consecuencia si no se corrige                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Títulos sin estructura fijada       | **`title.translations.en`** — Uber usa la llave `en` **aunque el texto esté en español** | El mapper busca `es_mx`, no encuentra nada, y el `PUT` sobrescribe las traducciones reales con vacío |
| §9 fijaba `vat_rate_percentage: 16` | El fixture trae **15**                                                                   | Un test que codifica 16 falla contra la realidad, o peor: se publica un IVA equivocado               |
| `Product.taxRate` vale "0 / 8 / 16" | En Prisma es **fracción decimal** (`0.16`, `schema.prisma:1597`)                         | Multiplicar por 100 a ciegas da 1600% o 0.16% según cómo se lea                                      |

Además `menuSnapshot.service.ts:19,71` **convierte `Decimal` a `number`**, que es exactamente el descuido que la regla de dinero del repo
prohíbe: el snapshot monetario va en **strings decimales**, y el `Decimal.mul(100).toDecimalPlaces(0)` vive **solo en el adapter**, nunca
antes.

🔴 **El IVA no se publica hasta entenderlo.** No se sabe por qué Uber materializa 15 para ese producto —puede ser configuración de esa
tienda, un redondeo suyo, o una convención que desconocemos—. **No se sustituye por `Product.taxRate * 100` a ciegas.** Se confirma con un
`GET → PUT → GET` controlado sobre una tienda **autorizada por §5.0** y con backup previo, más la respuesta de soporte. Publicar un IVA
inventado en el menú de un comercio es un problema fiscal, no un bug de formato.

`buildMenuSnapshot(venueId)`:

- Recorre los `Menu` activos del venue (`active`, `startDate`/`endDate`, `availableDays`, `schema.prisma:1526-1546`) y sus
  `MenuCategoryAssignment` (que solo relaciona y ordena, `:1561-1570`) — no todas las categorías del venue. `MenuCategory` tiene además su
  propio horario (`:1484-1488`); ambos viajan en el snapshot.
- Una categoría presente en varios menús se emite **una vez** (por `id`), con la unión de sus ventanas horarias.
- Filtra grupos de modificadores inactivos.
- Agrega, opcionales: `available` (por producto), `schedule` (menú + categoría), `imageUrl` (ya está). Uber exige por item `tax_info` (IVA
  incluido como `vat_rate_percentage`) y admite `suspension_info`, `nutritional_info`, `dietary_label_info`, `bundled_items` (§10.8): el
  snapshot agrega `taxRate` por producto y `available`; alérgenos/dieta y combos quedan opcionales. El snapshot **no** se declara completo
  hasta pasar el primer `PUT /menus` real en sandbox.
- Horarios en la zona del venue; el snapshot lleva `timezone`.

Flujo de publicación (v1 = **manual + al activar**; sin auto-sync):

- `POST /delivery-channels/venues/:venueId/channels/:id/publish-menu` (permiso `:manage`), encola `MENU_PUBLISH` en el outbox (§5.4) con el
  snapshot como payload y su hash en `dedupKey`.
- Al activar (§5.6) se encola automáticamente.
- `autoSyncMenu` **no tiene efecto en v1** y así se documenta en el schema y en el panel (la bandera no se muestra hasta que exista el
  mecanismo). Auto-sync es fase posterior, con `lastMenuSnapshotHash` persistido o eventos de catálogo con debounce — no se diseña aquí.
- Resultado remoto (`lastMenuSyncAt`, `lastMenuSyncError`) visible en el panel.

### 5.10 Credenciales y secretos (cierra #14)

- `DeliveryChannelLink.credentials` (`Bytes?`, migración) cifrado con la primitiva compartida `src/lib/token-encryption.ts`
  (`createTokenCipher('DELIVERY_CREDENTIALS_KEY')`) — llave propia, no la de Google Calendar. **Nunca** se selecciona en list/get; solo el
  adapter lo lee vía un accessor que descifra. Al pasar el link a DISABLED se borra (`null`) y se revoca en el proveedor si su API lo
  permite.
- `webhookSecret` se puede **proveer** al crear/actualizar (input opcional, SUPERADMIN) para el caso "el proveedor entrega el secreto"; si
  no, se genera y se **devuelve una sola vez** en la respuesta de creación para el caso "Avoqado entrega el secreto al proveedor".
- `config` queda solo para datos no sensibles (mapa channelId→OrderSource, etc.).
- Rotación: `PATCH .../rotate-secret` con ventana de doble secreto (`previousWebhookSecret`, `previousSecretValidUntil`). ⚠️ **Esto es para
  proveedores SIN rotación nativa.** Uber ya la ofrece (campo _Secondary Signing Key_ en su dashboard, §7.3), así que su adapter no usa este
  mecanismo: las dos llaves viven en env y el server acepta ambas mientras dure la ventana. No construir la rotación manual pensando en
  Uber.

### 5.11 Higiene (cierra #15, #16, #17, #18, #20)

- `DeliveryOrderEvent` gana `externalOrderId` (migración); `externalEventId` pasa a ser el id del **evento** del proveedor. Si el proveedor
  no lo da, la clave determinista la construye **el mapper de ese proveedor** a partir de campos **firmados y estables entre reintentos**
  (id de orden + tipo + estado + timestamp del payload) — nunca la hora de recepción.
- `deliverySummary`: ingreso = suma de `Payment` COMPLETED de delivery; propinas aparte; pedidos pendientes y cancelados contados pero no
  sumados.
- Zod valida el enum `DeliveryProvider` (shape); el **servicio** `createChannelLink` rechaza con 400 un proveedor sin adapter registrado
  (`hasAdapter(provider)`). Sin acoplar el schema al registry (evita import circular y validación dependiente de runtime).
- Pérdida de PREMIUM: un job horario detecta links ACTIVE de venues sin acceso al feature y les aplica la pausa por sistema (§5.8:
  `STORE_PAUSE` por outbox, `suspendedReason = 'PLAN'`). El webhook **sigue ingiriendo** los pedidos que lleguen (nunca se tira un pedido
  real): los anteriores a `suspendRequestedAt` son "en vuelo"; los posteriores se ingieren igual pero se marcan `receivedWhileSuspended` y
  disparan alerta si pasan de N — es la señal de que la pausa remota no surtió efecto. El panel muestra "pausado por plan" con CTA al plan.
- Doc OpenAPI de Deliverect (`webhook.routes.ts:403`): corregir el nombre del header al que el código verifica.
- Replay: el orquestador (§6.2) exige un timestamp firmado del proveedor con tolerancia (±5 min, ajustable por adapter) y rechaza fuera de
  ventana; el dedup durable por `externalEventId` cubre el resto. Uber **no** documenta timestamp firmado (§10.1): el dedup durable por
  `event_id` es la defensa y así se declara.
- `ActivityLog` sigue siendo fire-and-forget fuera de la transacción **por regla del repo** (`critical-warnings.md`: nunca dentro de un
  `$transaction`); se acepta y no se cambia aquí.

### 5.12 Impresión del pedido de delivery (defecto #21 — nuevo en v5)

**El hallazgo, verificado el 2026-08-17.** La v4 dejaba la impresión fuera del alcance diciendo que "hereda el comportamiento del venue".
Esa herencia no existe:

| Eslabón                                       | Estado real            | Evidencia                                                                                                      |
| --------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| El server crea la `Order`                     | ✅                     | `deliveryOrderIngestion.service.ts`                                                                            |
| El server emite `ORDER_CREATED` por Socket.IO | ✅ tras la transacción | `:287`                                                                                                         |
| Alguna app escucha ese evento                 | ❌ **cero**            | `grep ORDER_CREATED` en avoqado-android y avoqado-ios: sin resultados                                          |
| Algo dispara la impresión                     | ❌                     | único caller de `printRoundComandas`: `TableOrderViewModel:461,620` — la acción del mesero de enviar una ronda |
| El server imprime                             | ❌ no imprime          | solo rutea (`printing/printRouting.engine.ts`) y configura; el papel sale desde el cliente                     |

Consecuencia con `require_manual_acceptance: false`: el pedido entra, Avoqado responde `accept_pos_order`, y **en el local nadie se
entera**. No es un riesgo teórico — es el estado de hoy, y lo confirmó de forma independiente el levantamiento operativo de Testarudo Café
(2026-08-17): _"el sonido de la impresora es la alerta real que activa a los baristas, no la pantalla"_.

**El diseño no inventa nada: conecta delivery a lo que ya existe.**

- `PrintStation` (áreas), `Printer`, y la cascada `Product.printStationId ?? MenuCategory.printStationId ?? default del venue`
  (`printRouting.engine.ts:69`) ya resuelven a qué estación va cada línea.
- `buildTicketPlans()` (`:90`) ya devuelve **N planes, uno por estación** — un pedido con una cerveza y una hamburguesa se parte solo en dos
  comandas. Delivery no necesita ruteo propio.
- `PrintGateway` (`venueId @unique`) ya designa **un** dispositivo broker por sucursal. Esto es lo que evita el bug obvio: si todas las
  tablets escucharan el socket, cada una imprimiría su copia.

🔴 **Lo que la v5 diseñó mal, y por qué (auditoría Codex, 2026-08-17).** La v5 decía "el server encola `PrintJob` y el gateway los consume
por su camino normal". Es falso por **dos** razones independientes, ambas verificadas en el código:

| Error de la v5                                    | Realidad                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PrintJob` sería una cola server→gateway          | Va **al revés**: el gateway crea el `id` y **sube su outbox local** al server como réplica de auditoría (`print.mobile.service.ts:36`, comentario literal: _"Solo el gateway DESIGNADO del venue puede replicar su outbox"_; Android lo declara igual en `PrintJobModels.kt`). **No hay endpoint de descarga, ni socket de nuevo job, ni consumidor móvil.** El server puede insertar filas y ningún dispositivo se entera |
| Un `PrintJob` por estación con el mismo `eventId` | Imposible: `@@unique([venueId, eventId, reason, seq])` (`schema.prisma:14099`). Cocina y barra colisionan con `reason=ORIGINAL, seq=1`; EXPO también. `seq` está reservado para original/reimpresión, **no** para numerar destinos                                                                                                                                                                                         |

La prueba que la v5 escribió —_"un pedido con dos estaciones genera dos `PrintJob` distintos"_— **no podía pasar** con el schema actual. Un
test imposible es peor que ninguno: da falsa cobertura.

**El diseño corregido (v6):**

- **`CloudPrintIntent`** (modelo nuevo, migración): la intención de impresión que nace en el server. Se inserta **dentro de la misma
  transacción** que crean la `Order` y el ACCEPTED del outbox — no después del commit, porque un crash entre commit y encolado pierde la
  impresión para siempre, que es justo el fallo que esta sección existe para evitar.
- Un intent **por destino**, con `destinationKey` = `STATION:<id>` · `UNROUTED` · `EXPO`, y `causalEventId` separado del destino. Unique:
  `(venueId, causalEventId, destinationKey, reason, seq)`. Así dos estaciones y el EXPO conviven sin colisionar, y `seq` conserva su
  significado real.
- El **gateway designado los reclama**: endpoint de descarga con claim/lease + un socket-nudge como optimización de latencia (nunca como
  único camino — un nudge perdido no puede perder la comanda). Al reclamarlos, el gateway los persiste en su outbox local y **`PrintJob`
  sigue siendo lo que ya es**: la réplica del resultado físico que el dispositivo sube de vuelta.
- 🔴 **Activar AUTO exige un gateway con heartbeat reciente.** Sin ningún dispositivo registrado, no hay fail-open posible: el fail-open de
  `offline-first-y-hub-lan.md` §4 aplica cuando un POS **ya está intentando imprimir**; no puede invocarse cuando no hay nadie escuchando.
  Un venue sin gateway no debe poder quedar en aceptación automática, o Avoqado se compromete con Uber a preparar pedidos que nadie verá.
- `PrintJob` no gana `channelLinkId`, así que el conteo "fallidos por link" del MCP se resuelve por `CloudPrintIntent`, que sí conoce el
  pedido y el canal.

Nada de esto es específico de Uber: cualquier pedido de cualquier canal lo hereda.

**Ticket de expedición (`PrintJobType.EXPO`).** Hoy ese valor del enum existe y **no lo usa nadie** (`grep` vacío en server y en las dos
apps). Se implementa aquí: un ticket con el pedido **completo** para quien lo arma y se lo entrega al repartidor — necesario justo porque
las comandas salen partidas por estación.

🔴 **El enum del server NO es la implementación.** Que `PrintJobType.EXPO` exista en Prisma no imprime nada: hace falta un **renderer** que
convierta el intent en ESC/POS, y ese vive en los clientes. Por la regla cross-repo del workspace (android e iOS se cambian JUNTOS), el EXPO
exige renderer **y** pruebas en **avoqado-android y avoqado-ios en el mismo trabajo**. Sin eso, prender el switch produce un intent que
nadie sabe dibujar y el ticket nunca sale — un fallo silencioso peor que no tener la función. Esto convierte al EXPO en trabajo de tres
repos, no solo del server, y así debe planearse.

| Eje                   | Valor                                                                                                                | Por qué                                                                                                                                                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tier                  | `DELIVERY_CHANNELS` PREMIUM heredado                                                                                 | es parte del feature, no uno nuevo                                                                                                                                                                                                                                                                                                  |
| Comandas por estación | **sin switch** — core                                                                                                | no hay dos clientes reales que quieran lo contrario: un pedido que entra tiene que llegar a producción                                                                                                                                                                                                                              |
| Ticket de expedición  | **switch por sucursal** en `VenueSettings`                                                                           | sí hay dos casos opuestos reales: Testarudo (una barra) no lo quiere; un restaurante con barra + cocina lo necesita para juntar las partes                                                                                                                                                                                          |
| Default del switch    | **derivado UNA vez al conectar el primer canal**: ON si el venue tiene ≥2 `PrintStation` activas, OFF si tiene 0 o 1 | decisión de quien implementa (no toca dinero/fiscal/permisos/stock, así que no se consulta). Un default fijo se equivoca con la mitad de los clientes; derivarlo del número de estaciones acierta en ambos y sigue siendo editable. Se calcula una sola vez y no se reevalúa, para que el sistema nunca pise lo que el dueño eligió |
| Dónde se prende       | dashboard, junto a los canales (§ Fase D)                                                                            | switch canónico en el dashboard, por regla del repo                                                                                                                                                                                                                                                                                 |
| Permiso               | `delivery-channels:manage`                                                                                           | mismo que pausar y publicar menú                                                                                                                                                                                                                                                                                                    |
| MCP                   | el tool `delivery_channels` expone `expoTicketEnabled` y el conteo de `PrintJob` fallidos por link                   | regla de lockstep del repo                                                                                                                                                                                                                                                                                                          |

**Reglas que no se negocian, heredadas de `offline-first-y-hub-lan.md` §4:**

- 🔴 **Ningún guard de configuración delante de la impresión.** Sin estaciones configuradas, sin gateway registrado, o con la config vieja:
  se imprime igual por el camino fail-open ("SIN ESTACIÓN"). En este dominio el fail-safe **no puede ser no imprimir** — ese guard ya dejó a
  un local sin comandas una vez.
- **Un `PrintJob` que no llega a DONE tiene que gritar.** Con auto-aceptación el papel es la única señal, así que `FAILED`/`UNCERTAIN` sobre
  un pedido de delivery genera alerta a ops y marca el pedido en el panel. Es el punto único de falla que levantó el operador; que exista el
  ticket no basta si nadie se entera de que no salió.
- La impresión **nunca** tumba la ingesta: se encola después del commit, como el socket.

**Referencia de mercado (buscada en vivo, 2026-08-17).** [Fudo](https://soporte.fu.do/es/articles/11730988-areas-de-impresion-cocinas)
(nativo LatAm) modela "áreas de impresión (cocinas)" con Cocina y Barra por default, y cada impresora tilda a qué áreas sirve; el producto
define el área. [Parrot](https://parrotsoftware.com.mx/blog/como-integrar-uber-eats-rappi-didi-restaurante) (referente MX en delivery) mete
los pedidos de Uber/Rappi/DiDi al mismo flujo, "sin captura manual ni tablets extra". Square hace lo mismo ("same printer, same workflow");
[Toast](https://support.toasttab.com/en/article/My-restaurant-isn-t-receiving-third-party-orders) es el único que configura los terceros
**por dispositivo** (Device Setup → Ticket Display Options). 🔑 **En ninguno el dueño elige un aparato**: configura áreas y qué sale en cada
una. Se adopta ese patrón — la pregunta "¿por POS o por venue?" no debe llegarle al usuario.

**Pruebas:** un pedido de delivery con líneas de dos estaciones genera **dos `CloudPrintIntent` con `destinationKey` distinto** (la v5 decía
"dos `PrintJob` distintos" y era una prueba **imposible**: el unique del schema lo prohíbe) · los intents se crean **dentro de la misma
transacción** que la orden — un rollback no deja intents huérfanos y un crash post-commit no pierde la impresión · un venue **sin gateway
con heartbeat reciente** no puede quedar en AUTO · la misma ingesta reintentada no duplica jobs (unique por `eventId`) · venue sin
estaciones → igual se encola un job "SIN ESTACIÓN" (jamás cero) · switch OFF → no hay job `EXPO` y las comandas salen igual · job `FAILED`
sobre delivery → alerta · el `EXPO` lleva el pedido completo, no el parcial de una estación.

### 5.13 🔴 Un pedido de delivery desencadena TODO (decisión del founder, 2026-08-17)

**El requisito, en sus palabras:** _"si llega algo por Uber Eats y no tienen el método de pago Uber Eats, que se cree solo — y reportes,
impresión del recibo, inventarios, TODO se desencadene."_

Traducido a regla de diseño: **un pedido de delivery es una venta del venue como cualquier otra.** No un caso especial que llega a medias.
Si algo de la plataforma reacciona ante una venta de mostrador, tiene que reaccionar igual ante una de Uber.

**Estado real hoy (verificado, no asumido):**

| Consecuencia de una venta     | ¿Se dispara con delivery?            | Evidencia                                                                                                                                                                             |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Descuento de inventario       | ✅ **sí**                            | `deliveryOrderIngestion.service.ts:260,276` — `createSalePostingInTx` + `applySalePosting`; commit `ca6ef88c` "los pedidos de agregador descuentan inventario (paridad Toast/Square)" |
| Se crea `Payment`             | ✅ sí, si el proveedor confirmó pago | `:218` — gateado por `orderIsAlreadyPaid`                                                                                                                                             |
| Resumen por canal             | ✅ parcial                           | `deliverySummary.service.ts`, agrupa por `Order.source` — solo HOY y solo bruto                                                                                                       |
| **Tipo de pago del catálogo** | ❌ **NO**                            | `grep tenderTypeId` en la ingesta: **0**. El `Payment` se crea con `method: PaymentMethod.OTHER` y `externalSource: 'UBER_EATS'`, **sin `tenderTypeId`** (`:222-224`)                 |
| Comanda a estaciones          | ❌ no                                | §5.12 (defecto #21)                                                                                                                                                                   |
| Recibo del pedido             | ❌ no                                | `PrintJobType.RECEIPT` existe; nadie lo dispara para delivery                                                                                                                         |

**Qué se pierde exactamente por no estampar el tender type.** `VenueTenderType` no es una etiqueta bonita: es donde viven cuatro semánticas
de dinero (`schema.prisma:3756-3773`), y un `Payment` sin él las pierde todas:

| Campo del tender       | Qué decide                         | Sin él                                                  |
| ---------------------- | ---------------------------------- | ------------------------------------------------------- |
| `commissionPercent`    | la comisión del canal (Uber ≈ 30%) | el margen real del pedido no se registra en ningún lado |
| `satFormaPago`         | la forma de pago del catálogo SAT  | al timbrar el CFDI no hay forma de pago que declarar    |
| `countsAsPhysicalCash` | si entra al arqueo de caja         | el cierre de turno no sabe clasificarlo                 |
| `captureTip`           | si admite propina                  | —                                                       |

Y en los reportes el pedido aparece como **"OTHER"** genérico en vez de "Uber Eats", que es precisamente lo que el catálogo de tipos de pago
existe para evitar.

**El diseño: auto-provisión al activar el canal.**

- Al pasar un `DeliveryChannelLink` a ACTIVE (§5.6), el sistema **crea o resuelve** el `VenueTenderType` del canal con `normalizedName`
  derivado del proveedor (`uber eats`, `rappi`, `didi food`). Idempotente: si el venue ya lo creó a mano, se **reusa el suyo** — jamás se
  duplica ni se pisa lo que el dueño configuró.
- Defaults al crearlo: `baseMethod = OTHER` (obligado por el schema para filas custom), `countsAsPhysicalCash = false` (el dinero no entra
  al cajón), `captureTip = false` (la propina la liquida la plataforma), `commissionPercent` y `satFormaPago` **vacíos** — son decisiones
  fiscales y comerciales del venue, y **inventarlas es peor que dejarlas en blanco**. El panel las pide con un aviso visible.
- La ingesta estampa `tenderTypeId` + `tenderRevision` en el `Payment`, igual que el cobro rápido de TPV, para que el snapshot de comisión y
  forma SAT quede congelado en el momento del cobro.
- 🔴 **Esto se hace SIN preguntarle al founder cada vez.** Por la regla del repo (`feature-gating.md`): _"un feature cuyo único switch es un
  `UPDATE` en Postgres está incompleto — deja al founder de switch humano para cada cliente que lo pida"_. Que el dueño tenga que crear el
  tipo de pago a mano antes de recibir su primer pedido es exactamente ese defecto.

**Lo que falta y no se inventa aquí:** el recibo del pedido (`PrintJobType.RECEIPT`) sigue sin disparador — se resuelve con el mismo
`CloudPrintIntent` de §5.12, con `destinationKey` propio. Y el resumen por canal debe pasar de "hoy y bruto" a cruzarse con la comisión del
tender.

**Pruebas:** activar un canal en un venue sin tipos de pago crea el del proveedor · activarlo en un venue que ya lo tenía **reusa el
existente y no lo modifica** · un pedido ingerido estampa `tenderTypeId` y `tenderRevision` · el reporte por método de pago muestra "Uber
Eats", no "OTHER" · desactivar el canal **no borra** el tipo de pago (hay ventas históricas apuntando a él).

## 6. Fase B — adaptador de Uber Eats

Fuente de todo lo que sigue: documentación pública de Uber, leída en vivo el 2026-08-17 (URLs en §10). Lo que la doc no fija con claridad va
marcado `// REVALIDAR EN SANDBOX`.

### 6.1 Archivos y rutas

```
src/services/delivery-channels/providers/uber-eats/
├── uber.adapter.ts     implementa DeliveryProviderAdapter (+ verifyLink, classifyEvent, fetchOrder)
├── uber.client.ts      HTTP saliente + token client_credentials PERSISTIDO (§7.1)
├── uber.auth.ts        OAuth authorization_code `eats.pos_provisioning` + callback + pos_data
├── uber.signature.ts   X-Uber-Signature: HMAC-SHA256 hex del body crudo con la Signing Key
└── uber.mapper.ts      GET order → NormalizedDeliveryOrder (con `payment`) · MenuSnapshot → PUT menus

src/services/delivery-channels/core/
└── directWebhookOrchestrator.ts   ACK genérico para proveedores DIRECTOS (§6.2)

src/controllers/delivery-channels/
└── uber.webhook.controller.ts     ~20 líneas: llama al orquestador con el adapter de Uber
```

Registry (`statusDispatcher.service.ts:20`): `[DeliveryProvider.UBER_EATS]: uberAdapter`.

Rutas nuevas:

```
POST /api/v1/webhooks/delivery/uber                       ← UNA sola URL por app (así lo configura Uber)
GET  /api/v1/webhooks/delivery/uber/health
GET  /api/v1/delivery-channels/oauth/uber/start?venueId=…  ← inicia el OAuth (permiso :connect / :manage, §7.2)
GET  /api/v1/delivery-channels/oauth/uber/callback          ← ya registrada en el dashboard de Uber
```

**Diferencia clave con Deliverect:** Uber **no** manda el webhook a una URL por tienda. Es una URL por aplicación, y el payload trae
`meta.user_id` (= `store_id`) y `meta.resource_id` (= `order_id`). Por eso la URL no lleva `:channelLinkId`: el orquestador resuelve el link
por `provider = UBER_EATS` + `externalLocationId = store_id` del payload **firmado**. Y la firma no usa un secreto por link sino la
**Signing Key de la aplicación** (env `UBER_WEBHOOK_SIGNING_KEY`); `DeliveryChannelLink.webhookSecret` no aplica a Uber (queda
`null`-equivalente/ignorado y así se documenta).

🔴 **La Signing Key NO es el client secret** (corregido en v5 con evidencia del dashboard, 2026-08-17). Al dar de alta el webhook con
`Authentication Type = Basic HMAC`, el dashboard de Uber pide un campo **Signing Key** propio y obligatorio, que lo genera el integrador —
es un secreto dedicado a firmar lo que Uber nos **manda**, distinto del client secret con el que nosotros **llamamos** a Uber. Las v1–v4
afirmaban lo contrario en cinco lugares; implementarlo así habría dado 401 en todos los webhooks sin causa aparente. Valor generado con
`openssl rand -hex 32` (64 hex) y ya cargado en el `.env` local.

El webhook va bajo el mismo `express.raw({ type: 'application/json' })` ya montado (`app.ts:120-125`).

### 6.2 Orquestador de webhook para proveedores directos

Un módulo, no un controller: `handleDirectWebhook({ rawBody, headers, adapter })`. DiDi y Rappi lo reutilizarán; el controller de Deliverect
**no** se migra. Máquina, en orden:

1. `Buffer.isBuffer(rawBody)` → si no, 503 (mal montaje, no firma).
2. `adapter.verifySignature(rawBody, headers)` → 401 si falla. **Antes** de resolver el link, porque la identidad de la tienda viene dentro
   del payload y sin firma válida no se confía en él.
3. `adapter.extractIdentity(rawBody)` → `{ storeId, eventType, eventId, resourceId }`.
4. Link por `provider + externalLocationId = storeId` (lectura; puede ser null).
5. **Un solo INSERT atómico** de `DeliveryOrderEvent` con `dedupKey` (`@unique`, columna nueva, migración) = `UBER_EATS:${event_id}` — Uber
   documenta `event_id` como identificador único para deduplicar — más `externalOrderId`, `eventType` **canónico** (§10.0), `channelLinkId`
   (o null), `venueId` (o null), `payload`, `receivedAt`, y estado inicial según el link: `RECEIVED` (link ACTIVE / PENDING+sandbox /
   PAUSED, este último marcado `receivedWhileSuspended`) · `UNRESOLVED_STORE` (sin link) · `IGNORED` (link DISABLED, terminal). Violación
   del unique ⇒ duplicado. Dedup y persistencia son la **misma** operación: no hay ventana entre "¿lo tengo?" y "guárdalo". Funciona con
   `channelLinkId` null (el `@@unique` compuesto actual no deduplica con null en Postgres).
6. **Responder 200 con body vacío ya** (Uber lo pide así), en todos los casos anteriores incluido duplicado, `UNRESOLVED_STORE` e `IGNORED`
   (reintentar no aporta). Todo lo que sigue es asíncrono. **El camino principal es el job durable** (§5.5, lease); el `setImmediate` en el
   mismo proceso es solo una optimización de latencia que toma el mismo lease.
7. `UNRESOLVED_STORE`: el job lo re-resuelve durante 30 min (carrera con `store.provisioned`; Uber no garantiza orden entre eventos); si
   sigue sin link → alerta a ops y queda `DEAD`.
8. Procesamiento por `eventType` canónico:
   - `NEW_ORDER` (`orders.notification` **y** `orders.scheduled.notification`) → `adapter.fetchOrder(link, resourceId)` (GET, §10.3) →
     mapper → `ingestDeliveryOrder` (`isScheduled` + `estimated_ready_for_pickup_at` como **estimación**, no como hora programada fija; se
     refresca en cada re-fetch) → (AUTO) outbox `ACCEPTED` con **`deadlineAt = receivedAt + 11.5 min`** (el SLA corre desde el webhook, no
     desde `placed_at`).
   - `CANCEL` (`orders.cancel` / `orders.failure`) → `cancelDeliveryOrder` (§5.7). Si la orden aún no existe (cancel llegó antes que la
     notificación), el evento queda `PENDING_ORDER` y se aplica al terminar la ingesta de esa orden.
   - `ORDER_UPDATED` (`order.fulfillment_issues.resolved`) → **re-fetch** de la orden (Uber indica volver a leerla) → **v1 NO muta la
     orden**: persiste el snapshot nuevo, marca la orden `needsReview` con el diff (artículos y montos) y alerta al panel/ops. La
     reconciliación transaccional (artículos + `Payment` + inventario) es fase posterior; a medias sería peor que no hacerla.
   - `STATUS` (`orders.release`, `store.status.changed`) → se persisten; visibles en el panel.
   - `STORE_PROVISIONED` / `STORE_DEPROVISIONED` → actualizan el link (§7.2).

**Por qué difiere de Deliverect:** allá el webhook trae el pedido completo y se parsea antes de responder; acá trae solo ids y hay que ir
por el pedido a la API. Persistir-primero se conserva (el 200 sale solo con el evento guardado); la ingesta se mueve detrás del ACK.

### 6.3 Flujo de salida (todo por el outbox, §5.4)

| Acción                           | Endpoint de Uber                                                                                                                                                                                                                           | Notas                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Aceptar                          | `POST /v1/eats/orders/{order_id}/accept_pos_order`                                                                                                                                                                                         | body `{ reason, external_reference_id }` `// REVALIDAR EN SANDBOX` (la página de referencia no se pudo leer sin JS); `external_reference_id` = `Order.orderNumber` de Avoqado |
| Rechazar (MANUAL futuro / stock) | `POST /v1/eats/orders/{order_id}/deny_pos_order`                                                                                                                                                                                           | body con `reason` `// REVALIDAR`                                                                                                                                              |
| Cancelar desde el POS            | `POST /v1/eats/orders/{order_id}/cancel`                                                                                                                                                                                                   | motivos enumerados `// REVALIDAR`                                                                                                                                             |
| Listo para recoger               | `// REVALIDAR EN SANDBOX`: la doc lista `POST /v1/eats/orders/{order_id}/restaurantdelivery/status` para entrega propia; para `DELIVERY_BY_UBER` hay que confirmar si existe un "ready" o si Uber solo usa `estimated_ready_for_pickup_at` | READY se encola igual; el adapter decide el endpoint por `order.type`                                                                                                         |
| Publicar menú                    | `PUT /v2/eats/stores/{store_id}/menus`                                                                                                                                                                                                     | reemplaza el menú completo (idempotente, ideal para `MENU_PUBLISH`)                                                                                                           |
| Pausar / reanudar                | `POST /v1/eats/store/{store_id}/status` `{ status: 'PAUSED'                                                                                                                                                                                | 'ONLINE', reason, paused_until? }` → 204                                                                                                                                      | scope `eats.store.status.write`; ojo: path **singular** `store` |
| Verificar binding                | `store.provisioned` recibido + `GET /v1/eats/stores/{store_id}` OK                                                                                                                                                                         | §7.2                                                                                                                                                                          |

Scopes por token `client_credentials`: `eats.store` (menú/tienda), `eats.store.status.write`, `eats.order` (accept/deny/cancel),
`eats.store.orders.read` (GET orden v2).

## 7. Autenticación y binding de tienda (Uber)

### 7.1 Token de aplicación — se PERSISTE, no se cachea en memoria

`POST https://auth.uber.com/oauth/v2/token` (sandbox: `https://sandbox-login.uber.com/…`) con `grant_type=client_credentials`, `client_id`,
`client_secret`, `scope=…`. TTL **30 días**. Límite: **100 tokens/hora, y al generar el 101º Uber invalida el más viejo**. Con varios
procesos (web + jobs) y reinicios, un cache en memoria como el de `deliverect.client.ts:65` quemaría tokens y podría invalidar el que otro
proceso está usando. Por eso el token vive en DB, cifrado
(`DeliveryProviderCredential { provider, environment ('SANDBOX'|'PRODUCTION'), clientId, scopeSet (canónico: ordenado, separado por espacio), token Bytes, expiresAt }`,
`@@unique([provider, environment, clientId, scopeSet])`, migración; cifrado con `createTokenCipher('DELIVERY_CREDENTIALS_KEY')`), con
renovación única bajo `pg_advisory_lock` y margen de 24 h. Un solo token compartido por toda la app por (entorno, cliente, scopes); sandbox
y producción **nunca** comparten token.

Base URLs por entorno: `UBER_API_URL` = `https://test-api.uber.com` (TEST APP) / `https://api.uber.com` (PROD); `UBER_AUTH_URL` =
`https://sandbox-login.uber.com` / `https://auth.uber.com`. **Nunca mezclar** (la doc avisa: fallan las autenticaciones).

### 7.2 Binding de la tienda — OAuth `eats.pos_provisioning`

🔴 **El flujo de la v5 no era implementable (auditoría Codex). Tres defectos y una contradicción:**

1. **No hay dónde guardar el estado intermedio.** El paso 2 guarda el token del comerciante en `link.credentials`, pero el link **se crea
   hasta el paso 5** — después de elegir tienda y escribir `pos_data`. Y `DeliveryChannelLink` exige `externalLocationId` desde su creación
   (`schema.prisma:5417`), que es justo el dato que todavía no se conoce. El callback no tiene dónde dejar el token.
2. **No existe ruta para el caso multi-tienda.** El paso 3 dice "si hay varias, el dashboard pide elegir", pero no hay endpoint que liste ni
   que confirme la elección.
3. **El `state` no está especificado como single-use ni ligado al usuario que inició.** Sin eso, un `state` reutilizado o robado puede atar
   la tienda de un comerciante al venue equivocado.

Y la contradicción: **§5.6 exige activación ops-only, §7.2 autoactivaba con `autoActivateOnProvision`, y §14 vuelve a decir que ops
activa.** Tres afirmaciones para la misma decisión.

**Corrección (v6):**

- **`UberOAuthSession`** (modelo nuevo, migración), corta y **one-shot**, con el mismo patrón que la `GoogleOAuthSession` que el repo ya
  tiene (`schema.prisma:12460`): token cifrado, `venueId`, `userId` del iniciador, `expiresAt`, `consumedAt`, y las tiendas autorizadas que
  devolvió Uber.
- El callback **no crea el link**: valida el `state`, guarda la sesión y devuelve un `attemptId`. Endpoints **autenticados** listan las
  tiendas de esa sesión y confirman cuál se vincula — resolve-don't-guess, nunca elegir por el usuario cuando hay varias.
- Al confirmar se **revalida membresía, permiso y feature** del usuario sobre ese venue: entre el inicio del OAuth y la confirmación pudo
  cambiar cualquiera de los tres.
- **Una sola política de activación, y es la de §5.6:** el link nace `PENDING` y **ops activa**. `autoActivateOnProvision` se elimina. Para
  un piloto, empezar a ingerir pedidos antes de que alguien revise es exactamente el riesgo que no se quiere.

Flujo integrator-initiated (el que corresponde a "ops conecta / el dueño autoriza"):

1. Desde el dashboard, el dueño (o ops en su nombre) pulsa "Conectar Uber Eats" → `GET /delivery-channels/oauth/uber/start?venueId=…` genera
   `state` firmado (venueId + nonce + exp, HMAC con secreto del server) y redirige a
   `https://auth.uber.com/oauth/v2/authorize?response_type=code&scope=eats.pos_provisioning&client_id=…&redirect_uri=https://api.avoqado.io/api/v1/delivery-channels/oauth/uber/callback&state=…`.
2. Uber redirige al callback con `code` + `state`. El server valida `state`, intercambia el código (`grant_type=authorization_code`) →
   **token de usuario del comerciante** (30 días; si trae refresh no se usa: el token solo vive durante el binding). Se guarda cifrado en
   `link.credentials` mientras dura el binding y se borra al terminar.
3. `GET /v1/eats/stores` (token de usuario) → lista de tiendas autorizadas (`store_id`, nombre, `external_store_id`, ubicación). Si hay una,
   se propone; si hay varias, el dashboard pide elegir (**resolve, don't guess**).
4. `POST /v1/eats/stores/{store_id}/pos_data` (token de usuario, scope `eats.pos_provisioning`) con `integrator_store_id` = `venueId`,
   `integrator_brand_id` = `orgId`, `merchant_store_id` (id del comerciante si lo tiene), `is_order_manager: true` (Avoqado gestiona los
   pedidos), `require_manual_acceptance: false` (AUTO), y `webhooks_config.webhooks_version` fijando la versión del contrato de pedidos
   (§10.0). `pos_integration_enabled` está **deprecado/ignorado** y `partner_store_id` deprecado: no se mandan. `// REVALIDAR EN SANDBOX`:
   la referencia los muestra como _query params_ en el ejemplo; confirmar si van en query o body.
5. Se crea/actualiza el `DeliveryChannelLink { provider: UBER_EATS, externalLocationId: store_id, status: PENDING }`. Al llegar el webhook
   `store.provisioned` (o al confirmar por `GET /v1/eats/stores/{store_id}` con el token de app), `verifyLink` = ok → **ops activa (§5.6)**.
   🔴 **`autoActivateOnProvision` queda eliminado** — la v5 lo proponía aquí mientras §5.6 y §14 decían que activa ops, tres afirmaciones
   distintas para la misma decisión. Se elige una sola: **PENDING + activación de ops**, que para un piloto es la segura.
6. Desactivar: `PATCH /pos_data` con `integration_enabled: false` (pausa larga) o `DELETE /pos_data` (revocación); `store.deprovisioned`
   entrante → link DISABLED + credenciales borradas.

Permiso para iniciar el OAuth: `delivery-channels:connect` (SUPERADMIN) **o** `:manage` del propio venue — el dueño puede autorizar su
propia tienda porque Uber le pide su login de Uber Eats Manager; el confused-deputy de julio (bindear una tienda ajena) no aplica: solo
puede autorizar tiendas de las que Uber le reconoce como dueño.

### 7.3 Firma de webhooks

Header `X-Uber-Signature` = HMAC-SHA256 en **hex minúsculas** del body HTTP crudo, con la **Signing Key** que se registra en el dashboard al
dar de alta el webhook (`Basic HMAC`) como llave — **no** el client secret (§6.1). Comparación con `timingSafeEqual` sobre bytes tras
validar longitud (64 hex).

**Rotación: la da Uber, no hay que construirla.** El mismo formulario acepta una **Secondary Signing Key**, así que el proveedor ya
implementa la ventana de doble secreto que §5.10 diseñaba a mano (`previousWebhookSecret` / `previousSecretValidUntil`). Para Uber el server
acepta ambas llaves mientras las dos estén configuradas: se registra la nueva como secundaria, se despliega el server con las dos, se
promueve, y se borra la vieja. El diseño manual de §5.10 sigue aplicando a proveedores que no ofrezcan rotación nativa. El body firmado trae
`event_id` (único, documentado para deduplicar) y `event_time` → replay: dedup durable por `event_id` **más** ventana de ±5 min sobre
`event_time` (rechazo suave: se persiste como `REJECTED_STALE`, 200 vacío, alerta si se repite).

Reintentos de Uber ante 5xx/timeout: **máximo 7 entregas**; la cadencia exacta es inconsistente entre la guía (10/30/60/120 s) y la
referencia de `orders.notification` (1/2/4 s) → no se asume; lo único que importa al diseño es que el ACK sea rápido y persist-first, y
jamás 5xx después de persistir.

## 8. Gating, permisos y auditoría

| Eje       | Valor                                                                                                                                                                                                                                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tier      | `DELIVERY_CHANNELS` PREMIUM, ya existe; Uber es un proveedor dentro del mismo feature                                                                                                                                                                                                                                                    |
| Permisos  | `delivery-channels:connect` SUPERADMIN (crear/activar/secretos) · `:manage` OWNER/ADMIN (pausar, publicar menú, modo) · `:read` MANAGER · `:request` dueño solicita                                                                                                                                                                      |
| Orden     | `checkPermission` antes de `checkFeatureAccess` (se conserva)                                                                                                                                                                                                                                                                            |
| Auditoría | `ActivityLog` en crear, activar, pausar, publicar menú, rotar secreto, cancelación entrante                                                                                                                                                                                                                                              |
| MCP       | `delivery_channels` y `delivery_activation_requests` ya devuelven `provider`; se actualizan sus **descripciones** (hoy dicen "vía Deliverect") y se exponen los campos operativos nuevos: `lastMenuSyncAt/Error`, `suspendedReason`, `sandbox`, y por link el resumen del outbox (`pendingOutbound`, `deadOutbound`, `lastSentStatusAt`) |

## 9. Pruebas

- **Guardia de regresión:** los 176 tests de `tests/unit/services/delivery-channels/` (11 archivos) + los de controller/job/MCP de delivery
  siguen verdes tras cada punto de §5 (excepto los que fijaban un comportamiento incorrecto, corregidos con nota).
- **Dinero:** `amount + tipAmount === paidTotal`; `Order.total = paidTotal` y `Order.subtotal = saleAmount`; `paidAmount` con propina
  (convención TPV); UNPAID nunca crea `Payment`; `fundsFlow = EXTERNAL_RECORDED` y `paymentIsAvoqadoSettled === false`; ingesta concurrente
  del mismo pedido → un `Payment` (por `idempotencyKey` hasheada); mismo número de pedido en dos proveedores → dos `Order`.
- **Outbox:** accept encolado **en la misma transacción** que la orden; claim con lease y recuperación tras worker muerto; orden por
  `sequence` **dentro del `streamKey`** (§5.4: un stream por PEDIDO — `order:${orderId}` —, nunca por link: el test debe probar además que
  un `MENU_PUBLISH` atorado NO retrasa el `ACCEPTED` de un pedido, que es justo lo que el stream por link causaría); reintento con backoff;
  DEAD tras N; `deadlineAt` vencido → alerta.
- **Menú:** snapshot respeta `Menu` activo, fechas, días y horario de categoría; categoría en dos menús sale una vez; publicación encolada
  al activar y manual.
- **Cancelación entrante:** orden CANCELLED, `Payment` REFUNDED con `Refund` externo, stock repuesto, idempotente; cancelación parcial →
  DEAD + alerta, nunca PROCESSED.
- **Pausa por plan:** local no cambia hasta SENT; DEAD → alerta; pedidos posteriores marcados.
- **Pausa:** fallo del proveedor → estado local intacto + error visible.
- **Uber (Fase B):** fixtures capturados del sandbox, no inventados; `X-Uber-Signature` inválida → 401; `store_id` sin link → 200 IGNORED +
  evento persistido sin venue; `orders.notification` → 200 antes de la ingesta y `Order` creada después; `deadlineAt` = **`receivedAt`** +
  11.5 min (§6.2: el SLA corre desde el webhook, NUNCA desde `placed_at` — con un fixture cuyo `placed_at` sea anterior al `receivedAt`,
  para que el test falle si alguien vuelve a anclarlo ahí); `cash_amount_due` parcial en DELIVERY_BY_RESTAURANT → PARTIAL con
  `remainingBalance` exacto; `cash_amount_due` en un tipo no documentado → efectivo por cobrar + alerta; `charges.total` como
  `merchantReceivable` (nunca lo que pagó el cliente); `sub_total_promo_applied` como subtotal ya con promo; cancel antes que notification →
  se aplica al ingerir; tienda desconocida → 200 vacío + `UNRESOLVED_STORE` + re-resolución; `event_time` fuera de ±5 min →
  `REJECTED_STALE`; modificador × cantidad del padre; títulos con la estructura exacta `title.translations.en` (el fixture real usa `en`
  incluso para texto en español); `PUT /menus` con precios ×100 enteros desde `Decimal` (nunca desde `number`) y `vat_rate_percentage`
  **tomado del fixture, no fijado en 16** — el menú real trae 15 y el valor definitivo se confirma con el round-trip de §5.9; token de app
  persistido y renovado una sola vez bajo lock.
- Todo bajo `TZ=UTC`.

## 10. Contrato de Uber Eats — leído de la doc pública (2026-08-17)

Cada punto lleva su fuente. Lo marcado `// REVALIDAR EN SANDBOX` es lo que la doc no fija o cuya página no se pudo leer (varias páginas de
referencia solo se renderizan con JS y devolvieron el índice); las **rutas** de esas páginas sí están confirmadas por el índice de la doc.
La regla de julio sigue: **cada uno de estos puntos es un caso de prueba con fixture real del sandbox antes de ser código definitivo.**

**§10.0 — Versión del contrato de pedidos (decisión).** Uber tiene dos generaciones de API de pedidos: la "previous version"
(`GET /v2/eats/order/{id}`, `accept_pos_order` / `deny_pos_order` / `cancel`, webhooks `orders.notification` / `orders.cancel`) y la "Order
API 1.0.0" (`orders.failure`, `orders.scheduled.notification`, `webhooks_config.webhooks_version` en `pos_data`; sí tiene referencia
pública, no se alcanzó a leer en esta ronda). **Regla de diseño que hace la elección barata:** el orquestador y el core solo conocen eventos
**canónicos** — `NEW_ORDER`, `CANCEL`, `ORDER_UPDATED`, `STATUS`, `STORE_PROVISIONED`, `STORE_DEPROVISIONED` — y es
`adapter.classifyEvent(raw)` quien traduce los nombres de Uber. Cambiar de generación toca solo el adapter (rutas + tabla de traducción).
**Tarea 0 de la Fase B — gate BLOQUEANTE antes de escribir el adapter:** leer la referencia de 1.0.0 y confirmar con `GET pos_data` en
sandbox el valor exacto de `webhooks_version` que Uber espera hoy para nuevas integraciones; **se construye contra UNA sola** y así se fija
en `pos_data`. No se mezclan las dos. Corolario del split de dinero (§5.1): si un fixture real trae un monto que el mapper no puede separar
con certeza, el mapper **rechaza** (400 + evento visible), nunca estima.

| #   | Tema                    | Contrato leído                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Fuente                                                                                                                                                                                                                                                                                      |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Firma                   | `X-Uber-Signature`, HMAC-SHA256 hex minúsculas del body crudo, llave = **Signing Key** registrada en el dashboard al crear el webhook (`Basic HMAC`), **no** el client secret — verificado en el dashboard el 2026-08-17; el formulario la exige y ofrece además una _Secondary Signing Key_ para rotar. Payload: `event_id` (**único, documentado para dedup**), `event_type`, `event_time` (firmado → ventana de replay), `meta { resource_id, user_id (store), status }`, `resource_href`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | [webhooks](https://developer.uber.com/docs/eats/guides/webhooks), [orders.notification](https://developer.uber.com/docs/eats/references/api/webhooks.orders-notification)                                                                                                                   |
| 2   | Eventos                 | `orders.notification` (nuevo pedido; trae solo ids) · `orders.scheduled.notification` (programado; **también es pedido nuevo**) · `orders.cancel` · `orders.failure` (v1.0.0) · `orders.release` (repartidor cerca) · `order.fulfillment_issues.resolved` (**re-leer la orden**) · `store.provisioned` / `store.deprovisioned` · `store.status.changed`. **Uber no garantiza orden entre eventos.** Respuesta esperada **200 body vacío**. Reintentos: **máx 7**; cadencia inconsistente entre guía y referencia → no se asume                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | [webhooks](https://developer.uber.com/docs/eats/guides/webhooks), [order-integration](https://developer.uber.com/docs/eats/guides/order-integration)                                                                                                                                        |
| 3   | Pedido                  | `GET /v2/eats/order/{order_id}` (scope `eats.store.orders.read`) → `id`, `display_id` (5 chars, para el ticket), `external_reference_id`, `current_state` ∈ CREATED/ACCEPTED/DENIED/FINISHED/CANCELED, `type` ∈ PICK_UP/DINE_IN/DELIVERY_BY_UBER/DELIVERY_BY_RESTAURANT, `store`, `eater { first_name, last_name(inicial), phone (anonimizado), phone_code, delivery { location, type, notes } }`, `cart.items[] { id, instance_id, title, external_data, quantity, price { unit_price, total_price, base_unit_price… }, selected_modifier_groups[].selected_items[] { price, quantity }, special_instructions }`, `payment.charges`, `placed_at`, `estimated_ready_for_pickup_at`, `deliveries[]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | [get-order](https://developer.uber.com/docs/eats/references/api/v2/get-eats-order-orderid)                                                                                                                                                                                                  |
| 4   | Dinero                  | `Money { amount: entero en centavos, currency_code, formatted_amount }` → ÷100 **solo en el mapper**. **Semántica textual de la doc:** `total` = "cost of the entire order, including taxes and fees that will be paid out to the Merchant **excluding Marketplace Fees**" · `sub_total` = suma de líneas · `sub_total_promo_applied` = líneas **con la promo del comercio ya aplicada** · `tax` = impuesto sobre `sub_total` (en MX con IVA incluido en precio se espera 0; si viene > 0 el mapper NO lo suma dos veces: `saleAmount` = líneas ya con IVA) · `total_fee` = fees **pagados al comercio** · `total_fee_tax` · `bag_fee`, `delivery_fee` / `small_order_fee` / `tip` / `cash_amount_due` (**solo entrega propia**) · `total_promo_applied`, `tax_promo_applied`. **Precio de modificador NO viene multiplicado por la cantidad del padre** → el mapper multiplica. El mapper entrega el split explícito de §5.1 (`externallyPaidSale`, `externallyPaidTip`, `cashDueSale`, `cashDueTip`, `cashPassThroughToPlatform`); el core no deriva nada. `// REVALIDAR EN SANDBOX con fixture real: si `total`incluye`tip`, si `total_fee`ya suma bolsa/envío/pedido mínimo, y cómo se reparte`cash_amount_due` entre comercio y Uber` | [get-order](https://developer.uber.com/docs/eats/references/api/v2/get-eats-order-orderid)                                                                                                                                                                                                  |
| 5   | **Pagado o no**         | Lo decide el **mapper**, con el split explícito: `cash_amount_due` (**solo `DELIVERY_BY_RESTAURANT`**) puede diferir de `total` por créditos, promos y **cargos que se cobran en efectivo para Uber** → no es "lo que le falta al comercio" sin más. Sin `cash_amount_due` ⇒ todo externo (PAID). Con `cash_amount_due` ⇒ PARTIAL o UNPAID según el split; el reparto exacto entre `cashDueSale` y `cashPassThroughToPlatform` `// REVALIDAR EN SANDBOX` — hasta entonces, conservador: todo el efectivo se trata como por cobrar para el comercio y se alerta si `cash_amount_due > total`. `cash_amount_due` en un tipo no documentado ⇒ efectivo por cobrar + alerta, nunca pagado. `currency_code !== 'MXN'` → 400                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | [get-order](https://developer.uber.com/docs/eats/references/api/v2/get-eats-order-orderid)                                                                                                                                                                                                  |
| 6   | Estados salientes       | Aceptar `POST /v1/eats/orders/{id}/accept_pos_order` · Rechazar `…/deny_pos_order` · Cancelar `…/cancel` · Entrega propia `…/restaurantdelivery/status`. **SLA: aceptar o rechazar dentro de 11.5 min desde el webhook o Uber cancela** → `deadlineAt = receivedAt + 11.5 min`. Cuerpos `// REVALIDAR EN SANDBOX` (páginas sin render). "Listo" para `DELIVERY_BY_UBER` `// REVALIDAR`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | [order-integration](https://developer.uber.com/docs/eats/guides/order-integration), índice de la referencia v1                                                                                                                                                                              |
| 7   | Cancelación entrante    | `orders.cancel` (tiendas no-v1.0.0) / `orders.failure` (v1.0.0). Parcial: `order.fulfillment_issues.resolved` (el cliente aceptó una sustitución) → v1 lo registra y alerta; manejo completo con el sandbox                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | [webhooks](https://developer.uber.com/docs/eats/guides/webhooks)                                                                                                                                                                                                                            |
| 8   | Menú                    | `PUT /v2/eats/stores/{store_id}/menus` (scope `eats.store`) con `{ menus[], categories[], items[], modifier_groups[], menu_type? }`. Item requiere `id`, `title`, `price_info`, `tax_info`; opcionales `quantity_info`, `modifier_group_ids`, `external_data` (≤1024), `image_url` (320–6000 px, <25 MB), `nutritional_info`, `dish_info.classifications.dietary_label_info`, `bundled_items`. **Precios en centavos enteros** (×100 solo en el mapper). Impuesto: `tax_info.vat_rate_percentage` = IVA **incluido** en el precio, **valor = `Product.taxRate` del producto (0 / 8 / 16 según el caso), nunca un 16 fijo**; `mx_ieps_rate` cuando el producto lleve IEPS; `tax_rate` es el modelo US "+ tax" y NO se usa. Horarios: `menus[].service_availability[] { day_of_week, time_periods[] { start_time 'HH:MM', end_time } }`. Agotado: `suspension_info.suspension { suspend_until (epoch s), reason }`. Combos: `bundled_items`. El snapshot aporta `taxRate` por producto (`Product.taxRate` — verificar en el plan) y `sku` como `id`/`external_data`                                                                                                                                                                          | [put-menus](https://developer.uber.com/docs/eats/references/api/v2/put-eats-stores-storeid-menu)                                                                                                                                                                                            |
| 9   | Pausar tienda           | `POST /v1/eats/store/{store_id}/status` `{ status: 'ONLINE' \| 'PAUSED', paused_until?, reason }` → 204; scope `eats.store.status.write`. Path **singular** `store`. Auto-reanudar por `paused_until` `// REVALIDAR`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | [store-status](https://developer.uber.com/docs/eats/references/api/v1/post-eats-stores-storeid-status)                                                                                                                                                                                      |
| 10  | Binding                 | OAuth `authorization_code`, scope `eats.pos_provisioning`, `https://auth.uber.com/oauth/v2/authorize?…`, token en `POST https://auth.uber.com/oauth/v2/token`, 30 días. `GET /v1/eats/stores` (token de usuario) · `POST /v1/eats/stores/{store_id}/pos_data` (activar; `integrator_store_id`, `integrator_brand_id`, `merchant_store_id`, `is_order_manager`, `require_manual_acceptance`, `webhooks_config.webhooks_version`; `pos_integration_enabled` ignorado/deprecado, `partner_store_id` deprecado; query vs body `// REVALIDAR`) · `PATCH …/pos_data { integration_enabled: false }` · `DELETE …/pos_data`. Webhooks `store.provisioned` / `store.deprovisioned`. También existe activación por soporte de Uber y pre-integración en onboarding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | [integration-activation-flows](https://developer.uber.com/docs/eats/guides/integration-activation-flows), [authentication](https://developer.uber.com/docs/eats/guides/authentication), [pos_data](https://developer.uber.com/docs/eats/references/api/v1/post-eats-stores-storeid-posdata) |
| 11  | Token de app            | `client_credentials`, TTL 30 días, **100 tokens/hora y el 101º invalida el más viejo** → persistir el token (§7.1). Scopes: `eats.store`, `eats.store.status.write`, `eats.order`, `eats.store.orders.read`, `eats.report`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | [authentication](https://developer.uber.com/docs/eats/guides/authentication)                                                                                                                                                                                                                |
| 12  | Sandbox                 | Dominios **separados**: `https://sandbox-login.uber.com` (auth) y `https://test-api.uber.com` (API); mezclar falla. **Las tiendas de prueba las da Integration Tech Support** (no self-serve) — solicitud enviada 2026-08-17, **Uber Case# 59404262 / Request #739474**, prioridad P3 (SLA: acuse 4 h, resolución 48 h). 🔴 **Sin test store, `GET /v1/eats/stores` devuelve las tiendas REALES de la cuenta y las escrituras caen en producción — ver §5.0.** Junto con la tienda, Uber entrega **test store credentials** para entrar a Uber Eats Orders como si fueras el comercio y ponerla en estado abierto (necesario para el pedido de prueba). Pedidos de prueba: entrar a Uber Eats con la **cuenta de prueba**, usar la **dirección de la tienda de prueba** y pedir como cliente                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 15  | **Paso a producción**   | 🔴 No es solo trámite: (1) **integration verification = sesión CONJUNTA de pruebas end-to-end con Uber**, agendada por tech support — no una revisión de papeles; (2) app de PRODUCCIÓN aparte, creada con una cuenta de Uber de producción (no de test); (3) **los scopes de producción se piden con OTRO tech support request** citando el `client_id` de esa app; (4) configurar el webhook de producción. El encabezado de la doc advierte: _"Access to These APIs May Require Written Approval From Uber"_, y la guía asume que trabajas con un **partner manager** de Uber Eats. **Consecuencia para el plan:** la fase E no se puede agendar hasta que el motor esté completo y probado — Uber va a verlo funcionando en vivo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | [going-live](https://developer.uber.com/docs/eats/guides/going-live)                                                                                                                                                                                                                        | [sandbox](https://developer.uber.com/docs/eats/guides/sandbox), [webhooks](https://developer.uber.com/docs/eats/guides/webhooks) |
| 13  | Autenticación de la app | El founder eligió **Client Secret**; Uber recomienda llave asimétrica. Se arranca con client secret por ser más simple; migrar a asimétrica es un cambio acotado en `uber.client.ts`. ⚠️ Esta elección **no** afecta la firma de webhooks: esa usa la Signing Key dedicada (§7.3), no el client secret — la v4 justificaba la elección con esa razón y era falsa                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | dashboard de Uber (capturas 2026-08-17)                                                                                                                                                                                                                                                     |
| 14  | Webhook dado de alta    | `Primary Webhook` · URL `https://api.avoqado.io/api/v1/webhooks/delivery/uber` · `Authentication Type: Basic HMAC` · Signing Key generada por nosotros (`openssl rand -hex 32`, en `.env` como `UBER_WEBHOOK_SIGNING_KEY`) · Secondary Signing Key vacía (reservada para rotación). La ruta **aún no existe** en el server: se construye en B1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | dashboard de Uber (2026-08-17)                                                                                                                                                                                                                                                              |

**Lo que sigue sin respuesta y se resuelve con el sandbox, no adivinando:** cuerpos exactos de `accept_pos_order` / `deny_pos_order` /
`cancel`; query vs body de `pos_data`; endpoint de "listo" para `DELIVERY_BY_UBER`; si `charges.total` incluye `tip`; si `total_fee` ya suma
bolsa/envío propio/pedido mínimo (para no duplicar `merchantFees`); versión 1.0.0 vs actual (§10.0); si `tip` aparece alguna vez en
`DELIVERY_BY_UBER` en México.

### 10.b DiDi Food y Rappi (después)

Mismo motor, mismo orquestador. Para DiDi la doc vive detrás del registro (`developer.didi-food.com/es-MX`, formulario "Become a
Developer"); para Rappi hace falta un TAM. Cada una tendrá un spec corto con su tabla como la de arriba. Los diez puntos que hay que
confirmar de cada proveedor son los mismos: firma, eventos, forma del pedido, dinero, pagado/no-pagado, estados salientes y SLA,
cancelación, menú, pausa, binding y sandbox.

## 11. Migraciones (honesto: sí hay)

Los enums `DeliveryProvider.UBER_EATS` / `DIDI_FOOD` y `OrderSource.UBER_EATS` / `DIDI_FOOD` **ya existen**. Lo demás sí:

| Migración                                                                                                                                                                                                                                                                                          | Para                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `DeliveryOutboundEvent` (nuevo modelo: `kind`, `payload`, `sequence`, `state` con SENDING, `claimToken`, `lockedUntil`, `deadlineAt`…)                                                                                                                                                             | §5.4 outbox                     |
| `DeliveryOrderEvent.externalOrderId`, `dedupKey @unique`, `claimToken`, `lockedUntil`, `receivedWhileSuspended`, estados `UNRESOLVED_STORE` / `PENDING_ORDER` / `REJECTED_STALE`                                                                                                                   | §5.11 dedup · §6.2 · §5.5 lease |
| `DeliveryProviderCredential` (nuevo modelo: token de app persistido por entorno/cliente/scopes)                                                                                                                                                                                                    | §7.1                            |
| `DeliveryChannelLink.credentials Bytes?`, `previousWebhookSecret`, `previousSecretValidUntil`, `lastMenuSyncError`, `sandbox`, `suspendedReason`, `suspendRequestedAt`                                                                                                                             | §5.10, §5.9, §6.2, §5.8         |
| 🔴 **`Refund` NO existe como modelo.** El patrón real es un `Payment` negativo `type = REFUND` (§5.7) — la v5 anunciaba aquí una migración inexistente. Lo que sí hace falta: **reversión durable de `InventoryPosting`** con unique por `(posting, evento)`                                       | §5.7                            |
| 🔴 **`CloudPrintIntent`** (nuevo modelo): `venueId`, `orderId`, `channelLinkId`, `causalEventId`, **`destinationKey`** (`STATION:<id>` · `UNROUTED` · `EXPO`), `reason`, `seq`, `payload`, estado + claim/lease para el gateway, `@@unique([venueId, causalEventId, destinationKey, reason, seq])` | §5.12 impresión                 |
| 🔴 **`UberOAuthSession`** (nuevo modelo, patrón `GoogleOAuthSession`): token cifrado, `venueId`, `userId`, `expiresAt`, `consumedAt`, tiendas autorizadas. One-shot                                                                                                                                | §7.2 binding                    |
| 🔴 **`DeliveryOutboundStream`** (nuevo modelo): contador atómico de `sequence` por `streamKey`. Y `DeliveryOutboundEvent` gana `@@unique([streamKey, sequence])`                                                                                                                                   | §5.4 orden y exclusión          |
| 🔴 Estado **`BLOCKED_SAFETY`** en `DeliveryOutboundEvent` (terminal: escritura vetada por la lista blanca)                                                                                                                                                                                         | §5.0                            |
| 🔴 Estado **`PAUSE_PENDING`** en `DeliveryChannelStatus` (pausa pedida, aún no confirmada por lectura remota)                                                                                                                                                                                      | §5.8                            |

🔴 **Las seis filas marcadas se agregaron en v6 y faltaban** — el diseño las usaba y la tabla no las creaba (lo detectó la auditoría Codex:
_"migraciones/estados que no existen"_). Es el mismo defecto que la auditoría anterior ya había señalado, repetido al escribir las
correcciones. **Al cerrar cada sección nueva, verificar que todo modelo, enum y campo que menciona esté en esta tabla.**

Cada una aditiva. Por regla del repo (`critical-warnings.md`), **toda edición de `prisma/schema.prisma` termina con `npm run schema:map` y
`docs/SCHEMA_MAP.md` va en el MISMO commit**; los tres modelos nuevos (`CloudPrintIntent`, `UberOAuthSession`, `DeliveryOutboundStream`)
necesitan además su entrada en `MODEL_TO_DOMAIN` de `scripts/generate-schema-map.ts` o el script falla.

## 12. Plan por fases

| Fase  | Qué                                                                                                                                                                                                                                                                                                                   | Depende de                                |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 0     | Uber — ✅ **hecho el 2026-08-17**: Public Details, Tech Support Email (`jose@avoqado.io`) y webhook dado de alta (Primary · Basic HMAC · Signing Key en `.env`). ⏳ **Falta y es el camino crítico**: pedir las **tiendas de prueba** a Integration Tech Support (no son self-serve); en paralelo, formulario de DiDi | Founder                                   |
| **A** | **Reparar el motor** (§5), con guardia de regresión                                                                                                                                                                                                                                                                   | Nada — se puede empezar hoy               |
| B1    | Esqueleto Uber: archivos, registry, rutas (webhook único + OAuth start/callback), orquestador directo, token persistido                                                                                                                                                                                               | Fase A                                    |
| B2    | Contrato real contra sandbox: firma, fetch+mapper del pedido, accept/deny/cancel, binding OAuth + `pos_data`                                                                                                                                                                                                          | Tiendas de prueba de Uber                 |
| C     | Menú: `PUT /v2/eats/stores/{store_id}/menus` desde el snapshot                                                                                                                                                                                                                                                        | B2                                        |
| D     | **Dashboard**: botón "Conectar Uber Eats" (OAuth), selección de tienda, activación visible, publicar menú, error de sync, pausa con resultado real                                                                                                                                                                    | Fase A (cross-repo; **antes** del piloto) |
| E     | Certificación y primer venue piloto (con **conciliación manual documentada**: el dueño compara el estado de cuenta de Uber contra el reporte de Avoqado semanalmente); Production Validation de Uber                                                                                                                  | C + D                                     |
| F     | Conciliación financiera de lo que Uber liquida (comisión, promos, depósito neto; `eats.report`)                                                                                                                                                                                                                       | E                                         |
| —     | **Disponibilidad general** (abrir a más venues)                                                                                                                                                                                                                                                                       | **F terminada** — no antes                |
| G / H | DiDi Food / Rappi (specs cortos de contrato, mismo motor y orquestador)                                                                                                                                                                                                                                               | Su acceso                                 |

La fase A tiene valor por sí sola: deja el motor correcto para cualquier proveedor. La D va antes del piloto porque el dueño opera (pausa,
menú) desde el dashboard y el switch canónico debe ser visible. La F es prerequisito de abrirlo a todos: un piloto controlado puede vivir
con conciliación manual; una base de clientes no.

## 13. Riesgos

| Riesgo                                                                              | Mitigación                                                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Uber tarda en dar tiendas de prueba o rechaza la Production Validation              | Pedirlas hoy; DiDi en paralelo; Deliverect apagado como plan B; la Fase A no depende de nadie                      |
| Páginas de referencia de Uber que no se pudieron leer (accept/deny/cancel/pos_data) | Rutas confirmadas por el índice; cuerpos se fijan con el primer fixture del sandbox, marcados `REVALIDAR`          |
| Límite de 100 tokens/hora invalida el token en uso                                  | Token persistido en DB, renovación única bajo lock (§7.1)                                                          |
| Su formato difiere de lo esperado                                                   | El contrato no se escribe hasta tener la doc (§10)                                                                 |
| Pedido no pagado registrado como cobrado                                            | `payment.status` tipado; sin PAID confirmado no hay `Payment`                                                      |
| Regresión en Deliverect al reparar el motor                                         | Suite de delivery como guardia en cada punto de §5                                                                 |
| El outbox agrega un modelo y un job                                                 | Reusa el patrón exacto de `DeliveryOrderEvent` + reconciliación; sin él, cada aviso perdido es un pedido cancelado |
| Tres integraciones que mantener                                                     | Precio de quitar la renta; asumido                                                                                 |

## 14. Decisiones tomadas

- **Uber Eats primero** (founder, 2026-08-17, tras crear la app y obtener sandbox); DiDi después, Rappi al final.
- **v1 incluye publicar el menú y la cancelación entrante total**.
- **"Arregla lo necesario para que funcione perfecto"** (founder, 2026-08-17): el motor se repara; el adapter de Deliverect no se rediseña
  pero se toca donde el contrato lo exige.
- **Tier PREMIUM heredado**, sin feature nuevo.
- **Ops conecta y activa; el dueño solicita y opera.**
- **Dashboard antes del piloto**, no después.
- **Conciliación financiera del marketplace** es fase posterior, declarada, y **prerequisito de disponibilidad general** (el piloto vive con
  conciliación manual).
- **Auto-sync de menú fuera de v1**: manual + al activar. La bandera `autoSyncMenu` se oculta hasta que exista el mecanismo.
- **Un pedido de delivery desencadena TODO** (founder, 2026-08-17, §5.13): es una venta del venue como cualquier otra. El tipo de pago del
  canal **se auto-provisiona al activar el link** — el dueño no tiene que crearlo a mano antes de su primer pedido. Inventario ya está
  conectado; faltan comanda, recibo y el estampado de `tenderTypeId`.
- **La impresión del pedido de delivery entra a v1** (founder, 2026-08-17, tras verificarse que hoy no se imprime nada — §5.12). Comandas
  por estación **sin switch** (es core); ticket de expedición **con switch por sucursal**, cuyo default lo deriva el sistema del número de
  estaciones activas. El dueño **nunca elige un dispositivo**: configura áreas, como Fudo/Parrot.
- **La Signing Key de webhooks NO es el client secret** (evidencia del dashboard, 2026-08-17): las v1–v4 lo afirmaban en cinco lugares y era
  falso. Corregido en §6.1, §7.3 y §10.1/13.
- **`Product.sku` como PLU con candado**: mientras un venue tenga un link ACTIVE, cambiar el `sku` de un producto publicado exige
  confirmación explícita en el dashboard y re-publica el menú; el plan añade esa validación en `product.dashboard.service.ts`. Una tabla de
  ids externos versionados se evalúa cuando haya más de un proveedor vivo.
