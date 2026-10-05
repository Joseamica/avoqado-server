/**
 * Plan3b T4 — mobile money writers on an EXISTING order (order discount, split, split by seat, promotion, loyalty and
 * stamp redemptions) and the money written while `createOrderWithItems` creates a sale.
 *
 * Contract: canonical Order lock first (scoped to the ROUTE venue), every decision from the locked read, children and
 * totals on that SAME tx, audits only after commit. The tx double and the global client are DIFFERENT objects, so any
 * escape to the global client fails here instead of hiding behind a shared double.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import {
  applyOrderDiscount,
  createOrderWithItems,
  removeOrderDiscount,
  splitOrderBySeat,
  splitOrderItems,
} from '@/services/mobile/order.mobile.service'
import * as promotionService from '@/services/promotions/promotion.service'
import { redeemPointsToOrder } from '@/services/mobile/loyalty.mobile.service'
import * as stampService from '@/services/wallet/redeemStampReward.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { notifyCustomerPassUpdated } from '@/services/wallet/notifyPassUpdated.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

const ORDER = {
  id: 'order',
  venueId: 'venue',
  orderNumber: 'ORD-1',
  status: 'PENDING',
  paymentStatus: 'PENDING',
  subtotal: 150,
  discountAmount: 20,
  paidAmount: 7,
  tableId: 't1',
  covers: 2,
  servedById: 'staff',
  type: 'DINE_IN',
  shiftId: 'shift',
  contratoDePrecio: 'IVA_INCLUIDO',
  customerId: 'customer',
  items: [
    { id: 'i1', orderPromotionId: null, seat: 1 },
    { id: 'i2', orderPromotionId: null, seat: 2 },
  ],
  orderDiscounts: [],
  serviceCharges: [],
}
const PROMOTION = {
  id: 'promo',
  venueId: 'venue',
  name: 'Combo',
  type: 'BUNDLE',
  pricingMode: 'FIXED_TOTAL',
  priceCents: 9000,
  status: 'PUBLISHED',
  validFrom: null,
  validUntil: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  groups: [
    {
      id: 'g1',
      name: 'Plato',
      options: [
        {
          id: 'o1',
          productId: 'p1',
          quantity: 1,
          chargedQuantity: 1,
          priceDeltaCents: 0,
          product: { price: 100, venueId: 'venue', name: 'Plato', sku: null, category: null },
        },
      ],
    },
  ],
}
const promoParams = {
  venueId: 'venue',
  orderId: 'order',
  promotionId: 'promo',
  instanceId: 'instance',
  selections: [{ groupId: 'g1', optionId: 'o1' }],
  soldAt: new Date('2026-09-27T18:00:00Z'),
}
const CONFIG = {
  id: 'config',
  venueId: 'venue',
  active: true,
  minPointsRedeem: 100,
  redemptionRate: new Prisma.Decimal(0.01),
  pointsPerDollar: new Prisma.Decimal(1),
}
const REWARD = {
  id: 'rw',
  venueId: 'venue',
  customerId: 'customer',
  status: 'PENDING',
  rewardType: 'FIXED_AMOUNT',
  rewardValue: 50,
  rewardLabel: 'Premio',
  expiresAt: null,
}

let tx: any
let committed: boolean
const MODELS = [
  'order',
  'orderItem',
  'orderDiscount',
  'orderServiceCharge',
  'orderPromotion',
  'promotion',
  'venue',
  'discount',
  'customer',
  'loyaltyTransaction',
  'staffVenue',
  'stampReward',
  'shift',
]
const WRITES = ['create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany']

const writers = {
  applyDiscount: () => applyOrderDiscount('venue', 'order', 'disc', 'staff'),
  removeDiscount: () => removeOrderDiscount('venue', 'order', 'od', 'staff'),
  split: () => splitOrderItems('venue', 'order', ['i1'], 'staff'),
  splitBySeat: () => splitOrderBySeat('venue', 'order', 'staff'),
  applyPromotion: () => promotionService.applyPromotionToOrder(promoParams),
  removePromotion: () => promotionService.removePromotionFromOrder({ venueId: 'venue', orderId: 'order', orderPromotionId: 'op' }),
  redeemPoints: () => redeemPointsToOrder('venue', 'order', 'customer', 1000, 'staff'),
  redeemStamp: () => stampService.redeemStampReward('venue', 'order', 'rw', { staffId: 'staff' }),
}
type Writer = keyof typeof writers
const ALL = Object.keys(writers) as Writer[]
const AUDITED: Writer[] = ['applyDiscount', 'removeDiscount', 'split', 'splitBySeat', 'redeemPoints', 'redeemStamp']

/** remainingBalance of the recalculated Order: 150 of lines − fallback discount − locked paidAmount (7). */
const LOCKED_REMAINING: Record<Writer, number> = {
  applyDiscount: 143,
  removeDiscount: 143,
  split: 143,
  splitBySeat: 143,
  // Promotions keep the inherited discount (20) read under the lock as their fallback.
  applyPromotion: 123,
  removePromotion: 123,
  redeemPoints: 143,
  redeemStamp: 143,
}
const PAID_MESSAGE: Record<Writer, string> = {
  applyDiscount: 'No se puede descontar una orden ya pagada',
  removeDiscount: 'No se puede modificar una orden ya pagada',
  split: 'No se puede separar una cuenta ya pagada',
  splitBySeat: 'No se puede dividir una cuenta ya pagada',
  applyPromotion: 'A una cuenta ya pagada no se le pueden agregar promociones.',
  removePromotion: 'Esta cuenta ya se pagó: retira la promoción con un reembolso, no borrándola.',
  redeemPoints: 'No se puede modificar una orden ya pagada',
  redeemStamp: 'No se puede aplicar un premio a una cuenta ya pagada.',
}
const NOT_FOUND_MESSAGE: Record<Writer, string> = {
  applyDiscount: 'Order not found',
  removeDiscount: 'Order not found',
  split: 'Order not found',
  splitBySeat: 'Order not found',
  applyPromotion: 'No encontramos esa cuenta en este establecimiento.',
  removePromotion: 'No encontramos esa promoción en la cuenta.',
  redeemPoints: 'Orden no encontrada',
  redeemStamp: 'Orden no encontrada',
}

