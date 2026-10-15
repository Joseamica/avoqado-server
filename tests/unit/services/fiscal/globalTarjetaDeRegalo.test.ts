/**
 * Factura global y tarjetas de regalo (spec §7): la cuenta de VENTA de tarjetas sale entera con un motivo propio («se factura al
 * usarla») y la cuenta de mercancía pagada con saldo entra normal, con la forma 01 del tender de sistema.
 */
import { Prisma } from '@prisma/client'
import { ORDER_SELECT, ticketParaGlobal } from '@/services/fiscal/cfdiGlobal.service'
import { MOTIVOS_DE_CONFIGURACION, MOTIVOS_DE_IVA, TEXTO_EXCLUSION_GLOBAL } from '@/services/fiscal/globalPorTratamiento'

const Dc = (n: number) => new Prisma.Decimal(n)
const renglonDeTarjeta = (id: string, total: number) => ({
  id,
  productId: null,
  giftCardId: `gc-${id}`,
  ivaTratamiento: 'NO_OBJETO',
  productName: 'Tarjeta de regalo',
  quantity: 1,
  unitPrice: Dc(total),
  discountAmount: Dc(0),
  taxAmount: Dc(0),
  total: Dc(total),
  weightQuantity: null,
  modifiers: [],
  orderPromotionId: null,
  isCortesia: false,
  product: null,
})
const renglonDe16 = (id: string, total: number) => ({
  id,
  productId: `p-${id}`,
  giftCardId: null,
  ivaTratamiento: null,
  productName: id,
  quantity: 1,
  unitPrice: Dc(total),
  discountAmount: Dc(0),
  taxAmount: Dc(0),
  total: Dc(total),
  weightQuantity: null,
  modifiers: [],
  orderPromotionId: null,
  isCortesia: false,
  product: { taxRate: Dc(0.16), objetoImp: '02', ivaTratamiento: 'IVA_16', satProductKey: '50000000', satUnitKey: 'H87' },
})
const ticket = (items: any[], payments: any[], importe = 500) => ({
  id: 'o1',
  orderNumber: 'ORD-1',
  subtotal: Dc(importe),
  taxAmount: Dc(0),
  total: Dc(importe),
  discountAmount: Dc(0),
  serviceChargeAmount: Dc(0),
  contratoDePrecio: 'IVA_INCLUIDO',
  orderDiscounts: [],
  payments,
  items,
})
const cobro = (amount: number, over: Record<string, unknown> = {}) => ({
  id: `pay-${amount}`,
  createdAt: new Date('2026-10-14T18:00:00Z'),
  method: 'CREDIT_CARD',
  tenderSatFormaPago: null,
  tenderTypeId: null,
  amount: Dc(amount),
  type: 'REGULAR',
  ...over,
})

describe('ticketParaGlobal · tarjetas de regalo', () => {
  it('🔴 la cuenta de VENTA de tarjetas sale con TARJETA_DE_REGALO aunque se cobró con IVA incluido (si no, entraría como MIXTA)', () => {
    expect(ticketParaGlobal(ticket([renglonDeTarjeta('a', 500)], [cobro(500)]) as any)).toEqual({
      ok: false,
      motivo: 'TARJETA_DE_REGALO',
      detalle: TEXTO_EXCLUSION_GLOBAL.TARJETA_DE_REGALO,
    })
  })

  it('el motivo gana a todos los demás, también a SIN_PAGAR', () => {
    expect(ticketParaGlobal(ticket([renglonDeTarjeta('a', 500), renglonDeTarjeta('b', 300)], [], 800) as any)).toMatchObject({
      ok: false,
      motivo: 'TARJETA_DE_REGALO',
    })
  })

  it('🔴 regresión: la mercancía pagada con saldo (OTHER, tender de sistema, forma 01) ENTRA, con forma 01', () => {
    const t = ticketParaGlobal(
      ticket(
        [renglonDe16('playera', 116)],
        [cobro(116, { method: 'OTHER', tenderSatFormaPago: '01', tenderTypeId: 'tender-gc' })],
        116,
      ) as any,
    )
    expect(t).toMatchObject({ ok: true, orden: { formaPago: '01', porTratamiento: { IVA_16: 11600 } } })
  })

  it('el texto existe, habla de usarla, y el motivo no es de IVA ni de configuración', () => {
    expect(TEXTO_EXCLUSION_GLOBAL.TARJETA_DE_REGALO).toMatch(/se factura cuando el cliente usa el saldo/i)
    expect(MOTIVOS_DE_IVA).not.toContain('TARJETA_DE_REGALO')
    expect(MOTIVOS_DE_CONFIGURACION as readonly string[]).not.toContain('TARJETA_DE_REGALO')
  })

  it('la captura lee la marca de cada renglón', () => {
    expect(ORDER_SELECT.items.select.giftCardId).toBe(true)
  })
})
