import { LedgerAccountNature, LedgerAccountType, Prisma, VenueType } from '@prisma/client'

import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { BASE_CHART, SECTOR_EXTRAS, type SeedAccount } from './chartOfAccounts.catalog'

/**
 * Catálogo de cuentas (Capa B fiscal) — chart of accounts.
 *
 * Scope = **(organizationId, rfc) = el contribuyente**, NO por venue: una org puede tener
 * varios RFCs (FiscalEmisor por RFC) y cada RFC lleva su propio catálogo. Se siembra desde
 * un catálogo base verificado contra el código agrupador del SAT (c_CuentasSAT / Anexo 24),
 * adaptable por giro. Es solo la ESTRUCTURA (sin saldos). Gated PREMIUM (bundle con CFDI).
 *
 * Invariantes (model spec, validado):
 *  - `level` se deriva de la cadena de padres (1 = mayor).
 *  - `isPostable` solo en HOJAS: una cuenta con hijos (acumulativa) DEBE ser false.
 *  - `nature` por defecto según `type` (ACTIVO/COSTO/GASTO → DEUDORA; PASIVO/CAPITAL/INGRESO →
 *    ACREEDORA); se permite override explícito (contra-cuentas) — NO se bloquea.
 *  - El seed es idempotente por (org, rfc, code) — re-correrlo no duplica.
 */

/** Naturaleza por defecto según el tipo de cuenta (las contra-cuentas la sobrescriben). */
const DEFAULT_NATURE: Record<LedgerAccountType, LedgerAccountNature> = {
  ACTIVO: LedgerAccountNature.DEUDORA,
  COSTO: LedgerAccountNature.DEUDORA,
  GASTO: LedgerAccountNature.DEUDORA,
  PASIVO: LedgerAccountNature.ACREEDORA,
  CAPITAL: LedgerAccountNature.ACREEDORA,
  INGRESO: LedgerAccountNature.ACREEDORA,
  ORDEN: LedgerAccountNature.DEUDORA,
}

/** VenueType → llave de giro del catálogo de sector (para sembrar cuentas extra). */
const VENUE_TYPE_TO_SECTOR: Partial<Record<VenueType, string>> = {
  RESTAURANT: 'restaurante',
  BAR: 'restaurante',
  CAFE: 'restaurante',
  BAKERY: 'restaurante',
  FOOD_TRUCK: 'restaurante',
  FAST_FOOD: 'restaurante',
  CATERING: 'restaurante',
  CLOUD_KITCHEN: 'restaurante',
  NIGHTCLUB: 'restaurante',
  RETAIL_STORE: 'retail',
  JEWELRY: 'retail',
  CLOTHING: 'retail',
  ELECTRONICS: 'retail',
  PHARMACY: 'retail',
  CONVENIENCE_STORE: 'retail',
  SUPERMARKET: 'retail',
  LIQUOR_STORE: 'retail',
  FURNITURE: 'retail',
  HARDWARE: 'retail',
  BOOKSTORE: 'retail',
  PET_STORE: 'retail',
  TELECOMUNICACIONES: 'retail',
  SALON: 'servicios',
  SPA: 'servicios',
  CLINIC: 'servicios',
  VETERINARY: 'servicios',
  AUTO_SERVICE: 'servicios',
  LAUNDRY: 'servicios',
  REPAIR_SHOP: 'servicios',
  FITNESS: 'gimnasio',
  FITNESS_STUDIO: 'gimnasio',
  HOTEL: 'hotel',
  HOSTEL: 'hotel',
  RESORT: 'hotel',
  HOTEL_RESTAURANT: 'hotel',
}

export interface CatalogScope {
  organizationId: string
  rfc: string
  venueType: VenueType
}

export interface LedgerAccountDTO {
  id: string
  code: string
  satGroupingCode: string
  name: string
  type: LedgerAccountType
  nature: LedgerAccountNature
  level: number
  parentId: string | null
  isPostable: boolean
  isActive: boolean
}

