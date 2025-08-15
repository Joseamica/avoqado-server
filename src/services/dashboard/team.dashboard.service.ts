import prisma from '../../utils/prismaClient'
import { StaffRole, InvitationType, InvitationStatus } from '@prisma/client'
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../errors/AppError'
import logger from '../../config/logger'
import emailService from '../email.service'
import bcrypt from 'bcryptjs'

interface TeamMember {
  id: string
  firstName: string
  lastName: string
  email: string
  role: StaffRole
  active: boolean
  startDate: Date
  endDate: Date | null
  pin: string | null
  totalSales: number
  totalTips: number
  totalOrders: number
  averageRating: number
}

interface PaginatedTeamResponse {
  data: TeamMember[]
  meta: {
    totalCount: number
    pageSize: number
    currentPage: number
    totalPages: number
    hasNextPage: boolean
    hasPrevPage: boolean
  }
}

interface InviteTeamMemberRequest {
  email: string
  firstName: string
  lastName: string
  role: StaffRole
  message?: string
}

interface UpdateTeamMemberRequest {
  role?: StaffRole
  active?: boolean
  pin?: string
}

/**
 * Get all team members for a venue with pagination
 */
export async function getTeamMembers(
  venueId: string,
  page: number = 1,
  pageSize: number = 10,
  search?: string,
): Promise<PaginatedTeamResponse> {
  const skip = (page - 1) * pageSize

  // Build search conditions
  const searchConditions = search
    ? {
        OR: [
          {
            staff: {
              firstName: {
                contains: search,
                mode: 'insensitive' as const,
              },
            },
          },
          {
            staff: {
              lastName: {
                contains: search,
                mode: 'insensitive' as const,
              },
            },
          },
          {
            staff: {
              email: {
                contains: search,
                mode: 'insensitive' as const,
              },
            },
          },
        ],
      }
    : {}

  const whereCondition = {
    venueId,
    ...searchConditions,
  }

  const [staffVenues, totalCount] = await prisma.$transaction([
    prisma.staffVenue.findMany({
      where: whereCondition,
      include: {
        staff: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            active: true,
          },
        },
        venue: {
          select: {
            name: true,
          },
        },
      },
      orderBy: [{ role: 'asc' }, { staff: { firstName: 'asc' } }],
      skip,
      take: pageSize,
    }),
    prisma.staffVenue.count({
      where: whereCondition,
    }),
  ])

  const teamMembers: TeamMember[] = staffVenues.map(sv => ({
    id: sv.id,
    firstName: sv.staff.firstName,
    lastName: sv.staff.lastName,
    email: sv.staff.email,
    role: sv.role,
    active: sv.active && sv.staff.active,
    startDate: sv.startDate,
    endDate: sv.endDate,
    pin: sv.pin,
    totalSales: Number(sv.totalSales),
    totalTips: Number(sv.totalTips),
    totalOrders: sv.totalOrders,
    averageRating: Number(sv.averageRating),
  }))

  const totalPages = Math.ceil(totalCount / pageSize)

  return {
    data: teamMembers,
    meta: {
      totalCount,
      pageSize,
      currentPage: page,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  }
}

/**
 * Get a specific team member
 */
export async function getTeamMember(venueId: string, teamMemberId: string) {
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      id: teamMemberId,
      venueId,
    },
    include: {
      staff: true,
      venue: {
        select: {
          name: true,
          organization: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  })

  if (!staffVenue) {
    throw new NotFoundError('Team member not found')
  }

  return {
    id: staffVenue.id,
    staffId: staffVenue.staffId,
    firstName: staffVenue.staff.firstName,
    lastName: staffVenue.staff.lastName,
    email: staffVenue.staff.email,
    role: staffVenue.role,
    active: staffVenue.active,
    startDate: staffVenue.startDate,
    endDate: staffVenue.endDate,
    pin: staffVenue.pin,
    totalSales: Number(staffVenue.totalSales),
    totalTips: Number(staffVenue.totalTips),
    totalOrders: staffVenue.totalOrders,
    averageRating: Number(staffVenue.averageRating),
    venue: staffVenue.venue,
  }
}

/**
 * Invite a new team member
 */
