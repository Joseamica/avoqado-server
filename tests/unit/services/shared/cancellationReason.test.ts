// tests/unit/services/shared/cancellationReason.test.ts
import { z } from 'zod'
import {
  CANCELLATION_REASONS,
  cancellationAuditData,
  cancellationFields,
  toStripeCancellationDetails,
} from '@/services/shared/cancellationReason'

const schema = z.object(cancellationFields)

describe('cancellation reason', () => {
  it.each([
    ['TOO_EXPENSIVE', 'too_expensive'],
    ['UNUSED', 'unused'],
    ['MISSING_FEATURES', 'missing_features'],
    ['TOO_COMPLEX', 'too_complex'],
    ['SWITCHED_SERVICE', 'switched_service'],
    ['OTHER', 'other'],
  ] as const)('maps %s to Stripe feedback %s', (reason, feedback) => {
    expect(toStripeCancellationDetails({ reason })).toEqual({ feedback })
  })

  it('a temporary closure is "unused" with the [temporal] prefix, with or without a comment', () => {
    expect(toStripeCancellationDetails({ reason: 'TEMPORARY', comment: 'Cerramos en agosto' })).toEqual({
      feedback: 'unused',
      comment: '[temporal] Cerramos en agosto',
    })
    expect(toStripeCancellationDetails({ reason: 'TEMPORARY' })).toEqual({ feedback: 'unused', comment: '[temporal]' })
  })

  it('a comment without a reason goes alone; nothing at all sends nothing', () => {
    expect(toStripeCancellationDetails({ comment: 'Sin motivo' })).toEqual({ comment: 'Sin motivo' })
    expect(toStripeCancellationDetails({})).toBeUndefined()
  })

  it('covers exactly the seven reasons of the spec', () => {
    expect(CANCELLATION_REASONS).toHaveLength(7)
  })

  it('the audit keeps our own reason and the raw comment, and omits what is absent', () => {
    expect(cancellationAuditData({ reason: 'TEMPORARY', comment: 'Cerramos' })).toEqual({ reason: 'TEMPORARY', comment: 'Cerramos' })
    expect(Object.keys(cancellationAuditData({}))).toEqual([])
  })

  it('validates only shape, in Spanish; trims and drops an empty comment', () => {
    expect(schema.safeParse({ reason: 'BORED' }).error?.issues[0].message).toBe('El motivo de cancelación no es válido.')
    expect(schema.safeParse({ comment: 'x'.repeat(501) }).error?.issues[0].message).toBe('El comentario admite hasta 500 caracteres.')
    expect(schema.parse({ comment: '   ' }).comment).toBeUndefined()
    expect(schema.parse({ reason: 'UNUSED', comment: '  poco uso  ' })).toEqual({ reason: 'UNUSED', comment: 'poco uso' })
  })
})