export interface CatalogResult {
  /** El local aún no tiene RFC/emisor fiscal → el catálogo no puede existir todavía. */
  needsFiscalSetup: boolean
  organizationId: string | null
  rfc: string | null
  seeded: boolean
  accounts: LedgerAccountDTO[]
}

const toDTO = (a: {
  id: string
  code: string
  satGroupingCode: string
  name: string
  type: LedgerAccountType
  nature: LedgerAccountNature
  level: number
  parentId: string | null
  isPostable: boolean
  isActive: boolean
}): LedgerAccountDTO => ({
  id: a.id,
  code: a.code,
  satGroupingCode: a.satGroupingCode,
  name: a.name,
  type: a.type,
  nature: a.nature,
  level: a.level,
  parentId: a.parentId,
  isPostable: a.isPostable,
  isActive: a.isActive,
})

/**
 * Resuelve (organizationId, rfc, venueType) para un local. El RFC se toma del emisor fiscal
 * del local (FiscalEmisor) o de Venue.rfc. Devuelve null en `rfc` si no hay ninguno todavía.
 */
export async function resolveScopeOrNull(venueId: string): Promise<CatalogScope | null> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { organizationId: true, rfc: true, type: true },
  })
  if (!venue) throw new NotFoundError(`Venue with ID ${venueId} not found`)

  const emisor = await prisma.fiscalEmisor.findFirst({
    where: { venueId },
    select: { rfc: true },
    orderBy: { createdAt: 'asc' },
  })
  const rfc = (emisor?.rfc ?? venue.rfc ?? '').toUpperCase().trim()
  if (!rfc) return null
  return { organizationId: venue.organizationId, rfc, venueType: venue.type }
}

/** Igual que arriba pero lanza si no hay RFC (para mutaciones que lo requieren). */
async function requireScope(venueId: string): Promise<CatalogScope> {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) {
    throw new BadRequestError('Este local aún no tiene un RFC/emisor fiscal configurado. Configura la facturación (CFDI) primero.')
  }
  return scope
}

async function listAccounts(scope: CatalogScope): Promise<LedgerAccountDTO[]> {
  const rows = await prisma.ledgerAccount.findMany({
    where: { organizationId: scope.organizationId, rfc: scope.rfc },
    orderBy: { code: 'asc' },
    select: {
      id: true,
      code: true,
      satGroupingCode: true,
      name: true,
      type: true,
      nature: true,
      level: true,
      parentId: true,
      isPostable: true,
      isActive: true,
    },
  })
  return rows.map(toDTO)
}

/**
 * Catálogo de cuentas del local (read). Si el local no tiene RFC todavía, devuelve
 * `needsFiscalSetup: true` para que el dashboard muestre el estado "configura facturación".
 */
export async function getCatalog(venueId: string): Promise<CatalogResult> {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) {
    return { needsFiscalSetup: true, organizationId: null, rfc: null, seeded: false, accounts: [] }
  }
  const accounts = await listAccounts(scope)
  return {
    needsFiscalSetup: false,
    organizationId: scope.organizationId,
    rfc: scope.rfc,
    seeded: accounts.length > 0,
    accounts,
  }
}

/**
 * Siembra el catálogo base + las cuentas extra del giro para (org, rfc).
 *
 * **Insert-if-absent**: inserta SOLO las cuentas que faltan; NUNCA sobrescribe filas
 * existentes. Esto (a) preserva las ediciones del usuario (nombre, naturaleza, código
 * agrupador) y (b) no corrompe la jerarquía — un padre que el usuario extendió vía
 * createAccount conserva su `isPostable=false`. `isPostable` de las cuentas NUEVAS se deriva
 * de quién las referencia como padre, considerando TANTO el catálogo COMO las filas ya
 * existentes (unión). Inserta padres antes que hijos y resuelve parentId por código.
 */
