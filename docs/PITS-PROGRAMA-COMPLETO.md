# PITS — Programa de ingeniería completo

> **Levantado el 2026-08-06**, después de que el demo se aplazara. Cruza los 259 renglones de
> `Matriz-Requerimientos-Avoqado-PITS-CONTESTADA.xlsx` (hoja "2. Matriz de Requerimientos") contra el código real de `avoqado-server` y
> `avoqado-web-dashboard`.
>
> **Cómo leerlo.** Los porcentajes y el titular salen de la lectura completa de la matriz por cinco agentes (uno por módulo). El **detalle
> renglón por renglón está acotado a los 25 compromisos de mayor consecuencia por módulo (125 de 259)** — ese tope lo puse yo en el
> levantamiento, no es que los demás no se hayan leído. Está en [`PITS-INVENTARIO-MATRIZ.md`](./PITS-INVENTARIO-MATRIZ.md). El acta de
> alcance que pide el §6 necesita completar los ~134 restantes.
>
> **Verificado a mano** (no por agente) antes de publicarlo — las cinco afirmaciones más comprometedoras del §1, que son exactamente las que
> un consultor probaría en el demo:
>
> | Afirmación                                       | Verificación                                                                                                    |
> | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
> | A un proveedor inactivo se le puede poner una OC | ✅ `purchaseOrder.service.ts` → `supplier.findFirst({ where: { id, venueId } })`, sin `active`                  |
> | LOGIN/LOGOUT no quedan en bitácora               | ✅ sólo `MASTER_LOGIN_SUCCESS`/`_FAILED` (accesos de emergencia) en 4 puntos                                    |
> | IEPS no existe del lado de la venta              | ✅ `Product` sólo tiene `taxRate`; `OrderItem` sólo `taxAmount`. IEPS existe únicamente en gastos/CFDI recibido |
> | `quarantineBatch()` no es invocable              | ✅ definida en `fifoBatch.service.ts:685`, **cero** referencias más                                             |
> | `WasteLogDialog` no está montado                 | ✅ definida en el dashboard, **cero** imports                                                                   |

---

# PITS — Programa de ingeniería (no lista de tareas)

## 1. El titular honesto

**Si construimos literalmente todo lo que contestamos: 16 a 18 meses. No 5 semanas, no 3 meses.**

Los números, sin adornos:

| Corte                                                                                                                                             | Trabajo restante    | Calendario a nuestra velocidad real\* |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------- |
| **Todo lo contestado en la matriz**                                                                                                               | ~1,100 días-persona | **17 meses**                          |
| **Sólo lo que PITS realmente va a usar** (quitando IA especulativa, multimoneda, motor de reglas genérico, integraciones bloqueadas por terceros) | ~520 días-persona   | **8 a 9 meses**                       |
| **Lo que decide la selección del ERP** (H0–H4 de abajo)                                                                                           | ~190 días-persona   | **13 semanas**                        |

\* 15 días-persona efectivos por semana calendario, que es lo que se midió esta semana (OC de reventa punta a punta + recepción atómica + 8
defectos, en 5 días). No es una estimación optimista: es la observada.

**Porcentaje construido, con tres números porque un solo número miente:**

- **~25% de los renglones ya cumplen** o están a horas de cumplir.
- **~43% tiene base real y le falta la mitad** — no es empezar de cero, es terminar.
- **~32% es de cero.**
- Ponderado, **el compromiso está al 46%**. Pero el 54% restante concentra los módulos grandes (presupuestos, requisición/cotización, IEPS,
  SAT, pronóstico, combos, monedero, multimoneda), por eso el trabajo restante pesa mucho más que el porcentaje.

**El número que de verdad importa, y que no está en ningún lado de la matriz:**

> **Hay ~30 renglones que contestamos "cumplimiento en forma natural" y que hoy NO cumplen.** No "faltan campos": no funcionan. Ese es el
> riesgo real del programa, porque son exactamente los que una consultora de selección de ERP prueba en el demo, sin avisar.

Los más caros de esos 30, en orden de vergüenza si los prueban:

1. **A un proveedor inactivo SÍ se le puede poner una OC hoy.** `createPurchaseOrder` nunca lee `supplier.active`. Lo contestamos como
   política nativa. **Son horas de trabajo.**
2. **El login y el logout no quedan en la bitácora.** Contestamos "bitácora de acceso: inicio y cierre de sesión". Sólo se auditan los
   logins de emergencia. Es lo primero que pide un auditor de contraloría.
3. **IEPS no existe del lado de la venta.** Cero campos, cero cálculo, cero en el CFDI. Para 18 tiendas de conveniencia (refresco, cerveza,
   tabaco) es el requisito fiscal central, y lo contestamos como "configuración durante la implementación, 3 a 5 días". Es desarrollo y toca
   el cálculo de impuestos de la venta.
4. **No hay integración con el SAT.** Contestamos "conciliación de facturas contra el SAT con proceso diario ya operando". Lo que opera es
   un job que reconcilia _nuestras_ facturas contra Facturapi para no timbrar dos veces. Cosa distinta.
5. **Combos no existen** (fila 33/34, contestadas naturales). Y el workaround obvio —dar de alta un producto "café + galleta"— no sirve: las
   recetas apuntan a materia prima, no a otros productos, así que la galleta no se descontaría del inventario. Café + galleta es
   literalmente el negocio de 5 cafeterías y 18 tiendas.
6. **El "monedero electrónico" no es un monedero.** Los credit packs guardan créditos por producto (10 clases de yoga), no saldo en pesos, y
   cuelgan del venue, no de la organización — así que "canjeable en cualquier formato del grupo" es falso hoy.
7. **No se pueden registrar sobrantes en la recepción**: recibir más de lo ordenado se rechaza con 400 en los tres caminos. Contestamos
   "registro de faltantes y sobrantes".
8. **El "compro caja de 12, vendo por pieza" no funciona en tienda**, sólo en cocina. Las presentaciones de compra son exclusivas de
   insumos, y el propio código lo dice.
9. **Las 18 tiendas no tienen propuesta de compra automática.** El sugerido lee `rawMaterial`, la mercancía de reventa no entra.
10. **"Exportable" es falso en bitácora, inventario, compras y contabilidad.** El helper de export existe y está conectado a tres listados:
    órdenes, pagos y resumen de ventas.

Casi todos los de esta lista son de **horas o días**. Ese es el mensaje: la brecha más peligrosa del programa es también la más barata de
cerrar, y por eso va primero.

---

## 2. Las sorpresas buenas

Esto es lo que probablemente crees que falta y ya está construido y verificado en código:

**Contabilidad es un ERP contable, no un módulo de POS.** Libro diario de partida doble con invariante de cuadre duro, catálogo SAT, candado
de periodo, idempotencia por clave, **Anexo 24 completo** (catálogo, balanza **y pólizas** en XML — las pólizas ya tienen endpoint, sólo les
falta el botón), DIOT, ISR provisional con tarifa del art. 96, IVA en flujo (art. 1-B), activos fijos con las tasas de la LISR art. 34-35 y
el tope de MOI para automóviles, estado de resultados y balance general que cuadran y lo prueban, CFDI 4.0 con factura global mensual,
autofactura del cliente desde el ticket y cancelación con los 4 motivos SAT. **Nómina con subsidio al empleo, IMSS obrero y timbrado del
complemento 1.2.** Eso no lo tiene el 90% de los POS con los que compites.

**El REP ya está construido** — `createPaymentComplement` con NumParcialidad, ImpSaldoAnt e ImpSaldoInsoluto. Está en el módulo de
facturación de plataforma (nosotros cobrándole a nuestros clientes). No hay que escribirlo: hay que portarlo al scope de venue.

**Offline-first está verificado en hardware, no en papel.** 14 tipos de intent, reducer que reusa los mismos servicios que la ruta online,
idempotencia real de dinero por `[venueId, idempotencyKey]`, tres estados de ack (y el del medio, RETRY, que es el que todo el mundo se
come), hub LAN entre cajas y comandas imprimiendo sin internet. **Intelisis no tiene esto, y en paradores de carretera con enlace
intermitente es el argumento más fuerte de toda la venta.**

