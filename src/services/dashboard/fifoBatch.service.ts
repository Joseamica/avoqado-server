import { Prisma, BatchStatus, RawMaterialMovementType, Unit } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'
import { logAction } from './activity-log.service'
import { areUnitsCompatible, convertUnit } from '../../utils/unitConversion'
import { withSerializableRetry } from '../../utils/serializableRetry'
import { retry, shouldRetryDbConnectionError } from '../../utils/retry'

/**
 * Generate unique batch number for a raw material
 * Format: BATCH-YYYYMMDD-XXX
 */
async function generateBatchNumber(venueId: string, rawMaterialId: string, client: Prisma.TransactionClient = prisma): Promise<string> {
  const today = new Date()
  const datePrefix = `BATCH-${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

  const lastBatch = await client.stockBatch.findFirst({
    where: {
      venueId,
      rawMaterialId,
      batchNumber: {
        startsWith: datePrefix,
      },
    },
    orderBy: {
      batchNumber: 'desc',
    },
  })

  if (!lastBatch) {
    return `${datePrefix}-001`
  }

  const batchNumberParts = lastBatch.batchNumber.split('-')
  const lastSequence = Number.parseInt(batchNumberParts[batchNumberParts.length - 1] ?? '0', 10)
  const nextSequence = String(lastSequence + 1).padStart(3, '0')
  return `${datePrefix}-${nextSequence}`
}

/**
 * Create a new stock batch (typically when receiving a purchase order)
 */
export async function createStockBatch(
  venueId: string,
  rawMaterialId: string,
  data: {
    purchaseOrderItemId?: string
    quantity: number
    unit: Unit
    costPerUnit: number
    receivedDate: Date
    expirationDate?: Date
  },
  staffId?: string,
  // Optional transaction client so callers can create the batch atomically with
  // the currentStock update + movement (see rawMaterial.service adjustStock).
  // Defaults to the module prisma client, so existing non-transactional callers
  // (createRawMaterial, purchaseOrder receiving) are unaffected.
  client: Prisma.TransactionClient = prisma,
  // When running inside an external transaction, skip the internal fire-and-forget
  // audit so a rolled-back batch never leaves a phantom STOCK_BATCH_CREATED log;
  // the caller logs it after commit instead.
  opts?: { skipAudit?: boolean },
): Promise<any> {
  // Verify raw material exists
  const rawMaterial = await client.rawMaterial.findFirst({
    where: {
      id: rawMaterialId,
      venueId,
    },
  })

  if (!rawMaterial) {
    throw new AppError(`Raw material with ID ${rawMaterialId} not found`, 404)
  }

  // INVARIANT: every batch is stored in the raw material's unit. Callers may
  // pass the inbound delivery in any compatible unit (a 1 KG bag for a raw
  // material kept in GRAM), but the batch row — and therefore costPerUnit —
  // is always normalized. This guarantees deductStockFIFO and
  // RawMaterial.currentStock stay consistent. Incompatible units (mass vs
  // volume) are rejected loudly rather than silently corrupting stock.
  if (data.unit !== rawMaterial.unit && !areUnitsCompatible(data.unit, rawMaterial.unit)) {
    throw new AppError(
      `Cannot create batch: unit ${data.unit} is incompatible with raw material "${rawMaterial.name}" stored in ${rawMaterial.unit}`,
      400,
    )
  }
  const normalizedQuantity = convertUnit(data.quantity, data.unit, rawMaterial.unit)
  // costPerUnit must be expressed per-rawMaterial-unit too, otherwise FIFO
  // cost tracking inverts. If the caller said "$10 per KG" but RM is GRAM,
  // we convert to "$0.01 per GRAM".
  const normalizedCostPerUnit =
    data.unit === rawMaterial.unit
      ? new Decimal(data.costPerUnit)
      : new Decimal(data.costPerUnit).mul(new Decimal(data.quantity)).div(normalizedQuantity)

  // Generate unique batch number
  const batchNumber = await generateBatchNumber(venueId, rawMaterialId, client)

  // Create batch
  const batch = await client.stockBatch.create({
    data: {
      venueId,
      rawMaterialId,
      purchaseOrderItemId: data.purchaseOrderItemId,
      batchNumber,
      initialQuantity: normalizedQuantity,
      remainingQuantity: normalizedQuantity,
      unit: rawMaterial.unit,
      costPerUnit: normalizedCostPerUnit,
      receivedDate: data.receivedDate,
      expirationDate: data.expirationDate,
      status: BatchStatus.ACTIVE,
    },
    include: {
      rawMaterial: {
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
        },
      },
      purchaseOrderItem: {
        select: {
          id: true,
          purchaseOrder: {
            select: {
              orderNumber: true,
            },
          },
        },
      },
    },
  })

  if (!opts?.skipAudit) {
    void logAction({
      staffId,
      venueId,
      action: 'STOCK_BATCH_CREATED',
      entity: 'StockBatch',
      entityId: batch.id,
      data: { batchNumber, rawMaterialId, quantity: data.quantity, costPerUnit: data.costPerUnit },
    })
  }

  return batch
}

/**
 * Get active batches for a raw material ordered by FIFO (oldest first)
 */
export async function getActiveBatchesFIFO(venueId: string, rawMaterialId: string): Promise<any[]> {
  const batches = await prisma.stockBatch.findMany({
    where: {
      venueId,
      rawMaterialId,
      status: BatchStatus.ACTIVE,
      remainingQuantity: {
        gt: 0,
      },
    },
    orderBy: {
      receivedDate: 'asc', // FIFO: oldest first
    },
    include: {
      rawMaterial: {
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
        },
      },
    },
  })

  return batches
}

/**
 * Type for locked stock batch (row-level locking)
 * Used with PostgreSQL FOR UPDATE to prevent race conditions
 */
type LockedStockBatch = {
  id: string
  remainingQuantity: Prisma.Decimal
  costPerUnit: Prisma.Decimal
  receivedDate: Date
  batchNumber: string
  unit: string
}

/**
 * Lock stock batches for FIFO allocation using PostgreSQL row-level locking
 *
 * ⚠️ CRITICAL: This prevents race conditions in concurrent order processing
 *
 * Uses FOR UPDATE NOWAIT to:
 * - Acquire exclusive lock on batch rows
 * - Fail fast if another transaction holds the lock
 * - Prevent double-allocation of same stock
 *
 * Pattern used by: Shopify, Stripe, GitHub for inventory/resource allocation
 *
 * @throws Error if batches are already locked (code 55P03 - lock_not_available)
 */
async function lockBatchesForAllocation(tx: Prisma.TransactionClient, rawMaterialId: string, venueId: string): Promise<LockedStockBatch[]> {
  // venueId en el WHERE: aislamiento multi-tenant a nivel de la función, no
  // solo del caller HTTP — un rawMaterialId ajeno no debe bloquear ni deducir
  // lotes de otro venue.
  return await tx.$queryRaw<LockedStockBatch[]>`
    SELECT
      id,
      "remainingQuantity",
      "costPerUnit",
      "receivedDate",
      "batchNumber",
      unit
    FROM "StockBatch"
    WHERE "rawMaterialId" = ${rawMaterialId}
      AND "venueId" = ${venueId}
      AND status = 'ACTIVE'
      AND "remainingQuantity" > 0
    ORDER BY "receivedDate" ASC
    FOR UPDATE NOWAIT
  `
}

/**
 * Calculate FIFO allocations from a list of batches (pure function)
 *
 * This is a pure calculation function - receives batches, returns allocations.
 * Used internally by both locked and non-locked allocation functions.
 */
function calculateFIFOAllocations(
  batches: Array<{
    id: string
    batchNumber: string
    remainingQuantity: Prisma.Decimal
    costPerUnit: Prisma.Decimal
  }>,
  quantityNeeded: number,
): {
  allocations: Array<{
    batchId: string
    batchNumber: string
    quantityToDeduct: Decimal
    costImpact: Decimal
    remainingAfter: Decimal
  }>
  remainingToAllocate: Decimal
  totalAvailable: Decimal
} {
  const allocations: Array<{
    batchId: string
    batchNumber: string
    quantityToDeduct: Decimal
    costImpact: Decimal
    remainingAfter: Decimal
  }> = []

  let remainingToAllocate = new Decimal(quantityNeeded)
  const totalAvailable = batches.reduce((sum, b) => sum.add(b.remainingQuantity), new Decimal(0))

  for (const batch of batches) {
    if (remainingToAllocate.lessThanOrEqualTo(0)) {
      break
    }

    const quantityFromThisBatch = Decimal.min(batch.remainingQuantity, remainingToAllocate)
    const costImpact = quantityFromThisBatch.mul(batch.costPerUnit)
    const remainingAfter = batch.remainingQuantity.sub(quantityFromThisBatch)

    allocations.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      quantityToDeduct: quantityFromThisBatch,
      costImpact,
      remainingAfter,
    })

    remainingToAllocate = remainingToAllocate.sub(quantityFromThisBatch)
  }

  return {
    allocations,
    remainingToAllocate,
    totalAvailable,
  }
}

/**
 * Allocate quantity from batches using FIFO method (legacy - without locking)
 *
 * ⚠️ WARNING: This function queries batches WITHOUT locking.
 * Use for read-only operations (cost calculations, reports).
 * For actual inventory deduction, use deductStockFIFO which includes locking.
 *
 * @deprecated Use deductStockFIFO for write operations
 */
export async function allocateStockFIFO(
  venueId: string,
  rawMaterialId: string,
  quantityNeeded: number,
): Promise<
  Array<{
    batchId: string
    batchNumber: string
    quantityToDeduct: Decimal
    costImpact: Decimal
    remainingAfter: Decimal
  }>
> {
  const batches = await getActiveBatchesFIFO(venueId, rawMaterialId)

  if (batches.length === 0) {
    throw new AppError(`No active batches available for raw material ${rawMaterialId}`, 400)
  }

  const result = calculateFIFOAllocations(batches, quantityNeeded)

  // Check if we could fulfill the entire quantity
  if (result.remainingToAllocate.greaterThan(0)) {
    throw new AppError(`Insufficient stock. Needed: ${quantityNeeded}, Available: ${result.totalAvailable.toNumber()}`, 400)
  }

  return result.allocations
}

/**
 * Deduct stock from batches using FIFO with row-level locking
 *
 * ✅ WORLD-CLASS PATTERN: Prevents race conditions using PostgreSQL row-level locks
 *
 * How it works:
 * 1. Start transaction with Serializable isolation
 * 2. Lock batch rows with FOR UPDATE NOWAIT (prevents concurrent access)
 * 3. Calculate FIFO allocations from locked batches
 * 4. Update batches and create movement records
 * 5. Commit (or rollback on error) - locks released automatically
 *
 * If another transaction holds locks:
 * - Throws immediately (NOWAIT) with error code 55P03
 * - Retried here via `withSerializableRetry` (see below)
 * - No waiting/blocking = better performance
 *
 * Used by: Shopify, Stripe, GitHub for inventory/resource allocation
 *
 * 🔴 EL REINTENTO VIVE EN QUIEN POSEE LA TRANSACCIÓN — nunca fuera de ella.
 *
 * Bug real (Mindform, 17-18 jul 2026): un cajero tocó "Cobrar" 3 veces en 8s;
 * cada toque corrió su propia pasada de deducción sobre los mismos insumos.
 * Postgres abortó las colisiones con P2034 ("write conflict or a deadlock.
 * Please retry your transaction") y el clasificador de payment.tpv.service las
 * clasificó 'UNKNOWN' → tumbó la orden. Una venta cancelada por un tropiezo de
 * milisegundos.
 *
 * Reintentar sólo es seguro en el nivel que es ATÓMICO: si el intento chocó,
 * Postgres deshizo TODO lo de esa transacción, así que el reintento rehace
 * exactamente lo que no pasó. Hay dos poseedores legítimos:
 *
 *   - deductStockFIFO (aquí): un solo insumo en su propia tx Serializable.
 *   - deductStockForRecipe: la receta COMPLETA en UNA tx Serializable, llamando
 *     a deductStockFIFOInTx por línea. Ahí el reintento de la receta entera es
 *     seguro porque ninguna línea commitea por separado (fase 3, 2026-08-13).
 *
 * Lo que sigue PROHIBIDO es reintentar un nivel que agrupa transacciones YA
 * commiteadas (p. ej. deductInventoryForProduct reintentando producto+modifiers):
 * eso descuenta doble.
 *
 * Sólo se reintentan conflictos TRANSITORIOS (P2034 / 40001 / 55P03). Falta de
 * stock real, insumo de otro venue y "sin lotes activos" siguen fallando en el
 * primer intento — el candado de inventario no se relaja.
 * Cubierto por tests/unit/services/dashboard/fifoBatch.deductRetry.test.ts
 *
 * @throws AppError(400) if insufficient stock
 * @throws ConflictError if the conflict persists after the bounded retries
 */
export async function deductStockFIFO(
  venueId: string,
  rawMaterialId: string,
  quantityToDeduct: number,
  movementType: RawMaterialMovementType,
  metadata: {
    reason?: string
    reference?: string
    createdBy?: string
    postingLineId?: string
  },
): Promise<any[]> {
  return await withSerializableRetry(
    async tx => deductStockFIFOInTx(tx, venueId, rawMaterialId, quantityToDeduct, movementType, metadata),
    {
      // Serializable lo fija withSerializableRetry — no se pasa aquí.
      timeoutMs: 10_000, // 10s max (evita transacciones largas)
      // 3 intentos con backoff 40ms → 80ms = ~120ms extra en el PEOR caso.
      // Presupuesto deliberadamente corto: esto vive en la ruta del cobro, y si
      // la terminal se cansa de esperar el cajero vuelve a picar "Cobrar" — que
      // es justo lo que genera la colisión que estamos resolviendo.
      maxRetries: 3,
      baseDelayMs: 40,
    },
  )
}

/**
 * Core FIFO deduction running against a CALLER-OWNED transaction client.
 *
 * Extraída de deductStockFIFO (fase 3, 2026-08-13) para que deductStockForRecipe
 * pueda deducir TODAS las líneas de una receta dentro de UNA sola transacción
 * Serializable (todo-o-nada). Quien llama es dueño de la transacción y del
 * reintento; esta función no abre ni una ni otro.
 *
 * Reglas para usarla:
 *   - `tx` DEBE ser una transacción Serializable (withSerializableRetry) — el
 *     FOR UPDATE NOWAIT de lockBatchesForAllocation lanza 55P03 bajo contención
 *     y el poseedor de la tx debe reintentarla completa.
 *   - No escribas nada ANTES en la misma tx que no pueda reintentarse junto.
 *
 * @throws AppError(404) raw material not found in this venue
 * @throws AppError(400) no active batches / insufficient stock
 */
export async function deductStockFIFOInTx(
  tx: Prisma.TransactionClient,
  venueId: string,
  rawMaterialId: string,
  quantityToDeduct: number,
  movementType: RawMaterialMovementType,
  metadata: {
    reason?: string
    reference?: string
    createdBy?: string
    postingLineId?: string
  },
): Promise<any[]> {
  // 0. El rawMaterial debe pertenecer al venue que deduce — venueId no es
  // decorativo. Sin esto, cualquier caller interno con un rawMaterialId
  // ajeno cruzaba tenants.
  const rawMaterial = await tx.rawMaterial.findFirst({
    where: { id: rawMaterialId, venueId },
  })

  if (!rawMaterial) {
    throw new AppError(`Raw material not found`, 404)
  }

  // 1. Lock batches FIRST (inside transaction) - prevents race conditions
  const lockedBatches = await lockBatchesForAllocation(tx, rawMaterialId, venueId)

  if (lockedBatches.length === 0) {
    throw new AppError(`No active batches available for raw material ${rawMaterialId}`, 400)
  }

  // 2. Calculate FIFO allocations from locked batches
  const result = calculateFIFOAllocations(lockedBatches, quantityToDeduct)

  if (result.remainingToAllocate.greaterThan(0)) {
    throw new AppError(`Insufficient stock. Needed: ${quantityToDeduct}, Available: ${result.totalAvailable.toNumber()}`, 400)
  }

  const movements: any[] = []
  let cumulativeStock = rawMaterial.currentStock

  // 4. Process each allocation (update batches + create movements)
  for (const allocation of result.allocations) {
    const previousStock = cumulativeStock
    const newStock = previousStock.sub(allocation.quantityToDeduct)
    cumulativeStock = newStock

    // Update batch remaining quantity
    await tx.stockBatch.update({
      where: { id: allocation.batchId },
      data: {
        remainingQuantity: allocation.remainingAfter,
        status: allocation.remainingAfter.equals(0) ? BatchStatus.DEPLETED : BatchStatus.ACTIVE,
        depletedAt: allocation.remainingAfter.equals(0) ? new Date() : undefined,
      },
    })

    // Create movement record for this batch allocation
    const movement = await tx.rawMaterialMovement.create({
      data: {
        rawMaterialId,
        venueId,
        batchId: allocation.batchId,
        type: movementType,
        quantity: allocation.quantityToDeduct.neg(), // Negative for deductions
        unit: rawMaterial.unit,
        previousStock,
        newStock,
        costImpact: allocation.costImpact.neg(), // Negative cost impact for deductions
        reason: metadata.reason,
        reference: metadata.reference,
        createdBy: metadata.createdBy,
        postingLineId: metadata.postingLineId ?? null,
      },
      include: {
        batch: {
          select: {
            batchNumber: true,
          },
        },
      },
    })

    movements.push(movement)
  }

  // 5. Update raw material total stock
  await tx.rawMaterial.update({
    where: { id: rawMaterialId },
    data: {
      currentStock: cumulativeStock,
    },
  })

  return movements
}

/**
 * Get batch details with remaining quantity
 */
export async function getBatch(venueId: string, batchId: string): Promise<any> {
  const batch = await prisma.stockBatch.findFirst({
    where: {
      id: batchId,
      venueId,
    },
    include: {
      rawMaterial: true,
      purchaseOrderItem: {
        include: {
          purchaseOrder: {
            select: {
              orderNumber: true,
              supplier: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      },
      movements: {
        orderBy: {
          createdAt: 'desc',
        },
        take: 10,
      },
    },
  })

  if (!batch) {
    throw new AppError(`Batch not found`, 404)
  }

  return batch
}

/**
 * Get all batches for a raw material
 */
export async function getBatchesForRawMaterial(
  venueId: string,
  rawMaterialId: string,
  filters?: {
    status?: BatchStatus
    includeExpired?: boolean
  },
): Promise<any[]> {
  const where: Prisma.StockBatchWhereInput = {
    venueId,
    rawMaterialId,
    ...(filters?.status && { status: filters.status }),
  }

  const batches = await prisma.stockBatch.findMany({
    where,
    orderBy: [
      { receivedDate: 'asc' },
      // Tiebreak by id: two batches received at the very same instant would come back in
      // arbitrary order, and a list whose order shifts between queries is indefensible in
      // front of an auditor (and starts dropping rows the moment someone paginates it).
      { id: 'asc' },
    ],
    include: {
      rawMaterial: {
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
        },
      },
      purchaseOrderItem: {
        select: {
          id: true,
          purchaseOrder: {
            select: {
              orderNumber: true,
            },
          },
        },
      },
    },
  })

  return batches
}

/**
 * Mark expired batches as EXPIRED status — and take their remaining quantity
 * OUT of RawMaterial.currentStock.
 *
 * INVARIANT: currentStock === Σ remainingQuantity de lotes ACTIVE. Un lote
 * EXPIRED ya no participa en deductStockFIFO, así que su remanente debe
 * descontarse del agregado (con movimiento SPOILAGE) o el dashboard mostrará
 * stock que no se puede vender. El remainingQuantity del lote se conserva
 * como registro de cuánto se perdió.
 *
 * Ejecutado por el cron diario `batch-expiration.job.ts`.
 */
export async function markExpiredBatches(venueId?: string): Promise<number> {
  const now = new Date()

  // Entry read of the batch-expiration cron — retried on transient connection
  // errors per .claude/rules/cron-jobs.md.
  const expiredBatches = await retry(
    () =>
      prisma.stockBatch.findMany({
        where: {
          ...(venueId && { venueId }),
          status: BatchStatus.ACTIVE,
          expirationDate: {
            lte: now,
          },
        },
        select: {
          id: true,
          venueId: true,
          rawMaterialId: true,
          batchNumber: true,
          unit: true,
          costPerUnit: true,
        },
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'batch-expiration.findExpiredBatches' },
  )

  let expiredCount = 0

  for (const batch of expiredBatches) {
    const didExpire = await prisma.$transaction(async tx => {
      // Claim condicional: si otro proceso ya lo expiró (o lo agotó una venta
      // concurrente), no tocamos el stock dos veces.
      const claimed = await tx.stockBatch.updateMany({
        where: { id: batch.id, status: BatchStatus.ACTIVE },
        data: { status: BatchStatus.EXPIRED },
      })
      if (claimed.count === 0) return false

      // Releer el remanente DENTRO de la tx: una deducción concurrente pudo
      // consumir parte del lote después del findMany inicial.
      const fresh = await tx.stockBatch.findUnique({
        where: { id: batch.id },
        select: { remainingQuantity: true },
      })
      const remaining = fresh?.remainingQuantity ?? new Decimal(0)
      if (remaining.lessThanOrEqualTo(0)) return true

      const rawMaterial = await tx.rawMaterial.findUnique({ where: { id: batch.rawMaterialId } })
      if (!rawMaterial) return true

      const previousStock = rawMaterial.currentStock
      const newStock = previousStock.sub(remaining)

      await tx.rawMaterial.update({
        where: { id: batch.rawMaterialId },
        data: { currentStock: newStock },
      })

      await tx.rawMaterialMovement.create({
        data: {
          rawMaterialId: batch.rawMaterialId,
          venueId: batch.venueId,
          batchId: batch.id,
          type: RawMaterialMovementType.SPOILAGE,
          quantity: remaining.neg(),
          unit: batch.unit,
          previousStock,
          newStock,
          costImpact: batch.costPerUnit.mul(remaining).neg(),
          reason: `Lote ${batch.batchNumber} caducado`,
          reference: batch.id,
        },
      })

      return true
    })

    if (didExpire) {
      expiredCount++
      logAction({
        venueId: batch.venueId,
        action: 'STOCK_BATCH_EXPIRED',
        entity: 'StockBatch',
        entityId: batch.id,
        data: { batchNumber: batch.batchNumber, rawMaterialId: batch.rawMaterialId },
      })
    }
  }

  return expiredCount
}

/**
 * Quarantine a batch (quality issue, damage, etc.)
 *
 * INVARIANT: currentStock === Σ remainingQuantity de lotes ACTIVE. Un lote
 * QUARANTINED sale de circulación FIFO, así que su remanente se descuenta del
 * agregado con un movimiento SPOILAGE por la cantidad real. El
 * remainingQuantity del lote se conserva como registro de cuánto quedó
 * retenido.
 */
export async function quarantineBatch(venueId: string, batchId: string, reason: string, staffId?: string): Promise<any> {
  // The reason is the line whoever audits this hold will read months from now; without it
  // the record explains nothing and the goods sit frozen "just because".
  const trimmedReason = reason?.trim()
  if (!trimmedReason) {
    throw new AppError('Escribe por qué se retiene el lote: es lo que un auditor va a leer.', 400)
  }

  const batch = await prisma.stockBatch.findFirst({
    where: {
      id: batchId,
      venueId,
    },
  })

  if (!batch) {
    throw new AppError('No encontramos ese lote en esta sucursal.', 404)
  }

  // Quarantining twice does not deduct twice (`wasActive` below guards that), but it would
  // leave a second audit-trail line, with a different reason, for a hold that already
  // existed — and whoever audits it would believe two separate events happened.
  if (batch.status === BatchStatus.QUARANTINED) {
    throw new AppError('Ese lote ya está retenido.', 409)
  }

  const wasActive = batch.status === BatchStatus.ACTIVE

  const updatedBatch = await prisma.$transaction(async tx => {
    const updated = await tx.stockBatch.update({
      where: { id: batchId },
      data: {
        status: BatchStatus.QUARANTINED,
      },
      include: {
        rawMaterial: true,
      },
    })

    // Releer el remanente dentro de la tx (una venta concurrente pudo consumirlo)
    const fresh = await tx.stockBatch.findUnique({
      where: { id: batchId },
      select: { remainingQuantity: true },
    })
    const remaining = fresh?.remainingQuantity ?? new Decimal(0)

    // Solo los lotes que estaban ACTIVE con remanente afectan el stock: un
    // lote DEPLETED/EXPIRED ya no contaba en currentStock.
    if (!wasActive || remaining.lessThanOrEqualTo(0)) {
      return updated
    }

    const previousStock = updated.rawMaterial.currentStock
    const newStock = previousStock.sub(remaining)

    await tx.rawMaterial.update({
      where: { id: batch.rawMaterialId },
      data: { currentStock: newStock },
    })

    await tx.rawMaterialMovement.create({
      data: {
        rawMaterialId: batch.rawMaterialId,
        venueId,
        batchId,
        type: RawMaterialMovementType.SPOILAGE,
        quantity: remaining.neg(),
        unit: batch.unit,
        previousStock,
        newStock,
        costImpact: batch.costPerUnit.mul(remaining).neg(),
        reason: `Lote retenido: ${trimmedReason}`,
        reference: batchId,
      },
    })

    return updated
  })

  void logAction({
    staffId,
    venueId,
    action: 'STOCK_BATCH_QUARANTINED',
    entity: 'StockBatch',
    entityId: batchId,
    data: { reason: trimmedReason, batchNumber: batch.batchNumber },
  })

  return updatedBatch
}

/**
 * Release a batch that was being held in quarantine.
 *
 * Without this, quarantining was a one-way trip: the batch stayed out of circulation
 * forever and the only way out was editing the database by hand. A quality hold is by
 * definition temporary — you hold it, someone inspects it, and it either gets released or
 * written off.
 *
 * INVARIANT: `currentStock === Σ remainingQuantity of ACTIVE batches`. Since the held batch
 * was NOT ACTIVE it contributed 0; turning it ACTIVE makes it contribute its remainder, so
 * the aggregate has to go up by exactly that remainder. That holds regardless of which
 * status it had before the quarantine — the status is derived from today's reality, not
 * from a history we don't keep:
 *   - already expired → EXPIRED, and it does NOT rejoin the aggregate (letting expired
 *                       goods back into circulation would be the worst possible ending for
 *                       this function)
 *   - no remainder    → DEPLETED, contributes 0
 *   - otherwise       → ACTIVE, its remainder comes back with a positive movement
 */
export async function releaseBatchFromQuarantine(venueId: string, batchId: string, reason: string, staffId?: string): Promise<any> {
  const trimmedReason = reason?.trim()
  if (!trimmedReason) {
    throw new AppError('Escribe por qué se libera el lote: es lo que un auditor va a leer.', 400)
  }

  const batch = await prisma.stockBatch.findFirst({ where: { id: batchId, venueId } })

  if (!batch) {
    throw new AppError('No encontramos ese lote en esta sucursal.', 404)
  }

  if (batch.status !== BatchStatus.QUARANTINED) {
    throw new AppError('Ese lote no está retenido, así que no hay nada que liberar.', 400)
  }

  return prisma.$transaction(async tx => {
    // Re-read inside the tx: anything could have happened between the read above and here.
    const fresh = await tx.stockBatch.findUnique({
      where: { id: batchId },
      select: { remainingQuantity: true, expirationDate: true, status: true },
    })

    if (!fresh || fresh.status !== BatchStatus.QUARANTINED) {
      throw new AppError('Ese lote ya no está retenido; alguien más lo movió.', 409)
    }

    const remaining = fresh.remainingQuantity ?? new Decimal(0)
    const hasExpired = Boolean(fresh.expirationDate && fresh.expirationDate <= new Date())
    const newStatus = hasExpired ? BatchStatus.EXPIRED : remaining.lessThanOrEqualTo(0) ? BatchStatus.DEPLETED : BatchStatus.ACTIVE

    const updated = await tx.stockBatch.update({
      where: { id: batchId },
      data: { status: newStatus },
      include: { rawMaterial: true },
    })

    // Only a batch coming back as ACTIVE with a remainder rejoins the aggregate.
    if (newStatus === BatchStatus.ACTIVE && remaining.greaterThan(0)) {
      const previousStock = updated.rawMaterial.currentStock
      const newStock = previousStock.add(remaining)

      await tx.rawMaterial.update({
        where: { id: batch.rawMaterialId },
        data: { currentStock: newStock },
      })

      await tx.rawMaterialMovement.create({
        data: {
          rawMaterialId: batch.rawMaterialId,
          venueId,
          batchId,
          type: RawMaterialMovementType.ADJUSTMENT,
          quantity: remaining,
          unit: batch.unit,
          previousStock,
          newStock,
          costImpact: batch.costPerUnit.mul(remaining),
          reason: `Lote liberado de cuarentena: ${trimmedReason}`,
          reference: batchId,
        },
      })
    }

    void logAction({
      staffId,
      venueId,
      action: 'STOCK_BATCH_RELEASED',
      entity: 'StockBatch',
      entityId: batchId,
      data: {
        reason: trimmedReason,
        batchNumber: batch.batchNumber,
        // These two keys stay in Spanish on purpose: they are the payload an operator reads
        // in the audit screen, and a test outside this file already asserts on them.
        estadoResultante: newStatus,
        regresoAlInventario: newStatus === BatchStatus.ACTIVE && remaining.greaterThan(0),
      },
    })

    return updated
  })
}

/**
 * Get batch statistics for reporting
 */
export async function getBatchStatistics(venueId: string, rawMaterialId?: string) {
  const where: Prisma.StockBatchWhereInput = {
    venueId,
    ...(rawMaterialId && { rawMaterialId }),
  }

  const [totalBatches, activeBatches, depletedBatches, expiredBatches, quarantinedBatches] = await Promise.all([
    prisma.stockBatch.count({ where }),
    prisma.stockBatch.count({ where: { ...where, status: BatchStatus.ACTIVE } }),
    prisma.stockBatch.count({ where: { ...where, status: BatchStatus.DEPLETED } }),
    prisma.stockBatch.count({ where: { ...where, status: BatchStatus.EXPIRED } }),
    prisma.stockBatch.count({ where: { ...where, status: BatchStatus.QUARANTINED } }),
  ])

  const totalValue = await prisma.stockBatch.aggregate({
    where: { ...where, status: BatchStatus.ACTIVE },
    _sum: {
      remainingQuantity: true,
    },
  })

  return {
    totalBatches,
    statusBreakdown: {
      active: activeBatches,
      depleted: depletedBatches,
      expired: expiredBatches,
      quarantined: quarantinedBatches,
    },
    totalRemainingQuantity: totalValue._sum.remainingQuantity?.toNumber() || 0,
  }
}

/**
 * Calculate weighted average cost across all active batches for a raw material
 */
export async function calculateWeightedAverageCost(venueId: string, rawMaterialId: string): Promise<number> {
  const activeBatches = await getActiveBatchesFIFO(venueId, rawMaterialId)

  if (activeBatches.length === 0) {
    return 0
  }

  let totalCost = new Decimal(0)
  let totalQuantity = new Decimal(0)

  for (const batch of activeBatches) {
    const batchValue = batch.remainingQuantity.mul(batch.costPerUnit)
    totalCost = totalCost.add(batchValue)
    totalQuantity = totalQuantity.add(batch.remainingQuantity)
  }

  if (totalQuantity.equals(0)) {
    return 0
  }

  return totalCost.div(totalQuantity).toNumber()
}

/**
 * Get the costing method for a venue from its settings
 */
export async function getVenueCostingMethod(venueId: string): Promise<'FIFO' | 'WEIGHTED_AVERAGE' | 'STANDARD_COST'> {
  const settings = await prisma.venueSettings.findUnique({
    where: { venueId },
    select: { costingMethod: true },
  })

  return settings?.costingMethod || 'FIFO'
}

/**
 * Calculate cost impact for a quantity using the venue's costing method.
 * `quantity` MUST be expressed in the raw material's storage unit. If callers
 * have a recipe-side quantity in a different unit (e.g. KILOGRAM for a GRAM
 * raw material), convert with toRawMaterialUnit() first — otherwise STANDARD_COST
 * and WEIGHTED_AVERAGE silently return 1000× wrong totals.
 */
export async function calculateCostImpact(
  venueId: string,
  rawMaterialId: string,
  quantity: number,
  costingMethod?: 'FIFO' | 'WEIGHTED_AVERAGE' | 'STANDARD_COST',
): Promise<Decimal> {
  // Get costing method from venue settings if not provided
  const method = costingMethod || (await getVenueCostingMethod(venueId))

  const rawMaterial = await prisma.rawMaterial.findUnique({
    where: { id: rawMaterialId },
  })

  if (!rawMaterial) {
    throw new AppError('Raw material not found', 404)
  }

  switch (method) {
    case 'FIFO': {
      // For FIFO, we need to allocate from batches to get actual costs
      const allocations = await allocateStockFIFO(venueId, rawMaterialId, quantity)
      return allocations.reduce((sum, alloc) => sum.add(alloc.costImpact), new Decimal(0))
    }

    case 'WEIGHTED_AVERAGE': {
      // Calculate weighted average cost across all active batches
      const avgCost = await calculateWeightedAverageCost(venueId, rawMaterialId)
      return new Decimal(quantity).mul(avgCost)
    }

    case 'STANDARD_COST': {
      // Use the standard cost from raw material
      return new Decimal(quantity).mul(rawMaterial.costPerUnit)
    }

    default:
      throw new AppError(`Unknown costing method: ${method}`, 400)
  }
}