export async function seedBaseChart(venueId: string, actor: { staffId?: string | null }): Promise<CatalogResult> {
  const scope = await requireScope(venueId)
  const sector = VENUE_TYPE_TO_SECTOR[scope.venueType]
  const merged: SeedAccount[] = [...BASE_CHART, ...(sector ? (SECTOR_EXTRAS[sector] ?? []) : [])]

  // Dedupe por código (base gana si hubiese colisión).
  const byCode = new Map<string, SeedAccount>()
  for (const a of merged) if (!byCode.has(a.code)) byCode.set(a.code, a)
  const all = [...byCode.values()]

  // Cuentas ya existentes del contribuyente → insert-if-absent + parentId resoluble + isPostable correcto.
  const existing = await prisma.ledgerAccount.findMany({
    where: { organizationId: scope.organizationId, rfc: scope.rfc },
    select: { id: true, code: true, parentId: true },
  })
  const idByCode = new Map<string, string>(existing.map(e => [e.code, e.id]))
  const codeById = new Map<string, string>(existing.map(e => [e.id, e.code]))
  const existingCodes = new Set(existing.map(e => e.code))

  // Acumulativa (NO afectable) si la referencia como padre el catálogo O una fila existente (unión).
  const hasChild = new Set<string>()
  for (const a of all) if (a.parentCode) hasChild.add(a.parentCode)
  for (const e of existing) {
    if (!e.parentId) continue
    const pc = codeById.get(e.parentId)
    if (pc) hasChild.add(pc)
  }

  // Padres antes que hijos: por longitud de código y luego alfabético.
  all.sort((x, y) => x.code.length - y.code.length || x.code.localeCompare(y.code))

  let created = 0
  await prisma.$transaction(
    async tx => {
      for (const a of all) {
        if (existingCodes.has(a.code)) continue // ya existe → preservar (no sobrescribir ediciones del usuario)
        const parentId = a.parentCode ? (idByCode.get(a.parentCode) ?? null) : null
        const rec = await tx.ledgerAccount.create({
          data: {
            organizationId: scope.organizationId,
            rfc: scope.rfc,
            code: a.code,
            satGroupingCode: a.satGroupingCode,
            name: a.name,
            type: a.type as LedgerAccountType,
            nature: a.nature as LedgerAccountNature,
            parentId,
            level: a.level,
            isPostable: !hasChild.has(a.code),
          },
          select: { id: true },
        })
        idByCode.set(a.code, rec.id)
        created++
      }
    },
    { timeout: 30000, maxWait: 10000 },
  )

  await logAction({
    staffId: actor.staffId ?? null,
    venueId,
    action: 'LEDGER_CHART_SEEDED',
    entity: 'LedgerAccount',
    data: { organizationId: scope.organizationId, rfc: scope.rfc, sector: sector ?? null, total: all.length, created },
  })

  return getCatalog(venueId)
}

export interface CreateAccountInput {
  code: string
  name: string
  satGroupingCode: string
  type: LedgerAccountType
  nature?: LedgerAccountNature
  parentCode?: string | null
}

/**
 * Crea una cuenta nueva (hoja). Deriva level del padre, isPostable=true, y si el padre era
 * una hoja lo convierte en acumulativa (isPostable=false) en la misma transacción.
 */
