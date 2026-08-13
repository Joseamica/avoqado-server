/**
 * Before this format existed, a `logger.error` three layers deep inside a service produced
 * a line with a stack trace and no idea which venue it belonged to. Every production
 * investigation started by grepping an anonymous log stream and guessing by timestamp.
 *
 * The format below injects the active context into every record, so no call site has to
 * pass anything. That is what makes this cheap: ~600 places already pass a correlationId by
 * hand and keep working unchanged, and every other logger call in the codebase gains the
 * tenant for free.
 *
 * The rule that keeps it honest: an explicit field at the call site always wins. The caller
 * knows something the ambient context does not.
 */

import type { Logform } from 'winston'
import { contextFormat } from '@/observability/logContext'
import { runWithContext } from '@/observability/executionContext'

/** Runs a record through the format the way Winston does, and returns the result. */
const apply = (info: Partial<Logform.TransformableInfo>): Record<string, unknown> =>
  contextFormat().transform(info as Logform.TransformableInfo) as unknown as Record<string, unknown>

const fullContext = {
  correlationId: 'corr-1',
  source: 'http' as const,
  entrypoint: 'POST /api/v1/tpv/payments',
  venueId: 'venue-1',
  venueName: 'Testarudo Cafe',
  userId: 'user-1',
  role: 'WAITER',
  terminalSerial: 'AVQD-2841548624',
}

describe('logger context format', () => {
  it('injects the whole active context into the record', () => {
    runWithContext(fullContext, () => {
      expect(apply({ level: 'error', message: 'boom' })).toMatchObject({
        message: 'boom',
        correlationId: 'corr-1',
        source: 'http',
        entrypoint: 'POST /api/v1/tpv/payments',
        venueId: 'venue-1',
        venueName: 'Testarudo Cafe',
        userId: 'user-1',
        role: 'WAITER',
        terminalSerial: 'AVQD-2841548624',
      })
    })
  })

  it('🔴 carries the venue NAME, not just the cuid — that is what makes a line readable', () => {
    // The whole point: someone reading an alert must know which business it is without
    // running a query. `venueId` alone (`cms1qzg6o02jxi32bkm2ta66g`) tells a human nothing.
    runWithContext(fullContext, () => {
      expect(apply({ level: 'error', message: 'SOBREPAGO' }).venueName).toBe('Testarudo Cafe')
    })
  })

  it('omits venueName when it could not be resolved, rather than stamping a placeholder', () => {
    const { venueName: _dropped, ...withoutName } = fullContext
    runWithContext(withoutName, () => {
      const result = apply({ level: 'error', message: 'boom' })
      expect('venueName' in result).toBe(false)
      expect(result.venueId).toBe('venue-1')
    })
  })

  it('leaves the record untouched when there is no context', () => {
    const result = apply({ level: 'info', message: 'no context here' })
    expect(result.message).toBe('no context here')
    expect(result.correlationId).toBeUndefined()
    expect(result.venueId).toBeUndefined()
  })

  it('🔴 never overwrites a field the call site set explicitly', () => {
    runWithContext({ ...fullContext, venueId: 'venue-ambient' }, () => {
      const result = apply({ level: 'warn', message: 'explicit wins', venueId: 'venue-explicit' })
      expect(result.venueId).toBe('venue-explicit')
      // ...while still adding the fields the call site did not set.
      expect(result.correlationId).toBe('corr-1')
    })
  })

  it('omits tenant fields that the context does not have, instead of stamping undefined', () => {
    // A cron tick has no venue or user. Injecting `venueId: undefined` on every line would
    // make the output noisier than it was before.
    runWithContext({ correlationId: 'corr-job', source: 'job', entrypoint: 'money-integrity-watchdog' }, () => {
      const result = apply({ level: 'info', message: 'tick' })
      expect('venueId' in result).toBe(false)
      expect('userId' in result).toBe(false)
      expect('terminalSerial' in result).toBe(false)
      expect(result.source).toBe('job')
      expect(result.entrypoint).toBe('money-integrity-watchdog')
    })
  })

  it('preserves extra metadata the call site passed', () => {
    runWithContext(fullContext, () => {
      const result = apply({ level: 'error', message: 'failed', orderId: 'cmr123', durationMs: 42 })
      expect(result.orderId).toBe('cmr123')
      expect(result.durationMs).toBe(42)
      expect(result.venueId).toBe('venue-1')
    })
  })

  it('tags records from different sources so an investigation can filter by entry point', () => {
    const sources = ['http', 'job', 'rabbit', 'socket'] as const
    const seen = sources.map(source =>
      runWithContext({ correlationId: 'c', source, entrypoint: `${source}:x` }, () => apply({ level: 'info', message: 'm' }).source),
    )
    expect(seen).toEqual(['http', 'job', 'rabbit', 'socket'])
  })
})
