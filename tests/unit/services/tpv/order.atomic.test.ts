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
// Tarjetas de regalo: este doble de transacción no modela sobres; la guardia de cuentas de tarjetas tiene su propia
// suite (tests/unit/services/giftCards/cuentaDeTarjetas.test.ts y la integración de la cuenta).
jest.mock('@/services/giftCards/cuentaDeTarjetas', () => ({
  ...jest.requireActual('@/services/giftCards/cuentaDeTarjetas'),
  rechazarSiEsCuentaDeTarjetas: jest.fn().mockResolvedValue(undefined),
  esCuentaDeTarjetasEnTx: jest.fn().mockResolvedValue(false),
  desactivarSobresPendientesDeCuentaEnTx: jest.fn().mockResolvedValue({ desactivados: [] }),
}))
import prisma from '@/utils/prismaClient'
import {
  addItemsToOrder,
  removeOrderItem,
  compItems,
  voidItems,
  applyDiscount,
  addSerializedItemToOrder,
  sellSerializedItem,
} from '@/services/tpv/order.tpv.service'
import { serializedInventoryService } from '@/services/serialized-inventory/serializedInventory.service'
import { getProductInventoryStatus } from '@/services/dashboard/productInventoryIntegration.service'
import { buildOrderItemsData } from '@/services/mobile/order.mobile.service'
import { createHash } from 'crypto'

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
    orderDiscount: {
      findMany: jest.fn(async () => []),
      update: jest.fn(),
      // B2b T6 (Codex r5): anular TODO cierra las reducciones de impuesto de sus filas.
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async ({ data }: any) => ({ id: 'od-nueva', ...data })),
      delete: jest.fn(),
    },
    // B2c T4 (P5): la cortesía de la terminal crea su fila espejo con quien la otorga (StaffVenue) y el recorte puede retirar filas.
    staffVenue: { findFirst: jest.fn(async () => null) },
    orderServiceCharge: { findMany: jest.fn(async () => []), update: jest.fn() },
    orderAction: { create: jest.fn(async () => ({})) },
    orderCustomer: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    terminalPaymentRequest: { findFirst: jest.fn(async () => null) },
    payment: { aggregate: jest.fn(async () => ({ _sum: { amount: 0, tipAmount: 0 } })) },
    serializedItem: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null), create: jest.fn() },
    venue: { findUnique: jest.fn(async () => ({ organizationId: 'org' })) },
    // KDS etapa 3: anular TODOS los renglones retira de la pantalla de cocina las comandas de la cuenta.
    kdsOrderItem: { findMany: jest.fn(async () => []), deleteMany: jest.fn(async () => ({ count: 0 })) },
    kdsOrder: {
      findMany: jest.fn(async () => []),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
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
    for (const model of ['orderItem', 'orderDiscount', 'orderServiceCharge', 'kdsOrder', 'kdsOrderItem'])
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
    tx.orderItem.findMany.mockResolvedValueOnce([]).mockResolvedValue([
      { id: 'line', total: 100, discountAmount: 0 },
      { id: 'promo-line', total: 50, discountAmount: 0, orderPromotionId: 'promo' },
    ])
    tx.orderDiscount.findMany.mockResolvedValue([
      { id: 'd1', type: 'PERCENTAGE', value: 10, amount: 9 },
      { id: 'd2', type: 'PERCENTAGE', value: 50, amount: 5, appliedToItemIds: ['line'] },
    ])
    tx.orderServiceCharge.findMany.mockResolvedValue([{ id: 'charge', type: 'PERCENTAGE', value: 10, amount: 10 }])
    await addItemsToOrder('venue', 'order', [{ productId: 'product', quantity: 1 }], 1)
    expect(tx.orderDiscount.update).toHaveBeenCalledTimes(1)
    // B2: la misma escritura guarda el reparto canónico (sin la línea de promoción); `d2` es dirigida y sin reparto.
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { amount: 10, reparto: { v: 1, alcance: 'CUENTA', conPromociones: false, espejo: false, renglones: { line: 1000 } } },
    })
    expect(tx.order.updateMany.mock.calls[0][0].data).toMatchObject({
      subtotal: 150,
      discountAmount: 15,
      serviceChargeAmount: 13.5,
      total: 148.5,
      remainingBalance: 118.5,
    })
  })
  it('remove re-reparte una fila FIJA de cuenta sobre los renglones que quedan, sin cambiar su importe', async () => {
    const otra = {
      ...line,
      id: 'otra',
      total: new Prisma.Decimal(50),
      unitPrice: new Prisma.Decimal(50),
      discountAmount: new Prisma.Decimal(0),
      orderPromotionId: null,
    }
    tx.order.findUnique.mockResolvedValue({
      ...order(),
      items: [{ ...line, discountAmount: new Prisma.Decimal(0), orderPromotionId: null }, otra],
      subtotal: new Prisma.Decimal(150),
      discountAmount: new Prisma.Decimal(30),
    })
    const fija = { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { line: 2000, otra: 1000 } }
    tx.orderDiscount.findMany.mockResolvedValue([
      { id: 'fija', type: 'FIXED_AMOUNT', value: 30, amount: 30, appliedToItemIds: [], reparto: fija },
    ])
    await removeOrderItem('venue', 'order', 'otra', 1)
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'fija' },
      data: { reparto: { ...fija, renglones: { line: 3000 } } },
    })
    expect(tx.order.update.mock.calls.at(-1)[0].data).toMatchObject({ subtotal: 100, discountAmount: 30, total: 70 })
    expect(globalDb.orderDiscount.update).not.toHaveBeenCalled()
  })
  it('add (la misma función que reproduce ADD_ITEMS offline) re-reparte una fila FIJA sobre los renglones de hoy; la cortesía queda en 0', async () => {
    tx.orderItem.findMany.mockResolvedValueOnce([]).mockResolvedValue([
      { id: 'line', total: 100, discountAmount: 0, orderPromotionId: null },
      { id: 'regalo', total: 0, discountAmount: 50, orderPromotionId: null },
      { id: 'nueva', total: 100, discountAmount: 0, orderPromotionId: null },
    ])
    const fija = { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { line: 2000 } }
    tx.orderDiscount.findMany.mockResolvedValue([
      { id: 'fija', type: 'FIXED_AMOUNT', value: 20, amount: 20, appliedToItemIds: [], reparto: fija },
    ])
    await addItemsToOrder('venue', 'order', [{ productId: 'product', quantity: 1 }], 1, true)
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'fija' },
      data: { reparto: { ...fija, renglones: { line: 1000, nueva: 1000 } } },
    })
    expect(tx.order.updateMany.mock.calls[0][0].data).toMatchObject({ subtotal: 200, discountAmount: 20, total: 180 })
  })
  it('🔴 P2: applyDiscount heredado con artículos crea su fila DIRIGIDA congelada; la cabecera es la de hoy', async () => {
    await applyDiscount('venue', 'order', { type: 'PERCENTAGE', value: 10, itemIds: ['line'], staffId: 'staff', expectedVersion: 1 } as any)
    expect(tx.orderDiscount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order',
        type: 'PERCENTAGE',
        value: 10,
        amount: 10,
        appliedToItemIds: ['line'],
        isManual: true,
        reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones: { line: 1000 } },
      }),
    })
    expect(tx.order.update.mock.calls.at(-1)[0].data).toMatchObject({ discountAmount: 10 })
    expect(globalDb.orderDiscount.create).not.toHaveBeenCalled()
  })
  it('🔴 P2: applyDiscount heredado sin artículos crea su fila de CUENTA con la cuenta de hoy como base (importe congelado, como «Cobrar»)', async () => {
    await applyDiscount('venue', 'order', { type: 'PERCENTAGE', value: 10, staffId: 'staff', expectedVersion: 1 } as any)
    expect(tx.orderDiscount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amount: 10,
        appliedToItemIds: ['line'],
        reparto: { v: 1, alcance: 'CUENTA', conPromociones: true, base: ['line'], espejo: false, renglones: {} },
      }),
    })
  })
  // Codex r1 P2: sin renglones no hay destinos; la fila quedaría como % de cuenta y el recálculo la re-derivaría.
  it('🔴 P2: applyDiscount heredado sobre una cuenta SIN renglones no crea fila; sólo la cabecera, como hoy', async () => {
    tx.order.findUnique.mockResolvedValue({ ...order(), items: [] })
    await applyDiscount('venue', 'order', { type: 'PERCENTAGE', value: 10, staffId: 'staff', expectedVersion: 1 } as any)
    expect(tx.orderDiscount.create).not.toHaveBeenCalled()
    expect(tx.order.update.mock.calls.at(-1)[0].data).toMatchObject({ discountAmount: 10, total: 90 })
  })
  // Codex r1 P1: la cabecera de una orden anterior a B2 ($20 sin fila) se congela en su fila antes de la nueva.
  it('🔴 P1: applyDiscount heredado sobre una orden con $20 históricos de cabecera los congela antes de crear su fila', async () => {
    tx.order.findUnique.mockResolvedValue({ ...order(), discountAmount: new Prisma.Decimal(20), total: new Prisma.Decimal(80) })
    await applyDiscount('venue', 'order', { type: 'FIXED_AMOUNT', value: 10, staffId: 'staff', expectedVersion: 1 } as any)
    const creadas = tx.orderDiscount.create.mock.calls.map((c: any) => c[0].data)
    expect(creadas.map((d: any) => [d.name, Number(d.amount), d.reparto === undefined])).toEqual([
      ['Descuento anterior', 20, true],
      ['Descuento', 10, false],
    ])
    expect(tx.order.update.mock.calls.at(-1)[0].data).toMatchObject({ discountAmount: 30, total: 70 })
  })
  it('control de regresión (ruling R-6): un applyDiscount heredado de $0 no crea fila ni sincroniza; la cabecera es la de hoy', async () => {
    await applyDiscount('venue', 'order', { type: 'PERCENTAGE', value: 0, staffId: 'staff', expectedVersion: 1 } as any)
    expect(tx.orderDiscount.create).not.toHaveBeenCalled()
    expect(tx.orderDiscount.findMany).not.toHaveBeenCalled()
    expect(tx.order.update.mock.calls.at(-1)[0].data).toMatchObject({ discountAmount: 0, total: 100 })
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

describe('R9 (Codex r4 R4-1): lo que sale se lleva su IVA, ANTES de borrar y de sincronizar', () => {
  const conIva = (taxAmount: number, extra: Record<string, unknown> = {}) => ({
    ...line,
    taxAmount: new Prisma.Decimal(taxAmount),
    discountAmount: new Prisma.Decimal(0),
    orderPromotionId: null,
    isCortesia: false,
    product: { categoryId: 'c1' },
    ...extra,
  })
  const pan = () => conIva(8, { id: 'pan', unitPrice: new Prisma.Decimal(50), total: new Prisma.Decimal(50) })

  it('🔴 removeOrderItem con un 10 % de cuenta D16: incrementos [−16, +1.60] y R9 primero; total 52.20 (sin R9: [+1.60] y 68.20)', async () => {
    const cuenta = {
      v: 1,
      alcance: 'CUENTA',
      conPromociones: false,
      espejo: false,
      reduceImpuesto: true,
      renglones: { line: 1000, pan: 500 },
    }
    tx.order.findUnique.mockResolvedValue({
      ...order(),
      contratoDePrecio: 'IVA_APARTE',
      subtotal: new Prisma.Decimal(150),
      discountAmount: new Prisma.Decimal(15),
      taxAmount: new Prisma.Decimal(21.6),
      items: [conIva(16), pan()],
    })
    tx.orderDiscount.findMany.mockResolvedValue([
      {
        id: 'pct',
        type: 'PERCENTAGE',
        value: 10,
        amount: 15,
        taxReduction: 2.4,
        appliedToItemIds: [],
        createdAt: new Date(0),
        reparto: cuenta,
      },
    ])
    tx.order.findUniqueOrThrow
      .mockResolvedValueOnce({ contratoDePrecio: 'IVA_APARTE', taxAmount: new Prisma.Decimal(21.6) }) // R9
      .mockResolvedValueOnce({ contratoDePrecio: 'IVA_APARTE', taxAmount: new Prisma.Decimal(5.6) }) // la sincronización, ya sin el IVA del café
    await removeOrderItem('venue', 'order', 'line', 1)
    const conIncremento = tx.order.update.mock.calls
      .map(([a]: any, i: number) => [a, i] as const)
      .filter(([a]: any) => a.data.taxAmount?.increment !== undefined)
    expect(conIncremento.map(([a]: any) => Number(a.data.taxAmount.increment))).toEqual([-16, 1.6])
    const r9 = tx.order.update.mock.invocationCallOrder[conIncremento[0][1]]
    expect(r9).toBeLessThan(tx.orderItem.delete.mock.invocationCallOrder[0])
    expect(r9).toBeLessThan(tx.orderDiscount.update.mock.invocationCallOrder[0])
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'pct' },
      data: expect.objectContaining({ amount: 5, taxReduction: 0.8 }),
    })
    expect(tx.order.update.mock.calls.at(-1)[0].data).toMatchObject({
      subtotal: 50,
      discountAmount: 5,
      total: 52.2,
      remainingBalance: 52.2,
    })
  })

  it('🔴 voidItems parcial: increment −16 antes del deleteMany y total 58 (sin R9: 74)', async () => {
    tx.order.findUnique.mockResolvedValue({
      ...order(),
      contratoDePrecio: 'IVA_APARTE',
      subtotal: new Prisma.Decimal(150),
      taxAmount: new Prisma.Decimal(24),
      total: new Prisma.Decimal(174),
      items: [conIva(16), pan()],
    })
    tx.order.findUniqueOrThrow.mockResolvedValue({ contratoDePrecio: 'IVA_APARTE', taxAmount: new Prisma.Decimal(24) })
    await voidItems('venue', 'order', { itemIds: ['line'], reason: 'error', staffId: 'staff', expectedVersion: 1 })
    // La lista (y no un `findIndex`): sin R9 el rojo es por aserción (`[]`), no un TypeError sobre el índice −1.
    const conIncremento = tx.order.update.mock.calls
      .map(([a]: any, i: number) => [a, i] as const)
      .filter(([a]: any) => a.data.taxAmount?.increment !== undefined)
    expect(conIncremento.map(([a]: any) => Number(a.data.taxAmount.increment))).toEqual([-16])
    expect(tx.order.update.mock.invocationCallOrder[conIncremento[0][1]]).toBeLessThan(tx.orderItem.deleteMany.mock.invocationCallOrder[0])
    expect(tx.order.update.mock.calls.at(-1)[0].data).toMatchObject({ subtotal: 50, total: 58, remainingBalance: 58 })
  })
})

