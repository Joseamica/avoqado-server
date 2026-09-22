import { createHash } from 'crypto'
import { InventoryWasteReport, Prisma, StaffRole, Unit, WasteCostState, WasteItemType, WasteSource } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError'
import { withSerializableRetry } from '../../utils/serializableRetry'
import { BatchAllocationOrder, calculateFIFOAllocations, deductStockFIFOInTx, lockWasteBatchesInTx } from '../dashboard/fifoBatch.service'
import { adjustInventoryStockInTx } from '../dashboard/productInventory.service'
import { getUserAccess, hasPermission, UserAccess } from '../access/access.service'
import { resolveUserRoleForVenue } from '../../middlewares/checkPermission.middleware'
import { isWasteReasonCode, WasteReasonCode, WASTE_REASONS } from './wasteReasons'

const Decimal = Prisma.Decimal.clone({
  precision: 48,
  rounding: Prisma.Decimal.ROUND_HALF_UP,
})

const KEY_CONSTRAINT = 'InventoryWasteReport_venueId_idempotencyKey_key'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface WasteInput {
  itemType: WasteItemType
  itemId: string
  quantity: string | number | Prisma.Decimal
  unit: string
  reasonCode: WasteReasonCode
  idempotencyKey: string
  source: WasteSource
  note?: string
  reference?: string
  unitCost?: string | number | Prisma.Decimal
  supplier?: string
  clientOccurredAt?: Date
}

export interface WasteSummary {
  reportId: string
  declared: string
  deducted: string
  unrecorded: string
}

export type VoidWasteResult =
  | {
      outcome: 'VOIDED'
      voidedByStaffId: string
      voidedAt: string
    }
  | {
      outcome: 'ALREADY_APPLIED'
      report?: WasteSummary
    }

type ReportClient = Pick<Prisma.TransactionClient, 'inventoryWasteReport'>

type LockedRawMaterial = {
  id: string
  currentStock: Prisma.Decimal
  unit: Unit
}

type LockedProduct = {
  id: string
  inventoryId: string
  currentStock: Prisma.Decimal
  lastCountedAt: Date | null
  unit: string
  cost: Prisma.Decimal | null
}

function numericError(): ValidationError {
  return new ValidationError('La cantidad o su valoración no cabe en la precisión permitida.', 'QUANTITY_TOO_LARGE')
}

function decimal(value: string | number | Prisma.Decimal): Prisma.Decimal {
  try {
    const result = new Decimal(value)
    if (!result.isFinite()) throw numericError()
    return result
  } catch {
    throw numericError()
  }
}

function checkedMoney(value: Prisma.Decimal, integerDigits: number, scale: number): Prisma.Decimal {
  const rounded = new Decimal(value).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP)
  if (!rounded.isFinite() || rounded.isNegative() || rounded.greaterThanOrEqualTo(new Decimal(10).pow(integerDigits))) {
    throw numericError()
  }
  return rounded
}

export function normalizeWasteKey(key: string): string {
  if (!UUID.test(key)) {
    throw new ValidationError('El folio debe ser un UUID.', 'INVALID_WASTE_KEY')
  }
  return key.toLowerCase()
}

