/**
 * Async-error guardrail (express-async-errors) — crash-class regression.
 *
 * Express 4 does NOT forward a REJECTED promise from an async middleware/route to
 * next(err): the rejection escapes as a process-level unhandledRejection and crashes
 * the server (server.ts gracefulShutdown). That is exactly the 2026-06-23 incident — a
 * transient DB error (P1017/P2024) in the bare-async checkOwnerAccess middleware took the
 * whole process down.
 *
 * `import 'express-async-errors'` (loaded once at the top of src/app.ts) patches Express so
 * any such rejection reaches the global error handler instead. This test proves the patch
 * turns a bare async rejection into a clean 500 — NOT a hung request and NOT a crash — and
 * does not regress the happy path. It is the generic net behind the per-middleware try/catch.
 */
import 'express-async-errors'
import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// A Prisma-style transient DB error — the kind that crashed prod (pool timeout / conn closed).
const dbError = (code: string) => Object.assign(new Error(`prisma ${code}`), { code })

function buildApp(handler: (req: Request, res: Response, next: NextFunction) => unknown) {
  const app = express()
  app.get('/boom', handler as any)
  // Mirror src/app.ts's terminal error handler: a forwarded error → clean 500.

  app.use((err: Error & { code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ message: 'Internal Server Error', code: err.code })
  })
  return app
}

describe('async-error guardrail (express-async-errors)', () => {
  // NEW: a bare async middleware that throws with no try/catch (the checkOwnerAccess footgun)
  // must be forwarded to the error handler, not escape as an unhandledRejection.
  it('forwards a thrown transient error (P2024) from a bare async handler → 500, not a crash', async () => {
    const app = buildApp(async () => {
      throw dbError('P2024')
    })

    const res = await request(app).get('/boom')

    expect(res.status).toBe(500)
    expect(res.body.code).toBe('P2024')
  })

  it('forwards a rejected awaited promise (P1017) the same way', async () => {
    const app = buildApp(async () => {
      await Promise.reject(dbError('P1017'))
    })

    const res = await request(app).get('/boom')

    expect(res.status).toBe(500)
    expect(res.body.code).toBe('P1017')
  })

  // REGRESSION: a normal async handler must still respond untouched.
  it('does not regress the happy path — a normal async handler still responds 200', async () => {
    const app = buildApp(async (_req, res) => {
      res.status(200).json({ ok: true })
    })

    const res = await request(app).get('/boom')

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })
})

/**
 * Production wiring guard.
 *
 * The behavioral tests above prove the express-async-errors LIBRARY forwards a bare async
 * rejection — but they build a throwaway app and never import src/app.ts, so they would stay
 * green even if the production wiring were deleted. These source-level assertions pin the
 * actual wiring in src/app.ts so an accidental removal — or an import-sorter reordering the
 * side-effect import BELOW the routers (which would silently disarm it) — fails CI.
 */
describe('production wiring (src/app.ts)', () => {
  const src = readFileSync(resolve(__dirname, '../../../src/app.ts'), 'utf8')
  const importIdx = src.indexOf("import 'express-async-errors'")

  it('imports express-async-errors', () => {
    expect(importIdx).toBeGreaterThan(-1)
  })

  it('imports it AFTER express is loaded and BEFORE any router/route is mounted', () => {
    const expressImportIdx = src.indexOf("from 'express'")
    const firstAppUse = src.indexOf('app.use(')
    const routesImportIdx = src.indexOf("from './routes'")

    expect(expressImportIdx).toBeGreaterThan(-1)
    expect(importIdx).toBeGreaterThan(expressImportIdx) // after express is loaded
    expect(importIdx).toBeLessThan(routesImportIdx) // before the main router module is imported
    expect(importIdx).toBeLessThan(firstAppUse) // before any middleware/router is mounted
  })

  it('guards the global error handler against a double-send (res.headersSent)', () => {
    // The patch widens the "respond-then-reject" surface; the handler must short-circuit
    // when a response has already started instead of throwing ERR_HTTP_HEADERS_SENT.
    expect(src).toMatch(/if \(res\.headersSent\)/)
  })
})
