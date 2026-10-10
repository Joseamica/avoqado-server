---
paths:
  - 'src/services/commerce-channels/shopify/**'
  - 'prisma/migrations/*shopify*/**'
  - 'src/services/**/inventory*.ts'
  - 'src/services/**/*Inventory*.ts'
  - 'src/services/dashboard/productWizard.service.ts'
  - 'src/services/mobile/inventory.mobile.service.ts'
  - 'src/services/dashboard/stockCountAudit.service.ts'
  - 'src/mcp/tools/inventory.ts'
  - 'src/jobs/shopify-*.ts'
  - 'src/mcp/tools/shopify.ts'
  - 'src/routes/dashboard/shopify.routes.ts'
  - 'src/controllers/**/shopify*.ts'
  - 'tests/integration/shopify/**'
  - 'src/services/inventory/**'
  - 'src/services/dashboard/purchaseOrder*'
  - 'src/services/dashboard/menu.dashboard.service.ts'
  - 'src/services/mobile/areaTicketV7.mobile.service.ts'
  - 'src/services/dashboard/chatbot-actions/definitions/product-stock.actions.ts'
---

# Conector Shopify: el guardia del stock, la marca de origen, el espejo y los envíos en camino

Spec y contrato viven en `docs/superpowers/` del workspace (hoy en la rama `docs/precedente-shopify-inventario`, worktree
`.claude/worktrees/precedente-shopify-inventario`): `specs/2026-10-07-conector-shopify-design.md` (manda su §12 bis) y
`plans/2026-10-07-conector-shopify-v2-indice.md` (mandan sus §9, §10, §11 y §12, en ese orden de precedencia: la más nueva gana), con los
planes A, B y C a su lado. **Esta regla describe lo ENTREGADO en el código**: donde el plan y el código discrepan, gana el código. La prueba
`tests/unit/architecture/shopifyConectorRule.test.ts` fija las afirmaciones clave de abajo, en el texto y, cuando se puede, en el código: si
cambias el comportamiento, cambia aquí la frase y su aserción en el mismo commit.

## 0. Fase 1: piloto por invitación, NO se vende

| Pieza                                                                            | Dónde                                                                                                                       | Efecto                                                                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `SHOPIFY_PILOTO_SHOPS` (dominios `.myshopify.com`, coma; se lee en cada llamada) | `startShopifyConnect(…)` (`shopify.connect.service.ts:90`; la lista, `tiendasPiloto`, en `:62`)                             | otra tienda ⇒ 409 `SHOPIFY_SOLO_PILOTO`                                                                         |
| `SHOPIFY_INTEGRATION` en `PREMIUM_ONLY_SIN_CATALOGO`                             | `basePlan.service.ts:93`                                                                                                    | Premium por regla pero SIN entrada de catálogo ni precio; `shopifyTierMirror.test.ts` falla si queda en los dos |
| Nunca se contrata suelta                                                         | `addFeaturesToVenue(…)` (`venueFeature.dashboard.service.ts:190`) y `createTrialSubscriptions(…)` (`stripe.service.ts:303`) | 400 `FEATURE_NO_SE_VENDE_SUELTA`; la segunda es el embudo de venta suelta, conversión de demo y onboarding      |

Ningún texto (página, avisos, MCP, la razón del movimiento de un conteo) manda a comprar ni a subir de plan para tener Shopify. El MCP usa
su texto de piloto y no `planGateMessage` (`mcp/tools/shopify.ts`, `SOLO_PILOTO`); `SHOPIFY_SIN_PLAN` ya sale del servidor con texto de
piloto (`TEXTO_SIN_ACCESO`: «El conector con Shopify no está activo en este local (piloto por invitación).», sin «plan» ni «actívalo», M2) y
cada cliente lo traduce a su mismo texto de piloto por el código, nunca por el mensaje. Un Premium ya pagado pasa el candado y choca con
`SHOPIFY_SOLO_PILOTO` al conectar. La Fase 5 (app pública) la mueve a `PREMIUM_ONLY_CODES` con su entrada de catálogo.

## 1. Entradas HTTP: webhook y callback

- **Webhook** (`SHOPIFY_WEBHOOK_ROUTE`, `app.ts:165`): `express.raw` de 1 MB (`SHOPIFY_WEBHOOK_MAX_BYTES`) montado ANTES del router genérico
  de `/api/v1/webhooks`. El del router genérico usa `express.raw({ type: 'application/json' })`: el límite por omisión es de 100 KB (un
  `products/update` con muchas variantes lo rebasa) y su tipo NO es comodín (cualquier otro Content-Type deja `req.body = {}`); el HMAC es
  del cuerpo CRUDO. `persistShopifyWebhook(…)` sólo guarda y contesta; lo procesa el worker. Guarda SÓLO lo que el procesador lee
  (`cargaMinima(…)`: el `id`, el artículo y la ubicación del inventario, y el `variant_id` de cada renglón; M7): un pedido o un reembolso
  trae el nombre, el correo, el teléfono y las direcciones del cliente, y nada de eso se queda. Si un procesador empieza a leer otro campo,
  agrégalo ahí en el mismo cambio. Pruebas: `tests/unit/routes/shopify.webhook.app.test.ts` y
  `tests/integration/shopify/webhook-app.integration.test.ts` (un POST firmado por la `app` real deja un evento).
