// src/services/dashboard/tenderType.dashboard.service.ts

/**
 * VenueTenderType catalog (custom payment types) — slice A1.
 *
 * A tender type is a reporting/settlement LABEL layered on top of the fiscal
 * `PaymentMethod` enum ("Uber Eats", "Vale de despensa"), Square/Alegra-style.
 * Invariants enforced here (each one was an adversarial-audit finding — don't relax
 * them without re-auditing):
 *
 * - Custom rows ALWAYS resolve to `baseMethod = OTHER`. The caller cannot pick it.
 * - `normalizedName` is server-computed; it is the per-venue uniqueness key.
 * - Money/fiscal-semantic edits (name, countsAsPhysicalCash, captureTip,
 *   commissionPercent, satFormaPago) bump `revision` and append an immutable
 *   VenueTenderTypeRevision row IN THE SAME TRANSACTION. Presentation edits
 *   (posSection, displayOrder, showOnPos, active) are last-write-wins and do NOT bump.
 * - System rows (Efectivo/Tarjetas/Transferencia) are seeded per venue and their
 *   money semantics are immutable; only presentation fields can change.
 * - `satFormaPago` must be a real SAT c_FormaPago code — '99' is forbidden by design
 *   (a PUE invoice needs the actual forma; NULL simply means "not individually
 *   invoiceable", which the UI explains).
 * - Rows are soft-disabled, never hard-deleted (Payment FKs here with Restrict, and
 *   offline replays must always resolve their reference).
 */

import { OrderSource, Prisma, TenderSection } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import { logAction } from './activity-log.service'

/** SAT c_FormaPago codes accepted for a tender type. '99 Por definir' is excluded on purpose. */
const VALID_SAT_FORMA_PAGO = new Set([
  '01', // Efectivo
  '02', // Cheque nominativo
  '03', // Transferencia electrónica de fondos
  '04', // Tarjeta de crédito
  '05', // Monedero electrónico (vale en tarjeta)
  '06', // Dinero electrónico
  '08', // Vales de despensa (papel)
  '12', // Dación en pago
  '13', // Pago por subrogación
  '14', // Pago por consignación
  '15', // Condonación
  '17', // Compensación
  '23', // Novación
  '24', // Confusión
  '25', // Remisión de deuda
  '26', // Prescripción o caducidad
  '27', // A satisfacción del acreedor
  '28', // Tarjeta de débito
  '29', // Tarjeta de servicios
  '30', // Aplicación de anticipos
  '31', // Intermediario pagos
])

/** Fields whose edit changes how money/fiscal history must be interpreted → revision bump. */
const MONEY_SEMANTIC_FIELDS = ['name', 'countsAsPhysicalCash', 'captureTip', 'commissionPercent', 'satFormaPago'] as const

export interface CreateTenderTypeInput {
  name: string
  countsAsPhysicalCash?: boolean
  captureTip?: boolean
  showOnPos?: boolean
  posSection?: TenderSection
  commissionPercent?: number | null
  satFormaPago?: string | null
  linkedOrderSource?: OrderSource | null
}

export interface UpdateTenderTypeInput {
  name?: string
  countsAsPhysicalCash?: boolean
  captureTip?: boolean
  showOnPos?: boolean
  posSection?: TenderSection
  displayOrder?: number
  commissionPercent?: number | null
  satFormaPago?: string | null
  linkedOrderSource?: OrderSource | null
  active?: boolean
}

/** System tenders seeded per venue — they mirror the built-in PaymentMethod values 1:1. */
export const SYSTEM_TENDER_SEEDS = [
  { name: 'Efectivo', baseMethod: 'CASH', countsAsPhysicalCash: true, satFormaPago: '01', posSection: 'PRIMARY', displayOrder: 0 },
  {
    name: 'Tarjeta de crédito',
    baseMethod: 'CREDIT_CARD',
    countsAsPhysicalCash: false,
    satFormaPago: '04',
    posSection: 'PRIMARY',
    displayOrder: 1,
  },
  {
    name: 'Tarjeta de débito',
    baseMethod: 'DEBIT_CARD',
    countsAsPhysicalCash: false,
    satFormaPago: '28',
    posSection: 'PRIMARY',
    displayOrder: 2,
  },
  {
    name: 'Transferencia',
    baseMethod: 'BANK_TRANSFER',
    countsAsPhysicalCash: false,
    satFormaPago: '03',
    posSection: 'MORE',
    displayOrder: 3,
  },
] as const

/** Lowercase, trim, strip accents, collapse inner whitespace — the uniqueness key per venue. */
export function normalizeTenderName(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ')
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
}

