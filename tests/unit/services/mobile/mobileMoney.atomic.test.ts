import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import { compOrderItem, compWholeOrder } from '@/services/mobile/comp-item.mobile.service'
import { applyServiceCharge, removeServiceCharge, syncAutomaticServiceCharges } from '@/services/mobile/service-charge.mobile.service'
import { updateOrderDetails, mergeOrders } from '@/services/mobile/order.mobile.service'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/referrals/referralRefund.service', () => ({ onOrderCancelled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

const order = {
  id: 'order',
  status: 'PENDING',
  paymentStatus: 'PENDING',
  subtotal: 100,
  discountAmount: 20,
  // B2b T6c: fusionar pasa el IVA aparte del origen al destino (`new Prisma.Decimal(freshSource.taxAmount)`); sin contrato de
  // precio y sin IVA aparte, el impuesto guardado es 0.
  taxAmount: 0,
  paidAmount: 7,
  covers: 8,
  orderNumber: '1',
  customerName: null,
}
const item = { id: 'item', productName: 'Producto', total: 100, quantity: 1, unitPrice: 100, isCortesia: false }
const charge = { id: 'charge', name: 'Servicio', type: 'PERCENTAGE', value: 10, taxable: true, autoApplyMinCovers: 8 }
let tx: any
let committed: boolean
const comp = () => compOrderItem({ venueId: 'venue', orderId: 'order', itemId: 'item', reason: 'Error' })
const whole = () => compWholeOrder({ venueId: 'venue', orderId: 'order', reason: 'Error' })
const apply = () => applyServiceCharge('venue', 'order', 'charge', 'staff')
const remove = () => removeServiceCharge('venue', 'order', 'applied')
const auto = () => syncAutomaticServiceCharges('venue', 'order')

beforeEach(() => {
  jest.clearAllMocks()
  committed = false
  const model = () =>
    Object.fromEntries(
      ['findUnique', 'findFirst', 'findMany', 'create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany'].map(name => [
        name,
        jest.fn(),
      ]),
    )
  tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'order' }]),
    order: model(),
    orderItem: model(),
    orderDiscount: model(),
    orderServiceCharge: model(),
    serviceCharge: model(),
    staffVenue: model(),
    customer: model(),
    terminalPaymentRequest: model(),
  }
  tx.order.findUnique.mockResolvedValue({ ...order })
  tx.order.findFirst.mockResolvedValue({ ...order })
  tx.orderItem.findFirst.mockResolvedValue({ ...item })
  tx.orderItem.findMany.mockResolvedValue([{ ...item }])
  tx.orderDiscount.findMany.mockResolvedValue([])
  tx.orderServiceCharge.findMany.mockResolvedValue([])
  tx.orderServiceCharge.findFirst.mockResolvedValue(null)
  tx.orderServiceCharge.createMany.mockResolvedValue({ count: 1 })
  tx.serviceCharge.findFirst.mockResolvedValue(charge)
  tx.serviceCharge.findMany.mockResolvedValue([charge])
  tx.staffVenue.findUnique.mockResolvedValue({ id: 'staff-venue' })
  tx.order.update.mockImplementation(async ({ data }: any) => ({ ...order, serviceChargeAmount: 0, total: 100, version: 2, ...data }))
  prismaMock.$transaction.mockImplementation(async (callback: any) => {
    const result = await callback(tx)
    committed = true
    return result
  })
  // Global reads are deliberately different: passing the same double as tx hid these escapes.
  prismaMock.order.findUnique.mockRejectedValue(new Error('GLOBAL ORDER READ'))
  prismaMock.order.findFirst.mockRejectedValue(new Error('GLOBAL ORDER READ'))
  prismaMock.orderItem.update.mockRejectedValue(new Error('GLOBAL ITEM WRITE'))
  prismaMock.orderServiceCharge.create.mockRejectedValue(new Error('GLOBAL CHARGE WRITE'))
  ;(logAction as jest.Mock).mockImplementation(() => {
    expect(committed).toBe(true)
  })
})