**Traslados entre sucursales es mejor que lo que la matriz pide**: máquina de estados de 6 pasos, permisos separados por etapa (solicitar /
autorizar / despachar / recibir), asignación FIFO congelada al despachar con `SELECT ... FOR UPDATE`, la caducidad del lote viaja al
destino, recepciones idempotentes y resolución de variaciones con motivo tipificado. Sólo hay que extenderlo a mercancía de reventa.

**Dos cosas que ya están escritas y no están conectadas** — trabajo de horas que hoy se ve como hueco:

- `quarantineBatch()` hace exactamente el almacén de cuarentena que pide la fila R73 (saca el lote de FIFO, lo descuenta del disponible,
  deja movimiento). **No tiene ruta, ni controlador, ni tool. Nadie puede invocarla.**
- `WasteLogDialog.tsx` es la pantalla de captura de merma con catálogo de motivos. **No está montada en ninguna ruta.**

**El 2x1 sí está calculado de verdad** (`calculateBOGO`) y el wizard de alta ya lo configura. Lo que falta no es el motor: es que se dispare
solo y que la ruta que usan Android/iOS deje de rechazarlo.

**Los dos renglones que suenan a promesa de vendedor son los más construidos**: el motor de upsell con impresiones y aceptaciones atadas a
la línea real de la orden, y el asistente de IA con **225 herramientas** (contestamos "más de 200"), OAuth real con PKCE, permisos por
usuario, auditoría por llamada y confirmación en dos pasos. **Demuéstralo en vivo en la primera sesión con LDM.**

Y tres más: **243 permisos** con auditor automatizado de deriva entre los 4 repos; **ActivityLog con 467 puntos de escritura** en 155
archivos; y **conciliación bancaria** por CSV con matcher determinista, tolerancia de monto y ventana de 2 días.

---

## 3. El programa por hitos

Cada hito entrega una capacidad completa, se demuestra solo, y cierra un bloque de renglones de la matriz. Los tiempos son días-persona; la
columna calendario asume dos frentes en paralelo.

---

### H0 — "Todo lo que dijimos que ya cumple, cumple"

**Duración: 2 semanas · 12 días-persona · Empieza YA · No depende de nada ni de nadie**

Qué entrega: cierra ~12 de los ~30 renglones donde contestamos NATURAL y no es cierto, más la deuda que produce doble conteo.

Contenido cerrado (lista fija, no abierta):

- "Recibir ninguno" devuelve la mercancía al almacén (4-5 días, toca inventario en producción — es lo único de este hito con riesgo).
- Bloqueo de OC a proveedor inactivo o borrado.
- LOGIN / LOGOUT en ActivityLog (TPV, móvil y dashboard) + filtro por acción en la pantalla.
- Exportación en bitácora, inventario, compras y contabilidad — el helper ya existe.
- Botón de pólizas XML (endpoint ya existe) + export XLS/PDF de estado de resultados y balance.
- Montar `WasteLogDialog` y exponer `quarantineBatch` con su ruta.
- `cashDifference` al cerrar turno desde TPV (hoy queda nulo; un reporte de diferencias con la columna vacía se ve peor que no tenerlo).
- Cambiar el candado de ajuste de inventario a `inventory:adjust` con grandfathering.
- Fill rate y días de cobertura (salen de datos que ya están: dos consultas).

**Se demuestra así:** sesión de 45 minutos con LDM titulada "verificación de lo declarado". Tú abres los renglones que ellos elijan de la
lista de naturales y los enseñas funcionando. Es el movimiento de mayor retorno de todo el programa: convierte la auditoría del consultor de
amenaza en evidencia a favor.

---

### H1 — Catálogo maestro de PITS

**Duración: 3 semanas · 30 días-persona · Depende de: una decisión tuya (media hora) sobre qué es campo de primera clase**

Qué entrega: filas 43, 44, 45, 68, 69, 71, 47, 248.

- Marca, fabricante, presentación, región, IEPS (campo y catálogo; el cálculo viene en H5), `createdById`, validación de alta completa por
  tipo de negocio (tienda exige EAN-13, cafetería exige receta).
