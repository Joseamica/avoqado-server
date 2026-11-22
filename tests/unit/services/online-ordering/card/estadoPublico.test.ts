// tests/unit/services/online-ordering/card/estadoPublico.test.ts
import { devolucionPublica } from '@/services/online-ordering/card/estadoPublico'

describe('devolucionPublica: por dónde le llegó el dinero a la clienta', () => {
  it('D670: una reversa cerrada «Ya se devolvió en Stripe» (CREDIT_CARD) llegó a su TARJETA, no a saldo a favor', () => {
    expect(devolucionPublica([{ status: 'RESOLVED', reversal: { resolvedMethod: 'CREDIT_CARD' } }])).toEqual({
      status: 'DONE',
      medio: 'TARJETA',
    })
  })

  it('las de siempre no cambian: efectivo, transferencia, saldo a favor (sin reversa) y revertida', () => {
    expect(devolucionPublica([{ status: 'RESOLVED', reversal: { resolvedMethod: 'CASH' } }])?.medio).toBe('EFECTIVO')
    expect(devolucionPublica([{ status: 'RESOLVED', reversal: { resolvedMethod: 'BANK_TRANSFER' } }])?.medio).toBe('TRANSFERENCIA')
    expect(devolucionPublica([{ status: 'RESOLVED', reversal: null }])?.medio).toBe('SALDO')
    expect(devolucionPublica([{ status: 'REVERSED', reversal: { resolvedMethod: null } }])).toEqual({
      status: 'REVERSED',
      medio: 'TARJETA',
    })
  })
})
