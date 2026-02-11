import { OrgRole, StaffRole } from '@prisma/client'
import bcrypt from 'bcryptjs'

import logger from '../../config/logger'
import prisma from '@/utils/prismaClient'

// ===========================================
// TYPES
// ===========================================

interface ListStaffParams {
  page: number
  pageSize: number
  search?: string
  active?: 'true' | 'false' | 'all'
  organizationId?: string
  venueId?: string
  hasOrganization?: boolean
  hasVenue?: boolean
}

interface CreateStaffData {
  email: string
  firstName: string
  lastName: string
  phone?: string
  password?: string
  organizationId: string
  orgRole: OrgRole
  venueId?: string
  venueRole?: StaffRole
  pin?: string
}

interface UpdateStaffData {
  firstName?: string
  lastName?: string
  phone?: string | null
  active?: boolean
  emailVerified?: boolean
}

// ===========================================
// LIST STAFF (paginated with search/filters)
// ===========================================

export async function listStaff(params: ListStaffParams) {
  const { page, pageSize, search, active, organizationId, venueId, hasOrganization, hasVenue } = params
  const skip = (page - 1) * pageSize

  // Build where clause
  const where: any = {}

  if (active === 'true') where.active = true
  else if (active === 'false') where.active = false

  if (search) {
    where.OR = [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search, mode: 'insensitive' } },
    ]
  }

  if (organizationId) {
    where.organizations = {
      some: { organizationId, isActive: true },
    }
  } else if (hasOrganization) {
    where.organizations = { some: { isActive: true } }
  }

  if (venueId) {
    where.venues = {
      some: { venueId, active: true },
    }
  } else if (hasVenue) {
    where.venues = { some: { active: true } }
  }

  const [staff, total] = await Promise.all([
    prisma.staff.findMany({
      where,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        active: true,
        emailVerified: true,
        createdAt: true,
        organizations: {
          where: { isActive: true },
          select: {
            organizationId: true,
            role: true,
            isPrimary: true,
            organization: {
              select: { id: true, name: true },
            },
          },
        },
        venues: {
          where: { active: true },
          select: {
            venueId: true,
            role: true,
            pin: true,
            venue: {
              select: { id: true, name: true, slug: true },
            },
          },
        },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      skip,
      take: pageSize,
    }),
    prisma.staff.count({ where }),
  ])

  return {
    staff,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

// ===========================================
// GET STAFF DETAIL
// ===========================================

export async function getStaffById(staffId: string) {
  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      active: true,
      emailVerified: true,
      createdAt: true,
      updatedAt: true,
      organizations: {
        select: {
          id: true,
          organizationId: true,
          role: true,
          isPrimary: true,
          isActive: true,
          joinedAt: true,
          organization: {
            select: { id: true, name: true, slug: true },
          },
        },
        orderBy: { joinedAt: 'asc' },
      },
      venues: {
        select: {
          id: true,
          venueId: true,
          role: true,
          pin: true,
          active: true,
          startDate: true,
          venue: {
            select: {
              id: true,
              name: true,
              slug: true,
              organizationId: true,
              organization: { select: { name: true } },
            },
          },
        },
        orderBy: { startDate: 'asc' },
      },
    },
  })

  return staff
}

// ===========================================
// CREATE STAFF (atomic: Staff + StaffOrg + StaffVenue?)
// ===========================================

export async function createStaff(data: CreateStaffData) {
  const { email, firstName, lastName, phone, password, organizationId, orgRole, venueId, venueRole, pin } = data

  // 1. Check email uniqueness
  const existing = await prisma.staff.findUnique({ where: { email } })
  if (existing) {
    const error: any = new Error('Ya existe un usuario con este correo electrónico')
    error.statusCode = 409
    throw error
  }

  // 2. Validate org exists
  const org = await prisma.organization.findUnique({ where: { id: organizationId } })
  if (!org) {
    const error: any = new Error('Organización no encontrada')
    error.statusCode = 404
    throw error
  }

  // 3. If venueId, validate venue belongs to org
  if (venueId) {
    const venue = await prisma.venue.findFirst({
      where: { id: venueId, organizationId },
    })
    if (!venue) {
      const error: any = new Error('La sucursal no pertenece a la organización seleccionada')
      error.statusCode = 400
      throw error
    }

    // 4. If pin, check uniqueness within venue
    if (pin) {
      const existingPin = await prisma.staffVenue.findFirst({
        where: { venueId, pin, active: true },
      })
      if (existingPin) {
        const error: any = new Error('Este PIN ya está en uso en esta sucursal')
        error.statusCode = 400
        throw error
      }
    }
  }

  // 5. Hash password if provided
  let hashedPassword: string | undefined
  if (password) {
    hashedPassword = await bcrypt.hash(password, 10)
  }

  // 6. Atomic transaction
  const staff = await prisma.$transaction(async tx => {
    // Create Staff
    const newStaff = await tx.staff.create({
      data: {
        email,
        firstName,
        lastName,
        phone: phone || null,
        password: hashedPassword || null,
        active: true,
        emailVerified: true, // Superadmin-created users are verified
      },
    })

    // Create StaffOrganization
    await tx.staffOrganization.create({
      data: {
        staffId: newStaff.id,
        organizationId,
        role: orgRole as OrgRole,
        isPrimary: true,
        isActive: true,
      },
    })

    // Optionally create StaffVenue
    if (venueId && venueRole) {
      await tx.staffVenue.create({
        data: {
          staffId: newStaff.id,
          venueId,
          role: venueRole as StaffRole,
          pin: pin || null,
          active: true,
        },
      })
    }

    return newStaff
  })

  logger.info(`[STAFF-SUPERADMIN] Created staff: ${email}`, { staffId: staff.id, organizationId })

  // Return full detail
  return getStaffById(staff.id)
}