- Código agrupador con varios códigos de barras por SKU + carga masiva por layout con validación EAN-13 y reporte por renglón antes de
  aplicar.
- Cambio masivo de precios con previsualización `actual → nuevo`, confirmación en dos pasos y bitácora por renglón. **Esto trae gratis la
  fila 69** (ver qué SKU cambiaron de precio), porque hoy la auditoría guarda sólo los _nombres_ de los campos que cambiaron, sin valor
  viejo ni nuevo, y sin capturar el dato la pantalla nace vacía.
- Precio por Región: el modelo `Zone` existe y está muerto (nadie lo lee). Activarlo.

**Se demuestra así:** cargas el catálogo real de PITS —sus SKU, sus regiones, sus códigos— por layout, delante de ellos, y cambias 200
precios de una región con previsualización. Es la prueba de que el sistema aguanta _su_ operación, no una demo.

**Por qué va segundo:** bloquea la bandeja de alta de producto (52), el pronóstico por familia (63-67), la evaluación por tipo de negocio
(248) y el IEPS (146). Sin catálogo, todo lo demás se construye sobre arena.

---

### H2 — Motor de autorización, y compras autorizadas de verdad

**Duración: 3 semanas · 30 días-persona · Depende de: que PITS entregue su matriz real de niveles y montos por puesto**

Qué entrega: el renglón que PITS pondera número uno, y **un motor que paga 7 renglones distintos en 4 módulos**.

- Motor genérico de solicitud / bandeja / aprobación con motivo tipificado, notificación y bitácora. Se cuelgan de él: ajustes de inventario
  (R98), alta de producto solicitada de tienda (52), promociones y descuentos (50), devoluciones con segundo usuario (27/41), viáticos
  (175), autorización extraordinaria de compra urgente (61) y presupuestos (185).
- Umbrales por monto y por sucursal + segregación aprobar / recibir. Ya está dimensionado (~19 días efectivos, ~34 archivos en 2 repos, 2
  despliegues separados por reposo) y **el plan v2 falló la auditoría de Codex con 46 incidencias: hay que corregirlo antes de escribir
  código, no durante.**
- Separar `purchase-orders:approve` de `inventory:update` (hoy quien puede editar una orden puede autorizarla) y pasarlo por
  `audit:permissions`.

**Se demuestra así:** un cajero intenta autorizar su propio ajuste y no puede; el gerente de compras lo ve en su bandeja, lo aprueba con
motivo, y sale en la bitácora exportable. Contra Intelisis, esto es el centro del argumento de control interno.

**Cuidado:** el mismo servicio lo consumen las apps POS por `/api/v1/mobile/.../purchase-orders/:poId/status` y el cron de reabasto.
Endurecer la autorización sin coordinarlo deja a alguien sin poder autorizar en producción.

---

### H3 — La tienda de conveniencia opera igual de bien que la cocina

**Duración: 5 semanas · 74 días-persona · Se puede solapar con H2 en el segundo frente**

Este es el hito más grande y el hueco estructural real del producto: **todo lo de lotes, caducidad, PEPS, cuarentena, traslados y
presentaciones vive únicamente del lado de insumos.** Las 18 tiendas —el inventario que PITS pondera— hoy tienen un saldo simple.

Se parte en dos para que sea demostrable a mitad:

**H3a (3 semanas):** lote y caducidad en mercancía de reventa (copiando el patrón XOR insumo/producto que ya se resolvió en
`PurchaseOrderItem` en la migración de agosto) + presentaciones de compra en producto (**compro caja de 12, vendo por pieza** — el ejemplo
textual de PITS) + sobrantes en recepción con tolerancia configurable y motivo obligatorio. **Demo:** recibes una caja de 12 refrescos con
lote y caducidad, vendes uno por pieza, y el kardex cuadra.

**H3b (2 semanas):** traslados de mercancía entre sucursales + valuación PEPS real (hoy hay dos medias valorizaciones y ninguna suma los
lotes vivos a su costo congelado) + alertas de caducidad (el tipo `EXPIRING_SOON` existe en el enum y **nadie lo genera**) + sugerido de
compra para mercancía de reventa con redondeo a múltiplos de compra. **Demo:** mueves mercancía de un parador a otro con autorización y
trazabilidad, y el valor del inventario del grupo sale por PEPS.