function model() {
  return Object.fromEntries(['findUnique', 'findFirst', 'findMany', ...WRITES].map(name => [name, jest.fn()])) as Record<string, jest.Mock>
}
function txCallOrders(except: jest.Mock[] = []): number[] {
  return MODELS.flatMap(name => Object.values(tx[name] as Record<string, jest.Mock>))
    .filter(fn => !except.includes(fn))
    .flatMap(fn => fn.mock.invocationCallOrder)
}
function txWrites(): string[] {
  return MODELS.flatMap(name => WRITES.filter(op => tx[name][op].mock.calls.length > 0).map(op => `${name}.${op}`))
}
function paidOrder() {
  tx.order.findFirst.mockResolvedValue({ ...ORDER, paymentStatus: 'PAID' })
  tx.orderPromotion.findFirst.mockResolvedValue({ id: 'op', order: { paymentStatus: 'PAID', discountAmount: 20, paidAmount: 150 } })
}

beforeEach(() => {
  jest.clearAllMocks()
  committed = false
  tx = { $queryRaw: jest.fn().mockResolvedValue([{ id: 'order' }]), ...Object.fromEntries(MODELS.map(name => [name, model()])) }
  tx.order.findFirst.mockResolvedValue({ ...ORDER })
  tx.order.create.mockResolvedValue({ id: 'child', orderNumber: 'ORD-2', version: 1 })
  tx.order.update.mockImplementation(async ({ data }: any) => ({
    subtotal: data.subtotal ?? 0,
    discountAmount: data.discountAmount ?? 0,
    serviceChargeAmount: data.serviceChargeAmount ?? 0,
    total: data.total ?? 0,
    version: 2,
  }))
  // Recalculation reads the lines; FREE_PRODUCT reads their unit prices — both through the tx.
  tx.orderItem.findMany.mockResolvedValue([
    { id: 'i1', total: 100, discountAmount: 0, orderPromotionId: null, unitPrice: 100 },
    { id: 'i2', total: 50, discountAmount: 0, orderPromotionId: null, unitPrice: 50 },
  ])
  tx.orderItem.updateMany.mockResolvedValue({ count: 1 })
  tx.orderItem.createMany.mockResolvedValue({ count: 1 })
  tx.orderItem.deleteMany.mockResolvedValue({ count: 1 })
  tx.orderDiscount.findMany.mockResolvedValue([])
  tx.orderDiscount.findFirst.mockImplementation(async ({ where }: any) =>
    where.id === 'od' ? { id: 'od', orderId: 'order', name: 'Recompensas', amount: 10, loyaltyTransactionId: 'lt' } : null,
  )
  tx.orderDiscount.create.mockResolvedValue({ id: 'od-new', name: 'Diez', amount: 15 })
  tx.orderServiceCharge.findMany.mockResolvedValue([])
  tx.orderPromotion.findUnique.mockResolvedValue(null)
  tx.orderPromotion.findFirst.mockResolvedValue({ id: 'op', order: { paymentStatus: 'PENDING', discountAmount: 20, paidAmount: 7 } })
  tx.orderPromotion.create.mockResolvedValue({ id: 'op-new' })
  tx.orderPromotion.updateMany.mockResolvedValue({ count: 0 })
  tx.promotion.findFirst.mockResolvedValue(PROMOTION)
  tx.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  tx.discount.findFirst.mockResolvedValue({
    id: 'disc',
    venueId: 'venue',
    name: 'Diez',
    type: 'PERCENTAGE',
    value: 10,
    scope: 'ORDER',
    active: true,
    validFrom: null,
    validUntil: null,
    maxTotalUses: null,
    currentUses: 0,
  })
  tx.customer.findFirst.mockResolvedValue({ id: 'customer', loyaltyPoints: 5000 })
  tx.customer.updateMany.mockResolvedValue({ count: 1 })
  tx.loyaltyTransaction.create.mockResolvedValue({ id: 'lt-new' })
  tx.loyaltyTransaction.findUnique.mockResolvedValue({ id: 'lt', customerId: 'customer', points: -1000, orderId: 'order' })
  tx.staffVenue.findUnique.mockResolvedValue({ id: 'sv' })
  tx.stampReward.findFirst.mockImplementation(async ({ where }: any) =>
    where.orderDiscountId ? { id: 'rw-od', customerId: 'customer', rewardLabel: 'Premio' } : { ...REWARD },
  )
  tx.stampReward.updateMany.mockResolvedValue({ count: 1 })
  tx.shift.findFirst.mockResolvedValue(null)

  prismaMock.$transaction.mockImplementation(async (callback: any) => {
    const result = await callback(tx)
    committed = true
    return result
  })
  // Venue configuration is not Order data: it may be read before the lock.
  prismaMock.loyaltyConfig.findUnique.mockResolvedValue(CONFIG)
  // The response's balance is read after commit.
  prismaMock.customer.findUnique.mockResolvedValue({ loyaltyPoints: 4000 })
  // Every Order/child/reward read or write on the GLOBAL client is an escape from the lock.
  for (const [name, ops] of Object.entries({
    order: ['findFirst', 'findUnique', 'update', 'updateMany', 'create'],
    orderItem: ['findMany', 'updateMany', 'createMany', 'deleteMany'],
    orderDiscount: ['findFirst', 'findMany', 'create', 'update', 'delete'],
    orderPromotion: ['findUnique', 'findFirst', 'create', 'delete', 'updateMany'],
    promotion: ['findFirst'],
    discount: ['findFirst'],
    customer: ['findFirst', 'updateMany', 'update'],
    loyaltyTransaction: ['create'],
    staffVenue: ['findUnique'],
    stampReward: ['findFirst', 'updateMany', 'update'],
  })) {
    for (const op of ops) prismaMock[name][op].mockRejectedValue(new Error(`GLOBAL ${name}.${op}`))
  }
  ;(logAction as jest.Mock).mockImplementation(() => {
    expect(committed).toBe(true)
  })
  ;(notifyCustomerPassUpdated as jest.Mock).mockImplementation(() => {
    expect(committed).toBe(true)
  })
})

