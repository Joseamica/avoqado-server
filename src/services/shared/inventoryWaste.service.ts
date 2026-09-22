import { createHash } from 'crypto'
import { InventoryWasteReport, Prisma, StaffRole, Unit, WasteCostState, WasteItemType, WasteSource } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError'
import { withSerializableRetry } from '../../utils/serializableRetry'
import { BatchAllocationOrder, calculateFIFOAllocations, deductStockFIFOInTx, lockWasteBatchesInTx } from '../dashboard/fifoBatch.service'
import { adjustInventoryStockInTx } from '../dashboard/productInventory.service'
import { checkAndCreateLowStockAlert } from '../dashboard/rawMaterial.service'
import { getUserAccess, hasPermission, UserAccess } from '../access/access.service'
import { getEffectiveRolePermissions, resolvePermissions } from '../../lib/permissions'
import { getEffectivePermissions } from '../../lib/resolveEffectivePermissions'
import { resolveUserRoleForVenue } from '../../middlewares/checkPermission.middleware'
import { isWasteReasonCode, WasteReasonCode, WASTE_REASONS } from './wasteReasons'
import { WASTE_KEY_PATTERN } from './wasteKey'

const Decimal = Prisma.Decimal.clone({
  precision: 48,
  rounding: Prisma.Decimal.ROUND_HALF_UP,
})

const KEY_CONSTRAINT = 'InventoryWasteReport_venueId_idempotencyKey_key'

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
  // null = ausente, igual que omitirlo: es lo que manda un JSON con el campo vacío.
  unitCost?: string | number | Prisma.Decimal | null
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
  name: string
  currentStock: Prisma.Decimal
  unit: Unit
}

type LockedProduct = {
  id: string
  name: string
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
  if (!WASTE_KEY_PATTERN.test(key)) {
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

  // `== null` y no `=== undefined`: un null de JSON no es una cantidad (familia del reembolso del 11-sep).
  const suppliedCost = input.unitCost == null ? null : decimal(input.unitCost)
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
  if (!role) throw new ForbiddenError('Ya no tienes acceso a este establecimiento.', 'WASTE_ACCESS_REVOKED')
  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    select: { active: true },
  })
  if (!staff?.active) throw new ForbiddenError('La cuenta ya no está activa.', 'WASTE_ACCOUNT_INACTIVE')
  return getUserAccess(staffId, venueId)
}

/**
 * Los permisos que el rol o el Conjunto conceden en el local ANTES del filtro de activación
 * white-label: la misma lista que `getUserAccess` arma antes de filtrar
 * (access.service.ts, `basePermissions` → `resolvePermissions`), con las MISMAS funciones y
 * en el mismo orden. 🔴 No es `resolveStaffVenuePermissions`: ése resuelve las dependencias un
 * nivel menos en la rama del rol y ya da otra lista para OWNER (medido). Una prueba de
 * integración compara las dos listas en un local sin white-label para que no se separen.
 */
export async function grantedPermissionsBeforeActivation(staffId: string, venueId: string, role: StaffRole): Promise<string[]> {
  const [membership, rolePermission] = await Promise.all([
    prisma.staffVenue.findUnique({
      where: { staffId_venueId: { staffId, venueId } },
      select: { permissionSetId: true, permissionSet: true },
    }),
    prisma.venueRolePermission.findUnique({
      where: { venueId_role: { venueId, role } },
      select: { permissions: true, deniedPermissions: true },
    }),
  ])

  const base =
    membership?.permissionSetId && membership.permissionSet
      ? getEffectivePermissions(membership, [])
      : getEffectiveRolePermissions(role, rolePermission?.permissions ?? null, rolePermission?.deniedPermissions ?? null)
  return Array.from(resolvePermissions(base))
}

/**
 * Acceso para ANULAR (Ruling 12): la membresía vigente y la cuenta activa se exigen igual que
 * siempre (`getWasteAccess`), pero apagar AVOQADO_INVENTORY en white-label no le quita a nadie
 * la forma de CERRAR un folio pendiente — anular no mueve existencia, y bloquearlo dejaría en el
 * aparato filas imposibles de cerrar (spec §4.3). Registrar mermas NUEVAS sí sigue exigiendo la
 * activación (`hasWastePermission`). Sin white-label la lista ya es la de antes del filtro.
 */
async function getWasteVoidAccess(staffId: string, venueId: string): Promise<UserAccess> {
  const access = await getWasteAccess(staffId, venueId)
  if (!access.whiteLabelEnabled || access.role === StaffRole.SUPERADMIN) return access
  return { ...access, corePermissions: await grantedPermissionsBeforeActivation(staffId, venueId, access.role) }
}

/** ¿El inventario está activado para este usuario? Sin white-label, siempre; con white-label,
 *  sólo si `AVOQADO_INVENTORY` está encendido y permitido para su rol. SUPERADMIN pasa. */
function wasteInventoryActivated(access: UserAccess): boolean {
  return access.role === StaffRole.SUPERADMIN || !access.whiteLabelEnabled || access.featureAccess.AVOQADO_INVENTORY?.allowed === true
}