- **Pedidos y reembolsos, por tandas (P2-3):** el worker relee los niveles de las variantes de un pedido o reembolso de 50 en 50
  (`TANDA_PEDIDO`, una página de `fetchLevels(…)`), en orden fijo, y anota en el evento lo que ya quedó (`_avoqadoAvance`, con
  `guardarAvanceEvento`, como el sync del catálogo; la llave lleva sucursal y generación). Sin tiempo, la pasada vuelve a la fila sin gastar
  intento y la siguiente sigue desde ahí; lo que quedó en vuelo o incierto no se anota y el reintento lo repite. Antes se leía todo de una
  vez y cada pasada empezaba desde la primera pareja: un pedido de ~150 variantes no avanzaba nunca y, como el reclamo es del más viejo
  primero, detenía la entrada de webhooks de todas las tiendas.
- **Callback OAuth** (`SHOPIFY_OAUTH_CALLBACK_PATH`, `app.ts:204`): público, sin sesión; la prueba de origen es el `hmac` más el `state`
  firmado. `handleShopifyCallback(…)` recibe `req.query` INTACTO: un parámetro repetido (llega como arreglo) no es algo que Shopify firmó y
  da `?error=FIRMA`; no se filtra antes.
- **HMAC del callback** (`formaDeFirmaOAuth(…)`, `shopify.crypto.ts:32`; `verifyOAuthQueryHmac(…)`, `:47`): se aceptan DOS formas de firma,
  las dos en tiempo constante y las dos exigiendo el secreto: la de la biblioteca oficial de Shopify (valores codificados con
  `URLSearchParams`, `+` → `%20`) y la unión decodificada del ejemplo de su doc. Un `host` terminado en `==` firmado como la biblioteca
  oficial sólo cuadra con la forma codificada; con una sola forma (la decodificada), el piloto daría `?error=FIRMA`. Se registra cuál pegó
  (`callback OAuth: firma válida en la forma …`, nunca el hmac). CONFIRMADO en vivo (C10, 9-oct-2026): tres callbacks reales de la tienda de
  prueba, los tres en la forma codificada, con un `host` sin el relleno `=` de base64; no quites la forma codificada. `hmac` está en
  `PARAMS_SENSIBLES` del logger.