describe('locked mobile writers', () => {
  it.each(ALL)('%s locks the route venue Order before any tx access and recalculates on that tx with locked paidAmount', async name => {
    await writers[name]()

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(committed).toBe(true)
    // Tagged template: [strings, ...values]. The split writers insert a child Order (Venue FK), so they take the Venue
    // KEY SHARE fence FIRST, like deleteVenue's Venue → Order order; then the Order lock on the ROUTE venue, never one
    // taken from the Order itself; then everything else.
    const raw = tx.$queryRaw.mock.calls
    const fenced = name === 'split' || name === 'splitBySeat'
    expect(raw.map((call: any[]) => call.slice(1))).toEqual(fenced ? [['venue'], ['order', 'venue']] : [['order', 'venue']])
    if (fenced) expect(raw[0][0].join('?')).toMatch(/FROM "Venue"\s+WHERE id = \?\s+FOR KEY SHARE/)
    expect(tx.$queryRaw.mock.invocationCallOrder[raw.length - 1]).toBeLessThan(Math.min(...txCallOrders()))
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order' },
        data: expect.objectContaining({ remainingBalance: LOCKED_REMAINING[name] }),
      }),
    )
  })

  it.each(ALL)('%s rejects PAID seen only by the locked read and writes nothing', async name => {
    paidOrder()

    await expect(writers[name]()).rejects.toThrow(PAID_MESSAGE[name])

    expect(committed).toBe(false)
    expect(txWrites()).toEqual([])
    expect(logAction).not.toHaveBeenCalled()
  })

  it.each(ALL)('%s treats an Order the lock cannot see (missing/other venue) as not found and writes nothing', async name => {
    tx.$queryRaw.mockResolvedValue([])

    await expect(writers[name]()).rejects.toMatchObject({ statusCode: 404, message: NOT_FOUND_MESSAGE[name] })

    expect(txWrites()).toEqual([])
  })

  it.each(AUDITED)('%s propagates a failed total write before commit and never audits it', async name => {
    tx.order.update.mockRejectedValue(new Error('total write failed'))

    await expect(writers[name]()).rejects.toThrow('total write failed')

    expect(committed).toBe(false)
    expect(logAction).not.toHaveBeenCalled()
    expect(notifyCustomerPassUpdated).not.toHaveBeenCalled()
  })
})

