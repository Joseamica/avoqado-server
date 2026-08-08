import { OAuth2Client } from 'google-auth-library'
import { AuthenticationError, ForbiddenError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { StaffRole, OrgRole, InvitationStatus } from '@prisma/client'
import * as jwtService from '../../jwt.service'
import logger from '@/config/logger'
import { getPrimaryOrganizationId } from '../staffOrganization.service'
import { assertCanAddSeatsBulk } from '../access/seatCap.service'
import { logAction } from './activity-log.service'

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
  pendingInvitations?: {
    id: string
    token: string
    role: string
    venueName: string | null
    venueId: string | null
    organizationName: string
    organizationId: string
    expiresAt: string
  }[]
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

  // Audit context for an invitation this login auto-accepted. Written AFTER the transaction:
  // logAction is fire-and-forget and must never be able to roll back a signup.
  let acceptedInvitation: { invitationId: string; staffId: string; venueId: string; role: StaffRole; venueCount: number } | null = null

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

    const primaryVenueId = invitation.venueId || invitation.venue.id

    // 🔴 A PIN cannot be captured during an OAuth redirect. When the inviter required one we still
    // create the account (so the person can get in at all) but leave the invitation PENDING — the
    // `venues.length === 0` branch below returns it as a pending invitation and the frontend routes
    // them to /invite/:token, which collects the PIN. Auto-accepting here would silently drop the
    // PIN requirement and leave them unable to log into the TPV.
    const canAutoAccept = !invitation.requirePin

    // Parity with invitation.service.ts: an OWNER invitation carrying `inviteToAllVenues` grants
    // EVERY venue in the org, not just the invitation's own venue.
    const permissions = invitation.permissions as { inviteToAllVenues?: boolean } | null
    let venueIdsToAssign: string[] = [primaryVenueId]
    if (canAutoAccept && permissions?.inviteToAllVenues === true) {
      const orgVenues = await prisma.venue.findMany({
        where: { organizationId: invitation.organizationId },
        select: { id: true },
      })
      venueIdsToAssign = orgVenues.map(v => v.id)
    }

    // Free-tier seat cap: every venue here gets a BRAND-NEW seat. Checked BEFORE the transaction
    // because seatCap.service runs on the global client. Cap usage counts pending invitations and
    // this very invite is still PENDING, so exclude it for its own venue (off-by-one).
    if (canAutoAccept) {
      await assertCanAddSeatsBulk(venueIdsToAssign, { primaryVenueId, excludeInvitationId: invitation.id })
    }

    // Parity with invitation.service.ts: an OWNER invitation must become an OWNER at the
    // ORGANIZATION level too. Hardcoding MEMBER here left every Google-signup owner unable to
    // administer their own org.
    const orgRole = invitation.role === StaffRole.OWNER ? OrgRole.OWNER : OrgRole.MEMBER

    // One transaction: a half-applied signup leaves an orphan Staff row that owns the (globally
    // unique) email but has no org and no venue — the person can then never be invited again.
    const createdStaffId = await prisma.$transaction(async tx => {
      const created = await tx.staff.create({
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
        select: { id: true },
      })

      await tx.staffOrganization.create({
        data: {
          staffId: created.id,
          organizationId: invitation.organizationId,
          role: orgRole,
          isPrimary: true,
          isActive: true,
          joinedById: invitation.invitedById,
        },
      })

      if (canAutoAccept) {
        await tx.staffVenue.createMany({
          data: venueIdsToAssign.map(venueId => ({
            staffId: created.id,
            venueId,
            role: invitation.role,
            active: true,
          })),
        })

        await tx.invitation.update({
          where: { id: invitation.id },
          data: {
            status: InvitationStatus.ACCEPTED,
            acceptedAt: new Date(),
            acceptedById: created.id,
          },
        })
      }

      return created.id
    })

    if (canAutoAccept) {
      acceptedInvitation = {
        invitationId: invitation.id,
        staffId: createdStaffId,
        venueId: primaryVenueId,
        role: invitation.role,
        venueCount: venueIdsToAssign.length,
      }
    }

    // Refetch in the exact shape the rest of this function expects. The previous code hand-built
    // `organizations`/`venues` (cast through `as any`) to save a query; that stopped being safe
    // once one accept can grant N venues (inviteToAllVenues) or zero (requirePin).
    staff = await prisma.staff.findUniqueOrThrow({
      where: { id: createdStaffId },
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
                organizationId: true,
              },
            },
          },
        },
      },
    })

    logger.info('Google OAuth: staff created from invitation', {
      staffId: createdStaffId,
      email: googleUser.email.toLowerCase(),
      invitationId: invitation.id,
      autoAccepted: canAutoAccept,
      venueCount: canAutoAccept ? venueIdsToAssign.length : 0,
    })

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

  // Audit the accept — the owner audit screen reads ONLY ActivityLog, so an invitation accepted
  // through Google used to be invisible there while the password path was logged. Fire-and-forget,
  // outside the transaction, so an audit failure can never undo the signup.
  if (acceptedInvitation) {
    void logAction({
      staffId: acceptedInvitation.staffId,
      venueId: acceptedInvitation.venueId,
      action: 'INVITATION_ACCEPTED',
      entity: 'Invitation',
      entityId: acceptedInvitation.invitationId,
      data: { role: acceptedInvitation.role, via: 'GOOGLE_OAUTH', venueCount: acceptedInvitation.venueCount },
    })
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

    // Enterprise Pattern: Check for pending invitations before blocking
    // This allows users with no active venues but pending invitations to login
    // and be redirected to accept their invitations (same as email/password login)
    const pendingInvitations = await prisma.invitation.findMany({
      where: {
        email: staff.email.toLowerCase(),
        status: InvitationStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        token: true,
        role: true,
        venue: { select: { id: true, name: true } },
        organization: { select: { id: true, name: true } },
        expiresAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })

    if (pendingInvitations.length > 0) {
      // User has pending invitations - allow login with limited access
      // Frontend will redirect to invitation acceptance flow
      const orgId = staff.organizations[0]?.organizationId ?? pendingInvitations[0].organization.id
      const accessToken = jwtService.generateAccessToken(staff.id, orgId, 'pending-invitation', StaffRole.VIEWER)
      const refreshToken = jwtService.generateRefreshToken(staff.id, orgId)

      logger.info('Google OAuth: User logged in with pending invitations (no active venues)', {
        staffId: staff.id,
        email: staff.email,
        pendingInvitationsCount: pendingInvitations.length,
      })

      return {
        accessToken,
        refreshToken,
        staff: {
          id: staff.id,
          email: staff.email,
          firstName: staff.firstName,
          lastName: staff.lastName,
          organizationId: orgId,
          photoUrl: staff.photoUrl,
          role: StaffRole.VIEWER,
          venues: [],
        },
        isNewUser,
        // Include pending invitations for frontend to handle
        pendingInvitations: pendingInvitations.map(inv => ({
          id: inv.id,
          token: inv.token,
          role: inv.role,
          venueName: inv.venue?.name ?? null,
          venueId: inv.venue?.id ?? null,
          organizationName: inv.organization.name,
          organizationId: inv.organization.id,
          expiresAt: inv.expiresAt.toISOString(),
        })),
      }
    }

    // Not OWNER, no pending invitations, no venue access → error
    throw new ForbiddenError('No venue access assigned', 'NO_VENUE_ACCESS')
  }

  // Use the first venue as default
  const selectedVenue = staff.venues[0]

  // Generate tokens (derive orgId from venue)
  const googleOrgId = selectedVenue.venue.organizationId
  const accessToken = jwtService.generateAccessToken(staff.id, googleOrgId, selectedVenue.venueId, selectedVenue.role)

  const refreshToken = jwtService.generateRefreshToken(staff.id, googleOrgId)

  // Access log. `loginWithGoogleOneTap` delegates here, so this single row covers both SSO
  // paths. The method is recorded separately because in a security review signing in with a
  // password is not the same as signing in with a Google account.
  void logAction({
    staffId: staff.id,
    venueId: selectedVenue.venueId,
    action: 'STAFF_LOGIN',
    entity: 'Staff',
    entityId: staff.id,
    data: { source: 'dashboard', method: 'google', role: selectedVenue.role },
  })

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
  pendingInvitations?: {
    id: string
    token: string
    role: string
    venueName: string | null
    venueId: string | null
    organizationName: string
    organizationId: string
    expiresAt: string
  }[]
}> {
  // Verify the Google One Tap JWT credential
  const _googleUser = await verifyGoogleToken(credential)

  // Reuse the same logic as loginWithGoogle
  // The rest of the logic is the same - checking for existing staff, invitations, etc.
  return loginWithGoogle(credential, false)
}