describe('R11 (Codex r5): una importada de SoftRestaurant se rechaza bajo el candado ANTES de R9 y de toda escritura', () => {
  // Precio CON IVA y su impuesto por pieza, como los manda el puente; con PARTIAL, anular todo pasaría por las guardas de cobro.
  const importada = () => ({
    ...order(),
    originSystem: 'POS_SOFTRESTAURANT',
    contratoDePrecio: 'IVA_APARTE',
    paymentStatus: 'PARTIAL',
    subtotal: new Prisma.Decimal(100),
    taxAmount: new Prisma.Decimal(16),
    total: new Prisma.Decimal(116),
    items: [{ ...line, unitPrice: new Prisma.Decimal(116), total: new Prisma.Decimal(116), taxAmount: new Prisma.Decimal(16) }],
  })
  const nadaEscrito = () => ({
    r9: tx.order.findUniqueOrThrow.mock.calls.length,
    orden: tx.order.update.mock.calls.length + tx.order.updateMany.mock.calls.length,
    renglones: tx.orderItem.update.mock.calls.length + tx.orderItem.delete.mock.calls.length + tx.orderItem.deleteMany.mock.calls.length,
    filas: tx.orderDiscount.update.mock.calls.length + tx.orderDiscount.updateMany.mock.calls.length,
    acciones: tx.orderAction.create.mock.calls.length,
    guardasDeCobro: tx.payment.aggregate.mock.calls.length + tx.terminalPaymentRequest.findFirst.mock.calls.length,
  })
  const cero = { r9: 0, orden: 0, renglones: 0, filas: 0, acciones: 0, guardasDeCobro: 0 }

  it.each([
    ['removeOrderItem', () => removeOrderItem('venue', 'order', 'line', 1)],
    ['voidItems (todo)', () => voidItems('venue', 'order', { itemIds: ['line'], reason: 'error', staffId: 'staff', expectedVersion: 1 })],
  ] as const)('🔴 %s: ORDEN_IMPORTADA_DEL_POS sin leer R9, sin guardas de cobro y sin escribir nada', async (_w, correr) => {
    tx.order.findUnique.mockResolvedValue(importada())
    // Lo que R9 leería: con esto, una guarda puesta DESPUÉS de R9 deja ver su escritura (−16 a la cabecera) antes del rechazo.
    tx.order.findUniqueOrThrow.mockResolvedValue({ contratoDePrecio: 'IVA_APARTE', taxAmount: new Prisma.Decimal(16) })
    await expect(correr()).rejects.toMatchObject({ code: 'ORDEN_IMPORTADA_DEL_POS' })
    expect(nadaEscrito()).toEqual(cero)
  })
})

