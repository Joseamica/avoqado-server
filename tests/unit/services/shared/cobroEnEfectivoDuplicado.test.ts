import { Decimal } from '@prisma/client/runtime/library'
import { cobroEnEfectivoSobreOrdenSaldada, type PagoPrevio } from '@/services/shared/cobroEnEfectivoDuplicado'

const ORDEN_CERO = { subtotal: new Decimal(0), discountAmount: null, serviceChargeAmount: null }
const ORDEN_100 = { subtotal: new Decimal(100), discountAmount: null, serviceChargeAmount: null }

function pago(id: string, amount: number, extra: Partial<PagoPrevio> = {}): PagoPrevio {
  return {
    id,
    amount: new Decimal(amount),
    tipAmount: new Decimal(0),
    type: 'REGULAR',
    method: 'CASH',
    createdAt: new Date('2026-09-04T00:18:08Z'),
    ...extra,
  }
}
const CANDIDATO_CASH = { method: 'CASH', status: 'COMPLETED', hasAreaTicketLines: false }

describe('cobroEnEfectivoSobreOrdenSaldada — la regla que separa un toque repetido de un cobro legítimo', () => {
  it('orden de $0 SIN cobros previos: el primer cobro de una línea gratis se registra (null)', () => {
    expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_CERO, [])).toBeNull()
  })

  it('orden de $0 con UN cobro previo en efectivo: el segundo es el toque repetido → devuelve el previo', () => {
    const previo = pago('pay-prev', 0)
    expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_CERO, [previo])).toBe(previo)
  })

  it('orden de $100 ya cubierta con $100 en efectivo: otro efectivo devuelve el previo', () => {
    const previo = pago('pay-prev', 100)
    expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_100, [previo])).toBe(previo)
  })

  it('partes iguales: $50 de $100 pagados, el segundo $50 en efectivo es legítimo (null)', () => {
    expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_100, [pago('p1', 50)])).toBeNull()
  })

  it('TARJETA sobre una orden saldada NUNCA se deduplica: el dinero ya se movió en el banco (null)', () => {
    const candidatoTarjeta = { method: 'CREDIT_CARD', status: 'COMPLETED', hasAreaTicketLines: false }
    expect(cobroEnEfectivoSobreOrdenSaldada(candidatoTarjeta, ORDEN_100, [pago('p1', 100, { method: 'CREDIT_CARD' })])).toBeNull()
  })

  it('tras un REEMBOLSO total, volver a cobrar en efectivo es legítimo (null)', () => {
    const cobro = pago('p1', 100)
    const reembolso = pago('r1', -100, { type: 'REFUND' })
    expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_100, [cobro, reembolso])).toBeNull()
  })

  it('con vales por área (areaTicketLines) no interviene: ese submódulo tiene su propio candado (null)', () => {
    const candidato = { method: 'CASH', status: 'COMPLETED', hasAreaTicketLines: true }
    expect(cobroEnEfectivoSobreOrdenSaldada(candidato, ORDEN_CERO, [pago('p1', 0)])).toBeNull()
  })

  it('un cobro que no es COMPLETED no se deduplica (null)', () => {
    const candidato = { method: 'CASH', status: 'PENDING', hasAreaTicketLines: false }
    expect(cobroEnEfectivoSobreOrdenSaldada(candidato, ORDEN_CERO, [pago('p1', 0)])).toBeNull()
  })

  it('devuelve el cobro en EFECTIVO más reciente, no un cobro con tarjeta de la misma orden', () => {
    const tarjeta = pago('tarjeta', 100, { method: 'CREDIT_CARD', createdAt: new Date('2026-09-04T00:18:10Z') })
    const efectivo = pago('efectivo', 0, { createdAt: new Date('2026-09-04T00:18:08Z') })
    expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_100, [tarjeta, efectivo])).toBe(efectivo)
  })

  // ── Regresión propia: un reembolso PARCIAL también reabre la puerta ─────────
  // Mismo razonamiento que el reembolso total. El saldo de ESTA regla es el del
  // diagnóstico —`total − cobrado + reembolsado`—, no el `isFullyPaid` de
  // `computeOrderBalance`, que por decisión del founder NO reabre saldo. Con
  // `isFullyPaid` esta orden se leería como saldada y un cobro real se perdería.
  it('tras un reembolso PARCIAL, cobrar de nuevo en efectivo es legítimo (null)', () => {
    const cobro = pago('p1', 100)
    const reembolso = pago('r1', -40, { type: 'REFUND' })
    expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_100, [cobro, reembolso])).toBeNull()
  })
})
