# Money watchdog: explicación de las 40 alertas del 9 de septiembre de 2026

Investigación de sólo lectura sobre PostgreSQL de producción y Better Stack, seguida de una corrección local del detector solicitada por el usuario. No se modificaron pagos, stock ni configuración de producción; el cambio todavía no está desplegado. Las conexiones de diagnóstico usaron transacciones `READ ONLY`, `statement_timeout=15s` y consultas acotadas. Los timestamps de las tablas siguientes se expresan en UTC salvo indicación contraria.

**Corrección horaria de la lectura inicial:** `pg` interpretó las columnas `timestamp without time zone` como hora local de Node (America/Mexico_City), desplazando seis horas su salida JSON. Se reconsultaron pagos y solicitudes con `createdAt::text` y conversión explícita UTC→CDMX; el primer vale también se verificó como texto. Las horas de este informe ya incorporan la corrección. Los intervalos entre operaciones y los importes no cambian. Las fechas de Better Stack se verificaron contra `message.timestamp` y no padecían ese error.

## Resultado

El bloque combina datos históricos, limitaciones del detector y sobrepagos que necesitan conciliación. No representa 40 operaciones fallidas nuevas a la hora del log.

Los resúmenes recuperados de Better Stack para el 9-sep a las 00:17 y 06:17 UTC contienen la misma distribución y los mismos ejemplos:

| Regla | Casos | Negocios |
| --- | ---: | --- |
| ORDEN SIN VALE DE INVENTARIO | 30 | Mindform |
| PROPINA NO CUADRA | 1 | Testarudo Cafe |
| SOBREPAGO | 9 | Testarudo Cafe: 4; Amaena: 3; BAE MEZQUITAL (1298): 2 |

El usuario aportó otro bloque con timestamp interno `2026-09-09T12:17:03Z`; la consulta de Better Stack no recuperó esa ventana exacta. Los bloques anteriores y la base de producción sí confirman las mismas órdenes e importes aportados.

El job corre cada seis horas (`17 */6 * * *`, America/Mexico_City) y reemite cada violación pendiente más un resumen. No distingue un hallazgo nuevo de uno ya emitido. Hay dos casos adicionales triados que reporta como INFO y no forman parte de los 40.

## Mindform: falta el vale nuevo, pero existen movimientos de stock

La consulta exacta del predicado de inventario encontró 30 órdenes sin `InventoryPosting SALE`. Todas tienen al menos un `RawMaterialMovement` o `InventoryMovement` vinculado por referencia a la orden.

Las órdenes abarcan del 14-ago al 18-ago a las 19:07 UTC, antes del primer `InventoryPosting` que hoy existe en Mindform: **19-ago-2026 01:48:08.585 UTC**. El detector exige el vale desde **14-ago**, apoyándose originalmente en fechas de commits. Se comprobó posteriormente que la migración `20260813163837_inventory_posting_outbox` se aplicó en producción el **14-ago a las 17:45:29.939–17:45:30.220 UTC**. Por tanto, no sería correcto mover el corte al 19-ago afirmando que la tabla no existía. La fecha exacta de activación de cada camino sigue sin demostrarse.

Los dos ejemplos del usuario prueban deducciones contemporáneas al cobro:

| Orden | Evidencia |
| --- | --- |
| `cmsy1t92h0c8jp02b73csc3q6`, $272 | Movimiento `SALE` de -1, stock **7 → 6**, el 18-ago a las 02:33:52.394 UTC. Cierre: 02:33:51.533 UTC. |
| `cmsyo78hb0chbp02b0trvac1r`, $236 | **18 movimientos `USAGE` negativos** de materias primas, entre 13:00:33 y 13:00:42 UTC del 18-ago. Cierre: 13:00:31.592 UTC. |

En ambos casos `postingLineId=null`: el registro del movimiento existe sin el mecanismo nuevo. La alarma demuestra ausencia de vale, **no ausencia de deducción**. No se auditó la cobertura completa de cada ingrediente de las 30 ventas; la existencia de movimientos no certifica por sí sola que todo el stock sea correcto.

