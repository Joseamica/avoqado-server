import { AccountMovementType } from '@prisma/client'

import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { MOVEMENT_TYPES, MOVEMENT_TYPE_CODES, type MovementSide, type MovementGroup } from './accountMapping.catalog'
import { resolveScopeOrNull } from './chartOfAccounts.service'

/**
 * Configuración contable (Capa B) — mapa "tipo de movimiento → cuenta del catálogo".
 *
 * Scope = (organizationId, rfc) = el contribuyente, igual que el catálogo. Hace que el
 * motor de pólizas postee a la cuenta correcta sin que un humano la escoja. Se siembra con
 * defaults verificados (accountMapping.catalog.ts) y el contador puede reasignar cada uno.
 * Solo se puede mapear a cuentas AFECTABLES (hojas) del propio catálogo. Gated PREMIUM (CFDI).
 */

export interface MappedAccount {
  id: string
  code: string
  name: string
  satGroupingCode: string
  isActive: boolean
}

export interface MappingRow {
  movementType: string
  label: string
  side: MovementSide
  group: MovementGroup
  defaultCode: string
  /** Cuenta asignada actualmente (o null si aún sin asignar). */
  account: MappedAccount | null
}

export interface MappingResult {
  needsFiscalSetup: boolean
  /** El catálogo de cuentas debe existir antes de poder mapear. */
  catalogSeeded: boolean
  organizationId: string | null
  rfc: string | null
  mappings: MappingRow[]
}

async function requireScope(venueId: string) {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) {
    throw new BadRequestError('Este local aún no tiene un RFC/emisor fiscal configurado. Configura la facturación (CFDI) primero.')
  }
  return scope
}

/** Devuelve SIEMPRE los 24 movimientos, con su cuenta asignada (o null). */
export async function getMappings(venueId: string): Promise<MappingResult> {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) {
    return { needsFiscalSetup: true, catalogSeeded: false, organizationId: null, rfc: null, mappings: [] }
  }

  const [rows, catalogCount] = await Promise.all([
    prisma.accountMapping.findMany({
      where: { organizationId: scope.organizationId, rfc: scope.rfc },
      include: { ledgerAccount: { select: { id: true, code: true, name: true, satGroupingCode: true, isActive: true } } },
    }),
    prisma.ledgerAccount.count({ where: { organizationId: scope.organizationId, rfc: scope.rfc } }),
  ])

  const byType = new Map(rows.map(r => [r.movementType as string, r]))
  const mappings: MappingRow[] = MOVEMENT_TYPES.map(def => {
    const acct = byType.get(def.movementType)?.ledgerAccount ?? null
    return {
      movementType: def.movementType,
      label: def.label,
      side: def.side,
      group: def.group,
      defaultCode: def.defaultCode,
      account: acct,
    }
  })

  return { needsFiscalSetup: false, catalogSeeded: catalogCount > 0, organizationId: scope.organizationId, rfc: scope.rfc, mappings }
}

/**
 * Siembra (insert-if-absent) los mapeos default por (org, rfc). Resuelve cada `defaultCode`
 * a una cuenta del catálogo del contribuyente. NUNCA sobrescribe un mapeo que el usuario ya
 * cambió. Requiere que el catálogo de cuentas exista (no se puede mapear a la nada).
 */
export async function seedDefaultMappings(venueId: string, actor: { staffId?: string | null }): Promise<MappingResult> {
  const scope = await requireScope(venueId)

  const accounts = await prisma.ledgerAccount.findMany({
    where: { organizationId: scope.organizationId, rfc: scope.rfc },
    select: { id: true, code: true },
  })
  if (accounts.length === 0) {
    throw new BadRequestError('Primero genera el catálogo de cuentas; sin cuentas no hay a qué mapear.')
  }
  const idByCode = new Map(accounts.map(a => [a.code, a.id]))

  const existing = await prisma.accountMapping.findMany({
    where: { organizationId: scope.organizationId, rfc: scope.rfc },
    select: { movementType: true },
  })
  const existingTypes = new Set(existing.map(e => e.movementType as string))

  let created = 0
  for (const def of MOVEMENT_TYPES) {
    if (existingTypes.has(def.movementType)) continue // preservar el mapeo del usuario
    await prisma.accountMapping.create({
      data: {
        organizationId: scope.organizationId,
        rfc: scope.rfc,
        movementType: def.movementType as AccountMovementType,
        ledgerAccountId: idByCode.get(def.defaultCode) ?? null, // null si el catálogo no trae ese código
      },
    })
    created++
  }

  await logAction({
    staffId: actor.staffId ?? null,
    venueId,
    action: 'ACCOUNTING_MAPPING_SEEDED',
    entity: 'AccountMapping',
    data: { organizationId: scope.organizationId, rfc: scope.rfc, total: MOVEMENT_TYPES.length, created },
  })

  return getMappings(venueId)
}

/**
 * Reasigna un movimiento a una cuenta (o lo limpia con ledgerAccountId=null). Valida que la
 * cuenta pertenezca al catálogo del contribuyente y sea AFECTABLE (hoja).
 */
export async function setMapping(
  venueId: string,
  movementType: string,
  ledgerAccountId: string | null,
  actor: { staffId?: string | null },
): Promise<MappingRow> {
  const scope = await requireScope(venueId)
  if (!MOVEMENT_TYPE_CODES.includes(movementType)) {
    throw new BadRequestError(`Tipo de movimiento no válido: ${movementType}.`)
  }

  if (ledgerAccountId) {
    const acct = await prisma.ledgerAccount.findFirst({
      where: { id: ledgerAccountId, organizationId: scope.organizationId, rfc: scope.rfc },
      select: { id: true, isPostable: true },
    })
    if (!acct) throw new BadRequestError('La cuenta no pertenece al catálogo de este contribuyente.')
    if (!acct.isPostable) throw new BadRequestError('Solo puedes mapear a cuentas afectables (hojas), no a cuentas acumulativas.')
  }

  await prisma.accountMapping.upsert({
    where: {
      organizationId_rfc_movementType: {
        organizationId: scope.organizationId,
        rfc: scope.rfc,
        movementType: movementType as AccountMovementType,
      },
    },
    update: { ledgerAccountId },
    create: { organizationId: scope.organizationId, rfc: scope.rfc, movementType: movementType as AccountMovementType, ledgerAccountId },
  })

  await logAction({
    staffId: actor.staffId ?? null,
    venueId,
    action: 'ACCOUNTING_MAPPING_UPDATED',
    entity: 'AccountMapping',
    data: { organizationId: scope.organizationId, rfc: scope.rfc, movementType, ledgerAccountId },
  })

  const def = MOVEMENT_TYPES.find(m => m.movementType === movementType)!
  const acct = ledgerAccountId
    ? await prisma.ledgerAccount.findUnique({
        where: { id: ledgerAccountId },
        select: { id: true, code: true, name: true, satGroupingCode: true, isActive: true },
      })
    : null
  return { movementType: def.movementType, label: def.label, side: def.side, group: def.group, defaultCode: def.defaultCode, account: acct }
}
