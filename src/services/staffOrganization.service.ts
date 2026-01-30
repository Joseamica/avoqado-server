/**
 * StaffOrganization Service
 *
 * Helper functions for the StaffOrganization junction table.
 * Provides org resolution for token generation and membership checks.
 *
 * Pattern: Stripe/GitHub/Slack multi-org membership
 */

import prisma from '@/utils/prismaClient'
import { OrgRole } from '@prisma/client'

/**
 * Get the primary organization ID for a staff member.
 * Used when generating tokens without a specific venue context (e.g., onboarding, refresh).
 */
export async function getPrimaryOrganizationId(staffId: string): Promise<string> {
  const primaryOrg = await prisma.staffOrganization.findFirst({
    where: {
      staffId,
      isPrimary: true,
      isActive: true,
    },
    select: { organizationId: true },
  })

  if (primaryOrg) {
    return primaryOrg.organizationId
  }

  // If no primary, try any active membership
  const anyOrg = await prisma.staffOrganization.findFirst({
    where: {
      staffId,
      isActive: true,
    },
    select: { organizationId: true },
    orderBy: { joinedAt: 'asc' },
  })

  if (anyOrg) {
    return anyOrg.organizationId
  }

  throw new Error(`Staff has no organization membership: ${staffId}`)
}

/**
 * Get organization ID from a venue.
 * Used when generating tokens with a specific venue context (login, switch).
 */
export async function getOrganizationIdFromVenue(venueId: string): Promise<string> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { organizationId: true },
  })

  if (!venue) {
    throw new Error(`Venue not found: ${venueId}`)
  }

  return venue.organizationId
}

/**
 * Check if a staff member has access to an organization.
 */
export async function hasOrganizationAccess(staffId: string, organizationId: string): Promise<boolean> {
  const membership = await prisma.staffOrganization.findUnique({
    where: {
      staffId_organizationId: {
        staffId,
        organizationId,
      },
    },
    select: { isActive: true },
  })

  return membership?.isActive ?? false
}

/**
 * Create a StaffOrganization membership.
 * Safe to call if membership already exists (upsert behavior).
 */
export async function createStaffOrganizationMembership(params: {
  staffId: string
  organizationId: string
  role: OrgRole
  isPrimary: boolean
  joinedById?: string
}): Promise<void> {
  await prisma.staffOrganization.upsert({
    where: {
      staffId_organizationId: {
        staffId: params.staffId,
        organizationId: params.organizationId,
      },
    },
    update: {
      isActive: true,
      role: params.role,
      isPrimary: params.isPrimary,
      leftAt: null,
    },
    create: {
      staffId: params.staffId,
      organizationId: params.organizationId,
      role: params.role,
      isPrimary: params.isPrimary,
      isActive: true,
      joinedById: params.joinedById,
    },
  })
}
