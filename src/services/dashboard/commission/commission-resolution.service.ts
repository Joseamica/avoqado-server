/**
 * Commission Resolution Service
 *
 * Resolves the effective commission configs for a venue using inheritance:
 * 1. If venue has its own configs → use those (venue wins entirely)
 * 2. If venue has NO configs → fall back to OrganizationCommissionConfigs (orgId set, venueId null)
 *
 * Same pattern as getEffectivePaymentConfig() — no merge, venue replaces org entirely.
 */

import prisma from '../../../utils/prismaClient'
import { NotFoundError } from '../../../errors/AppError'
import { logAction } from '../activity-log.service'

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
export async function createOrgCommissionConfig(venueId: string, data: any, createdById: string) {
  const organizationId = await getOrgIdFromVenue(venueId)

  const result = await prisma.commissionConfig.create({
    data: {
      ...data,
      orgId: organizationId,
      venueId: null, // Org-level: no venue
      createdById,
    },
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
export async function updateOrgCommissionConfig(venueId: string, configId: string, data: any) {
  const organizationId = await getOrgIdFromVenue(venueId)

  // Verify config belongs to this org and is org-level
  const existing = await prisma.commissionConfig.findFirst({
    where: { id: configId, orgId: organizationId, venueId: null },
  })
  if (!existing) throw new NotFoundError('Org commission config not found')

  const result = await prisma.commissionConfig.update({
    where: { id: configId },
    data,
    include: configInclude,
  })

  logAction({
    venueId,
    action: 'ORG_COMMISSION_CONFIG_UPDATED',
    entity: 'CommissionConfig',
    entityId: configId,
  })

  return result
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