export function hasWastePermission(access: UserAccess, permission: string): boolean {
  return wasteInventoryActivated(access) && hasPermission(access, permission)
}

/**
 * Lo que `checkPermission` NO mira, sin evaluar el permiso: acceso vigente al venue, cuenta
 * activa y activación white-label del inventario. Es el paso previo de las rutas HTTP (Ruling 18):
 * se monta ANTES de `checkPermission` para que ningún rechazo posterior queme el token de un
 * solo uso del PIN de gerente, y para que el permiso lo decida UNA sola autoridad que respeta ese
 * PIN. Quien llama sin middleware (el MCP) usa `requireWastePermission`, que evalúa las dos cosas.
 */
export async function requireWasteActivation(staffId: string, venueId: string): Promise<UserAccess> {
  const access = await getWasteAccess(staffId, venueId)
  if (!wasteInventoryActivated(access)) {
    throw new ForbiddenError('El inventario no está habilitado para tu usuario en este establecimiento.', 'WASTE_INVENTORY_DISABLED')
  }
  return access
}

/** Activación + permiso, para quien no pasa por `checkPermission` (MCP). No conoce el PIN de gerente. */
export async function requireWastePermission(staffId: string, venueId: string, permission: string): Promise<UserAccess> {
  const access = await requireWasteActivation(staffId, venueId)
  if (!hasPermission(access, permission)) {
    throw new ForbiddenError('No tienes permiso para esta operación de inventario.', 'WASTE_PERMISSION_DENIED')
  }
  return access
}

async function audit(
  tx: Prisma.TransactionClient,
  report: InventoryWasteReport,
  action: 'INVENTORY_WASTE_LOGGED' | 'INVENTORY_WASTE_VOIDED',
  extra: Record<string, string | null> = {},
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
        // La pantalla de auditoría del dueño sólo lee ActivityLog: tiene que decir QUÉ se mermó.
        itemType: report.itemType,
        itemId: report.rawMaterialId ?? report.productId,
        reasonCode: report.reasonCode,
        unit: report.unit,
        source: report.source,
        declared: report.declaredQuantity?.toString() ?? null,
        deducted: report.deductedQuantity.toString(),
        unrecorded: report.unrecordedQuantity.toString(),
        costImpact: report.costImpact?.toString() ?? null,
        costState: report.costState,
        // Aditivo (Opus menor 1): el nombre del artículo al mermar, o el folio anulado.
        ...extra,
      },
    },
  })
}

/**
 * La alerta de existencia baja tras la merma de un INSUMO (Opus I1). Ventas, modificadores, conteo
 * móvil y la merma vieja la disparan; la del libro la dispara aquí, igual para POS, dashboard y MCP.
 *
 * Corre DESPUÉS del COMMIT y nunca convierte la merma en error: la merma ya está confirmada, y un
 * error haría que el cliente reintentara — el dashboard de hoy sin folio, o sea descontando otra vez.
 * Es idempotente (`checkAndCreateLowStockAlert` no crea otra si ya hay una ACTIVE) y respeta
 * `notifyOnLowStock` para el aviso (Ruling 22).
 */