function validateSatFormaPago(code: string | null | undefined): void {
  if (code == null) return
  if (code === '99') {
    throw new BadRequestError(
      "La forma SAT '99 (Por definir)' no se puede asignar a un tipo de pago: el SAT exige la forma real en facturas PUE. Déjala vacía si este tipo no se factura individualmente.",
    )
  }
  if (!VALID_SAT_FORMA_PAGO.has(code)) {
    throw new BadRequestError(`'${code}' no es una forma de pago válida del catálogo del SAT.`)
  }
}

function validateCommission(percent: number | null | undefined): void {
  if (percent == null) return
  if (typeof percent !== 'number' || Number.isNaN(percent) || percent < 0 || percent > 100) {
    throw new BadRequestError('La comisión debe ser un porcentaje entre 0 y 100.')
  }
}

function toCommissionDecimal(percent: number | null | undefined): Prisma.Decimal | null {
  return percent == null ? null : new Prisma.Decimal(percent.toFixed(2))
}

/**
 * Idempotent per-venue seed of the system tender rows (parent + revision 1 each).
 * Fast-path on count so calling it on every catalog read costs one indexed COUNT.
 * A concurrent seeder winning the unique-constraint race is tolerated silently.
 */
export async function ensureSystemTenderTypes(venueId: string): Promise<void> {
  const existing = await prisma.venueTenderType.count({ where: { venueId, isSystem: true } })
  if (existing >= SYSTEM_TENDER_SEEDS.length) return

  for (const seed of SYSTEM_TENDER_SEEDS) {
    try {
      await prisma.$transaction(async tx => {
        const already = await tx.venueTenderType.findFirst({
          where: { venueId, normalizedName: normalizeTenderName(seed.name) },
          select: { id: true },
        })
        if (already) return
        const created = await tx.venueTenderType.create({
          data: {
            venueId,
            name: seed.name,
            normalizedName: normalizeTenderName(seed.name),
            baseMethod: seed.baseMethod,
            isSystem: true,
            countsAsPhysicalCash: seed.countsAsPhysicalCash,
            captureTip: true,
            showOnPos: true,
            posSection: seed.posSection,
            displayOrder: seed.displayOrder,
            satFormaPago: seed.satFormaPago,
            revision: 1,
          },
        })
        await tx.venueTenderTypeRevision.create({
          data: {
            venueId,
            tenderTypeId: created.id,
            revision: 1,
            name: seed.name,
            countsAsPhysicalCash: seed.countsAsPhysicalCash,
            captureTip: true,
            commissionPercent: null,
            satFormaPago: seed.satFormaPago,
            createdBy: null,
          },
        })
      })
    } catch (error) {
      if (isUniqueViolation(error)) continue // concurrent seeder won — same outcome
      throw error
    }
  }
}

