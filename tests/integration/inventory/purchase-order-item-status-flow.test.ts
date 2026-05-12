import prisma from '@/utils/prismaClient'
import { updatePurchaseOrderItemStatus } from '@/services/dashboard/purchaseOrder.service'
import { BatchStatus, PurchaseOrderItemStatus, PurchaseOrderStatus, RawMaterialMovementType } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

describe('Purchase order item status inventory flow', () => {
  const createdVenueIds: string[] = []
  const createdOrgIds: string[] = []
  const createdStaffIds: string[] = []

  async function cleanup() {
    if (createdVenueIds.length > 0) {
      await prisma.rawMaterialMovement.deleteMany({ where: { venueId: { in: createdVenueIds } } })
      await prisma.stockBatch.deleteMany({ where: { venueId: { in: createdVenueIds } } })
      await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { venueId: { in: createdVenueIds } } } })
      await prisma.purchaseOrder.deleteMany({ where: { venueId: { in: createdVenueIds } } })
      await prisma.supplier.deleteMany({ where: { venueId: { in: createdVenueIds } } })
      await prisma.rawMaterial.deleteMany({ where: { venueId: { in: createdVenueIds } } })
      await prisma.staffVenue.deleteMany({ where: { venueId: { in: createdVenueIds } } })
      await prisma.venue.deleteMany({ where: { id: { in: createdVenueIds } } })
    }

    if (createdStaffIds.length > 0) {
      await prisma.staffOrganization.deleteMany({ where: { staffId: { in: createdStaffIds } } })
      await prisma.staff.deleteMany({ where: { id: { in: createdStaffIds } } })
    }

    if (createdOrgIds.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } })
    }

    createdVenueIds.length = 0
    createdOrgIds.length = 0
    createdStaffIds.length = 0
  }

  beforeEach(async () => {
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function seedPurchaseOrder() {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const organization = await prisma.organization.create({
      data: {
        name: `PO Item Flow Org ${suffix}`,
        email: `po-flow-${suffix}@avoqado.test`,
        phone: '5550000000',
        type: 'RESTAURANT',
      },
    })
    createdOrgIds.push(organization.id)

    const venue = await prisma.venue.create({
      data: {
        organizationId: organization.id,
        name: `PO Item Flow Venue ${suffix}`,
        slug: `po-item-flow-${suffix}`,
        timezone: 'America/Mexico_City',
        currency: 'MXN',
      },
    })
    createdVenueIds.push(venue.id)

    const staff = await prisma.staff.create({
      data: {
        email: `po-flow-staff-${suffix}@avoqado.test`,
        firstName: 'PO',
        lastName: 'Tester',
        organizations: {
          create: {
            organizationId: organization.id,
            role: 'OWNER',
            isPrimary: true,
            isActive: true,
          },
        },
        venues: {
          create: {
            venueId: venue.id,
            role: 'OWNER',
            permissions: ['*:*'],
          },
        },
      },
    })
    createdStaffIds.push(staff.id)

    const supplier = await prisma.supplier.create({
      data: {
        venueId: venue.id,
        name: `Supplier ${suffix}`,
      },
    })

    const rawMaterial = await prisma.rawMaterial.create({
      data: {
        venueId: venue.id,
        name: `Carne QA ${suffix}`,
        sku: `CARNE-${suffix}`.slice(0, 60),
        category: 'MEAT',
        currentStock: new Decimal(0),
        unit: 'KILOGRAM',
        unitType: 'WEIGHT',
        minimumStock: new Decimal(0),
        reorderPoint: new Decimal(0),
        costPerUnit: new Decimal(5),
        avgCostPerUnit: new Decimal(5),
      },
    })

    const purchaseOrder = await prisma.purchaseOrder.create({
      data: {
        venueId: venue.id,
        supplierId: supplier.id,
        orderNumber: `PO-ITEM-FLOW-${suffix}`.slice(0, 80),
        status: PurchaseOrderStatus.CONFIRMED,
        orderDate: new Date(),
        subtotal: new Decimal(50),
        total: new Decimal(50),
        items: {
          create: {
            rawMaterialId: rawMaterial.id,
            quantityOrdered: new Decimal(10),
            quantityReceived: new Decimal(0),
            unit: 'KILOGRAM',
            unitPrice: new Decimal(5),
            total: new Decimal(50),
          },
        },
      },
      include: { items: true },
    })

    return {
      venue,
      staff,
      rawMaterial,
      purchaseOrder,
      item: purchaseOrder.items[0],
    }
  }

  it('receives incremental quantities into sequenced FIFO batches and can reverse them', async () => {
    const { venue, staff, rawMaterial, purchaseOrder, item } = await seedPurchaseOrder()

    await updatePurchaseOrderItemStatus(
      venue.id,
      purchaseOrder.id,
      item.id,
      { receiveStatus: PurchaseOrderItemStatus.RECEIVED, quantityReceived: 4 },
      staff.id,
    )
    await updatePurchaseOrderItemStatus(
      venue.id,
      purchaseOrder.id,
      item.id,
      { receiveStatus: PurchaseOrderItemStatus.RECEIVED, quantityReceived: 6 },
      staff.id,
    )

    const batchesAfterReceive = await prisma.stockBatch.findMany({
      where: { venueId: venue.id, rawMaterialId: rawMaterial.id },
      orderBy: { batchNumber: 'asc' },
    })
    expect(batchesAfterReceive).toHaveLength(2)
    expect(batchesAfterReceive[0].batchNumber).toMatch(/-001$/)
    expect(batchesAfterReceive[1].batchNumber).toMatch(/-002$/)
    expect(batchesAfterReceive.map(batch => batch.batchNumber).join(',')).not.toContain('NaN')
    expect(batchesAfterReceive[0].initialQuantity.toString()).toBe('4')
    expect(batchesAfterReceive[1].initialQuantity.toString()).toBe('2')

    const stockAfterReceive = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: rawMaterial.id } })
    expect(stockAfterReceive.currentStock.toString()).toBe('6')

    await updatePurchaseOrderItemStatus(venue.id, purchaseOrder.id, item.id, { receiveStatus: PurchaseOrderItemStatus.DAMAGED }, staff.id)

    const stockAfterReverse = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: rawMaterial.id } })
    expect(stockAfterReverse.currentStock.toString()).toBe('0')

    const batchesAfterReverse = await prisma.stockBatch.findMany({
      where: { venueId: venue.id, rawMaterialId: rawMaterial.id },
    })
    expect(batchesAfterReverse.every(batch => batch.status === BatchStatus.QUARANTINED)).toBe(true)
    expect(batchesAfterReverse.reduce((sum, batch) => sum.add(batch.remainingQuantity), new Decimal(0)).toString()).toBe('0')

    const movements = await prisma.rawMaterialMovement.findMany({
      where: { venueId: venue.id, rawMaterialId: rawMaterial.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(movements.map(movement => movement.type)).toEqual([
      RawMaterialMovementType.PURCHASE,
      RawMaterialMovementType.PURCHASE,
      RawMaterialMovementType.SPOILAGE,
    ])
    expect(movements[2].quantity.toString()).toBe('-6')
    expect(movements.every(movement => movement.createdBy === staff.id)).toBe(true)
  })

  it('blocks reversal below already-consumed batch quantity', async () => {
    const { venue, staff, rawMaterial, purchaseOrder, item } = await seedPurchaseOrder()

    await updatePurchaseOrderItemStatus(
      venue.id,
      purchaseOrder.id,
      item.id,
      { receiveStatus: PurchaseOrderItemStatus.RECEIVED, quantityReceived: 5 },
      staff.id,
    )

    const batch = await prisma.stockBatch.findFirstOrThrow({
      where: { venueId: venue.id, rawMaterialId: rawMaterial.id },
    })
    await prisma.stockBatch.update({
      where: { id: batch.id },
      data: { remainingQuantity: new Decimal(2) },
    })
    await prisma.rawMaterial.update({
      where: { id: rawMaterial.id },
      data: { currentStock: new Decimal(2) },
    })

    await expect(
      updatePurchaseOrderItemStatus(venue.id, purchaseOrder.id, item.id, { receiveStatus: PurchaseOrderItemStatus.DAMAGED }, staff.id),
    ).rejects.toThrow(/consumieron/i)

    const stockAfterRejectedReverse = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: rawMaterial.id } })
    expect(stockAfterRejectedReverse.currentStock.toString()).toBe('2')
  })
})