- **Búsqueda de Shopify en minúsculas** (`FILTRO_ESTADO`, `catalog.service.ts:68`): los valores de `product_status:` van en minúsculas y se
  unen con OR, `(product_status:active OR product_status:draft)`. En mayúsculas Shopify devuelve 0 variantes sin error: medido en vivo (C10,
  API 2026-10, 0 contra 25) y confirmado por personal de Shopify, con la doc de `productVariants` equivocada
  ([community.shopify.dev/t/21623](https://community.shopify.dev/t/bug-report-graphql-api-productvariants-product-status-query-not-working/21623)).
  Ningún otro código escribe `product_status:` a mano (lo vigila `tests/unit/shopify/shopify.filtro-estado.test.ts`). Si la tienda tiene
  variantes y el filtro no trae ninguna, la importación lo dice en el log (`0 variantes activas o en borrador de N`).

## 2. El guardia ve TODO cambio de `"Inventory"."currentStock"`: no le avises a Shopify desde tu servicio

El trigger `"Inventory_guardia_shopify"` (`AFTER INSERT OR UPDATE OF "currentStock"`, migración `shopify_conector`) encola el delta en
`ShopifyStockOutbox` en la MISMA transacción del cambio, también desde SQL crudo y desde caminos que se agreguen. Encola según la **fase
efectiva** de la sucursal (si está PAUSED, manda `pausedFrom`; por eso una pausa por plan no pierde ventas):

| Fase efectiva             | Qué encola                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| CONNECTING · REVIEWING    | cualquier producto de la sucursal, tenga o no pareja (12 bis.2)                                           |
| ACTIVE                    | productos con pareja no suspendida: iniciada, o sin iniciar que el conector creó (`createdProduct`, P1-1) |
| DISCONNECTED o sin enlace | nada                                                                                                      |

**La pareja sin iniciar que creó el conector (P1-1):** el catálogo la crea activa (si tiene precio) con `Inventory` en 0, y el barrido del
cuadre la inicia hasta su etapa de stock (decenas de minutos en un catálogo grande): una venta, un ajuste o una recepción en esa ventana se
perdía en silencio, porque TOMAR pone `Inventory = S + Σ vivas` y el cuadre no ve la diferencia. Ahora el guardia la encola y la fila se
RETIENE: el reclamo exige pareja iniciada, así que no sale hasta que TOMAR inicia la pareja y la suma (`Inventory = S − 1`, espejo `S`, la
fila `−1` sale después). La limpieza horaria (M4, §10) la cuenta como viva; si la pareja se suspende al iniciar, `suspendPair(…)` la
descarta como a cualquier otra.

No encola: un cambio con la marca de origen `shopify`, un delta 0, ni un `DELETE` de la fila (ver §5). El buzón lo llenan SÓLO el guardia y
la resolución «usar Avoqado» (`reconcile.service.ts:1290`).

## 3. La marca de origen: si aplicas en Avoqado algo que VINO de Shopify

Abre la transacción con `marcarOrigenShopify(tx)`, que hace `SELECT set_config('avoqado.stock_origen', 'shopify', true)`. Sin eso el cambio
regresa a Shopify y se cuenta doble. Con `true` la marca vive sólo en esa transacción. Es la primera vez que el repo pasa contexto a un
trigger: no la uses para nada más.

## 4. El invariante, los cuatro escritores del espejo y el orden de candados

**Invariante operativo (§9.3):** `Inventory = espejo + Σ vivas + Σ DEAD_LETTER sin resolver + offset de la revisión OPEN`

- «Vivas» = filas PENDING, IN_PROGRESS y FAILED (`LIVE_OUTBOX_STATUSES = ['PENDING', 'IN_PROGRESS', 'FAILED']`). El invariante vale para una
  pareja iniciada y no suspendida, y TODAS sus sumas son de la generación vigente de la sucursal (T3): Σ vivas y Σ DEAD_LETTER por igual.
  Las filas de una generación vieja y las `RELIGADA_A_OTRA_TIENDA` (que quedan en la generación anterior) NO entran en la cuenta; el filtro
  por `generation` vive en `productBlocked(…)`, `liveOutboxSum(…)`, `bloquearFilasDelProducto` y `abrirRevision` (`mirror.service.ts:5`,
  `reconcile.service.ts:735`).
- Una DEAD_LETTER (de la generación vigente) conserva su delta en la cuenta hasta que la resolución la descarte. Una venta que dejó
  `Inventory = 9`, espejo 10 y su `−1` en DEAD_LETTER es un estado CORRECTO, no algo que «arreglar».
- COMPARAR con diferencia abre `REACTIVADA` con `offset = Inventory − S`; si los saldos ya coinciden, cierra en la misma tx la revisión OPEN
  del producto (`offset = 0`, §11.8). La revisión guarda `firstPairing` (W5): la pareja nunca se había iniciado, o sea, el producto ya
  existía en Avoqado y acaba de aparecer en Shopify con el mismo SKU. Sigue siendo `REACTIVADA` (mismo motivo, misma sugerencia, mismos
  filtros); sólo cambia el texto: la página (`primeraVez` en la lista) y el correo no dicen «se volvió a emparejar».
- El cuadre calcula `total = Inventory − espejo − Σ vivas − Σ DEAD_LETTER` (`abrirRevision`, `reconcile.service.ts:735`) y decide en este
  orden:
  - con DEAD_LETTER (aunque `total = 0`, que es el caso normal de un ATORADO): abre o actualiza `ATORADO` (`INCIERTO` si alguna es ambigua)
    con `offset = total`; nunca cierra;
  - sin DEAD_LETTER y `total = 0`: cierra la revisión OPEN (offset 0) o no hace nada;
  - sin DEAD_LETTER y `total ≠ 0`: con un envío en camino sale `EN_CAMINO` sin escribir; si la OPEN ya lo explica (`total − offset = 0`), no
    hace nada; si no, abre o actualiza `DIFERENCIA` con `offset = total`, y una OPEN que ya existía conserva su motivo (sólo ATORADO e
    INCIERTO se lo pisan).
- Se compara con `Prisma.Decimal`, nunca con `Number`.

El espejo (`mirrorAvailable` / `mirrorCommitted`) tiene CUATRO escritores, y nadie más:

| Escritor                              | Qué hace                                                                                                                                                                                                                                                                                                                                                                                                                                 | Atomicidad                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| mensajero, `runShopifyOutboxRow(…)`   | al confirmar un envío: SENT y `espejo += delta` (NUNCA `quantityAfterChange`), sólo si la pareja existe y su generación coincide con la de la fila                                                                                                                                                                                                                                                                                       | misma tx que marcar SENT                      |
| aplicador, `applyShopifyLevel(…)`     | frescura (`mirrorAt > fetchedAt`) y `productBlocked(…)` ANTES de actuar, también sobre un nivel no OK; luego espejo ← lectura vigente y `Inventory += S − espejo` con la marca                                                                                                                                                                                                                                                           | una tx; sin acceso ⇒ `PAUSADO` sin tocar nada |
| inicio de pareja, `initializePair(…)` | TOMAR_SHOPIFY: espejo = S e `Inventory = S + Σ vivas` (en ACTIVE sólo con `createdProduct = true`; en REVIEWING con `applyRequestedAt`, para todas); COMPARAR: espejo = S, `Inventory` no se toca y, si difiere, `REACTIVADA` con su offset                                                                                                                                                                                              | una tx; sin acceso ⇒ `NO_APLICA`              |
| resolución, `resolveShopifyReview(…)` | revalida las cantidades mostradas y las VIGENTES (Avoqado bajo candado, Shopify recién leído). «Usar Shopify»: espejo e `Inventory` a la lectura vigente, con la marca. «Usar Avoqado»: descarta las DEAD_LETTER, en la misma tx pone el espejo en `S` (la lectura recién hecha, con su `committed` y `mirrorAt`) y encola `A − S` (entero) como fila nueva; al quedar SENT esa fila, el mensajero suma su delta como con cualquier otra | una tx; 409/422 si no                         |

Por qué «usar Avoqado» pone el espejo en `S` y no espera al mensajero: con `A = 12`, `S = 11` y espejo viejo `10`, encolar `+1` sin mover el
espejo dejaría la cuenta en 11 contra las 12 piezas de Avoqado. Si hay filas vivas, la resolución contesta 409 `SHOPIFY_CAMBIOS_EN_CAMINO`.

**Orden de candados (índice §10.3, con el evento de §11.2), siempre éste:** Product (si se toca) → sucursal (`FOR SHARE`) → tienda
(`FOR SHARE`) → pareja (`FOR UPDATE`) → `Inventory` → buzón/revisión → evento (`FOR SHARE`, al final)

- **Product se bloquea `FOR NO KEY UPDATE`** (K11): serializa con otros escritores del catálogo sin frenar el `FOR KEY SHARE` de una venta
  que inserta un renglón con llave foránea al producto. Catálogo y archivo lo piden explícito (`bloquearProductos`,
  `catalog.service.ts:418`; `archivarPareja(…)`, `:1188`); `switchInventoryMethod(…)` y `setProductInventoryMethod(…)` lo toman con el
  `product.update` que ya hacen (no toca llaves) y llaman a `suspenderParejaPorReceta(…)` DESPUÉS, nunca antes.
- **El mensajero**, con o sin cerco, toma el orden general sin Product: sucursal y tienda `FOR SHARE`, pareja `FOR UPDATE`, la fila del
  buzón `FOR UPDATE` (releída: sigue `IN_PROGRESS` con su `claimToken`) y, con cerco de evento, el evento `FOR SHARE` al final
  (`conFilaPropia`, `outbox.service.ts:169`). Nunca la fila primero, ni con `SKIP LOCKED`: `claimShopifyOutbox(…)` ELIGE su candidata sin
  candado y la revalida ya con los candados puestos.
- Los cierres por falla (devolver a la fila, FAILED, DEAD_LETTER) van sin cerco, con los candados en orden, y se protegen con el
  `claimToken` de la fila: si ya no es suya, no escriben. No le exijas al mensajero revisar el cerco antes de esos cierres. Un 401 sólo
  revoca la tienda si el token sigue siendo el vigente (`tokenVersion`), y lo hace por `revocarTiendaSiVigente(…)` como toda revocación
  (deja `SHOPIFY_STORE_REVOKED` en `ActivityLog` y avisa REVOCADA, M5).
- **Lo que no es un intento no gasta intento (M6):** `THROTTLED` (429, o THROTTLED en un 200) y un token que no se puede descifrar (antes de
  salir; `leerToken(…)` lo deja en el log de errores) devuelven la fila sin sumar `attempts` y sin tocar su duda, como la importación y el
  cuadre. Una `SHOPIFY_TOKEN_KEY` mal puesta no manda el buzón a DEAD_LETTER; una fila ambigua sigue acotada por su ventana de 23 h.
- **`marcarFaltaPermiso(…)`** bloquea `FOR NO KEY UPDATE` SÓLO la sucursal que recibe (`locationLinkId`; sin ella, las de la tienda, por id)
  y después la tienda `FOR SHARE` (`mirror.service.ts:372`). Quien la llame lo hace antes de cualquier candado de pareja, fila o cerco, o en
  una tx propia (el mensajero: tx de 15 s, porque avisa por dentro). `FOR NO KEY UPDATE` y no `FOR UPDATE`: no frena el `FOR KEY SHARE` de
  quien inserte una pareja con llave foránea a la sucursal.
- **Desconectar** (`disconnectShopify(…)`, `connect.service.ts:1186`) bloquea primero TODAS las sucursales de la tienda por id (la propia
  `FOR UPDATE`, las hermanas `FOR NO KEY UPDATE`), después las parejas de ESA sucursal, ordenadas por id, y sólo entonces sube la
  generación. Nunca la propia y luego una hermana de id menor: se cruzaría con quien las toma por id (el drenado, diferir, renovar la
  credencial). `renovarCredencial` (reconectar o reautorizar) también bloquea todas las sucursales de la tienda por id ANTES de la tienda.
- **Conectar** (`confirmShopifyConnect(…)`): sucursales afectadas por id `FOR UPDATE` (la propia y la que ocupaba la ubicación) → tienda
  `FOR SHARE` → sus parejas por id. La credencial nueva se guarda ANTES, en su propia tx (K9), para que un 409 de la barrera no impida
  reconectar.
- Así una pausa, desconexión o revocación espera a que termine quien tiene la sucursal y la tienda en `FOR SHARE`, sin trabarse con él.
- **Confirmaciones del MCP (P2-4):** `shopify_connect_apply` y `shopify_disconnect` atan su confirmación a la tienda, la ubicación, el
  enlace y la generación que se vieron, y el servicio vuelve a comparar enlace y generación DENTRO de su escritura:
  `requestApplyShopifyConnect(…)` en el `where` de su `updateMany`, `disconnectShopify(…)` con la sucursal ya bloqueada. Reconectar la MISMA
  tienda y ubicación sube la generación: un confirm viejo contesta 409 `SHOPIFY_CONEXION_CAMBIO` (el MCP pide otra vista previa) y no aplica
  ni desconecta la conexión nueva. La ruta del dashboard no manda la generación (la página sondea el estado) y se comporta como antes.

## 5. `Inventory` que desaparece o vuelve ⇒ suspender y reactivar la pareja, NUNCA borrarla

Un `DELETE` de la fila (pasar el producto a receta, borrar la sucursal, limpiar una demo) no se manda a Shopify: dejaría la tienda en línea
en cero. Pasar un producto a RECETA, por CUALQUIER camino, llama a `suspenderParejaPorReceta(…)` DESPUÉS de escribir el `Product` y ANTES de
tocar `Inventory`; y volver a CANTIDAD llama a `pedirCuadreAlVolverACantidad(…)`. Los caminos de hoy son CUATRO. Dos cambian el método:
`switchInventoryMethod(…)` (`productWizard.service.ts:569`) y `setProductInventoryMethod(…)` (`productInventoryIntegration.service.ts:612`:
PUT inventory-method, paso 2 del asistente y la tool de recetas del MCP). Los otros dos son los PATCH genéricos del producto, que cambian
`type`, `trackInventory`, `inventoryMethod`, `unit` y `soldByWeight`: la ficha del dashboard (`updateProduct(…)` de
`product.dashboard.service.ts`) y el PATCH móvil (`product.mobile.controller.ts`). Esos dos llaman a `ajustarParejaAlProducto(…)` (P1-2)
entre `product.update` y `ensureQuantityInventoryRow`: si el producto ya no se sincroniza, suspende con el motivo real (por
`suspenderParejaPorReceta(…)`, con su excepción U3); si sí, `pedirCuadreAlVolverACantidad(…)`. Antes no lo hacían: pasar a kilo por la ficha
dejaba la pareja viva y cada kilo entero vendido le quitaba una PIEZA a Shopify (reproducido en vivo, 39 → 38). Si agregas otro camino que
borre o cree filas de `Inventory` de productos ligados, o que cambie esos campos, usa los mismos ayudantes (`shopify.store.service.ts:308`).

- `suspenderParejaPorReceta(…)` toma la pareja con `bloquearPareja(…)` y la suspende con `SIN_INVENTARIO` (`suspendPair(…)`). Excepción: un
  producto que el conector archivó con un envío en camino se queda en `NIVEL_INEXISTENTE`; pisarlo apagaría el reintento que lo borra.
- `pedirCuadreAlVolverACantidad(…)` pide el cuadre (`pedirCuadre(…)`) SÓLO si la pareja está suspendida por `SIN_INVENTARIO`: pedirlo
  siempre armaría un cuadre por cada alta y cada PUT. El cuadre la reactiva solo (`COMPARAR`) cuando el producto vuelve a ser elegible
  (`trackInventory` + `QUANTITY`, por pieza —ni otra unidad ni «se vende por peso»: la venta descuenta kilos aunque la unidad diga pieza— y
  de un tipo con existencias: `motivoNoSincronizable(…)`, la MISMA regla con que el catálogo liga) y hay `Inventory` y nivel en Shopify;
  mientras tanto aparece en «Productos sin pareja».
- Una fila de `Inventory` sola NO basta para reactivar (FF-I1): `setProductInventoryMethod(…)` la conserva al pasar a receta, y con ella el
  cuadre revivía la pareja y Shopify sobrevendía. Por eso `initializePair(…)`, `applyShopifyLevel(…)` y la resolución (U2) leen el producto
  bajo el candado de la pareja (`sincronizableBajoCandado(…)`) y, si ya no se sincroniza, suspenden con `SIN_INVENTARIO` en vez de iniciar,
  aplicar o reactivar (la resolución contesta 409 `SHOPIFY_SIN_INVENTARIO` y la revisión sigue abierta).
- **El motivo real (R-M2):** la pareja queda `SIN_INVENTARIO` (es lo que lee el resto del conector), pero la incidencia de «Productos sin
  pareja» lleva el motivo REAL con su propio texto: `METODO_RECETA`, `UNIDAD_NO_PIEZA`, `TIPO_SIN_INVENTARIO` o `SIN_INVENTARIO_EN_AVOQADO`,
  el que devuelve `motivoNoSincronizable(…)` y que `suspendPair(…)` recibe (`suspenderParejaPorReceta(…)` pasa `METODO_RECETA`). El 409
  `SHOPIFY_SIN_INVENTARIO` de la resolución nombra ese mismo motivo. Si el motivo cambia mientras sigue suspendida (de receta a kilos),
  `sincronizableBajoCandado(…)` pone la incidencia al día; al reactivarse se limpian todos (`MOTIVOS_DE_SUSPENSION`).
- **Sin los ayudantes (R-M3):** una pareja VIVA cuyo producto deja de ser elegible por un camino que no los llama (SQL a mano, un camino
  nuevo) también se suspende, por tres puertas: el catálogo (`upsertShopifyVariant(…)` lo ve con el `Product` ya bloqueado y suspende con
  `Inventory` y las filas bloqueadas antes del evento), la tanda de stock del cuadre, que la manda a `applyShopifyLevel(…)` aunque Shopify
  no haya cambiado, y el mensajero (P1-2): una fila NO ambigua de una pareja viva cuyo producto ya no se sincroniza no recibe un envío
  nuevo; `runShopifyOutboxRow(…)` suspende la pareja con el motivo real y descarta la fila (`PAREJA_SUSPENDIDA`), antes de mandar a
  DEAD_LETTER un delta no entero. La ambigua con sus parámetros congelados se sigue resolviendo con su llave. El orden de candados (§10.3)
  no cambia.

## 6. Envíos en camino, dudas y generaciones (§9.1-§9.2, §10.14, §11.3, §11.7)

- `suspendPair(…)` sólo descarta filas vivas NO ambiguas en PENDING/FAILED (nunca se aplicaron). Las filas `IN_PROGRESS` y las ambiguas
  siguen vivas: pueden haber llegado a Shopify.
- **Dos barreras distintas; no las mezcles:**
  - Iniciar o reactivar una pareja (`initializePair(…)`, los dos modos) espera (`REINTENTAR`) mientras `productBlocked(…)` no sea `LIBRE`
    (`EN_VUELO` = una fila IN_PROGRESS; `INCIERTO` = una fila viva o DEAD_LETTER ambigua).
  - Conectar una generación nueva (reconectar la sucursal a la MISMA tienda, con su ubicación u otra, o tomar la ubicación que ocupaba otra
    sucursal desconectada) responde 409 `SHOPIFY_ENVIO_EN_CAMINO` mientras haya filas `IN_PROGRESS` o vivas ambiguas (`envioEnCamino(…)`,
    `store.service.ts:273`) de cualquier generación anterior de esa sucursal o de la que ocupaba la ubicación. Una DEAD_LETTER ambigua no la
    frena: ya no puede llegar.
  - Religar la sucursal a OTRA tienda no es un 409: sus filas `IN_PROGRESS` y vivas ambiguas pasan a DEAD_LETTER con
    `lastError = RELIGADA_A_OTRA_TIENDA` (duda y parámetros congelados conservados; `aCuarentenaPorReligar`, `connect.service.ts:639`),
    porque el reclamo sólo las tomaría con la tienda vieja ACTIVE y la sucursal ya apunta a la nueva: la espera no terminaría nunca. No
    avisan (es una acción deliberada del dueño); queda `religadas` en el `ActivityLog` de `SHOPIFY_CONNECTED`.
  - Desconectar no espera: bloquea (§4), sube la generación y deja esas filas cerrarse con su llave; al llegar no mueven el espejo.
- Una fila ambigua se reclama con su MISMA llave `@idempotent` y con sus parámetros congelados (`sentInventoryItemId`, `sentLocationId`; el
  `delta` no cambia) aunque la pareja esté suspendida o la generación sea vieja, si la tienda está ACTIVE, la sucursal no tiene un error
  terminal y su ventana no venció. Al quedar SENT, el mensajero mueve el espejo sólo si la pareja existe y su generación coincide. Una fila
  de generación vieja cierra así con sus propios parámetros, nunca con los de la conexión nueva; una NO ambigua de generación vieja se
  descarta (`GENERACION_VIEJA`) y nunca viaja.
- Una fila ambigua (timeout, red, 5xx, respuesta ilegible, o un lease vencido: el proceso pudo morir con la petición en el aire) significa
  «no sabemos si Shopify la aplicó». Mientras el producto tenga una, ni el receptor ni el cuadre le aplican nada de Shopify.
- **`userErrors`:** `IDEMPOTENCY_CONCURRENT_REQUEST` (el primer intento sigue en curso: FAILED ambigua), `SERVICE_UNAVAILABLE` y
  `ADJUST_QUANTITIES_FAILED` (reintentables según Shopify 2026-10) quedan FAILED hasta agotar los intentos (`SHOPIFY_OUTBOX_MAX_ATTEMPTS`,
  6; después DEAD_LETTER) y conservan la duda previa. Cualquier otro `userError` en una fila ambigua (incluido
  `IDEMPOTENCY_KEY_PARAMETER_MISMATCH`) la deja DEAD_LETTER ambigua y su revisión es `INCIERTO`. Sólo el éxito validado la limpia.
- La ventana de 23 h sólo pone en cuarentena filas AMBIGUAS (la llave vive 24 h en Shopify): vencida, la fila pasa a DEAD_LETTER y a «Por
  revisar» como INCIERTO. Una fila NO ambigua (429, «inténtalo más tarde») nunca se aplicó: si su ventana venció, se le borra
  `firstAttemptAt` y se manda normal. `firstAttemptAt` lo pone el mensajero justo antes del HTTP: una fila devuelta por pausa o sin acceso
  no abre ventana.
- Permiso insuficiente (HTTP 403 o `errors[].extensions.code = 'ACCESS_DENIED'`) en CUALQUIER ruta se marca con `marcarFaltaPermiso(…)`,
  condicionado a la credencial y la generación vigentes: si no aplica a la vigente devuelve `false` y quien llamó lo trata como
  reintentable; si aplica, pone `importError = 'FALTA_PERMISO'` en las sucursales afectadas y avisa una vez. La fila del buzón va a
  DEAD_LETTER `FALTA_PERMISO` y conserva su duda previa; el reclamo no toma filas de una sucursal con esa marca, y reautorizar la limpia y
  re-encola esas filas (no ambigua ⇒ PENDING; ambigua ⇒ FAILED, para resolverse con su llave). La tienda sigue ACTIVE.

## 7. Cerco, cuadre y conteo (§10.9, §11.1, §11.2, §12.1)

- **Cerco:** `applyShopifyLevel(…)`, `initializePair(…)` y `runShopifyOutboxRow(…)` reciben `deps.cerco` (generación, tienda, ubicación de
  Shopify, `tokenVersion`, y el `workToken` o el reclamo del evento). Se verifica DENTRO de su tx, bajo los candados (`cercoVigente(…)`); si
  no coincide, el resultado es `CONTEXTO_CAMBIO` y no se toca nada. Todo efecto de B lo pasa (catálogo, archivo, aplicar, cuadre, eventos,
  conteo); las escrituras de progreso van por `conCerco(…)`.
- **Cuadre:** pedirlo (`requestShopifyResync(…)`, `pedirCuadre(…)`, el job de la mañana, reanudar o reautorizar) levanta `needsReconcile` o
  sube `reconcileVersion`. La vuelta (`reconcileVenue(…)`) lo consume al empezar (`reconcileDoneVersion = v`, `reconcileVersion = v + 1`) y
  una vuelta se cierra sólo con CAS sobre `reconcileVersion`; `lastReconciledAt` se pone entonces. Si llegó otro pedido a media vuelta,
  empieza otra. El cuadre nunca escribe un `importError` terminal. Lo no concluyente se distingue:
  - esperar un envío en vuelo deja la tanda pendiente (`REINTENTAR` sin dudas: es corto, 60 s);
  - con una fila VIVA ambigua la vuelta no se da por buena: se empieza otra (en 10 min), porque esa fila todavía puede llegar;
  - una DEAD_LETTER no detiene la vuelta: ya no puede llegar y queda en «Por revisar» (`ATORADO` o `INCIERTO`) para que la decida una
    persona.
- **Bajas del barrido (FF-I2, R-I2b):** lo que el barrido completo no vio NO se da por borrado sin más, porque la búsqueda de Shopify puede
  devolver 0 en silencio (C10). La protección es la confirmación por id: cada baja se confirma con una lectura directa por id
  (`confirmarBajas(…)`, la consulta `nodes` por ids, de 50 en 50 y dentro del vencimiento de la unidad, sin búsqueda): sólo se archiva lo
  que Shopify dice que ya no existe o cuyo producto está `ARCHIVED`; lo que sigue se da por visto. Si la lectura falla, no se archiva nada
  (a la 5ª falla, la vuelta sigue sin bajas). Cuando la baja parece masiva (no se vio NINGUNA pareja, o más de 10 y más del 20 %), igual se
  confirma por id, pero la vuelta archiva a lo más `TOPE_BAJAS_CON_DUDA` (20) y deja el resto para las siguientes: una baja masiva de verdad
  se drena en unas vueltas (un catálogo de UN producto borrado también se archiva) y una búsqueda rota no archiva nada. Va al log de errores
  (`BAJA_MASIVA`, «N de M») y avisa `BARRIDO_OMITIDO` sólo si todo lo confirmado sigue en Shopify (la búsqueda parece rota) o si la lectura
  directa no se pudo hacer. La cuenta de lo apartado vive en el mismo cursor (`BAJAS|n`). El sync de un producto (`syncShopifyProduct(…)`)
  confirma igual sus huérfanas. Restaurar mira sólo `deletedBy = SHOPIFY_SYNC` (lo escribe sólo el conector), sin importar `originSystem`:
  el catálogo del piloto lo subió el cargador CSV (`AVOQADO`).
- Qué sucursal cuadra el worker: ACTIVE, con su tienda ACTIVE, con acceso al plan (sin plan se pausa guardando la fase) y sin `importError`
  terminal (`FALTA_PERMISO`, `CATALOGO_MUY_GRANDE`, `CATALOGO_MAESTRO`). Un pedido sobre otra se queda guardado (la bandera es durable) y
  corre cuando vuelva a ser elegible.
- **Conteo** (reemplaza la última regla de §11.1; enmienda §12.1): con un envío en camino no se puede saber si un cambio de apartadas vino
  de un pedido (que también baja el disponible) o de un despacho (que no), así que ninguna fórmula sirve.
  - Producto libre: antes de las líneas se refresca el espejo (`refrescarEspejoParaConteo(…)`: `fetchLevels(…)` + `applyShopifyLevel(…)`, 4
    s para todo el conteo); en la tx de cada línea, bajo los candados (`apartadasBajoCandado(…)`),
    `objetivo = contado − pareja.mirrorCommitted` (el vigente, coherente con `Inventory`).
  - Producto bloqueado (`productBlocked(…)` ≠ `LIBRE`, revisado por tanda ANTES de cualquier HTTP y otra vez bajo candado): la línea NO se
    aplica y el stock no cambia. Se marca en la línea (`shopifyHeldAt`, `shopifyHeldReason`), la respuesta del conteo trae `noAplicados` y
    sale el aviso `CONTEO_NO_APLICADO`. Nunca se aplica un número que podría estar mal.
  - Dos motivos (enmienda §12.1): `ENVIO_EN_CAMINO` (se resuelve solo: vuelve a contarlo en unos minutos) y `DUDA_POR_REVISAR` (sólo entre
    los bloqueados: hay una DEAD_LETTER ambigua o una revisión OPEN; recontar no sirve hasta resolverla en «Por revisar»). El motivo viaja
    en la línea, en el aviso (texto y llave distintos) y en `noAplicados`.
  - Pausa, revocada, sin plan, sin permiso o Shopify sin contestar, con el producto libre: sin HTTP, se usa `mirrorCommitted` y el
    movimiento dice la hora (`committedAt`). Nunca se pone cero.
  - Lectura (L5): la línea retenida se expone como `shopifyHeld` (`{ at, motivo }` o `null`) en `mapCountItem(…)` (GET móvil y detalle del
    dashboard, que suma `noAplicadas`) y en `stock_counts` del MCP. En el POS (Android e iOS, C12) lo cuentan la tarjeta «N productos no se
    aplicaron» que queda arriba de la lista de conteos al confirmar, la insignia «No se aplicó» con su motivo en cada línea del detalle, la
    fila de la lista y el comprobante impreso; la tarjeta nace de `noAplicados` y se completa releyendo el GET (`shopifyHeld`), porque el
    reintento `alreadyCompleted` no trae `noAplicados`; el motivo se lee como texto y uno que la app no conoce cae en `DUDA_POR_REVISAR`. Si
    esa relectura falla (sin red, por ejemplo), el POS no inventa que todo se aplicó: enseña la línea ámbar «No se pudo comprobar si todo se
    aplicó; revisa este conteo en el historial cuando vuelva la red.» (degrada y lo dice, ronda 1 de C12).

## 8. Nunca cero por ausencia

Un nivel inexistente o inactivo en la ubicación, o un artículo `tracked = false`, NO es «0 piezas»: la pareja se suspende
(`NIVEL_INEXISTENTE` / `NO_RASTREADO`) y aparece en «Productos sin pareja». Nada de `?.available ?? 0`.

## 9. Avisos y la página

`notifyShopify(venueId, aviso)` avisa a OWNER y ADMIN activos, uno por persona y por día (`CONTEO_NO_APLICADO`, también por producto, y
`DUDA_POR_REVISAR` con su propia llave), con liga a `/venues/:slug/settings/integrations/shopify` (la página la construye el plan C en el
dashboard): REVOCADA, ATORADOS, RETRASO, SOBREVENTA, POR_REVISAR, FALTA_PERMISO, CONTEO_NO_APLICADO y BARRIDO_OMITIDO. Si agregas un aviso,
agrega su explicación en la página (`avisos.items` de `shopify.json` en el dashboard, más `SHOPIFY_AVISOS` en `src/types/shopify.ts`) y en
la guía. La página nunca ofrece comprar Premium para Shopify (§0).

## 10. Mantenimiento y pruebas

- **Limpieza horaria** (`limpiarShopify(…)`, `worker.service.ts:362`): descarta lo que NUNCA salió de una generación vieja y, de una
  sucursal ACTIVE, lo vivo NO ambiguo de la generación vigente cuyo producto no tiene pareja viva con más de 15 min (`SIN_PAREJA_VIVA_MIN`,
  M4: nunca saldría y contaba para siempre en el resumen y en RETRASO; la sin iniciar que creó el conector cuenta como viva, P1-1), borra lo
  cerrado hace 30 días (filas SENT/DISCARDED, eventos terminales, intents) y **las revisiones RESUELTAS hace más de 90 días**
  (`REVISIONES_RESUELTAS_DIAS`) cuya elección ya no está en camino: sin envío, o con su fila SENT, DISCARDED o ya borrada. Nunca se purga
  una revisión OPEN, ni una resuelta cuyo envío siga PENDING, FAILED, IN_PROGRESS o DEAD_LETTER. Sin la purga la tabla crece para siempre (a
  30,000 revisiones en un negocio la lista cuesta 35 ms con Seq Scan); la historia queda en `ActivityLog`. El índice `(status, resolvedAt)`
  va en la misma migración `shopify_conector` (la única del conector, `20261008230100_shopify_conector`, posterior a la última de develop):
  sin él la purga tarda 201 ms contra 0.04 ms con 1 M de filas.
- **Prueba de volumen:** `tests/integration/shopify/catalogo-volumen.integration.test.ts` (5,000 variantes de punta a punta, ~9 min) está
  APAGADA por defecto (`describe.skip`) para no sumarle minutos al CI de todos. `SHOPIFY_VOLUMEN=1` la enciende, siempre en una base
  desechable:
  `SHOPIFY_VOLUMEN=1 node scripts/run-with-launch-campaigns-test-db.cjs npx jest --selectProjects integration --runInBand --runTestsByPath tests/integration/shopify/catalogo-volumen.integration.test.ts`
  (el runner crea y borra su base y aborta si coincide con `av-db-25`). Córrela a mano si tocas el barrido, la importación o el cuadre.
- **Prueba de arranque del sandbox de la guía:** `tests/unit/scripts/shopify-sandbox-arranque.test.ts` importa la app real con el entorno
  saneado (~30 s) y está APAGADA por defecto; `SHOPIFY_SANDBOX=1` la enciende:
  `SHOPIFY_SANDBOX=1 npx jest --selectProjects=unit --runTestsByPath tests/unit/scripts/shopify-sandbox-arranque.test.ts`. Córrela si tocas
  `scripts/shopify-sandbox-server.ts` o algo que la app exija al importarse.
- **Dónde están las pruebas:** guardia `tests/integration/shopify/guardia.integration.test.ts` (si agregas una forma nueva de escribir
  stock, agrega su caso ahí); espejo, mensajero, avisos, resolución, conteo y worker en `tests/integration/shopify/*.integration.test.ts`;
  esta regla `tests/unit/architecture/shopifyConectorRule.test.ts`; candado `tests/unit/services/access/shopifyTierMirror.test.ts`; rutas,
  webhook y MCP `tests/unit/routes/shopify.*`, `tests/unit/controllers/dashboard/shopify.controller.test.ts` y
  `tests/unit/mcp-customer/shopify.tools.test.ts`.
- **Verificar en GitHub:** sube TU commit a una rama `ci/<tema>` (carril del workspace); los deploys sólo corren en `main`. 🔴 NUNCA
  `gh workflow run` sobre esta rama: `workflow_dispatch` con `environment=production` publica en producción SIN importar la rama
  (`ci-cd.yml:286`).