/** Venue catalog, lazily seeded. Stable order: section → displayOrder → createdAt → id. */
export async function listTenderTypes(venueId: string) {
  await ensureSystemTenderTypes(venueId)
  return prisma.venueTenderType.findMany({
    where: { venueId },
    orderBy: [{ posSection: 'asc' }, { displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
}

export async function createTenderType(venueId: string, input: CreateTenderTypeInput, performedBy?: string) {
  const name = input.name?.trim().replace(/\s+/g, ' ')
  if (!name) throw new BadRequestError('El nombre del tipo de pago es requerido.')
  if (name.length > 80) throw new BadRequestError('El nombre del tipo de pago no puede exceder 80 caracteres.')
  validateSatFormaPago(input.satFormaPago)
  validateCommission(input.commissionPercent)

  const normalizedName = normalizeTenderName(name)
  const commission = toCommissionDecimal(input.commissionPercent)

  let created
  try {
    created = await prisma.$transaction(async tx => {
      const tender = await tx.venueTenderType.create({
        data: {
          venueId,
          name,
          normalizedName,
          // 🔴 Invariant: custom rows are ALWAYS OTHER — the fiscal spine (`PaymentMethod`)
          // is never client-selectable. Square-parity: the name is a reporting layer.
          baseMethod: 'OTHER',
          isSystem: false,
          countsAsPhysicalCash: input.countsAsPhysicalCash ?? false,
          captureTip: input.captureTip ?? true,
          showOnPos: input.showOnPos ?? true,
          posSection: input.posSection ?? 'MORE',
          commissionPercent: commission,
          satFormaPago: input.satFormaPago ?? null,
          linkedOrderSource: input.linkedOrderSource ?? null,
          revision: 1,
        },
      })
      await tx.venueTenderTypeRevision.create({
        data: {
          venueId,
          tenderTypeId: tender.id,
          revision: 1,
          name,
          countsAsPhysicalCash: input.countsAsPhysicalCash ?? false,
          captureTip: input.captureTip ?? true,
          commissionPercent: commission,
          satFormaPago: input.satFormaPago ?? null,
          createdBy: performedBy ?? null,
        },
      })
      return tender
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(`Ya existe un tipo de pago llamado "${name}" en este negocio.`)
    }
    throw error
  }

  void logAction({
    staffId: performedBy,
    venueId,
    action: 'TENDER_TYPE_CREATED',
    entity: 'VenueTenderType',
    entityId: created.id,
    data: {
      name,
      countsAsPhysicalCash: input.countsAsPhysicalCash ?? false,
      commissionPercent: input.commissionPercent ?? null,
      satFormaPago: input.satFormaPago ?? null,
    },
  })
  return created
}

/**
 * Optimistic update: `expectedRevision` is the money-semantic version the editor was
 * looking at. Money edits use it as a hard precondition (409 on mismatch) and bump it;
 * presentation edits share the precondition but are last-write-wins (no bump, no row).
 */
export async function updateTenderType(
  venueId: string,
  tenderTypeId: string,
  expectedRevision: number,
  input: UpdateTenderTypeInput,
  performedBy?: string,
) {
  const existing = await prisma.venueTenderType.findFirst({ where: { id: tenderTypeId, venueId } })
  if (!existing) throw new NotFoundError('Tipo de pago no encontrado.')

  const touchesMoney = MONEY_SEMANTIC_FIELDS.some(field => input[field] !== undefined)
  if (existing.isSystem && touchesMoney) {
    throw new BadRequestError(
      'Los tipos de pago del sistema (Efectivo, Tarjetas, Transferencia) no se pueden renombrar ni cambiar su semántica de dinero. Crea un tipo personalizado si necesitas otro comportamiento.',
    )
  }

  if (input.name !== undefined) {
    const name = input.name?.trim()
    if (!name) throw new BadRequestError('El nombre del tipo de pago es requerido.')
    if (name.length > 80) throw new BadRequestError('El nombre del tipo de pago no puede exceder 80 caracteres.')
  }
  validateSatFormaPago(input.satFormaPago)
  validateCommission(input.commissionPercent)

  const data: Prisma.VenueTenderTypeUpdateManyMutationInput = {}
  if (input.name !== undefined) {
    data.name = input.name.trim()
    ;(data as Record<string, unknown>).normalizedName = normalizeTenderName(input.name)
  }
  if (input.countsAsPhysicalCash !== undefined) data.countsAsPhysicalCash = input.countsAsPhysicalCash
  if (input.captureTip !== undefined) data.captureTip = input.captureTip
  if (input.showOnPos !== undefined) data.showOnPos = input.showOnPos
  if (input.posSection !== undefined) data.posSection = input.posSection
  if (input.displayOrder !== undefined) data.displayOrder = input.displayOrder
  if (input.commissionPercent !== undefined) data.commissionPercent = toCommissionDecimal(input.commissionPercent)
  if (input.satFormaPago !== undefined) data.satFormaPago = input.satFormaPago
  if (input.linkedOrderSource !== undefined) data.linkedOrderSource = input.linkedOrderSource
  if (input.active !== undefined) data.active = input.active
  if (Object.keys(data).length === 0) return existing
  if (touchesMoney) data.revision = { increment: 1 }

  const updated = await prisma.$transaction(async tx => {
    const result = await tx.venueTenderType.updateMany({
      // venueId in the WHERE is tenant isolation at the effect boundary, not just the read.
      where: { id: tenderTypeId, venueId, revision: expectedRevision },
      data,
    })
    if (result.count === 0) {
      throw new ConflictError('El tipo de pago cambió mientras lo editabas. Recarga la lista e intenta de nuevo.')
    }
    const fresh = await tx.venueTenderType.findFirst({ where: { id: tenderTypeId, venueId } })
    if (touchesMoney && fresh) {
      await tx.venueTenderTypeRevision.create({
        data: {
          venueId,
          tenderTypeId,
          revision: fresh.revision,
          name: fresh.name,
          countsAsPhysicalCash: fresh.countsAsPhysicalCash,
          captureTip: fresh.captureTip,
          commissionPercent: fresh.commissionPercent,
          satFormaPago: fresh.satFormaPago,
          createdBy: performedBy ?? null,
        },
      })
    }
    return fresh
  })

  void logAction({
    staffId: performedBy,
    venueId,
    action: 'TENDER_TYPE_UPDATED',
    entity: 'VenueTenderType',
    entityId: tenderTypeId,
    data: { changes: JSON.parse(JSON.stringify(input)), touchesMoney },
  })
  return updated
}