**Riesgo:** toca la deducción de stock en ~70 puntos de venta vivos. El camino de insumos debe quedar byte-idéntico.

---

### H4 — Un peso desde que alguien lo pide hasta que sale del banco

**Duración: 3 semanas · 45 días-persona · Depende de: el banco que PITS defina (para el layout de dispersión)**

Qué entrega: cierra el ciclo documental completo, que es lo que un corporativo de 31 puntos da por hecho y hoy está partido.

- Requisición → cotización → OC (fila 61; hoy sólo existe el último eslabón).
- **Enlace OC ↔ recepción ↔ CFDI** (`Expense` no tiene `purchaseOrderId` hoy). Esto desbloquea de un golpe: cierre automático de OC con
  factura (60), conciliación de tres vías (156) y generación de CxP desde la OC (136).
- Días de crédito y cuenta bancaria en el proveedor → **vencimiento real en CxP** (hoy la antigüedad se calcula desde la fecha de emisión, o
  sea que la antigüedad que mostramos no es la que PITS usaría para decidir a quién pagar).
- Notas de crédito que sí afectan: hoy se registran y no bajan el saldo del proveedor, no restan el IVA en la DIOT y no generan póliza.
- Orden de pago que agrupa facturas → archivo de dispersión.

**Se demuestra así:** una requisición de una tienda termina en un archivo de dispersión bancario, con la factura conciliada contra la orden
y la recepción. Es la demo que gana contra Intelisis en el terreno donde ellos son fuertes.

---

### H5 — Fiscal duro: IEPS y el SAT

**Duración: 4 semanas · 45 días-persona · Depende de: decisión de compra (proveedor de descarga masiva) y de que PITS diga qué productos
causan IEPS y a qué tasa**

- IEPS de la venta punta a punta: catálogo → cálculo en el cobro → CFDI → póliza. Las cuentas contables de IEPS ya están sembradas y nada
  las alimenta.
- Descarga masiva de CFDI recibidos del SAT: **es decisión de plataforma, no de código** — contratar un tercero (SATws, Syncfy, Facturapi
  Recepción) o pedir e.firma/CIEC por RFC. Decídelo en H0, no en H5.
- REP a nivel venue (portar lo que ya existe) + carga masiva de XML (envolver el import de uno que ya existe).

---

### H6 — Presupuestos y centros de costo

**Duración: 6 semanas · 45 días-persona**

Son 16 renglones entre contabilidad y transversal, cero código hoy, y **PITS lo llama el primer punto de su macroproceso**. Contestamos "1 a
2 semanas" en cada renglón por separado, lo cual sumado es una mentira aritmética. Necesita spec propio antes de tocar código: qué dimensión
se presupuesta (cuenta, centro de costo, proyecto, insumo), qué es un centro de costo (¿el parador? ¿el formato dentro del parador? ¿la
Zone?) y si el control es abierto o restrictivo — porque el restrictivo bloquea órdenes de compra y vuelve a tocar H2.

---

### H7 y en adelante (mes 5 en adelante)

- **POS comercial:** combos y combos incrementales, promociones que se disparen solas, RFC desde caja, monedero electrónico organizacional.
  ~50 días.
- **Expediente y evaluación de proveedores** con OTIF y fill rate calculados (el dato ya se captura en cada recepción; falta la fórmula y la
  periodicidad). ~25 días.
- **KDS por estación** y reporte de tiempos de preparación (`OrderItem.preparedAt` nunca se escribe). ~18 días.
- **Pronóstico de demanda**, ya con catálogo con familia real y 6 meses de historia de PITS. ~20 días.

---

## 4. Qué va primero, y por qué

**Sí: estabilizar antes de construir. Pero acotado, con lista cerrada y con fecha.**

La evidencia está en tu propia historia reciente y no es opinable: **el plan de autorización de compras falló dos veces, y la mitad de sus
bloqueadores eran deuda preexistente, no complejidad del feature.** Se pagó dos veces el mismo diseño porque el terreno se movía. H2 vuelve
a pisar exactamente ese terreno. Si entras a H2 sin H0, lo pagas una tercera vez — y esta vez con el cliente mirando.