// ===========================================
// UPDATE STAFF
// ===========================================

export async function updateStaff(staffId: string, data: UpdateStaffData) {
  const staff = await prisma.staff.findUnique({ where: { id: staffId } })
  if (!staff) {
    const error: any = new Error('Usuario no encontrado')
    error.statusCode = 404
    throw error
  }

  const updated = await prisma.staff.update({
    where: { id: staffId },
    data,
  })

  logger.info(`[STAFF-SUPERADMIN] Updated staff: ${updated.email}`, { staffId })
  return getStaffById(staffId)
}

// ===========================================
// ASSIGN TO ORGANIZATION (upsert)
// ===========================================

export async function assignToOrganization(staffId: string, organizationId: string, role: OrgRole) {
  // Validate staff exists
  const staff = await prisma.staff.findUnique({ where: { id: staffId } })
  if (!staff) {
    const error: any = new Error('Usuario no encontrado')
    error.statusCode = 404
    throw error
  }

  // Validate org exists
  const org = await prisma.organization.findUnique({ where: { id: organizationId } })
  if (!org) {
    const error: any = new Error('Organización no encontrada')
    error.statusCode = 404
    throw error
  }

  // Check if already has a primary org — don't override
  const hasPrimary = await prisma.staffOrganization.findFirst({
    where: { staffId, isPrimary: true, isActive: true },
  })

  await prisma.staffOrganization.upsert({
    where: {
      staffId_organizationId: { staffId, organizationId },
    },
    update: {
      isActive: true,
      role,
      leftAt: null,
    },
    create: {
      staffId,
      organizationId,
      role,
      isPrimary: !hasPrimary, // Primary only if they don't have one yet
      isActive: true,
    },
  })

  logger.info(`[STAFF-SUPERADMIN] Assigned staff to org`, { staffId, organizationId, role })
  return getStaffById(staffId)
}

// ===========================================
// REMOVE FROM ORGANIZATION (soft delete)
// ===========================================

export async function removeFromOrganization(staffId: string, organizationId: string) {
  // Validate membership exists
  const membership = await prisma.staffOrganization.findUnique({
    where: { staffId_organizationId: { staffId, organizationId } },
  })
  if (!membership) {
    const error: any = new Error('El usuario no pertenece a esta organización')
    error.statusCode = 404
    throw error
  }

  // Check not removing last OWNER
  if (membership.role === OrgRole.OWNER) {
    const ownerCount = await prisma.staffOrganization.count({
      where: { organizationId, role: OrgRole.OWNER, isActive: true },
    })
    if (ownerCount <= 1) {
      const error: any = new Error('No se puede eliminar al último propietario de la organización')
      error.statusCode = 400
      throw error
    }
  }

  // Soft delete: deactivate membership and all venue assignments in this org
  await prisma.$transaction(async tx => {
    await tx.staffOrganization.update({
      where: { staffId_organizationId: { staffId, organizationId } },
      data: { isActive: false, leftAt: new Date() },
    })

    // Deactivate all venue assignments for venues in this org
    const orgVenues = await tx.venue.findMany({
      where: { organizationId },
      select: { id: true },
    })
    const venueIds = orgVenues.map(v => v.id)

    if (venueIds.length > 0) {
      await tx.staffVenue.updateMany({
        where: { staffId, venueId: { in: venueIds }, active: true },
        data: { active: false, endDate: new Date() },
      })
    }
  })

  logger.info(`[STAFF-SUPERADMIN] Removed staff from org`, { staffId, organizationId })
  return getStaffById(staffId)
}

// ===========================================
// ASSIGN TO VENUE (upsert)
// ===========================================

