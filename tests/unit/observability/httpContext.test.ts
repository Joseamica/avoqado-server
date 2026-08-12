/**
 * The request logger is the single middleware every byte of traffic passes through, so a
 * mistake here does not degrade a feature — it takes the API down. These tests exist to
 * cover the three ways that could happen.
 *
 * 1. next() stops being called, or gets called twice. Everything hangs, or Express throws.
 * 2. The res listeners end up OUTSIDE the context. They are registered before next(), so
 *    wrapping only next() would silently strip the tenant from the request-completion log
 *    — the one line an investigation actually searches.
 * 3. Two concurrent requests share a context and we attribute a money bug to the wrong
 *    venue, which is worse than having no attribution at all.
 */

import { EventEmitter } from 'node:events'
import type { Request, Response, NextFunction } from 'express'
import { requestLoggerMiddleware } from '@/middlewares/requestLogger'
import { getContext, enrichContext } from '@/observability/executionContext'

const buildReq = (overrides: Partial<Request> = {}): Request =>
  ({
    method: 'POST',
    url: '/api/v1/tpv/payments',
    ip: '1.2.3.4',
    headers: {},
    ...overrides,
  }) as unknown as Request

/**
 * A response double that records the correlation id active at the moment each listener was
 * REGISTERED. That is the property under test: listeners must be attached from inside the
 * context, or they will not see it when they later fire.
 */
const buildRes = () => {
  const emitter = new EventEmitter()
  const contextAtRegistration: Array<string | undefined> = []

  const res = {
    statusCode: 200,
    writableEnded: true,
    setHeader: jest.fn(),
    on(event: string, listener: (...args: unknown[]) => void) {
      contextAtRegistration.push(getContext()?.correlationId)
      emitter.on(event, listener)
      return this
    },
    emit: (event: string) => emitter.emit(event),
  }

  return { res: res as unknown as Response, contextAtRegistration }
}

describe('requestLoggerMiddleware — the hot path', () => {
  it('🔴 calls next exactly once', () => {
    const next = jest.fn() as unknown as NextFunction
    const { res } = buildRes()
    requestLoggerMiddleware(buildReq(), res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('🔴 still sets the response header, so clients keep receiving the id', () => {
    const { res } = buildRes()
    requestLoggerMiddleware(buildReq(), res, jest.fn() as unknown as NextFunction)
    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-ID', expect.any(String))
  })

  it('🔴 registers the res listeners INSIDE the context', () => {
    const { res, contextAtRegistration } = buildRes()
    let idInsideNext: string | undefined

    requestLoggerMiddleware(buildReq(), res, (() => {
      idInsideNext = getContext()?.correlationId
    }) as unknown as NextFunction)

    // Both 'finish' and 'close' were registered, and both saw the same context next() saw.
    expect(contextAtRegistration).toHaveLength(2)
    expect(contextAtRegistration.every(id => id !== undefined)).toBe(true)
    expect(new Set(contextAtRegistration)).toEqual(new Set([idInsideNext]))
  })

  it('does not leak the context after the middleware returns', () => {
    const { res } = buildRes()
    requestLoggerMiddleware(buildReq(), res, jest.fn() as unknown as NextFunction)
    expect(getContext()).toBeUndefined()
  })
})

describe('requestLoggerMiddleware — context shape', () => {
  const runAndRead = (req: Request) => {
    const { res } = buildRes()
    let seen: ReturnType<typeof getContext>
    requestLoggerMiddleware(req, res, (() => {
      seen = getContext()
    }) as unknown as NextFunction)
    return seen
  }

  it('opens the context with source http', () => {
    expect(runAndRead(buildReq())?.source).toBe('http')
  })

  it('normalizes the entrypoint so ids do not fragment the grouping', () => {
    const seen = runAndRead(buildReq({ url: '/api/v1/orders/cmrb9clsl0001c9126obyxp2q?expand=items' }))
    expect(seen?.entrypoint).toBe('POST /api/v1/orders/:id')
  })

  it('honors a safe inbound correlation id — this is the cross-console thread', () => {
    const req = buildReq({ headers: { 'x-correlation-id': 'tpv_01HX8ZQ4M9KJ3N' } as Request['headers'] })
    expect(runAndRead(req)?.correlationId).toBe('tpv_01HX8ZQ4M9KJ3N')
  })

  it('🔴 replaces a hostile inbound header instead of writing it to every log line', () => {
    const req = buildReq({ headers: { 'x-correlation-id': 'a'.repeat(500) } as Request['headers'] })
    const seen = runAndRead(req)
    expect(seen?.correlationId).not.toContain('aaaa')
    expect(seen?.correlationId).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('🔴 replaces a duplicated header, which Express hands back as an array', () => {
    const req = buildReq({ headers: { 'x-correlation-id': ['one', 'two'] } as unknown as Request['headers'] })
    expect(runAndRead(req)?.correlationId).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('generates an id when the client sends none', () => {
    expect(runAndRead(buildReq())?.correlationId).toMatch(/^[0-9a-f-]{36}$/i)
  })
})

describe('🔴 requestLoggerMiddleware — concurrent requests never cross', () => {
  /** One request end to end: middleware opens the context, "auth" enriches it, a service reads it after awaits. */
  const handleRequest = (venueId: string, delayMs: number): Promise<{ venue?: string; correlation?: string }> =>
    new Promise(resolve => {
      const { res } = buildRes()
      const req = buildReq({ headers: { 'x-correlation-id': `corr_${venueId}_${delayMs}` } as Request['headers'] })

      requestLoggerMiddleware(req, res, (async () => {
        // Stands in for authenticateTokenMiddleware.
        enrichContext({ venueId, userId: `user-${venueId}` })
        // Stands in for a service several layers down, after real awaits.
        await new Promise(r => setTimeout(r, delayMs))
        await new Promise(r => setImmediate(r))
        resolve({ venue: getContext()?.venueId, correlation: getContext()?.correlationId })
      }) as unknown as NextFunction)
    })

  it('50 interleaved requests from 2 venues produce zero crossings', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) => {
        const venueId = index % 2 === 0 ? 'venue-a' : 'venue-b'
        const delay = index % 7 // varying delays force real interleaving
        return handleRequest(venueId, delay).then(seen => ({
          expectedVenue: venueId,
          expectedCorrelation: `corr_${venueId}_${delay}`,
          ...seen,
        }))
      }),
    )

    expect(results).toHaveLength(50)
    expect(results.filter(r => r.venue !== r.expectedVenue)).toEqual([])
    expect(results.filter(r => r.correlation !== r.expectedCorrelation)).toEqual([])
  })
})
