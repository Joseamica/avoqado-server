/**
 * Unit tests for the SIM custody state machine.
 *
 * These tests lock in the transition table from plan §8. They are DB-free
 * (no Prisma, no network) so they run fast and gate regressions in the
 * canonical transition rules.
 */

import { SerializedItemCustodyState } from '@prisma/client'
import { applyTransition } from '@/services/serialized-inventory/custody.service'
import { SimCustodyError } from '@/lib/sim-custody-error-codes'

type Action = Parameters<typeof applyTransition>[1]

describe('custody state machine — applyTransition', () => {
  describe('valid transitions (plan §8 matrix)', () => {
    const cases: Array<[SerializedItemCustodyState, Action, SerializedItemCustodyState]> = [
      ['ADMIN_HELD', 'ASSIGN_TO_SUPERVISOR', 'SUPERVISOR_HELD'],
      ['SUPERVISOR_HELD', 'ASSIGN_TO_PROMOTER', 'PROMOTER_PENDING'],
      ['PROMOTER_PENDING', 'ACCEPT', 'PROMOTER_HELD'],
      ['PROMOTER_PENDING', 'REJECT', 'PROMOTER_REJECTED'],
      ['PROMOTER_PENDING', 'COLLECT_FROM_PROMOTER', 'SUPERVISOR_HELD'],
      ['PROMOTER_HELD', 'COLLECT_FROM_PROMOTER', 'SUPERVISOR_HELD'],
      ['PROMOTER_REJECTED', 'COLLECT_FROM_PROMOTER', 'SUPERVISOR_HELD'],
      ['SUPERVISOR_HELD', 'COLLECT_FROM_SUPERVISOR', 'ADMIN_HELD'],
      ['PROMOTER_HELD', 'MARK_SOLD', 'SOLD'],
    ]

    it.each(cases)('%s + %s → %s', (from, action, to) => {
      expect(applyTransition(from, action)).toBe(to)
    })
  })

  describe('invalid transitions raise canonical errors', () => {
    it('SOLD is terminal: any action raises SIM_SOLD', () => {
      expect(() => applyTransition('SOLD', 'COLLECT_FROM_PROMOTER')).toThrow(SimCustodyError)
      try {
        applyTransition('SOLD', 'COLLECT_FROM_PROMOTER')
      } catch (err) {
        expect(err).toBeInstanceOf(SimCustodyError)
        expect((err as SimCustodyError).code).toBe('SIM_SOLD')
      }
    })

    it('collect-from-supervisor on a chain that has a promoter → HAS_DOWNSTREAM_CUSTODY', () => {
      const bad: SerializedItemCustodyState[] = ['PROMOTER_PENDING', 'PROMOTER_HELD', 'PROMOTER_REJECTED']
      for (const state of bad) {
        try {
          applyTransition(state, 'COLLECT_FROM_SUPERVISOR')
          fail(`Expected ${state} + COLLECT_FROM_SUPERVISOR to throw`)
        } catch (err) {
          expect((err as SimCustodyError).code).toBe('HAS_DOWNSTREAM_CUSTODY')
        }
      }
    })

    it('accepting from a non-pending state → INVALID_STATE', () => {
      try {
        applyTransition('SUPERVISOR_HELD', 'ACCEPT')
        fail('expected throw')
      } catch (err) {
        expect((err as SimCustodyError).code).toBe('INVALID_STATE')
      }
    })

    it('marking sold before acceptance → INVALID_STATE', () => {
      try {
        applyTransition('PROMOTER_PENDING', 'MARK_SOLD')
        fail('expected throw')
      } catch (err) {
        expect((err as SimCustodyError).code).toBe('INVALID_STATE')
      }
    })

    it('reassigning a supervisor on a non-admin state → INVALID_STATE', () => {
      try {
        applyTransition('SUPERVISOR_HELD', 'ASSIGN_TO_SUPERVISOR')
        fail('expected throw')
      } catch (err) {
        expect((err as SimCustodyError).code).toBe('INVALID_STATE')
      }
    })
  })

  describe('regression: every action has a deterministic happy-path output', () => {
    it('every action returns the expected new state when given a valid `from` state', () => {
      const actionsToCover: Array<{ action: Action; from: SerializedItemCustodyState; expected: SerializedItemCustodyState }> = [
        { action: 'ASSIGN_TO_SUPERVISOR', from: 'ADMIN_HELD', expected: 'SUPERVISOR_HELD' },
        { action: 'ASSIGN_TO_PROMOTER', from: 'SUPERVISOR_HELD', expected: 'PROMOTER_PENDING' },
        { action: 'ACCEPT', from: 'PROMOTER_PENDING', expected: 'PROMOTER_HELD' },
        { action: 'REJECT', from: 'PROMOTER_PENDING', expected: 'PROMOTER_REJECTED' },
        { action: 'COLLECT_FROM_PROMOTER', from: 'PROMOTER_HELD', expected: 'SUPERVISOR_HELD' },
        { action: 'COLLECT_FROM_SUPERVISOR', from: 'SUPERVISOR_HELD', expected: 'ADMIN_HELD' },
        { action: 'MARK_SOLD', from: 'PROMOTER_HELD', expected: 'SOLD' },
      ]
      for (const c of actionsToCover) {
        expect(applyTransition(c.from, c.action)).toBe(c.expected)
      }
    })
  })
})
