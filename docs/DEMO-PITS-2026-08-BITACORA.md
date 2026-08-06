# Bitácora de cambios — preparación demo PITS (agosto 2026)

**Contexto:** PITS (cadena de 18 paradores de autopista: 31 puntos de venta entre tiendas de conveniencia, restaurantes y cafeterías; 141
usuarios; 2 turnos de 12x12 los 365 días) está evaluando ERPs. Hay una **sesión de validación en vivo del 11 al 14 de agosto de 2026** donde
el cliente pedirá demostrar lo declarado en la matriz de requerimientos.

**Principio rector de todo lo que está aquí:** nada de esto es específico de PITS. Son huecos reales del producto que cualquier cliente de
retail o alimentos también necesita. Se construyen en el núcleo o detrás de un candado de nivel, **nunca** con un `if` sobre el slug del
cliente. Lo único genuinamente a la medida son las 4 interfaces con los sistemas que PITS ya usa (nómina, contabilidad, estaciones de
servicio y banca), que van como adaptadores detrás de una interfaz genérica.

**Restricción número uno:** no romper a los ~70 puntos de venta que ya operan. Todo cambio es **aditivo, nunca mutativo**: tablas y columnas
nuevas opcionales, jamás cambiar el significado de una columna existente. Un venue que no active nada opera exactamente igual que hoy. Sólo
se prende por defecto lo demostrablemente inocuo.

**Decisiones de nivel (tomadas por el fundador, 2026-08-05):**

| Capacidad                              | Nivel               |
| -------------------------------------- | ------------------- |
| Presupuestos y control presupuestal    | PRO                 |
| Lealtad unificada a nivel organización | PRO                 |
| MRP con orden de producción            | PREMIUM             |
| Pronóstico de demanda                  | PREMIUM             |
| Multimoneda                            | PREMIUM             |
| Todo lo demás de esta bitácora         | NÚCLEO, sin candado |

---

## 1. Eliminación de datos fabricados en estadísticas generales ✅

**Fecha:** 2026-08-05 · **Nivel:** núcleo · **Estado:** hecho y validado

### Qué estaba mal

`src/services/dashboard/generalStats.dashboard.service.ts` devolvía **tres fuentes de datos inventados** a clientes reales en producción:

1. **`generateWeeklyTrendsData`** — la gráfica de tendencia semanal de ventas recibía `venueId`, `fromDate` y `toDate`, **los ignoraba**
   (iban prefijados con guión bajo) y devolvía `Math.random()`. Dos refrescos de la misma pantalla daban cifras distintas.
2. **`avgPrepTime` por empleado** — `Math.random()`, con el comentario `// Mock data (not tracked in DB yet)`.
3. **`prepTimesByCategory`** — constantes fijas (`entradas: 8`, `principales: 12`…), **idénticas para todos los venues**, más
   `Math.random()` en la variante por categoría.

### Qué se hizo

- **La gráfica semanal ahora calcula venta real**: agrupa por día de la semana el periodo solicitado y lo compara contra el periodo
  inmediato anterior de la misma duración. Excluye órdenes `PENDING`, `CANCELLED` y `DELETED`, igual que el resto del archivo. Sin periodo
  anterior devuelve 0% de variación, no un número inventado.
- **La agrupación por día usa la zona horaria del VENUE**, no la del servidor. Producción no define `TZ`, así que Node corre en UTC: agrupar
  sin convertir movía la venta nocturna al día siguiente. Se añadió el parámetro `timezone` y se actualizaron sus dos llamadores.
- **Los tiempos de preparación dejaron de inventarse.** No se pudieron calcular de verdad porque `KdsOrderItem` guarda `productName` como
  texto libre, **sin liga a `Product`**: no hay forma de saber a qué categoría pertenece una línea de comanda. Se dejan en 0, que se lee
  como "sin medición".

### Qué NO se cambió, a propósito

**Todos los campos de la respuesta se conservaron.** La regla de compatibilidad cross-repo prohíbe quitar un campo de una respuesta de API:
las versiones viejas de las apps siguen dependiendo de él.

### Validación

`/full-testing` completo — reporte en `/tmp/full-testing-20260805-143046/report.md`:

- **Contra-cálculo en SQL puro**, por un camino distinto al del código, sobre una semana real de 59 órdenes: **los siete días coinciden al
  centavo** (Martes 10,991.00, Miércoles 1,212.20, Jueves 1,024.13, Viernes 2,491.48, Sábado 926.95, Domingo 57.75, Lunes 150.00).
- **Determinismo** verificado con 8 llamadas concurrentes idénticas.
- **11 pruebas destructivas en verde**, incluida una inyección SQL en el campo de fecha (rechazada por la validación de formato; tabla
  `Order` verificada intacta después).
- Payload íntegro: 6 claves de `extraMetrics`, 7 días, 4 categorías, `avgPrepTime` presente en todas las filas.

Prueba permanente: `tests/unit/services/dashboard/generalStats.no-mock-data.test.ts` (6 casos). El central es el **determinismo** — si
alguien reintroduce aleatoriedad, truena.

### Deuda que esto deja anotada

- **Tiempos de preparación reales** requieren agregar `productId` a `KdsOrderItem` y sellar las marcas de tiempo por línea. Es relevante
  para la demo: la matriz promete el reporte de tiempos de preparación por estación, y PITS tiene 8 restaurantes y 5 cafeterías.
- **`parseDateRange` (`src/utils/datetime.ts:227`) es frágil ante fechas simples.** Hace `parseISO('YYYY-MM-DD')` sin conversión de zona.
  **Severidad BAJA tras verificar:** el dashboard envía marcas de tiempo completas (`toISOString()`), así que no está afectado, y el camino
  del MCP ya está resuelto con el envoltorio `getVenueChartData` (`src/mcp/chartData.ts`). Sólo quedan expuestos los llamadores que pasen
  fechas simples. No se tocó: cambiarlo mueve cifras que los clientes ya ven y hay que rastrear cada llamador antes.

---

## 2. Recepción de órdenes de compra — pérdida de mercancía por concurrencia 🚧

**Fecha:** 2026-08-05 · **Nivel:** núcleo · **Estado:** hecho (con deuda acotada, ver abajo)

### Qué está mal

Hay **dos caminos de recepción** en `src/services/dashboard/purchaseOrder.service.ts`, y los dos escriben el stock como **valor absoluto**
en vez de incremento atómico:

1. **`receivePurchaseOrder`** (~línea 726) — el camino legacy. Calcula `newStock = orderItem.rawMaterial.currentStock.add(recibido)` desde
   una lectura hecha **fuera** de la transacción y lo aplica como `SET`. Dos renglones del mismo insumo en una misma OC, o dos recepciones
   concurrentes, y **la segunda pisa a la primera**: se pierde una recepción entera. Peor, `previousStock`/`newStock` del movimiento heredan
   la lectura viciada, así que el kardex miente. Además crea los `StockBatch` con `Promise.all` **fuera** del `$transaction` (el comentario
   en el código lo dice: _"outside transaction to avoid nesting"_). Si la transacción falla, quedan lotes con remanente completo y
   `currentStock` sin sumar: stock fantasma que el PEPS va a consumir.
2. **`applyItemReceiveStatusInTx`** (~línea 1139) — el camino moderno, usado por la recepción por renglón y por el móvil. Lee **dentro** de
   la transacción, así que la ventana es mucho más chica, pero **usa el mismo `SET` absoluto**. En PostgreSQL con el aislamiento por defecto
   (`READ COMMITTED`), leer-modificar-escribir dentro de una transacción **tampoco** previene la pérdida: dos transacciones leen 10, ambas
   escriben 15, y un incremento desaparece. Sólo `increment` —que se traduce a un `SET x = x + n` atómico— lo evita.

### Radio de impacto (verificado antes de tocar)

- **Sólo dos puntos de entrada** llaman al camino legacy: la ruta del dashboard (`src/routes/dashboard/inventory.routes.ts:724`) y una
  acción del chatbot (`chatbot-actions/definitions/purchase-order.actions.ts:349`).
- `previousStock`/`newStock` se exponen en el listado de movimientos del MCP (`src/mcp/tools/inventory.ts`). El arreglo los vuelve
  correctos; **la forma de la respuesta no cambia**.
