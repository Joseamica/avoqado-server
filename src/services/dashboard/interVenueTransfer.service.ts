import { createHash, randomUUID } from 'node:crypto'
import {
  BatchStatus,
  InterVenueTransferMode,
  InterVenueTransferStatus,
  InterVenueTransferVarianceReason,
  Prisma,
  RawMaterialMovementType,
  StaffRole,
  Unit,
} from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import AppError from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { withSerializableRetry } from '@/utils/serializableRetry'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  allocateDispatchFIFO,
  allocateReceiptFIFO,
  assertTransferQuantities,
  assertTransferTransition,
  calculateVarianceCostFIFO,
  deriveTransferCompletionStatus,
} from './interVenueTransfer.domain'

const TRANSFER_DETAIL_INCLUDE = Prisma.validator<Prisma.InterVenueTransferInclude>()({
  sourceVenue: { select: { id: true, name: true, operationalRole: true, salesEnabled: true } },
  destinationVenue: { select: { id: true, name: true, operationalRole: true, salesEnabled: true } },
  items: {
    orderBy: { createdAt: 'asc' },
    include: {
      sourceRawMaterial: { select: { id: true, name: true, sku: true, unit: true } },
      destinationRawMaterial: { select: { id: true, name: true, sku: true, unit: true } },
      allocations: {
        orderBy: { allocationOrder: 'asc' },
        include: {
          sourceBatch: { select: { batchNumber: true } },
          destinationBatch: { select: { batchNumber: true } },
        },
      },
    },
  },
  receipts: { orderBy: { receivedAt: 'asc' }, include: { lines: true } },
  varianceResolutions: { orderBy: { resolvedAt: 'asc' }, include: { lines: true } },
})

export interface CreateInterVenueTransferInput {
  mode: InterVenueTransferMode
  sourceVenueId: string
  destinationVenueId: string
  externalReference?: string
  notes?: string
  fiscalUuid?: string
  fiscalReference?: string
  items: Array<{
    sourceRawMaterialId: string
    destinationRawMaterialId: string
    quantity: Prisma.Decimal.Value
    notes?: string
  }>
}

export interface DispatchInterVenueTransferInput {
  idempotencyKey: string
  items: Array<{ itemId: string; quantity: Prisma.Decimal.Value; shortfallReason?: string }>
}

export interface ReceiveInterVenueTransferInput {
  idempotencyKey: string
  notes?: string
  items: Array<{ itemId: string; quantity: Prisma.Decimal.Value }>
}

export interface ResolveInterVenueTransferVarianceInput {
  idempotencyKey: string
  notes?: string
  items: Array<{
    itemId: string
    quantity: Prisma.Decimal.Value
    reason: InterVenueTransferVarianceReason
    notes?: string
  }>
}

type LockedBatch = {
  id: string
  remainingQuantity: Prisma.Decimal
  costPerUnit: Prisma.Decimal
  receivedDate: Date
  expirationDate: Date | null
}

type LockedRawMaterial = {
  id: string
  currentStock: Prisma.Decimal
  costPerUnit: Prisma.Decimal
  avgCostPerUnit: Prisma.Decimal
  unit: Unit
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function transferNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `TR-${date}-${randomUUID().slice(0, 8).toUpperCase()}`
}

async function assertTransferFeatureAccess(sourceVenueId: string, destinationVenueId: string): Promise<void> {
  const [sourceEnabled, destinationEnabled] = await Promise.all([
    venueHasFeatureAccess(sourceVenueId, 'INVENTORY_TRACKING'),
    venueHasFeatureAccess(destinationVenueId, 'INVENTORY_TRACKING'),
  ])
  if (!sourceEnabled || !destinationEnabled) {
    throw new AppError('El control de inventario debe estar habilitado en la sucursal de origen y en la de destino', 403)
  }
}

async function loadVenuePair(sourceVenueId: string, destinationVenueId: string) {
  if (sourceVenueId === destinationVenueId) throw new AppError('El origen y el destino deben ser sucursales distintas', 400)
  const venues = await prisma.venue.findMany({
    where: { id: { in: [sourceVenueId, destinationVenueId] }, active: true },
    select: { id: true, organizationId: true },
  })
  if (venues.length !== 2) throw new AppError('No se encontró una de las sucursales del traslado', 404)
  if (venues[0].organizationId !== venues[1].organizationId) {
    throw new AppError('Los traslados solo pueden realizarse dentro de la misma organización', 400)
  }
  await assertTransferFeatureAccess(sourceVenueId, destinationVenueId)
  return { organizationId: venues[0].organizationId }
}

