import { PUBLIC_CANCELLATION_KEYS, toPublicCancellationPolicy } from '@/services/public/publicCancellationPolicy'

/**
 * `GET /public/venues/:slug/info` es anónimo. La política de cancelación sale con lista blanca:
 * lo que la clienta necesita para saber si recupera su crédito, nunca los cobros por no llegar
 * ni los ajustes internos.
 */
const CANCEL = {
  allowCustomerCancel: true,
  minHoursBeforeStart: 12,
  forfeitDeposit: true,
  noShowFeePercent: 50,
  creditRefundMode: 'TIME_BASED',
  creditFreeRefundHoursBefore: 24,
  creditLateRefundPercent: 0,
  creditNoShowRefund: false,
  allowCustomerReschedule: true,
} as const

describe('toPublicCancellationPolicy — lista blanca del payload anónimo', () => {
  it('entrega sólo la lista blanca, con sus valores', () => {
    expect(toPublicCancellationPolicy(CANCEL)).toEqual({
      allowCustomerCancel: true,
      minHoursBeforeStart: 12,
      creditRefundMode: 'TIME_BASED',
      creditFreeRefundHoursBefore: 24,
      creditLateRefundPercent: 0,
    })
  })

  it('🔴 no publica cobros por no llegar ni ajustes internos', () => {
    const p = toPublicCancellationPolicy(CANCEL)!
    for (const k of ['forfeitDeposit', 'noShowFeePercent', 'creditNoShowRefund', 'allowCustomerReschedule']) {
      expect(p).not.toHaveProperty(k)
    }
    expect(Object.keys(p).sort()).toEqual([...PUBLIC_CANCELLATION_KEYS].sort())
  })

  it('sin datos completos no inventa: null', () => {
    expect(toPublicCancellationPolicy(undefined)).toBeNull()
    expect(toPublicCancellationPolicy(null)).toBeNull()
    expect(toPublicCancellationPolicy({ minHoursBeforeStart: null })).toBeNull() // sin allowCustomerCancel
  })
})