- **`createStockBatch` ya acepta un cliente de transacción opcional** (`src/services/dashboard/fifoBatch.service.ts:43`), con un comentario
  que dice explícitamente que los llamadores no-transaccionales quedan sin afectar. La puerta ya estaba lista.

### Estado en producción (consultado el 2026-08-05, antes de arreglar)

El bug es **real en el código pero todavía no ha costado mercancía**:

- Órdenes con dos renglones del mismo insumo: **0**. La condición nunca se ha dado.
- Insumos con `sku` fantasma (`PROD-%`) creados desde el móvil: **0**.
- Desviaciones de `currentStock` contra la suma de lotes activos: 6, de las cuales 5 son del venue de demostración (artefactos de la
  semilla) y 1 es de un cliente real (Mindform, **2 popotes**) — no atribuible con certeza a este bug.

Por eso el arreglo es **preventivo, no correctivo**. Y es el momento: PITS con 31 puntos y recepciones simultáneas en 18 paradores
multiplica la probabilidad.

### Qué se hizo

**`currentStock: { increment: delta }` en los DOS caminos**, en vez de la asignación absoluta. Prisma lo traduce a un
`SET currentStock = currentStock + n` que PostgreSQL resuelve atómicamente, así que el orden de llegada deja de importar.

El punto que no es obvio y quedó escrito en el código: **meterlo en una transacción no basta.** Con el aislamiento por defecto
(`READ COMMITTED`) dos transacciones concurrentes pueden leer el mismo saldo y ambas escribir el suyo. Sólo delegar la suma a la base lo
evita. Por eso el camino moderno, que ya leía dentro de la transacción, también estaba expuesto.

**Por qué los dos y no sólo el legacy:** arreglar uno deja la misma clase de bug vivo por la puerta de al lado, y el moderno es el que usan
la recepción por renglón y el móvil — y es sobre el que se va a construir la recepción de mercancía de reventa.

### Validación

- **8,043 pruebas unitarias en verde, 0 fallas** (662 suites).
- Prueba nueva: `tests/unit/services/dashboard/purchaseOrder.concurrent-receive.test.ts` (5 casos). Verifica la **forma** de la escritura en
  ambos caminos, que es lo que da la garantía, e incluye un caso que falla si alguien borra el comentario que explica el porqué — sin el
  porqué, el siguiente que pase "simplifica" el `increment` y reintroduce el bug.
- **Tres pruebas existentes fijaban el comportamiento con el bug** y se actualizaron: `purchaseOrderItemStatus.service.test.ts` (5
  aserciones), `purchaseOrder.receiveAllItems.test.ts` y `purchase-order.mobile.receiveStock.test.ts`. Antes asertaban el resultado absoluto
  (`toBe('620')`); ahora asertan el **delta** (`increment: '600'`), que es lo que realmente se le pide a la base y por tanto la aserción
  correcta.
- Las 8 suites de integración de inventario fallan por falta de `TEST_DATABASE_URL` (entorno, preexistente, sin relación con este cambio).

### Deuda que este cambio deja anotada, a propósito

1. **`previousStock`/`newStock` del kardex en el camino legacy** siguen saliendo de la lectura hecha al inicio de la función. El saldo real
   (`RawMaterial.currentStock`) queda correcto, pero esas dos columnas del movimiento pueden quedar desfasadas bajo concurrencia. No se
   corrigió porque `receivePurchaseOrder` usa la forma de ARREGLO de `$transaction`, que no expone el cliente `tx`; arreglarlo obliga a
   convertir 185 líneas a la forma de callback.
