import bcrypt from 'bcrypt'
import { v4 as uuidv4 } from 'uuid'
import { InvitationStatus, Prisma, StaffRole } from '@prisma/client'
import prisma from '../utils/prismaClient'
import AppError from '../errors/AppError'
import { generateAccessToken, generateRefreshToken } from '../jwt.service'
import logger from '../config/logger'
import { getRoleDisplayName } from './dashboard/venueRoleConfig.dashboard.service'

interface AcceptInvitationData {
  firstName: string
  lastName: string
  password: string
  pin?: string | null
}

interface AcceptInvitationResult {
  user: {
    id: string
    email: string
    firstName: string
    lastName: string
    organizationId: string
  }
  tokens: {
    accessToken: string | null
    refreshToken: string
  }
}

export async function getInvitationByToken(token: string) {
  const invitation = await prisma.invitation.findFirst({
    where: {
      token,
      status: InvitationStatus.PENDING,
    },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
        },
      },
      venue: {
        select: {
          id: true,
          name: true,
        },
      },
      invitedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  if (!invitation) {
    throw new AppError('Invitación no encontrada o ya utilizada', 404)
  }

  // Check if invitation is expired
  if (new Date() > invitation.expiresAt) {
    throw new AppError('La invitación ha expirado', 410)
  }

  // Get the staff record if it exists (might have been invited to another venue before)
  // Use toLowerCase() for consistent case-insensitive email lookups
  const staff = await prisma.staff.findUnique({
    where: { email: invitation.email.toLowerCase() },
    select: {
      firstName: true,
      lastName: true,
      password: true, // Check if they already have a password
      organizationId: true,
    },
  })

  // Check if user exists in a DIFFERENT organization (they'll need to contact support)
  const existsInDifferentOrg = staff && staff.organizationId !== invitation.organizationId

  // Check if user already has an account with password (skip password form on frontend)
  const userAlreadyHasPassword = staff && staff.password !== null && !existsInDifferentOrg

  // Get custom role display name from venue config (if venue exists)
  let roleDisplayName: string | null = null
  if (invitation.venue?.id) {
    try {
      roleDisplayName = await getRoleDisplayName(invitation.venue.id, invitation.role as StaffRole)
    } catch (error) {
      // If role config lookup fails, roleDisplayName stays null (frontend will use default)
      logger.warn('Failed to get role display name for invitation', {
        venueId: invitation.venue.id,
        role: invitation.role,
        error,
      })
    }
  }

  // Return invitation details for the frontend
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    roleDisplayName, // Custom role name from venue settings (if configured)
    organizationName: invitation.organization.name,
    venueName: invitation.venue?.name || null,
    inviterName: `${invitation.invitedBy.firstName} ${invitation.invitedBy.lastName}`,
    expiresAt: invitation.expiresAt.toISOString(),
    status: invitation.status,
    // Include firstName/lastName if staff record exists
    firstName: staff?.firstName || null,
    lastName: staff?.lastName || null,
    // Multi-venue support: inform frontend about user's existing account status
    userAlreadyHasPassword: userAlreadyHasPassword || false, // If true, skip password form
    existsInDifferentOrg: existsInDifferentOrg || false, // If true, show "contact support" message
  }
}