Pero "estabilizar" tiene que ser una lista de 9 puntos con fecha de fin (H0, 2 semanas), no una temporada de limpieza. La deuda es infinita;
el presupuesto de deuda no.

**Sobre la ponderación de PITS (1º Compras, 2º Contabilidad, 3º POS, 4º Inventarios) y por qué el orden técnico no la respeta al pie de la
letra:**

No la estamos contradiciendo. Estamos construyendo Compras **de verdad**. Compras sin catálogo maestro (H1) es una maqueta: no puedes
agrupar códigos, ni comprar por presentación, ni sugerir. Y Compras sin inventario de tienda (H3) sólo sirve para las 8 cocinas: **las 18
tiendas de conveniencia, que son el 58% de sus puntos de venta, hoy no tienen sugerido, ni lote, ni traslado, ni presentación de compra.**

Dicho de otra forma: **la ponderación de PITS pone Inventarios al final, pero técnicamente Inventarios-de-tienda es la mitad de Compras.**
Vale la pena decírselo así en la primera sesión — te posiciona como quien entiende su operación mejor que su propia ponderación, que es
exactamente el terreno donde se gana una selección de ERP.

**Contabilidad va tercera no por prioridad sino porque ya está al 80%.** Lo que le falta (IEPS, SAT, presupuestos) o depende de una decisión
de compra, o depende de un spec que aún no existe. Mientras tanto, contabilidad es tu mejor material de demostración _hoy_, sin escribir una
línea: enseña el Anexo 24, la DIOT, la depreciación con tasas LISR y el timbrado de nómina en la primera reunión.

**Los cuatro insumos que tienes que pedirle a PITS esta semana**, porque sin ellos hay hitos que no arrancan:

1. La matriz real de niveles de autorización (montos por puesto) → bloquea H2.
2. Los layouts reales de carga masiva (precios, códigos, pólizas, órdenes) → bloquea H1 y H4.
3. El banco y su especificación de dispersión → bloquea H4.
4. Qué productos causan IEPS y a qué tasa o cuota → bloquea H5.

Pedirlos ya tiene un segundo efecto: **un cliente que te entrega insumos es un cliente comprometido.** Es la mejor señal temprana de si la
selección se está inclinando a tu favor.

---

## 5. Lo que NO haría (y cómo se conversa)

**1. Los 15 renglones de IA (203-206, 209-214, 216-218, 228-233).** Prometidos a "3 a 5 días" y "1 a 2 semanas" cada uno. Ninguno existe. Y
el problema no es el esfuerzo: **es que un cliente nuevo no tiene datos el día uno.** El pronóstico de precios de materia prima, la
detección de mermas anómalas y la clasificación ABC dinámica necesitan meses de historia de PITS que por definición no existirán al
arranque.

> Cómo se conversa: _"Estos módulos se activan a los 90 días de operación, cuando ya existe historia suya. Entregarlos el día uno sería
> entregarles un modelo entrenado con datos de otro cliente, y eso no se hace. Mientras tanto les damos el reporte determinista equivalente
> —que además es auditable, y un modelo no lo es."_ En varios casos (selección de proveedor, detección de anomalías en compras) el reporte
> determinista es genuinamente mejor y sale casi gratis de H4 y H8. **Este movimiento te ahorra ~120 días-persona y te hace ver más serio,
> no menos.**

**2. Multimoneda (fila 7).** ~25 días, riesgo ALTO. Todo el dinero de la plataforma es Decimal en pesos 1:1 y ~70 puntos de venta están
cobrando contra esas mismas tablas. **Es el cambio más peligroso de todo el inventario.**

> Cómo se conversa: _"¿Compran o venden en dólares hoy?"_ Un parador de carretera en México casi seguro que no. Si la respuesta es "no, es
> por si acaso", sale del alcance por escrito y se cotiza aparte. Si la respuesta es "sí, compramos importado", entonces es un proyecto con
> su propio spec y su propio precio.

