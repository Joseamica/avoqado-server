# Contexto de ejecución — el hilo que identifica cada operación

Desde 2026-08-09 el backend arrastra un contexto por operación con `AsyncLocalStorage`, de modo que **cualquier** `logger.*` sabe a qué
venue y a qué usuario pertenece sin que su sitio de llamada pase nada. Todo vive en `src/observability/`.

## Qué hay

| Archivo               | Qué hace                                                                |
| --------------------- | ----------------------------------------------------------------------- |
| `executionContext.ts` | El `AsyncLocalStorage`: `runWithContext`, `getContext`, `enrichContext` |
| `logContext.ts`       | Formato de winston que inyecta el contexto en **todo** registro         |
| `correlationId.ts`    | `resolveCorrelationId` / `sanitizeCorrelationId` + `CORRELATION_HEADER` |
| `entrypoint.ts`       | `normalizeEntrypoint`: ids → `:id`, borra el query string               |
| `jobContext.ts`       | `scheduleJob` / `scheduleCron`: reemplazo directo de los schedulers     |
| `socketContext.ts`    | `onWithContext`: reemplazo directo de `socket.on`                       |

## Cómo se abre el contexto en cada camino

| Camino    | Cómo                                                                         | Estado                      |
| --------- | ---------------------------------------------------------------------------- | --------------------------- |
| HTTP      | `requestLogger.ts` abre; `authenticateToken.middleware.ts` estampa el tenant | ✅                          |
| Cron jobs | `scheduleJob('nombre', ...)` en vez de `new CronJob(...)`                    | ✅ 40 de 42                 |
| Socket.IO | `onWithContext(socket, evento, handler)` en vez de `socket.on(...)`          | ✅ los 20                   |
| RabbitMQ  | —                                                                            | **apagado, no lo trabajes** |

🔴 **La regla, y es lo único que hay que recordar: nunca llames al scheduler ni a `socket.on` directamente.** Hay tests que fallan si
alguien lo hace.

Los helpers reciben **los mismos argumentos** que la función que reemplazan, con un nombre adelante. El callback se copia **verbatim**, y
eso es deliberado: la primera versión de este trabajo reescribía cada callback a mano, que es exactamente donde se pierde un
`this.metodo.bind(this)` y el job queda tronando en silencio para siempre. Copiar el argumento sin tocarlo vuelve ese error **imposible**,
en vez de solo detectable.

**Pendientes conocidos:**

- `catalog-publication-outbox-sweeper.job.ts` y `catalog-publication-watchdog.job.ts` — no migrados porque otra sesión los estaba editando.
  Están en una lista de exclusión en `tests/unit/jobs/jobContextGuard.test.ts` **con un test que verifica que la lista sea real**; la lista
  solo puede encoger.
- **RabbitMQ**: `DISABLE_RABBITMQ=true` en el `.env` local, verificado en el log de arranque. En prod el flag se define desde el dashboard
  de Render, **no** desde `render.yaml`: confírmalo antes de asumir que corre. Plan:
  `docs/superpowers/plans/2026-08-08-observabilidad-server.md`, Tarea 5, en suspenso.

## Reglas al tocarlo

**1. 🔴 Un wrapper de contexto NUNCA atrapa un error.** Abrir contexto y capturar errores son responsabilidades distintas. Un wrapper que se
traga una excepción convierte la observabilidad en la causa del siguiente bug invisible. `runWithContext` devuelve lo que devuelva el
callback y deja propagar; si algún día hace falta capturar, se hace en el `catch` terminal de cada camino, no aquí.

**2. Al agregar un punto de arranque nuevo**, el contexto se construye **por invocación**, no al registrar el callback. Si lo construyes una
vez y lo reusas, todos los ticks comparten el mismo `correlationId` y las mutaciones de `enrichContext` se filtran entre ellos.

```typescript
// ✅ un contexto por ejecución
const wrap =
  (makeCtx: () => ExecutionContext, fn: Fn) =>
  (...a) =>
    runWithContext(makeCtx(), () => fn(...a))
```

**3. Envuelve el cuerpo completo, no solo la continuación.** En HTTP los listeners de `res` se registran **antes** de `next()`; envolver
solo `next()` los deja fuera y el log de cierre —el que la gente busca— pierde el tenant. El contexto se hereda en el momento del
**registro** del callback, no en el de su ejecución.

**4. El campo explícito del sitio de llamada siempre gana** sobre el ambiental. Quien llama sabe algo que el contexto no.

**5. Nada de texto crudo del cliente como campo de log.** El `X-Correlation-ID` entrante pasa por `sanitizeCorrelationId`: acota longitud y
charset, y rechaza arrays (Express entrega array cuando el header llega dos veces). Un header hostil **nunca** es error: se genera uno nuevo
y se sigue.

**6. Usa `normalizeEntrypoint`, no la URL cruda.** Sin normalizar, cada id crea su propia etiqueta y la agrupación deja de servir; además el
query string puede cargar datos personales.

## Trampas al escribir tests (costaron dos intentos)

- **`@/config/logger` está mockeado globalmente** en `tests/__helpers__/setup.ts`. Cualquier export nombrado que pongas ahí **desaparece**
  en tests. Por eso el formato vive en `observability/logContext.ts`.
- **`@/config/env` corre validación y `process.exit(1)` al importarse.** Importarlo desde un test puede matar al worker de Jest. Por eso los
  helpers puros viven en `config/envHelpers.ts`.
- **Regla general: toda pieza pura va en su propio módulo sin efectos secundarios.**
- Para correr un archivo suelto: `npx jest --selectProjects unit --testPathPattern "<nombre>"`. El argumento posicional **no filtra** en
  este repo, corre la suite entera.

## Cómo se usa para investigar

```bash
LOG=$(ls -t logs/development*.log | head -1)
grep "venueId: '<id>'" "$LOG"                     # todo lo de un venue
grep "correlationId: <id>" "$LOG"                 # una operación de punta a punta
grep "entrypoint: 'POST /api/v1/tpv/payments'" "$LOG"   # un endpoint, sin importar los ids
```

El `correlationId` viaja en el header `X-Correlation-ID` de la respuesta: tómalo del cliente (devtools, `curl -i`, logcat) y búscalo aquí
para tener la traza exacta de ESA operación.
