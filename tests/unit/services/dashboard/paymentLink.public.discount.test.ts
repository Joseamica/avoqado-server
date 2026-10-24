// Task 7 — respuesta pública de la liga: desglose del descuento, base viva y WhatsApp del negocio.
jest.mock('nanoid', () => ({ nanoid: jest.fn(() => 'abc12345') }))
import { getPaymentLinkByShortCode } from '../../../../src/services/dashboard/paymentLink.service'
import { prismaMock } from '../../../__helpers__/setup'
import { Decimal } from '@prisma/client/runtime/library'

const MANUAL_15 = { v: 1, origen: 'MANUAL', discountId: null, type: 'PERCENTAGE', value: 15, name: 'Buen Fin' }
const CATALOGO = { v: 1, origen: 'CATALOGO', discountId: 'cdisc00000000000000000001', type: 'PERCENTAGE', value: 10, name: 'Verano' }

function liga(over: Record<string, unknown> = {}) {
  return {
    id: 'cplink00000000000000000001',
    shortCode: 'abc12345',
    purpose: 'PAYMENT',
    title: 'Clase',
    description: null,
    imageUrl: null,
    amountType: 'FIXED',
    amount: new Decimal(1000),
    currency: 'MXN',
    status: 'ACTIVE',
    expiresAt: null,
    isReusable: true,
    paymentCount: 0,
    customFields: null,
    tippingConfig: null,
    redirectUrl: null,
    discount: null,
    items: [],
    venue: {
      id: 'v1',
      name: 'Mindform',
      slug: 'mindform',
      logo: null,
      primaryColor: null,
      secondaryColor: null,
      paymentLinkBranding: null,
      phone: '5512345678',
      timezone: 'America/Mexico_City',
    },
    ecommerceMerchant: { provider: { code: 'STRIPE_CONNECT' } },
    ...over,
  }
}
const pedir = async (over: Record<string, unknown> = {}) => {
  ;(prismaMock.paymentLink.findUnique as jest.Mock).mockResolvedValue(liga(over))
  return getPaymentLinkByShortCode('abc12345') as Promise<any>
}

describe('getPaymentLinkByShortCode — descuento', () => {
  it('sin descuento: discount null, baseAmount = amount, amount y WhatsApp del negocio', async () => {
    const r = await pedir()
    expect(r.discount).toBeNull()
    expect(r.baseAmount).toBe(1000)
    expect(r.amount).toEqual(new Decimal(1000))
    expect(r.venue.whatsappPhone).toBe('5512345678')
    expect(r.venue).not.toHaveProperty('phone')
    expect(r.venue).not.toHaveProperty('timezone')
  })

  it('whatsappPhone null si el teléfono está vacío', async () => {
    const r = await pedir({ venue: { ...liga().venue, phone: '  ' } })
    expect(r.venue.whatsappPhone).toBeNull()
  })

  it('fija 1000 −15 %: amount 150, disponible', async () => {
    const r = await pedir({ discount: MANUAL_15 })
    expect(r.discount).toMatchObject({
      name: 'Buen Fin', type: 'PERCENTAGE', value: 15, amount: 150, available: true, reason: null,
      minPurchaseAmount: null, maxDiscountAmount: null, validUntil: null,
    })
  })

  it('descuento del catálogo vencido: available false, reason VENCIDO, amount null', async () => {
    ;(prismaMock.discount.findUnique as jest.Mock).mockResolvedValue({
      active: true, validFrom: null, validUntil: new Date('2020-01-01T00:00:00Z'), daysOfWeek: [], timeFrom: null, timeUntil: null,
      minPurchaseAmount: new Decimal(500), maxDiscountAmount: null,
      scope: 'ORDER', type: 'PERCENTAGE', requiresApproval: false, isAutomatic: false, buyQuantity: null, getQuantity: null,
      getDiscountPercent: null, buyItemIds: [], getItemIds: [], maxTotalUses: null, maxUsesPerCustomer: null, customerGroupId: null,
    })
    const r = await pedir({ discount: CATALOGO })
    expect(r.discount).toMatchObject({ available: false, reason: 'VENCIDO', amount: null, minPurchaseAmount: 500, validUntil: '2020-01-01T00:00:00.000Z' })
  })

  it('importe abierto: baseAmount null, amount null, disponible por fecha/compat', async () => {
    const r = await pedir({ amountType: 'OPEN', amount: null, discount: MANUAL_15 })
    expect(r.baseAmount).toBeNull()
    expect(r.discount).toMatchObject({ amount: null, available: true, reason: null })
  })

  it('productos: baseAmount con precios vivos (misma suma que cobra)', async () => {
    const items = [{ id: 'i1', quantity: 2, product: { price: new Decimal(300) }, modifiers: [{ id: 'm1', quantity: 1, modifier: { price: new Decimal(50) } }] }]
    const r = await pedir({ purpose: 'ITEM', amountType: 'FIXED', amount: new Decimal(1), items, discount: MANUAL_15 })
    expect(r.baseAmount).toBe(700)
    expect(r.discount.amount).toBe(105)
  })
})