export async function createAccount(
  venueId: string,
  input: CreateAccountInput,
  actor: { staffId?: string | null },
): Promise<LedgerAccountDTO> {
  const scope = await requireScope(venueId)
  const code = input.code.trim()
  if (!code) throw new BadRequestError('El código de la cuenta es requerido.')

  const exists = await prisma.ledgerAccount.findUnique({
    where: { organizationId_rfc_code: { organizationId: scope.organizationId, rfc: scope.rfc, code } },
    select: { id: true },
  })
  if (exists) throw new BadRequestError(`Ya existe una cuenta con el código ${code}.`)

  let parentId: string | null = null
  let level = 1
  let parent: { id: string; isPostable: boolean; level: number; type: LedgerAccountType } | null = null
  if (input.parentCode) {
    parent = await prisma.ledgerAccount.findUnique({
      where: { organizationId_rfc_code: { organizationId: scope.organizationId, rfc: scope.rfc, code: input.parentCode } },
      select: { id: true, isPostable: true, level: true, type: true },
    })
    if (!parent) throw new BadRequestError(`La cuenta padre ${input.parentCode} no existe.`)
    parentId = parent.id
    level = parent.level + 1
  }

  // Coherencia fiscal: una subcuenta hereda el tipo del padre (una subcuenta de Bancos es ACTIVO).
  const accountType: LedgerAccountType = parent ? parent.type : input.type
  // Naturaleza: default por tipo; se permite override (contra-cuentas) sin bloquear.
  const nature = input.nature ?? DEFAULT_NATURE[accountType]

  let created
  try {
    created = await prisma.$transaction(async tx => {
      if (parent && parent.isPostable) {
        // El padre deja de ser afectable al recibir un hijo (pasa a acumulativa).
        await tx.ledgerAccount.update({ where: { id: parent.id }, data: { isPostable: false } })
      }
      return tx.ledgerAccount.create({
        data: {
          organizationId: scope.organizationId,
          rfc: scope.rfc,
          code,
          satGroupingCode: input.satGroupingCode.trim(),
          name: input.name.trim(),
          type: accountType,
          nature,
          parentId,
          level,
          isPostable: true,
        },
        select: {
          id: true,
          code: true,
          satGroupingCode: true,
          name: true,
          type: true,
          nature: true,
          level: true,
          parentId: true,
          isPostable: true,
          isActive: true,
        },
      })
    })
  } catch (e) {
    // Carrera con el pre-check de unicidad: el índice (org, rfc, code) lo atrapa → 400 amable.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new BadRequestError(`Ya existe una cuenta con el código ${code}.`)
    }
    throw e
  }

  await logAction({
    staffId: actor.staffId ?? null,
    venueId,
    action: 'LEDGER_ACCOUNT_CREATED',
    entity: 'LedgerAccount',
    entityId: created.id,
    data: { organizationId: scope.organizationId, rfc: scope.rfc, code, name: created.name },
  })

  return toDTO(created)
}

export interface UpdateAccountInput {
  name?: string
  satGroupingCode?: string
  nature?: LedgerAccountNature
  isActive?: boolean
}

/** Edita campos seguros de una cuenta (nombre, código agrupador, naturaleza, activo). */
export async function updateAccount(
  venueId: string,
  accountId: string,
  input: UpdateAccountInput,
  actor: { staffId?: string | null },
): Promise<LedgerAccountDTO> {
  const scope = await requireScope(venueId)
  const existing = await prisma.ledgerAccount.findFirst({
    where: { id: accountId, organizationId: scope.organizationId, rfc: scope.rfc },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Cuenta no encontrada en este catálogo.')

  const updated = await prisma.ledgerAccount.update({
    where: { id: accountId },
    data: {
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.satGroupingCode !== undefined && { satGroupingCode: input.satGroupingCode.trim() }),
      ...(input.nature !== undefined && { nature: input.nature }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
    select: {
      id: true,
      code: true,
      satGroupingCode: true,
      name: true,
      type: true,
      nature: true,
      level: true,
      parentId: true,
      isPostable: true,
      isActive: true,
    },
  })

  await logAction({
    staffId: actor.staffId ?? null,
    venueId,
    action: 'LEDGER_ACCOUNT_UPDATED',
    entity: 'LedgerAccount',
    entityId: updated.id,
    // JSON round-trip strips undefined optionals so the object is a valid InputJsonValue.
    data: { organizationId: scope.organizationId, rfc: scope.rfc, code: updated.code, changes: JSON.parse(JSON.stringify(input)) },
  })

  return toDTO(updated)
}