describe('writer-specific fresh decisions', () => {
  // Codex r1 P1: la cabecera genérica del doble ($20 sin ninguna fila) es la de una orden HISTÓRICA y gana antes su fila
  // «Descuento anterior» (ver el describe de abajo). Las pruebas que miran la fila del escritor usan una cuenta sana.
  const cuentaSana = () => tx.order.findFirst.mockResolvedValue({ ...ORDER, discountAmount: 0 })
  it('applyDiscount caps against the locked subtotal/discount and reads the catalog rule on the tx', async () => {
    tx.order.findFirst.mockResolvedValue({ ...ORDER, subtotal: 150, discountAmount: 145 })

    await applyOrderDiscount('venue', 'order', 'disc', 'staff')

    expect(tx.discount.findFirst).toHaveBeenCalledWith({ where: { id: 'disc', venueId: 'venue' } })
    // 10 % of 150 = 15, but only 150 − 145 = 5 is still discountable on the locked photo.
    expect(tx.orderDiscount.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: 5 }) }))
  })

  it('🔴 R6 antes/después: un 10 % del catálogo con tope de $5 no lo pasa desde el móvil, ni al aplicar ni al recalcular ($5; hoy $15)', async () => {
    cuentaSana()
    tx.discount.findFirst.mockResolvedValue({
      id: 'disc',
      venueId: 'venue',
      name: 'Diez',
      type: 'PERCENTAGE',
      value: 10,
      scope: 'ORDER',
      active: true,
      validFrom: null,
      validUntil: null,
      maxTotalUses: null,
      currentUses: 0,
      maxDiscountAmount: new Prisma.Decimal(5),
    })
    let creada: any = null
    tx.orderDiscount.create.mockImplementation(
      async ({ data }: any) => (creada = { id: 'od-new', createdAt: new Date(0), appliedToItemIds: [], ...data }),
    )
    tx.orderDiscount.findMany.mockImplementation(async () => (creada ? [creada] : []))
    await applyOrderDiscount('venue', 'order', 'disc', 'staff')
    expect(tx.orderDiscount.create.mock.calls[0][0].data).toMatchObject({ amount: 5, reparto: { alcance: 'CUENTA', tope: 5 } })
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({ where: { id: 'od-new' }, data: expect.objectContaining({ amount: 5 }) })
  })
  it('control — R6, venta sana: sin tope el % del móvil es el de hoy (10 % de $150 = $15)', async () => {
    cuentaSana()
    let creada: any = null
    tx.orderDiscount.create.mockImplementation(
      async ({ data }: any) => (creada = { id: 'od-new', createdAt: new Date(0), appliedToItemIds: [], ...data }),
    )
    tx.orderDiscount.findMany.mockImplementation(async () => (creada ? [creada] : []))
    await applyOrderDiscount('venue', 'order', 'disc', 'staff')
    expect(tx.orderDiscount.create.mock.calls[0][0].data).toMatchObject({ amount: 15 })
  })
  // Codex r1 (corrige el ruling anterior «tope 0 = sin tope»): un tope que no es nulo cuenta, incluido 0 — al aplicar y, viajando
  // en el reparto, al recalcular. Así ya lo hacían el cupón (Decimal(0) es verdadero) y el motor (lo mapea a 0).
  it('🔴 R6: un tope de $0 en el catálogo ES tope, como el cupón y el motor (10 % de $150 ⇒ $0; antes $15 y sin tope)', async () => {
    cuentaSana()
    tx.discount.findFirst.mockResolvedValue({
      id: 'disc',
      venueId: 'venue',
      name: 'Diez',
      type: 'PERCENTAGE',
      value: 10,
      scope: 'ORDER',
      active: true,
      validFrom: null,
      validUntil: null,
      maxTotalUses: null,
      currentUses: 0,
      maxDiscountAmount: new Prisma.Decimal(0),
    })
    let creada: any = null
    tx.orderDiscount.create.mockImplementation(
      async ({ data }: any) => (creada = { id: 'od-new', createdAt: new Date(0), appliedToItemIds: [], ...data }),
    )
    tx.orderDiscount.findMany.mockImplementation(async () => (creada ? [creada] : []))
    await applyOrderDiscount('venue', 'order', 'disc', 'staff')
    expect(tx.orderDiscount.create.mock.calls[0][0].data).toMatchObject({ amount: 0, reparto: { alcance: 'CUENTA', tope: 0 } })
  })

  /** B2: un P2028 al sincronizar repartos sale tal cual — nadie lo convierte en error de negocio (el reducer lo deja en RETRY). */
  it('applyOrderDiscount propaga el P2028 de la sincronización y no deja nada escrito', async () => {
    // Una fila re-derivable (% de cuenta): el recálculo de la misma tx la sincroniza, y esa escritura truena con P2028.
    tx.orderDiscount.findMany.mockResolvedValue([
      { id: 'od-new', type: 'PERCENTAGE', value: 10, amount: 15, appliedToItemIds: [], reparto: null, createdAt: new Date(0) },
    ])
    tx.orderDiscount.update.mockRejectedValue(Object.assign(new Error('Transaction API error'), { code: 'P2028' }))
    await expect(applyOrderDiscount('venue', 'order', 'disc', 'staff')).rejects.toMatchObject({ code: 'P2028' })
    expect(tx.orderDiscount.update).toHaveBeenCalled()
    expect(tx.order.update).not.toHaveBeenCalled()
    expect(committed).toBe(false)
    expect(logAction).not.toHaveBeenCalled()
  })

  it('removeDiscount refunds points and returns the stamp reward on the locked tx, after the Order lock', async () => {
    const result = await removeOrderDiscount('venue', 'order', 'od', 'staff')

    expect(result).toMatchObject({ total: 150 })
    const lock = tx.$queryRaw.mock.invocationCallOrder[0]
    expect(tx.customer.update).toHaveBeenCalledWith({ where: { id: 'customer' }, data: { loyaltyPoints: { increment: 1000 } } })
    expect(tx.customer.update.mock.invocationCallOrder[0]).toBeGreaterThan(lock)
    expect(tx.stampReward.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rw-od' }, data: expect.objectContaining({ status: 'PENDING' }) }),
    )
    expect(tx.stampReward.update.mock.invocationCallOrder[0]).toBeGreaterThan(lock)
    expect(tx.orderDiscount.delete).toHaveBeenCalledWith({ where: { id: 'od' } })
  })

  it('🔴 D16: quitar desde el móvil una fila con reducción de impuesto la devuelve a la orden, bajo el candado (hoy se perdía)', async () => {
    tx.orderDiscount.findFirst.mockResolvedValue({
      id: 'od',
      orderId: 'order',
      name: 'Motor',
      amount: 10,
      taxReduction: 1.6,
      loyaltyTransactionId: null,
      appliedToItemIds: [],
      reparto: null,
    })
    await removeOrderDiscount('venue', 'order', 'od', 'staff')
    const llamada = tx.order.update.mock.calls.findIndex(([a]: any) => a.data.taxAmount?.increment !== undefined)
    expect(llamada).toBeGreaterThanOrEqual(0)
    expect(tx.order.update.mock.calls[llamada][0].where).toEqual({ id: 'order' })
    expect(Number(tx.order.update.mock.calls[llamada][0].data.taxAmount.increment)).toBe(1.6)
    expect(tx.order.update.mock.invocationCallOrder[llamada]).toBeGreaterThan(tx.$queryRaw.mock.invocationCallOrder[0])
    expect(tx.orderDiscount.delete).toHaveBeenCalledWith({ where: { id: 'od' } })
  })

  it('control — sin reducción guardada quitar desde el móvil no toca el impuesto (regresión)', async () => {
    await removeOrderDiscount('venue', 'order', 'od', 'staff')
    expect(tx.order.update.mock.calls.some(([a]: any) => a.data.taxAmount !== undefined)).toBe(false)
  })

  it('🔴 P4: quitar la promoción retira el premio dirigido a su línea y lo devuelve (hoy seguía restando sobre lo demás)', async () => {
    tx.orderItem.findMany.mockImplementation(async ({ where }: any) => {
      if (where.orderPromotionId) return [{ id: 'combo' }]
      if (where.id) return [{ id: 'combo', appliedDiscountId: null, isCortesia: false, discountAmount: 10 }]
      return [{ id: 'i1', total: 100, discountAmount: 0, orderPromotionId: null, unitPrice: 100, taxAmount: 0 }]
    })
    const premio = {
      id: 'premio',
      orderId: 'order',
      name: 'Café gratis',
      type: 'FIXED_AMOUNT',
      value: 90,
      amount: 90,
      taxReduction: 0,
      loyaltyTransactionId: null,
      appliedToItemIds: [],
      createdAt: new Date(0),
      reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones: { combo: 9000 } },
    }
    // R7-1: dos lecturas de filas antes del recálculo — `conservarDescuentoHistorico` y el recorte — y las dos ven el premio.
    tx.orderDiscount.findMany.mockResolvedValueOnce([premio]).mockResolvedValueOnce([premio]).mockResolvedValue([])
    tx.stampReward.findFirst.mockResolvedValue({ id: 'rw-premio', customerId: 'customer', rewardLabel: 'Café gratis' })

    await promotionService.removePromotionFromOrder({ venueId: 'venue', orderId: 'order', orderPromotionId: 'op' })

    // La cabecera del doble ($20) no pasa de su fila de $90: nada que conservar.
    expect(tx.orderDiscount.create).not.toHaveBeenCalled()
    expect(tx.orderDiscount.delete).toHaveBeenCalledWith({ where: { id: 'premio' } })
    expect(tx.stampReward.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rw-premio' }, data: expect.objectContaining({ status: 'PENDING' }) }),
    )
    expect(tx.orderDiscount.delete.mock.invocationCallOrder[0]).toBeLessThan(tx.orderItem.deleteMany.mock.invocationCallOrder[0])
    expect(tx.orderDiscount.delete.mock.invocationCallOrder[0]).toBeGreaterThan(tx.$queryRaw.mock.invocationCallOrder[0])
    // Importes y saldo (Codex r2): sin el premio, el café de $100 se cobra completo; lo cobrado en el doble es $7.
    // Hoy: el premio de $90 seguía en la cabecera y la cuenta quedaba en $10 (saldo $3).
    expect(tx.order.update.mock.calls.at(-1)[0].data).toMatchObject({ subtotal: 100, discountAmount: 0, total: 100, remainingBalance: 93 })
    // Una bitácora DISCOUNT_REMOVED por fila retirada, después del commit.
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'venue',
        action: 'DISCOUNT_REMOVED',
        entity: 'Order',
        entityId: 'order',
        data: expect.objectContaining({ orderDiscountId: 'premio', motivo: 'promocion-retirada', stampRewardReturned: 'rw-premio' }),
      }),
    )
  })

  it('split decides "at least one item stays" from the locked lines', async () => {
    tx.order.findFirst.mockResolvedValue({ ...ORDER, items: [{ id: 'i1', orderPromotionId: null, seat: 1 }] })

    await expect(splitOrderItems('venue', 'order', ['i1'], 'staff')).rejects.toThrow(
      'Debe quedar al menos un artículo en la cuenta original',
    )
    expect(txWrites()).toEqual([])
  })

  it('split moves a complete combo and its instance using the locked lines', async () => {
    tx.order.findFirst.mockResolvedValue({
      ...ORDER,
      items: [
        { id: 'c1', orderPromotionId: 'op1', seat: null },
        { id: 'c2', orderPromotionId: 'op1', seat: null },
        { id: 'n1', orderPromotionId: null, seat: null },
      ],
    })

    await expect(splitOrderItems('venue', 'order', ['c1'], 'staff')).rejects.toThrow(/completa/)
    await splitOrderItems('venue', 'order', ['c1', 'c2'], 'staff')

    expect(tx.orderItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1', 'c2'] }, orderId: 'order' },
      data: { orderId: 'child' },
    })
    expect(tx.orderPromotion.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['op1'] }, orderId: 'order' },
      data: { orderId: 'child' },
    })
  })

  it('splitBySeat groups the locked seats', async () => {
    tx.order.findFirst.mockResolvedValue({
      ...ORDER,
      items: [
        { id: 'i1', orderPromotionId: null, seat: 1 },
        { id: 'i2', orderPromotionId: null, seat: 2 },
        { id: 'i3', orderPromotionId: null, seat: 3 },
      ],
    })

    const result = await splitOrderBySeat('venue', 'order', 'staff')

    expect(tx.order.create).toHaveBeenCalledTimes(2)
    expect(result.created.map(c => c.seat)).toEqual([2, 3])
    expect(tx.orderItem.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['i3'] }, orderId: 'order' }, data: { orderId: 'child' } })
  })

  it('applyPromotion answers a replayed instance from the locked read, before the PAID guard, writing nothing', async () => {
    tx.orderPromotion.findUnique.mockResolvedValue({ id: 'op-prev', netCents: 9000 })
    paidOrder()

    await expect(promotionService.applyPromotionToOrder(promoParams)).resolves.toEqual({
      orderPromotionId: 'op-prev',
      netCents: 9000,
      created: false,
    })
    expect(tx.orderPromotion.findUnique.mock.invocationCallOrder[0]).toBeGreaterThan(tx.$queryRaw.mock.invocationCallOrder[0])
    expect(txWrites()).toEqual([])
  })

  it('applyPromotion with a caller tx opens no transaction and does every read and write on that tx', async () => {
    const result = await promotionService.applyPromotionToOrder(promoParams, tx)

    expect(result).toEqual({ orderPromotionId: 'op-new', netCents: 9000, created: true })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(tx.orderPromotion.create).toHaveBeenCalledTimes(1)
    expect(tx.orderItem.createMany).toHaveBeenCalledTimes(1)
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ discountAmount: 20 }) }))
  })

  it('applyPromotion with a caller tx rethrows a unique violation without querying a winner on the global client', async () => {
    const unique = Object.assign(new Error('unique'), { code: 'P2002' })
    tx.orderPromotion.create.mockRejectedValue(unique)

    await expect(promotionService.applyPromotionToOrder(promoParams, tx)).rejects.toBe(unique)
    expect(prismaMock.orderPromotion.findUnique).not.toHaveBeenCalled()
  })

  it('redeemPoints caps from the locked base and burns with the customer CAS after the Order lock', async () => {
    tx.order.findFirst.mockResolvedValue({ ...ORDER, subtotal: 25, discountAmount: 20 })

    const result = await redeemPointsToOrder('venue', 'order', 'customer', 1000, 'staff')

    // 1000 points × 0.01 = 10, but the locked base is 25 − 20 = 5 → only 500 points burn.
    expect(result).toMatchObject({ pointsRedeemed: 500, discountAmount: 5, newBalance: 4000 })
    expect(tx.customer.updateMany).toHaveBeenCalledWith({
      where: { id: 'customer', loyaltyPoints: { gte: 500 } },
      data: { loyaltyPoints: { decrement: 500 } },
    })
    expect(tx.customer.updateMany.mock.invocationCallOrder[0]).toBeGreaterThan(tx.$queryRaw.mock.invocationCallOrder[0])
    expect(tx.loyaltyTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ points: -500, createdById: 'sv' }) }),
    )
    expect(tx.staffVenue.findUnique).toHaveBeenCalled()
  })

  it('redeemPoints losing the customer CAS creates no discount and no totals', async () => {
    tx.customer.updateMany.mockResolvedValue({ count: 0 })

    await expect(redeemPointsToOrder('venue', 'order', 'customer', 1000, 'staff')).rejects.toThrow(
      'Puntos insuficientes (otro canje se procesó al mismo tiempo)',
    )
    expect(tx.orderDiscount.create).not.toHaveBeenCalled()
    expect(tx.order.update).not.toHaveBeenCalled()
  })

  it('redeemStamp FREE_PRODUCT gives one piece of the LOCKED line that gives the customer the most (P11) and burns after the Order lock', async () => {
    tx.stampReward.findFirst.mockResolvedValue({ ...REWARD, rewardType: 'FREE_PRODUCT', rewardValue: null })

    const result = await stampService.redeemStampReward('venue', 'order', 'rw', { staffId: 'staff' })

    // Locked lines are 100 and 50; the base is 150 − 20 = 130, so the whole 100 is given.
    expect(result.discountAmount).toBe(100)
    // B2 (P11): lee los renglones con lo que hace falta para elegir y topar el premio, no sólo su precio.
    expect(tx.orderItem.findMany).toHaveBeenCalledWith({
      where: { orderId: 'order' },
      select: {
        id: true,
        total: true,
        discountAmount: true,
        orderPromotionId: true,
        isCortesia: true,
        taxAmount: true,
        productId: true,
        product: { select: { categoryId: true } },
        unitPrice: true,
      },
    })
    expect(tx.stampReward.updateMany.mock.invocationCallOrder[0]).toBeGreaterThan(tx.$queryRaw.mock.invocationCallOrder[0])
    expect(tx.stampReward.update).toHaveBeenCalledWith({ where: { id: 'rw' }, data: { orderDiscountId: 'od-new' } })
  })

  it('redeemStamp losing the reward CAS creates no discount and no totals', async () => {
    tx.stampReward.updateMany.mockResolvedValue({ count: 0 })

    await expect(stampService.redeemStampReward('venue', 'order', 'rw')).rejects.toThrow('Este premio ya fue canjeado.')
    expect(tx.orderDiscount.create).not.toHaveBeenCalled()
    expect(tx.order.update).not.toHaveBeenCalled()
  })

  it('redeemPoints crea la fila de CUENTA con promociones; el recálculo de la misma tx la reparte', async () => {
    await redeemPointsToOrder('venue', 'order', 'customer', 1000, 'staff')
    expect(tx.orderDiscount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        loyaltyTransactionId: 'lt-new',
        reparto: { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: {} },
      }),
    })
  })
  it('redeemStamp FREE_PRODUCT: la fila va DIRIGIDA al renglón premiado', async () => {
    cuentaSana()
    tx.stampReward.findFirst.mockResolvedValue({ ...REWARD, rewardType: 'FREE_PRODUCT', rewardValue: null })
    await stampService.redeemStampReward('venue', 'order', 'rw', { staffId: 'staff' })
    expect(tx.orderDiscount.create.mock.calls[0][0].data.reparto).toEqual({
      v: 1,
      alcance: 'DIRIGIDO',
      conPromociones: null,
      espejo: false,
      renglones: { i1: 10000 },
    })
  })
  it('redeemStamp FREE_PRODUCT con empate de precio: premia el renglón de id menor, importe de hoy', async () => {
    cuentaSana()
    tx.stampReward.findFirst.mockResolvedValue({ ...REWARD, rewardType: 'FREE_PRODUCT', rewardValue: null })
    tx.orderItem.findMany.mockResolvedValue([
      { id: 'zz', total: 50, discountAmount: 0, orderPromotionId: null, unitPrice: 50 },
      { id: 'aa', total: 50, discountAmount: 0, orderPromotionId: null, unitPrice: 50 },
    ])
    expect((await stampService.redeemStampReward('venue', 'order', 'rw', { staffId: 'staff' })).discountAmount).toBe(50)
    expect(tx.orderDiscount.create.mock.calls[0][0].data.reparto).toMatchObject({ alcance: 'DIRIGIDO', renglones: { aa: 5000 } })
  })
})

