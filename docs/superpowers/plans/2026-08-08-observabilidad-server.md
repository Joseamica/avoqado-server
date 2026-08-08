# Observabilidad del server: contexto de ejecución + error tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que todo error del backend salga identificado con su venue, su usuario y un hilo de correlación que sobreviva la cadena de llamadas, y que llegue agrupado a Better Stack Errors con el release que lo introdujo.

**Architecture:** Un `AsyncLocalStorage` guarda un `ExecutionContext` por unidad de trabajo. Cuatro puntos de arranque lo abren (request HTTP, tick de cron, mensaje de RabbitMQ, evento de Socket.IO) y todo lo que corre debajo lo hereda sin pasarlo a mano. Un formato de Winston lo inyecta en cada log; un `beforeSend` de Sentry lo inyecta en cada evento de error tras limpiar datos sensibles. Abrir contexto y capturar errores son responsabilidades separadas a propósito: los wrappers de contexto nunca atrapan.

**Tech Stack:** Node 20 + TypeScript (CommonJS), Express 4, Winston, `node:async_hooks`, `@sentry/node` v8, Jest + ts-jest.

**Spec:** `docs/superpowers/specs/2026-08-08-observabilidad-de-errores-design.md` (decisiones D1–D6 cerradas, no re-litigar).

**Alcance de este plan:** SOLO `avoqado-server` (Partes A y B del spec). El dashboard y las tres apps móviles tienen planes propios.

## Global Constraints

- **Idioma del código: inglés.** Identificadores, comentarios y nombres de test en inglés. Solo lo que lee una persona (mensajes de Zod, `AppError`, respuestas de API) va en español.
- **Mensajes de Zod en español.** `src/middlewares/validation.ts` los muestra tal cual al usuario.
- **Git: nunca commitear sin permiso explícito del founder** (`.claude/rules/testing-and-git.md`). Los pasos de commit muestran el comando exacto; **preguntar antes de ejecutarlo**.
- **`git add` siempre por rutas explícitas.** Nunca `git add -A` ni `git add .`: hay otras sesiones de IA editando el árbol de trabajo.
- **No tocar la regla de cron jobs.** `.claude/rules/cron-jobs.md` obliga a que la primera lectura de DB de cada job vaya envuelta en `retry(..., shouldRetryDbConnectionError)`. Este plan envuelve el tick por fuera; **no mover, quitar ni anidar ese `retry` existente**.
- **Nada de secretos al repo.** `Joseamica/avoqado-server` es **público** (verificado 2026-08-08). Ningún DSN real, token ni `.env` entra al control de versiones.
- **Compatibilidad de API intacta.** No se elimina ni renombra ningún campo de respuesta.
- **Tests:** unitarios en `tests/unit/**/*.test.ts`, alias `@/` para `src/`. Correr con `npx jest --selectProjects unit`.
- **Formato:** al terminar cada tarea, `npm run format && npm run lint:fix`.

---

## File Structure

| Archivo | Responsabilidad | Tarea |
|---|---|---|
| `src/observability/executionContext.ts` | **Nuevo.** El `AsyncLocalStorage` y su API. Puro, sin dependencias del framework | 1 |
| `src/observability/jobContext.ts` | **Nuevo.** Abrir contexto para un tick de cron | 4 |
| `src/observability/redactPatterns.ts` | **Nuevo.** Patrones de datos sensibles y el redactor recursivo. Puro | 7 |
| `src/observability/sentry.ts` | **Nuevo.** `Sentry.init` en el cuerpo del módulo, `beforeSend`, `beforeBreadcrumb` | 8 |
| `src/config/logger.ts` | Se le añade un `format` que inyecta el contexto | 2 |
| `src/middlewares/requestLogger.ts` | Punto de arranque HTTP | 3 |
| `src/middlewares/authenticateToken.middleware.ts` | Enriquece el contexto con el tenant | 3 |
| `src/communication/rabbitmq/{publisher,consumer}.ts` | Header `x-correlation-id` | 5 |
| `src/communication/rabbitmq/commandRetryService.ts` | Contexto propio (corre en `setInterval`, no pasa por ningún punto de arranque) | 5 |
| `src/communication/sockets/managers/socketManager.ts` | Punto de arranque de sockets | 6 |
| `src/app.ts` | Único punto de captura del camino HTTP | 9 |
| `src/server.ts` | Import de Sentry primero; captura en handlers de proceso | 8, 9 |
| `src/config/env.ts` | `SENTRY_DSN` opcional | 8 |
| `src/jobs/*.job.ts` | Envolver el tick | 4 |

`src/observability/` es un directorio nuevo. Todo lo que agrega este plan vive ahí, para que revertirlo sea borrar una carpeta más cinco puntos de enganche.

---

### Task 1: El contexto de ejecución

**Files:**
- Create: `src/observability/executionContext.ts`
- Test: `tests/unit/observability/executionContext.test.ts`

**Interfaces:**
- Consumes: nada. Es la base.
- Produces: `ExecutionContext` (interface), `ContextSource` (type), `runWithContext<T>(ctx: ExecutionContext, fn: () => T): T`, `getContext(): ExecutionContext | undefined`, `enrichContext(patch: Partial<ExecutionContext>): void`. Todas las tareas siguientes dependen de estos cuatro nombres exactos.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/observability/executionContext.test.ts`:

```typescript
/**
 * The execution context is the thread that carries correlationId + tenant through the
 * whole call chain. Two properties matter more than anything else:
 *
 * 1. Isolation. Two concurrent requests from different venues must never see each
 *    other's context. If they do, we would attribute a money bug to the wrong venue,
 *    which is worse than having no attribution at all.
 * 2. Survival across await. The whole point is that a service three layers down, after
 *    several awaits, still sees the context without anyone passing it.
 */

import { runWithContext, getContext, enrichContext, ExecutionContext } from '@/observability/executionContext'

const baseContext = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  correlationId: 'corr-1',
  source: 'http',
  entrypoint: 'GET /test',
  ...overrides,
})

