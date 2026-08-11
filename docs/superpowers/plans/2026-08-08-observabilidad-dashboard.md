# Observabilidad del dashboard web — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que cuando a un cliente se le rompa una pantalla te enteres tú antes que él, con el stack simbolicado a `.tsx`, el venue al que le
pasó, y la secuencia de llamadas a la API que precedió al crash.

**Architecture:** `@sentry/react` reporta a Sentry SaaS (D6 del spec: el dashboard se despliega minificado y Better Stack no acepta source
maps). `@sentry/vite-plugin` sube los mapas en cada build y los borra del artefacto publicado, así que el bundle sigue minificado de cara al
usuario. Un interceptor de request origina un `X-Correlation-ID` por llamada; el de respuesta deja un breadcrumb con ese id, de modo que un
error de render llega con la secuencia real de requests que lo precedieron y se salta al log del server desde cualquiera de ellos.

**Tech Stack:** React 18.3, Vite 7.3, TypeScript, axios 1.7, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-08-observabilidad-de-errores-design.md`, Parte C.

**Repo:** `avoqado-web-dashboard` (hermano de `avoqado-server` en el workspace). Todas las rutas de este plan son relativas a la raíz de ese
repo.

**Dependencia de orden con el server:** ninguna que bloquee. Verificado 2026-08-08: `X-Correlation-Id` ya está en `allowedHeaders` del CORS
del server (`avoqado-server/src/config/corsOptions.ts:156`), así que **enviar** el header no rompe el preflight. Exponerlo para poder
**leerlo** es un paso del plan del server, pero este plan no depende de él: el dashboard origina su propio id.

## Global Constraints

- **Idioma del código: inglés.** Identificadores, comentarios y nombres de test en inglés. Solo lo que lee una persona (textos de UI vía
  i18n) va en español.
- **Git: nunca commitear sin permiso explícito del founder.** Los pasos muestran el comando; preguntar antes.
- **`git add` por rutas explícitas.** Nunca `git add -A`.
- **Nada de secretos al repo.** El `VITE_SENTRY_DSN` es visible en el bundle publicado y eso es normal por diseño de Sentry; el **auth
  token** de subida de source maps NO lo es y vive solo en CI y en `.env.sentry-build-plugin` (que va a `.gitignore`).
- **No romper el auto-reload de chunks.** `ErrorBoundary` y `main.tsx` recargan la página cuando falla la carga de un chunk tras un deploy.
  Es un comportamiento correcto y frecuente; **no se reporta como error** o la consola se llena de ruido de cada despliegue.
- **`console` se elimina en producción.** `vite.config.ts:38` tiene `esbuild.drop: ['console','debugger']` en modo production. Los
  breadcrumbs de consola de Sentry estarán **vacíos en prod**; por eso los breadcrumbs de axios de la Tarea 4 son la fuente real de contexto
  y no un extra.
- **Tests con Vitest**, no Jest: `npx vitest run <archivo>`.

---

## File Structure

| Archivo                                  | Responsabilidad                                                     | Tarea |
| ---------------------------------------- | ------------------------------------------------------------------- | ----- |
| `src/lib/sentry.ts`                      | **Nuevo.** `Sentry.init`, scrubbing, y los helpers de identidad     | 1     |
| `src/main.tsx:20`                        | Llamar al init junto a `initPostHog()`                              | 1     |
| `vite.config.ts`                         | `build.sourcemap` + `sentryVitePlugin`                              | 2     |
| `src/api.ts`                             | Interceptor de request (nuevo) y extensión del de respuesta (`:71`) | 3, 4  |
| `src/components/ErrorBoundary.tsx:53-62` | Captura real, conservando el camino de chunk                        | 5     |
| `src/context/AuthContext.tsx:123-132`    | Identidad de usuario y venue                                        | 6     |

Todo lo nuevo vive en `src/lib/sentry.ts` para que revertir sea borrar un archivo y cinco enganches.

---

### Task 1: Inicializar Sentry

**Files:**

- Create: `src/lib/sentry.ts`
- Modify: `src/main.tsx`
- Create: `.env.example` (añadir la variable) y `.gitignore` (añadir `.env.sentry-build-plugin`)
- Test: `src/lib/__tests__/sentry.test.ts`

**Interfaces:**

- Consumes: nada.
- Produces: `initSentry(): void`, `buildBeforeSend()` (exportada para testear), `identifySentryUser(user: { id: string } | null): void`,
  `setSentryVenue(venueId: string | null): void`. Las tareas 4, 5 y 6 usan estos nombres exactos.

**Prerequisito:** proyecto `avoqado-dashboard` creado en Sentry (P2 del spec) y su DSN a mano. Sin DSN el SDK queda inerte y la tarea se
completa y testea igual.

- [ ] **Step 1: Install the SDK**

```bash
npm install @sentry/react
npm install --save-dev @sentry/vite-plugin
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/__tests__/sentry.test.ts`:

```typescript
/**
 * The dashboard runs in browsers the venue controls: extensions, old versions, flaky
 * networks. Two things must hold before anything is sent.
 *
 * 1. Chunk-load failures are NOT errors. They happen on every deploy when a client holds
 *    a stale index. The app already auto-reloads on them. Reporting them would bury the
 *    real bugs under deploy noise.
 * 2. No PII leaves the browser. Same allowlist posture as the backend (D3 of the spec).
 */

