/** Plan3b T2: separate transaction/global clients catch writes and reads escaping the Order lock. */
import { Prisma } from '@prisma/client'
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { $transaction: jest.fn() } }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/referrals/referralRefund.service', () => ({ onOrderCancelled: jest.fn() }))
jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({ getProductInventoryStatus: jest.fn() }))
jest.mock('@/services/modules/module.service', () => ({
  moduleService: { isModuleEnabled: jest.fn(async () => true) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({
  serializedInventoryService: { scan: jest.fn(), register: jest.fn(), buildOrderItemData: jest.fn(), markAsSold: jest.fn() },
}))
import prisma from '@/utils/prismaClient'
import {
  addItemsToOrder,
  removeOrderItem,
  compItems,
  voidItems,
  applyDiscount,
  addSerializedItemToOrder,
} from '@/services/tpv/order.tpv.service'
import { serializedInventoryService } from '@/services/serialized-inventory/serializedInventory.service'
import { getProductInventoryStatus } from '@/services/dashboard/productInventoryIntegration.service'

const globalDb = prisma as any
let tx: any
const line = {
  id: 'line',
  productId: 'product',
  productName: 'Product',
  quantity: 1,
  unitPrice: new Prisma.Decimal(100),
  total: new Prisma.Decimal(100),
  modifiers: [],
  sentToKitchenAt: null,
}
const order = () => ({
  id: 'order',
  venueId: 'venue',
  orderNumber: 'T1',
  version: 1,
  paymentStatus: 'PENDING',
  status: 'PENDING',
  subtotal: new Prisma.Decimal(100),
  discountAmount: new Prisma.Decimal(0),
  tipAmount: new Prisma.Decimal(0),
  paidAmount: new Prisma.Decimal(0),
  total: new Prisma.Decimal(100),
  items: [line],
  table: null,
})
function db() {
  return {
    $queryRaw: jest.fn(async () => [{ id: 'order' }]),
    order: {
      findUnique: jest.fn(async () => order()),
      findUniqueOrThrow: jest.fn(async () => order()),
      update: jest.fn(async () => order()),
      updateMany: jest.fn(async () => ({ count: 1 })),
      count: jest.fn(async () => 1),
      create: jest.fn(async () => order()),
    },
    orderItem: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => ({ ...line, ...data, modifiers: [] })),
      update: jest.fn(async ({ data }: any) => ({ ...line, ...data, modifiers: [] })),
      delete: jest.fn(async () => line),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    product: { findMany: jest.fn(async () => [{ id: 'product', name: 'Product', price: new Prisma.Decimal(100), soldByWeight: false }]) },
    modifier: { findMany: jest.fn(async () => [{ id: 'modifier', name: 'Extra', price: new Prisma.Decimal(10) }]) },
    staff: { findUnique: jest.fn(async () => ({ id: 'staff' })) },
    orderDiscount: { findMany: jest.fn(async () => []), update: jest.fn() },
    orderServiceCharge: { findMany: jest.fn(async () => []), update: jest.fn() },
    orderAction: { create: jest.fn(async () => ({})) },
    orderCustomer: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    terminalPaymentRequest: { findFirst: jest.fn(async () => null) },
    payment: { aggregate: jest.fn(async () => ({ _sum: { amount: 0, tipAmount: 0 } })) },
    serializedItem: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null), create: jest.fn() },
    venue: { findUnique: jest.fn(async () => ({ organizationId: 'org' })) },
    // KDS etapa 3: anular TODOS los renglones retira de la pantalla de cocina las comandas de la cuenta.
    kdsOrderItem: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    kdsOrder: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  }
}
const serial = { id: 'serial', venueId: 'venue', serialNumber: 'SERIAL', status: 'AVAILABLE', category: { name: 'SIM' } }
beforeEach(() => {
  jest.clearAllMocks()
  ;(getProductInventoryStatus as jest.Mock).mockResolvedValue(null)
  Object.assign(globalDb, db())
  tx = db()
  globalDb.$transaction.mockImplementation(async (callback: any) => callback(tx))
  ;(serializedInventoryService.scan as jest.Mock).mockResolvedValue({ found: true, item: serial, status: 'available' })
  ;(serializedInventoryService.register as jest.Mock).mockResolvedValue(serial)
  ;(serializedInventoryService.buildOrderItemData as jest.Mock).mockReturnValue({
    productName: 'SIM',
    quantity: 1,
    unitPrice: 20,
    total: 20,
    taxAmount: 0,
  })
  tx.serializedItem.findFirst.mockResolvedValue(serial)
  tx.serializedItem.findUnique.mockResolvedValue(serial)
})
const writers = [
  ['add', () => addItemsToOrder('venue', 'order', [{ productId: 'product', quantity: 1 }], 1)],
  ['remove', () => removeOrderItem('venue', 'order', 'line', 1)],
  ['comp', () => compItems('venue', 'order', { itemIds: ['line'], reason: 'error', staffId: 'staff' })],
  ['void', () => voidItems('venue', 'order', { itemIds: ['line'], reason: 'error', staffId: 'staff', expectedVersion: 1 })],
  ['discount', () => applyDiscount('venue', 'order', { type: 'PERCENTAGE', value: 10, staffId: 'staff', expectedVersion: 1 })],
  ['serial', () => addSerializedItemToOrder('venue', 'order', { serialNumber: 'SERIAL', price: 20 }, 1, 'staff')],
] as const

