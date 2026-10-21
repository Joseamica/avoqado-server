import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '@tests/__helpers__/setup'
import { receivePurchaseOrder, updatePurchaseOrderItemStatus } from '@/services/dashboard/purchaseOrder.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const item = (prepared: boolean, approvedBy: string | null, status = 'PENDING_APPROVAL') => ({
  id: 'item',
  rawMaterialId: 'raw',
  productId: null,
  quantityOrdered: new Decimal(3),
  quantityReceived: new Decimal(0),
  unit: 'KILOGRAM',
  unitPrice: new Decimal(300),
  batches: [],
  rawMaterial: { id: 'raw', name: 'Harina', unit: 'GRAM', currentStock: new Decimal(0), perishable: false },
  purchaseOrder: {
    id: 'po',
    orderNumber: 'XML-invoice',
    status,
    approvedBy,
    approvedAt: approvedBy ? new Date() : null,
    invoices: prepared ? [{ id: 'invoice' }] : [],
  },
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.purchaseOrder.findUnique.mockResolvedValue({ id: 'po', status: 'RECEIVED', items: [] })
  prismaMock.stockBatch.findFirst.mockResolvedValue(null)
  prismaMock.stockBatch.create.mockImplementation(async ({ data }: any) => ({ id: 'batch', ...data }))
})

describe('XML approval at the shared inventory writer', () => {
  it('also blocks the legacy bulk writer when status was changed without approving', async () => {
    prismaMock.purchaseOrder.findFirst.mockResolvedValue({ ...item(true, null, 'CONFIRMED').purchaseOrder, items: [] })
    await expect(receivePurchaseOrder('venue', 'po', { receivedDate: new Date().toISOString(), items: [] }, 'staff')).rejects.toMatchObject(
      { statusCode: 409 },
    )
    expect(prismaMock.stockBatch.create).not.toHaveBeenCalled()
  })
  it.each(['PENDING_APPROVAL', 'DRAFT', 'REJECTED', 'CONFIRMED', 'RECEIVED'])('blocks an unapproved XML order even in %s', async status => {
    prismaMock.purchaseOrderItem.findFirst.mockResolvedValue(item(true, null, status))
    await expect(
      updatePurchaseOrderItemStatus('venue', 'po', 'item', { receiveStatus: 'RECEIVED', quantityReceived: 3 }, 'staff'),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(prismaMock.purchaseOrderItem.update).not.toHaveBeenCalled()
    expect(prismaMock.stockBatch.create).not.toHaveBeenCalled()
    expect(prismaMock.rawMaterial.update).not.toHaveBeenCalled()
  })

  it('still receives an approved XML in purchase units', async () => {
    prismaMock.purchaseOrderItem.findFirst.mockResolvedValue(item(true, 'manager', 'APPROVED'))
    await updatePurchaseOrderItemStatus('venue', 'po', 'item', { receiveStatus: 'RECEIVED', quantityReceived: 3 }, 'staff')
    expect(prismaMock.rawMaterial.update).toHaveBeenCalledWith({
      where: { id: 'raw' },
      data: { currentStock: { increment: new Decimal(3000) } },
    })
  })

  it('preserves the legacy manual-order contract without an approval stamp', async () => {
    prismaMock.purchaseOrderItem.findFirst.mockResolvedValue(item(false, null, 'CONFIRMED'))
    await updatePurchaseOrderItemStatus('venue', 'po', 'item', { receiveStatus: 'RECEIVED', quantityReceived: 3 }, 'staff')
    expect(prismaMock.stockBatch.create).toHaveBeenCalledTimes(1)
  })
})
