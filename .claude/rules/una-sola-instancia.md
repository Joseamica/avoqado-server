---
paths:
  - 'render.yaml'
  - 'fly.toml'
  - 'src/server.ts'
  - 'src/communication/sockets/**/*.ts'
  - 'src/middlewares/*rate-limit*.ts'
  - 'src/jobs/**/*.ts'
---

# 🔴 Este server asume UNA sola instancia — subir a 2 NO es mover un slider

Prod corre **una instancia** (`render.yaml`, servicio `avoqado-server`, `plan: standard`). Eso no es un descuido: hay estado en la memoria
del proceso del que dependen los sockets, los rate limiters y los crons. **Subir el service a 2+ instancias —o prender autoscaling— sin
hacer antes las 4 piezas de abajo rompe la operación SIN UN SOLO ERROR EN EL LOG.** El health check pasa, el deploy sale verde, y te enteras
por el reclamo de un cliente dos días después.

Si te piden "aguanta más carga" / "optimiza el rendimiento": **la respuesta por defecto es escalar VERTICAL** (subir el plan de la
instancia). Eso no necesita ningún cambio de código y deja todo lo de abajo correcto tal cual está.

## Lo que se rompe, y por qué es silencioso

| #   | Pieza                                                 | Qué pasa con 2 instancias                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Dónde                                                                                                                |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | **Socket.IO sin adapter**                             | La TPV conectada al pod A no recibe lo que emite el pod B. El cobro pasa pero el dashboard no se mueve → el mesero cobra otra vez.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `src/communication/sockets/managers/socketManager.ts:108` (`setupRedisAdapter`, ya escrito, solo espera `REDIS_URL`) |
| 2   | **Crons duplicados**                                  | Los ~40 jobs viven DENTRO del proceso web (`src/server.ts`) → cada uno corre 2 veces. Incluye jobs de DINERO: `money-integrity-watchdog`, `settlement-detection`, `blumon-webhook-reconciliation`, `commission-aggregation`, `monthly-overage-billing`.                                                                                                                                                                                                                                                                                                                                                                     | `src/server.ts` + `src/jobs/jobSchedules.ts`                                                                         |
| 3   | **Rate limiters en memoria**                          | Los 32 `rateLimit({...})` cuentan por proceso → 2 pods = el doble de intentos permitidos. En `pin-login` y `password-reset` eso es tu defensa contra fuerza bruta partida a la mitad. 🔴 **Y `mcp-rate-limit.middleware.ts` NO usa `rateLimit({...})`** — tiene su propio store en memoria, así que un `grep 'rateLimit({'` para migrar a Redis lo SALTA en silencio. Lo mismo el **cupo por persona del MCP** (`mcp-request-guard.middleware.ts`, `McpRequestSlots`: 1 herramienta y 2 peticiones a la vez, el freno del incidente del 23-sep): con 2 pods cada uno lleva su cuenta y la persona puede correr el doble en paralelo.                                                                                                                                                                                                                                                       | `src/middlewares/*-rate-limit.middleware.ts`                                                                         |
| 4   | **Challenge store en memoria**                        | El reto de auth se emite en un pod y se valida en otro → login móvil que falla aleatoriamente.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `src/services/mobile/auth.mobile.service.ts:34`                                                                      |
| 5   | **Candado "una pasada a la vez" del job de delivery** | `DeliveryWebhookReconciliationJob.enCurso` es un booleano EN MEMORIA: con 2 pods, los dos reprocesan a la vez el MISMO evento FAILED y pueden crear DOS comandas del mismo pedido — la cocina prepara la comida dos veces. `KdsOrder.orderId` NO tiene índice único (y no puede tenerlo: ya hay órdenes con 2 comandas legítimas del sync offline de Android), así que nada lo atrapa aguas abajo. Con 2 instancias hay que mover el candado a la base: un _lease_ atómico sobre `DeliveryOrderEvent` (`updateMany` empujando `nextAttemptAt` al futuro al seleccionar), que es el patrón que ya usa el outbox de anuncios. | `src/jobs/delivery-webhook-reconciliation.job.ts` (`enCurso`, `runOnce`)                                             |
| 6   | **Avisos del banco que no se pudieron guardar**       | Cuando el INSERT del aviso firmado de AngelPay falla, el receptor contesta 503, deja dos marcas EN MEMORIA (`avisosNoGuardados.ts`): «esa aprobación es dinero de su intento» y «el canal de ese comercio acaba de fallar» (30 min), y programa su REINGRESO (también en memoria: el propio servidor vuelve a procesar el aviso hasta que la base lo guarde). Con 2 pods, la marca vive sólo en el que recibió el aviso: el otro puede liberar ese intento («no se cobró») aunque el banco lo aprobó — por la liberación automática del Pago rápido o por la ventana de 30 s de un cobro del POS (las dos la consultan). Van en memoria a propósito —el aviso no se guardó porque la base falló—, así que con 2 instancias hay que moverlas a un almacén compartido que no dependa de esa base.                                                                                                                                                                                                                    | `src/services/tpv/avisosNoGuardados.ts` (lo registra `angelpay-webhook.tpv.controller.ts`)                           |