describe('new atomic writers', () => {
  it.each(writers)('%s rejects PAID from the transaction even when the global snapshot is still pending', async (_name, run) => {
    tx.order.findUnique.mockResolvedValue({ ...order(), paymentStatus: 'PAID' })
    await expect(run()).rejects.toThrow(/paid order/)
    expect(tx.$queryRaw).toHaveBeenCalled()
    expect(globalDb.order.findUnique).not.toHaveBeenCalled()
    for (const model of ['orderItem', 'orderServiceCharge'])
      for (const method of ['create', 'update', 'delete', 'deleteMany']) {
        if (tx[model][method]) expect(tx[model][method]).not.toHaveBeenCalled()
        if (globalDb[model][method]) expect(globalDb[model][method]).not.toHaveBeenCalled()
      }
  })
  it.each(writers)('%s explicitly rejects a missing/foreign Order lock', async (_name, run) => {
    tx.$queryRaw.mockResolvedValue([])
    await expect(run()).rejects.toThrow(/not found/)
    expect(tx.orderItem.create).not.toHaveBeenCalled()
  })
  it.each(writers)('%s keeps Order-dependent reads and writes on its transaction', async (_name, run) => {
    await run()
    expect(tx.$queryRaw).toHaveBeenCalled()
    expect(globalDb.order.findUnique).not.toHaveBeenCalled()
    expect(globalDb.order.update).not.toHaveBeenCalled()
    expect(globalDb.order.updateMany).not.toHaveBeenCalled()
    for (const model of ['orderItem', 'orderDiscount', 'orderServiceCharge'])
      for (const method of Object.keys(globalDb[model])) expect(globalDb[model][method]).not.toHaveBeenCalled()
  })
  it('register participates in its caller transaction and retains standalone compatibility', async () => {
    const { SerializedInventoryService } = jest.requireActual('@/services/serialized-inventory/serializedInventory.service')
    const service = new SerializedInventoryService(globalDb)
    const input = { venueId: 'venue', categoryId: 'category', serialNumber: ' serial ', createdBy: 'staff' }
    await service.register(input, tx)
    expect(tx.serializedItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ serialNumber: 'SERIAL', status: 'AVAILABLE' }) }),
    )
    expect(globalDb.serializedItem.create).not.toHaveBeenCalled()
    await service.register(input)
    expect(globalDb.serializedItem.create).toHaveBeenCalledTimes(1)
  })
  it('new serial registration receives the same transaction as its item and SOLD write', async () => {
    ;(serializedInventoryService.scan as jest.Mock).mockResolvedValue({ found: false, status: 'not_registered' })
    tx.serializedItem.findFirst.mockResolvedValue(null)
    tx.serializedItem.findUnique.mockResolvedValue(null)
    await addSerializedItemToOrder('venue', 'order', { serialNumber: 'NEW', categoryId: 'category', price: 20 }, 1, 'staff')
    expect(serializedInventoryService.register).toHaveBeenCalledWith(expect.anything(), tx)
    expect(serializedInventoryService.markAsSold).toHaveBeenCalledWith('venue', 'NEW', expect.any(String), tx, { staffId: 'staff' })
  })
})