import { describe, it, expect } from 'vitest'
import { buildBeforeSend, isIgnorableError } from '../sentry'

const beforeSend = buildBeforeSend()

const eventWith = (overrides: Record<string, unknown> = {}) =>
  ({ exception: { values: [{ type: 'Error', value: 'boom' }] }, ...overrides }) as never

describe('isIgnorableError', () => {
  it('🔴 ignores chunk load failures', () => {
    expect(isIgnorableError('Failed to fetch dynamically imported module: /assets/x.js')).toBe(true)
    expect(isIgnorableError('Loading chunk 42 failed')).toBe(true)
    expect(isIgnorableError('Loading CSS chunk 7 failed')).toBe(true)
  })

  it('🔴 ignores browser-extension and network noise we cannot act on', () => {
    expect(isIgnorableError('ResizeObserver loop completed with undelivered notifications')).toBe(true)
    expect(isIgnorableError('Network Error')).toBe(true)
  })

  it('does not ignore a real application error', () => {
    expect(isIgnorableError("Cannot read properties of undefined (reading 'venueId')")).toBe(false)
  })
})

describe('beforeSend', () => {
  it('drops ignorable errors entirely', () => {
    const event = eventWith({ exception: { values: [{ type: 'Error', value: 'Loading chunk 42 failed' }] } })
    expect(beforeSend(event, {} as never)).toBeNull()
  })

  it('keeps a real error', () => {
    expect(beforeSend(eventWith(), {} as never)).not.toBeNull()
  })

  it('🔴 redacts an email that leaked into the exception message', () => {
    const event = eventWith({ exception: { values: [{ type: 'Error', value: 'failed for cliente@ejemplo.com' }] } })
    const out = beforeSend(event, {} as never) as Record<string, unknown>
    expect(JSON.stringify(out)).not.toContain('cliente@ejemplo.com')
  })

  it('🔴 strips the query string from the URL', () => {
    const event = eventWith({ request: { url: 'https://dashboard.avoqado.io/venues?email=cliente@ejemplo.com' } })
    const out = beforeSend(event, {} as never) as Record<string, unknown>
    expect(JSON.stringify((out.request as Record<string, unknown>).url)).not.toContain('cliente@ejemplo.com')
  })

  it('🔴 never sends the user email or ip, only the id', () => {
    const event = eventWith({ user: { id: 'user-1', email: 'cliente@ejemplo.com', ip_address: '1.2.3.4' } })
    const out = beforeSend(event, {} as never) as Record<string, unknown>
    expect(out.user).toEqual({ id: 'user-1' })
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npx vitest run src/lib/__tests__/sentry.test.ts
```

Expected: FAIL, no existe `../sentry`.

- [ ] **Step 4: Write the module**

Create `src/lib/sentry.ts`:

```typescript
import * as Sentry from '@sentry/react'

/**
 * Errors that are noise, not bugs.
 *
 * Chunk failures happen on every deploy: a client holding a stale index asks for a hash
 * that no longer exists. The app already handles it by reloading (ErrorBoundary and the
 * vite:preloadError listener in main.tsx). Reporting them would make every deploy look
 * like an incident.
 *
 * ResizeObserver and bare "Network Error" are browser and connectivity noise we cannot
 * act on from here.
 */
const IGNORABLE_PATTERNS = [
  'failed to fetch dynamically imported module',
  'loading chunk',
  'loading css chunk',
  'dynamically imported module',
  'resizeobserver loop',
  'network error',
]

export function isIgnorableError(message: string): boolean {
  const normalized = message.toLowerCase()
  return IGNORABLE_PATTERNS.some(pattern => normalized.includes(pattern))
}

/** Same posture as the backend: nothing sensitive leaves, even inside free text. */
const SENSITIVE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'rfc', pattern: /\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/g },
  { label: 'clabe', pattern: /\b\d{18}\b/g },
  { label: 'email', pattern: /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g },
  { label: 'jwt', pattern: /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g },
]

function redactString(value: string): string {
  let result = value
  for (const { label, pattern } of SENSITIVE_PATTERNS) result = result.replace(pattern, `[REDACTED:${label}]`)
  return result
}

function redactDeep<T>(value: T, depth = 0, seen = new WeakSet<object>()): T {
  if (depth > 5) return value
  if (typeof value === 'string') return redactString(value) as unknown as T
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value as object)) return value
  seen.add(value as object)
  if (Array.isArray(value)) return value.map(item => redactDeep(item, depth + 1, seen)) as unknown as T
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactDeep(entry, depth + 1, seen)]),
  ) as T
}

