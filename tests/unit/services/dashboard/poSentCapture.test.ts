/**
 * Unit tests — PO sent-to-supplier audit capture.
 *
 * Verifies that sendToSupplier writes a PURCHASE_ORDER_SENT_TO_SUPPLIER
 * ActivityLog entry (via logAction) after transitioning the PO to SENT,
 * including the actor (performedBy) and key PO fields.
 */

import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    purchaseOrder: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { sendToSupplier } from '@/services/dashboard/purchaseOrderWorkflow.service'

const mockedPrisma = prisma as any
const mockedLogAction = logAction as jest.Mock

const VENUE_ID = 'venue-abc'
const PO_ID = 'po-123'
const SUPPLIER_ID = 'sup-001'
const SUPPLIER_EMAIL = 'proveedor@test.com'
const ACTOR_ID = 'staff-xyz'

const approvedPO = {
  id: PO_ID,
  venueId: VENUE_ID,
  orderNumber: 'PO-2026-001',
  status: 'APPROVED',
  supplierId: SUPPLIER_ID,
  supplier: { id: SUPPLIER_ID, email: SUPPLIER_EMAIL },
}

const sentPO = {
  ...approvedPO,
  status: 'SENT',
  supplier: approvedPO.supplier,
  items: [],
}

describe('sendToSupplier — audit capture', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue(approvedPO)
    mockedPrisma.purchaseOrder.update.mockResolvedValue(sentPO)
  })

  // ---- NEW FEATURE TESTS ----

  it('calls logAction with PURCHASE_ORDER_SENT_TO_SUPPLIER after status update', async () => {
    await sendToSupplier(VENUE_ID, PO_ID, ACTOR_ID)

    expect(mockedLogAction).toHaveBeenCalledTimes(1)
    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PURCHASE_ORDER_SENT_TO_SUPPLIER',
        entity: 'PurchaseOrder',
        entityId: PO_ID,
      }),
    )
  })

  it('threads the actor (performedBy) into logAction as staffId', async () => {
    await sendToSupplier(VENUE_ID, PO_ID, ACTOR_ID)

    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: ACTOR_ID,
        venueId: VENUE_ID,
      }),
    )
  })

  it('includes orderNumber, supplierId, and supplierEmail in logAction data', async () => {
    await sendToSupplier(VENUE_ID, PO_ID, ACTOR_ID)

    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderNumber: approvedPO.orderNumber,
          supplierId: SUPPLIER_ID,
          supplierEmail: SUPPLIER_EMAIL,
        }),
      }),
    )
  })

  it('passes null as staffId when no actor is provided', async () => {
    await sendToSupplier(VENUE_ID, PO_ID)

    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: null,
      }),
    )
  })

  it('still calls logAction even when supplier has no email', async () => {
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue({
      ...approvedPO,
      supplier: { id: SUPPLIER_ID, email: null },
    })

    await sendToSupplier(VENUE_ID, PO_ID, ACTOR_ID)

    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          supplierEmail: null,
        }),
      }),
    )
  })

  // ---- REGRESSION TESTS ----

  it('still updates PO status to SENT', async () => {
    await sendToSupplier(VENUE_ID, PO_ID, ACTOR_ID)

    expect(mockedPrisma.purchaseOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SENT' }),
        where: { id: PO_ID },
      }),
    )
  })

  it('still returns the updated PO', async () => {
    const result = await sendToSupplier(VENUE_ID, PO_ID, ACTOR_ID)

    expect(result).toEqual(sentPO)
  })

  it('throws 404 when PO is not found', async () => {
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue(null)

    await expect(sendToSupplier(VENUE_ID, PO_ID, ACTOR_ID)).rejects.toMatchObject({
      statusCode: 404,
    })
    expect(mockedLogAction).not.toHaveBeenCalled()
  })

  it('throws 400 when PO is not in APPROVED status', async () => {
    mockedPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...approvedPO, status: 'DRAFT' })

    await expect(sendToSupplier(VENUE_ID, PO_ID, ACTOR_ID)).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(mockedLogAction).not.toHaveBeenCalled()
  })
})
