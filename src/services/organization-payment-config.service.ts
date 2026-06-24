/**
 * Organization Payment Config Resolution Service
 *
 * Provides runtime resolution of payment configuration with two-level inheritance:
 *   1. VenuePaymentConfig (explicit venue override) — wins when present
 *   2. OrganizationPaymentConfig (inherited by all venues without their own config)
 *
 * Same pattern as the module system (VenueModule → OrganizationModule).
 */

import prisma from '@/utils/prismaClient'
import { AccountType } from '@prisma/client'

type ConfigSource = 'venue' | 'organization'

// Shared include for merchant account details
const merchantAccountInclude = {
  provider: true,
  costStructures: {
    where: { active: true },
    orderBy: { effectiveFrom: 'desc' as const },
    take: 1,
  },
} as const

/**
 * Resolve the effective payment config for a venue.
 * Checks venue-level first, then falls back to organization-level.
 */
export async function getEffectivePaymentConfig(venueId: string) {
  // 1. Check venue-level config
  const venueConfig = await prisma.venuePaymentConfig.findUnique({
    where: { venueId },
    include: {
      primaryAccount: { include: merchantAccountInclude },
      secondaryAccount: { include: merchantAccountInclude },
      tertiaryAccount: { include: merchantAccountInclude },
    },
  })

  if (venueConfig) {
    return { config: venueConfig, source: 'venue' as ConfigSource }
  }

  // 2. Fallback to organization-level config
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { organizationId: true },
  })

  if (!venue) return null

  const orgConfig = await prisma.organizationPaymentConfig.findUnique({
    where: { organizationId: venue.organizationId },
    include: {
      primaryAccount: { include: merchantAccountInclude },
      secondaryAccount: { include: merchantAccountInclude },
      tertiaryAccount: { include: merchantAccountInclude },
    },
  })

  if (orgConfig) {
    return { config: orgConfig, source: 'organization' as ConfigSource }
  }

  return null
}

/**
 * Resolve the effective pricing structure for a venue + account type.
 * Checks venue-level first, then falls back to organization-level.
 *
 * @param venueId      Venue to resolve pricing for.
 * @param accountType  Legacy slot accountType (PRIMARY/SECONDARY/TERTIARY).
 * @param opts.effectiveAt        Date the pricing must be active at. Defaults to
 *                                `new Date()`. Pass the PAYMENT's date when costing
 *                                historically (recompute) so rates are not anchored
 *                                to today (was a latent bug — the function used
 *                                `new Date()` unconditionally).
 * @param opts.merchantAccountId  When set, per-account pricing
 *                                (VenuePricingStructure.merchantAccountId, PR-1) is
 *                                tried FIRST and wins over the legacy accountType
 *                                rows. Forward-compatible: no per-account rows exist
 *                                yet, so this currently always falls through to the
 *                                legacy path (zero behavior change for live calls).
 */
export async function getEffectivePricing(
  venueId: string,
  accountType?: AccountType,
  opts?: { merchantAccountId?: string; effectiveAt?: Date },
) {
  const at = opts?.effectiveAt ?? new Date()
  const window = {
    active: true,
    effectiveFrom: { lte: at },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
  }

  // Resolve the org lazily and at most once (used by both org-level fallbacks).
  let organizationId: string | null | undefined
  const orgId = async () => {
    if (organizationId === undefined) {
      const v = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
      organizationId = v?.organizationId ?? null
    }
    return organizationId
  }

  // (A) Per-account pricing (PR-2): a row keyed to the exact merchant account that
  // processed the payment wins over the legacy accountType rows. Today this returns
  // nothing (no per-account rows seeded) and we fall through to (B) below.
  if (opts?.merchantAccountId) {
    const venuePerAccount = await prisma.venuePricingStructure.findMany({
      where: { venueId, merchantAccountId: opts.merchantAccountId, ...window },
      orderBy: [{ effectiveFrom: 'desc' }],
    })
    if (venuePerAccount.length > 0) return { pricing: venuePerAccount, source: 'venue' as ConfigSource }

    const oid = await orgId()
    if (oid) {
      const orgPerAccount = await prisma.organizationPricingStructure.findMany({
        where: { organizationId: oid, merchantAccountId: opts.merchantAccountId, ...window },
        orderBy: [{ effectiveFrom: 'desc' }],
      })
      if (orgPerAccount.length > 0) return { pricing: orgPerAccount, source: 'organization' as ConfigSource }
    }
  }

  // (B) Legacy accountType-keyed pricing (today's behavior). `merchantAccountId: null`
  // selects ONLY legacy rows so per-account rows (PR-4+) never leak into this path;
  // today every row has a null merchantAccountId, so this filter is behavior-preserving.
  const legacyWhere = {
    ...window,
    merchantAccountId: null,
    ...(accountType ? { accountType } : {}),
  }

  // 1. Check venue-level pricing
  const venuePricing = await prisma.venuePricingStructure.findMany({
    where: { venueId, ...legacyWhere },
    orderBy: [{ accountType: 'asc' }, { effectiveFrom: 'desc' }],
  })

  if (venuePricing.length > 0) {
    return { pricing: venuePricing, source: 'venue' as ConfigSource }
  }

  // 2. Fallback to organization-level pricing
  const oid = await orgId()
  if (!oid) return null

  const orgPricing = await prisma.organizationPricingStructure.findMany({
    where: { organizationId: oid, ...legacyWhere },
    orderBy: [{ accountType: 'asc' }, { effectiveFrom: 'desc' }],
  })

  if (orgPricing.length > 0) {
    return { pricing: orgPricing, source: 'organization' as ConfigSource }
  }

  return null
}

/**
 * Get venue config sources for all venues in an organization.
 * Used by the admin UI to show inheritance status per venue.
 */
export async function getVenueConfigSources(organizationId: string) {
  const venues = await prisma.venue.findMany({
    where: { organizationId },
    select: {
      id: true,
      name: true,
      slug: true,
      paymentConfig: { select: { id: true } },
      pricingStructures: {
        where: { active: true },
        select: { id: true },
        take: 1,
      },
    },
    orderBy: { name: 'asc' },
  })

  const orgConfig = await prisma.organizationPaymentConfig.findUnique({
    where: { organizationId },
    select: { id: true },
  })

  const orgPricing = await prisma.organizationPricingStructure.findFirst({
    where: { organizationId, active: true },
    select: { id: true },
  })

  return venues.map(venue => ({
    venueId: venue.id,
    venueName: venue.name,
    venueSlug: venue.slug,
    paymentConfig: {
      source: venue.paymentConfig ? 'venue' : orgConfig ? 'organization' : 'none',
      hasVenueOverride: !!venue.paymentConfig,
    },
    pricing: {
      source: venue.pricingStructures.length > 0 ? 'venue' : orgPricing ? 'organization' : 'none',
      hasVenueOverride: venue.pricingStructures.length > 0,
    },
  }))
}

/**
 * Get the organization payment config directly (for admin CRUD).
 */
export async function getOrganizationPaymentConfig(organizationId: string) {
  return prisma.organizationPaymentConfig.findUnique({
    where: { organizationId },
    include: {
      primaryAccount: { include: merchantAccountInclude },
      secondaryAccount: { include: merchantAccountInclude },
      tertiaryAccount: { include: merchantAccountInclude },
    },
  })
}

/**
 * Get organization pricing structures directly (for admin CRUD).
 */
export async function getOrganizationPricing(organizationId: string) {
  return prisma.organizationPricingStructure.findMany({
    where: { organizationId, active: true },
    orderBy: [{ accountType: 'asc' }, { effectiveFrom: 'desc' }],
  })
}