/** D5 v5 (mesas40, 15-oct): la venta serializada guarda la nota COMPLETA, como en `a2e999c0f` (el server no recorta notas). */
describe('D5 v5: la nota de la venta serializada se guarda completa', () => {
  const notaLarga = 'a'.repeat(499) + '🌮' + 'b'.repeat(9_537)

  it('🔴 addSerializedItemToOrder guarda la nota de 10,038 completa', async () => {
    expect(notaLarga).toHaveLength(10_038)
    await addSerializedItemToOrder('venue', 'order', { serialNumber: 'SERIAL', price: 20, notes: notaLarga }, 1, 'staff')

    expect(tx.orderItem.create.mock.calls[0][0].data.notes).toBe(notaLarga)
  })

  it('🔴 sellSerializedItem (venta rápida) guarda la nota completa en el renglón que nace con la orden', async () => {
    globalDb.venue.findUnique.mockResolvedValue({ id: 'venue', name: 'Venue', salesEnabled: true, organizationId: 'org' })
    tx.shift = { findFirst: jest.fn(async () => null) }

    await sellSerializedItem('venue', { serialNumber: 'SERIAL', price: 20, notes: notaLarga }, 'staff')

    expect(tx.order.create.mock.calls[0][0].data.items.create.notes).toBe(notaLarga)
  })
})