describe('mobile money writers own the lock and transaction', () => {
  it.each([
    ['comp', comp],
    ['whole', whole],
    ['apply', apply],
    ['remove', remove],
    ['auto', auto],
  ] as const)('%s recalculates on the same tx with fresh paidAmount', async (name, run) => {
    if (name === 'remove') tx.orderServiceCharge.findFirst.mockResolvedValue({ id: 'applied', name: 'Servicio' })
    await run()
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      Math.min(...[...tx.order.findFirst.mock.invocationCallOrder, ...tx.order.findUnique.mock.invocationCallOrder]),
    )
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ remainingBalance: name === 'comp' || name === 'whole' ? 73 : 93 }) }),
    )
  })
  it.each([
    ['comp', comp],
    ['whole', whole],
    ['apply', apply],
    ['remove', remove],
    ['auto', auto],
  ] as const)('%s propagates recalc failure without auditing', async (name, run) => {
    if (name === 'remove') tx.orderServiceCharge.findFirst.mockResolvedValue({ id: 'applied', name: 'Servicio' })
    tx.order.update.mockRejectedValue(new Error('total write failed'))
    await expect(run()).rejects.toThrow('total write failed')
    expect(committed).toBe(false)
    expect(logAction).not.toHaveBeenCalled()
  })
  it.each([
    ['comp', comp],
    ['whole', whole],
    ['apply', apply],
    ['remove', remove],
  ] as const)('%s rejects the payment status read after locking', async (_name, run) => {
    tx.order.findUnique.mockResolvedValue({ ...order, paymentStatus: 'PAID' })
    tx.order.findFirst.mockResolvedValue({ ...order, paymentStatus: 'PAID' })
    await expect(run()).rejects.toThrow('pagada')
    expect(tx.orderItem.update).not.toHaveBeenCalled()
    expect(tx.orderServiceCharge.create).not.toHaveBeenCalled()
    expect(tx.orderServiceCharge.delete).not.toHaveBeenCalled()
  })
  it('auto accepts caller tx and does not start a nested transaction', async () => {
    await syncAutomaticServiceCharges('venue', 'order', tx as Prisma.TransactionClient)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(tx.orderServiceCharge.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }))
  })
  it.each(['PAID', 'PARTIAL', 'missing'])('auto preserves no-op for %s', async state => {
    tx.order.findFirst.mockResolvedValue(state === 'missing' ? null : { ...order, paymentStatus: state })
    if (state === 'missing') tx.$queryRaw.mockResolvedValue([])
    await expect(auto()).resolves.toBeNull()
    expect(tx.order.update).not.toHaveBeenCalled()
  })
  it('auto duplicate create is non-abortive and does not recalculate', async () => {
    tx.orderServiceCharge.createMany.mockResolvedValue({ count: 0 })
    await expect(auto()).resolves.toBeNull()
    expect(tx.order.update).not.toHaveBeenCalled()
  })
  it('manual duplicate preserves its public message', async () => {
    tx.orderServiceCharge.findFirst.mockResolvedValue({ id: 'existing' })
    await expect(apply()).rejects.toThrow('Ese cobro ya está aplicado a la cuenta')
  })
  it('manual P2002 escapes the aborted tx before mapping the public error', async () => {
    tx.orderServiceCharge.create.mockRejectedValue({ code: 'P2002' })
    await expect(apply()).rejects.toThrow('Ese cobro ya está aplicado a la cuenta')
    expect(tx.order.update).not.toHaveBeenCalled()
  })
  it('comp replay preserves its public message', async () => {
    tx.orderItem.findFirst.mockResolvedValue({ ...item, isCortesia: true })
    await expect(comp()).rejects.toThrow('El artículo ya está dado de cortesía')
  })
  it('covers update and automatic charges share one tx', async () => {
    await expect(updateOrderDetails('venue', 'order', { covers: 9 })).resolves.toMatchObject({ covers: 9 })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.orderServiceCharge.createMany).toHaveBeenCalled()
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ covers: 9 }) }))
  })
  it('merge uses fresh paidAmount/item count and synchronizes automatic charges before commit', async () => {
    const source = { ...order, id: 'source', paidAmount: 0, items: [item], _count: { items: 2 }, orderDiscounts: [], serviceCharges: [] }
    prismaMock.order.findFirst.mockImplementation(async ({ where }: any) => (where.id === 'source' ? source : { ...order, paidAmount: 1 }))
    tx.order.findFirst.mockImplementation(async ({ where }: any) => (where.id === 'source' ? source : order))
    tx.$queryRaw.mockResolvedValue([{ id: 'order' }, { id: 'source' }])
    tx.terminalPaymentRequest.findFirst.mockResolvedValue(null)
    prismaMock.table.findFirst.mockResolvedValue(null)
    const result = await mergeOrders('venue', 'order', 'source')
    expect(result.merged.items).toBe(2)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ORDERS_MERGED', data: expect.objectContaining({ items: 2 }) }),
    )
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ remainingBalance: 93 }) }))
    expect(tx.orderServiceCharge.createMany).toHaveBeenCalled()
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })
})