export function prepareWaste(actorStaffId: string, input: WasteInput) {
  const idempotencyKey = normalizeWasteKey(input.idempotencyKey)
  let quantity = decimal(input.quantity)
  const maximum = input.source === 'DASHBOARD' ? '999999999.999' : '999999.999'

  if (quantity.lte(0) || quantity.gt(maximum)) throw numericError()

  if (input.source === 'DASHBOARD') {
    // El contrato legacy dejaba a numeric(12,3) aplicar este redondeo.
    quantity = quantity.toDecimalPlaces(3, Decimal.ROUND_HALF_UP)
  } else if (quantity.decimalPlaces() > 3) {
    throw numericError()
  }

  if (quantity.lt('0.001')) throw numericError()

  if (!input.itemId || !input.unit || input.unit.length > 64) {
    throw new ValidationError('Artículo o unidad inválidos.', 'INVALID_WASTE_PAYLOAD')
  }
  if (input.itemType !== 'RAW_MATERIAL' && input.itemType !== 'PRODUCT') {
    throw new ValidationError('Tipo de artículo inválido.', 'INVALID_WASTE_PAYLOAD')
  }
  if (!isWasteReasonCode(input.reasonCode)) {
    throw new ValidationError('Motivo inválido.', 'INVALID_WASTE_REASON')
  }
  if (input.source === 'POS' && !WASTE_REASONS[input.reasonCode].pos) {
    throw new ValidationError('Este motivo no está disponible en el POS.', 'INVALID_WASTE_REASON')
  }
  if (input.reasonCode === 'UNSPECIFIED' && input.source !== 'DASHBOARD') {
    throw new ValidationError('Debes elegir un motivo.', 'INVALID_WASTE_REASON')
  }

  const note = input.note ?? null
  if (input.source !== 'DASHBOARD' && note !== null && note.length > 280) {
    throw new ValidationError('La nota admite hasta 280 caracteres.', 'INVALID_WASTE_PAYLOAD')
  }
  if (input.reasonCode === 'OTHER' && !note?.trim()) {
    throw new ValidationError('Escribe una nota para el motivo Otro.', 'INVALID_WASTE_REASON')
  }
  if (input.clientOccurredAt && !Number.isFinite(input.clientOccurredAt.getTime())) {
    throw new ValidationError('Fecha inválida.', 'INVALID_WASTE_PAYLOAD')
  }

  const suppliedCost = input.unitCost === undefined ? null : decimal(input.unitCost)
  const unitCost = suppliedCost === null ? null : checkedMoney(suppliedCost, 8, 2)
  const reference = input.reference ?? null
  const supplier = input.supplier ?? null

  // JSON distingue los campos sin colisiones por separadores dentro de una nota.
  const payloadHash = createHash('sha256')
    .update(
      JSON.stringify([
        actorStaffId,
        input.itemType,
        input.itemId,
        quantity.toFixed(3),
        input.unit,
        input.reasonCode,
        note,
        reference,
        suppliedCost?.toString() ?? null,
        supplier,
      ]),
    )
    .digest('hex')

  return {
    ...input,
    idempotencyKey,
    quantity,
    note,
    reference,
    supplier,
    unitCost,
    payloadHash,
  }
}

export function wasteSummary(report: InventoryWasteReport): WasteSummary {
  if (report.status !== 'APPLIED' || report.declaredQuantity === null) {
    throw new Error('El reporte aplicado no satisface su contrato persistido.')
  }
  return {
    reportId: report.id,
    declared: report.declaredQuantity.toString(),
    deducted: report.deductedQuantity.toString(),
    unrecorded: report.unrecordedQuantity.toString(),
  }
}

export async function recoverByKey(
  venueId: string,
  key: string,
  actorStaffId: string,
  payloadHash: string,
  client: ReportClient = prisma,
): Promise<WasteSummary | null> {
  const report = await client.inventoryWasteReport.findUnique({
    where: {
      venueId_idempotencyKey: {
        venueId,
        idempotencyKey: normalizeWasteKey(key),
      },
    },
  })

  if (!report) return null
  if (report.status === 'VOIDED') {
    throw new ConflictError('Este folio fue anulado.', 'WASTE_VOIDED')
  }
  if (report.reportedByStaffId === actorStaffId && report.payloadHash === payloadHash) {
    return wasteSummary(report)
  }

  throw new ConflictError('El folio ya fue utilizado.', 'IDEMPOTENCY_KEY_REUSED')
}

export function isWasteKeyCollision(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false
  }

  const meta = error.meta
  const descriptor = meta?.constraint ?? meta?.target
  if (descriptor === KEY_CONSTRAINT) return true
  if (Array.isArray(descriptor) && descriptor.length === 1 && descriptor[0] === KEY_CONSTRAINT) {
    return true
  }

  const target = meta?.target
  return (
    meta?.modelName === 'InventoryWasteReport' &&
    Array.isArray(target) &&
    target.length === 2 &&
    target.includes('venueId') &&
    target.includes('idempotencyKey')
  )
}

async function serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await withSerializableRetry(operation)
  } catch (error) {
    if (error instanceof ConflictError && !error.code) {
      throw new ConflictError('Hubo un conflicto de inventario. Reintenta con el mismo folio.', 'WASTE_RETRYABLE_CONFLICT')
    }
    throw error
  }
}

export async function getWasteAccess(staffId: string, venueId: string): Promise<UserAccess> {
  const { role } = await resolveUserRoleForVenue({ userId: staffId, targetVenueId: venueId })
  if (!role) throw new ForbiddenError('Ya no tienes acceso a este establecimiento.')
  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    select: { active: true },
  })
  if (!staff?.active) throw new ForbiddenError('La cuenta ya no está activa.')
  return getUserAccess(staffId, venueId)
}

export function hasWastePermission(access: UserAccess, permission: string): boolean {
  if (access.role !== StaffRole.SUPERADMIN && access.whiteLabelEnabled && !access.featureAccess.AVOQADO_INVENTORY?.allowed) {
    return false
  }
  return hasPermission(access, permission)
}