**3. El motor genérico de reglas de negocio configurables (fila 198).** ~40 días para construir un lenguaje de reglas que el cliente nunca
va a usar. Contestamos ambiguo a propósito ("se define durante la implementación").

> Cómo se conversa: _"Denos la lista de las reglas que realmente quieren vigiladas."_ Si son 5 a 10 reglas concretas, se implementan una por
> una en días. Nadie ha pedido nunca un motor de reglas y luego lo ha usado.

**4. Recargas de tiempo aire, pago de servicios y la interfaz con la gasolinera (12, 252, 134).** Bloqueadas por terceros que PITS no ha
definido, **y con una dependencia interna que no está en la respuesta: no existen cuentas por cobrar B2B.** Los "3 a 5 días de nuestro lado"
aplican al conector, no al módulo que tiene que existir debajo.

> Cómo se conversa: _"Estas tres van en la fase 2, arrancan cuando ustedes cierren con el agregador, y nuestro tiempo se cuenta desde que
> tengamos su documentación y ambiente de pruebas."_ Ponerlo por escrito ahora te protege de que en el mes 6 se lea como incumplimiento.

**5. Nómina de producción para los 141 empleados (fila 151).** El motor calcula ISR con la tarifa real, subsidio e IMSS obrero y timbra el
complemento 1.2 — es más de lo que crees. Pero le faltan horas extra, aguinaldo, PTU, finiquito, incapacidades, préstamos y pensión
alimenticia, **y el propio código advierte que activar otras deducciones descuadra la póliza si no se hacen tres cambios juntos.** Eso es
dinero de empleados.

> Cómo se conversa: separa las dos preguntas. _"¿Quieren correr la nómina aquí, o quieren timbrar la que ya calculan?"_ Timbrar es hoy.
> Calcular es un módulo, y hay que decirlo.

**6. Franquicias (255) y despliegue en servidor propio (9).** Probablemente los 18 paradores son propios y nadie quiere administrar su
propio servidor.

> Cómo se conversa: una pregunta cada uno, y si la respuesta es no, salen del alcance. Son ~15 días-persona que se recuperan preguntando.

**7. Tres modelos estadísticos de pronóstico (63-67).** Prometimos media móvil, Holt-Winters y regresión con estacionalidad, más comparativo
de error y elección automática.

> Cómo se conversa: entrega **uno bueno con backtesting visible** y explica por qué. Un cliente que compara tres modelos no existe; un
> cliente que quiere ver que el pronóstico le atinó el mes pasado, sí. Ahorra ~10 días y mejora el resultado.

---

## 6. Los tres riesgos del programa

Estos son los que tumban un proyecto de meses. No son riesgos de tarea.

### Riesgo 1 — La deuda preexistente que aparece a mitad del hito

**Ya te pasó dos veces, en el mismo módulo.** El plan de autorización de compras falló dos auditorías y **la mitad de sus bloqueadores era
deuda que ya estaba ahí**: la comisión que se borraba al editar, el cron que insistía con órdenes rechazadas, quien recibió en nulo, el
botón Rechazar que cancelaba. Ninguna era parte del feature.

Esto no es mala suerte: es la firma de un código que creció rápido. Va a volver a pasar en H3 (deducción de stock), en H4 (el enlace OC-CFDI
cruza dos módulos que nunca se hablaron) y en H5 (cálculo de impuestos en la venta).

**Mitigación, concreta:** cada hito arranca con **2 días de sondeo** —leer el código real del camino que se va a tocar y listar la deuda
antes de estimar— y lleva **20% del presupuesto reservado para deuda encontrada**. Si el sondeo destapa más del 20%, el hito se re-planea;
no se absorbe en silencio, porque absorberlo en silencio es exactamente lo que hizo fallar el plan dos veces. Y ningún plan entra a
construcción sin pasar la auditoría de Codex primero (el de autorización tiene 46 incidencias vivas: **corrígelo antes de H2, no durante**).

### Riesgo 2 — El alcance no tiene acta, y ~30 renglones dicen "se configura durante la implementación"