describe('existing add branches keep their semantics within the transaction', () => {
  it.each(['external', 'fallback', 'create-external', 'merge', 'plain', 'round', 'weight', 'custom'] as const)('%s', async branch => {
    const item: any = { productId: 'product', quantity: 2, modifierIds: ['modifier'] }
    if (['external', 'fallback', 'create-external'].includes(branch)) item.externalId = 'external'
    if (branch === 'external') tx.orderItem.findFirst.mockResolvedValueOnce(line)
    if (branch === 'fallback') tx.orderItem.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(line)
    if (branch === 'merge') tx.orderItem.findMany.mockResolvedValueOnce([{ ...line, notes: null, modifiers: [{ modifierId: 'modifier' }] }])
    if (branch === 'weight') {
      item.quantity = 1
      item.weightQuantity = 1.2346
      tx.product.findMany.mockResolvedValue([{ id: 'product', name: 'Product', price: new Prisma.Decimal(100), soldByWeight: true }])
    }
    if (branch === 'custom') {
      delete item.productId
      delete item.modifierIds
      item.customName = 'Libre'
      item.customUnitPriceCents = 2000
      tx.product.findMany.mockResolvedValue([])
    }
    await addItemsToOrder('venue', 'order', [item], 1, branch === 'round')
    const updating = ['external', 'fallback', 'merge'].includes(branch)
    const data = (updating ? tx.orderItem.update : tx.orderItem.create).mock.calls[0][0].data
    expect(Number(data.total)).toBe(branch === 'weight' ? 133.5 : branch === 'custom' ? 40 : 220)
    if (branch === 'weight') expect(Number(data.weightQuantity)).toBe(1.235)
    if (branch === 'round') expect(data.sentToKitchenAt).toBeInstanceOf(Date)
    expect(globalDb.orderItem.create).not.toHaveBeenCalled()
    expect(globalDb.orderItem.update).not.toHaveBeenCalled()
  })
  it('round inventory preflight still fails open', async () => {
    ;(getProductInventoryStatus as jest.Mock).mockRejectedValueOnce(new Error('inventory unavailable'))
    await addItemsToOrder('venue', 'order', [{ productId: 'product', quantity: 1 }], 1, true)
    expect(tx.orderItem.create).toHaveBeenCalled()
  })
})