export async function requireWastePermission(staffId: string, venueId: string, permission: string): Promise<UserAccess> {
  const access = await getWasteAccess(staffId, venueId)
  if (!hasWastePermission(access, permission)) {
    throw new ForbiddenError('No tienes permiso para esta operación de inventario.')
  }
  return access
}

async function audit(
  tx: Prisma.TransactionClient,
  report: InventoryWasteReport,
  action: 'INVENTORY_WASTE_LOGGED' | 'INVENTORY_WASTE_VOIDED',
): Promise<void> {
  const venue = await tx.venue.findUniqueOrThrow({
    where: { id: report.venueId },
    select: { organizationId: true },
  })

  // logAction es externo a esta transacción y absorbe errores; aquí la auditoría es obligatoria.
  await tx.activityLog.create({
    data: {
      staffId: report.reportedByStaffId,
      actorStaffId: report.reportedByStaffId,
      actorType: 'HUMAN',
      venueId: report.venueId,
      organizationId: venue.organizationId,
      action,
      entity: 'InventoryWasteReport',
      entityId: report.id,
      createdAt: report.createdAt,
      data: {
        source: report.source,
        declared: report.declaredQuantity?.toString() ?? null,
        deducted: report.deductedQuantity.toString(),
        unrecorded: report.unrecordedQuantity.toString(),
        costImpact: report.costImpact?.toString() ?? null,
        costState: report.costState,
      },
    },
  })
}

