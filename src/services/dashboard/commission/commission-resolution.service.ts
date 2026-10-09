/**
 * Commission Resolution Service
 *
 * Resolves the effective commission configs for a venue using inheritance:
 * 1. If venue has its own configs → use those (venue wins entirely)
 * 2. If venue has NO configs → fall back to OrganizationCommissionConfigs (orgId set, venueId null)
 *
 * Same pattern as getEffectivePaymentConfig() — no merge, venue replaces org entirely.
 */

import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { NotFoundError } from '../../../errors/AppError'
import { logAction } from '../activity-log.service'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { validarTasasDelEsquema } from './tasasDelEsquema'
import { personasElegidasAGuardar } from './personasElegidas'
import { rechazarCambiosConComisiones, sinLoQueNoCambia, soloCamposDelEsquema } from './cambiosConComisiones'
import { validateAttendanceRule } from './commission-config.service'
import { asegurarIdsDelNegocio } from './idsDelNegocio'

export type CommissionConfigSource = 'venue' | 'organization'

export interface ResolvedCommissionConfig {
  config: any // CommissionConfig with relations
  source: CommissionConfigSource
}

/**
 * Get organizationId from venueId
 */
async function getOrgIdFromVenue(venueId: string): Promise<string> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { organizationId: true },
  })
  if (!venue) throw new NotFoundError('Venue not found')
  return venue.organizationId
}

const configInclude = {
  tiers: { where: { active: true }, orderBy: { tierLevel: 'asc' as const } },
  milestones: { where: { active: true } },
  overrides: { where: { active: true } },
}

/**
 * Get effective commission configs for a venue.
 * Returns venue configs if any exist, otherwise falls back to org-level configs.
 */
export async function getEffectiveCommissionConfigs(venueId: string): Promise<ResolvedCommissionConfig[]> {
  // 1. Check venue-level configs
  const venueConfigs = await prisma.commissionConfig.findMany({
    where: { venueId, active: true, deletedAt: null },
    include: configInclude,
    orderBy: { priority: 'desc' },
  })

  if (venueConfigs.length > 0) {
    return venueConfigs.map(c => ({ config: c, source: 'venue' as const }))
  }

  // 2. Fallback: org-level configs
  const organizationId = await getOrgIdFromVenue(venueId)

  const orgConfigs = await prisma.commissionConfig.findMany({
    where: { orgId: organizationId, venueId: null, active: true, deletedAt: null },
    include: configInclude,
    orderBy: { priority: 'desc' },
  })

  return orgConfigs.map(c => ({ config: c, source: 'organization' as const }))
}

// ==========================================
// ORG-LEVEL CONFIG CRUD
// ==========================================

/**
 * Get all org-level commission configs
 */
export async function getOrgCommissionConfigs(venueId: string) {
  const organizationId = await getOrgIdFromVenue(venueId)

  return prisma.commissionConfig.findMany({
    where: { orgId: organizationId, venueId: null, deletedAt: null },
    include: configInclude,
    orderBy: { priority: 'desc' },
  })
}

/**
 * Create an org-level commission config
 */
export async function createOrgCommissionConfig(venueId: string, cuerpo: unknown, createdById: string) {
  // FT-GRAVES T1: sólo la lista blanca de la sede. Antes el cuerpo iba tal cual: elegía el id, nacía borrado o creaba filas
  // anidadas en otro negocio.
  const data = soloCamposDelEsquema(cuerpo)
  // Final-fijo-niveles (fase 3): esta ruta no validaba ninguna tasa — un fijo de $5 con niveles quedaba como 500 %.
  validarTasasDelEsquema(data)
  validateAttendanceRule(data)
  const organizationId = await getOrgIdFromVenue(venueId)
  // D-ELEGIDOS: sólo personas del equipo de la ORGANIZACIÓN (alguna de sus sedes), sin repetidos.
  const elegidos = await personasElegidasAGuardar(data, { organizationId })
  await asegurarIdsDelNegocio({ organizationId }, { categoryIds: data.categoryIds }) // de alguna de SUS sedes (T1-hermanos)

  const result = await prisma.commissionConfig.create({
    data: {
      ...data,
      roleRates: data.roleRates ?? Prisma.JsonNull,
      ...elegidos,
      orgId: organizationId,
      venueId: null, // Org-level: no venue
      createdById,
    } as Prisma.CommissionConfigUncheckedCreateInput,
    include: configInclude,
  })

  logAction({
    staffId: createdById,
    venueId,
    action: 'ORG_COMMISSION_CONFIG_CREATED',
    entity: 'CommissionConfig',
    entityId: result.id,
    data: { name: data.name },
  })

  return result
}

/**
 * Update an org-level commission config
 */
export async function updateOrgCommissionConfig(venueId: string, configId: string, cuerpo: unknown, actorId?: string) {
  const organizationId = await getOrgIdFromVenue(venueId)

  // Verify config belongs to this org and is org-level
  const existing = await prisma.commissionConfig.findFirst({
    where: { id: configId, orgId: organizationId, venueId: null, deletedAt: null },
    include: { _count: { select: { calculations: true } } },
  })
  if (!existing) throw new NotFoundError('Org commission config not found')
  // FT-GRAVES T1: la lista blanca de la sede (antes el cuerpo iba tal cual y movía el esquema de organización o de negocio) y el
  // mismo candado: con comisiones calculadas no cambia la tasa, el tipo, a quién ni cuándo (`cambiosConComisiones.ts`).
  const data = sinLoQueNoCambia(soloCamposDelEsquema(cuerpo, { conActive: true }), existing)
  rechazarCambiosConComisiones(data, existing, existing._count.calculations)
  validateAttendanceRule(data)
  validarTasasDelEsquema(data, existing) // lo que QUEDA (final-fijo-niveles, fase 3)
  const elegidos = await personasElegidasAGuardar(data, { organizationId }, existing)
  await asegurarIdsDelNegocio({ organizationId }, { categoryIds: data.categoryIds }) // de alguna de SUS sedes (T1-hermanos)

  // El cambio y su ActivityLog (con quién lo hizo) en la MISMA transacción.
  return prisma.$transaction(async tx => {
    const actualizado = await tx.commissionConfig.update({
      where: { id: configId },
      data: {
        ...data,
        ...(data.roleRates === null ? { roleRates: Prisma.JsonNull } : {}),
        ...elegidos,
      } as Prisma.CommissionConfigUncheckedUpdateInput,
      include: configInclude,
    })
    await writeLegacyActivityAuditTx(tx, {
      staffId: actorId ?? null,
      venueId,
      action: 'ORG_COMMISSION_CONFIG_UPDATED',
      entity: 'CommissionConfig',
      entityId: configId,
      data: { changes: Object.keys(data), ...(data.active !== undefined ? { active: data.active } : {}) },
    })
    return actualizado
  })
}

/**
 * Soft-delete an org-level commission config
 */
export async function deleteOrgCommissionConfig(venueId: string, configId: string, deletedBy: string) {
  const organizationId = await getOrgIdFromVenue(venueId)

  const existing = await prisma.commissionConfig.findFirst({
    where: { id: configId, orgId: organizationId, venueId: null },
  })
  if (!existing) throw new NotFoundError('Org commission config not found')

  const result = await prisma.commissionConfig.update({
    where: { id: configId },
    data: { active: false, deletedAt: new Date(), deletedBy },
  })

  logAction({
    staffId: deletedBy,
    venueId,
    action: 'ORG_COMMISSION_CONFIG_DELETED',
    entity: 'CommissionConfig',
    entityId: configId,
  })

  return result
}