describe('descuento histórico de cabecera (Codex r1 P1)', () => {
  // El doble genérico ES una orden histórica: $20 de cabecera y ninguna fila. Antes de su propia fila, cada escritor que crea
  // una sobre la orden congela esos $20 en una fila FIJA sin reparto, con el tx y después del candado.
  it.each(['applyDiscount', 'redeemPoints', 'redeemStamp'] as const)(
    '🔴 %s congela los $20 históricos en su fila antes de crear la suya',
    async name => {
      await writers[name]()
      const creadas = tx.orderDiscount.create.mock.calls.map((c: any) => c[0].data)
      expect(creadas).toHaveLength(2)
      expect(creadas[0]).toMatchObject({ orderId: 'order', type: 'FIXED_AMOUNT', name: 'Descuento anterior', isManual: true })
      expect([Number(creadas[0].amount), creadas[0].reparto]).toEqual([20, undefined])
      expect(creadas[1].name).not.toBe('Descuento anterior')
      expect(tx.orderDiscount.create.mock.invocationCallOrder[0]).toBeGreaterThan(tx.$queryRaw.mock.invocationCallOrder[0])
    },
  )
  it('control — con la cabecera igual a sus filas no hay fila de descuento anterior', async () => {
    tx.orderDiscount.findMany.mockResolvedValue([{ id: 'od-20', type: 'FIXED_AMOUNT', value: 20, amount: 20, appliedToItemIds: [] }])
    await writers.applyDiscount()
    expect(tx.orderDiscount.create.mock.calls.map((c: any) => c[0].data.name)).toEqual(['Diez'])
  })
})