export async function logWaste(venueId: string, actorStaffId: string, input: WasteInput): Promise<WasteSummary> {
  const payload = prepareWaste(actorStaffId, input)

  try {
    return await serializable(async tx => {
      const recovered = await recoverByKey(venueId, payload.idempotencyKey, actorStaffId, payload.payloadHash, tx)
      if (recovered) return recovered

      let raw: LockedRawMaterial | undefined
      let product: LockedProduct | undefined
      let byBatches = new Decimal(0)
      let withoutBatches = new Decimal(0)
      let deducted = new Decimal(0)
      let valuedQuantity = new Decimal(0)
      let cost = new Decimal(0)
      let snapshot: Prisma.Decimal | null = null
      const order: BatchAllocationOrder = payload.reasonCode === 'EXPIRED' ? 'FEFO' : 'FIFO'

      if (payload.itemType === 'RAW_MATERIAL') {
        const rows = await tx.$queryRaw<LockedRawMaterial[]>`
          SELECT id, "currentStock", unit
          FROM "RawMaterial"
          WHERE id = ${payload.itemId}
            AND "venueId" = ${venueId}
            AND (
              ${payload.source === 'DASHBOARD'}
              OR (active = TRUE AND "deletedAt" IS NULL)
            )
          FOR UPDATE
        `
        raw = rows[0]
        if (!raw) throw new NotFoundError('Artículo no encontrado.', 'ITEM_NOT_FOUND')
        if (raw.unit !== payload.unit) {
          throw new ConflictError('La unidad del artículo cambió.', 'UNIT_MISMATCH')
        }

        const batches = await lockWasteBatchesInTx(tx, venueId, raw.id, order)
        const available = batches.reduce((sum, batch) => sum.add(batch.remainingQuantity), new Decimal(0))
        const stock = Decimal.max(0, raw.currentStock)
        byBatches = Decimal.min(payload.quantity, stock, available)

        if (byBatches.gt(0)) {
          const allocations = calculateFIFOAllocations(batches, byBatches)
          const usedIds = new Set(allocations.allocations.map(allocation => allocation.batchId))
          if (batches.some(batch => usedIds.has(batch.id) && batch.unit !== raw?.unit)) {
            throw new ConflictError('La unidad de un lote no coincide.', 'UNIT_MISMATCH')
          }
          if (allocations.remainingToAllocate.gt(0)) {
            throw new ConflictError('Cambió la disponibilidad.', 'WASTE_RETRYABLE_CONFLICT')
          }

          // Cada movimiento se guarda en numeric(10,4), no en la precisión de la cabecera.
          for (const allocation of allocations.allocations) {
            cost = cost.add(checkedMoney(allocation.costImpact, 6, 4))
          }
          valuedQuantity = byBatches
        }

        withoutBatches = Decimal.min(payload.quantity.sub(byBatches), Decimal.max(0, new Decimal(raw.currentStock).sub(byBatches)))
        deducted = byBatches.add(withoutBatches)
      } else {
        const rows = await tx.$queryRaw<LockedProduct[]>`
          SELECT p.id, i.id AS "inventoryId", i."currentStock", i."lastCountedAt",
                 COALESCE(p.unit::text, 'UNIT') AS unit, p.cost
          FROM "Product" p
          INNER JOIN "Inventory" i
            ON i."productId" = p.id AND i."venueId" = p."venueId"
          WHERE p.id = ${payload.itemId}
            AND p."venueId" = ${venueId}
            AND p."trackInventory" = TRUE
            AND p."inventoryMethod" = 'QUANTITY'
            AND (
              ${payload.source === 'DASHBOARD'}
              OR (p.active = TRUE AND p."deletedAt" IS NULL)
            )
          FOR UPDATE OF p, i
        `
        product = rows[0]
        if (!product) throw new NotFoundError('Artículo no encontrado.', 'ITEM_NOT_FOUND')
        if (product.unit !== payload.unit) {
          throw new ConflictError('La unidad del artículo cambió.', 'UNIT_MISMATCH')
        }

        deducted = product.currentStock.lt(0) ? new Decimal(0) : Decimal.min(payload.quantity, product.currentStock)

        const selectedCost = payload.unitCost ?? product.cost
        snapshot = selectedCost === null ? null : checkedMoney(selectedCost, 8, 2)
        if (snapshot !== null && deducted.gt(0)) {
          valuedQuantity = deducted
          cost = new Decimal(deducted).mul(snapshot)
        }
      }

      const unrecorded = payload.quantity.sub(deducted)
      const costImpact = valuedQuantity.gt(0) ? checkedMoney(cost, 17, 5) : null
      const costState: WasteCostState = deducted.eq(0)
        ? 'NONE'
        : valuedQuantity.eq(0)
          ? 'UNKNOWN'
          : valuedQuantity.eq(payload.quantity)
            ? 'KNOWN'
            : 'PARTIAL'
      const createdAt = new Date()

      // El índice único se disputa antes de escribir los efectos.
      const report = await tx.inventoryWasteReport.create({
        data: {
          venueId,
          idempotencyKey: payload.idempotencyKey,
          status: 'APPLIED',
          payloadHash: payload.payloadHash,
          itemType: payload.itemType,
          rawMaterialId: raw?.id ?? null,
          productId: product?.id ?? null,
          unit: payload.unit,
          reasonCode: payload.reasonCode,
          declaredQuantity: payload.quantity,
          deductedQuantity: deducted,
          unrecordedQuantity: unrecorded,
          costImpact,
          costState,
          note: payload.note,
          reference: payload.reference,
          unitCost: payload.unitCost,
          unitCostSnapshot: snapshot,
          supplier: payload.supplier,
          reportedByStaffId: actorStaffId,
          source: payload.source,
          clientOccurredAt: payload.clientOccurredAt,
          createdAt,
        },
      })

      const reason = `${WASTE_REASONS[payload.reasonCode].label}${payload.note ? `: ${payload.note}` : ''}`

      if (raw) {
        if (byBatches.gt(0)) {
          await deductStockFIFOInTx(
            tx,
            venueId,
            raw.id,
            byBatches,
            'SPOILAGE',
            {
              reason,
              reference: payload.reference ?? undefined,
              createdBy: actorStaffId,
              wasteReportId: report.id,
              createdAt,
            },
            order,
          )
        }

        if (withoutBatches.gt(0)) {
          const previousStock = new Decimal(raw.currentStock).sub(byBatches)
          const newStock = previousStock.sub(withoutBatches)

          await tx.rawMaterialMovement.create({
            data: {
              venueId,
              rawMaterialId: raw.id,
              type: 'SPOILAGE',
              quantity: withoutBatches.neg(),
              unit: raw.unit,
              previousStock,
              newStock,
              costImpact: null,
              reason: `${reason} (ajuste directo, sin lotes)`,
              reference: payload.reference,
              createdBy: actorStaffId,
              wasteReportId: report.id,
              createdAt,
            },
          })
          await tx.rawMaterial.update({
            where: { id: raw.id },
            data: { currentStock: newStock },
          })
        }
      }

      if (product && deducted.gt(0)) {
        await adjustInventoryStockInTx(
          tx,
          product.id,
          { id: product.inventoryId, lastCountedAt: product.lastCountedAt },
          {
            type: 'LOSS',
            quantity: deducted.neg(),
            reason,
            reference: payload.reference ?? undefined,
            supplier: payload.supplier ?? undefined,
          },
          actorStaffId,
          { reportId: report.id, createdAt, unitCostSnapshot: snapshot },
        )
      }

      await audit(tx, report, 'INVENTORY_WASTE_LOGGED')
      return wasteSummary(report)
    })
  } catch (error) {
    if (!isWasteKeyCollision(error)) throw error

    // La transacción que perdió ya terminó: no se consulta con su cliente abortado.
    const recovered = await recoverByKey(venueId, payload.idempotencyKey, actorStaffId, payload.payloadHash)
    if (recovered) return recovered
    throw error
  }
}
