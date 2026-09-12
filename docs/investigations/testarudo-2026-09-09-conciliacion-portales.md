# Testarudo: conciliación de exportaciones de Blumon y AngelPay

9 de septiembre de 2026. Horas CDMX (UTC−06:00). Consulta de producción de sólo lectura terminada a las 08:45:07 CDMX. No se modificaron pagos, órdenes, configuración ni código de ejecución; no hubo reembolso, push ni despliegue.

## Resultado

Actualización técnica posterior: el [análisis Android→TPV](./testarudo-2026-09-09-android-tpv-relay.md) enlaza el primer cargo de $319 con un GenericFailure de SaleIcc y otro inicio bajo el mismo intento; también identifica una desconexión Nexgo inmediatamente después del envío de $308. No cambia los resultados financieros del cruce ni acredita liquidación.

**La única aprobación de estos archivos sin Payment encontrado en Avoqado es la operación Blumon 24237797 por $319.** Es la primera de las dos aprobaciones del caso ya investigado. Las otras 166 aprobaciones Blumon de Testarudo y las 73 ventas exportadas de AngelPay coinciden con un Payment cada una, por referencia e importe total. Esos 239 Payments están COMPLETED, sus órdenes PAID y con saldo cero.

| Procesador / fecha | Filas de Testarudo | Aprobaciones explícitas en CSV | Payments coincidentes |
|---|---:|---:|---:|
| Blumon · 7 sep | 89 | 86 | 86 |
| Blumon · 8 sep | 81 | 75 | 74 |
| Blumon · 9 sep | 7 | 6 | 6 |
| AngelPay · 5 sep | 23 | Sin columna de estado | 23 |
| AngelPay · 7 sep | 25 | Sin columna de estado | 25 |
| AngelPay · 8 sep | 25 | Sin columna de estado | 25 |

Los diez resultados Blumon distintos de APROBADA no tienen Payment coincidente; sus webhooks figuran ERROR / NOT_APPROVED. No se contabilizaron como pagos faltantes. Las 73 filas AngelPay tienen tipo VENTA, pero el archivo no permite evaluar estados de rechazo, reverso o liquidación.

Importes conciliados: **$27,927.63 Blumon** y **$11,237.56 AngelPay**. El total de aprobaciones Blumon de Testarudo en el archivo es $28,246.63: diferencia de $319. Estos son importes de transacciones, no depósitos netos ni cortes de liquidación.

## Los dos cobros de $319

| Campo | Primero | Segundo |
|---|---|---|
| Fecha / hora | 08/09 14:00:15 | 08/09 14:01:53 |
| Operación Blumon | 24237797 | 24237873 |
| Autorización | 06875D | 01993D |
| Referencia del portal | 20260908150012 | 20260908150111 |
| hostResponse | 288563190332 | 962061836893 |
| Resultado CSV | APROBADA | APROBADA |
| Modo de entrada | chip | chip |
| Payment en Avoqado | No encontrado | cmtt3ievm073qnb2bk5huz7o5 |

Terminal 2841653112. Los datos enmascarados de tarjeta, BIN, banco y marca coinciden y no están vacíos; los valores se omiten del informe. Son dos operaciones distintas, separadas por 98 segundos. La primera notificación sigue PENDING, sin Payment vinculado, en la consulta del día 9. La segunda corresponde a la orden `ORD-1788897607207`, $290 + $29 de propina.

La columna Devolución está vacía en ambas filas y en todo el archivo. Eso **no prueba que no haya un reverso posterior**: no hay estado de liquidación ni historial de cambios. Falta el detalle actual o corte de Blumon para saber si ambas siguen vigentes o si una fue revertida. No se debe crear otro Payment ni reembolsar automáticamente con este CSV.

Este archivo refuerza la discrepancia financiera, pero no reconstruye qué hizo la terminal entre las dos autorizaciones. La investigación previa encontró un solo POST de registro, posterior a la segunda aprobación y terminado en 363 ms; no demuestra la causa del segundo intento.

## Nexgo y las órdenes originales