describe('P11 — el premio «producto gratis» regala UNA pieza del artículo que más le regala al cliente', () => {
  const gratis = () => tx.stampReward.findFirst.mockResolvedValue({ ...REWARD, rewardType: 'FREE_PRODUCT', rewardValue: null })
  // V1 (Codex r3): cada escenario de P11 trae una cuenta COHERENTE —subtotal = Σ renglones, descuento = Σ filas, sin pagos—,
  // porque el servicio de hoy ya topa el premio a `subtotal − descuento` (`redeemStampReward.service.ts:118`): con la cabecera
  // genérica del doble (150 / 20) los «hoy» de v3 no eran los de verdad. Las filas viven en un arreglo: la que crea el canje
  // entra al `findMany` del recálculo y se pueden afirmar cabecera, total y saldo.
  function cuentaCoherente(renglones: any[], previas: any[] = []) {
    const filas = previas.map(f => ({ ...f }))
    const subtotal = renglones.reduce((s, r) => s + r.total, 0)
    const descuento = filas.reduce((s, f) => s + Number(f.amount), 0)
    tx.order.findFirst.mockResolvedValue({ ...ORDER, subtotal, discountAmount: descuento, paidAmount: 0 })
    tx.orderItem.findMany.mockResolvedValue(renglones)
    tx.orderDiscount.findMany.mockImplementation(async () => filas.map(f => ({ ...f })))
    tx.orderDiscount.create.mockImplementation(async ({ data }: any) => {
      const fila = {
        id: 'od-new',
        createdAt: new Date(1),
        appliedToItemIds: [],
        discountId: null,
        isComp: false,
        ...data,
        value: Number(data.value),
        amount: Number(data.amount),
      }
      filas.push(fila)
      return fila
    })
    tx.orderDiscount.update.mockImplementation(async ({ where, data }: any) => Object.assign(filas.find(f => f.id === where.id)!, data))
  }
  const R = (id: string, total: number, unitPrice: number, extra: Record<string, unknown> = {}) => ({
    id,
    total,
    unitPrice,
    discountAmount: 0,
    orderPromotionId: null,
    isCortesia: false,
    taxAmount: 0,
    quantity: 1,
    ...extra,
  })
  const previaDirigida = (id: string, renglon: string, pesos: number) => ({
    id,
    type: 'FIXED_AMOUNT',
    value: pesos,
    amount: pesos,
    taxReduction: 0,
    appliedToItemIds: [],
    createdAt: new Date(0),
    reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones: { [renglon]: pesos * 100 } },
  })
  const previaDeCuenta = (id: string, pesos: number, renglones: Record<string, number>) => ({
    id,
    type: 'FIXED_AMOUNT',
    value: pesos,
    amount: pesos,
    taxReduction: 0,
    appliedToItemIds: [],
    createdAt: new Date(0),
    reparto: { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones },
  })
  const canjear = () => stampService.redeemStampReward('venue', 'order', 'rw', { staffId: 'staff' })
  const cabeceraEscrita = () => tx.order.update.mock.calls.at(-1)[0].data

  it('🔴 P11 antes/después: cortesía del móvil de $200 + $100 + $50 ⇒ premio $100, cuenta $50 (hoy $150 y la cuenta en $0)', async () => {
    gratis()
    cuentaCoherente([R('cort', 0, 200, { discountAmount: 200, isCortesia: true }), R('b', 100, 100), R('c', 50, 50)]) // subtotal 150
    // Hoy: el `unitPrice` más alto (la cortesía, 200) topado a la base 150 ⇒ $150.
    expect((await canjear()).discountAmount).toBe(100)
    expect(tx.orderDiscount.create.mock.calls[0][0].data.reparto).toMatchObject({ alcance: 'DIRIGIDO', renglones: { b: 10000 } })
    expect(cabeceraEscrita()).toMatchObject({ subtotal: 150, discountAmount: 100, total: 50, remainingBalance: 50 })
  })
  it('🔴 P11 antes/después: un artículo por peso ($100/kg que vale $10) + uno de $50 ⇒ premio $50, cuenta $10 (hoy $60 y $0)', async () => {
    gratis()
    cuentaCoherente([R('kilo', 10, 100), R('b', 50, 50)]) // subtotal 60
    // Hoy: el `unitPrice` del kilo (100) topado a la base 60 ⇒ $60.
    expect((await canjear()).discountAmount).toBe(50)
    expect(tx.orderDiscount.create.mock.calls[0][0].data.reparto).toMatchObject({ renglones: { b: 5000 } })
    expect(cabeceraEscrita()).toMatchObject({ subtotal: 60, discountAmount: 50, total: 10, remainingBalance: 10 })
  })
  it('🔴 P11 antes/después: A ($100) ya trae $70 de otro descuento dirigido y B vale $50 ⇒ premio $50 en B, cuenta $30 (hoy $80 y $0)', async () => {
    gratis()
    cuentaCoherente([R('a', 100, 100), R('b', 50, 50)], [previaDirigida('previo', 'a', 70)]) // subtotal 150, descuento 70
    // Hoy: el `unitPrice` de A (100) topado a la base 150 − 70 = 80 ⇒ $80. A sólo tiene $30 disponibles; B, $50.
    expect((await canjear()).discountAmount).toBe(50)
    expect(tx.orderDiscount.create.mock.calls[0][0].data.reparto).toMatchObject({ alcance: 'DIRIGIDO', renglones: { b: 5000 } })
    expect(cabeceraEscrita()).toMatchObject({ subtotal: 150, discountAmount: 120, total: 30, remainingBalance: 30 })
  })
  it('control — P11: UNA pieza aunque el renglón traiga tres ($50, igual que hoy; cuenta $100)', async () => {
    gratis()
    cuentaCoherente([R('b', 150, 50, { quantity: 3 })])
    expect((await canjear()).discountAmount).toBe(50)
    expect(cabeceraEscrita()).toMatchObject({ subtotal: 150, discountAmount: 50, total: 100, remainingBalance: 100 })
  })
  it('control — P11, descuento de cuenta primero y premio después: $100 en A como hoy, y los $10 de cuenta se re-reparten enteros en B', async () => {
    gratis()
    // A y B de $100; un descuento de CUENTA de $10 ya repartido 5/5. Una fila de cuenta se re-reparte DESPUÉS de las dirigidas
    // (pasos 3-4 del cálculo canónico): no le quita lugar al premio. Hoy: `unitPrice` 100 topado a la base 200 − 10 = 190 ⇒ $100.
    cuentaCoherente([R('a', 100, 100), R('b', 100, 100)], [previaDeCuenta('cuenta', 10, { a: 500, b: 500 })])
    expect((await canjear()).discountAmount).toBe(100)
    expect(tx.orderDiscount.create.mock.calls[0][0].data.reparto).toMatchObject({ alcance: 'DIRIGIDO', renglones: { a: 10000 } })
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'cuenta' },
      data: { reparto: expect.objectContaining({ alcance: 'CUENTA', renglones: { b: 1000 } }) },
    })
    expect(cabeceraEscrita()).toMatchObject({ subtotal: 200, discountAmount: 110, total: 90, remainingBalance: 90 })
  })
  it('control — P11: un único artículo con $30 disponibles da $30, igual que hoy (cuenta $0)', async () => {
    gratis()
    cuentaCoherente([R('a', 100, 100)], [previaDirigida('previo', 'a', 70)]) // subtotal 100, descuento 70: la base de hoy ya es 30
    expect((await canjear()).discountAmount).toBe(30)
    expect(tx.orderDiscount.create.mock.calls[0][0].data.reparto).toMatchObject({ renglones: { a: 3000 } })
    expect(cabeceraEscrita()).toMatchObject({ subtotal: 100, discountAmount: 100, total: 0, remainingBalance: 0 })
  })
})