export async function assignToVenue(staffId: string, venueId: string, role: StaffRole, pin?: string) {
  // Validate staff exists
  const staff = await prisma.staff.findUnique({ where: { id: staffId } })
  if (!staff) {
    const error: any = new Error('Usuario no encontrado')
    error.statusCode = 404
    throw error
  }

  // Validate venue exists and get its org
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true, organizationId: true, name: true },
  })
  if (!venue) {
    const error: any = new Error('Sucursal no encontrada')
    error.statusCode = 404
    throw error
  }

  // Validate staff belongs to the venue's org
  const orgMembership = await prisma.staffOrganization.findUnique({
    where: { staffId_organizationId: { staffId, organizationId: venue.organizationId } },
  })
  if (!orgMembership || !orgMembership.isActive) {
    const error: any = new Error('El usuario no pertenece a la organización de esta sucursal. Asígnelo primero a la organización.')
    error.statusCode = 400
    throw error
  }

  // Check PIN uniqueness if provided
  if (pin) {
    const existingPin = await prisma.staffVenue.findFirst({
      where: {
        venueId,
        pin,
        active: true,
        staffId: { not: staffId }, // Exclude self for upsert case
      },
    })
    if (existingPin) {
      const error: any = new Error('Este PIN ya está en uso en esta sucursal')
      error.statusCode = 400
      throw error
    }
  }

  await prisma.staffVenue.upsert({
    where: {
      staffId_venueId: { staffId, venueId },
    },
    update: {
      role,
      pin: pin !== undefined ? pin || null : undefined,
      active: true,
      endDate: null,
    },
    create: {
      staffId,
      venueId,
      role,
      pin: pin || null,
      active: true,
    },
  })

  logger.info(`[STAFF-SUPERADMIN] Assigned staff to venue`, { staffId, venueId, role })
  return getStaffById(staffId)
}

// ===========================================
// UPDATE VENUE ASSIGNMENT
// ===========================================

export async function updateVenueAssignment(
  staffId: string,
  venueId: string,
  data: { role?: StaffRole; pin?: string | null; active?: boolean },
) {
  const assignment = await prisma.staffVenue.findUnique({
    where: { staffId_venueId: { staffId, venueId } },
  })
  if (!assignment) {
    const error: any = new Error('El usuario no está asignado a esta sucursal')
    error.statusCode = 404
    throw error
  }

  // Check PIN uniqueness if changing
  if (data.pin !== undefined && data.pin !== null) {
    const existingPin = await prisma.staffVenue.findFirst({
      where: {
        venueId,
        pin: data.pin,
        active: true,
        staffId: { not: staffId },
      },
    })
    if (existingPin) {
      const error: any = new Error('Este PIN ya está en uso en esta sucursal')
      error.statusCode = 400
      throw error
    }
  }

  await prisma.staffVenue.update({
    where: { staffId_venueId: { staffId, venueId } },
    data: {
      ...(data.role !== undefined && { role: data.role }),
      ...(data.pin !== undefined && { pin: data.pin }),
      ...(data.active !== undefined && { active: data.active, ...(data.active === false && { endDate: new Date() }) }),
    },
  })

  logger.info(`[STAFF-SUPERADMIN] Updated venue assignment`, { staffId, venueId })
  return getStaffById(staffId)
}

// ===========================================
// REMOVE FROM VENUE (soft delete)
// ===========================================

export async function removeFromVenue(staffId: string, venueId: string) {
  const assignment = await prisma.staffVenue.findUnique({
    where: { staffId_venueId: { staffId, venueId } },
  })
  if (!assignment) {
    const error: any = new Error('El usuario no está asignado a esta sucursal')
    error.statusCode = 404
    throw error
  }

  await prisma.staffVenue.update({
    where: { staffId_venueId: { staffId, venueId } },
    data: { active: false, endDate: new Date() },
  })

  logger.info(`[STAFF-SUPERADMIN] Removed staff from venue`, { staffId, venueId })
  return getStaffById(staffId)
}

// ===========================================
// DELETE STAFF (hard delete — cascades StaffVenue, StaffOrganization)
// ===========================================

export async function deleteStaff(staffId: string, currentUserId: string) {
  if (staffId === currentUserId) {
    const error: any = new Error('No puedes eliminarte a ti mismo')
    error.statusCode = 400
    throw error
  }

  const staff = await prisma.staff.findUnique({ where: { id: staffId } })
  if (!staff) {
    const error: any = new Error('Usuario no encontrado')
    error.statusCode = 404
    throw error
  }

  await prisma.staff.delete({ where: { id: staffId } })

  logger.info(`[STAFF-SUPERADMIN] Deleted staff: ${staff.email}`, { staffId })
  return { success: true }
}

// ===========================================
// RESET PASSWORD
// ===========================================

export async function resetPassword(staffId: string, newPassword: string) {
  const staff = await prisma.staff.findUnique({ where: { id: staffId } })
  if (!staff) {
    const error: any = new Error('Usuario no encontrado')
    error.statusCode = 404
    throw error
  }

  const hashed = await bcrypt.hash(newPassword, 10)
  await prisma.staff.update({
    where: { id: staffId },
    data: { password: hashed },
  })

  logger.info(`[STAFF-SUPERADMIN] Password reset for staff`, { staffId, email: staff.email })
  return { success: true, message: 'Contraseña actualizada correctamente' }
}