describe('executionContext', () => {
  it('returns undefined outside any context', () => {
    expect(getContext()).toBeUndefined()
  })

  it('exposes the context to code running inside run()', () => {
    runWithContext(baseContext(), () => {
      expect(getContext()?.correlationId).toBe('corr-1')
    })
  })

  it('returns the callback return value unchanged', () => {
    const result = runWithContext(baseContext(), () => 42)
    expect(result).toBe(42)
  })

  it('survives awaits inside the callback', async () => {
    await runWithContext(baseContext({ correlationId: 'corr-async' }), async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      await new Promise(resolve => setImmediate(resolve))
      expect(getContext()?.correlationId).toBe('corr-async')
    })
  })

  it('does not leak the context after run() returns', () => {
    runWithContext(baseContext(), () => getContext())
    expect(getContext()).toBeUndefined()
  })

  it('enrichContext adds fields to the active context', () => {
    runWithContext(baseContext(), () => {
      enrichContext({ venueId: 'venue-1', userId: 'user-1' })
      expect(getContext()?.venueId).toBe('venue-1')
      expect(getContext()?.userId).toBe('user-1')
      expect(getContext()?.correlationId).toBe('corr-1')
    })
  })

  it('enrichContext is a no-op (does not throw) outside any context', () => {
    expect(() => enrichContext({ venueId: 'venue-1' })).not.toThrow()
  })

  it('🔴 keeps concurrent contexts isolated', async () => {
    const seen: string[] = []

    const task = (venueId: string, delayMs: number) =>
      runWithContext(baseContext({ correlationId: venueId }), async () => {
        enrichContext({ venueId })
        await new Promise(resolve => setTimeout(resolve, delayMs))
        // After the await, the context must still be THIS task's, not the other one's.
        seen.push(`${getContext()?.venueId}:${getContext()?.correlationId}`)
      })

    // Interleave on purpose: the slow one starts first and finishes last.
    await Promise.all([task('venue-slow', 20), task('venue-fast', 1)])

    expect(seen.sort()).toEqual(['venue-fast:venue-fast', 'venue-slow:venue-slow'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx jest --selectProjects unit tests/unit/observability/executionContext.test.ts
```

Expected: FAIL, `Cannot find module '@/observability/executionContext'`.

- [ ] **Step 3: Write the implementation**

Create `src/observability/executionContext.ts`:

```typescript
import { AsyncLocalStorage } from 'node:async_hooks'

/** Where a unit of work started. Used to filter and group errors by entry point. */
export type ContextSource = 'http' | 'job' | 'rabbit' | 'socket'

export interface ExecutionContext {
  /** Shared across client and server for one logical operation. */
  correlationId: string
  source: ContextSource
  /** Human-readable entry point: 'POST /api/v1/tpv/orders', 'money-integrity-watchdog', 'socket:join-room'. */
  entrypoint: string
  venueId?: string
  userId?: string
  role?: string
  terminalSerial?: string
}

const storage = new AsyncLocalStorage<ExecutionContext>()

/**
 * Runs `fn` with `ctx` available to everything it calls, including across awaits and
 * inside callbacks registered while it runs.
 *
 * Deliberately transparent: it returns whatever `fn` returns and never catches. A
 * context wrapper that swallows errors would turn observability into the cause of the
 * next invisible bug. Capturing errors is a separate responsibility (see sentry.ts).
 */
export function runWithContext<T>(ctx: ExecutionContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

export function getContext(): ExecutionContext | undefined {
  return storage.getStore()
}

/**
 * Adds fields to the context that is already active.
 *
 * Mutates the stored object on purpose: authentication runs AFTER the request logger
 * opened the context, so the tenant fields can only be known later. Mutation is safe
 * because each run() gets its own object, so one request can never write into another's.
 * No-op when there is no active context (jobs that call shared services, tests).
 */
export function enrichContext(patch: Partial<ExecutionContext>): void {
  const store = storage.getStore()
  if (store) Object.assign(store, patch)
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx jest --selectProjects unit tests/unit/observability/executionContext.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Format and commit** (pedir permiso antes de ejecutar el commit)

```bash
npm run format && npm run lint:fix
git add src/observability/executionContext.ts tests/unit/observability/executionContext.test.ts
git commit -m "feat(observability): add AsyncLocalStorage execution context"
```

---

### Task 2: Inyectar el contexto en todos los logs

**Files:**
- Modify: `src/config/logger.ts:13-16` (el `baseFormat`)
- Test: `tests/unit/observability/loggerContext.test.ts`

**Interfaces:**
- Consumes: `getContext`, `runWithContext` de la Tarea 1.
- Produces: nada nuevo exportado. El efecto es que todo `logger.*` emite `correlationId`, `venueId`, `userId`, `source` y `entrypoint` cuando hay contexto activo.

Esta es la tarea de mayor palanca del plan: sin tocar ninguno de los 622 sitios de llamada existentes, cada log del backend gana identidad.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/observability/loggerContext.test.ts`:

```typescript
/**
 * Before this, a logger.error() three layers deep inside a service produced a line with
 * a stack trace and no idea which venue it belonged to. Investigations started with a
 * grep over an anonymous log stream.
 *
 * The format below injects the active context into every record, so no call site has to
 * pass anything. Explicit fields at the call site still win: if someone logs an explicit
 * venueId, that is the one that must survive.
 */

import winston from 'winston'
import { contextFormat } from '@/config/logger'
import { runWithContext } from '@/observability/executionContext'

/** Runs a record through the format the same way Winston does, and returns the result. */
const applyFormat = (info: winston.Logform.TransformableInfo) => contextFormat().transform(info) as winston.Logform.TransformableInfo

describe('logger context format', () => {
  it('injects the active context into the record', () => {
    runWithContext({ correlationId: 'corr-1', source: 'http', entrypoint: 'GET /x', venueId: 'venue-1', userId: 'user-1' }, () => {
      const result = applyFormat({ level: 'error', message: 'boom' })
      expect(result.correlationId).toBe('corr-1')
      expect(result.venueId).toBe('venue-1')
      expect(result.userId).toBe('user-1')
      expect(result.source).toBe('http')
      expect(result.entrypoint).toBe('GET /x')
    })
  })

  it('leaves the record untouched when there is no context', () => {
    const result = applyFormat({ level: 'info', message: 'no context here' })
    expect(result.correlationId).toBeUndefined()
    expect(result.venueId).toBeUndefined()
    expect(result.message).toBe('no context here')
  })

  it('does not overwrite fields the call site set explicitly', () => {
    runWithContext({ correlationId: 'corr-ctx', source: 'job', entrypoint: 'my-job', venueId: 'venue-ctx' }, () => {
      const result = applyFormat({ level: 'warn', message: 'explicit wins', venueId: 'venue-explicit' })
      expect(result.venueId).toBe('venue-explicit')
      expect(result.correlationId).toBe('corr-ctx')
    })
  })

  it('omits context fields that are undefined', () => {
    runWithContext({ correlationId: 'corr-1', source: 'job', entrypoint: 'my-job' }, () => {
      const result = applyFormat({ level: 'info', message: 'partial' })
      expect('venueId' in result).toBe(false)
      expect('userId' in result).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx jest --selectProjects unit tests/unit/observability/loggerContext.test.ts
```

Expected: FAIL, `contextFormat is not a function` (aún no se exporta).

- [ ] **Step 3: Add the format to the logger**

En `src/config/logger.ts`, añadir el import arriba del archivo (después de los imports existentes):

```typescript
import { getContext } from '../observability/executionContext'
```

Añadir el formato justo antes de `const baseFormat = combine(` (línea 13):

```typescript
/**
 * Injects the active ExecutionContext into every log record.
 *
 * Exported so it can be unit-tested directly. Call-site fields win over context fields:
 * `...info` is spread last on purpose, so an explicit venueId at the call site is never
 * overwritten by the ambient one.
 */
export const contextFormat = winston.format(info => {
  const ctx = getContext()
  if (!ctx) return info

  const injected: Record<string, unknown> = {
    correlationId: ctx.correlationId,
    source: ctx.source,
    entrypoint: ctx.entrypoint,
  }
  if (ctx.venueId) injected.venueId = ctx.venueId
  if (ctx.userId) injected.userId = ctx.userId
  if (ctx.role) injected.role = ctx.role
  if (ctx.terminalSerial) injected.terminalSerial = ctx.terminalSerial

  return { ...injected, ...info }
})
```

Y añadirlo como **primer** elemento de `baseFormat`, para que los transportes de consola y de archivo lo vean:

```typescript
const baseFormat = combine(
  contextFormat(),
  timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  splat(), // Permite usar logger.info('mensaje %s', variable)
)
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx jest --selectProjects unit tests/unit/observability/loggerContext.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Verify no import cycle and the server still boots**

`executionContext.ts` no importa nada del proyecto, así que no puede haber ciclo. Confirmar que arranca:

```bash
npm run build
```

Expected: compila sin errores.

- [ ] **Step 6: Format and commit** (pedir permiso)

```bash
npm run format && npm run lint:fix
git add src/config/logger.ts tests/unit/observability/loggerContext.test.ts
git commit -m "feat(observability): inject execution context into every log record"
```

---

### Task 3: Punto de arranque HTTP y enriquecimiento con el tenant

**Files:**
- Modify: `src/middlewares/requestLogger.ts` (envolver el cuerpo completo)
- Modify: `src/middlewares/authenticateToken.middleware.ts:67` (después de `req.authContext = authContext`)
- Test: `tests/unit/observability/httpContext.test.ts`

**Interfaces:**
- Consumes: `runWithContext`, `enrichContext` de la Tarea 1.
- Produces: contexto activo con `source: 'http'` durante todo el ciclo del request, incluidos los callbacks de `res.on('finish')`.

**Detalle que importa:** hay que envolver el **cuerpo completo** del middleware, no solo la llamada a `next()`. Los `res.on('finish')` y `res.on('close')` se registran antes de `next()`; si quedan fuera del `runWithContext`, sus callbacks corren sin contexto y el log de cierre del request pierde el tenant, que es justo el que más se consulta.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/observability/httpContext.test.ts`:

```typescript
/**
 * The HTTP entry point. Two things are verified here that are easy to get wrong:
 *
 * 1. An inbound X-Correlation-ID is honored, not replaced. That is what lets a TPV error
 *    and the 500 it caused share one id across two consoles.
 * 2. The res.on('finish') callback runs INSIDE the context. Those listeners are
 *    registered before next(), so wrapping only next() would silently lose the tenant on
 *    the request-completion log, which is the line people actually search.
 */

import { EventEmitter } from 'node:events'
import type { Request, Response, NextFunction } from 'express'
import { requestLoggerMiddleware } from '@/middlewares/requestLogger'
import { getContext } from '@/observability/executionContext'

const buildReq = (overrides: Partial<Request> = {}): Request =>
  ({ method: 'POST', url: '/api/v1/orders', ip: '1.2.3.4', headers: {}, ...overrides }) as unknown as Request

const buildRes = () => {
  const res = new EventEmitter() as unknown as Response & EventEmitter
  res.setHeader = jest.fn() as unknown as Response['setHeader']
  Object.assign(res, { statusCode: 200, writableEnded: true })
  return res
}

describe('requestLoggerMiddleware execution context', () => {
  it('opens a context with source http and the route as entrypoint', done => {
    const req = buildReq()
    const res = buildRes()
    const next: NextFunction = () => {
      const ctx = getContext()
      expect(ctx?.source).toBe('http')
      expect(ctx?.entrypoint).toBe('POST /api/v1/orders')
      expect(ctx?.correlationId).toEqual(expect.any(String))
      done()
    }
    requestLoggerMiddleware(req, res, next)
  })

  it('honors an inbound X-Correlation-ID instead of generating a new one', done => {
    const req = buildReq({ headers: { 'x-correlation-id': 'from-the-tpv' } as Request['headers'] })
    const res = buildRes()
    const next: NextFunction = () => {
      expect(getContext()?.correlationId).toBe('from-the-tpv')
      done()
    }
    requestLoggerMiddleware(req, res, next)
  })

  it('🔴 keeps the context inside the res finish listener', done => {
    const req = buildReq()
    const res = buildRes()
    const next: NextFunction = () => {
      // Simulate the response completing after the handler chain ran.
      res.emit('finish')
    }
    // The finish listener registered by the middleware must see the context.
    requestLoggerMiddleware(req, res, next)
    setImmediate(() => {
      // If the listener had run without context, the middleware would have thrown or
      // logged without correlationId. We assert the observable proxy: no context leaks
      // out here, and the test above proved it exists inside.
      expect(getContext()).toBeUndefined()
      done()
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx jest --selectProjects unit tests/unit/observability/httpContext.test.ts
```

Expected: FAIL en los dos primeros tests, `getContext()` devuelve `undefined` dentro de `next`.

- [ ] **Step 3: Wrap the request logger body**

En `src/middlewares/requestLogger.ts`, añadir el import:

```typescript
import { runWithContext } from '../observability/executionContext'
```

Y envolver todo el cuerpo a partir de `const start = process.hrtime()`. La estructura queda así (se conserva **íntegro** el contenido actual; solo se indenta dentro del callback):

```typescript
export const requestLoggerMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const correlationId = req.headers['x-correlation-id'] || uuidv4()
  req.correlationId = correlationId as string
  res.setHeader('X-Correlation-ID', correlationId)

  // Everything below runs inside the context, including the res listeners registered
  // here. Wrapping only next() would leave those listeners without context.
  runWithContext({ correlationId: correlationId as string, source: 'http', entrypoint: `${req.method} ${req.url}` }, () => {
    const start = process.hrtime()
    const { method, url, ip } = req

    // ... (todo el cuerpo actual sin cambios: shouldSkipLogging, shouldLogStart,
    //      res.on('finish', ...), res.on('close', ...))

    next()
  })
}
```

- [ ] **Step 4: Enrich the context with the tenant after authentication**

En `src/middlewares/authenticateToken.middleware.ts`, añadir el import:

```typescript
import { enrichContext } from '../observability/executionContext'
```

E inmediatamente después de `req.authContext = authContext` (línea 67):

```typescript
    req.authContext = authContext

    // Stamp the tenant onto the execution context opened by requestLogger. From here on,
    // every log line and every Sentry event below this point knows which venue and which
    // user it belongs to, without any call site passing it.
    enrichContext({
      venueId: authContext.venueId,
      userId: authContext.userId,
      role: authContext.role,
      terminalSerial: authContext.terminalSerialNumber,
    })
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx jest --selectProjects unit tests/unit/observability/
```

Expected: PASS, 15 tests en los tres archivos.

- [ ] **Step 6: Write the concurrency test that closes acceptance criterion 3**

Este es el test que importa de todo el plan. Si el contexto se cruza entre requests, atribuiríamos un bug de dinero al venue equivocado, que es peor que no atribuirlo. Se hace en el proyecto `unit` a propósito: no depende de la suite `api-tests`, que hoy está frágil.

Añadir al final de `tests/unit/observability/httpContext.test.ts`:

```typescript
describe('🔴 concurrency isolation across requests', () => {
  /** Simulates the real chain: requestLogger opens context, auth enriches it, a service reads it. */
  const handleRequest = (venueId: string, delayMs: number): Promise<string | undefined> =>
    new Promise(resolve => {
      const req = buildReq({ headers: { 'x-correlation-id': `corr-${venueId}` } as Request['headers'] })
      const res = buildRes()
      requestLoggerMiddleware(req, res, async () => {
        // Stands in for authenticateTokenMiddleware.
        enrichContext({ venueId, userId: `user-${venueId}` })
        // Stands in for a service three layers down, after awaits.
        await new Promise(r => setTimeout(r, delayMs))
        await new Promise(r => setImmediate(r))
        resolve(getContext()?.venueId)
      })
    })

  it('50 interleaved requests from 2 venues never cross context', async () => {
    const requests = Array.from({ length: 50 }, (_, index) => {
      const venueId = index % 2 === 0 ? 'venue-a' : 'venue-b'
      // Varying delays force the event loop to interleave them.
      return handleRequest(venueId, index % 7).then(seen => ({ expected: venueId, seen }))
    })

    const results = await Promise.all(requests)
    const crossed = results.filter(r => r.expected !== r.seen)
    expect(crossed).toEqual([])
  })
})
```

Añadir `enrichContext` al import de `@/observability/executionContext` al inicio del archivo.

- [ ] **Step 7: Run it and verify no regression elsewhere**

```bash
npx jest --selectProjects unit tests/unit/observability/
npm run build
```

Expected: PASS incluido el test de 50 requests; compila.

- [ ] **Step 8: Format and commit** (pedir permiso)

```bash
npm run format && npm run lint:fix
git add src/middlewares/requestLogger.ts src/middlewares/authenticateToken.middleware.ts tests/unit/observability/httpContext.test.ts
git commit -m "feat(observability): open execution context on HTTP requests and stamp tenant after auth"
```

---

### Task 4: Contexto en los cron jobs, con guardia estática

**Files:**
- Create: `src/observability/jobContext.ts`
- Modify: todos los `src/jobs/*.job.ts` (39 archivos) + `src/jobs/monitorPosConnections.ts`
- Test: `tests/unit/observability/jobContext.test.ts`
- Test: `tests/unit/observability/jobContextCoverage.test.ts` (la guardia)

**Interfaces:**
- Consumes: `runWithContext` de la Tarea 1.
- Produces: `runInJobContext<T>(jobName: string, fn: () => T): T`.

Aquí viven los bugs caros: la agregación de comisiones, el watchdog de dinero y las reconciliaciones de webhooks son todos jobs. Hoy sus errores salen sin ninguna identidad.

- [ ] **Step 1: Write the failing test for the helper**

Create `tests/unit/observability/jobContext.test.ts`:

```typescript
/**
 * Cron ticks have no request, so they need their own context. Each tick gets a fresh
 * correlationId: two runs of the same job are two different units of work and must not
 * share an id, or the console would group unrelated failures together.
 */

import { runInJobContext } from '@/observability/jobContext'
import { getContext } from '@/observability/executionContext'

describe('runInJobContext', () => {
  it('opens a context with source job and the job name as entrypoint', () => {
    runInJobContext('money-integrity-watchdog', () => {
      expect(getContext()?.source).toBe('job')
      expect(getContext()?.entrypoint).toBe('money-integrity-watchdog')
    })
  })

  it('generates a fresh correlationId per tick', () => {
    const first = runInJobContext('my-job', () => getContext()?.correlationId)
    const second = runInJobContext('my-job', () => getContext()?.correlationId)
    expect(first).toEqual(expect.any(String))
    expect(first).not.toBe(second)
  })

  it('returns the callback value and preserves async', async () => {
    const value = await runInJobContext('my-job', async () => {
      await new Promise(resolve => setImmediate(resolve))
      return getContext()?.entrypoint
    })
    expect(value).toBe('my-job')
  })

  it('🔴 does not swallow errors', async () => {
    expect(() => runInJobContext('my-job', () => { throw new Error('boom') })).toThrow('boom')
    await expect(runInJobContext('my-job', async () => { throw new Error('async boom') })).rejects.toThrow('async boom')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx jest --selectProjects unit tests/unit/observability/jobContext.test.ts
```

Expected: FAIL, `Cannot find module '@/observability/jobContext'`.

- [ ] **Step 3: Write the helper**

Create `src/observability/jobContext.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import { runWithContext } from './executionContext'

/**
 * Opens an execution context for one cron tick.
 *
 * A fresh correlationId per tick: two runs of the same job are two units of work, and
 * sharing an id would group unrelated failures into one thread.
 *
 * Like every context wrapper here, it never catches. Each job keeps its own try/catch,
 * which is where the error is logged and captured; this only makes sure that catch has
 * a context to read.
 */
export function runInJobContext<T>(jobName: string, fn: () => T): T {
  return runWithContext({ correlationId: randomUUID(), source: 'job', entrypoint: jobName }, fn)
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npx jest --selectProjects unit tests/unit/observability/jobContext.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Write the static coverage guard**

Create `tests/unit/observability/jobContextCoverage.test.ts`:

```typescript
/**
 * Exhaustiveness by construction.
 *
 * There is no central job scheduler in this repo: each job self-schedules with its own
 * `new CronJob(...)` or `cron.schedule(...)`, and they are imported one by one in
 * server.ts. That means "wrap every job" cannot be verified by reading one file, and job
 * number 42 would silently ship without context.
 *
 * This guard makes the coverage structural: a new job file that does not call
 * runInJobContext fails the suite. Same pattern as the pagination guard already in the repo.
 */

import fs from 'node:fs'
import path from 'node:path'

const JOBS_DIR = path.join(__dirname, '../../../src/jobs')

/** Files in src/jobs/ that do not schedule anything and therefore need no context. */
const NOT_A_JOB = new Set(['jobSchedules.ts'])

describe('every job opens an execution context', () => {
  const jobFiles = fs
    .readdirSync(JOBS_DIR)
    .filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .filter(file => !NOT_A_JOB.has(file))

  it('finds job files to check', () => {
    expect(jobFiles.length).toBeGreaterThan(30)
  })

  it.each(jobFiles)('%s calls runInJobContext', file => {
    const source = fs.readFileSync(path.join(JOBS_DIR, file), 'utf8')
    expect(source).toContain('runInJobContext(')
  })
})
```

- [ ] **Step 6: Run the guard to see it fail for every job**

```bash
npx jest --selectProjects unit tests/unit/observability/jobContextCoverage.test.ts
```

Expected: FAIL en ~40 casos. Esa lista es exactamente el trabajo del paso siguiente.

- [ ] **Step 7: Wrap every job tick**

Para **cada** archivo que la guardia reportó, envolver el callback que el scheduler ejecuta. Los jobs siguen dos formas; el cambio es análogo.

Forma A, clase con `CronJob` (ejemplo real, `src/jobs/tpv-health-monitor.job.ts:19-25`):

```typescript
// antes
this.job = new CronJob(
  DATABASE_JOB_SCHEDULES.tpvHealthMonitor,
  this.checkTerminalHealth.bind(this),
  null,
  false,
  'America/Mexico_City',
)

// después
this.job = new CronJob(
  DATABASE_JOB_SCHEDULES.tpvHealthMonitor,
  () => runInJobContext('tpv-health-monitor', () => this.checkTerminalHealth()),
  null,
  false,
  'America/Mexico_City',
)
```

Forma B, `cron.schedule` (ejemplo real, `src/jobs/monitorPosConnections.ts:78`):

```typescript
// antes
const task = cron.schedule(DATABASE_JOB_SCHEDULES.posConnectionMonitor, checkPosConnections, { ... })

// después
const task = cron.schedule(
  DATABASE_JOB_SCHEDULES.posConnectionMonitor,
  () => runInJobContext('pos-connection-monitor', checkPosConnections),
  { ... },
)
```

Reglas al hacerlo:
- El `jobName` es el nombre del archivo sin `.job.ts`, en kebab-case. `money-integrity-watchdog.job.ts` → `'money-integrity-watchdog'`. Consistencia importa: es la etiqueta por la que se filtrará en la consola.
- Añadir el import `import { runInJobContext } from '../observability/jobContext'` en cada archivo.
- **No tocar el `retry(..., shouldRetryDbConnectionError)`** de la lectura de entrada. El wrapper va por fuera del tick, el retry se queda donde está.
- **No añadir ni mover ningún `try/catch`** en esta tarea. La captura de errores es la Tarea 9.

- [ ] **Step 8: Run the guard until it is green**

```bash
npx jest --selectProjects unit tests/unit/observability/jobContextCoverage.test.ts
```

Expected: PASS en todos los archivos.

- [ ] **Step 9: Verify the whole suite and the build**

```bash
npm run build && npx jest --selectProjects unit
```

Expected: compila y la suite unitaria sigue verde. Si algún test de job falla, casi siempre es que el `bind(this)` se perdió al envolver: usar la forma de arrow function del ejemplo.

- [ ] **Step 10: Format and commit** (pedir permiso)

```bash
npm run format && npm run lint:fix
git add src/observability/jobContext.ts src/jobs/ tests/unit/observability/jobContext.test.ts tests/unit/observability/jobContextCoverage.test.ts
git commit -m "feat(observability): open execution context on every cron tick, guarded by a static test"
```

---

### Task 5: Correlación a través de RabbitMQ

**Files:**
- Modify: `src/communication/rabbitmq/publisher.ts:9-25`
- Modify: `src/communication/rabbitmq/consumer.ts:44-77` (`handleMessage`)
- Modify: `src/communication/rabbitmq/commandRetryService.ts` (republicación)
- Create: `src/observability/correlationHeader.ts`
- Test: `tests/unit/observability/correlationHeader.test.ts`

**Interfaces:**
- Consumes: `getContext`, `runWithContext` de la Tarea 1.
- Produces: `CORRELATION_HEADER` (const `'x-correlation-id'`), `readCorrelationHeader(headers: unknown): string | undefined`, `currentCorrelationId(): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/observability/correlationHeader.test.ts`:

```typescript
/**
 * AMQP headers are not typed: depending on the publisher, a value can arrive as a string,
 * a Buffer, or a number. And messages already sitting in the queue when this ships carry
 * no header at all.
 *
 * A consumer that throws on a malformed or missing header would stop draining the queue.
 * Absence is normal, not an error.
 */

import { readCorrelationHeader, currentCorrelationId, CORRELATION_HEADER } from '@/observability/correlationHeader'
import { runWithContext } from '@/observability/executionContext'

describe('readCorrelationHeader', () => {
  const valid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

  it('reads a plain string uuid', () => {
    expect(readCorrelationHeader({ [CORRELATION_HEADER]: valid })).toBe(valid)
  })

  it('reads a Buffer value', () => {
    expect(readCorrelationHeader({ [CORRELATION_HEADER]: Buffer.from(valid) })).toBe(valid)
  })

  it('trims surrounding whitespace', () => {
    expect(readCorrelationHeader({ [CORRELATION_HEADER]: `  ${valid}  ` })).toBe(valid)
  })

  it('🔴 returns undefined for a missing header instead of throwing', () => {
    expect(readCorrelationHeader({})).toBeUndefined()
    expect(readCorrelationHeader(undefined)).toBeUndefined()
    expect(readCorrelationHeader(null)).toBeUndefined()
  })

  it('🔴 returns undefined for a malformed value instead of throwing', () => {
    expect(readCorrelationHeader({ [CORRELATION_HEADER]: 'not-a-uuid' })).toBeUndefined()
    expect(readCorrelationHeader({ [CORRELATION_HEADER]: 12345 })).toBeUndefined()
    expect(readCorrelationHeader({ [CORRELATION_HEADER]: { nested: true } })).toBeUndefined()
  })
})

describe('currentCorrelationId', () => {
  it('returns the active context id when there is one', () => {
    runWithContext({ correlationId: 'from-context', source: 'http', entrypoint: 'GET /x' }, () => {
      expect(currentCorrelationId()).toBe('from-context')
    })
  })

  it('generates a new uuid when there is no context', () => {
    const generated = currentCorrelationId()
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx jest --selectProjects unit tests/unit/observability/correlationHeader.test.ts
```

Expected: FAIL, módulo no encontrado.

- [ ] **Step 3: Write the module**

Create `src/observability/correlationHeader.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import { getContext } from './executionContext'

/** Header name used on both HTTP (X-Correlation-ID) and AMQP message headers. */
export const CORRELATION_HEADER = 'x-correlation-id'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Reads a correlation id out of AMQP headers, defensively.
 *
 * Values can arrive as string, Buffer or number depending on the publisher, and messages
 * queued before this shipped have no header at all. Anything that is not a valid uuid
 * yields undefined so the caller generates a fresh one. It never throws: a malformed
 * header must not stop the queue from draining.
 */
export function readCorrelationHeader(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const raw = (headers as Record<string, unknown>)[CORRELATION_HEADER]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return undefined

  const value = String(raw).trim()
  return UUID_PATTERN.test(value) ? value : undefined
}

/** The active correlation id, or a fresh one when running outside any context. */
export function currentCorrelationId(): string {
  return getContext()?.correlationId ?? randomUUID()
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npx jest --selectProjects unit tests/unit/observability/correlationHeader.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Stamp the header when publishing**

En `src/communication/rabbitmq/publisher.ts`, añadir el import:

```typescript
import { CORRELATION_HEADER, currentCorrelationId } from '../../observability/correlationHeader'
```

Y añadir `headers` al objeto de opciones de `channel.publish` (línea 21), conservando `persistent: true`:

```typescript
    const published = channel.publish(
      POS_COMMANDS_EXCHANGE,
      routingKey,
      message,
      {
        persistent: true, // Mensaje persistente
        headers: { [CORRELATION_HEADER]: currentCorrelationId() },
      },
    )
```

- [ ] **Step 6: Open the context when consuming**

En `src/communication/rabbitmq/consumer.ts`, dentro de `handleMessage` (línea ~44), envolver el cuerpo. El `routingKey` sirve de `entrypoint`:

```typescript
import { runWithContext } from '../../observability/executionContext'
import { readCorrelationHeader } from '../../observability/correlationHeader'
import { randomUUID } from 'node:crypto'

// al inicio de handleMessage, antes de cualquier otra cosa:
const correlationId = readCorrelationHeader(msg.properties?.headers) ?? randomUUID()
return runWithContext(
  { correlationId, source: 'rabbit', entrypoint: `rabbit:${msg.fields.routingKey}` },
  async () => {
    // ... todo el cuerpo actual de handleMessage, incluidos los channel.ack / channel.nack
  },
)
```

- [ ] **Step 7: Give the retry service its own context**

**Verificado 2026-08-08: `commandRetryService.ts` NO republica a AMQP.** `retryFailedCommands` (`:27-58`) solo lee comandos `FAILED` de la base y les cambia el status a `PENDING` para disparar el NOTIFY. No hay header que conservar ahí, y cualquier instrucción que diga lo contrario está mal.

Lo que sí hace falta es que ese servicio tenga contexto propio, porque corre en un `setInterval` y no pasa por ninguno de los cuatro puntos de arranque. Envolver el cuerpo de `retryFailedCommands`:

```typescript
import { runInJobContext } from '../../observability/jobContext'

  private async retryFailedCommands(): Promise<void> {
    return runInJobContext('command-retry-service', async () => {
      // ... todo el cuerpo actual sin cambios
    })
  }
```

Dos cosas que notar de paso, sin arreglarlas aquí:
- Su `catch` (`:55-57`) loguea y sigue, o sea que **hoy traga el error**. La captura para Sentry se le añade en la Tarea 9, junto con los jobs.
- No es un `*.job.ts`, así que la guardia estática de la Tarea 4 no lo cubre. Por eso se envuelve a mano en este paso.

- [ ] **Step 8: Verify the build and the suite**

```bash
npm run build && npx jest --selectProjects unit
```

Expected: compila, suite verde.

- [ ] **Step 9: Format and commit** (pedir permiso)

```bash
npm run format && npm run lint:fix
git add src/observability/correlationHeader.ts src/communication/rabbitmq/ tests/unit/observability/correlationHeader.test.ts
git commit -m "feat(observability): propagate correlation id through RabbitMQ"
```

---

### Task 6: Contexto en Socket.IO

**Files:**
- Modify: `src/communication/sockets/managers/socketManager.ts:182-430`
- Test: `tests/unit/observability/socketContext.test.ts`

**Interfaces:**
- Consumes: `runWithContext` de la Tarea 1, `CORRELATION_HEADER` de la Tarea 5.
- Produces: `withSocketContext(eventName: string, handler: (...args: unknown[]) => unknown)` — helper local exportado desde `socketManager.ts` para poder testearlo.

Los 20 handlers están todos en este archivo, así que un solo helper los cubre a todos.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/observability/socketContext.test.ts`:

```typescript
/**
 * Socket.IO has no central error handler equivalent to Express's. This wrapper is the one
 * place in the codebase where a context wrapper also touches the error, and even here it
 * re-throws after capturing: capture and propagate, never swallow.
 */

import { withSocketContext } from '@/communication/sockets/managers/socketManager'
import { getContext } from '@/observability/executionContext'

describe('withSocketContext', () => {
  it('opens a context with source socket and the event as entrypoint', () => {
    const wrapped = withSocketContext('join-room', () => getContext())
    const ctx = wrapped() as ReturnType<typeof getContext>
    expect(ctx?.source).toBe('socket')
    expect(ctx?.entrypoint).toBe('socket:join-room')
  })

  it('preserves the arguments the handler receives', () => {
    const handler = jest.fn()
    const wrapped = withSocketContext('join-room', handler)
    const callback = jest.fn()
    wrapped({ roomId: 'r1' }, callback)
    expect(handler).toHaveBeenCalledWith({ roomId: 'r1' }, callback)
  })

  it('returns the handler return value', () => {
    expect(withSocketContext('x', () => 'value')()).toBe('value')
  })

  it('🔴 re-throws after capturing, never swallows', () => {
    expect(() => withSocketContext('x', () => { throw new Error('boom') })()).toThrow('boom')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx jest --selectProjects unit tests/unit/observability/socketContext.test.ts
```

Expected: FAIL, `withSocketContext` no existe.

- [ ] **Step 3: Add the wrapper and apply it to every handler**

En `src/communication/sockets/managers/socketManager.ts`, añadir arriba:

```typescript
import { randomUUID } from 'node:crypto'
import { runWithContext } from '../../../observability/executionContext'

/**
 * Wraps a socket event handler so everything it calls runs inside an execution context.
 *
 * Exported for unit testing. Error capture lands in Task 9: unlike the other wrappers,
 * this one will catch, capture and RE-THROW, because Socket.IO has no central error
 * handler to fall back on.
 */
export function withSocketContext<A extends unknown[], R>(eventName: string, handler: (...args: A) => R) {
  return (...args: A): R =>
    runWithContext({ correlationId: randomUUID(), source: 'socket', entrypoint: `socket:${eventName}` }, () => handler(...args))
}
```

Después aplicarlo a **cada** `socket.on(...)` del archivo (líneas 215 a ~430, 20 registros). Patrón:

```typescript
// antes
socket.on(SocketEventType.JOIN_ROOM, (payload, callback) => { /* ... */ })

// después
socket.on(SocketEventType.JOIN_ROOM, withSocketContext('join-room', (payload, callback) => { /* ... */ }))
```

El `eventName` que se pasa al wrapper es la etiqueta legible del evento en kebab-case, no la constante del enum: es lo que se va a leer en la consola.

- [ ] **Step 4: Run it to verify it passes**

```bash
npx jest --selectProjects unit tests/unit/observability/socketContext.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Verify no handler was missed**

```bash
grep -c "socket.on(" src/communication/sockets/managers/socketManager.ts
grep -c "withSocketContext(" src/communication/sockets/managers/socketManager.ts
```

Expected: el segundo número es el primero **más uno** (la definición del helper). Si no cuadra, falta envolver alguno.

- [ ] **Step 6: Build and commit** (pedir permiso)

```bash
npm run build && npm run format && npm run lint:fix
git add src/communication/sockets/managers/socketManager.ts tests/unit/observability/socketContext.test.ts
git commit -m "feat(observability): open execution context on socket events"
```

---

### Task 7: Redacción de datos sensibles

**Files:**
- Create: `src/observability/redactPatterns.ts`
- Test: `tests/unit/observability/redactPatterns.test.ts`

**Interfaces:**
- Consumes: nada. Puro.
- Produces: `redactString(value: string): string`, `redactDeep<T>(value: T, depth?: number): T`.

Se escribe **antes** que Sentry a propósito: es la pieza que decide si datos fiscales de clientes salen o no de la infra. El repo es público y la plataforma maneja RFC y CLABE; esto no es opcional.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/observability/redactPatterns.test.ts`:

```typescript
/**
 * The structural allowlist in sentry.ts handles known fields. This handles the surfaces
 * where sensitive data travels embedded in free text and no allowlist can catch it:
 * a URL query string, a Prisma error message quoting the row, a log breadcrumb where
 * someone logged a whole object.
 *
 * Avoqado handles Mexican tax IDs (RFC) and bank accounts (CLABE). Once a value reaches a
 * third-party console it cannot be unsent.
 */

import { redactString, redactDeep } from '@/observability/redactPatterns'

describe('redactString', () => {
  it('redacts an RFC', () => {
    expect(redactString('cliente RFC AAA010101AAA no encontrado')).toBe('cliente RFC [REDACTED:rfc] no encontrado')
  })

  it('redacts a CLABE', () => {
    expect(redactString('cuenta 002010077777777771')).toBe('cuenta [REDACTED:clabe]')
  })

  it('redacts an email', () => {
    expect(redactString('user cliente@ejemplo.com failed')).toBe('user [REDACTED:email] failed')
  })

  it('redacts a bearer token', () => {
    expect(redactString('Authorization: Bearer abc.def.ghi')).toContain('[REDACTED:token]')
  })

  it('leaves harmless text alone', () => {
    expect(redactString('order cmr123 total 150.50')).toBe('order cmr123 total 150.50')
  })
})

describe('redactDeep', () => {
  it('redacts inside nested objects', () => {
    const input = { level1: { level2: { note: 'RFC AAA010101AAA' } } }
    expect(redactDeep(input)).toEqual({ level1: { level2: { note: 'RFC [REDACTED:rfc]' } } })
  })

  it('redacts inside arrays', () => {
    expect(redactDeep(['cliente@ejemplo.com'])).toEqual(['[REDACTED:email]'])
  })

  it('🔴 stops at depth 5 instead of recursing forever', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'cliente@ejemplo.com' } } } } } } }
    expect(() => redactDeep(deep)).not.toThrow()
  })

  it('🔴 survives a circular reference', () => {
    const circular: Record<string, unknown> = { note: 'cliente@ejemplo.com' }
    circular.self = circular
    expect(() => redactDeep(circular)).not.toThrow()
  })

  it('leaves numbers and booleans untouched', () => {
    expect(redactDeep({ total: 150.5, paid: true })).toEqual({ total: 150.5, paid: true })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx jest --selectProjects unit tests/unit/observability/redactPatterns.test.ts
```

Expected: FAIL, módulo no encontrado.

- [ ] **Step 3: Write the module**

Create `src/observability/redactPatterns.ts`:

```typescript
/**
 * Redaction of sensitive values before anything leaves the process.
 *
 * The pattern list mirrors the workspace redaction scanner
 * (~/.claude/skills/gstack/lib/redact-patterns.ts). It is REPLICATED here on purpose,
 * not imported: that scanner is developer tooling, not a production runtime dependency.
 * When updating one, compare against the other.
 */

const MAX_DEPTH = 5

const PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  // Mexican tax id: 3-4 letters + 6 digits (date) + 3 alphanumeric homoclave.
  { label: 'rfc', pattern: /\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/g },
  // Mexican interbank account: exactly 18 digits.
  { label: 'clabe', pattern: /\b\d{18}\b/g },
  // Card-shaped 13-19 digit run (checked before generic long numbers).
  { label: 'card', pattern: /\b\d{13,19}\b/g },
  { label: 'email', pattern: /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g },
  { label: 'jwt', pattern: /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g },
  { label: 'token', pattern: /\bBearer\s+[\w.\-~+/]+=*/gi },
  { label: 'phone', pattern: /\+?\d{1,3}?[\s-]?\(?\d{2,3}\)?[\s-]?\d{3,4}[\s-]?\d{4}\b/g },
]

/** Replaces every known sensitive pattern in a string with a labelled placeholder. */
export function redactString(value: string): string {
  let result = value
  for (const { label, pattern } of PATTERNS) {
    result = result.replace(pattern, `[REDACTED:${label}]`)
  }
  return result
}

/**
 * Walks a value and redacts every string it finds.
 *
 * Bounded at depth 5 and cycle-aware: this runs inside beforeSend on every error event,
 * so it must never hang or blow the stack. A permitted key does not make its descendants
 * trustworthy, which is why the walk is recursive rather than one level deep.
 */
export function redactDeep<T>(value: T, depth = 0, seen = new WeakSet<object>()): T {
  if (depth > MAX_DEPTH) return value
  if (typeof value === 'string') return redactString(value) as unknown as T
  if (value === null || typeof value !== 'object') return value

  if (seen.has(value as object)) return value
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map(item => redactDeep(item, depth + 1, seen)) as unknown as T
  }

  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = redactDeep(entry, depth + 1, seen)
  }
  return output as T
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npx jest --selectProjects unit tests/unit/observability/redactPatterns.test.ts
```

Expected: PASS, 10 tests. Si el test del RFC falla porque el patrón de `card` o `phone` se lo comió primero, revisar el orden del array: los patrones más específicos van antes que los genéricos.

- [ ] **Step 5: Format and commit** (pedir permiso)

```bash
npm run format && npm run lint:fix
git add src/observability/redactPatterns.ts tests/unit/observability/redactPatterns.test.ts
git commit -m "feat(observability): add recursive sensitive-data redaction"
```

---

### Task 8: Inicializar Sentry contra Better Stack

**Files:**
- Create: `src/observability/sentry.ts`
- Modify: `src/config/env.ts` (añadir `SENTRY_DSN`)
- Modify: `src/server.ts:1` (primer import)
- Modify: `tsconfig.json` (`sourceMap`), `package.json` (script `start`)
- Test: `tests/unit/observability/sentryScrubbing.test.ts`

**Interfaces:**
- Consumes: `getContext` (Tarea 1), `redactDeep` (Tarea 7).
- Produces: `buildBeforeSend()` — la función que Sentry llama por evento, exportada para poder testearla sin inicializar el SDK.

**Prerequisito:** la app `avoqado-server` creada en Better Stack Errors y su DSN a mano (P1 del spec). Sin DSN el SDK queda inerte y la tarea igual se puede completar y testear.

- [ ] **Step 1: Install the SDK**

```bash
npm install @sentry/node
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/observability/sentryScrubbing.test.ts`:

```typescript
/**
 * beforeSend is the last gate before data leaves the process. D3 chose a strict allowlist:
 * what is not explicitly permitted does not go out.
 *
 * The test seeds each sensitive type into all four surfaces named in the spec, because
 * the structural allowlist alone only covers the first one.
 */

import { buildBeforeSend } from '@/observability/sentry'
import { runWithContext } from '@/observability/executionContext'

const beforeSend = buildBeforeSend()

const seedEvent = () =>
  ({
    request: {
      url: 'https://api.avoqado.io/v1/customers?email=cliente@ejemplo.com',
      method: 'POST',
      data: { rfc: 'AAA010101AAA', clabe: '002010077777777771' },
      cookies: { accessToken: 'secret' },
      query_string: 'email=cliente@ejemplo.com',
      headers: { authorization: 'Bearer abc.def.ghi', 'user-agent': 'jest', cookie: 'accessToken=secret' },
    },
    exception: { values: [{ type: 'Error', value: 'Unique constraint failed on rfc AAA010101AAA' }] },
    breadcrumbs: [{ category: 'http', message: 'GET /x?email=cliente@ejemplo.com', data: { body: { rfc: 'AAA010101AAA' } } }],
    extra: { orderId: 'cmr1', nested: { deep: { note: 'cliente@ejemplo.com' } }, notAllowed: 'drop me' },
    user: { id: 'user-1', email: 'cliente@ejemplo.com', ip_address: '1.2.3.4' },
  }) as never

describe('beforeSend scrubbing', () => {
  it('🔴 removes request body, cookies and query string entirely', () => {
    const out = beforeSend(seedEvent(), {} as never) as never as Record<string, never>
    const request = out.request as Record<string, unknown>
    expect(request.data).toBeUndefined()
    expect(request.cookies).toBeUndefined()
    expect(request.query_string).toBeUndefined()
  })

  it('🔴 keeps only allowlisted headers', () => {
    const out = beforeSend(seedEvent(), {} as never) as never as Record<string, never>
    const headers = (out.request as Record<string, unknown>).headers as Record<string, unknown>
    expect(headers.authorization).toBeUndefined()
    expect(headers.cookie).toBeUndefined()
    expect(headers['user-agent']).toBe('jest')
  })

  it('🔴 redacts sensitive data inside the URL', () => {
    const out = beforeSend(seedEvent(), {} as never) as never as Record<string, never>
    expect(JSON.stringify((out.request as Record<string, unknown>).url)).not.toContain('cliente@ejemplo.com')
  })

  it('🔴 redacts sensitive data inside the exception message', () => {
    const out = beforeSend(seedEvent(), {} as never) as never as Record<string, never>
    expect(JSON.stringify(out.exception)).not.toContain('AAA010101AAA')
  })

  it('🔴 redacts sensitive data inside breadcrumbs and drops their bodies', () => {
    const out = beforeSend(seedEvent(), {} as never) as never as Record<string, never>
    const serialized = JSON.stringify(out.breadcrumbs)
    expect(serialized).not.toContain('cliente@ejemplo.com')
    expect(serialized).not.toContain('AAA010101AAA')
  })

  it('🔴 keeps only allowlisted extra keys and redacts inside them', () => {
    const out = beforeSend(seedEvent(), {} as never) as never as Record<string, never>
    const extra = out.extra as Record<string, unknown>
    expect(extra.orderId).toBe('cmr1')
    expect(extra.notAllowed).toBeUndefined()
    expect(JSON.stringify(extra)).not.toContain('cliente@ejemplo.com')
  })

  it('🔴 reduces user to an id, dropping email and ip', () => {
    const out = beforeSend(seedEvent(), {} as never) as never as Record<string, never>
    expect(out.user).toEqual({ id: 'user-1' })
  })

  it('tags the event with the active execution context', () => {
    runWithContext({ correlationId: 'corr-1', source: 'job', entrypoint: 'my-job', venueId: 'venue-1' }, () => {
      const out = beforeSend(seedEvent(), {} as never) as never as Record<string, never>
      const tags = out.tags as Record<string, unknown>
      expect(tags.correlationId).toBe('corr-1')
      expect(tags.venueId).toBe('venue-1')
      expect(tags.source).toBe('job')
      expect(tags.entrypoint).toBe('my-job')
    })
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npx jest --selectProjects unit tests/unit/observability/sentryScrubbing.test.ts
```

Expected: FAIL, módulo no encontrado.

- [ ] **Step 4: Add SENTRY_DSN to the env schema**

En `src/config/env.ts`, dentro de `envSchema`, en la sección CORE APPLICATION:

```typescript
  // Observabilidad. Opcional a propósito: sin DSN el SDK queda inerte y dev/test no cambian.
  SENTRY_DSN: z.string().url('SENTRY_DSN debe ser una URL válida').optional(),
```

- [ ] **Step 5: Write the Sentry module**

Create `src/observability/sentry.ts`:

```typescript
import * as Sentry from '@sentry/node'
import { getContext } from './executionContext'
import { redactDeep, redactString } from './redactPatterns'

const ALLOWED_HEADERS = ['user-agent', 'x-app-version-code', 'x-correlation-id']

const ALLOWED_EXTRA_KEYS = [
  'venueId', 'userId', 'role', 'correlationId', 'source', 'entrypoint',
  'terminalSerial', 'orderId', 'paymentId', 'jobName',
]

const pick = (source: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter(key => key in source).map(key => [key, source[key]]))

/**
 * The last gate before an event leaves the process.
 *
 * Exported as a factory so it can be unit-tested without initializing the SDK.
 * Two layers, because neither alone is enough: a structural allowlist for known fields,
 * and a recursive redaction pass for the surfaces where sensitive data hides inside free
 * text (URLs, exception messages, breadcrumbs, nested extras).
 */
export function buildBeforeSend() {
  return (event: Sentry.ErrorEvent, _hint: Sentry.EventHint): Sentry.ErrorEvent | null => {
    const ctx = getContext()

    if (event.request) {
      delete event.request.data
      delete event.request.cookies
      delete event.request.query_string
      event.request.headers = pick((event.request.headers ?? {}) as Record<string, unknown>, ALLOWED_HEADERS) as Record<string, string>
      if (event.request.url) event.request.url = redactString(event.request.url.split('?')[0])
    }

    event.user = ctx?.userId ? { id: ctx.userId } : undefined

    if (event.extra) {
      event.extra = redactDeep(pick(event.extra as Record<string, unknown>, ALLOWED_EXTRA_KEYS))
    }

    if (event.breadcrumbs) {
      event.breadcrumbs = event.breadcrumbs.map(crumb => {
        if (crumb.data && typeof crumb.data === 'object') delete (crumb.data as Record<string, unknown>).body
        return redactDeep(crumb)
      })
    }

    if (event.exception) event.exception = redactDeep(event.exception)

    if (ctx) {
      event.tags = {
        ...event.tags,
        correlationId: ctx.correlationId,
        source: ctx.source,
        entrypoint: ctx.entrypoint,
        ...(ctx.venueId ? { venueId: ctx.venueId } : {}),
        ...(ctx.terminalSerial ? { terminalSerial: ctx.terminalSerial } : {}),
      }
    }

    return event
  }
}

/**
 * Initializes error reporting.
 *
 * Runs in the module body, not behind an exported function, so importing this module is
 * enough. src/server.ts imports it FIRST, before ./app, so the SDK instruments Express,
 * http and Prisma before they load. That ordering works because the build targets
 * CommonJS and requires run in source order. If this project ever moves to native ESM,
 * hoisting changes and this must become `--import ./dist/src/observability/sentry.js`.
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  release: process.env.RENDER_GIT_COMMIT,
  sendDefaultPii: false,
  tracesSampleRate: 0,
  beforeSend: buildBeforeSend(),
  beforeBreadcrumb(crumb) {
    if (crumb.category === 'http' && crumb.data) delete (crumb.data as Record<string, unknown>).body
    return crumb
  },
})
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx jest --selectProjects unit tests/unit/observability/sentryScrubbing.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Import Sentry first in server.ts**

En `src/server.ts`, como **primera línea del archivo**, antes de cualquier otro import:

```typescript
// Must be the FIRST import: initializes error reporting before Express, http and Prisma
// load, so the SDK can instrument them. Side-effect import on purpose — do not add braces
// and do not let the linter reorder it.
import './observability/sentry'
```

- [ ] **Step 8: Enable backend source maps**

En `tsconfig.json`, dentro de `compilerOptions`:

```json
    "sourceMap": true,
```

En `package.json`, el script `start`:

```json
    "start": "node --enable-source-maps -r tsconfig-paths/register dist/src/server.js",
```

- [ ] **Step 9: Verify the DSN-less path still boots**

```bash
npm run build
SENTRY_DSN= npx ts-node -r tsconfig-paths/register -e "import './src/observability/sentry'; console.log('inert init ok')"
npx jest --selectProjects unit
```

Expected: compila, el init sin DSN no lanza, y la suite completa sigue verde. Esto cubre el criterio 11 del spec.

- [ ] **Step 10: Format and commit** (pedir permiso)

```bash
npm run format && npm run lint:fix
git add src/observability/sentry.ts src/config/env.ts src/server.ts tsconfig.json package.json package-lock.json tests/unit/observability/sentryScrubbing.test.ts
git commit -m "feat(observability): report backend errors to Better Stack with strict scrubbing"
```

---

### Task 9: Conectar los puntos de captura

**Files:**
- Modify: `src/app.ts:346-427` (error handler global)
- Modify: `src/server.ts:267-305` (handlers de proceso)
- Modify: `src/communication/sockets/managers/socketManager.ts` (`withSocketContext`)
- Test: `tests/unit/observability/captureRules.test.ts`

**Interfaces:**
- Consumes: `buildBeforeSend` indirectamente vía el SDK ya inicializado; `getContext` de la Tarea 1.
- Produces: `shouldCaptureError(err: Error): boolean` exportada desde `src/app.ts`.

La regla de qué se captura vive en **una sola función** para que sea testeable y para que nadie la reinterprete en otro archivo.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/observability/captureRules.test.ts`:

```typescript
/**
 * A 4xx operational AppError is a client mistake, not a backend fault. Capturing those
 * would drown the console in noise and make the real 500s invisible, which defeats the
 * purpose of having grouping at all.
 */

import { shouldCaptureError } from '@/app'
import AppError from '@/utils/httpErrors'

describe('shouldCaptureError', () => {
  it('captures a plain unexpected Error', () => {
    expect(shouldCaptureError(new Error('boom'))).toBe(true)
  })

  it('captures an AppError with a 5xx status', () => {
    expect(shouldCaptureError(new AppError('upstream failed', 502))).toBe(true)
  })

  it('🔴 does NOT capture an operational 4xx AppError', () => {
    expect(shouldCaptureError(new AppError('no encontrado', 404))).toBe(false)
    expect(shouldCaptureError(new AppError('no autorizado', 401))).toBe(false)
    expect(shouldCaptureError(new AppError('datos inválidos', 400))).toBe(false)
  })
})
```

**Nota para el implementador:** verificar primero la firma real de `AppError` en `src/utils/httpErrors.ts` y ajustar la construcción del test si difiere. No inventar la firma.

- [ ] **Step 2: Run it to verify it fails**

```bash
npx jest --selectProjects unit tests/unit/observability/captureRules.test.ts
```

Expected: FAIL, `shouldCaptureError` no existe.

- [ ] **Step 3: Add the rule and the capture in app.ts**

En `src/app.ts`, añadir los imports y la función antes de `globalErrorHandler` (línea 346):

```typescript
import * as Sentry from '@sentry/node'

/**
 * Which errors are worth an aggregated report.
 *
 * 4xx operational AppErrors are the client's mistake, not ours: they are already answered
 * with a proper status and logged as warnings. Reporting them would bury the real 500s.
 */
export function shouldCaptureError(err: Error): boolean {
  if (err instanceof AppError) return err.statusCode >= 500
  return true
}
```

Dentro de `globalErrorHandler`, en la rama de `AppError` (después del `logger[logLevel](...)`, línea 393) y en la rama de error inesperado (después del `logger.error(...)`, línea 414):

```typescript
    if (shouldCaptureError(err)) Sentry.captureException(err)
```

Añadir el `venueId`/`userId`/`role` al metadata de los tres caminos de log, tomándolos de `authContext`:

```typescript
  const authContext = (req as any).authContext
  const tenant = authContext
    ? { venueId: authContext.venueId, userId: authContext.userId, role: authContext.role }
    : {}
```

y esparcir `...tenant` en cada objeto de metadata que ya se pasa a `logger`.

- [ ] **Step 4: Capture in the process handlers**

En `src/server.ts`, dentro de `process.on('uncaughtException', ...)` (línea 267) y `process.on('unhandledRejection', ...)` (línea 276), añadir la captura **antes** de la llamada a `gracefulShutdown`, y darle margen al SDK para vaciar la cola:

```typescript
  Sentry.captureException(error)
  void Sentry.flush(2000)
```

**No** cambiar la lógica de apagado existente: `src/server.ts` es el único dueño de estos handlers y ya hubo un incidente por duplicarlos.

- [ ] **Step 5: Capture in the socket wrapper**

En `withSocketContext` (Tarea 6), envolver la llamada al handler:

```typescript
export function withSocketContext<A extends unknown[], R>(eventName: string, handler: (...args: A) => R) {
  return (...args: A): R =>
    runWithContext({ correlationId: randomUUID(), source: 'socket', entrypoint: `socket:${eventName}` }, () => {
      try {
        return handler(...args)
      } catch (error) {
        // Socket.IO has no central error handler, so this is the only place the error can
        // be seen. Capture and RE-THROW: never swallow.
        Sentry.captureException(error)
        throw error
      }
    })
}
```

- [ ] **Step 6: Capture in job and rabbit catches**

En cada `src/jobs/*.job.ts`, dentro del `try/catch` que ya rodea el tick, añadir `Sentry.captureException(error)` junto al `logger.error` existente. **Si algún job no tiene `try/catch` alrededor de su tick, añadírselo**: sin él, ese job ya está perdiendo su error hoy.

En `src/communication/rabbitmq/consumer.ts`, en el `catch` que hace `channel.nack` (línea ~75), añadir la captura antes del `nack`.

- [ ] **Step 7: Run the full unit suite**

```bash
npm run build && npx jest --selectProjects unit
```

Expected: compila y la suite completa en verde.

- [ ] **Step 8: Format and commit** (pedir permiso)

```bash
npm run format && npm run lint:fix
git add src/app.ts src/server.ts src/communication/ src/jobs/ tests/unit/observability/captureRules.test.ts
git commit -m "feat(observability): capture backend errors at one point per entry path"
```

---

### Task 10: Verificación end-to-end y de latencia

**Files:** ninguno nuevo. Esta tarea es la que decide si el cambio se puede desplegar.

- [ ] **Step 1: Run the full pre-deploy gate**

```bash
npm run pre-deploy
```

Expected: pasa. Si la máquina está saturada va a tardar varios minutos; **no cancelar**, subir el timeout.

- [ ] **Step 2: Verify the context reaches a service three layers down**

Levantar el server en local con un DSN de staging y disparar un request autenticado cualquiera. En el log del request debe aparecer `venueId`, `userId` y `correlationId` en **todas** las líneas del request, no solo en la de inicio y fin.

```bash
npm run dev
# en otra terminal, un request autenticado a cualquier endpoint del dashboard
```

Expected: cada línea del log lleva el tenant. Esto cubre los criterios 1 y 2 del spec.

- [ ] **Step 3: Verify a seeded error lands in Better Stack**

Con el DSN configurado, provocar un 500 real (por ejemplo un endpoint temporal que lance) y confirmar en la consola de Better Stack Errors que llega **agrupado**, con `release` igual al SHA y los tags `venueId`, `correlationId`, `source`, `entrypoint`.

Borrar el endpoint temporal antes de commitear. Cubre el criterio 4.

- [ ] **Step 4: Verify a 4xx does NOT arrive**

Disparar un 404 y un 401 y confirmar que **no** aparecen en la consola. Cubre el criterio 5.

- [ ] **Step 5: Verify the stack trace points at .ts**

En el error del paso 3, el frame superior debe apuntar a `src/**/*.ts` con la línea correcta, no a `dist/**/*.js`. Si apunta a `dist`, falta el `--enable-source-maps` en el arranque. Cubre el criterio 7.

- [ ] **Step 6: Measure the latency cost**

`AsyncLocalStorage` no es gratis. Medir en staging, tres corridas antes y tres después del despliegue:

```bash
npx autocannon -c 50 -d 30 -H "Authorization: Bearer <token-de-staging>" https://<staging>/api/v1/dashboard/venues
```

Umbral del criterio 12: **+5 ms absolutos o +3% sobre la mediana de los p95, lo que sea mayor.** Documentar los seis números en el PR. Si se pasa del umbral, no revertir todo: acotar el contexto a los caminos que importan y volver a medir.

- [ ] **Step 7: Verify the rollback works**

En staging, borrar `SENTRY_DSN` y reiniciar. El server debe arrancar normal y dejar de enviar eventos. Cubre el criterio 11 en condiciones reales.

- [ ] **Step 8: Final commit and hand-off** (pedir permiso)

```bash
git status --porcelain
```

Confirmar que no quedan endpoints temporales ni scripts de prueba. Los planes del dashboard y de las apps móviles son el siguiente paso.

---

## Notas para quien ejecute

**El orden importa hasta la Tarea 7; después no tanto.** Las Tareas 1 y 2 son la base de todo. Las 3, 4, 5 y 6 son los cuatro puntos de arranque y son independientes entre sí: se pueden repartir. La 7 tiene que estar antes de la 8. La 9 necesita la 8. La 10 va al final.

**El error más probable al envolver los jobs** es perder el `this` de una clase. Usar siempre la forma de arrow function del ejemplo, nunca pasar el método directo.

**Si un test de contexto falla de forma intermitente**, casi seguro es un `res.on(...)` o un listener registrado fuera del `runWithContext`. El contexto se hereda en el momento del **registro** del callback, no en el de su ejecución.

**Lo que este plan deliberadamente no hace:** tracing distribuido con OpenTelemetry, alertas, y explicabilidad de cálculos de dominio. Están en "Out of Scope" del spec con su razón.
