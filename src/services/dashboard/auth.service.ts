import prisma from '../../utils/prismaClient'
import bcrypt from 'bcryptjs'
import { AuthenticationError, ForbiddenError } from '../../errors/AppError'
import { LoginDto } from '../../schemas/dashboard/auth.schema'
import { StaffRole } from '@prisma/client'
import * as jwtService from '../../jwt.service'
import { DEFAULT_PERMISSIONS } from '../../lib/permissions'

export async function loginStaff(loginData: LoginDto) {
  const { email, password, venueId } = loginData

  // 1. Buscar staff con TODOS sus venues (no solo el solicitado)
  const staff = await prisma.staff.findUnique({
    where: { email: email.toLowerCase() },
    include: {
      organization: true,
      venues: {
        where: { active: true },
        include: {
          venue: {
            select: {
              id: true,
              name: true,
              slug: true,
              logo: true,
            },
          },
        },
      },
    },
  })

  if (!staff || !staff.password) {
    throw new AuthenticationError('Credenciales inválidas')
  }

  if (!staff.active) {
    throw new AuthenticationError('Tu cuenta está desactivada')
  }

  // 2. Verificar contraseña
  const passwordMatch = await bcrypt.compare(password, staff.password)
  if (!passwordMatch) {
    throw new AuthenticationError('Credenciales inválidas')
  }

  // 3. Si se especificó un venue, verificar acceso
  let selectedVenue = staff.venues[0] // Por defecto el primero

  if (venueId) {
    const venueAccess = staff.venues.find(sv => sv.venueId === venueId)
    if (!venueAccess) {
      throw new ForbiddenError('No tienes acceso a este establecimiento')
    }
    selectedVenue = venueAccess
  }

  if (!selectedVenue) {
    throw new ForbiddenError('No tienes acceso a ningún establecimiento')
  }

  // 4. Generar tokens con el venue seleccionado
  const accessToken = jwtService.generateAccessToken(staff.id, staff.organizationId, selectedVenue.venueId, selectedVenue.role)

  const refreshToken = jwtService.generateRefreshToken(staff.id, staff.organizationId)

  // 5. Actualizar último login
  await prisma.staff.update({
    where: { id: staff.id },
    data: { lastLoginAt: new Date() },
  })

  // 6. Fetch custom role permissions for all venues
  const venueIds = staff.venues.map(sv => sv.venueId)
  const customRolePermissions = await prisma.venueRolePermission.findMany({
    where: {
      venueId: { in: venueIds },
    },
    select: {
      venueId: true,
      role: true,
      permissions: true,
    },
  })

  // 7. Formatear respuesta with merged permissions
  const sanitizedStaff = {
    id: staff.id,
    email: staff.email,
    firstName: staff.firstName,
    lastName: staff.lastName,
    organizationId: staff.organizationId,
    photoUrl: staff.photoUrl,
    venues: staff.venues.map(sv => {
      // Get custom permissions for this venue + role combination
      const customPerms = customRolePermissions.find(
        crp => crp.venueId === sv.venueId && crp.role === sv.role
      )

      // If custom permissions exist, use them; otherwise use defaults
      const permissions = customPerms
        ? (customPerms.permissions as string[])
        : DEFAULT_PERMISSIONS[sv.role] || []

      return {
        id: sv.venue.id,
        name: sv.venue.name,
        slug: sv.venue.slug,
        logo: sv.venue.logo,
        role: sv.role,
        permissions, // Include permissions in response
      }
    }),
  }

  return {
    accessToken,
    refreshToken,
    staff: sanitizedStaff,
  }
}

/**
 * Permite a un Staff cambiar su contexto a un nuevo Venue y obtener nuevos tokens.
 * @param staffId - El ID del Staff que realiza la petición (del token actual).
 * @param orgId - El ID de la Organización del Staff (del token actual).
 * @param targetVenueId - El ID del Venue al que se desea cambiar.
 * @returns Nuevos accessToken y refreshToken con el contexto actualizado.
 */
export async function switchVenueForStaff(staffId: string, orgId: string, targetVenueId: string) {
  // Declare roleInNewVenue variable at function scope with StaffRole type
  let roleInNewVenue: StaffRole

  // Get the staff with his venues to check roles
  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    select: {
      id: true,
      organizationId: true,
      venues: {
        where: { active: true },
        select: {
          role: true,
          venue: { select: { id: true } },
        },
      },
    },
  })

  if (!staff) {
    throw new ForbiddenError('Usuario no encontrado.')
  }

  // Check roles
  const isSuperAdmin = staff.venues.some(sv => sv.role === StaffRole.SUPERADMIN)
  const isOwner = staff.venues.some(sv => sv.role === StaffRole.OWNER)

  // First check if venue exists
  const targetVenue = await prisma.venue.findUnique({
    where: { id: targetVenueId },
    select: {
      id: true,
      organizationId: true,
    },
  })

  if (!targetVenue) {
    throw new ForbiddenError('El establecimiento solicitado no existe.')
  }

  // Si es SUPERADMIN, permitir acceso a cualquier venue
  if (isSuperAdmin) {
    // Los SUPERADMINs mantienen su rol SUPERADMIN incluso al cambiar de venue
    roleInNewVenue = StaffRole.SUPERADMIN
  }
  // Si es OWNER, permitir acceso a cualquier venue de su organización
  else if (isOwner && targetVenue.organizationId === staff.organizationId) {
    roleInNewVenue = StaffRole.OWNER
  }
  // Para otros usuarios, verificar acceso normal al venue
  else {
    const staffVenueAccess = await prisma.staffVenue.findFirst({
      where: {
        staffId: staffId,
        venueId: targetVenueId,
        active: true,
      },
    })

    if (!staffVenueAccess) {
      throw new ForbiddenError('No tienes acceso a este establecimiento o el acceso está inactivo.')
    }

    roleInNewVenue = staffVenueAccess.role
  }

  // 2. Generar un nuevo set de tokens
  const accessToken = jwtService.generateAccessToken(staffId, orgId, targetVenueId, roleInNewVenue)
  const refreshToken = jwtService.generateRefreshToken(staffId, orgId)

  return { accessToken, refreshToken }
}