/**
 * D5 en `addItemsToOrder`. En el carrito completo de la TPV (`asNewRound=false`) la nota es la IDENTIDAD de la línea:
 * llave de la fusión en `normalizeAddItems`, match contra las filas existentes y `_count`. Cada recorte en el server
 * chocó con eso:
 * - v3 (Codex P1): un recorte pelón fusionaba `500a+A` con `500a+B` y el carrito reenviado SUMABA ($200 → $400).
 * - v4 (Codex r2): con huella, una nota escrita LITERALMENTE igual que la forma recortada de otra se confundía con ella, y
 *   una nota vieja de 501 espacios se volvía visible y duplicaba el renglón.
 * - v5 (Codex r3): una fila guardada RECORTADA por otro escritor (alta mobile, vale) dejaba de reconocerse cuando llegaba
 *   el carrito completo con la nota original ($100 → $200).
 * Decisión v5: el server no recorta `OrderItem.notes` en ningún camino (exactamente `a2e999c0f`: sólo trim). Estas
 * pruebas se quedan de guarda. Prisma simulado con las filas en memoria y la versión que avanza como en el server (CAS de
 * `order.updateMany`).
 */
describe('D5: la nota en addItemsToOrder — sin tope en el carrito completo ni en las rondas', () => {
  const base = 'a'.repeat(500)
  const X = base + 'A'
  // La forma que le daba el recorte v3 a X, escrita LITERALMENTE como la nota de otra línea (contraejemplo de Codex r2).
  const Y = 'a'.repeat(491) + '…' + createHash('sha256').update(X).digest('hex').slice(0, 8)
  const linea = (notes?: string) => ({ productId: 'product', quantity: 1, ...(notes === undefined ? {} : { notes }) })
  const vieja = (id: string, notes: string) => ({
    id,
    orderId: 'order',
    productId: 'product',
    quantity: 1,
    total: new Prisma.Decimal(100),
    notes,
    isCortesia: false,
    course: null,
    seat: null,
  })

  function cuentaEnMemoria(iniciales: any[] = []) {
    const filas: any[] = iniciales.map(fila => ({ ...fila }))
    let siguiente = 0
    let version = 1
    tx.order.findUnique.mockImplementation(async () => ({ ...order(), version }))
    tx.order.updateMany.mockImplementation(async ({ where }: any) => {
      if (where.version !== version) return { count: 0 }
      version += 1
      return { count: 1 }
    })
    tx.orderItem.findMany.mockImplementation(async ({ where }: any = {}) =>
      filas
        .filter(
          fila =>
            (!where?.orderId || fila.orderId === where.orderId) &&
            (!where?.productId || fila.productId === where.productId) &&
            !(where?.id?.notIn ?? []).includes(fila.id),
        )
        .map(fila => ({ ...fila, modifiers: [] })),
    )
    tx.orderItem.create.mockImplementation(async ({ data }: any) => {
      // `modifiers` es el `create` anidado de Prisma, no una columna: la fila guardada no lo lleva.
      const fila = { id: `fila-${++siguiente}`, isCortesia: false, course: null, seat: null, ...data, modifiers: undefined }
      filas.push(fila)
      return { ...fila, modifiers: [] }
    })
    tx.orderItem.update.mockImplementation(async ({ where, data }: any) => {
      const fila = filas.find(f => f.id === where.id)
      Object.assign(fila, data)
      return { ...fila, modifiers: [] }
    })
    return { filas, version: () => version }
  }
  const totalGuardado = () => {
    const llamadas = tx.order.updateMany.mock.calls
    return llamadas[llamadas.length - 1][0].data.total
  }
  /** Guarda el carrito y lo reenvía con la versión que dejó el primer envío. Regresa el total de cada envío. */
  async function guardarYReenviar(carrito: any[], cuenta: { version: () => number }) {
    await addItemsToOrder('venue', 'order', carrito, cuenta.version())
    const primero = totalGuardado()
    await addItemsToOrder('venue', 'order', carrito, cuenta.version())
    return [primero, totalGuardado()]
  }

  it('v3: `500a+A` y `500a+B` — guardar y reenviar el carrito deja $200 → $200', async () => {
    const cuenta = cuentaEnMemoria()

    expect(await guardarYReenviar([linea(base + 'A'), linea(base + 'B')], cuenta)).toEqual([200, 200])
    expect(cuenta.filas.map(fila => fila.quantity)).toEqual([1, 1])
  })

  it('v3: esas notas sobre dos filas viejas guardadas completas — reenviar deja $200, sin filas nuevas', async () => {
    const cuenta = cuentaEnMemoria([vieja('vieja-A', base + 'A'), vieja('vieja-B', base + 'B')])

    await addItemsToOrder('venue', 'order', [linea(base + 'A'), linea(base + 'B')], 1)

    expect(totalGuardado()).toBe(200)
    expect(cuenta.filas.map(fila => [fila.id, fila.quantity])).toEqual([
      ['vieja-A', 1],
      ['vieja-B', 1],
    ])
    expect(tx.orderItem.create).not.toHaveBeenCalled()
  })

  it('🔴 v4: X y su forma recortada escrita literalmente (Y) — guardar y reenviar deja $200 → $200', async () => {
    const cuenta = cuentaEnMemoria()

    expect(await guardarYReenviar([linea(X), linea(Y)], cuenta)).toEqual([200, 200])
    expect(cuenta.filas.map(fila => [fila.quantity, fila.notes])).toEqual([
      [1, X],
      [1, Y],
    ])
  })

  it('🔴 v4: X y Y sobre dos filas viejas — reenviar deja $200, sin filas nuevas', async () => {
    const cuenta = cuentaEnMemoria([vieja('vieja-X', X), vieja('vieja-Y', Y)])

    await addItemsToOrder('venue', 'order', [linea(X), linea(Y)], 1)

    expect(totalGuardado()).toBe(200)
    expect(cuenta.filas.map(fila => [fila.id, fila.quantity])).toEqual([
      ['vieja-X', 1],
      ['vieja-Y', 1],
    ])
    expect(tx.orderItem.create).not.toHaveBeenCalled()
  })

  it('🔴 v4: fila vieja con 501 espacios — dos envíos sin nota dejan UN renglón y $100 (la nota vacía no se vuelve visible)', async () => {
    const espacios = ' '.repeat(501)
    const cuenta = cuentaEnMemoria([vieja('vieja', espacios)])

    expect(await guardarYReenviar([linea()], cuenta)).toEqual([100, 100])
    expect(cuenta.filas).toHaveLength(1)
    expect(cuenta.filas[0].notes).toBe(espacios)
    expect(tx.orderItem.create).not.toHaveBeenCalled()
  })

  it('🔴 v4: en el carrito completo una nota de 10,038 se guarda COMPLETA (sólo trim), como en a2e999c0f, y el reenvío la reconoce', async () => {
    const larga = 'n'.repeat(10_038)
    const cuenta = cuentaEnMemoria()

    expect(await guardarYReenviar([linea(`  ${larga} `)], cuenta)).toEqual([100, 100])
    expect(cuenta.filas).toHaveLength(1)
    expect(cuenta.filas[0].notes).toBe(larga)
  })

  it('🔴 rondas (asNewRound=true): X y Y en una ronda nueva sobre dos filas viejas — dos renglones nuevos con sus notas COMPLETAS', async () => {
    const cuenta = cuentaEnMemoria([vieja('vieja-X', X), vieja('vieja-Y', Y)])

    await addItemsToOrder('venue', 'order', [linea(X), linea(Y)], 1, true)

    expect(totalGuardado()).toBe(400)
    expect(tx.orderItem.update).not.toHaveBeenCalled()
    expect(cuenta.filas.map(fila => [fila.quantity, fila.notes])).toEqual([
      [1, X],
      [1, Y],
      [1, X],
      [1, Y],
    ])
  })

  it('🔴 v5: una ronda nueva guarda la nota de 10,038 COMPLETA (sólo trim), como en a2e999c0f', async () => {
    const larga = 'n'.repeat(10_038)
    const cuenta = cuentaEnMemoria()

    await addItemsToOrder('venue', 'order', [linea(`  ${larga} `)], 1, true)

    expect(totalGuardado()).toBe(100)
    expect(cuenta.filas.map(fila => fila.notes)).toEqual([larga])
  })

  // Codex r3: la fila la escribió OTRO camino (aquí el alta mobile, `buildOrderItemsData`; el vale v7 usa el mismo dato) y
  // después llega el carrito completo SIN `externalId` con la misma nota. Si el escritor la hubiera recortado, el match
  // por nota fallaba y nacía un segundo renglón ($100 → $200).
  it('🔴 v5 (Codex r3): fila del alta mobile con nota de 10,038 + carrito completo sin externalId con la misma nota ⇒ $100 → $100, una sola fila', async () => {
    const larga = 'n'.repeat(10_038)
    const { itemsData } = await buildOrderItemsData('venue', [{ productId: 'product', quantity: 1, notes: larga }])
    const cuenta = cuentaEnMemoria([vieja('del-alta', itemsData[0].notes)])

    expect(await guardarYReenviar([linea(larga)], cuenta)).toEqual([100, 100])
    expect(cuenta.filas.map(fila => [fila.id, fila.quantity])).toEqual([['del-alta', 1]])
    expect(tx.orderItem.create).not.toHaveBeenCalled()
  })
})

