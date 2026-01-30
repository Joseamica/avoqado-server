import { OAuth2Client } from 'google-auth-library'
import { AuthenticationError, ForbiddenError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { StaffRole, OrgRole } from '@prisma/client'
import * as jwtService from '../../jwt.service'
import logger from '@/config/logger'
import { getPrimaryOrganizationId } from '../staffOrganization.service'

// Validate Google OAuth configuration
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.FRONTEND_URL) {
  logger.warn('Google OAuth not configured. Missing environment variables: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or FRONTEND_URL')
}

const client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.FRONTEND_URL}/auth/google/callback`,
)

interface GoogleUserInfo {
  id: string
  email: string
  name: string
  given_name?: string
  family_name?: string
  picture?: string
  email_verified: boolean
}

/**
 * Generate Google OAuth URL for authentication
 */
export function getGoogleAuthUrl(): string {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.FRONTEND_URL) {
    throw new AuthenticationError('Google OAuth is not configured on this server')
  }

  const scopes = ['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile']

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    include_granted_scopes: true,
  })

  return authUrl
}

/**
 * Verify Google OAuth token and get user info
 */
async function verifyGoogleToken(token: string): Promise<GoogleUserInfo> {
  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    })

    const payload = ticket.getPayload()
    if (!payload) {
      throw new AuthenticationError('Invalid Google token payload')
    }

    return {
      id: payload.sub,
      email: payload.email!,
      name: payload.name!,
      given_name: payload.given_name,
      family_name: payload.family_name,
      picture: payload.picture,
      email_verified: payload.email_verified || false,
    }
  } catch (error) {
    logger.error('Error verifying Google token', { error: error instanceof Error ? error.message : 'Unknown error' })
    throw new AuthenticationError('Failed to verify Google token')
  }
}

/**
 * Exchange Google authorization code for user info
 */
async function getGoogleUserFromCode(code: string): Promise<GoogleUserInfo> {
  try {
    const { tokens } = await client.getToken(code)

    if (!tokens.id_token) {
      throw new AuthenticationError('No ID token received from Google')
    }

    return await verifyGoogleToken(tokens.id_token)
  } catch (error) {
    logger.error('Error exchanging Google authorization code', { error: error instanceof Error ? error.message : 'Unknown error' })
    throw new AuthenticationError('Failed to exchange Google authorization code')
  }
}

/**
 * Login or register staff using Google OAuth
 */
export async function loginWithGoogle(
  codeOrToken: string,
  isCode: boolean = true,
): Promise<{
  accessToken: string
  refreshToken: string
  staff: any
  isNewUser: boolean
}> {
  // Get user info from Google
  const googleUser = isCode ? await getGoogleUserFromCode(codeOrToken) : await verifyGoogleToken(codeOrToken)

  if (!googleUser.email_verified) {
    throw new AuthenticationError('Email not verified with Google')
  }

  // Check if staff exists
  let staff = await prisma.staff.findUnique({
    where: { email: googleUser.email.toLowerCase() },
    include: {
      organizations: {
        where: { isPrimary: true, isActive: true },
        include: { organization: true },
        take: 1,
      },
      venues: {
        where: { active: true },
        include: {
          venue: {
            select: {
              id: true,
              name: true,
              slug: true,
              logo: true,
              status: true, // Single source of truth for venue state
              organizationId: true, // For deriving orgId in token generation
            },
          },
        },
      },
    },
  })

  let isNewUser = false

  // If staff doesn't exist, check if they were invited
  if (!staff) {
    // Look for an invitation for this email
    const invitation = await prisma.invitation.findFirst({
      where: {
        email: googleUser.email.toLowerCase(),
        status: 'PENDING',
        expiresAt: {
          gt: new Date(),
        },
      },
      include: {
        venue: {
          select: {
            id: true,
            name: true,
            slug: true,
            logo: true,
            status: true,
            organizationId: true,
            organization: true,
          },
        },
      },
    })

    if (!invitation) {
      throw new ForbiddenError('No invitation found for this email. Please contact your administrator to get invited.')
    }

    if (!invitation.venue) {
      throw new ForbiddenError('Invitation is missing venue information. Please contact your administrator.')
    }

    // Validate invitation data consistency
    if (invitation.venue.organizationId !== invitation.organizationId) {
      throw new ForbiddenError('Invitation data inconsistency: venue organization mismatch. Please contact your administrator.')
    }

    // Create new staff from invitation
    staff = await prisma.staff.create({
      data: {
        email: googleUser.email.toLowerCase(),
        firstName: googleUser.given_name || googleUser.name.split(' ')[0] || 'Unknown',
        lastName: googleUser.family_name || googleUser.name.split(' ').slice(1).join(' ') || '',
        photoUrl: googleUser.picture,
        emailVerified: true,
        googleId: googleUser.id,
        active: true,
        lastLoginAt: new Date(),
      },
      include: {
        organizations: {
          where: { isPrimary: true, isActive: true },
          include: { organization: true },
          take: 1,
        },
        venues: {
          where: { active: true },
          include: {
            venue: {
              select: {
                id: true,
                name: true,
                slug: true,
                logo: true,
                status: true,
              },
            },
          },
        },
      },
    })

    // Create StaffOrganization membership
    await prisma.staffOrganization.create({
      data: {
        staffId: staff.id,
        organizationId: invitation.organizationId,
        role: OrgRole.MEMBER,
        isPrimary: true,
        isActive: true,
      },
    })

    // Create staff-venue relationship and mark invitation as accepted IN PARALLEL
    // These operations are independent and can run concurrently
    const venueId = invitation.venueId || invitation.venue.id
    await Promise.all([
      prisma.staffVenue.create({
        data: {
          staffId: staff.id,
          venueId: venueId,
          role: invitation.role,
          active: true,
        },
      }),
      prisma.invitation.update({
        where: { id: invitation.id },
        data: {
          status: 'ACCEPTED',
          acceptedAt: new Date(),
        },
      }),
    ])

    // No need to refetch - we have all the data we need
    // Manually construct the organizations and venues arrays from the invitation data
    staff.organizations = [
      {
        organizationId: invitation.organizationId,
        organization: invitation.venue.organization,
      },
    ] as any

    staff.venues = [
      {
        staffId: staff.id,
        venueId: venueId,
        role: invitation.role,
        active: true,
        venue: {
          id: invitation.venue.id,
          name: invitation.venue.name,
          slug: invitation.venue.slug,
          logo: (invitation.venue as any).logo || null,
          status: (invitation.venue as any).status || 'ACTIVE',
          organizationId: invitation.venue.organizationId,
        },
      },
    ] as any

    isNewUser = true
  } else {
    // Update existing staff with Google info if not already set
    const updateData: any = {
      lastLoginAt: new Date(),
    }

    if (!staff.googleId) {
      updateData.googleId = googleUser.id
    }
    if (!staff.photoUrl && googleUser.picture) {
      updateData.photoUrl = googleUser.picture
    }
    if (!staff.emailVerified) {
      updateData.emailVerified = true
    }

    if (Object.keys(updateData).length > 1) {
      // More than just lastLoginAt
      await prisma.staff.update({
        where: { id: staff.id },
        data: updateData,
      })
    }
  }

  if (!staff || !staff.active) {
    throw new AuthenticationError('Account is inactive')
  }

  // World-Class Pattern (Stripe/Shopify): Allow OWNER login without venues if onboarding incomplete
  // This prevents chicken-and-egg problem: User needs to login to complete onboarding, but onboarding creates first venue
  if (staff.venues.length === 0) {
    // Check if user has OWNER role (primary owner created during signup)
    const organization = staff.organizations[0]?.organization
    const hasOwnerRole = organization ? staff.email === organization.email : false

    // If OWNER and onboarding not completed, allow login with placeholder venueId
    if (hasOwnerRole && organization && !organization.onboardingCompletedAt) {
      // Generate token with placeholder venueId for onboarding flow
      const orgId = await getPrimaryOrganizationId(staff.id)
      const accessToken = jwtService.generateAccessToken(staff.id, orgId, 'pending', StaffRole.OWNER)
      const refreshToken = jwtService.generateRefreshToken(staff.id, orgId)

      // Return with onboarding flag - same structure as normal login
      return {
        accessToken,
        refreshToken,
        staff: {
          id: staff.id,
          email: staff.email,
          firstName: staff.firstName,
          lastName: staff.lastName,
          organizationId: staff.organizations[0]?.organizationId ?? null,
          photoUrl: staff.photoUrl,
          role: StaffRole.OWNER, // CRITICAL: Include role so frontend can detect OWNER status for onboarding redirect
          venues: [], // Empty venues array (user needs to complete onboarding)
        },
        isNewUser,
      }
    }

    // Not OWNER or onboarding completed but no venue access → error
    throw new ForbiddenError('No venue access assigned')
  }

  // Use the first venue as default
  const selectedVenue = staff.venues[0]

  // Generate tokens (derive orgId from venue)
  const googleOrgId = selectedVenue.venue.organizationId
  const accessToken = jwtService.generateAccessToken(staff.id, googleOrgId, selectedVenue.venueId, selectedVenue.role)

  const refreshToken = jwtService.generateRefreshToken(staff.id, googleOrgId)

  // Format response
  const sanitizedStaff = {
    id: staff.id,
    email: staff.email,
    firstName: staff.firstName,
    lastName: staff.lastName,
    organizationId: staff.organizations[0]?.organizationId ?? null,
    photoUrl: staff.photoUrl,
    venues: staff.venues.map(sv => ({
      id: sv.venue.id,
      name: sv.venue.name,
      slug: sv.venue.slug,
      logo: sv.venue.logo,
      role: sv.role,
      status: sv.venue.status, // Single source of truth
    })),
  }

  return {
    accessToken,
    refreshToken,
    staff: sanitizedStaff,
    isNewUser,
  }
}

/**
 * Check if an email has a pending invitation
 */
export async function checkInvitationStatus(email: string): Promise<{
  hasInvitation: boolean
  venue?: {
    id: string
    name: string
    slug: string
  }
  role?: StaffRole
}> {
  const invitation = await prisma.invitation.findFirst({
    where: {
      email: email.toLowerCase(),
      status: 'PENDING',
      expiresAt: {
        gt: new Date(),
      },
    },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  })

  if (invitation) {
    return {
      hasInvitation: true,
      venue: invitation.venue || undefined,
      role: invitation.role,
    }
  }

  return { hasInvitation: false }
}

/**
 * Login or register staff using Google One Tap JWT credential
 * This is specifically for Google One Tap Sign-In which provides a JWT token directly
 */
export async function loginWithGoogleOneTap(credential: string): Promise<{
  accessToken: string
  refreshToken: string
  staff: any
  isNewUser: boolean
}> {
  // Verify the Google One Tap JWT credential
  const _googleUser = await verifyGoogleToken(credential)

  // Reuse the same logic as loginWithGoogle
  // The rest of the logic is the same - checking for existing staff, invitations, etc.
  return loginWithGoogle(credential, false)
}