2. **Los `StockBatch` se siguen creando fuera de la transacción** en el camino legacy (`Promise.all`, con el comentario original _"outside
   transaction to avoid nesting"_). Si la transacción falla quedan lotes con remanente y `currentStock` sin sumar. Mismo motivo que arriba.
   `createStockBatch` **ya acepta** un cliente `tx` opcional (`fifoBatch.service.ts:43`), así que el día que se convierta la función es
   directo.

**Regla que queda escrita en el código:** toda funcionalidad nueva de recepción —incluida la de mercancía de reventa— se construye en
`applyItemReceiveStatusInTx`, **no** en el camino legacy.

### Hallazgos preexistentes que salieron al probar esto (NO arreglados)

Los tres son la **misma clase de bug** que el corregido —leer, calcular, escribir— pero con una diferencia que decide la prioridad: **estos
fallan a gritos** (violan un índice único y devuelven 500), mientras el corregido fallaba **en silencio** perdiendo mercancía. Por eso
ninguno ha corrompido datos y por eso ninguno bloquea la demo.

| Dónde                                                  | Qué pasa                                                                                                                                                                                                                                                                                         | Severidad |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `generateOrderNumber` (`purchaseOrder.service.ts:109`) | Dos órdenes creadas simultáneamente en el mismo venue generan el mismo folio → `Unique constraint failed on (orderNumber)` → 500 al usuario. **Reproducido.**                                                                                                                                    | MEDIA     |
| `generateBatchNumberInTx` (`:1100`)                    | Dos recepciones concurrentes **del mismo insumo** generan el mismo número de lote → `Unique constraint failed on (rawMaterialId, batchNumber)` → 500. **Reproducido.**                                                                                                                           | MEDIA     |
| Validación de insumos (`:419`)                         | Repetir un insumo en una OC responde _"Some raw materials not found"_ — compara `findMany().length` contra `items.length`. El mensaje manda al usuario a buscar un insumo que sí existe. Efecto colateral bueno: es la razón por la que producción tiene **0 órdenes con renglones duplicados**. | BAJA      |

**Por qué no se arreglaron ahora (decisión del fundador, 2026-08-05):** no bloquean la demo —nadie crea dos órdenes en el mismo segundo
durante una demostración— y las ~3 horas que cuestan salen de la pista de compras, que es el módulo #1 en la ponderación de PITS.
**Agendados para antes del go-live de PITS (inicios de 2027).**

Notas para cuando se tomen:

- El arreglo es un **reintento acotado**, no una secuencia de base de datos: `createPurchaseOrder` usa escritura anidada (transacción
  implícita), así que el P2002 revierte limpio y al reintentar se lee el folio ya confirmado. Una migración a secuencia sería
  sobre-ingeniería y cambiaría la semántica del folio.
- ⚠️ `src/utils/retry.ts` **excluye P2002 a propósito** (_"so genuine business errors still fail fast"_), así que hay que escribir un
  predicado local — no reusar el compartido.
- ⚠️ El del número de lote ocurre **dentro** de una transacción. En PostgreSQL una sentencia fallida aborta la transacción completa:
  reintentar adentro no funciona, hay que reintentar el `$transaction` desde afuera.

---

## 3. Órdenes de compra de mercancía de reventa ✅

**Fecha:** 2026-08-05 · **Nivel:** núcleo · **Estado:** hecho y validado

### Qué estaba mal

`PurchaseOrderItem.rawMaterialId` era **obligatorio** y no existía ninguna liga a `Product`. Toda la cadena comprar → recibir → reordenar
hablaba únicamente el idioma de insumos de cocina, así que **una tienda de conveniencia no podía comprar ni recibir un refresco**. Para PITS
son 18 de sus 31 puntos de venta, en el módulo que ellos ponderan **primero**.

### El diseño, y por qué es el mínimo

La plataforma ya tenía **dos sistemas de inventario completos y separados**:

|          | Insumos de cocina                                        | Mercancía de reventa     |
| -------- | -------------------------------------------------------- | ------------------------ |
| Catálogo | `RawMaterial`                                            | `Product`                |
| Saldo    | `currentStock` + `StockBatch` (lotes PEPS con caducidad) | `Inventory.currentStock` |
| Historia | `RawMaterialMovement`                                    | `InventoryMovement`      |

Los dos funcionaban. El hueco era sólo que la orden de compra conocía uno. Por eso el cambio de esquema es **una columna y un índice**, no
un modelo nuevo: `InventoryMovement` ya traía `unitCost`, `supplier` y el tipo `PURCHASE` sin que nadie los usara.

### Qué se hizo

- **Esquema:** `rawMaterialId` pasa a opcional, se agrega `productId` opcional con índice y relación. Migración `20260805211911_...`,
  **puramente aditiva**: 27 renglones antes, 27 después, ninguno perdió su insumo.
- **`resolveLineTarget()`** — unión discriminada `RAW_MATERIAL | PRODUCT`, el único lugar donde se decide a qué apunta un renglón. Todo lo
  demás (PDF, etiquetas, correo al proveedor, mensajes de error) lo consume y deja de preguntar por `.rawMaterial`.
- **`applyProductItemReceiveStatusInTx()`** — recepción de mercancía sobre `Inventory` + `InventoryMovement`, con `increment` atómico y
  sellado de `lastRestockedAt`.
- **Bifurcación temprana** en `applyItemReceiveStatusInTx`: si el renglón es de producto delega y regresa; si es de insumo, el código sigue
  **byte-idéntico** a como estaba.
- **El camino legacy rechaza** renglones de producto con un 400 que explica qué hacer.
- **Zod** exige exactamente uno de los dos y rechaza presentaciones de compra en producto.

### 🔴 Lo que casi se cuela: `ON DELETE SET NULL`

Al volver opcional el campo, **Prisma cambia el default de la llave foránea a `SET NULL`**. La original era `RESTRICT`. Con ese cambio,
borrar un insumo dejaría de estar bloqueado y **vaciaría en silencio la referencia en órdenes de compra históricas**, borrando la evidencia
de qué se compró y a quién.

Se puso `onDelete: Restrict` **explícito** en ambas relaciones. Efecto secundario bueno: como ahora coincide con el comportamiento original,
la migración ni siquiera toca la llave existente.

### Validación

`/full-testing` — reporte en `/tmp/ft-compras-161311/report.md`. **19 pruebas, 0 fallas:**

- **Aislamiento de inquilino:** un producto o insumo de OTRO venue se rechaza nombrando el id. El filtro por `venueId` va en la misma
  consulta que verifica existencia, así que un id ajeno es indistinguible de uno inexistente — no hay fuga de información.
- **Orden mixta:** un renglón de cerveza y otro de aguacate en la misma orden; el producto movió su `Inventory` (96→106), el insumo movió su
  stock y generó lote (0→3). Cada uno por su camino, sin contaminar al otro.
- Ciclo completo sobre "Refresco": 120 → 144 → 120, con kardex y reversión.
- Zod: insumo+producto juntos, ninguno de los dos, presentación en producto, orden vacía.
- Guardas: unidad que no coincide, recibir más de lo ordenado, camino legacy con producto.
- **8,055 unitarias en verde.** Base restaurada, conteos idénticos al baseline.

### La lección: un `any` derrotó al compilador

El correo al proveedor hacía `item.rawMaterial.name` dentro de un `.map((item: any) => …)`. Ese `any` **desactivó el chequeo de tipos justo
ahí**, así que los ~40 errores de compilación que sirvieron de red de seguridad para todo lo demás no lo cubrieron. Reventaba con renglones
de producto, y en silencio, porque la función es fire-and-forget.

Sólo apareció al correr el ciclo real contra la base de datos. Es el argumento concreto de por qué compilar y pasar unitarias no sustituye a
ejecutar la cosa.

### Deuda anotada

- **Lotes y caducidad para mercancía de reventa** siguen sin existir: `StockBatch` cuelga de `rawMaterialId`. Un producto perecedero de
  tienda todavía no tiene control de lote. Es el punto 9 de la lista de abajo.
- **Presentaciones de compra** (comprar por caja) sólo aplican a insumos; en producto se rechazan explícito en vez de valuar mal el
  inventario.

---

## 3b. Lo que la revisión encontró — y por qué el punto 3 NO estaba terminado ✅

Una revisión pre-aterrizaje (`/review`: pase propio + dos especialistas + pase adversarial) encontró que el punto 3 estaba **a medio
cablear**: el motor funcionaba, pero la mercancía de reventa no se podía crear desde la pantalla, no se podía imprimir, y bajo cierta
secuencia duplicaba existencias. Nada de esto llegó a producción — se encontró antes de commitear, que es exactamente para lo que sirve
revisar. Se corrigió todo antes de dar el punto 3 por bueno.

### 🔴 El peor: doble conteo de inventario, determinista, sin concurrencia

El delta de la recepción se calculaba contra `PurchaseOrderItem.quantityReceived`, que **parece** la fuente obvia pero es un metadato
mutable: `receiveNoItems` lo pone en 0 sin revertir el saldo, y `receiveAllItems` acepta correr sobre una orden `CANCELLED` justo para
permitir deshacer esa acción. Tres clics de un solo usuario —recibir 5 → recibir ninguno → recibir todo— dejaban **10 de existencia habiendo
llegado 5**.

El camino de insumos nunca tuvo el defecto porque su delta sale de los **lotes vivos**, que son estado real y por tanto autocorrectivo. Se
copió la forma de ese camino pero no su fuente de verdad.

**Arreglo:** darle a la mercancía su equivalente estructural. `InventoryMovement.purchaseOrderItemId` (migración `20260806024353`) es el
espejo exacto de `StockBatch.purchaseOrderItemId`, y lo ya aplicado se deriva sumando `newStock - previousStock` de los movimientos de ese
renglón — por diferencia de saldos y no por `quantity`, porque la convención de signo de ese campo no es uniforme entre servicios.

### El resolvedor que se saboteó a sí mismo

`resolveLineTarget()` se introdujo para que ningún punto del archivo olvidara el caso de producto. Se conectó a dos consultas que **no
cargaban la relación `product`**, así que caía a su `throw` final: imprimir etiquetas o generar el PDF del proveedor de cualquier orden con
mercancía devolvía 400 y **no salía nada, ni siquiera los renglones de insumo de esa misma orden**.

Ahora `ResolvableLine` declara las dos relaciones como obligatorias (`| null`, no `?`), así que **una consulta que olvide el `include` ya no
compila**. El compilador pasa a ser la defensa en vez de la disciplina. Los 14 `include` del archivo quedaron completos.

### El resto del barrido

| Qué                         | Estaba                                                                      | Quedó                                                                           |
| --------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `ActivityLog`               | La bifurcación hacía `return` **antes** del log: recepciones sin auditar    | `logAction` dentro del camino de producto, con `productId` y el actor           |
| Editar una orden            | `deleteMany` + recrear conectando siempre `rawMaterial`                     | Conexión condicional, en transacción, y **bloqueado si ya hay recepciones**     |
| `UpdatePurchaseOrderDto`    | Esquema propio que exigía `rawMaterialId` y desconocía `productId`          | Una sola definición compartida con crear — no pueden volver a divergir          |
| `/mobile`                   | Escribía `rawMaterialId` crudo sin Zod                                      | Guarda explícita + el CHECK de la base                                          |
| MCP `purchase_order_detail` | Renglones anónimos (nombre y sku en null)                                   | Resuelve ambos + campo `tipo` (INSUMO / MERCANCIA_DE_REVENTA)                   |
| Dashboard                   | **Imposible crear** una orden de reventa; detalle, recibir y CSV reventaban | Selector unificado con etiqueta, y helpers `nombreDelRenglon` en los 8 puntos   |
| Movimiento de dañado        | `ADJUSTMENT` genérico                                                       | `LOSS` — espejo del `SPOILAGE` de insumos, para que un reporte de mermas lo vea |
| Aislamiento                 | El update no validaba venue del insumo/producto                             | `verificarRenglonesDelVenue()` compartida por crear y editar                    |

### Donde me equivoqué al reportar

Dije que la migración era **"puramente aditiva y ningún comportamiento cambia"**. Fue la mitad cierto: las filas existentes quedan intactas
y el camino de insumos sí es byte-idéntico. Pero quitar el `NOT NULL` **desarmó la última red de seguridad** de las rutas que escriben
renglones sin pasar por Zod (`/mobile`, chatbot, autoReorder): un renglón sin destino pasaba de reventar ruidosamente en la base a guardarse
en silencio. Por eso ahora la exclusividad se defiende en tres capas y el `CHECK` está en la base.

También dije que repetir el mismo insumo en dos renglones era "perfectamente legítimo" al cambiar la validación de longitudes a conjuntos.
La validación vieja **sí los rechazaba**, y el kardex del camino legacy no los soporta (ambos movimientos estampan el mismo
`previousStock`). Aflojé una restricción sin revisar qué dependía de ella. Anotado abajo.

### Validación

`/full-testing` contra la base real — **26 comprobaciones, 0 fallas**:

- **La secuencia de tres clics: 80 → 85, no 90.** Es el corazón de todo esto.
- Orden mixta: el insumo movió su saldo (0→3) y generó lote PEPS con caducidad; el producto movió su `Inventory` (85→89) y su
  `InventoryMovement`, **sin generar lote**. Cada uno por su sistema.
- `ActivityLog` con `productId` y el actor correcto.
- PDF del proveedor (2,254 bytes) y etiquetas (2) sobre una orden con mercancía: **ya no lanzan**.
- El `CHECK` de la base rechaza el renglón sin destino y el que apunta a los dos; el renglón normal de insumo sigue pasando.
- Editar una orden **PARCIALMENTE** recibida se bloquea con mensaje legible, sin perder renglones ni mover existencias. (El guard viejo sólo
  cubría `RECEIVED`; éste cubre el hueco.)
- Aislamiento: producto ajeno, insumo ajeno y recibir desde otro venue → los tres rechazados.
- Regresión: orden sólo de insumos idéntica a antes, incluido el invariante PEPS (saldo == Σ lotes activos).
- **8,070 unitarias en verde** (14 nuevas del camino de producto). Base restaurada al conteo exacto en las 7 tablas.

### Deuda que ESTO deja anotada

- ~~**Renglones duplicados del mismo insumo**~~ — **RESUELTO el 2026-08-06.** Se volvieron a rechazar, pero ahora con un mensaje que dice
  qué artículo está repetido en vez del inútil "Some raw materials not found". La restricción sí hacía falta: el kardex del camino anterior
  estampa el mismo saldo previo en los dos movimientos, así que dos renglones del mismo insumo dejan un historial que no encadena. Y al
  usuario no le aportaba nada — dos renglones de 5 kg son 10 kg, y en uno solo se recibe y se audita mejor.
- **La carrera restante**: `increment` cerró la escritura, no la lectura. Dos recepciones concurrentes del MISMO renglón siguen leyendo el
  mismo estado y sumando doble — y ahora _cuadra_ contra los lotes, así que es más difícil de detectar que antes. Se cierra con un candado
  de fila (`FOR UPDATE`) sobre el renglón antes de calcular el delta.
- **`strict: false` en el dashboard**: tipar bien `PurchaseOrderItem` allá NO protege, porque `strictNullChecks` está apagado. Los ocho
  sitios se arreglaron a mano. Mientras siga apagado, el compilador no va a avisar del siguiente.
- **Crear una orden de compra dispara un correo real al proveedor** (fire-and-forget). Salió durante las pruebas. No es nuevo, pero conviene
  saberlo antes de demostrar en vivo.

---

## Pendientes priorizados para la demo

Orden por impacto en la ponderación declarada por PITS (1º Compras, 2º Contabilidad, 3º POS, 4º Inventarios):

| #   | Pieza                                                                                                                                                        | Nivel   | Demo      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | --------- |
| 3   | Órdenes de compra sobre **mercancía de reventa** (hoy sólo existen para insumos: `PurchaseOrderItem.rawMaterialId` es obligatorio y no hay liga a `Product`) | núcleo  | 🔴        |
| 4   | Venta con existencia en cero, configurable por venue y producto                                                                                              | núcleo  | 🔴        |
| 5   | Segregación de funciones: separar `inventory:update` en aprobar / recibir, **con grandfathering** para que ningún rol pierda accesos                         | núcleo  | 🔴        |
| 6   | Motor genérico de flujos de autorización, cableado a los 7 puntos donde PITS lo pide                                                                         | núcleo  | 🔴        |
| 7   | MRP con orden de producción **y el candado anti-doble-descuento**                                                                                            | PREMIUM | 🔴        |
| 8   | Conteo por denominación en el arqueo de caja                                                                                                                 | núcleo  | 🔴        |
| 9   | Lotes y caducidad para mercancía de reventa (hoy `StockBatch` cuelga de `rawMaterialId`)                                                                     | PREMIUM | post-demo |
| 10  | Presupuestos y control presupuestal (12-15 días — **no alcanza para la demo**)                                                                               | PRO     | post-demo |
| 11  | Lealtad unificada a nivel organización                                                                                                                       | PRO     | post-demo |
| 12  | Multimoneda                                                                                                                                                  | PREMIUM | post-demo |
