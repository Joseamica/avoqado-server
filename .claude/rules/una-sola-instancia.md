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

Si te piden "aguanta más carga" / "optimiza el rendimiento": **la respuesta por defecto es escalar VERTICAL** (subir el plan de la instancia).
Eso no necesita ningún cambio de código y deja todo lo de abajo correcto tal cual está.

## Lo que se rompe, y por qué es silencioso

| # | Pieza | Qué pasa con 2 instancias | Dónde |
|---|-------|---------------------------|-------|
| 1 | **Socket.IO sin adapter** | La TPV conectada al pod A no recibe lo que emite el pod B. El cobro pasa pero el dashboard no se mueve → el mesero cobra otra vez. | `src/communication/sockets/managers/socketManager.ts:108` (`setupRedisAdapter`, ya escrito, solo espera `REDIS_URL`) |
| 2 | **Crons duplicados** | Los ~40 jobs viven DENTRO del proceso web (`src/server.ts`) → cada uno corre 2 veces. Incluye jobs de DINERO: `money-integrity-watchdog`, `settlement-detection`, `blumon-webhook-reconciliation`, `commission-aggregation`, `monthly-overage-billing`. | `src/server.ts` + `src/jobs/jobSchedules.ts` |
| 3 | **Rate limiters en memoria** | Los 32 `rateLimit({...})` cuentan por proceso → 2 pods = el doble de intentos permitidos. En `pin-login` y `password-reset` eso es tu defensa contra fuerza bruta partida a la mitad. | `src/middlewares/*-rate-limit.middleware.ts` |
| 4 | **Challenge store en memoria** | El reto de auth se emite en un pod y se valida en otro → login móvil que falla aleatoriamente. | `src/services/mobile/auth.mobile.service.ts:34` |

De los cuatro, **sólo el #4 se queja**. Los otros tres fallan callados, y el #2 mueve dinero.

## El checklist ANTES de subir a 2 instancias

1. **Provisionar Redis** (Render Key Value, ~$10/mes el Starter de 256 MB) y setear `REDIS_URL`. Ojo: `REDIS_URL` es OPCIONAL en
   `src/config/env.ts:46` — si no está, el socket manager cae a adapter de memoria **sin fallar**. No hay red de seguridad: verifícalo en el
   log (`✅ Redis adapter configured`), no lo asumas.
2. **Rate limiters → `rate-limit-redis`** (ya está en `package.json`, sin usar). Los 32 sitios.
3. **Candado en los crons.** Redis NO lo resuelve solo. Usa el patrón que ya existe en casa: **advisory locks de Postgres**
   (`src/services/google-calendar/pull.service.ts:357` explica por qué se eligió eso sobre un `SETNX`). Un job de dinero corriendo dos veces
   es peor que el server lento.
4. **Challenge store de auth móvil → Redis** (o a una tabla).

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
