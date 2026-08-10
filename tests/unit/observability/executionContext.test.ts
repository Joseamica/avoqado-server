/**
 * The execution context is the thread that carries the correlation id and the tenant
 * through a whole operation, so a `logger.error` three layers deep knows which venue it
 * belongs to without anyone passing it down.
 *
 * Two properties matter more than the rest, and both are tested here with real concurrency
 * rather than by inspecting the implementation:
 *
 * 1. ISOLATION. One Node process serves hundreds of simultaneous operations from different
 *    venues. If two of them ever shared a context, we would attribute a money bug to the
 *    wrong venue — worse than having no attribution at all.
 * 2. SURVIVAL ACROSS AWAIT. The whole point is that the context is still there after the
 *    service has awaited the database three times.
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
      expect(getContext()?.source).toBe('http')
      expect(getContext()?.entrypoint).toBe('GET /test')
    })
  })

  it('returns the callback return value unchanged', () => {
    expect(runWithContext(baseContext(), () => 42)).toBe(42)
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

  it('is visible inside a callback registered while the context was active', done => {
    // This is how res.on('finish') behaves: registered inside the context, run later.
    runWithContext(baseContext({ correlationId: 'corr-listener' }), () => {
      setTimeout(() => {
        expect(getContext()?.correlationId).toBe('corr-listener')
        done()
      }, 1)
    })
  })

  it('🔴 does not swallow a synchronous error', () => {
    expect(() =>
      runWithContext(baseContext(), () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
  })

  it('🔴 does not swallow a rejected promise', async () => {
    await expect(
      runWithContext(baseContext(), async () => {
        throw new Error('async boom')
      }),
    ).rejects.toThrow('async boom')
  })
})

describe('enrichContext', () => {
  it('adds fields to the active context without losing the existing ones', () => {
    runWithContext(baseContext(), () => {
      enrichContext({ venueId: 'venue-1', userId: 'user-1', role: 'WAITER' })
      expect(getContext()).toMatchObject({
        correlationId: 'corr-1',
        venueId: 'venue-1',
        userId: 'user-1',
        role: 'WAITER',
      })
    })
  })

  it('is a no-op outside any context instead of throwing', () => {
    expect(() => enrichContext({ venueId: 'venue-1' })).not.toThrow()
    expect(getContext()).toBeUndefined()
  })

  it('is visible to code that runs after the enrichment, deeper in the chain', async () => {
    const readDeepInsideAService = async () => {
      await new Promise(resolve => setImmediate(resolve))
      return getContext()?.venueId
    }

    const seen = await runWithContext(baseContext(), async () => {
      enrichContext({ venueId: 'venue-late' })
      return readDeepInsideAService()
    })

    expect(seen).toBe('venue-late')
  })
})

describe('🔴 isolation between concurrent operations', () => {
  /** Stands in for a request: opens a context, enriches it after "auth", then awaits. */
  const operation = async (venueId: string, delayMs: number) =>
    runWithContext(baseContext({ correlationId: `corr-${venueId}` }), async () => {
      enrichContext({ venueId })
      await new Promise(resolve => setTimeout(resolve, delayMs))
      await new Promise(resolve => setImmediate(resolve))
      return { seenVenue: getContext()?.venueId, seenCorrelation: getContext()?.correlationId }
    })

  it('two interleaved operations never see each other context', async () => {
    // The slow one starts first and finishes last, so they genuinely overlap.
    const [slow, fast] = await Promise.all([operation('venue-slow', 20), operation('venue-fast', 1)])

    expect(slow).toEqual({ seenVenue: 'venue-slow', seenCorrelation: 'corr-venue-slow' })
    expect(fast).toEqual({ seenVenue: 'venue-fast', seenCorrelation: 'corr-venue-fast' })
  })

  it('50 interleaved operations across 2 venues produce zero crossings', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) => {
        const venueId = index % 2 === 0 ? 'venue-a' : 'venue-b'
        // Varying delays force the event loop to interleave them.
        return operation(venueId, index % 7).then(result => ({ expected: venueId, ...result }))
      }),
    )

    const crossed = results.filter(r => r.seenVenue !== r.expected)
    expect(crossed).toEqual([])
    expect(results).toHaveLength(50)
  })

  it('a nested context does not corrupt the outer one', async () => {
    await runWithContext(baseContext({ correlationId: 'outer' }), async () => {
      await runWithContext(baseContext({ correlationId: 'inner' }), async () => {
        expect(getContext()?.correlationId).toBe('inner')
      })
      // Back outside the nested run, the outer context must be intact.
      expect(getContext()?.correlationId).toBe('outer')
    })
  })
})