export async function acceptInvitation(token: string, userData: AcceptInvitationData): Promise<AcceptInvitationResult> {
  // Start a transaction to ensure data consistency
  return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Get and validate invitation
    const invitation = await tx.invitation.findFirst({
      where: {
        token,
        status: InvitationStatus.PENDING,
      },
      include: {
        organization: true,
        venue: true,
      },
    })

    if (!invitation) {
      throw new AppError('Invitación no encontrada o ya utilizada', 404)
    }

    // Check if invitation is expired
    if (new Date() > invitation.expiresAt) {
      throw new AppError('La invitación ha expirado', 410)
    }

    // Check if user with this email already exists GLOBALLY
    // Staff.email is globally unique - one person = one Staff account
    // Use toLowerCase() for consistent case-insensitive email lookups
    const existingStaff = await tx.staff.findUnique({
      where: {
        email: invitation.email.toLowerCase(),
      },
      include: {
        venues: {
          where: {
            active: true,
          },
        },
      },
    })

    // If user exists in a DIFFERENT organization, we need to handle this case
    // Currently, the data model requires Staff to belong to one organization
    // But they can be in multiple venues within that organization
    if (existingStaff && existingStaff.organizationId !== invitation.organizationId) {
      throw new AppError(
        'Este email ya está registrado en otra organización. Por favor, contacta a soporte si necesitas acceso a múltiples organizaciones.',
        409,
      )
    }

    // If user exists in the SAME organization, that's fine!
    // They're being invited to a new venue within the same org
    // No need to block - we'll just add them to the new venue

    // Hash the password
    const hashedPassword = await bcrypt.hash(userData.password, 12)

    // Validate PIN if provided (stored as PLAIN TEXT for fast TPV login)
    // ⚠️ PIN is NOT hashed - auth.tpv.service.ts does plain text comparison
    let validatedPin: string | null = null
    if (userData.pin) {
      // Check if PIN is already used in this venue (plain text comparison)
      if (invitation.venueId) {
        const existingPinUser = await tx.staffVenue.findFirst({
          where: {
            venueId: invitation.venueId,
            pin: userData.pin, // Plain text comparison
            active: true,
          },
        })

        if (existingPinUser) {
          throw new AppError('PIN no disponible. Por favor, elige otro diferente.', 409)
        }
      }

      validatedPin = userData.pin // Store as plain text
    }

    // Create or reuse the staff record
    let staff
    if (existingStaff) {
      // User already exists in this organization
      // DON'T overwrite their password or name - they already have valid credentials
      // Just ensure they're active and verified
      const updateData: Prisma.StaffUpdateInput = {
        active: true,
        emailVerified: true, // Since they responded to email invitation
      }

      // Only update password if they don't have one (PIN-only users being upgraded)
      if (!existingStaff.password && hashedPassword) {
        updateData.password = hashedPassword
      }

      // Only update name if they don't have one set
      if (!existingStaff.firstName && userData.firstName) {
        updateData.firstName = userData.firstName
      }
      if (!existingStaff.lastName && userData.lastName) {
        updateData.lastName = userData.lastName
      }

      staff = await tx.staff.update({
        where: { id: existingStaff.id },
        data: updateData,
      })

      logger.info('Existing staff member invited to new venue', {
        staffId: staff.id,
        email: staff.email,
        newVenueId: invitation.venueId,
        existingVenuesCount: existingStaff.venues.length,
      })
    } else {
      // Brand new user - create staff record with all provided data
      // IMPORTANT: Normalize email to lowercase for consistent login lookups
      staff = await tx.staff.create({
        data: {
          id: uuidv4(),
          organizationId: invitation.organizationId,
          email: invitation.email.toLowerCase(),
          password: hashedPassword,
          firstName: userData.firstName,
          lastName: userData.lastName,
          active: true,
          emailVerified: true, // Since they responded to email invitation
        },
      })
    }

    // Create the staff-venue relationship if venue is specified
    if (invitation.venueId) {
      // Check if this staff is already assigned to this venue
      const existingAssignment = await tx.staffVenue.findUnique({
        where: {
          staffId_venueId: {
            staffId: staff.id,
            venueId: invitation.venueId,
          },
        },
      })

      if (existingAssignment) {
        // Update existing assignment instead of creating new one
        await tx.staffVenue.update({
          where: { id: existingAssignment.id },
          data: {
            role: invitation.role,
            pin: validatedPin,
            active: true,
            startDate: new Date(),
          },
        })
      } else {
        // Create new assignment (let Prisma auto-generate CUID)
        await tx.staffVenue.create({
          data: {
            staffId: staff.id,
            venueId: invitation.venueId,
            role: invitation.role,
            pin: validatedPin, // PIN is stored per venue
            active: true,
            startDate: new Date(),
            totalSales: 0,
            totalTips: 0,
            averageRating: 0,
            totalOrders: 0,
          },
        })
      }
    }

    // Mark invitation as accepted
    await tx.invitation.update({
      where: { id: invitation.id },
      data: {
        status: InvitationStatus.ACCEPTED,
        acceptedAt: new Date(),
        acceptedById: staff.id,
      },
    })

    // Generate tokens for immediate login
    // We need a venue ID to generate access token, so we'll use the invitation venue or find user's first venue
    let venueId = invitation.venueId
    let role = invitation.role

    if (!venueId) {
      // If no specific venue, find user's first venue assignment
      const firstVenueAssignment = await tx.staffVenue.findFirst({
        where: { staffId: staff.id },
        include: { venue: true },
      })

      if (firstVenueAssignment) {
        venueId = firstVenueAssignment.venueId
        role = firstVenueAssignment.role
      }
    }

    const tokens = {
      accessToken: venueId ? generateAccessToken(staff.id, staff.organizationId, venueId, role) : null,
      refreshToken: generateRefreshToken(staff.id, staff.organizationId),
    }

    logger.info('Invitation accepted and user created', {
      staffId: staff.id,
      email: staff.email,
      organizationId: staff.organizationId,
      venueId: invitation.venueId,
      role: invitation.role,
    })

    return {
      user: {
        id: staff.id,
        email: staff.email,
        firstName: staff.firstName,
        lastName: staff.lastName,
        organizationId: staff.organizationId,
      },
      tokens,
    }
  })
}
