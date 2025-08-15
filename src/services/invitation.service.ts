import bcrypt from 'bcrypt'
import { v4 as uuidv4 } from 'uuid'
import { InvitationStatus, Prisma } from '@prisma/client'
import prisma from '../utils/prismaClient'
import AppError from '../errors/AppError'
import { generateAccessToken, generateRefreshToken } from '../jwt.service'
import logger from '../config/logger'

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

  // Return invitation details for the frontend
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    organizationName: invitation.organization.name,
    venueName: invitation.venue?.name || null,
    inviterName: `${invitation.invitedBy.firstName} ${invitation.invitedBy.lastName}`,
    expiresAt: invitation.expiresAt.toISOString(),
    status: invitation.status,
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

    // Check if user with this email already exists
    const existingStaff = await tx.staff.findFirst({
      where: {
        email: invitation.email,
        organizationId: invitation.organizationId,
      },
      include: {
        venues: {
          where: {
            active: true,
          },
        },
      },
    })

    // Only prevent if user exists, is active, and has active venue assignments
    if (existingStaff && existingStaff.active && existingStaff.venues.length > 0) {
      throw new AppError('Ya existe un usuario activo con este email en la organización', 409)
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(userData.password, 12)

    // Validate and hash the PIN if provided (PIN is stored in StaffVenue, not Staff)
    let hashedPin: string | null = null
    if (userData.pin) {
      // Check if PIN is already used in this venue
      if (invitation.venueId) {
        const existingPinUser = await tx.staffVenue.findFirst({
          where: {
            venueId: invitation.venueId,
            pin: {
              not: null,
            },
            active: true,
          },
          include: {
            staff: true,
          },
        })

        // Verify PIN against all existing hashed PINs in the venue
        if (existingPinUser) {
          const allStaffWithPins = await tx.staffVenue.findMany({
            where: {
              venueId: invitation.venueId,
              pin: {
                not: null,
              },
              active: true,
            },
          })

          for (const staff of allStaffWithPins) {
            const pinMatches = await bcrypt.compare(userData.pin, staff.pin!)
            if (pinMatches) {
              throw new AppError('Este PIN ya está siendo utilizado por otro miembro del equipo', 409)
            }
          }
        }
      }

      hashedPin = await bcrypt.hash(userData.pin, 12)
    }

    // Create or reuse the staff record
    let staff
    if (existingStaff) {
      // Reuse existing staff record and update their information
      staff = await tx.staff.update({
        where: { id: existingStaff.id },
        data: {
          password: hashedPassword,
          firstName: userData.firstName,
          lastName: userData.lastName,
          active: true,
          emailVerified: true, // Since they responded to email invitation
        },
      })
    } else {
      // Create new staff record
      staff = await tx.staff.create({
        data: {
          id: uuidv4(),
          organizationId: invitation.organizationId,
          email: invitation.email,
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
            pin: hashedPin,
            active: true,
            startDate: new Date(),
          },
        })
      } else {
        // Create new assignment
        await tx.staffVenue.create({
          data: {
            id: uuidv4(),
            staffId: staff.id,
            venueId: invitation.venueId,
            role: invitation.role,
            pin: hashedPin, // PIN is stored per venue
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
