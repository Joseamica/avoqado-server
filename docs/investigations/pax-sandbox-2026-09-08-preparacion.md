# PAX sandbox: preparación del laboratorio

Actualización posterior: el usuario confirmó USB y tarjeta de pruebas; se ejecutaron los [drills de contactless y recuperación](./pax-sandbox-2026-09-08-resultados.md). El texto siguiente conserva el estado inicial de preparación de las 23:11.

8 de septiembre de 2026, aproximadamente 23:11 CDMX. Preparación ejecutada; pruebas monetarias todavía pendientes de tarjeta de pruebas y conexión USB. No hubo instalación de APK, cobro, reembolso, corte de red ni modificación del código de ejecución.

## Configuración comprobada

| Elemento | Evidencia |
|---|---|
| Hardware | PAX A910S, serial 2841548417, ADB inalámbrico |
| App abierta | `com.jaac.avoqado_tpv.sandbox`, 2.8.7-sandbox (104), debuggable |
| APK instalado | SHA-256 `69b5db035bffb3ad483328057091dcbee7b4eb729f762258a446313a42ea1ad5`, idéntico al APK sandbox local; se inspeccionó su BuildConfig, no se supuso que coincidiera con el WIP actual |
| Procesador | `BLUMON_ENV=SAND`, `sandbox-core.blumonpay.net`, `sandbox-tokener.blumonpay.net` |
| API REST instalada | `http://localhost:8799/api/v1/` |
| Socket configurado | `https://patchiest-noncommemorational-willia.ngrok-free.dev`; este canal puede comportarse distinto del REST tunelado |
| Proxy existente | Puerto 8799 → `http://localhost:3000`; al leer su estado: sin rechazo, retraso ni corte activos |
| Backend local | Proceso existente en 3000; `.env` de desarrollo con PostgreSQL local `av-db-25` |
| Venue local | Restaurante El Atole, `cmpe64yq2001f9k92m0lbhmf4` |
| Terminal configurada | `cmph332eq00039kg8z9cqyc4g`, serial `AVQD-2841548417` |
| Cuentas asignadas | A: `cmpe64xca000m9k928fijhbn8`, serial Blumon 2841548417; B: `cmq850h9e00019kpwbsthqw0s`, serial 2841548418. Ambas activas, `blumonEnvironment=SANDBOX` |

Hay otro registro local de terminal con serial sin prefijo y sin cuentas asignadas. Las llamadas de arranque observadas utilizaron el id del registro `AVQD-2841548417`; no se modificó ninguno.

Se agregó el túnel ausente `adb reverse tcp:8799 tcp:8799` únicamente a la PAX y se abrió su MainActivity sandbox. El proxy registró respuestas 200 para permisos, turno, productos, módulos y heartbeat. La pantalla pasó de «Preparando sistema de pagos» al inicio; los logs del proceso muestran hosts sandbox. Esto verifica arranque y conectividad, no una autorización bancaria ni el funcionamiento completo de Socket.IO.

La PAX tenía batería crítica de 10% al terminar. Para cortes de Wi-Fi se requiere USB: el transporte actual depende de esa misma red. Al conectar por cable, volver a identificar el transporte y comprobar/aplicar el túnel a ese transporte; no asumir que se conserva.

## Antecedentes locales preservados

Antes de abrir la app se consultó una copia temporal de Room con sus archivos WAL/SHM, con el proceso detenido. Se eliminaron las copias al terminar la lectura y se conservaron solamente estos datos seleccionados. No se leyó la base privada del SDK ni se extrajeron credenciales.

Room versión 33: `pending_payments` y `pending_refunds` vacías. La libreta contenía:

| Intento | Tipo / estado | Importe | Creación CDMX |
|---|---|---:|---|
| `da4d27fa-9462-48b6-9966-ef9e577129e0` | SALE / PREPARANDO | $10 | 08 sep 10:26:03 |
| `79065c4b-089f-4fbd-815d-e4ef2d8af898` | SALE / PREPARANDO | $10 | 08 sep 10:42:16 |
| `9f68f11c-40f9-4947-977a-1750cae6d065` | SALE / REGISTRADO, host aprobado | $10 | 08 sep 10:46:51 |
| `8249674a-eee2-4e47-aee7-dab31a6b9c28` | REFUND / INDETERMINADO, host sin resultado | $10 | 08 sep 10:53:23 |

Todos pertenecen al venue local indicado. Son anteriores a esta preparación, no resultados de pruebas nuevas. No se descartaron, reintentaron ni limpiaron. El sweep de libreta inspeccionado es observacional; sus estados abiertos no equivalen automáticamente a un job que vuelva a cobrar.

## Pruebas por ejecutar

Cada prueba debe tener orden e `attemptId/idempotencyKey` propios; los reintentos de registro deben conservar la misma identidad. Registrar tiempos UTC y CDMX de inicio EMV, autorización online, resultado del host, persistencia local, POST, primer commit, saldos de orden y fin/corte HTTP. Conservar sólo referencias operativas y datos sanitizados de logs.

| Escenario | Interrupción | Evidencia necesaria para evaluarlo |
|---|---|---|
| Control con chip | Ninguna | Una autorización sandbox, un Payment, orden/saldo correctos y recibo utilizable; tiempos por fase |
| Sin red antes del cobro | Cortar antes de iniciar EMV/host, con ADB por USB | Estado de conectividad y UX; determinar si bloquea antes de autorizar; comprobar procesador y libreta, sin inferir ausencia de cargo únicamente por el mensaje local |
| Resultado del host desconocido | Cortar durante autorización online | Correlación con historial sandbox; conservar incertidumbre si no hay veredicto; comprobar que no se presenta como rechazo confirmado ni se inicia otra autorización a ciegas |
| Host aprobado, POST aún no enviado | Interceptar el registro después del resultado aprobado | Resultado durable en la libreta/cola; al recuperar red, un solo Payment con la identidad original y ninguna nueva autorización |
| Commit completado, respuesta perdida | Reenviar POST y descartar su respuesta después de observar el commit | Repetir registro con la misma clave; una sola Payment, saldos/asientos/recibo sin duplicados; observar el evento de cierre HTTP |
| Muerte del proceso en ambas fronteras | Antes de iniciar autorización, y tras aprobación durable antes de registrar | Estado local recuperable y correlación con procesador/backend; nunca volver a autorizar por el mero reinicio |

El proxy existente es de otra sesión: se inspeccionó sin cambiar su modo, vaciar su bitácora ni detenerlo. Su opción de retrasar retiene la petición **antes de reenviarla**; su opción de cortar la descarta **antes del backend**. Ninguna de las dos reproduce por sí sola una respuesta perdida después del commit. Ese escenario necesita un interceptor independiente que reenvíe, observe el resultado y corte sólo la respuesta. Tampoco el proxy REST controla directamente la llamada del SDK a Blumon. No reportar esas ventanas como cubiertas por un corte genérico de Wi-Fi.

No se usó `scripts/capture-logs.sh`: limpia logcat, detiene capturas previas y no selecciona dispositivo en todas las llamadas. Se inspeccionaron logs del PID sandbox sin limpiar el buffer y se emitieron sólo marcadores seleccionados.

Esta preparación no modifica lógica monetaria: no corresponde reportar TDD, suite ni integración como ejecutados. Si se implementa el refactor del servidor o un cambio de comportamiento de pagos, rigen TDD primero, PostgreSQL real, suite y typecheck por `avq-verify`, y auditoría final.