async function lockTransfer(tx: Prisma.TransactionClient, transferId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "InterVenueTransfer" WHERE id = ${transferId} FOR UPDATE
  `
  if (rows.length === 0) throw new AppError('Traslado no encontrado', 404)
}

async function lockRawMaterial(tx: Prisma.TransactionClient, rawMaterialId: string, venueId: string): Promise<LockedRawMaterial> {
  const rows = await tx.$queryRaw<LockedRawMaterial[]>`
    SELECT id, "currentStock", "costPerUnit", "avgCostPerUnit", unit
    FROM "RawMaterial"
    WHERE id = ${rawMaterialId} AND "venueId" = ${venueId} AND "deletedAt" IS NULL
    FOR UPDATE
  `
  if (rows.length === 0) throw new AppError('Insumo del traslado no encontrado en la sucursal esperada', 404)
  return rows[0]
}

async function transferById(transferId: string) {
  return prisma.interVenueTransfer.findUnique({ where: { id: transferId }, include: TRANSFER_DETAIL_INCLUDE })
}

async function assertTransferContextFeatureAccess(
  contextVenueId: string,
  transferId: string,
  side: 'source' | 'destination' | 'either' = 'either',
) {
  const sideWhere =
    side === 'source'
      ? { sourceVenueId: contextVenueId }
      : side === 'destination'
        ? { destinationVenueId: contextVenueId }
        : { OR: [{ sourceVenueId: contextVenueId }, { destinationVenueId: contextVenueId }] }
  const transfer = await prisma.interVenueTransfer.findFirst({
    where: { id: transferId, ...sideWhere },
    select: { sourceVenueId: true, destinationVenueId: true },
  })
  if (!transfer) throw new AppError('Traslado no encontrado', 404)
  await assertTransferFeatureAccess(transfer.sourceVenueId, transfer.destinationVenueId)
  return transfer
}

export async function createInterVenueTransfer(contextVenueId: string, input: CreateInterVenueTransferInput, staffId: string) {
  if (input.items.length === 0) throw new AppError('El traslado debe contener al menos un insumo', 400)
  const expectedContext = input.mode === InterVenueTransferMode.PULL ? input.destinationVenueId : input.sourceVenueId
  if (contextVenueId !== expectedContext) {
    throw new AppError(
      input.mode === InterVenueTransferMode.PULL
        ? 'Una solicitud pull debe crearse desde la sucursal de destino'
        : 'Un envío push debe crearse desde la sucursal de origen',
      403,
    )
  }

  const { organizationId } = await loadVenuePair(input.sourceVenueId, input.destinationVenueId)
  const materialIds = [...new Set(input.items.flatMap(item => [item.sourceRawMaterialId, item.destinationRawMaterialId]))]
  const materials = await prisma.rawMaterial.findMany({
    where: { id: { in: materialIds }, deletedAt: null, active: true },
    select: { id: true, venueId: true, unit: true },
  })
  const byId = new Map(materials.map(material => [material.id, material]))

  const seenPairs = new Set<string>()
  for (const item of input.items) {
    assertTransferQuantities({ requested: item.quantity, dispatched: 0, received: 0, varianceResolved: 0 })
    const source = byId.get(item.sourceRawMaterialId)
    const destination = byId.get(item.destinationRawMaterialId)
    if (!source || source.venueId !== input.sourceVenueId)
      throw new AppError('El insumo de origen no pertenece a la sucursal de origen', 400)
    if (!destination || destination.venueId !== input.destinationVenueId) {
      throw new AppError('El insumo de destino no pertenece a la sucursal de destino', 400)
    }
    if (source.unit !== destination.unit) {
      throw new AppError('Los insumos vinculados deben usar exactamente la misma unidad base', 400)
    }
    const pair = `${source.id}:${destination.id}`
    if (seenPairs.has(pair)) throw new AppError('No se puede repetir el mismo insumo dentro del traslado', 400)
    seenPairs.add(pair)
  }

  const autoApproved = input.mode === InterVenueTransferMode.PUSH
  const transfer = await prisma.interVenueTransfer.create({
    data: {
      organizationId,
      number: transferNumber(),
      externalReference: input.externalReference,
      mode: input.mode,
      status: autoApproved ? InterVenueTransferStatus.APPROVED : InterVenueTransferStatus.REQUESTED,
      sourceVenueId: input.sourceVenueId,
      destinationVenueId: input.destinationVenueId,
      notes: input.notes,
      fiscalUuid: input.fiscalUuid,
      fiscalReference: input.fiscalReference,
      requestedByStaffId: staffId,
      approvedByStaffId: autoApproved ? staffId : undefined,
      approvedAt: autoApproved ? new Date() : undefined,
      items: {
        create: input.items.map(item => ({
          sourceRawMaterialId: item.sourceRawMaterialId,
          destinationRawMaterialId: item.destinationRawMaterialId,
          unit: byId.get(item.sourceRawMaterialId)!.unit,
          quantityRequested: new Decimal(item.quantity),
          notes: item.notes,
        })),
      },
    },
    include: TRANSFER_DETAIL_INCLUDE,
  })

  void logAction({
    staffId,
    venueId: contextVenueId,
    action: autoApproved ? 'INTER_VENUE_TRANSFER_PUSH_CREATED' : 'INTER_VENUE_TRANSFER_REQUESTED',
    entity: 'InterVenueTransfer',
    entityId: transfer.id,
    data: { number: transfer.number, sourceVenueId: input.sourceVenueId, destinationVenueId: input.destinationVenueId },
  })
  return transfer
}

export async function listInterVenueTransfers(
  contextVenueId: string,
  filters: { status?: InterVenueTransferStatus; direction?: 'incoming' | 'outgoing'; search?: string; page?: number; pageSize?: number },
) {
  const page = filters.page ?? 1
  const pageSize = Math.min(filters.pageSize ?? 50, 100)
  const venueScope: Prisma.InterVenueTransferWhereInput =
    filters.direction === 'incoming'
      ? { destinationVenueId: contextVenueId }
      : filters.direction === 'outgoing'
        ? { sourceVenueId: contextVenueId }
        : { OR: [{ sourceVenueId: contextVenueId }, { destinationVenueId: contextVenueId }] }
  const where: Prisma.InterVenueTransferWhereInput = {
    status: filters.status,
    AND: [
      venueScope,
      ...(filters.search
        ? [
            {
              OR: [
                { number: { contains: filters.search, mode: 'insensitive' as const } },
                { externalReference: { contains: filters.search, mode: 'insensitive' as const } },
              ],
            },
          ]
        : []),
    ],
  }

  const [items, total] = await Promise.all([
    prisma.interVenueTransfer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        sourceVenue: { select: { id: true, name: true, operationalRole: true } },
        destinationVenue: { select: { id: true, name: true, operationalRole: true } },
        _count: { select: { items: true, receipts: true } },
      },
    }),
    prisma.interVenueTransfer.count({ where }),
  ])
  return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
}

export async function getInterVenueTransfer(contextVenueId: string, transferId: string) {
  const transfer = await prisma.interVenueTransfer.findFirst({
    where: { id: transferId, OR: [{ sourceVenueId: contextVenueId }, { destinationVenueId: contextVenueId }] },
    include: TRANSFER_DETAIL_INCLUDE,
  })
  if (!transfer) throw new AppError('Traslado no encontrado', 404)
  await assertTransferFeatureAccess(transfer.sourceVenueId, transfer.destinationVenueId)
  return transfer
}

export async function approveInterVenueTransfer(sourceVenueId: string, transferId: string, staffId: string) {
  await assertTransferContextFeatureAccess(sourceVenueId, transferId, 'source')
  let changed = false
  await withSerializableRetry(async tx => {
    await lockTransfer(tx, transferId)
    const transfer = await tx.interVenueTransfer.findFirst({ where: { id: transferId, sourceVenueId } })
    if (!transfer) throw new AppError('Traslado no encontrado en la sucursal de origen', 404)
    if (transfer.status === InterVenueTransferStatus.APPROVED) return
    assertTransferTransition(transfer.status, 'APPROVE')
    await tx.interVenueTransfer.update({
      where: { id: transferId },
      data: { status: InterVenueTransferStatus.APPROVED, approvedByStaffId: staffId, approvedAt: new Date(), version: { increment: 1 } },
    })
    changed = true
  })
  if (changed) {
    void logAction({
      staffId,
      venueId: sourceVenueId,
      action: 'INTER_VENUE_TRANSFER_APPROVED',
      entity: 'InterVenueTransfer',
      entityId: transferId,
    })
  }
  return transferById(transferId)
}

export async function rejectInterVenueTransfer(sourceVenueId: string, transferId: string, reason: string, staffId: string) {
  await assertTransferContextFeatureAccess(sourceVenueId, transferId, 'source')
  let changed = false
  await withSerializableRetry(async tx => {
    await lockTransfer(tx, transferId)
    const transfer = await tx.interVenueTransfer.findFirst({ where: { id: transferId, sourceVenueId } })
    if (!transfer) throw new AppError('Traslado no encontrado en la sucursal de origen', 404)
    if (transfer.status === InterVenueTransferStatus.REJECTED) return
    assertTransferTransition(transfer.status, 'REJECT')
    await tx.interVenueTransfer.update({
      where: { id: transferId },
      data: {
        status: InterVenueTransferStatus.REJECTED,
        rejectedByStaffId: staffId,
        rejectedAt: new Date(),
        rejectionReason: reason,
        version: { increment: 1 },
      },
    })
    changed = true
  })
  if (changed) {
    void logAction({
      staffId,
      venueId: sourceVenueId,
      action: 'INTER_VENUE_TRANSFER_REJECTED',
      entity: 'InterVenueTransfer',
      entityId: transferId,
      data: { reason },
    })
  }
  return transferById(transferId)
}

export async function cancelInterVenueTransfer(contextVenueId: string, transferId: string, reason: string, staffId: string) {
  await assertTransferContextFeatureAccess(contextVenueId, transferId)
  let changed = false
  await withSerializableRetry(async tx => {
    await lockTransfer(tx, transferId)
    const transfer = await tx.interVenueTransfer.findFirst({
      where: { id: transferId, OR: [{ sourceVenueId: contextVenueId }, { destinationVenueId: contextVenueId }] },
    })
    if (!transfer) throw new AppError('Traslado no encontrado', 404)
    if (transfer.status === InterVenueTransferStatus.CANCELLED) return
    assertTransferTransition(transfer.status, 'CANCEL')
    await tx.interVenueTransfer.update({
      where: { id: transferId },
      data: {
        status: InterVenueTransferStatus.CANCELLED,
        cancelledByStaffId: staffId,
        cancelledAt: new Date(),
        cancellationReason: reason,
        version: { increment: 1 },
      },
    })
    changed = true
  })
  if (changed) {
    void logAction({
      staffId,
      venueId: contextVenueId,
      action: 'INTER_VENUE_TRANSFER_CANCELLED',
      entity: 'InterVenueTransfer',
      entityId: transferId,
      data: { reason },
    })
  }
  return transferById(transferId)
}

export async function dispatchInterVenueTransfer(
  sourceVenueId: string,
  transferId: string,
  input: DispatchInterVenueTransferInput,
  staffId: string,
) {
  await assertTransferContextFeatureAccess(sourceVenueId, transferId, 'source')
  const hash = requestHash(input.items)
  let replayed = false
  await withSerializableRetry(async tx => {
    await lockTransfer(tx, transferId)
    const transfer = await tx.interVenueTransfer.findFirst({
      where: { id: transferId, sourceVenueId },
      include: { items: true },
    })
    if (!transfer) throw new AppError('Traslado no encontrado en la sucursal de origen', 404)
    if (transfer.dispatchIdempotencyKey === input.idempotencyKey) {
      if (transfer.dispatchRequestHash !== hash) throw new AppError('La Idempotency-Key ya fue usada con otra salida', 409)
      replayed = true
      return
    }
    assertTransferTransition(transfer.status, 'DISPATCH')
    if (input.items.length !== transfer.items.length) throw new AppError('La salida debe indicar una cantidad para cada insumo', 400)

    const dispatchItems = new Map(input.items.map(item => [item.itemId, item]))
    if (dispatchItems.size !== transfer.items.length) throw new AppError('No se puede repetir un insumo en la salida', 400)

    for (const item of transfer.items) {
      const dispatchItem = dispatchItems.get(item.id)
      if (!dispatchItem) throw new AppError('La salida contiene un insumo ajeno al traslado', 400)
      const quantity = new Decimal(dispatchItem.quantity)
      assertTransferQuantities({ requested: item.quantityRequested, dispatched: quantity, received: 0, varianceResolved: 0 })
      if (!quantity.greaterThan(0)) throw new AppError('Cada cantidad enviada debe ser mayor que cero', 400)
      if (quantity.lessThan(item.quantityRequested) && !dispatchItem.shortfallReason?.trim()) {
        throw new AppError('Indica el motivo de la cantidad no despachada', 400)
      }

      const rawMaterial = await lockRawMaterial(tx, item.sourceRawMaterialId, sourceVenueId)
      if (new Decimal(rawMaterial.currentStock).lessThan(quantity)) {
        throw new AppError(
          `Existencia insuficiente para despachar el insumo ${item.sourceRawMaterialId}; revisa la conciliación entre existencias y lotes`,
          409,
        )
      }
      const batches = await tx.$queryRaw<LockedBatch[]>`
        SELECT id, "remainingQuantity", "costPerUnit", "receivedDate", "expirationDate"
        FROM "StockBatch"
        WHERE "rawMaterialId" = ${item.sourceRawMaterialId}
          AND "venueId" = ${sourceVenueId}
          AND status = 'ACTIVE'
          AND "remainingQuantity" > 0
        ORDER BY "receivedDate" ASC, id ASC
        FOR UPDATE
      `
      const allocations = allocateDispatchFIFO(batches, quantity)
      let stock = new Decimal(rawMaterial.currentStock)

      for (const [index, allocation] of allocations.entries()) {
        const previousStock = stock
        stock = stock.sub(allocation.quantity)
        await tx.stockBatch.update({
          where: { id: allocation.batchId },
          data: {
            remainingQuantity: allocation.remainingAfter,
            status: allocation.remainingAfter.equals(0) ? BatchStatus.DEPLETED : BatchStatus.ACTIVE,
            depletedAt: allocation.remainingAfter.equals(0) ? new Date() : null,
          },
        })
        await tx.interVenueTransferAllocation.create({
          data: {
            itemId: item.id,
            sourceBatchId: allocation.batchId,
            quantityDispatched: allocation.quantity,
            costPerUnit: allocation.costPerUnit,
            sourceReceivedDate: allocation.receivedDate,
            expirationDate: allocation.expirationDate,
            allocationOrder: index,
          },
        })
        await tx.rawMaterialMovement.create({
          data: {
            rawMaterialId: item.sourceRawMaterialId,
            venueId: sourceVenueId,
            batchId: allocation.batchId,
            type: RawMaterialMovementType.TRANSFER_OUT,
            quantity: allocation.quantity.neg(),
            unit: rawMaterial.unit,
            previousStock,
            newStock: stock,
            costImpact: allocation.quantity.mul(allocation.costPerUnit).neg(),
            reason: `Salida de traslado ${transfer.number}`,
            reference: transfer.id,
            createdBy: staffId,
          },
        })
      }
      await tx.rawMaterial.update({ where: { id: item.sourceRawMaterialId }, data: { currentStock: stock } })
      await tx.interVenueTransferItem.update({
        where: { id: item.id },
        data: { quantityDispatched: quantity, dispatchShortfallReason: dispatchItem.shortfallReason?.trim() || null },
      })
    }

    await tx.interVenueTransfer.update({
      where: { id: transferId },
      data: {
        status: InterVenueTransferStatus.IN_TRANSIT,
        dispatchedByStaffId: staffId,
        dispatchedAt: new Date(),
        dispatchIdempotencyKey: input.idempotencyKey,
        dispatchRequestHash: hash,
        version: { increment: 1 },
      },
    })
  })

  if (!replayed) {
    void logAction({
      staffId,
      venueId: sourceVenueId,
      action: 'INTER_VENUE_TRANSFER_DISPATCHED',
      entity: 'InterVenueTransfer',
      entityId: transferId,
      data: { idempotencyKey: input.idempotencyKey },
    })
  }
  return transferById(transferId)
}

function destinationBatchNumber(transferNumberValue: string, itemId: string, allocationOrder: number): string {
  return `${transferNumberValue}-${itemId.slice(-6).toUpperCase()}-A${String(allocationOrder + 1).padStart(3, '0')}`
}

export async function receiveInterVenueTransfer(
  destinationVenueId: string,
  transferId: string,
  input: ReceiveInterVenueTransferInput,
  staffId: string,
) {
  await assertTransferContextFeatureAccess(destinationVenueId, transferId, 'destination')
  const hash = requestHash({ items: input.items, notes: input.notes ?? null })
  let replayed = false
  await withSerializableRetry(async tx => {
    await lockTransfer(tx, transferId)
    const prior = await tx.interVenueTransferReceipt.findUnique({
      where: { transferId_idempotencyKey: { transferId, idempotencyKey: input.idempotencyKey } },
    })
    if (prior) {
      if (prior.requestHash !== hash) throw new AppError('La Idempotency-Key ya fue usada con otra recepción', 409)
      replayed = true
      return
    }

    const transfer = await tx.interVenueTransfer.findFirst({
      where: { id: transferId, destinationVenueId },
      include: {
        items: {
          include: {
            allocations: { orderBy: { allocationOrder: 'asc' } },
            varianceLines: { select: { quantity: true, reason: true } },
          },
        },
      },
    })
    if (!transfer) throw new AppError('Traslado no encontrado en la sucursal de destino', 404)
    assertTransferTransition(transfer.status, 'RECEIVE')
    if (input.items.length === 0) throw new AppError('La recepción debe contener al menos un insumo', 400)

    const receipt = await tx.interVenueTransferReceipt.create({
      data: {
        transferId,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        receivedByStaffId: staffId,
        notes: input.notes,
      },
    })
    const inputIds = new Set<string>()

    for (const receivedItem of input.items) {
      if (inputIds.has(receivedItem.itemId)) throw new AppError('No se puede repetir un insumo en la recepción', 400)
      inputIds.add(receivedItem.itemId)
      const item = transfer.items.find(candidate => candidate.id === receivedItem.itemId)
      if (!item) throw new AppError('La recepción contiene un insumo ajeno al traslado', 400)
      const quantity = new Decimal(receivedItem.quantity)
      const resolvedInTransit = item.varianceLines
        .filter(line => line.reason !== InterVenueTransferVarianceReason.NOT_DISPATCHED)
        .reduce((sum, line) => sum.add(line.quantity), new Decimal(0))
      const receiptLines = allocateReceiptFIFO(item.allocations, quantity, resolvedInTransit)
      const destinationRawMaterial = await lockRawMaterial(tx, item.destinationRawMaterialId, destinationVenueId)
      const previousMaterialStock = new Decimal(destinationRawMaterial.currentStock)
      let stock = previousMaterialStock
      let receiptValue = new Decimal(0)
      let latestCostPerUnit = new Decimal(destinationRawMaterial.costPerUnit)

      for (const receiptLine of receiptLines) {
        const allocation = item.allocations.find(candidate => candidate.id === receiptLine.allocationId)!
        const previousStock = stock
        stock = stock.add(receiptLine.quantity)
        receiptValue = receiptValue.add(receiptLine.quantity.mul(allocation.costPerUnit))
        latestCostPerUnit = allocation.costPerUnit
        let destinationBatchId = allocation.destinationBatchId

        if (destinationBatchId) {
          await tx.stockBatch.update({
            where: { id: destinationBatchId },
            data: {
              initialQuantity: { increment: receiptLine.quantity },
              remainingQuantity: { increment: receiptLine.quantity },
              status: BatchStatus.ACTIVE,
              depletedAt: null,
            },
          })
        } else {
          const batch = await tx.stockBatch.create({
            data: {
              rawMaterialId: item.destinationRawMaterialId,
              venueId: destinationVenueId,
              batchNumber: destinationBatchNumber(transfer.number, item.id, allocation.allocationOrder),
              initialQuantity: receiptLine.quantity,
              remainingQuantity: receiptLine.quantity,
              unit: item.unit,
              costPerUnit: allocation.costPerUnit,
              receivedDate: new Date(),
              expirationDate: allocation.expirationDate,
              status: BatchStatus.ACTIVE,
            },
          })
          destinationBatchId = batch.id
          await tx.interVenueTransferAllocation.update({ where: { id: allocation.id }, data: { destinationBatchId } })
        }

        await tx.interVenueTransferReceiptLine.create({
          data: { receiptId: receipt.id, allocationId: allocation.id, quantity: receiptLine.quantity },
        })
        await tx.interVenueTransferAllocation.update({
          where: { id: allocation.id },
          data: { quantityReceived: { increment: receiptLine.quantity } },
        })
        await tx.rawMaterialMovement.create({
          data: {
            rawMaterialId: item.destinationRawMaterialId,
            venueId: destinationVenueId,
            batchId: destinationBatchId,
            type: RawMaterialMovementType.TRANSFER_IN,
            quantity: receiptLine.quantity,
            unit: item.unit,
            previousStock,
            newStock: stock,
            costImpact: receiptLine.quantity.mul(allocation.costPerUnit),
            reason: `Recepción de traslado ${transfer.number}`,
            reference: transfer.id,
            createdBy: staffId,
          },
        })
      }

      const previousInventoryValue = previousMaterialStock.mul(destinationRawMaterial.avgCostPerUnit)
      const avgCostPerUnit = stock.greaterThan(0) ? previousInventoryValue.add(receiptValue).div(stock) : new Decimal(0)
      await tx.rawMaterial.update({
        where: { id: item.destinationRawMaterialId },
        data: { currentStock: stock, costPerUnit: latestCostPerUnit, avgCostPerUnit },
      })
      item.quantityReceived = new Decimal(item.quantityReceived).add(quantity)
      assertTransferQuantities({
        requested: item.quantityRequested,
        dispatched: item.quantityDispatched,
        received: item.quantityReceived,
        varianceResolved: item.quantityVarianceResolved,
      })
      await tx.interVenueTransferItem.update({ where: { id: item.id }, data: { quantityReceived: item.quantityReceived } })
    }

    const status = deriveTransferCompletionStatus(
      transfer.items.map(item => ({
        requested: item.quantityRequested,
        dispatched: item.quantityDispatched,
        received: item.quantityReceived,
        varianceResolved: item.quantityVarianceResolved,
      })),
    ) as InterVenueTransferStatus
    await tx.interVenueTransfer.update({
      where: { id: transferId },
      data: {
        status,
        completedAt:
          status === InterVenueTransferStatus.COMPLETED || status === InterVenueTransferStatus.COMPLETED_WITH_VARIANCE ? new Date() : null,
        version: { increment: 1 },
      },
    })
  })

  if (!replayed) {
    void logAction({
      staffId,
      venueId: destinationVenueId,
      action: 'INTER_VENUE_TRANSFER_RECEIVED',
      entity: 'InterVenueTransfer',
      entityId: transferId,
      data: { idempotencyKey: input.idempotencyKey },
    })
  }
  return transferById(transferId)
}

export async function resolveInterVenueTransferVariance(
  destinationVenueId: string,
  transferId: string,
  input: ResolveInterVenueTransferVarianceInput,
  staffId: string,
) {
  await assertTransferContextFeatureAccess(destinationVenueId, transferId, 'destination')
  const hash = requestHash({ items: input.items, notes: input.notes ?? null })
  let replayed = false
  await withSerializableRetry(async tx => {
    await lockTransfer(tx, transferId)
    const prior = await tx.interVenueTransferVarianceResolution.findUnique({
      where: { transferId_idempotencyKey: { transferId, idempotencyKey: input.idempotencyKey } },
    })
    if (prior) {
      if (prior.requestHash !== hash) throw new AppError('La Idempotency-Key ya fue usada con otra resolución', 409)
      replayed = true
      return
    }
    const transfer = await tx.interVenueTransfer.findFirst({
      where: { id: transferId, destinationVenueId },
      include: {
        items: {
          include: {
            allocations: { orderBy: { allocationOrder: 'asc' } },
            varianceLines: { select: { quantity: true, reason: true } },
          },
        },
      },
    })
    if (!transfer) throw new AppError('Traslado no encontrado en la sucursal de destino', 404)
    assertTransferTransition(transfer.status, 'RESOLVE_VARIANCE')
    if (input.items.length === 0) throw new AppError('La resolución debe contener al menos una diferencia', 400)

    const resolution = await tx.interVenueTransferVarianceResolution.create({
      data: {
        transferId,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        resolvedByStaffId: staffId,
        notes: input.notes,
      },
    })
    const inputIds = new Set<string>()

    for (const varianceItem of input.items) {
      if (inputIds.has(varianceItem.itemId)) throw new AppError('No se puede repetir un insumo en la resolución', 400)
      inputIds.add(varianceItem.itemId)
      const item = transfer.items.find(candidate => candidate.id === varianceItem.itemId)
      if (!item) throw new AppError('La resolución contiene un insumo ajeno al traslado', 400)
      const quantity = new Decimal(varianceItem.quantity)
      const nextResolved = new Decimal(item.quantityVarianceResolved).add(quantity)
      assertTransferQuantities({
        requested: item.quantityRequested,
        dispatched: item.quantityDispatched,
        received: item.quantityReceived,
        varianceResolved: nextResolved,
      })
      if (!quantity.greaterThan(0)) throw new AppError('La diferencia resuelta debe ser mayor que cero', 400)

      const priorNotDispatched = item.varianceLines
        .filter(line => line.reason === InterVenueTransferVarianceReason.NOT_DISPATCHED)
        .reduce((sum, line) => sum.add(line.quantity), new Decimal(0))
      const priorInTransit = item.varianceLines
        .filter(line => line.reason !== InterVenueTransferVarianceReason.NOT_DISPATCHED)
        .reduce((sum, line) => sum.add(line.quantity), new Decimal(0))
      let varianceCost = new Decimal(0)

      if (varianceItem.reason === InterVenueTransferVarianceReason.NOT_DISPATCHED) {
        const available = new Decimal(item.quantityRequested).sub(item.quantityDispatched).sub(priorNotDispatched)
        if (quantity.greaterThan(available)) {
          throw new AppError('La diferencia no despachada supera la cantidad pendiente de salida', 400)
        }
      } else {
        varianceCost = calculateVarianceCostFIFO(item.allocations, quantity, priorInTransit)
      }

      await tx.interVenueTransferVarianceLine.create({
        data: {
          resolutionId: resolution.id,
          itemId: item.id,
          quantity,
          reason: varianceItem.reason,
          costImpact: varianceCost,
          notes: varianceItem.notes,
        },
      })
      item.quantityVarianceResolved = nextResolved
      await tx.interVenueTransferItem.update({ where: { id: item.id }, data: { quantityVarianceResolved: nextResolved } })
    }

    const status = deriveTransferCompletionStatus(
      transfer.items.map(item => ({
        requested: item.quantityRequested,
        dispatched: item.quantityDispatched,
        received: item.quantityReceived,
        varianceResolved: item.quantityVarianceResolved,
      })),
    ) as InterVenueTransferStatus
    await tx.interVenueTransfer.update({
      where: { id: transferId },
      data: {
        status,
        completedAt: status === InterVenueTransferStatus.COMPLETED_WITH_VARIANCE ? new Date() : null,
        version: { increment: 1 },
      },
    })
  })

  if (!replayed) {
    void logAction({
      staffId,
      venueId: destinationVenueId,
      action: 'INTER_VENUE_TRANSFER_VARIANCE_RESOLVED',
      entity: 'InterVenueTransfer',
      entityId: transferId,
      data: { idempotencyKey: input.idempotencyKey },
    })
  }
  return transferById(transferId)
}

export async function getConsolidatedRawMaterialInventory(contextVenueId: string, staffId: string, search?: string) {
  const contextVenue = await prisma.venue.findUnique({ where: { id: contextVenueId }, select: { organizationId: true } })
  if (!contextVenue) throw new AppError('Sucursal no encontrada', 404)

  const [isSuperAdmin, isOwner, staffVenues] = await Promise.all([
    prisma.staffVenue.findFirst({ where: { staffId, active: true, role: StaffRole.SUPERADMIN }, select: { id: true } }),
    prisma.staffOrganization.findFirst({
      where: { staffId, organizationId: contextVenue.organizationId, isActive: true, role: 'OWNER' },
      select: { id: true },
    }),
    prisma.staffVenue.findMany({
      where: { staffId, active: true, venue: { organizationId: contextVenue.organizationId } },
      select: { venueId: true },
    }),
  ])
  const venueWhere =
    isSuperAdmin || isOwner ? { organizationId: contextVenue.organizationId } : { id: { in: staffVenues.map(row => row.venueId) } }
  const accessibleVenues = await prisma.venue.findMany({
    where: { ...venueWhere, active: true },
    select: {
      id: true,
      name: true,
      operationalRole: true,
      salesEnabled: true,
      rawMaterials: {
        where: { active: true, deletedAt: null, ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}) },
        select: { id: true, name: true, sku: true, unit: true, currentStock: true, reservedStock: true, reorderPoint: true },
        orderBy: { name: 'asc' },
      },
    },
    orderBy: { name: 'asc' },
  })
  const entitlementChecks = await Promise.all(
    accessibleVenues.map(async venue => ({ venue, enabled: await venueHasFeatureAccess(venue.id, 'INVENTORY_TRACKING') })),
  )
  const venues = entitlementChecks.filter(result => result.enabled).map(result => result.venue)

  // A SKU is only a mapping suggestion between venues, never an organization-wide
  // material identity. Return the per-venue records without fabricating cross-venue
  // totals that could merge unrelated raw materials sharing a SKU.
  return { venues }
}
