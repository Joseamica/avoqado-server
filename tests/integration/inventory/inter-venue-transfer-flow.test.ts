import {
  FeatureCategory,
  InterVenueTransferMode,
  InterVenueTransferVarianceReason,
  Prisma,
  RawMaterialMovementType,
  Unit,
  UnitType,
} from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  approveInterVenueTransfer,
  createInterVenueTransfer,
  dispatchInterVenueTransfer,
  receiveInterVenueTransfer,
  resolveInterVenueTransferVariance,
} from '@/services/dashboard/interVenueTransfer.service'

describe('inter-venue raw-material transfer flow', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  let organizationId: string
  let sourceVenueId: string
  let destinationVenueId: string
  let sourceRawMaterialId: string
  let destinationRawMaterialId: string
  let featureId: string

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: { name: `Transfer Org ${suffix}`, email: `transfer-${suffix}@example.test`, phone: '+525500000000' },
    })
    organizationId = organization.id

    const [source, destination] = await Promise.all([
      prisma.venue.create({
        data: { organizationId, name: `Source ${suffix}`, slug: `transfer-source-${suffix}`, status: 'ACTIVE' },
      }),
      prisma.venue.create({
        data: { organizationId, name: `Destination ${suffix}`, slug: `transfer-destination-${suffix}`, status: 'ACTIVE' },
      }),
    ])
    sourceVenueId = source.id
    destinationVenueId = destination.id

    const feature = await prisma.feature.upsert({
      where: { code: 'INVENTORY_TRACKING' },
      update: {},
      create: { code: 'INVENTORY_TRACKING', name: `Inventory ${suffix}`, category: FeatureCategory.OPERATIONS, monthlyPrice: 0 },
    })
    featureId = feature.id
    await prisma.venueFeature.createMany({
      data: [
        { venueId: sourceVenueId, featureId, monthlyPrice: 0 },
        { venueId: destinationVenueId, featureId, monthlyPrice: 0 },
      ],
    })

    const [sourceMaterial, destinationMaterial] = await Promise.all([
      prisma.rawMaterial.create({
        data: {
          venueId: sourceVenueId,
          name: 'Harina origen',
          sku: `HARINA-ORIGEN-${suffix}`,
          unit: Unit.KILOGRAM,
          unitType: UnitType.WEIGHT,
          currentStock: 10,
          minimumStock: 0,
          reorderPoint: 0,
          costPerUnit: 4,
          avgCostPerUnit: 4,
        },
      }),
      prisma.rawMaterial.create({
        data: {
          venueId: destinationVenueId,
          name: 'Harina destino',
          sku: `HARINA-DESTINO-${suffix}`,
          unit: Unit.KILOGRAM,
          unitType: UnitType.WEIGHT,
          currentStock: 0,
          minimumStock: 0,
          reorderPoint: 0,
          costPerUnit: 0,
          avgCostPerUnit: 0,
        },
      }),
    ])
    sourceRawMaterialId = sourceMaterial.id
    destinationRawMaterialId = destinationMaterial.id

    await prisma.stockBatch.createMany({
      data: [
        {
          rawMaterialId: sourceRawMaterialId,
          venueId: sourceVenueId,
          batchNumber: `OLD-${suffix}`,
          initialQuantity: 3,
          remainingQuantity: 3,
          unit: Unit.KILOGRAM,
          costPerUnit: 2,
          receivedDate: new Date('2026-01-01T00:00:00Z'),
          expirationDate: new Date('2026-10-01T00:00:00Z'),
        },
        {
          rawMaterialId: sourceRawMaterialId,
          venueId: sourceVenueId,
          batchNumber: `NEW-${suffix}`,
          initialQuantity: 7,
          remainingQuantity: 7,
          unit: Unit.KILOGRAM,
          costPerUnit: 5,
          receivedDate: new Date('2026-02-01T00:00:00Z'),
          expirationDate: new Date('2026-11-01T00:00:00Z'),
        },
      ],
    })
  })

  afterAll(async () => {
    await prisma.interVenueTransfer.deleteMany({ where: { organizationId } })
    await prisma.venue.deleteMany({ where: { organizationId } })
    await prisma.organization.delete({ where: { id: organizationId } })
    // NO borrar el Feature: el beforeAll hace upsert por `code`, así que en cualquier
    // base con datos reales `featureId` es la fila COMPARTIDA de INVENTORY_TRACKING del
    // catálogo, no una creada por este test. Borrarla se llevaría el feature de la
    // plataforma (aquí sólo lo impidió la FK de VenueFeature). Los VenueFeature propios
    // ya se fueron en cascada al borrar los venues de la línea anterior.
    await prisma.$disconnect()
  })

  it('keeps concurrent retries idempotent and reconciles FIFO cost, expiry, stock, and ledger', async () => {
    const created = await createInterVenueTransfer(
      destinationVenueId,
      {
        mode: InterVenueTransferMode.PULL,
        sourceVenueId,
        destinationVenueId,
        items: [{ sourceRawMaterialId, destinationRawMaterialId, quantity: 5 }],
      },
      'staff-requester',
    )
    await approveInterVenueTransfer(sourceVenueId, created.id, 'staff-approver')
    const itemId = created.items[0].id

    const dispatchInput = { idempotencyKey: 'c1dd8201-7379-410d-bcca-d1984db33e90', items: [{ itemId, quantity: 5 }] }
    const dispatches = await Promise.allSettled([
      dispatchInterVenueTransfer(sourceVenueId, created.id, dispatchInput, 'staff-dispatcher'),
      dispatchInterVenueTransfer(sourceVenueId, created.id, dispatchInput, 'staff-dispatcher'),
    ])
    expect(dispatches.every(result => result.status === 'fulfilled')).toBe(true)

    const sourceAfterDispatch = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: sourceRawMaterialId } })
    expect(sourceAfterDispatch.currentStock.toString()).toBe('5')
    expect(await prisma.rawMaterialMovement.count({ where: { reference: created.id, type: RawMaterialMovementType.TRANSFER_OUT } })).toBe(2)

    const firstReceipt = {
      idempotencyKey: '3acd84bd-5a99-49b9-9592-6835810cb07b',
      items: [{ itemId, quantity: 3 }],
    }
    const receipts = await Promise.allSettled([
      receiveInterVenueTransfer(destinationVenueId, created.id, firstReceipt, 'staff-receiver'),
      receiveInterVenueTransfer(destinationVenueId, created.id, firstReceipt, 'staff-receiver'),
    ])
    expect(receipts.every(result => result.status === 'fulfilled')).toBe(true)
    expect(await prisma.interVenueTransferReceipt.count({ where: { transferId: created.id } })).toBe(1)

    const completed = await receiveInterVenueTransfer(
      destinationVenueId,
      created.id,
      { idempotencyKey: '2170ccf2-55a7-4c6d-9605-08461705b2be', items: [{ itemId, quantity: 2 }] },
      'staff-receiver',
    )
    expect(completed?.status).toBe('COMPLETED')

    const destinationAfterReceipt = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: destinationRawMaterialId } })
    expect(destinationAfterReceipt.currentStock.toString()).toBe('5')
    expect(destinationAfterReceipt.costPerUnit.toString()).toBe('5')
    expect(destinationAfterReceipt.avgCostPerUnit.toString()).toBe('3.2')
    expect(await prisma.rawMaterialMovement.count({ where: { reference: created.id, type: RawMaterialMovementType.TRANSFER_IN } })).toBe(2)

    const allocations = await prisma.interVenueTransferAllocation.findMany({
      where: { itemId },
      include: { destinationBatch: true },
      orderBy: { allocationOrder: 'asc' },
    })
    expect(allocations.map(allocation => [allocation.quantityDispatched.toString(), allocation.costPerUnit.toString()])).toEqual([
      ['3', '2'],
      ['2', '5'],
    ])
    expect(allocations.map(allocation => allocation.destinationBatch?.expirationDate?.toISOString())).toEqual([
      '2026-10-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
    ])
    const dispatchedValue = allocations.reduce(
      (sum, allocation) => sum.add(allocation.quantityDispatched.mul(allocation.costPerUnit)),
      new Prisma.Decimal(0),
    )
    expect(dispatchedValue.toString()).toBe('16')
  })

  it('does not let batch stock bypass a lower scalar stock balance', async () => {
    await prisma.rawMaterial.update({ where: { id: sourceRawMaterialId }, data: { currentStock: 0 } })
    const transfer = await createInterVenueTransfer(
      destinationVenueId,
      {
        mode: InterVenueTransferMode.PULL,
        sourceVenueId,
        destinationVenueId,
        items: [{ sourceRawMaterialId, destinationRawMaterialId, quantity: 1 }],
      },
      'staff-requester',
    )
    await approveInterVenueTransfer(sourceVenueId, transfer.id, 'staff-approver')

    await expect(
      dispatchInterVenueTransfer(
        sourceVenueId,
        transfer.id,
        { idempotencyKey: '9bdc2086-48d0-405f-bdbf-4aa22ceff03d', items: [{ itemId: transfer.items[0].id, quantity: 1 }] },
        'staff-dispatcher',
      ),
    ).rejects.toMatchObject({ statusCode: 409 })

    await prisma.rawMaterial.update({ where: { id: sourceRawMaterialId }, data: { currentStock: 5 } })
  })

  it('does not receive stock already resolved as an in-transit variance', async () => {
    const transfer = await createInterVenueTransfer(
      destinationVenueId,
      {
        mode: InterVenueTransferMode.PULL,
        sourceVenueId,
        destinationVenueId,
        items: [{ sourceRawMaterialId, destinationRawMaterialId, quantity: 3 }],
      },
      'staff-requester',
    )
    await approveInterVenueTransfer(sourceVenueId, transfer.id, 'staff-approver')
    const itemId = transfer.items[0].id
    await dispatchInterVenueTransfer(
      sourceVenueId,
      transfer.id,
      { idempotencyKey: '933b0942-920a-4109-8aca-ab736aa99e12', items: [{ itemId, quantity: 3 }] },
      'staff-dispatcher',
    )
    await resolveInterVenueTransferVariance(
      destinationVenueId,
      transfer.id,
      {
        idempotencyKey: '7dbc982e-bc53-4a60-80b0-dcab91168918',
        items: [{ itemId, quantity: 1, reason: InterVenueTransferVarianceReason.DAMAGED }],
      },
      'staff-receiver',
    )

    await expect(
      receiveInterVenueTransfer(
        destinationVenueId,
        transfer.id,
        { idempotencyKey: '3ab52269-4782-4057-a442-4325e84a94dc', items: [{ itemId, quantity: 3 }] },
        'staff-receiver',
      ),
    ).rejects.toMatchObject({ statusCode: 400 })

    const completed = await receiveInterVenueTransfer(
      destinationVenueId,
      transfer.id,
      { idempotencyKey: 'e4eb8ee7-a219-493c-b9fc-6f880a9455a3', items: [{ itemId, quantity: 2 }] },
      'staff-receiver',
    )
    expect(completed?.status).toBe('COMPLETED_WITH_VARIANCE')
  })

  it('rejects the operation when either venue loses entitlement', async () => {
    await prisma.venueFeature.update({
      where: { venueId_featureId: { venueId: destinationVenueId, featureId } },
      data: { active: false },
    })
    await expect(
      createInterVenueTransfer(
        destinationVenueId,
        {
          mode: InterVenueTransferMode.PULL,
          sourceVenueId,
          destinationVenueId,
          items: [{ sourceRawMaterialId, destinationRawMaterialId, quantity: 1 }],
        },
        'staff-requester',
      ),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})