describe('createOrderWithItems writes the sale money inside its creation transaction', () => {
  const CREATED = {
    id: 'order-new',
    orderNumber: 'ORD-9',
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    type: 'DINE_IN',
    source: 'AVOQADO_IOS',
    subtotal: new Prisma.Decimal(100),
    discountAmount: new Prisma.Decimal(20),
    taxAmount: new Prisma.Decimal(0),
    total: new Prisma.Decimal(85),
    createdAt: new Date('2026-09-27T18:00:00Z'),
    items: [{ id: 'line', productId: 'p1', productName: 'Plato', quantity: 1, unitPrice: 100, total: 100, modifiers: [] }],
    promotions: [],
  }
  const input = {
    staffId: 'staff',
    items: [{ productId: 'p1', quantity: 1 }, { promotionRef: { promotionId: 'promo', promotionInstanceId: 'uuid-1', selections: [] } }],
    discount: 2000,
    tip: 500,
  } as any
  let apply: jest.SpyInstance
  let committedAtApply: boolean[]
  let creadas: any[]

  beforeEach(() => {
    committedAtApply = []
    creadas = []
    tx.orderDiscount.create.mockImplementation(async ({ data }: any) => {
      const f = { id: `od-${creadas.length + 1}`, createdAt: new Date(0), appliedToItemIds: [], ...data }
      creadas.push(f)
      return f
    })
    tx.orderDiscount.findMany.mockImplementation(async () => creadas)
    prismaMock.staffVenue.findFirst.mockResolvedValue({ staffId: 'staff' })
    prismaMock.product.findMany.mockResolvedValue([
      {
        id: 'p1',
        name: 'Plato',
        price: new Prisma.Decimal(100),
        sku: 'P1',
        categoryId: 'c1',
        soldByWeight: false,
        category: { name: 'Comida' },
      },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
    tx.order.create.mockResolvedValue(CREATED)
    tx.order.findFirst.mockResolvedValue({ subtotal: new Prisma.Decimal(190), serviceChargeAmount: new Prisma.Decimal(0), paidAmount: 0 })
    tx.order.update.mockImplementation(async ({ data }: any) => ({ ...CREATED, ...data }))
    apply = jest.spyOn(promotionService, 'applyPromotionToOrder').mockImplementation(async () => {
      committedAtApply.push(committed)
      return { orderPromotionId: 'op', netCents: 9000, created: true }
    })
  })
  afterEach(() => apply.mockRestore())

  it('applies the promotion with the creation tx and reaffirms tip and order discount from that tx before commit', async () => {
    tx.orderItem.findMany.mockResolvedValue([
      { id: 'line', total: 100, discountAmount: 0, orderPromotionId: null },
      { id: 'combo', total: 90, discountAmount: 10, orderPromotionId: 'op' },
    ])
    const result = await createOrderWithItems('venue', input)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'venue', orderId: 'order-new', instanceId: 'uuid-1' }), tx)
    expect(committedAtApply).toEqual([false])
    // 190 with the combo − 20 order discount + 5 tip = 175 — the same arithmetic as before, now on the private order.
    expect(tx.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'order-new', venueId: 'venue' } }))
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-new' },
        data: expect.objectContaining({
          discountAmount: new Prisma.Decimal(20),
          total: new Prisma.Decimal(175),
          remainingBalance: new Prisma.Decimal(175),
        }),
      }),
    )
    expect(result.total).toBe(175)
    expect(tx.orderDiscount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orderId: 'order-new', type: 'FIXED_AMOUNT', amount: new Prisma.Decimal(20) }),
    })
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'od-1' },
      data: { reparto: { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { line: 1053, combo: 947 } } },
    })
    expect(tx.orderDiscount.update.mock.invocationCallOrder[0]).toBeLessThan(tx.order.update.mock.invocationCallOrder[0])
  })

  it('venta de puras promociones: la fila de cuenta nace con el importe reafirmado y su reparto cae en el combo', async () => {
    tx.order.create.mockResolvedValue({ ...CREATED, subtotal: new Prisma.Decimal(0), items: [] })
    tx.order.findFirst.mockResolvedValue({ subtotal: new Prisma.Decimal(90), serviceChargeAmount: new Prisma.Decimal(0), paidAmount: 0 })
    tx.orderItem.findMany.mockResolvedValue([{ id: 'combo', total: 90, discountAmount: 10, orderPromotionId: 'op' }])
    await createOrderWithItems('venue', { staffId: 'staff', items: [input.items[1]], discount: 2000 } as any)
    expect(tx.orderDiscount.create).toHaveBeenCalledTimes(1)
    expect(tx.orderDiscount.create.mock.calls[0][0].data).toMatchObject({ amount: new Prisma.Decimal(20) })
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'od-1' },
      data: { reparto: expect.objectContaining({ renglones: { combo: 2000 } }) },
    })
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ discountAmount: new Prisma.Decimal(20) }) }),
    )
  })

  it('a promotion failure rolls the sale back: no cancel, no compensation, no post-commit effects', async () => {
    const compensate = jest.spyOn(promotionService, 'removeIntentPromotions')
    apply.mockRejectedValue(new Error('Esa promoción no está publicada.'))
    prismaMock.order.findUnique.mockResolvedValueOnce(null) // idempotency pre-check for the externalId

    await expect(createOrderWithItems('venue', { ...input, externalId: 'ticket-1' })).rejects.toThrow('Esa promoción no está publicada.')

    expect(committed).toBe(false)
    expect(compensate).not.toHaveBeenCalled()
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(tx.order.update).not.toHaveBeenCalled()
    expect(prismaMock.discount.updateMany).not.toHaveBeenCalled()
    compensate.mockRestore()
  })

  it('the stamp reward is redeemed only after the creation commits, through the locked service', async () => {
    const committedAtRedeem: boolean[] = []
    const redeem = jest.spyOn(stampService, 'redeemStampReward').mockImplementation(async () => {
      committedAtRedeem.push(committed)
      return { discountAmount: 10, rewardLabel: 'Café', order: {} }
    })
    prismaMock.order.findUnique.mockResolvedValueOnce({ ...CREATED, total: new Prisma.Decimal(165) })

    const result = await createOrderWithItems('venue', { ...input, stampRewardId: 'rw' })

    expect(redeem).toHaveBeenCalledWith('venue', 'order-new', 'rw', { staffId: 'staff' })
    expect(committedAtRedeem).toEqual([true])
    expect(result.stampReward).toEqual({ applied: true, discountAmount: 10, rewardLabel: 'Café' })
    redeem.mockRestore()
  })
})