No se debe crear y aplicar retrospectivamente un vale sólo para callar estas alertas: podría repetir deducciones ya realizadas. La corrección del detector debe reconocer evidencia histórica de manera acotada, conservando la detección de faltantes nuevos.

Código: `src/jobs/money-integrity-watchdog.job.ts:91` y `:307`; predicado de elegibilidad en `src/services/inventory/inventoryPosting.service.ts`.

## Testarudo: dos cuentas cobradas dos veces con aprobaciones distintas

Las cuatro filas Payment pertenecen a la cuenta merchant `testarudo`, configurada como `PRODUCTION`. Cada una tiene un webhook Blumon TPV vinculado con `operationType=VENTA`, `codeResponse=00`, `descriptionResponse=APROBADA` y estado procesado.

| Orden | Primer pago | Segundo pago | Separación |
| --- | --- | --- | --- |
| `cmtki3bht011zqr2bua5s36e0` | 2-sep 19:40:19.938 UTC; Mastercard; autorización `917731`; $46.75 + $7.01 propina | 2-sep 19:40:59.734 UTC; American Express; autorización `894294`; $46.75 + $7.01 propina | 39.796 s |
| `cmtly54gf04cgi12amztqi5hm` | 3-sep 19:57:28.382 UTC; Mastercard; autorización `072507`; $135 | 3-sep 20:08:01.718 UTC; Visa; autorización `655773`; $135 | 10 min 33.336 s |

En hora de Ciudad de México corresponden al **2 de septiembre a las 13:40** y al **3 de septiembre a las 13:57 y 14:08**, respectivamente. Sustituyen las horas 19:40 / 19:57 / 20:08 comunicadas inicialmente como CDMX.

Ambos pares tienen referencias e `idempotencyKey` diferentes y proceden de la misma terminal. No son dos inserciones con la misma identidad de pago. La auditoría `SOBREPAGO_DETECTADO` confirma `wasAlreadyPaid=true` al registrar el segundo pago en cada orden.

La ruta de registro deduplica por clave de intento y referencia; estos pares no coinciden por ninguna. Cuando llega una aprobación nueva, el backend la registra aunque la cuenta ya estuviera pagada, porque rechazar su registro después del cargo dejaría dinero sin contabilizar. Ese comportamiento y la alarma están documentados en `src/services/tpv/payment.tpv.service.ts:628` y `:1920`.

Esto demuestra dos ventas aprobadas por el procesador atribuidas a cada cuenta. **No establece si pertenecían al mismo cliente, si el segundo intento se originó en una respuesta perdida, ni su liquidación o reversión posterior en el banco.** Se necesita conciliación operativa con el procesador y el negocio para decidir entre cargo indebido y venta atribuida a la orden incorrecta.

El watchdog compara importes sin propina: por eso el primer ejemplo dice `93.50` contra `46.75`, aunque las dos aprobaciones fueron de **$53.76** y sumaron **$107.52** incluyendo propinas.

### Seguimiento: hipótesis de problema de conexión

El usuario no conoce el detalle operativo y plantea la conexión como posibilidad, no como hecho confirmado. Se consultaron los registros durables para evitar depender de su recuerdo:

- Existe **una `TerminalPaymentRequest` por cada orden**, vinculada al primer Payment. Ambas están `COMPLETED`, con `lateResult=false` y `failureCode=null`. Sus últimas actualizaciones son 2-sep 19:40:20.697 UTC y 3-sep 19:57:29.157 UTC. No hay segunda solicitud durable para esas órdenes en el resultado completo acotado (dos filas, límite 30).
- Hay un `TerminalLog` **`PHASE 1 PreTrans iniciado` para cada uno de los cuatro pagos**. Se ligaron por `metadata.attemptId = Payment.idempotencyKey`, además de venue y terminal. Todos tienen `flowOrigin=ORDER` y el importe correspondiente. Esto demuestra que el segundo pago atravesó otro inicio del procesamiento de tarjeta, no únicamente una retransmisión del POST de registro.
- En ventanas de cinco minutos alrededor de los pagos, los logs de terminal recuperados son 14 entradas INFO `PaymentTrace`; sólo registran inicios, sin WARN/ERROR ni evidencia de qué mostró la pantalla al finalizar. No permiten demostrar ni descartar una confirmación perdida. Los marcadores del resto de intentos cercanos no se atribuyen a estas órdenes.
- Better Stack ya no devolvió logs del servidor de los días 2 y 3 de septiembre; la consulta de cobertura del 2 al 6 devolvió datos únicamente del 6. Los logs locales tampoco contienen estos IDs.
- El código actual **ya tiene** un candado para órdenes `PAID` al enviar un cobro remoto (`src/services/terminal-payment.service.ts:302`). No se debe proponer simplemente añadirlo otra vez. Hay que identificar el camino de reinicio en terminal y el estado de pantalla/sesión, y comprobar la versión desplegada entonces, antes de atribuir una causa de software.

Conclusión: la pérdida de confirmación por conexión es posible, pero no está probada. Lo confirmado es que hubo un nuevo intento de tarjeta después de un primer pago aprobado. Las solicitudes completadas en servidor no certifican la recepción de la confirmación por el POS o la terminal. No se implementó una corrección de pagos ni se ejecutaron devoluciones basándose en esta hipótesis.

## Propina: incompatibilidad con un reembolso importado

Orden `cmspisqsf0knav1u9ot73dte3`, cheque SoftRestaurant `27074`, 1-jul-2026:

- Origen `POS_SOFTRESTAURANT`; orden `CANCELLED`, propina $500.
- Su Payment conserva importe $355 y propina $500, pero tiene **status `REFUNDED` y type `REGULAR`**.
- El watchdog suma propinas sólo de pagos `COMPLETED`, por lo que obtiene cero.
- Su exclusión de reembolsos sólo busca **type `REFUND`**; no reconoce esta representación importada.

El mensaje `orden=500 cobros=0` no demuestra pérdida de $500: la propina está registrada en un pago marcado como reembolsado. El detector compara estados que no son equivalentes. Código: `src/jobs/money-integrity-watchdog.job.ts:180`.

## Otros siete avisos de sobrepago

Además de las dos órdenes anteriores, se verificaron estas filas:

| Negocio / orden | Cuenta sin propina | Pagos sumados | Hallazgo confirmado |
| --- | ---: | ---: | --- |
| Testarudo `cmspisqpx0gsxv1u9jfx46vaf` | $47.41 | $55 | Importación SoftRestaurant del 16-may; IVA guardado en cero. Diferencia $7.59 compatible con el IVA omitido documentado en investigación anterior; no se cotejó de nuevo el archivo de origen. |
| Testarudo `cmtium34s004rns1sxoykya1l` | $80 | $85 | Un pago con tarjeta, propina guardada en cero. Falta conciliar los $5. |
| Amaena `cmtkl5rg701tvqr2b3a3ztvxv` | $475 | $522.50 | Un pago, propina guardada en cero. |
| Amaena `cmtknmwso00f7ng2a7ttu02dr` | $475 | $2,422 | Tarjeta $892 y efectivo $1,530. |
| Amaena `cmtnbfqjc0cjxi12afg5jbewr` | $430 | $1,693 | Tarjeta $473 y otro pago con tarjeta $1,220 al día siguiente. |
| BAE MEZQUITAL `cmthu1l9700bxsg2alu1cc64a` | $0 | $100 | Efectivo registrado contra orden en cero. |
| BAE MEZQUITAL `cmthuojrp00jksg2asdzbmzxa` | $0 | $100 | Efectivo registrado contra orden en cero. |

No se adjudicó la causa operativa de las filas de Amaena y BAE ni de los $5 de Testarudo. No deben tratarse automáticamente como fraude, cobro duplicado o falso positivo.

## Trabajo necesario

