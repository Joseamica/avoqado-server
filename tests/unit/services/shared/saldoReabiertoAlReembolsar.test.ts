/**
 * D19 (founder 10-nov «A»; nube 12-nov): ¿cuánto de un reembolso vuelve a deberse? Lo decide UNA vez quien escribe el
 * reembolso, con la cuenta bloqueada y sus cobros de ESE momento. Regla:
 *
 *   reabre ⟺ cuenta VIVA (no cancelada) · no CERRADA (PAID/REFUNDED) · y todavía debía con los cobros de antes
 *   importe reabierto = min(importe devuelto, importe cobrado neto)
 *   propina reabierta = min(propina devuelta, propina cobrada neta)
 *
 * Una devolución de producto sobre una venta cubierta o cerrada no reabre nada (regla del 18-ago).
 */
import { Prisma } from '@prisma/client'
import { saldoQueReabreElReembolso } from '@/services/shared/saldoReabiertoAlReembolsar'

const d = (v: string | number) => new Prisma.Decimal(v)

const cuenta = (over: Partial<{ subtotal: string; status: string; paymentStatus: string; taxAmount: string; contrato: string }> = {}) => ({
  subtotal: d(over.subtotal ?? '100.00'),
  discountAmount: d('0.00'),
  serviceChargeAmount: d('0.00'),
  contratoDePrecio: over.contrato ?? 'IVA_INCLUIDO',
  taxAmount: d(over.taxAmount ?? '0.00'),
  status: over.status ?? 'PENDING',
  paymentStatus: over.paymentStatus ?? 'PARTIAL',
})
const cobro = (amount: string, tip = '0.00') => ({
  amount: d(amount),
  tipAmount: d(tip),
  type: 'REGULAR',
  reopenedAmount: null,
  reopenedTipAmount: null,
})
const reembolso = (amount: string, tip = '0.00', reAmount: string | null = null, reTip: string | null = null) => ({
  amount: d(`-${amount}`),
  tipAmount: d(`-${tip}`),
  type: 'REFUND',
  reopenedAmount: reAmount == null ? null : d(reAmount),
  reopenedTipAmount: reTip == null ? null : d(reTip),
})
const decide = (order: ReturnType<typeof cuenta>, pagosAntes: any[], importe: string, propina = '0.00') => {
  const r = saldoQueReabreElReembolso({ order, pagosAntes, devueltoImporte: d(importe), devueltoPropina: d(propina) })
  return { importe: r.reopenedAmount.toString(), propina: r.reopenedTipAmount.toString(), reabre: r.reabre }
}