export function buildBeforeSend() {
  return (event: Sentry.ErrorEvent): Sentry.ErrorEvent | null => {
    const message = event.exception?.values?.[0]?.value ?? ''
    if (isIgnorableError(message)) return null

    if (event.request?.url) event.request.url = event.request.url.split('?')[0]
    event.user = event.user?.id ? { id: String(event.user.id) } : undefined
    if (event.exception) event.exception = redactDeep(event.exception)
    if (event.breadcrumbs) event.breadcrumbs = redactDeep(event.breadcrumbs)
    if (event.extra) event.extra = redactDeep(event.extra)

    return event
  }
}

/**
 * Starts error reporting. No-op when VITE_SENTRY_DSN is absent, so local dev and preview
 * builds never send anything and never need the variable.
 */
export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN
  if (!dsn) return

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    sendDefaultPii: false,
    // No performance tracing: we are buying error visibility, and transactions are the
    // bulk of Sentry quota consumption (see S-1 in the spec).
    tracesSampleRate: 0,
    beforeSend: buildBeforeSend(),
  })
}

/** Called on login and logout. Only the id: never the email or the name. */
export function identifySentryUser(user: { id: string } | null): void {
  Sentry.setUser(user ? { id: user.id } : null)
}

/** Called whenever the active venue changes, including on first load. */
export function setSentryVenue(venueId: string | null): void {
  Sentry.setTag('venueId', venueId ?? undefined)
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run src/lib/__tests__/sentry.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Wire it into main.tsx**

En `src/main.tsx`, añadir el import junto a los otros de `lib` y llamarlo **antes** de `initPostHog()` (línea 20), para que un fallo del
propio arranque quede reportado:

```typescript
import { initSentry } from './lib/sentry'

// Error reporting first: anything that throws during the rest of the bootstrap should be
// reported, including a failure inside initPostHog.
initSentry()

// PostHog product analytics — no-op unless VITE_POSTHOG_KEY is set
initPostHog()
```

- [ ] **Step 7: Document the variable and ignore the build secret**

En `.env.example` (crearlo si no existe), añadir:

```
# Error tracking (Sentry). Sin valor, el SDK queda inerte.
VITE_SENTRY_DSN=
```

En `.gitignore`, añadir:

```
.env.sentry-build-plugin
```

- [ ] **Step 8: Verify the build still works**

```bash
npm run build
```

Expected: `tsc -b && vite build` pasa.

- [ ] **Step 9: Format and commit** (pedir permiso)

```bash
git add src/lib/sentry.ts src/lib/__tests__/sentry.test.ts src/main.tsx .env.example .gitignore package.json package-lock.json
git commit -m "feat(observability): initialize Sentry error reporting"
```

---

### Task 2: Source maps simbolicados en el build

**Files:**

- Modify: `vite.config.ts:40` (bloque `build`)

**Interfaces:**

- Consumes: nada del código; consume el auth token de Sentry (P6 del spec) desde el entorno de CI.
- Produces: builds de producción cuyos stack traces se leen en `.tsx` con la línea correcta.

Sin esta tarea, el resto del plan entrega una consola llena de `index-a1b2c3.js:1:48213`. Es la razón por la que D6 mandó el dashboard a
Sentry en vez de a Better Stack.

- [ ] **Step 1: Add the plugin to the Vite config**

En `vite.config.ts`, importar arriba:

```typescript
import { sentryVitePlugin } from '@sentry/vite-plugin'
```

Añadir el plugin al final del array `plugins` (debe ir **después** de los demás) y activar los source maps en el bloque `build` existente:

```typescript
    // Must come last: it needs the final built assets to upload their maps.
    // No-ops without SENTRY_AUTH_TOKEN, so local builds are unaffected.
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: 'avoqado-dashboard',
      authToken: process.env.SENTRY_AUTH_TOKEN,
      disable: !process.env.SENTRY_AUTH_TOKEN,
      sourcemaps: {
        // Delete the .map files after uploading: they are for Sentry, not for the public.
        filesToDeleteAfterUpload: ['./dist/**/*.map'],
      },
    }),
```

En el bloque `build` (línea 40), añadir:

```typescript
  build: {
    // 'hidden' generates the maps for upload without leaving a sourceMappingURL comment
    // in the shipped bundle, so the browser never fetches them and users still get a
    // minified app.
    sourcemap: 'hidden',
    rollupOptions: {
      // ... (lo existente sin cambios: manualChunks)
    },
    chunkSizeWarningLimit: 1000,
  },
```

- [ ] **Step 2: Verify a local build produces maps and then removes them**

```bash
npm run build
ls dist/assets/*.map 2>/dev/null | head
```

Expected: sin `SENTRY_AUTH_TOKEN` el plugin está deshabilitado, así que los `.map` **se generan y se quedan** en `dist/`. Eso es correcto en
local. Lo que importa es que el build no falle.

- [ ] **Step 3: Verify the shipped bundle has no sourceMappingURL**

```bash
grep -l "sourceMappingURL" dist/assets/*.js | head
```

Expected: **sin resultados.** Con `sourcemap: 'hidden'` el comentario no se emite. Si aparece, el valor quedó en `true` en vez de `'hidden'`
y los mapas serían públicos.

- [ ] **Step 4: Configure CI**

Añadir `SENTRY_AUTH_TOKEN` y `SENTRY_ORG` como secretos del pipeline que construye el dashboard. **No** ponerlos en ningún archivo del repo.

- [ ] **Step 5: Commit** (pedir permiso)

```bash
git add vite.config.ts
git commit -m "build(observability): upload source maps to Sentry and keep the bundle minified"
```

---

### Task 3: Originar el `X-Correlation-ID` en cada request

**Files:**

- Modify: `src/api.ts` (añadir `api.interceptors.request`)
- Test: `src/__tests__/api-correlation.test.ts`

**Interfaces:**

- Consumes: nada.
- Produces: cada request de `api` sale con el header `X-Correlation-ID` y con `config.correlationId` disponible para el interceptor de
  respuesta de la Tarea 4.

**Sutileza que hay que respetar:** el interceptor de respuesta existente reintenta una vez los errores de red (`config._retry`,
`src/api.ts:95-100`) reusando el mismo objeto `config`. El reintento **debe conservar el id original**: son dos requests HTTP pero una sola
operación lógica, y darles ids distintos rompe justo la traza que queremos. Es el mismo razonamiento que aplicó al servicio de reintentos
del server.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/api-correlation.test.ts`:

```typescript
/**
 * The correlation id is what lets a broken screen and the 500 that caused it be found as
 * one thing across two consoles. The dashboard originates it rather than reading it back
 * from the response, because the case that matters most is the one where the response
 * never arrives.
 */

import { describe, it, expect, vi } from 'vitest'
import { attachCorrelationId } from '../api'

describe('attachCorrelationId', () => {
  it('adds an X-Correlation-ID header', () => {
    const config = attachCorrelationId({ headers: {} } as never)
    expect(config.headers['X-Correlation-ID']).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('exposes the id on the config for the response interceptor', () => {
    const config = attachCorrelationId({ headers: {} } as never)
    expect(config.correlationId).toBe(config.headers['X-Correlation-ID'])
  })

  it('generates a different id per request', () => {
    const first = attachCorrelationId({ headers: {} } as never)
    const second = attachCorrelationId({ headers: {} } as never)
    expect(first.correlationId).not.toBe(second.correlationId)
  })

  it('🔴 reuses the existing id on a retry instead of minting a new one', () => {
    const config = attachCorrelationId({ headers: {} } as never)
    const original = config.correlationId
    // The response interceptor retries network errors with the SAME config object.
    const retried = attachCorrelationId(config as never)
    expect(retried.correlationId).toBe(original)
    expect(retried.headers['X-Correlation-ID']).toBe(original)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run src/__tests__/api-correlation.test.ts
```

Expected: FAIL, `attachCorrelationId` no está exportada.

- [ ] **Step 3: Add the interceptor**

En `src/api.ts`, después de `const api = axios.create({...})` (línea ~50):

```typescript
import type { InternalAxiosRequestConfig } from 'axios'

/**
 * Stamps a correlation id on every outgoing request.
 *
 * Exported for testing. Idempotent on purpose: the response interceptor retries network
 * errors with the SAME config object, and a retry must keep the original id — two HTTP
 * requests, one logical operation.
 *
 * The server already accepts this header (requestLogger honors an inbound
 * X-Correlation-ID) and CORS already allows it, so nothing on the backend has to change
 * for this to work.
 */
export const attachCorrelationId = (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
  const existing = config.headers?.['X-Correlation-ID'] as string | undefined
  const correlationId = existing ?? crypto.randomUUID()
  config.headers['X-Correlation-ID'] = correlationId
  ;(config as InternalAxiosRequestConfig & { correlationId?: string }).correlationId = correlationId
  return config
}

api.interceptors.request.use(attachCorrelationId)
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npx vitest run src/__tests__/api-correlation.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Verify a real request carries the header**

```bash
npm run dev
```

Abrir el dashboard, entrar a cualquier pantalla y en las devtools, pestaña Network, confirmar que los requests a la API llevan
`X-Correlation-ID` en los headers de solicitud y que **ninguno falla por CORS**. Si algo se bloquea en el preflight, parar aquí y revisar
`allowedHeaders` en el server: no debería pasar, ya está permitido.

- [ ] **Step 6: Commit** (pedir permiso)

```bash
git add src/api.ts src/__tests__/api-correlation.test.ts
git commit -m "feat(observability): originate a correlation id on every API request"
```

---

### Task 4: Breadcrumbs y captura de fallos de API

**Files:**

- Modify: `src/api.ts:71` (el `onRejected` del interceptor de respuesta)
- Test: `src/__tests__/api-breadcrumbs.test.ts`

**Interfaces:**

- Consumes: `config.correlationId` de la Tarea 3.
- Produces: `recordApiBreadcrumb(response)` y `captureApiFailure(error)` exportadas desde `src/api.ts`.

Este es el mecanismo que hace útil al `ErrorBoundary` de la Tarea 5. Como el error de render no puede saber honestamente cuál de los
requests en vuelo lo causó, en vez de inventar esa atribución dejamos la secuencia completa: quien investiga ve las últimas llamadas con su
id y salta al log del server desde cualquiera.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/api-breadcrumbs.test.ts`:

```typescript
/**
 * Two rules that matter more than the mechanics:
 *
 * 1. Breadcrumbs never carry request or response bodies. A venue's fiscal data would end
 *    up in a third-party console with no way to unsend it.
 * 2. A 401 is not a bug. Sessions expire; the app already redirects to login. Capturing
 *    them would drown the real failures.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Sentry from '@sentry/react'
import { recordApiBreadcrumb, shouldCaptureApiFailure } from '../api'

vi.mock('@sentry/react', () => ({ addBreadcrumb: vi.fn(), captureException: vi.fn(), setUser: vi.fn(), setTag: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('recordApiBreadcrumb', () => {
  it('records method, path, status and correlation id', () => {
    recordApiBreadcrumb({
      config: { method: 'post', url: '/api/v1/orders', correlationId: 'corr-1' },
      status: 500,
    } as never)

    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'api',
        data: expect.objectContaining({ method: 'POST', url: '/api/v1/orders', status: 500, correlationId: 'corr-1' }),
      }),
    )
  })

  it('🔴 never records the request or response body', () => {
    recordApiBreadcrumb({
      config: { method: 'post', url: '/api/v1/customers', correlationId: 'corr-1', data: { rfc: 'AAA010101AAA' } },
      status: 200,
      data: { email: 'cliente@ejemplo.com' },
    } as never)

    const call = vi.mocked(Sentry.addBreadcrumb).mock.calls[0][0]
    expect(JSON.stringify(call)).not.toContain('AAA010101AAA')
    expect(JSON.stringify(call)).not.toContain('cliente@ejemplo.com')
  })

  it('🔴 strips the query string from the recorded url', () => {
    recordApiBreadcrumb({ config: { method: 'get', url: '/api/v1/x?email=cliente@ejemplo.com' }, status: 200 } as never)
    const call = vi.mocked(Sentry.addBreadcrumb).mock.calls[0][0]
    expect(JSON.stringify(call)).not.toContain('cliente@ejemplo.com')
  })
})

describe('shouldCaptureApiFailure', () => {
  it('captures a 5xx', () => {
    expect(shouldCaptureApiFailure({ response: { status: 500 } } as never)).toBe(true)
  })

  it('🔴 does NOT capture 401 or 403', () => {
    expect(shouldCaptureApiFailure({ response: { status: 401 } } as never)).toBe(false)
    expect(shouldCaptureApiFailure({ response: { status: 403 } } as never)).toBe(false)
  })

  it('🔴 does NOT capture 404 or 422', () => {
    expect(shouldCaptureApiFailure({ response: { status: 404 } } as never)).toBe(false)
    expect(shouldCaptureApiFailure({ response: { status: 422 } } as never)).toBe(false)
  })

  it('🔴 does NOT capture a network error: the app already shows an offline state', () => {
    expect(shouldCaptureApiFailure({ code: 'ERR_NETWORK', message: 'Network Error' } as never)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run src/__tests__/api-breadcrumbs.test.ts
```

Expected: FAIL, funciones no exportadas.

- [ ] **Step 3: Add the helpers and wire them**

En `src/api.ts`, añadir:

```typescript
import * as Sentry from '@sentry/react'

type ApiConfig = { method?: string; url?: string; correlationId?: string }

/**
 * Leaves a trail of API calls so a render error that happens LATER arrives with the real
 * sequence that preceded it.
 *
 * Deliberately never carries bodies: this is a third-party console and the payloads hold
 * fiscal and customer data. Method, path, status and correlation id are enough to find the
 * matching server log.
 */
export const recordApiBreadcrumb = (response: { config?: ApiConfig; status?: number }): void => {
  const config = response.config ?? {}
  Sentry.addBreadcrumb({
    category: 'api',
    level: (response.status ?? 0) >= 500 ? 'error' : 'info',
    message: `${(config.method ?? 'get').toUpperCase()} ${(config.url ?? '').split('?')[0]}`,
    data: {
      method: (config.method ?? 'get').toUpperCase(),
      url: (config.url ?? '').split('?')[0],
      status: response.status,
      correlationId: config.correlationId,
    },
  })
}

/**
 * Only server faults are worth reporting.
 *
 * 401/403 are expected: sessions expire and permissions are enforced, and the app already
 * handles both. 404/422 are the client asking for something that is not there or sending
 * something invalid. A network error means the venue's internet dropped, which the app
 * already surfaces with an offline state.
 */
export const shouldCaptureApiFailure = (error: { response?: { status?: number }; code?: string }): boolean => {
  const status = error.response?.status
  if (status === undefined) return false
  return status >= 500
}
```

En el interceptor de respuesta (`:71`), añadir la llamada al breadcrumb en **ambas** ramas, y la captura en la de error. En la rama de
éxito, antes del `return response`:

```typescript
recordApiBreadcrumb(response)
```

En la rama de error, **después** del bloque de reintento por red y **antes** del manejo de impersonación, para que un reintento exitoso no
reporte nada:

```typescript
recordApiBreadcrumb({ config: error.config, status: error.response?.status })
if (shouldCaptureApiFailure(error)) {
  Sentry.captureException(error, {
    tags: { correlationId: error.config?.correlationId, httpStatus: error.response?.status },
  })
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npx vitest run src/__tests__/api-breadcrumbs.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Verify no regression in the existing interceptor behavior**

```bash
npx vitest run
```

Expected: la suite completa en verde. Prestar atención a los tests de `AuthContext` (`src/context/__tests__/`), que ejercitan el camino de
401 y logout.

- [ ] **Step 6: Commit** (pedir permiso)

```bash
git add src/api.ts src/__tests__/api-breadcrumbs.test.ts
git commit -m "feat(observability): breadcrumb every API call and report server faults"
```

---

### Task 5: Captura real en el ErrorBoundary

**Files:**

- Modify: `src/components/ErrorBoundary.tsx:53-62`
- Test: `src/components/__tests__/ErrorBoundary.capture.test.tsx`

**Interfaces:**

- Consumes: `isIgnorableError` de la Tarea 1.
- Produces: nada nuevo. El efecto es que un crash de render llega a Sentry con su `componentStack`.

Aquí está el `// TODO: Send to error tracking service in production` que lleva tiempo en el archivo (`:61`). Esta tarea lo cumple.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/ErrorBoundary.capture.test.tsx`:

```typescript
/**
 * The chunk-reload path must keep winning.
 *
 * When a deploy lands, clients holding a stale index fail to fetch chunks that no longer
 * exist. The boundary reloads the page and the user never notices. If we reported those,
 * every deploy would look like an incident and the real crashes would be buried.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import * as Sentry from '@sentry/react'
import ErrorBoundary from '../ErrorBoundary'

vi.mock('@sentry/react', () => ({ captureException: vi.fn(), addBreadcrumb: vi.fn(), setUser: vi.fn(), setTag: vi.fn() }))

const Boom = ({ message }: { message: string }) => {
  throw new Error(message)
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  // jsdom does not implement navigation; stub it so the chunk path does not throw.
  Object.defineProperty(window, 'location', { value: { reload: vi.fn(), href: '' }, writable: true })
})

describe('ErrorBoundary reporting', () => {
  it('captures a real render error with its component stack', () => {
    render(
      <ErrorBoundary>
        <Boom message="Cannot read properties of undefined (reading 'venueId')" />
      </ErrorBoundary>,
    )

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('venueId') }),
      expect.objectContaining({ contexts: expect.objectContaining({ react: expect.anything() }) }),
    )
  })

  it('🔴 does NOT capture a chunk load failure, and still reloads', () => {
    render(
      <ErrorBoundary>
        <Boom message="Failed to fetch dynamically imported module: /assets/x.js" />
      </ErrorBoundary>,
    )

    expect(Sentry.captureException).not.toHaveBeenCalled()
    expect(window.location.reload).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run src/components/__tests__/ErrorBoundary.capture.test.tsx
```

Expected: FAIL, `captureException` nunca se llama.

Si falla por falta de `@testing-library/react`, instalarlo como dev dependency antes de continuar:

```bash
npm install --save-dev @testing-library/react
```

- [ ] **Step 3: Add the capture**

En `src/components/ErrorBoundary.tsx`, importar arriba:

```typescript
import * as Sentry from '@sentry/react'
import { isIgnorableError } from '@/lib/sentry'
```

Y reemplazar el bloque final de `componentDidCatch` (líneas 53-62, desde el comentario `// Log error to console` hasta el `// Example:`)
por:

```typescript
// Log error to console in development only
if (import.meta.env.DEV) {
  console.error('ErrorBoundary caught an error:', error)
  console.error('Component stack:', errorInfo.componentStack)
}

// Report the crash with the component stack, which is what makes a render error
// actionable. Chunk failures are already handled above and are deploy noise, not bugs.
if (!isIgnorableError(error.message)) {
  Sentry.captureException(error, {
    contexts: { react: { componentStack: errorInfo.componentStack } },
  })
}
```

**No tocar** el bloque de `isChunkError` que está arriba: sigue siendo el primero en correr y sigue haciendo `return` antes de llegar aquí.

- [ ] **Step 4: Run it to verify it passes**

```bash
npx vitest run src/components/__tests__/ErrorBoundary.capture.test.tsx
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit** (pedir permiso)

```bash
git add src/components/ErrorBoundary.tsx src/components/__tests__/ErrorBoundary.capture.test.tsx package.json package-lock.json
git commit -m "feat(observability): report render crashes with their component stack"
```

---

### Task 6: Identidad de usuario y de venue

**Files:**

- Modify: `src/context/AuthContext.tsx:123-132`
- Test: `src/context/__tests__/AuthContext.sentry-identity.test.ts`

**Interfaces:**

- Consumes: `identifySentryUser`, `setSentryVenue` de la Tarea 1.
- Produces: nada nuevo.

Sin esto, la consola muestra errores sin dueño y no se puede contestar la pregunta que de verdad importa: "¿a cuántos venues les está
pasando?".

- [ ] **Step 1: Write the failing test**

Create `src/context/__tests__/AuthContext.sentry-identity.test.ts`:

```typescript
/**
 * Identity has to clear on logout. If it does not, a shared machine at the front desk
 * would attribute the next person's errors to whoever logged in first, and the audit
 * question "who saw this" gets a wrong answer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Sentry from '@sentry/react'
import { identifySentryUser, setSentryVenue } from '@/lib/sentry'

vi.mock('@sentry/react', () => ({ setUser: vi.fn(), setTag: vi.fn(), init: vi.fn(), captureException: vi.fn(), addBreadcrumb: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('sentry identity helpers', () => {
  it('sets only the user id, never the email', () => {
    identifySentryUser({ id: 'user-1' })
    expect(Sentry.setUser).toHaveBeenCalledWith({ id: 'user-1' })
  })

  it('🔴 clears the user on logout', () => {
    identifySentryUser(null)
    expect(Sentry.setUser).toHaveBeenCalledWith(null)
  })

  it('sets the venue tag', () => {
    setSentryVenue('venue-1')
    expect(Sentry.setTag).toHaveBeenCalledWith('venueId', 'venue-1')
  })

  it('🔴 clears the venue tag when there is no active venue', () => {
    setSentryVenue(null)
    expect(Sentry.setTag).toHaveBeenCalledWith('venueId', undefined)
  })
})
```

- [ ] **Step 2: Run it to verify it fails or passes**

```bash
npx vitest run src/context/__tests__/AuthContext.sentry-identity.test.ts
```

Expected: PASS si la Tarea 1 ya está hecha. Este test blinda el contrato de los helpers antes de engancharlos.

- [ ] **Step 3: Hook identity into the existing effect**

En `src/context/AuthContext.tsx`, añadir el import:

```typescript
import { identifySentryUser, setSentryVenue } from '@/lib/sentry'
```

Y dentro del efecto que ya existe (`:123-132`), junto a `identifyUser` y `resetUser`, sin cambiar su lógica de guarda:

```typescript
useEffect(() => {
  if (user?.id) {
    identifyUser(user)
    identifySentryUser({ id: user.id })
    hadIdentifiedUserRef.current = true
  } else if (hadIdentifiedUserRef.current) {
    resetUser()
    identifySentryUser(null)
    hadIdentifiedUserRef.current = false
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- identify only when the user id changes, not on every refetch
}, [user?.id])
```

- [ ] **Step 4: Add a second effect for the venue tag**

Justo después del efecto anterior. Va aparte y no dentro de `switchVenue` a propósito: keyeado al `activeVenue` queda correcto también en la
carga inicial y tras un refetch, no solo cuando alguien cambia de venue a mano.

```typescript
// Venue tag, keyed on the active venue so it is correct on first load too, not only
// after an explicit switch.
useEffect(() => {
  setSentryVenue(activeVenue?.id ?? null)
}, [activeVenue?.id])
```

Verificar el nombre real de la variable del venue activo en el contexto antes de escribirlo: en este archivo aparece como `activeVenue`
(`:218`, `:228`). Si el campo del id no es `.id`, ajustarlo, no inventarlo.

- [ ] **Step 5: Run the AuthContext suite**

```bash
npx vitest run src/context/__tests__/
```

Expected: los tests existentes de login, logout y access-control siguen en verde, más los 4 nuevos.

- [ ] **Step 6: Commit** (pedir permiso)

```bash
git add src/context/AuthContext.tsx src/context/__tests__/AuthContext.sentry-identity.test.ts
git commit -m "feat(observability): attribute dashboard errors to user and venue"
```

---

### Task 7: Verificación

- [ ] **Step 1: Full suite and build**

```bash
npx vitest run && npm run build
```

Expected: verde y compila.

- [ ] **Step 2: Verify a seeded error arrives symbolicated**

Construir con el token de Sentry configurado, desplegar a preview, y provocar un error real desde un componente. En la consola de Sentry el
stack debe apuntar a un archivo `.tsx` con la línea correcta.

Si aparece `index-a1b2c3.js:1:48213`, los mapas no se subieron: revisar que `SENTRY_AUTH_TOKEN` esté presente en el build y que
`sourcemap: 'hidden'` esté puesto. Cubre el criterio 8 del spec.

- [ ] **Step 3: Verify the breadcrumb trail**

En ese mismo error, confirmar que los breadcrumbs muestran las últimas llamadas a la API con su `correlationId`. Tomar uno y buscarlo en el
log stream de Better Stack (source `1720702`): debe aparecer el request correspondiente del server. Ese salto entre consolas es el
entregable central de este plan.

- [ ] **Step 4: Verify the deploy noise is NOT reported**

Tras un despliegue, confirmar que **no** llegan eventos de `Failed to fetch dynamically imported module`. Si llegan, el filtro de
`isIgnorableError` no se está aplicando en alguno de los dos caminos (`beforeSend` o `ErrorBoundary`).

- [ ] **Step 5: Verify no PII in real events**

Abrir tres o cuatro errores reales en la consola y revisar URL, breadcrumbs, mensaje y `extra`. No debe haber correos, RFC, CLABE ni tokens.
Si aparece algo, añadir el patrón a `SENSITIVE_PATTERNS` y **borrar los eventos afectados en Sentry** antes de seguir.

- [ ] **Step 6: Verify the kill switch**

En Sentry → Settings → Client Keys, deshabilitar la key del proyecto y confirmar que dejan de llegar eventos sin redesplegar. Volver a
habilitarla. Este es el rollback del plan y hay que probarlo antes de darlo por listo.

---

## Notas para quien ejecute

**Las Tareas 1 y 2 van juntas o el resto no sirve.** Reportar sin simbolicar produce una consola de errores ilegibles, que es peor que no
tener consola: da la sensación de cobertura sin darla.

**Las Tareas 3, 4, 5 y 6 son independientes entre sí** una vez hecha la 1. Se pueden repartir.

**El error más probable** es reportar el ruido de deploy. Si tras el primer despliegue la consola se llena de fallos de chunk, el filtro no
se está aplicando; revisar los dos caminos, no solo uno.

**Lo que este plan deliberadamente no hace:** session replay (implica PII en pantallas con datos fiscales y necesita su propia decisión de
enmascarado), performance tracing (`tracesSampleRate: 0` a propósito, las transacciones son el grueso de la cuota), y tocar PostHog.