De los cuatro, **sólo el #4 se queja**. Los otros tres fallan callados, y el #2 mueve dinero. **El #6 también mueve dinero, y también
calla.**

## El checklist ANTES de subir a 2 instancias

1. **Provisionar Redis** (Render Key Value, ~$10/mes el Starter de 256 MB) y setear `REDIS_URL`. Ojo: `REDIS_URL` es OPCIONAL en
   `src/config/env.ts:46` — si no está, el socket manager cae a adapter de memoria **sin fallar**. No hay red de seguridad: verifícalo en el
   log (`✅ Redis adapter configured`), no lo asumas.
2. **Rate limiters → `rate-limit-redis`** (ya está en `package.json`, sin usar). Los 32 sitios **más el store propio de
   `mcp-rate-limit.middleware.ts`** (no es un `rateLimit({...})`; se migra cambiando su clase `RateLimitStore`) **y el
   cupo por persona de `mcp-request-guard.middleware.ts`** (clase `McpRequestSlots`; su liberación está atada al
   trabajo vivo de la petición, así que en Redis necesita un lease con renovación, no un simple contador).
3. **Candado en los crons.** Redis NO lo resuelve solo. Usa el patrón que ya existe en casa: **advisory locks de Postgres**
   (`src/services/google-calendar/pull.service.ts:357` explica por qué se eligió eso sobre un `SETNX`). Un job de dinero corriendo dos veces
   es peor que el server lento.
4. **Challenge store de auth móvil → Redis** (o a una tabla).
5. **Lease en la base para el job de delivery.** Su candado `enCurso` es en memoria: con 2 pods no sirve. Se sustituye por un _claim_
   atómico sobre `DeliveryOrderEvent` — `updateMany` empujando `nextAttemptAt` al futuro EN la selección, que es el patrón del outbox de
   anuncios. Sin eso, dos pods reprocesan el mismo evento y la cocina prepara el pedido dos veces (nada lo atrapa: `KdsOrder.orderId` no
   tiene índice único y no puede tenerlo).

6. 🔴 **Caché de sesiones revocables → compartida** (`src/services/auth/sessionCache.ts`). Es memoria del proceso, con TTL de 60 s, y la
   consulta el middleware de auth en **cada petición**. Con 2 pods, revocar una sesión en el pod A **no invalida el pod B**: el token
   revocado sigue entrando por B hasta que su entrada expire. Falla callado y en el peor lugar posible — es justo el mecanismo que existe
   para expulsar a alguien. Se migra a una caché compartida, o se baja el TTL a 0 (que equivale a consultar la base siempre, correcto pero
   más lento). La base **siempre** es la verdad: la caché nunca acepta por defecto, así que el modo degradado es seguro, sólo lento.
7. **Desconexión de sockets por sesión/aparato** (`SocketManager`). Cierra los sockets del proceso local; con 2 pods, revocar deja vivos los
   sockets conectados al otro. Se resuelve con el adapter de Redis del punto 1 más un pub/sub que propague la orden de desconectar.
8. **Avisos del banco no guardados → almacén compartido** (`src/services/tpv/avisosNoGuardados.ts`). La marca de «esta aprobación
   es dinero de su intento» tiene que verla el pod que decide la liberación automática, no sólo el que recibió el aviso; y no
   puede vivir en la misma base cuya caída la produjo. Mientras sea memoria del proceso, además, un reinicio la pierde (residual
   declarado, gemelo del `evidenciaSinGuardar` de la terminal). El reingreso pendiente vive en el mismo sitio: con 2 pods cada
   uno reintenta lo que recibió (el `eventId` lo vuelve idempotente), y un reinicio con la base aún caída lo pierde.

Excepción deliberada que NO se migra: el dedupe de `registerDevice.middleware.ts:33` es en proceso **a propósito** — meter una dependencia
dura de Redis en el camino del cobro es peor que un dedupe imperfecto. Lee el comentario antes de "arreglarlo".

## Cuándo SÍ vale la pena (y cuándo no)

- **No lo vale por rendimiento** a la escala actual: sube el plan de la instancia y ya.
- **No lo vale por deploys**: Render ya hace deploy sin downtime con UNA instancia (levanta la nueva, health check, switch, `SIGTERM` a la
  vieja).
- **Sí lo vale por alta disponibilidad real**: sobrevivir a que un pod se muera. Considéralo cuando haya un **SLA contractual** (cliente
  enterprise) o cuando el checkout web / widget de reservas / consumer-app muevan volumen que duela — esos NO son offline-first.
- Recuerda que el POS y la TPV **sí son offline-first** (`.claude/rules/offline-first-y-hub-lan.md`): un server caído degrada, no detiene la
  venta. Esa es tu HA para lo que factura, y ya está pagada.

**Antes de comprar redundancia, mide.** Si los monitors de uptime de Better Stack están pausados, no tienes evidencia de un problema de
disponibilidad — ni te enterarías si lo tuvieras.
