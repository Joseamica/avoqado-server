# PAX chip: control y corte de Wi-Fi durante lectura

9 de septiembre de 2026, aproximadamente 08:14–08:23 CDMX. Usuario confirmó tarjeta de pruebas insertada. PAX A910S 2841548417 conectada por USB; app `com.jaac.avoqado_tpv.sandbox`, 2.8.7-sandbox (104), cuenta B de Blumon sandbox, backend y PostgreSQL locales. SHA-256 instalado verificado de nuevo: `69b5db035bffb3ad483328057091dcbee7b4eb729f762258a446313a42ea1ad5`, mismo APK de las pruebas de contactless.

**No se reprodujo el atasco del chip en estos dos recorridos.** El control terminó aprobado; al cortar Wi-Fi durante la lectura, el chip también terminó y después falló la resolución DNS del host de autorización. No equivale a descartar un fallo intermitente, otra tarjeta, otra fase del SDK o producción.

## Control de $10.05, sin propina

- `attemptId/idempotencyKey`: `685d1ab8-0f04-4002-8891-c475f0da028c`.
- Payment: `cmtu6lzjt006hc9ue7vp1bwuk`, creado a las 08:16:26.681 CDMX.
- Operación sandbox informada por SDK/libreta: `81849`.
- Entrada **CHIP**, COMPLETED, importe $10.05, propina $0.00.
- PostgreSQL real: un solo Payment, orden PAID, `paidAmount=10.05`, saldo cero, un DigitalReceipt y un VenueTransaction. Aserciones ejecutadas sobre esos valores; QR visible en la PAX.

| Tramo, mismo reloj de logcat | Duración |
|---|---:|
| StartEmvTrans → fin del procesamiento de chip | 9 335 ms |
| AUTORIZANDO → HOST_RESPONDIO | 2 596 ms |
| Inicio del registro → recibo incorporado a Success | 319 ms |
| PREPARANDO → recibo | 13 354 ms |

El tramo de chip incluye interacción/espera del PIN; no se atribuye entero a CPU o a una llamada de base de datos. El total de 13.35 segundos no es la duración del POST. La tarjeta **no requirió CompleteEmvTrans/ARPC** en este control: el log señala que se omitió esa fase. Por ello no se verificó la ruta que sí actualiza el chip con ARPC.

## $10.06 propuestos: corte al entrar a StartEmvTrans

- `attemptId/idempotencyKey`: `76226b8d-9266-4846-b114-456e44eec1bd`.
- Un observador temporal leyó los marcadores nuevos de logcat y, al detectar `chip_kernel_start`, ejecutó `svc data disable` seguido de `svc wifi disable`. Se abstendría de cortar si antes aparecía AUTORIZANDO.
- El corte se inició a las 08:19:15.711 CDMX y sus comandos terminaron a las 08:19:15.967. Se verificó `wifi_on=0`. El ajuste global `mobile_data` seguía mostrando 1, pese al comando: **no se afirma que ambos transportes quedaran deshabilitados**. La PAX mostró «Sin conexión a internet» y se observó fallo DNS del SDK.
- El chip terminó **13 644 ms** después de StartEmvTrans, con marcadores de PIN durante ese intervalo. Después se intentó SaleIcc; en **693 ms** desde AUTORIZANDO apareció el fallo de autorización por conexión.
- El `UnknownHostException` correspondió a **`sandbox-core.blumonpay.net`**. El recorrido no se detuvo indefinidamente en StartEmvTrans.
- La pantalla mostró «Error de conexión. Verifica tu conexión a internet e intenta nuevamente», con botones Reintentar y Cancelar. No se tocó Reintentar ni se inició otra autorización; se canceló la pantalla.

El snapshot de Room, tomado con la app detenida a las 08:20:48 CDMX, conserva:

| Campo | Valor |
|---|---|
| state | AUTORIZANDO |
| amount_cents / tip_cents | 1006 / 0 |
| host_approved | null |
| operation_id | null |
| recording_route | FAST |
| Fila en pending_payments para esa clave | Ninguna |

PostgreSQL local: cero Payments para esa clave. En el proxy del laboratorio, la ventana de las pruebas de chip sólo contiene el POST exitoso de $10.05; no apareció registro de $10.06. No se verificó un corte independiente del portal sandbox, por lo que se reporta **sin aprobación observada**, no como una liquidación/rechazo bancario confirmado.

La libreta y la UX necesitan interpretarse por fase: este error DNS ocurrió antes de obtener un resultado del host, mientras el intento persistido permanece AUTORIZANDO. No se debe generalizar su botón Reintentar a una respuesta perdida después de que el procesador pudiera haber aprobado. Este experimento no cubre esa segunda ventana.

## El log de PIN produce falsos indicadores de error

En el control aprobado de $10.05 apareció dos veces `PIN incorrect or error: null`: una antes de PREPARANDO y otra después de terminar EMV, antes de la autorización online. También hubo marcador de PIN correcto y finalmente aprobación, Payment y recibo.

Esto reproduce la advertencia de la investigación de producción: **ese texto, cuando lleva null, no demuestra un PIN incorrecto ni identifica la causa de un atasco**. El consumidor del flujo trata cualquier valor distinto de cero como error, incluido el estado null. No se capturó ni almacenó el PIN introducido.

## Alcance y estado final

Se autorizó una venta adicional de **$10.05 en sandbox**. El segundo intento propuesto fue de $10.06 y no produjo Payment observado. Sumado a las cuatro ventas de contactless anteriores, hay cinco pagos de laboratorio por $50.11. No hubo cargos, reembolsos ni ajustes de producción.

Las pruebas siguen usando **Pago rápido `/fast`**. No cubren el endpoint de orden `/orders/:id`, caída del servidor a mitad de transacción, outbox, entrega duplicada de sus consumidores, ARPC ni pérdida de respuesta del procesador tras una aprobación. Los tiempos se calculan dentro del reloj del dispositivo; no se mezclan con timestamps de la Mac para obtener duraciones.

Se restauraron Wi-Fi y datos móviles a sus valores iniciales, ambos 1, y se conservó el túnel `tcp:8799 → tcp:8799`. La app sandbox fue reabierta. Se preservó el intento de $10.06; no se borró ni se marcó descartado mediante SQL. No se modificaron APK, código de ejecución del servidor/TPV, ni configuración de producción. Sin push ni despliegue; no se reportan typecheck o suites de aplicación como ejecutados porque no hubo cambios de ese código.

Evidencia local seleccionada en `/tmp/codex-testarudo-20260908/`: `chip-control-20260909-markers.jsonl`, `chip-control-20260909-postgres.json`, `chip-network-cut-20260909.json`, `chip-network-dns-20260909.json`, `chip-final-room-20260909.json` y `chip-cut-20260909-postgres.json`.