Ese es el riesgo comercial más caro del programa. Frases como _"alertas por incumplimiento de políticas en todos los procesos"_,
_"reportería 100% a la medida"_, _"la validación de atributos obligatorios se configura durante la implementación"_ y _"los niveles
escalonados se configuran en la implementación"_ son alcance infinito escrito con letra de alcance cerrado. Cuando la consultora las lea en
el mes 4, no van a significar lo que tú creíste.

Y hay un segundo filo: **hay al menos 4 renglones donde escribimos "se configura" y en realidad es código** (programación de conteos
cíclicos, niveles escalonados de autorización, IEPS, validación de alta completa). Ese es el tipo de cosa que quema credibilidad de golpe,
porque el cliente ya la dio por incluida.

**Mitigación:** **antes de firmar**, un acta de alcance renglón por renglón sobre esos ~30, con tres columnas: _entregado hoy / entregado en
el hito N / requiere insumo de PITS_. Se hace en dos días de trabajo y es la póliza de seguro de todo el programa. Y como el demo se aplazó,
tienes exactamente la ventana para hacerlo. Hazlo **tú**, con LDM, no lo dejes para "cuando arranque la implementación".

Dentro de este riesgo va su gemelo: **cuatro hitos dependen de insumos que sólo PITS puede dar** (matriz de autorización, layouts, banco,
tasas de IEPS, catálogo de documentos de proveedor, fórmulas de OTIF). Si esos insumos tardan 6 semanas, el programa entero se recorre 6
semanas y la culpa se va a leer como tuya. Pídelos por escrito, con fecha, esta semana.

### Riesgo 3 — Romper producción en los clientes que ya pagan, mientras cortejas al que no

Cada hito de este programa toca la ruta de dinero de ~70 puntos de venta vivos: H0 toca inventario en producción, H2 toca los permisos que
usan las apps POS y el cron de reabasto, H3 toca la deducción de stock en el cobro, H5 toca el cálculo de impuestos de la venta. **Un
incidente en PlayTelecom o Mindform durante estos dos meses no sólo cuesta ese cliente: consume las semanas que necesitas para PITS y te
deja sin programa.**

Y la red de seguridad es delgada: **no hay un solo `down.sql` en todo `prisma/migrations`, y `pg_dump` es la única reversa.** Está escrito
en tu propio plan interno.

**Mitigación, en orden:**

1. **Todo cambio de comportamiento en la ruta de dinero entra con bandera por venue y default en el comportamiento actual.** Venta con
   existencia en cero, promociones automáticas, lotes en mercancía de reventa, umbrales de autorización: PITS los prende, nadie más los
   nota.
2. **Migraciones de bajada obligatorias** para todo lo que toque dinero o inventario, a partir de H0. Es media hora por migración y es la
   diferencia entre un susto y un fin de semana.
3. **Ensayar un restore, una vez, esta semana.** Hoy nadie sabe cuánto tarda ni si funciona. Cuesta un día y aparte cierra la fila 9 de la
   matriz, que también contestamos como natural sin tener política escrita.

---

## Resumen ejecutable de los próximos dos meses

| Semanas         | Hito                                               | Qué demuestras al final                                                                                   |
| --------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1-2             | **H0** Estabilización cerrada                      | "Verifiquen los renglones que quieran de los que declaramos cumplidos"                                    |
| 3-5             | **H1** Catálogo maestro                            | Cargas el catálogo real de PITS y cambias 200 precios de una región con previsualización                  |
| 6-8             | **H2** Motor de autorización + compras autorizadas | Un cajero no puede autorizarse a sí mismo; el gerente aprueba desde su bandeja; queda bitácora exportable |
| 7-9 (2º frente) | **H3a** Lote, caducidad y presentaciones en tienda | Recibes una caja de 12, vendes por pieza, y el kardex cuadra                                              |

**En paralelo y sin escribir código:** el acta de alcance sobre los ~30 renglones, la petición formal de los 4 insumos a PITS, la decisión
de compra del proveedor de descarga del SAT, el ensayo de restore, y la corrección del plan de autorización contra las 46 incidencias de
Codex.

Al corte de dos meses tienes tres demos independientes ya enseñadas, el alcance acotado por escrito, y el módulo que PITS pondera número uno
funcionando de verdad — no en la matriz.
