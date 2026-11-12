import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import { addItemsToOrder } from '@/services/tpv/order.tpv.service'
import { applyPromotionToOrder } from '@/services/promotions/promotion.service'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'

// Pedidos en línea fase 2 (T8): las guardas de pedidos con tarjeta leen `onlineOrder`, que los `tx` a mano de esta suite no traen.
// Esta suite prueba otra cosa; las guardas se prueban en `online-ordering/card/guards.test.ts` y `cardGuards.integration.test.ts`.
jest.mock('@/services/online-ordering/card/guards', () => ({
  ...jest.requireActual('@/services/online-ordering/card/guards'),
  findCardOnlineOrderInTx: jest.fn(async () => null),
  isCardOnlineOrderInTx: jest.fn(async () => false),
  assertNotCardOnlineOrderInTx: jest.fn(async () => undefined),
  assertCardOrderMoneyFrozenInTx: jest.fn(async () => undefined),
  avisarCobroDobleSobrePedidoConTarjeta: jest.fn(async () => undefined),
}))
jest.mock('@/services/promotions/promotion.service', () => ({ applyPromotionToOrder: jest.fn() }))
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  ...jest.requireActual('@/services/kds/kitchenDisplayStations'),
  debeMarcarCocina: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
const order = {
  id: 'order',
  venueId: 'venue',
  orderNumber: 'T1',
  version: 1,
  status: 'PENDING',
  paymentStatus: 'PENDING',
  subtotal: new Prisma.Decimal(0),
  discountAmount: new Prisma.Decimal(0),
  paidAmount: new Prisma.Decimal(0),
  taxAmount: new Prisma.Decimal(0),
  contratoDePrecio: 'IVA_INCLUIDO',
  items: [],
  table: { number: 1 },
}
const comboLine = {
  id: 'component',
  productId: 'coffee',
  productName: 'Café',
  quantity: 1,
  unitPrice: new Prisma.Decimal(120),
  total: new Prisma.Decimal(99),
  discountAmount: new Prisma.Decimal(21),
  taxAmount: new Prisma.Decimal(0),
  orderPromotionId: 'instance',
  modifiers: [],
  product: { id: 'coffee', name: 'Café' },
}
const promo = {
  quantity: 1,
  promotionRef: {
    promotionId: 'combo',
    promotionInstanceId: 'sale',
    selections: [{ groupId: 'g', optionId: 'o', serviceCourse: { id: 'desserts', label: 'Postres', kind: 'STANDARD' as const } }],
  },
}
let tx: any
describe('table combo rounds use one locked fiscal transaction', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    ;(applyPromotionToOrder as jest.Mock).mockResolvedValue({ orderPromotionId: 'instance', netCents: 9900, created: true })
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'order' }]),
      order: {
        count: jest.fn(async () => 0),
        findUnique: jest.fn().mockResolvedValue(order),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ ...order, items: [comboLine] }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      modifier: { findMany: jest.fn().mockResolvedValue([]) },
      orderItem: { findMany: jest.fn().mockResolvedValue([comboLine]), create: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
      orderDiscount: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      orderServiceCharge: { findMany: jest.fn().mockResolvedValue([]) },
    }
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx))
  })
  it('passes the complete choice and shared round timestamp to promotion creation on the caller tx', async () => {
    await addItemsToOrder('venue', 'order', [promo] as any, 1, true)
    expect(applyPromotionToOrder).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: 'venue', orderId: 'order', instanceId: 'sale', selections: promo.promotionRef.selections }),
      tx,
      expect.objectContaining({ deferTotalsToCaller: true, sentToKitchenAt: expect.any(Date) }),
    )
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order', version: 1 },
        data: expect.objectContaining({ total: 99, version: { increment: 1 } }),
      }),
    )
    expect(prismaMock.orderItem.createMany).not.toHaveBeenCalled()
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })
  // hz:5bda0b30:D3: la cola sin red manda la ronda con combos por aquí, con la hora en que se VENDIÓ sin red (ya acotada).
  it('una ronda de la cola sin red evalúa y envía el combo a la hora en que se vendió; sin ella, la del envío', async () => {
    const vendidoEn = new Date(Date.now() - 40 * 60_000)
    await addItemsToOrder('venue', 'order', [promo] as any, 1, true, undefined, vendidoEn)
    expect(applyPromotionToOrder).toHaveBeenCalledWith(
      expect.objectContaining({ soldAt: vendidoEn }),
      tx,
      expect.objectContaining({ deferTotalsToCaller: true, sentToKitchenAt: vendidoEn }),
    )
    ;(applyPromotionToOrder as jest.Mock).mockClear()
    await addItemsToOrder('venue', 'order', [promo] as any, 1, true)
    const [params, , options] = (applyPromotionToOrder as jest.Mock).mock.calls[0]
    expect(params.soldAt).not.toEqual(vendidoEn)
    expect(options.sentToKitchenAt).toEqual(params.soldAt)
  })
  it('never sends promotion references through the normal product/custom-price branch', async () => {
    await addItemsToOrder('venue', 'order', [promo] as any, 1, true)
    expect(tx.orderItem.create).not.toHaveBeenCalled()
    expect(tx.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: [] } }) }))
  })
  it('a stale check is rejected before creating a promotion', async () => {
    await expect(addItemsToOrder('venue', 'order', [promo] as any, 0, true)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(applyPromotionToOrder).not.toHaveBeenCalled()
  })
  it('requires TABLE_SERVICE and PROMOTIONS even when invoked outside the HTTP router', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    await expect(addItemsToOrder('venue', 'order', [promo] as any, 1, true)).rejects.toMatchObject({ statusCode: 403 })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
  it('does not accept a mixed product/promotion or quantity >1 as one package', async () => {
    await expect(addItemsToOrder('venue', 'order', [{ ...promo, productId: 'coffee' }] as any, 1, true)).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(addItemsToOrder('venue', 'order', [{ ...promo, quantity: 2 }] as any, 1, true)).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})