1. Corregir con regresiones la compatibilidad del detector con deducciones históricas y reembolsos importados. Evitar exclusiones generales por negocio, estado o existencia de un solo movimiento que pudieran esconder faltantes reales.
2. Conciliar los dos pares de aprobaciones de Testarudo y los otros importes pendientes; preservar los registros hasta identificar qué representan.
3. Investigar la ruta previa a una nueva autorización en terminal/POS para impedir volver a cobrar una cuenta cubierta y resolver resultados inciertos sin generar otro intento de tarjeta. El registro de una aprobación ya obtenida debe seguir preservándose.

## Corrección local del detector

- La regla de vales conserva el corte original del 14-ago. Sólo clasifica como revisión histórica una orden TPV creada, cerrada y actualizada antes del **19-ago-2026 00:00 UTC**, con una deducción negativa `SALE`/`USAGE` del mismo negocio y referencia de orden, disminución efectiva de stock y `postingLineId=null`, entre el cierre y sus 15 minutos siguientes, también anterior al corte. La fecha limita el conjunto histórico investigado; no pretende representar un despliegue.
- Estos casos permanecen en **un WARN agrupado por pasada**, con total real y hasta 30 ejemplos. El mensaje indica que falta revisar la cobertura de inventario. No se certifican todos los ingredientes, no se crean vales y no se silencian otras anomalías de esas órdenes. Los faltantes nuevos o sin evidencia siguen como ERROR.
- La regla de propina reconoce una orden **cancelada e importada de SoftRestaurant cuyos pagos son todos importados y REFUNDED**. Una mezcla de pagos, un pago fallido o un origen nativo mantiene la alerta. No se cambia el registro de la venta ni del reembolso.
- Los sobrepagos y la lista preexistente de dos casos pendientes de terceros quedan intactos.

La vista previa de la **consulta corregida exacta** sobre producción devolvió 30 revisiones históricas (todas de Mindform), cero discrepancias de propina y 11 sobrepagos, de los que dos ya estaban triados: **9 errores activos**, los mismos nueve de este informe. Se extrajeron las declaraciones puras con el AST de TypeScript para generar el SQL sin iniciar servicios ni jobs; ejecución en transacción `READ ONLY`.

`EXPLAIN (ANALYZE, BUFFERS)` del conteo: **1,742 ms** de ejecución, 11 ms de planificación, 365,153 bloques compartidos en caché y cero lecturas físicas en esa pasada. Las nuevas búsquedas de movimientos usaron los índices `InventoryMovement_createdAt_idx` (30 ciclos), `Inventory_pkey` (8) y `RawMaterialMovement_createdAt_idx` (22); ninguna exploración secuencial de movimientos. Es una medición con caché caliente, no una garantía para otro volumen.

Verificación TDD: antes de implementar, fallaron los 8 escenarios de integración y 3 unitarios que reproducen los defectos; tras la corrección pasaron **42 escenarios PostgreSQL y 16 pruebas unitarias**. La integración ejecuta las consultas completas contra tablas temporales de sesión con rollback, en zonas UTC y America/Mexico_City; no modifica tablas públicas ni fixtures compartidos. ESLint y `git diff --check` pasaron.

Typecheck del servidor: `NODE_OPTIONS='--max-old-space-size=8192' ./scripts/avq-verify.sh avoqado-server npx tsc -p tsconfig.typecheck.json`, desde el root del workspace: **exit 0, cero errores TypeScript**, 20 s de compilación en el Alienware. El verificador avisó que el árbol cambió durante la corrida: se había actualizado este informe y un comentario del job. Se compararon los cuatro archivos de código/pruebas con el snapshot compilado: el único cambio de texto era ese comentario y **los cuatro emitían exactamente el mismo JavaScript sin comentarios**. No se corrió la suite completa ni se hizo build de despliegue; no hubo commit ni push. Antes de publicar corresponde ejecutar `./scripts/avq-verify.sh avoqado-server npm run pre-deploy` y la verificación completa exigida por el repositorio.

Los puntos 2 y 3 del trabajo necesario siguen abiertos: no hay evidencia suficiente para devolver dinero o adjudicar el origen del segundo intento a una falla de conexión.