describe('validation and historical amounts', () => {
  it('serial rereads SOLD and rejects before creating a line', async () => {
    tx.serializedItem.findFirst.mockResolvedValue({ ...serial, status: 'SOLD' })
    await expect(addSerializedItemToOrder('venue', 'order', { serialNumber: 'SERIAL', price: 20 }, 1, 'staff')).rejects.toThrow(
      'ya fue vendido',
    )
    expect(tx.orderItem.create).not.toHaveBeenCalled()
    expect(tx.serializedItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'serial', OR: [{ venueId: 'venue' }, { venueId: null, organizationId: 'org' }] } }),
    )
  })
  it('serial moved outside the tenant is not replaced with the preflight snapshot', async () => {
    tx.serializedItem.findFirst.mockResolvedValue(null)
    await expect(addSerializedItemToOrder('venue', 'order', { serialNumber: 'SERIAL', price: 20 }, 1, 'staff')).rejects.toThrow('not found')
    expect(tx.orderItem.create).not.toHaveBeenCalled()
  })
  it('tracked out-of-stock round rejects before any writes', async () => {
    ;(getProductInventoryStatus as jest.Mock).mockResolvedValue({ inventoryMethod: 'QUANTITY', available: false })
    await expect(addItemsToOrder('venue', 'order', [{ productId: 'product', quantity: 1 }], 1, true)).rejects.toThrow('agotado')
    expect(tx.orderItem.create).not.toHaveBeenCalled()
  })
  // Codex (fusión con develop, 30-sep): la cola reenvía una ronda YA guardada (se perdió la respuesta) y entretanto el
  // producto se agotó o pasó a venderse por peso. Antes se rechazaba con «agotado» ANTES de ver que sus renglones ya
  // existían: el reducer la mandaba a cuarentena y le retiraba sus promociones.
  it('replay of a saved round is returned as-is even if the product ran out afterwards', async () => {
    ;(getProductInventoryStatus as jest.Mock).mockResolvedValue({ inventoryMethod: 'QUANTITY', available: false })
    tx.orderItem.findMany.mockResolvedValueOnce([{ externalId: 'sync:r:0' }])
    tx.orderItem.findFirst.mockResolvedValueOnce({ ...line, externalId: 'sync:r:0' })
    await addItemsToOrder('venue', 'order', [{ productId: 'product', quantity: 1, externalId: 'sync:r:0' }], 1, true)
    expect(tx.orderItem.create).not.toHaveBeenCalled()
    expect(tx.orderItem.update).not.toHaveBeenCalled()
  })
  it('replay of a saved round is returned as-is even if the product became sold by weight afterwards', async () => {
    tx.product.findMany.mockResolvedValue([{ id: 'product', name: 'Product', price: new Prisma.Decimal(100), soldByWeight: true }])
    tx.orderItem.findMany.mockResolvedValueOnce([{ externalId: 'sync:r:0' }])
    tx.orderItem.findFirst.mockResolvedValueOnce({ ...line, externalId: 'sync:r:0' })
    await addItemsToOrder('venue', 'order', [{ productId: 'product', quantity: 1, externalId: 'sync:r:0' }], 1, true)
    expect(tx.orderItem.create).not.toHaveBeenCalled()
  })
  it('a NEW keyed round with an out-of-stock product is still rejected', async () => {
    ;(getProductInventoryStatus as jest.Mock).mockResolvedValue({ inventoryMethod: 'QUANTITY', available: false })
    tx.orderItem.findMany.mockResolvedValueOnce([])
    await expect(
      addItemsToOrder('venue', 'order', [{ productId: 'product', quantity: 1, externalId: 'sync:nueva:0' }], 1, true),
    ).rejects.toThrow('agotado')
    expect(tx.orderItem.create).not.toHaveBeenCalled()
  })
  it.each(['plain', 'external', 'custom'])('%s courtesy keeps its existing zero-total snapshot', async branch => {
    const item: any = { productId: 'product', quantity: 2, modifierIds: ['modifier'], isCortesia: true, cortesiaReason: 'Regalo' }
    if (branch === 'external') item.externalId = 'external'
    if (branch === 'custom') {
      delete item.productId
      delete item.modifierIds
      item.customName = 'Libre'
      item.customUnitPriceCents = 2000
      tx.product.findMany.mockResolvedValue([])
    }
    await addItemsToOrder('venue', 'order', [item], 1)
    const data = tx.orderItem.create.mock.calls[0][0].data
    expect(Number(data.total)).toBe(0)
    expect(Number(data.discountAmount)).toBe(branch === 'custom' ? 40 : 220)
    expect(data.isCortesia).toBe(true)
    if (branch !== 'custom') expect(data.modifiers.create[0]).toMatchObject({ modifierId: 'modifier', quantity: 1, name: 'Extra' })
  })
  it('add recalculates order percentages excluding promotions, preserves item discount and partial balance', async () => {
    tx.order.findUnique.mockResolvedValue({ ...order(), paymentStatus: 'PARTIAL', paidAmount: 30 })
    tx.orderItem.findMany.mockResolvedValueOnce([]).mockResolvedValue([{ total: 100 }, { total: 50, orderPromotionId: 'promo' }])
    tx.orderDiscount.findMany.mockResolvedValue([
      { id: 'd1', type: 'PERCENTAGE', value: 10, amount: 9 },
      { id: 'd2', type: 'PERCENTAGE', value: 50, amount: 5, appliedToItemIds: ['line'] },
    ])
    tx.orderServiceCharge.findMany.mockResolvedValue([{ id: 'charge', type: 'PERCENTAGE', value: 10, amount: 10 }])
    await addItemsToOrder('venue', 'order', [{ productId: 'product', quantity: 1 }], 1)
    expect(tx.orderDiscount.update).toHaveBeenCalledTimes(1)
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({ where: { id: 'd1' }, data: { amount: 10 } })
    expect(tx.order.updateMany.mock.calls[0][0].data).toMatchObject({
      subtotal: 150,
      discountAmount: 15,
      serviceChargeAmount: 13.5,
      total: 148.5,
      remainingBalance: 118.5,
    })
  })
})

it('advisory stock reads run before opening the Order transaction', async () => {
  ;(getProductInventoryStatus as jest.Mock).mockImplementationOnce(async () => {
    expect(globalDb.$transaction.mock.calls.length).toBe(0)
    return { inventoryMethod: null, available: true }
  })
  await addItemsToOrder('venue', 'order', [{ productId: 'product', quantity: 1 }], 1, true)
  expect(globalDb.product.findMany).toHaveBeenCalledWith({
    where: { venueId: 'venue', id: { in: ['product'] } },
    select: { id: true },
    take: 1,
  })
  expect(tx.product.findMany).toHaveBeenCalled()
})