export async function inviteTeamMember(
  venueId: string,
  inviterStaffId: string,
  request: InviteTeamMemberRequest,
): Promise<{ invitation: any; emailSent: boolean }> {
  // Validate role - can't invite SUPERADMIN
  if (request.role === StaffRole.SUPERADMIN) {
    throw new BadRequestError('Cannot invite SUPERADMIN role')
  }

  // Get venue and organization info
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    include: {
      organization: true,
    },
  })

  if (!venue) {
    throw new NotFoundError('Venue not found')
  }

  // Get inviter info
  const inviter = await prisma.staff.findUnique({
    where: { id: inviterStaffId },
    select: {
      firstName: true,
      lastName: true,
    },
  })

  if (!inviter) {
    throw new NotFoundError('Inviter not found')
  }

  // Check if user already exists
  let staff = await prisma.staff.findUnique({
    where: { email: request.email },
  })

  let existingStaffVenue = null
  if (staff) {
    // Check if already assigned to this venue
    existingStaffVenue = await prisma.staffVenue.findUnique({
      where: {
        staffId_venueId: {
          staffId: staff.id,
          venueId,
        },
      },
    })

    if (existingStaffVenue && existingStaffVenue.active) {
      throw new BadRequestError('User is already a team member of this venue')
    }
  }

  // Check for existing pending invitations
  const existingInvitation = await prisma.invitation.findFirst({
    where: {
      email: request.email,
      venueId,
      status: InvitationStatus.PENDING,
      expiresAt: {
        gt: new Date(),
      },
    },
  })

  if (existingInvitation) {
    throw new BadRequestError('A pending invitation already exists for this email')
  }

  // Create invitation
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + 7) // 7 days expiry

  const invitation = await prisma.invitation.create({
    data: {
      email: request.email,
      role: request.role,
      type: InvitationType.VENUE_STAFF,
      organizationId: venue.organizationId,
      venueId,
      expiresAt,
      invitedById: inviterStaffId,
      message: request.message,
    },
  })

  // If user doesn't exist, create them
  if (!staff) {
    staff = await prisma.staff.create({
      data: {
        email: request.email,
        firstName: request.firstName,
        lastName: request.lastName,
        organizationId: venue.organizationId,
        active: false, // Will be activated when they accept invitation
        emailVerified: false,
      },
    })
  }

  // Send invitation email
  const inviteLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/invite/${invitation.token}`

  const emailSent = await emailService.sendTeamInvitation(request.email, {
    inviterName: `${inviter.firstName} ${inviter.lastName}`,
    organizationName: venue.organization.name,
    venueName: venue.name,
    role: request.role,
    inviteLink,
  })

  logger.info('Team invitation created', {
    invitationId: invitation.id,
    email: request.email,
    venueId,
    role: request.role,
    emailSent,
  })

  return {
    invitation: {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    },
    emailSent,
  }
}

/**
 * Update team member role or status
 */
export async function updateTeamMember(venueId: string, teamMemberId: string, updates: UpdateTeamMemberRequest): Promise<TeamMember> {
  // Validate role if updating - can't assign SUPERADMIN
  if (updates.role === StaffRole.SUPERADMIN) {
    throw new BadRequestError('Cannot assign SUPERADMIN role')
  }

  // Get current team member
  const existingStaffVenue = await prisma.staffVenue.findFirst({
    where: {
      id: teamMemberId,
      venueId,
    },
    include: {
      staff: true,
    },
  })

  if (!existingStaffVenue) {
    throw new NotFoundError('Team member not found')
  }

  // Prevent deactivating yourself if you're the only OWNER/ADMIN
  if (updates.active === false && ['OWNER', 'ADMIN'].includes(existingStaffVenue.role)) {
    const adminCount = await prisma.staffVenue.count({
      where: {
        venueId,
        role: {
          in: [StaffRole.OWNER, StaffRole.ADMIN],
        },
        active: true,
        id: {
          not: teamMemberId,
        },
      },
    })

    if (adminCount === 0) {
      throw new BadRequestError('Cannot deactivate the last venue administrator')
    }
  }

  // Hash PIN if provided
  let hashedPin = undefined
  if (updates.pin !== undefined) {
    if (updates.pin === null || updates.pin === '') {
      hashedPin = null
    } else {
      // Validate PIN format (4-6 digits)
      if (!/^\d{4,6}$/.test(updates.pin)) {
        throw new BadRequestError('PIN must be 4-6 digits')
      }
      hashedPin = await bcrypt.hash(updates.pin, 10)
    }
  }

  // Update staff venue
  const updatedStaffVenue = await prisma.staffVenue.update({
    where: { id: teamMemberId },
    data: {
      ...(updates.role && { role: updates.role }),
      ...(updates.active !== undefined && { active: updates.active }),
      ...(hashedPin !== undefined && { pin: hashedPin }),
    },
    include: {
      staff: true,
    },
  })

  logger.info('Team member updated', {
    teamMemberId,
    venueId,
    updates,
  })

  return {
    id: updatedStaffVenue.id,
    firstName: updatedStaffVenue.staff.firstName,
    lastName: updatedStaffVenue.staff.lastName,
    email: updatedStaffVenue.staff.email,
    role: updatedStaffVenue.role,
    active: updatedStaffVenue.active,
    startDate: updatedStaffVenue.startDate,
    endDate: updatedStaffVenue.endDate,
    pin: updatedStaffVenue.pin,
    totalSales: Number(updatedStaffVenue.totalSales),
    totalTips: Number(updatedStaffVenue.totalTips),
    totalOrders: updatedStaffVenue.totalOrders,
    averageRating: Number(updatedStaffVenue.averageRating),
  }
}

/**
 * Remove team member from venue
 */
export async function removeTeamMember(venueId: string, teamMemberId: string): Promise<void> {
  // Get current team member
  const existingStaffVenue = await prisma.staffVenue.findFirst({
    where: {
      id: teamMemberId,
      venueId,
    },
  })

  if (!existingStaffVenue) {
    throw new NotFoundError('Team member not found')
  }

  // Prevent removing yourself if you're the only OWNER/ADMIN
  if (['OWNER', 'ADMIN'].includes(existingStaffVenue.role)) {
    const adminCount = await prisma.staffVenue.count({
      where: {
        venueId,
        role: {
          in: [StaffRole.OWNER, StaffRole.ADMIN],
        },
        active: true,
        id: {
          not: teamMemberId,
        },
      },
    })

    if (adminCount === 0) {
      throw new BadRequestError('Cannot remove the last venue administrator')
    }
  }

  // Soft delete by setting endDate and deactivating
  await prisma.staffVenue.update({
    where: { id: teamMemberId },
    data: {
      active: false,
      endDate: new Date(),
    },
  })

  logger.info('Team member removed', {
    teamMemberId,
    venueId,
  })
}

/**
 * Get pending invitations for a venue (including expired ones)
 */
export async function getPendingInvitations(venueId: string) {
  const invitations = await prisma.invitation.findMany({
    where: {
      venueId,
      status: InvitationStatus.PENDING, // Include expired but still pending invitations
    },
    include: {
      invitedBy: {
        select: {
          firstName: true,
          lastName: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  return invitations.map(inv => {
    const isExpired = new Date() > inv.expiresAt
    return {
      id: inv.id,
      email: inv.email,
      role: inv.role,
      status: isExpired ? 'EXPIRED' : inv.status,
      expiresAt: inv.expiresAt,
      createdAt: inv.createdAt,
      message: inv.message,
      isExpired,
      invitedBy: {
        name: `${inv.invitedBy.firstName} ${inv.invitedBy.lastName}`,
      },
    }
  })
}

/**
 * Resend an invitation (extends expiration and sends new email)
 */
export async function resendInvitation(venueId: string, invitationId: string, invitedById: string): Promise<void> {
  const invitation = await prisma.invitation.findFirst({
    where: {
      id: invitationId,
      venueId,
      status: InvitationStatus.PENDING,
    },
    include: {
      venue: true,
      organization: true,
      invitedBy: true,
    },
  })

  if (!invitation) {
    throw new NotFoundError('Invitation not found')
  }

  // Check if the invitation belongs to the same venue
  if (invitation.venueId !== venueId) {
    throw new UnauthorizedError('Cannot resend invitation from different venue')
  }

  // Extend expiration date by 7 days
  const newExpirationDate = new Date()
  newExpirationDate.setDate(newExpirationDate.getDate() + 7)

  // Update invitation with new expiration date and attempt count
  await prisma.invitation.update({
    where: { id: invitationId },
    data: {
      expiresAt: newExpirationDate,
      attemptCount: invitation.attemptCount + 1,
      lastAttemptAt: new Date(),
    },
  })

  // Send email again
  const inviteLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/invite/${invitation.token}`

  try {
    await emailService.sendTeamInvitation(invitation.email, {
      inviterName: `${invitation.invitedBy.firstName} ${invitation.invitedBy.lastName}`,
      organizationName: invitation.organization.name,
      venueName: invitation.venue?.name || '',
      role: invitation.role,
      inviteLink,
    })

    logger.info('Team invitation resent', {
      invitationId: invitation.id,
      email: invitation.email,
      venueId,
      role: invitation.role,
      attemptCount: invitation.attemptCount + 1,
    })
  } catch (emailError) {
    logger.warn('Email service not available. Invitation updated but email not sent.', {
      invitationId: invitation.id,
      email: invitation.email,
    })
  }
}

/**
 * Cancel/revoke an invitation
 */
export async function cancelInvitation(venueId: string, invitationId: string): Promise<void> {
  const invitation = await prisma.invitation.findFirst({
    where: {
      id: invitationId,
      venueId,
      status: InvitationStatus.PENDING,
    },
  })

  if (!invitation) {
    throw new NotFoundError('Invitation not found or already processed')
  }

  await prisma.invitation.update({
    where: { id: invitationId },
    data: {
      status: InvitationStatus.REVOKED,
    },
  })

  logger.info('Invitation cancelled', {
    invitationId,
    venueId,
  })
}