async function alertLowStockAfterWaste(venueId: string, rawMaterialId: string, reportId: string): Promise<void> {
  try {
    await checkAndCreateLowStockAlert(venueId, rawMaterialId)
  } catch (error) {
    logger.warn('No se pudo evaluar la alerta de existencia baja tras la merma', {
      venueId,
      rawMaterialId,
      reportId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Lo que la entrada responde, leído DENTRO de la transacción de `logWaste` (Codex P2-2): después de
 * escribir los efectos y antes del COMMIT. Si la lectura falla, la merma entera se revierte; nunca
 * queda una merma aplicada con una respuesta de error. Importa porque el dashboard de hoy no manda
 * folio: un error tras el COMMIT haría que reintentara con otro y descontara dos veces.
 */
export type WasteResultReader<T> = (tx: Prisma.TransactionClient, summary: WasteSummary) => Promise<T>

export function logWaste(venueId: string, actorStaffId: string, input: WasteInput): Promise<WasteSummary>
export function logWaste<T>(venueId: string, actorStaffId: string, input: WasteInput, readResult: WasteResultReader<T>): Promise<T>
export async function logWaste<T>(
  venueId: string,
  actorStaffId: string,
  input: WasteInput,
  readResult?: WasteResultReader<T>,
): Promise<WasteSummary | T> {
  const payload = prepareWaste(actorStaffId, input)
  const respond = (tx: Prisma.TransactionClient, summary: WasteSummary): Promise<WasteSummary | T> =>
    readResult ? readResult(tx, summary) : Promise.resolve(summary)

  // `applied`: ESTA llamada escribió los efectos. Recuperar un folio ya aplicado no los repite, y
  // tampoco repite lo que va después del COMMIT.
  let outcome: { summary: WasteSummary; result: WasteSummary | T; applied: boolean }
  try {
    outcome = await serializable(async tx => {
      const recovered = await recoverByKey(venueId, payload.idempotencyKey, actorStaffId, payload.payloadHash, tx)
      if (recovered) return { summary: recovered, result: await respond(tx, recovered), applied: false }

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
          SELECT id, name, "currentStock", unit
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
          SELECT p.id, p.name, i.id AS "inventoryId", i."currentStock", i."lastCountedAt",
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
          -- NOWAIT: una compra toma Inventory y después Product.cost, el orden inverso a éste.
          -- Esperar aquí cierra una espera circular (40P01, que no se reintenta); con NOWAIT la
          -- contención sale como 55P03 y entra al reintento de withSerializableRetry.
          FOR UPDATE OF p, i NOWAIT
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

      // El nombre sale de la fila ya bloqueada: es el que tenía el artículo al mermarlo.
      await audit(tx, report, 'INVENTORY_WASTE_LOGGED', { itemName: raw?.name ?? product?.name ?? null })
      const summary = wasteSummary(report)
      return { summary, result: await respond(tx, summary), applied: true }
    })
  } catch (error) {
    if (!isWasteKeyCollision(error)) throw error

    // La transacción que perdió ya terminó: no se consulta con su cliente abortado. La respuesta se
    // arma en una transacción propia (el ganador ya confirmó: aquí no hay efectos que proteger).
    const recovered = await recoverByKey(venueId, payload.idempotencyKey, actorStaffId, payload.payloadHash)
    if (recovered) return readResult ? serializable(tx => readResult(tx, recovered)) : recovered
    throw error
  }

  // Después del COMMIT: sólo un insumo del que ESTA llamada descontó algo puede haber cruzado el
  // punto de reorden (un producto no tiene LowStockAlert, y sin descuento la existencia no cambió).
  if (outcome.applied && payload.itemType === 'RAW_MATERIAL' && new Decimal(outcome.summary.deducted).gt(0)) {
    await alertLowStockAfterWaste(venueId, payload.itemId, outcome.summary.reportId)
  }
  return outcome.result
}

function voidResult(report: InventoryWasteReport, actorStaffId: string, canAdjust: boolean): VoidWasteResult {
  if (report.status === 'VOIDED') {
    // La autoría CANÓNICA de la lápida: quien la creó y cuándo, aunque la repita otra persona.
    return {
      outcome: 'VOIDED',
      voidedByStaffId: report.reportedByStaffId,
      voidedAt: report.createdAt.toISOString(),
    }
  }
  // Cuánto se descontó sólo lo ve el autor o quien administra inventario (spec §4.3).
  if (report.reportedByStaffId === actorStaffId || canAdjust) {
    return { outcome: 'ALREADY_APPLIED', report: wasteSummary(report) }
  }
  return { outcome: 'ALREADY_APPLIED' }
}

/**
 * La ÚNICA forma de anular un folio: el aparato se deshace de un envío con desenlace
 * desconocido sin arriesgarse a que el servidor lo aplique después. Si el folio no existe,
 * inserta una lápida VOIDED que ocupa el índice único; si ya se aplicó, lo dice y no toca nada.
 * La carrera con el POST la decide ese índice: el que pierde revierte entero.
 * SIN candado de plan ni de activación white-label: anular no escribe existencia (Ruling 12).
 */
export async function voidWasteKey(
  venueId: string,
  actorStaffId: string,
  key: string,
  source: WasteSource = 'POS',
): Promise<VoidWasteResult> {
  const idempotencyKey = normalizeWasteKey(key)
  const access = await getWasteVoidAccess(actorStaffId, venueId)
  const canAdjust = hasPermission(access, 'inventory:adjust')
  if (!canAdjust && !hasPermission(access, 'inventory:log-waste')) {
    throw new ForbiddenError('No tienes permiso para anular este folio.', 'WASTE_PERMISSION_DENIED')
  }

  try {
    return await serializable(async tx => {
      const existing = await tx.inventoryWasteReport.findUnique({
        where: { venueId_idempotencyKey: { venueId, idempotencyKey } },
      })
      if (existing) return voidResult(existing, actorStaffId, canAdjust)

      const report = await tx.inventoryWasteReport.create({
        data: {
          venueId,
          idempotencyKey,
          status: 'VOIDED',
          costState: 'NONE',
          deductedQuantity: new Decimal(0),
          unrecordedQuantity: new Decimal(0),
          reportedByStaffId: actorStaffId,
          source,
          createdAt: new Date(),
        },
      })
      await audit(tx, report, 'INVENTORY_WASTE_VOIDED', { idempotencyKey: report.idempotencyKey })
      return voidResult(report, actorStaffId, canAdjust)
    })
  } catch (error) {
    if (!isWasteKeyCollision(error)) throw error

    // Ganó el otro (POST o lápida): se lee lo que quedó, fuera de la transacción abortada.
    const existing = await prisma.inventoryWasteReport.findUnique({
      where: { venueId_idempotencyKey: { venueId, idempotencyKey } },
    })
    if (!existing) throw error
    return voidResult(existing, actorStaffId, canAdjust)
  }
}
