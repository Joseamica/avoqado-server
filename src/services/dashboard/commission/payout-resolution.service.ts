/**
 * Payout Resolution Service
 *
 * Resolves the effective payout configuration for a venue using the inheritance pattern:
 * 1. If venue's CommissionConfig has payout settings → use those (venue-level)
 * 2. If venue has NO custom payout config → fall back to OrganizationPayoutConfig
 *
 * Same pattern as getEffectivePaymentConfig() and goal-resolution.service.ts
 */

import prisma from '../../../utils/prismaClient'
import { NotFoundError } from '../../../errors/AppError'

// ==========================================
// TYPES
// ==========================================

export type PayoutSource = 'venue' | 'organization'

export interface PayoutConfig {
  aggregationPeriod: string
  requireApproval: boolean
  paymentMethods: string[]
}

export interface ResolvedPayoutConfig {
  config: PayoutConfig
  source: PayoutSource
}

export interface OrgPayoutConfigInput {
  aggregationPeriod?: string
  requireApproval?: boolean
  paymentMethods?: string[]
}

// ==========================================
// HELPER: Get org ID from venue
// ==========================================

async function getOrgIdFromVenue(venueId: string): Promise<string> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { organizationId: true },
  })

  if (!venue?.organizationId) {
    throw new NotFoundError('Venue not found or has no organization')
  }

  return venue.organizationId
}

// ==========================================
// RESOLUTION
// ==========================================

/**
 * Get the effective payout configuration for a venue.
 * Venue-level CommissionConfig.aggregationPeriod wins if it exists,
 * otherwise falls back to OrganizationPayoutConfig.
 */
export async function getEffectivePayoutConfig(venueId: string): Promise<ResolvedPayoutConfig> {
  // Check if venue has any active commission config (venue-level payout comes from there)
  const venueConfig = await prisma.commissionConfig.findFirst({
    where: {
      venueId,
      active: true,
      deletedAt: null,
    },
    orderBy: { priority: 'desc' },
    select: {
      aggregationPeriod: true,
    },
  })

  if (venueConfig) {
    return {
      config: {
        aggregationPeriod: venueConfig.aggregationPeriod,
        requireApproval: true, // default at venue level
        paymentMethods: ['CASH', 'BANK_TRANSFER'],
      },
      source: 'venue',
    }
  }

  // Fall back to org-level payout config
  const orgId = await getOrgIdFromVenue(venueId)

  const orgConfig = await prisma.organizationPayoutConfig.findUnique({
    where: { organizationId: orgId },
  })

  if (orgConfig) {
    return {
      config: {
        aggregationPeriod: orgConfig.aggregationPeriod,
        requireApproval: orgConfig.requireApproval,
        paymentMethods: orgConfig.paymentMethods,
      },
      source: 'organization',
    }
  }

  // Default config if nothing is configured
  return {
    config: {
      aggregationPeriod: 'MONTHLY',
      requireApproval: true,
      paymentMethods: ['CASH', 'BANK_TRANSFER'],
    },
    source: 'organization',
  }
}

// ==========================================
// ORG PAYOUT CONFIG CRUD
// ==========================================

export async function getOrgPayoutConfig(venueId: string) {
  const orgId = await getOrgIdFromVenue(venueId)

  return prisma.organizationPayoutConfig.findUnique({
    where: { organizationId: orgId },
  })
}

export async function upsertOrgPayoutConfig(venueId: string, input: OrgPayoutConfigInput) {
  const orgId = await getOrgIdFromVenue(venueId)

  return prisma.organizationPayoutConfig.upsert({
    where: { organizationId: orgId },
    create: {
      organizationId: orgId,
      aggregationPeriod: input.aggregationPeriod ?? 'MONTHLY',
      requireApproval: input.requireApproval ?? true,
      paymentMethods: input.paymentMethods ?? ['CASH', 'BANK_TRANSFER'],
    },
    update: {
      ...(input.aggregationPeriod !== undefined && { aggregationPeriod: input.aggregationPeriod }),
      ...(input.requireApproval !== undefined && { requireApproval: input.requireApproval }),
      ...(input.paymentMethods !== undefined && { paymentMethods: input.paymentMethods }),
    },
  })
}

export async function deleteOrgPayoutConfig(venueId: string) {
  const orgId = await getOrgIdFromVenue(venueId)

  return prisma.organizationPayoutConfig.delete({
    where: { organizationId: orgId },
  })
}

export const payoutResolutionService = {
  getEffectivePayoutConfig,
  getOrgPayoutConfig,
  upsertOrgPayoutConfig,
  deleteOrgPayoutConfig,
}