- **$308 / $280, 8 sep alrededor de 15:14:** no aparece ninguno de esos importes en el archivo AngelPay. Las ventas cercanas son $77 a las 15:10:08 y $120 a las 15:12:10; la siguiente exportada es $154 a las 16:46:20. Todas están conciliadas con Avoqado. La venta investigada fue registrada después como efectivo por $280 + $28 en otra orden, según la extracción previa. El CSV no aporta evidencia de un cargo AngelPay adicional; al carecer de estados e información sobre los filtros del export, no acredita exhaustivamente que nunca hubiera un intento autorizado y posteriormente revertido o excluido.
- **$247.50, 8 sep alrededor de 09:48:** AngelPay sí muestra la operación `260908095256` a las 09:48:49. Coincide con el pago ya identificado en la orden rehecha `ORD-1788882515132`, $225 + $22.50. La aprobación Blumon por el mismo importe a las 09:35:58 corresponde a otro Payment; no se mezcló por coincidencia de importe.
- **$77, 8 sep alrededor de 08:07:** los $77 exportados de Blumon ese día son de las 11:47, 13:00 y 13:40, y tienen sus propios Payments. No aclaran el destino de la orden de las 08:07. El primer registro de ese día en el archivo Blumon es de las 08:09:06; no se presume cobertura exhaustiva anterior.
- **$80, 8 sep alrededor de 14:31:** los registros del mismo importe de otros horarios tienen sus propios Payments; no justifican atribuir un cargo al intento cancelado. La nueva orden CASH previamente identificada sigue siendo evidencia de registro en efectivo, no de recepción física del efectivo.

## Método, alcance y comprobaciones

Archivos aportados por el usuario:

- [Blumon — tableExport (6).csv](</Users/amieva/Downloads/tableExport (6).csv>): 200 filas, de las cuales 177 son TESTARUDO CAFE / terminal 2841653112. Las 23 de otros comercios se excluyeron. SHA-256 `523c460d69ab8a8c988904b4a3b9fb2c47b444da741a19474192e7de9522b802`.
- [AngelPay — transacciones__.csv](/Users/amieva/Downloads/transacciones__.csv): 73 filas, todas TESTARUDO CAFE / terminal N860W173400. SHA-256 `eb1435258c1aaba1aabcff3f17cb1f4b235dc07e25a4f7c05a170258a99328e6`.

Cobertura observada, sin presumir que sean días completos:

| Archivo | Fecha | Primera / última hora de Testarudo |
|---|---|---|
| Blumon | 7 sep | 08:34:42–17:43:45 |
| Blumon | 8 sep | 08:09:06–18:02:46 |
| Blumon | 9 sep | 08:08:49–08:37:10 |
| AngelPay | 5 sep | 12:21:21–18:27:50 |
| AngelPay | 7 sep | 13:32:18–17:49:27 |
| AngelPay | 8 sep | 09:22:12–16:46:20 |

Se consultó únicamente el venue `cmiowv1yu000aqa27mhhxrdqe`, entre 05/09 06:00 UTC y 09/09 15:00 UTC, con `default_transaction_read_only=on`, timeout de sentencia de 10 s y lock timeout de 2 s. Dos consultas acotadas devolvieron 599 Payments y 515 ProviderEventLogs, por debajo del límite de 1001 filas impuesto a cada consulta. No se seleccionaron payloads completos ni datos de tarjeta. Los timestamps Prisma sin zona se interpretaron como UTC antes de convertir a CDMX.

Conciliación Blumon: `hostResponse` del CSV contra `Payment.referenceNumber`, con aserción adicional de autorización e importe. Conciliación AngelPay: `ID Transaccion` contra `Payment.referenceNumber` e importe. El importe comparado es `Payment.amount + Payment.tipAmount`; en AngelPay, Monto ya contiene el total cobrado aunque Propina aparezca en cero. No se utilizó Total mi ingreso como monto de venta.

Comprobaciones ejecutadas sobre todas las filas:

- Una sola fila de Payment por referencia conciliada; ninguna referencia duplicada dentro de cada export.
- Importes exactos en centavos; cero discrepancias en los 239 pares. Autorizaciones Blumon coincidentes.
- COMPLETED, PAID y saldo cero para los 239 pagos y órdenes conciliados.
- Ningún Payment con tarjeta de esas terminales, creado dentro de los intervalos observados de cada archivo, quedó sin referencia en su CSV. Esta comprobación inversa no amplía la cobertura temporal del export.
- Exploración de operaciones del mismo importe y mismos datos enmascarados de tarjeta, separadas hasta diez minutos: el único par encontrado en los archivos es el de $319. No es un detector exhaustivo de duplicados y no sustituye la conciliación de liquidaciones.

Evidencia derivada sanitizada: `/tmp/codex-testarudo-20260908/csv-reconciliation-db-20260909.json` y `csv-reconciliation-results-20260909.json`. Los CSV originales no se copiaron al repo. Sólo se añadieron documentos; no corresponde ejecutar typecheck ni suite de dinero para este cambio documental.

Contexto técnico y límites de causalidad: [investigación principal](./testarudo-2026-09-08-codex.md). Las pruebas sandbox y esta conciliación no acreditan una corrección de las terminales; el manejo de resultados inciertos sigue pendiente de implementación y verificación.
