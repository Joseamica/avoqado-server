/**
 * Rappi 2b (diseño 2026-10-23, T6): cuánto falta cobrar de un pedido con repartidor propio en efectivo, por partes.
 * Pedido real DEV 881655210: venta 175 (Burger 140 + Envío 35), propina 20, tarifa de Rappi 10.
 */
import { Prisma } from '@prisma/client'
import { saldoDeCobroDeReparto } from '@/services/shared/orderBalance'

const d = (v: string | number) => new Prisma.Decimal(v)

const pedido = {
  subtotal: d(175),
  discountAmount: d(0),
  serviceChargeAmount: d(0),
  contratoDePrecio: 'IVA_INCLUIDO',
  taxAmount: d(0),
  status: 'CONFIRMED',
  thirdPartyCashDue: d(10),
  cashTipDue: d(20),
}

const enPesos = (r: ReturnType<typeof saldoDeCobroDeReparto>) =>
  r && [r.ventaPendiente.toFixed(2), r.propinaPendiente.toFixed(2), r.tercerosPendiente.toFixed(2), r.totalACobrar.toFixed(2)]

describe('saldoDeCobroDeReparto', () => {
  it('sin cobros: 175 de venta, 20 de propina, 10 de Rappi = 205', () => {
    expect(enPesos(saldoDeCobroDeReparto(pedido, []))).toEqual(['175.00', '20.00', '10.00', '205.00'])
  })

  it('cobrado completo {175, 20, 10}: no falta nada', () => {
    const pagos = [{ amount: d(175), tipAmount: d(20), thirdPartyCashAmount: d(10), type: 'REGULAR' }]
    expect(enPesos(saldoDeCobroDeReparto(pedido, pagos))).toEqual(['0.00', '0.00', '0.00', '0.00'])
  })

  it('abono {70, 20, 10}: faltan 105 de venta', () => {
    const pagos = [{ amount: d(70), tipAmount: d(20), thirdPartyCashAmount: d(10), type: 'REGULAR' }]
    expect(enPesos(saldoDeCobroDeReparto(pedido, pagos))).toEqual(['105.00', '0.00', '0.00', '105.00'])
  })

  it('abono que sólo cubrió 5 de Rappi: la propina sigue pendiente aunque `Order.tipAmount` ya se haya reescrito', () => {
    // `cashTipDue` es la fuente; el pedido no lleva `tipAmount` a propósito (cada cobro lo reescribe con lo cobrado).
    const pagos = [{ amount: d(0), tipAmount: d(0), thirdPartyCashAmount: d(5), type: 'REGULAR' }]
    expect(enPesos(saldoDeCobroDeReparto(pedido, pagos))).toEqual(['175.00', '20.00', '5.00', '200.00'])
  })

  it('una devolución no vuelve a pedir propina ni Rappi ya cobrados', () => {
    const pagos = [
      { amount: d(175), tipAmount: d(20), thirdPartyCashAmount: d(10), type: 'REGULAR' },
      { amount: d(-35), tipAmount: d(0), thirdPartyCashAmount: null, type: 'REFUND' },
    ]
    const r = saldoDeCobroDeReparto(pedido, pagos)!
    expect(r.propinaPendiente.toFixed(2)).toBe('0.00')
    expect(r.tercerosPendiente.toFixed(2)).toBe('0.00')
  })

  it('un pedido que no es de este carril (sin `thirdPartyCashDue`) devuelve null', () => {
    expect(saldoDeCobroDeReparto({ ...pedido, thirdPartyCashDue: null, cashTipDue: null }, [])).toBeNull()
  })
})