/**
 * Updates de una línea que CONSERVA su nota (`normalizedNotes ?? existing.notes`): la nota heredada queda tal cual, como
 * en `a2e999c0f`, en el carrito completo y en las rondas. Recortarla la cambiaba de identidad: 501 espacios pasaban a
 * «491 espacios…huella» y el siguiente envío creaba otro renglón (Codex r2).
 */
describe('D5: un update que hereda la nota de una fila vieja', () => {
  const notaVieja = 'n'.repeat(10_038)
  const filaVieja = { ...line, id: 'fila-vieja', orderId: 'order', notes: notaVieja, externalId: null as string | null }

  it('🔴 v4: carrito completo por externalId — la nota heredada queda tal cual', async () => {
    tx.orderItem.findFirst.mockImplementation(async ({ where }: any) =>
      where.externalId === 'ext-1' ? { ...filaVieja, externalId: 'ext-1' } : null,
    )

    await addItemsToOrder('venue', 'order', [{ productId: 'product', quantity: 2, externalId: 'ext-1' }], 1)

    expect(tx.orderItem.update.mock.calls[0][0].data.notes).toBe(notaVieja)
  })

  it('🔴 v4: carrito completo por el respaldo de id — la nota heredada queda tal cual', async () => {
    tx.orderItem.findFirst.mockImplementation(async ({ where }: any) => (where.id === 'fila-vieja' ? filaVieja : null))

    await addItemsToOrder('venue', 'order', [{ productId: 'product', quantity: 2, externalId: 'fila-vieja' }], 1)

    expect(tx.orderItem.update.mock.calls[0][0].data.notes).toBe(notaVieja)
  })

  it('🔴 v5: ronda (asNewRound=true) por el respaldo de id — la nota heredada también queda tal cual', async () => {
    tx.orderItem.findFirst.mockImplementation(async ({ where }: any) => (where.id === 'fila-vieja' ? filaVieja : null))

    await addItemsToOrder('venue', 'order', [{ productId: 'product', quantity: 2, externalId: 'fila-vieja' }], 1, true)

    expect(tx.orderItem.update.mock.calls[0][0].data.notes).toBe(notaVieja)
  })
})