describe('saldoQueReabreElReembolso — D19', () => {
  it('🔴 cuenta $100 con abono $50 que se devuelve: reabre los $50', () => {
    expect(decide(cuenta(), [cobro('50.00')], '50.00')).toEqual({ importe: '50', propina: '0', reabre: true })
  })

  it('devolución parcial del abono: reabre sólo lo devuelto', () => {
    expect(decide(cuenta(), [cobro('50.00')], '20.00')).toEqual({ importe: '20', propina: '0', reabre: true })
  })

  it('la propina devuelta del abono también reabre, topada a la propina cobrada', () => {
    expect(decide(cuenta(), [cobro('50.00', '10.00')], '50.00', '10.00')).toEqual({ importe: '50', propina: '10', reabre: true })
  })

  it('cuenta que debía $10 ($90 de $100): devolver los $90 reabre $90', () => {
    expect(decide(cuenta(), [cobro('90.00')], '90.00')).toEqual({ importe: '90', propina: '0', reabre: true })
  })

  it('un segundo reembolso tras uno ya reabierto se topa en lo que queda cobrado neto', () => {
    // Abono $50; ya se devolvieron $30 que reabrieron $30 (quedan $20 netos). Se devuelven otros $30: reabre $20.
    expect(decide(cuenta(), [cobro('50.00'), reembolso('30.00', '0.00', '30.00', '0.00')], '30.00')).toEqual({
      importe: '20',
      propina: '0',
      reabre: true,
    })
  })

  it('IVA aparte: la cuenta de $100 + $16 con $100 cobrados todavía debía; devolverlos reabre $100', () => {
    expect(decide(cuenta({ contrato: 'IVA_APARTE', taxAmount: '16.00' }), [cobro('100.00')], '100.00')).toEqual({
      importe: '100',
      propina: '0',
      reabre: true,
    })
  })

  it('🔴 Rappi 2b (Codex plan r2 #4): venta en $0 por descuento del proveedor, propina pactada a medias; devolverla SÍ reabre', () => {
    // Pedido de $100 con descuento de $100 del proveedor, propina pactada $10 y tarifa de Rappi $20. Se cobraron $25: $20 a Rappi y
    // $5 a propina. El saldo común se ve «saldado» ($5 de propina contra $5 cobrados), pero faltan $5 de propina pactada.
    const order = { ...cuenta(), discountAmount: d('100.00'), thirdPartyCashDue: d('20.00'), cashTipDue: d('10.00') }
    const pagos = [{ ...cobro('0.00', '5.00'), thirdPartyCashAmount: d('20.00') }]
    const r = saldoQueReabreElReembolso({ order, pagosAntes: pagos, devueltoImporte: d('0.00'), devueltoPropina: d('5.00') })

    expect(r.reabre).toBe(true)
    expect(r.reopenedTipAmount.toString()).toBe('5')
    expect(r.reopenedAmount.toString()).toBe('0')
  })

  it('Rappi 2b con las tres partes cubiertas: devolver no reabre (devolución sobre lo ya saldado)', () => {
    const order = { ...cuenta(), discountAmount: d('100.00'), thirdPartyCashDue: d('20.00'), cashTipDue: d('10.00') }
    const pagos = [{ ...cobro('0.00', '10.00'), thirdPartyCashAmount: d('20.00') }]
    const r = saldoQueReabreElReembolso({ order, pagosAntes: pagos, devueltoImporte: d('0.00'), devueltoPropina: d('5.00') })

    expect(r.reabre).toBe(false)
  })

  describe('NO reabre (regla del 18-ago y cuentas que no deben)', () => {
    it('REGRESIÓN 18-ago: venta cerrada (PAID) que se reembolsa sigue cerrada', () => {
      expect(decide(cuenta({ paymentStatus: 'PAID' }), [cobro('100.00')], '100.00')).toEqual({ importe: '0', propina: '0', reabre: false })
    })

    it('venta ya REFUNDED tampoco', () => {
      expect(decide(cuenta({ paymentStatus: 'REFUNDED' }), [cobro('100.00')], '40.00')).toEqual({
        importe: '0',
        propina: '0',
        reabre: false,
      })
    })

    it('cuenta cubierta aunque no esté marcada PAID (cierre automático no permitido): devolución de producto, no reabre', () => {
      expect(decide(cuenta({ paymentStatus: 'PARTIAL' }), [cobro('100.00')], '30.00')).toEqual({
        importe: '0',
        propina: '0',
        reabre: false,
      })
    })

    it('cuenta sobrepagada: no reabre', () => {
      expect(decide(cuenta(), [cobro('120.00')], '20.00')).toEqual({ importe: '0', propina: '0', reabre: false })
    })

    it('cuenta CANCELADA con abono: devolverlo no la hace deber (se fue cancelada)', () => {
      expect(decide(cuenta({ status: 'CANCELLED' }), [cobro('50.00')], '50.00')).toEqual({ importe: '0', propina: '0', reabre: false })
    })

    it('cuenta BORRADA: tampoco', () => {
      expect(decide(cuenta({ status: 'DELETED' }), [cobro('50.00')], '50.00')).toEqual({ importe: '0', propina: '0', reabre: false })
    })

    it('sin cobros previos (nada que reabrir): 0', () => {
      expect(decide(cuenta(), [], '10.00')).toEqual({ importe: '0', propina: '0', reabre: false })
    })
  })
})
