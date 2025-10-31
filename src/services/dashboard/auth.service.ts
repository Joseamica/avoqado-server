import prisma from '../../utils/prismaClient'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { AuthenticationError, ForbiddenError, BadRequestError } from '../../errors/AppError'
import { LoginDto, RequestPasswordResetDto, ResetPasswordDto } from '../../schemas/dashboard/auth.schema'
import { StaffRole } from '@prisma/client'
import * as jwtService from '../../jwt.service'
import { DEFAULT_PERMISSIONS } from '../../lib/permissions'
import emailService from '../email.service'
import logger from '@/config/logger'

export async function loginStaff(loginData: LoginDto) {
  const { email, password, venueId, rememberMe } = loginData

  // 1. Buscar staff con TODOS sus venues (no solo el solicitado)
  const staff = await prisma.staff.findUnique({
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      email: true,
      emailVerified: true, // FAANG pattern: check email verification
      firstName: true,
      lastName: true,
      password: true,
      active: true,
      photoUrl: true,
      phone: true,
      organizationId: true,
      lockedUntil: true,
      failedLoginAttempts: true,
      createdAt: true,
      lastLoginAt: true,
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
              isOnboardingDemo: true,
            },
          },
        },
      },
    },
  })

  if (!staff || !staff.password) {
    throw new AuthenticationError('Correo electrónico o contraseña incorrectos.')
  }

  if (!staff.active) {
    throw new AuthenticationError('Tu cuenta está desactivada')
  }

  // 2. Check if account is locked (FAANG security pattern)
  if (staff.lockedUntil && new Date() < staff.lockedUntil) {
    const minutesLeft = Math.ceil((staff.lockedUntil.getTime() - Date.now()) / 60000)
    throw new ForbiddenError(
      `Account temporarily locked due to too many failed login attempts. Please try again in ${minutesLeft} minute${minutesLeft > 1 ? 's' : ''}.`,
    )
  }

  // 3. Verificar contraseña
  const passwordMatch = await bcrypt.compare(password, staff.password)
  if (!passwordMatch) {
    // Increment failed attempts
    const newAttempts = staff.failedLoginAttempts + 1
    const updates: any = { failedLoginAttempts: newAttempts }

    // Lock account after 5 failed attempts (FAANG best practice)
    if (newAttempts >= 5) {
      updates.lockedUntil = new Date(Date.now() + 30 * 60 * 1000) // 30 minutes
      await prisma.staff.update({
        where: { id: staff.id },
        data: updates,
      })
      throw new ForbiddenError('Account locked due to too many failed login attempts. Please try again in 30 minutes.')
    }

    await prisma.staff.update({
      where: { id: staff.id },
      data: updates,
    })
    throw new AuthenticationError('Correo electrónico o contraseña incorrectos.')
  }

  // 2.5. Verificar que el email esté verificado (FAANG pattern)
  if (!staff.emailVerified) {
    throw new ForbiddenError('Please verify your email before logging in. Check your inbox for the verification code.')
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

  // 3.5. World-Class Pattern (Stripe/Shopify): Allow OWNER login without venues if onboarding incomplete
  // This prevents chicken-and-egg problem: User needs to login to complete onboarding, but onboarding creates first venue
  if (!selectedVenue) {
    // Check if user has OWNER role in any venue (even if no active venues)
    const organization = staff.organization
    const hasOwnerRole = staff.email === organization.email // Primary owner (created during signup)

    // If OWNER and onboarding not completed, allow login with placeholder venueId
    if (hasOwnerRole && !organization.onboardingCompletedAt) {
      // Generate token with placeholder venueId for onboarding flow
      const accessToken = jwtService.generateAccessToken(staff.id, staff.organizationId, 'pending', StaffRole.OWNER)
      const refreshToken = jwtService.generateRefreshToken(staff.id, staff.organizationId)

      // Reset failed attempts
      await prisma.staff.update({
        where: { id: staff.id },
        data: {
          lastLoginAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      })

      // Return with onboarding flag
      return {
        accessToken,
        refreshToken,
        staff: {
          id: staff.id,
          email: staff.email,
          firstName: staff.firstName,
          lastName: staff.lastName,
          organizationId: staff.organizationId,
          photoUrl: staff.photoUrl,
          phone: staff.phone,
          createdAt: staff.createdAt,
          lastLogin: staff.lastLoginAt,
          role: StaffRole.OWNER, // CRITICAL: Include role so frontend can detect OWNER status
          venues: [], // Empty venues array (user needs to complete onboarding)
        },
      }
    }

    // Not OWNER or onboarding completed but no venue access → error
    throw new ForbiddenError('No tienes acceso a ningún establecimiento', 'NO_VENUE_ACCESS')
  }

  // 4. Generar tokens con el venue seleccionado
  const accessToken = jwtService.generateAccessToken(staff.id, staff.organizationId, selectedVenue.venueId, selectedVenue.role, rememberMe)

  const refreshToken = jwtService.generateRefreshToken(staff.id, staff.organizationId, rememberMe)

  // 5. Actualizar último login y resetear intentos fallidos
  await prisma.staff.update({
    where: { id: staff.id },
    data: {
      lastLoginAt: new Date(),
      failedLoginAttempts: 0, // Reset failed attempts on successful login
      lockedUntil: null, // Clear any lock
    },
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
    phone: staff.phone,
    createdAt: staff.createdAt,
    lastLogin: staff.lastLoginAt,
    venues: staff.venues.map(sv => {
      // Get custom permissions for this venue + role combination
      const customPerms = customRolePermissions.find(crp => crp.venueId === sv.venueId && crp.role === sv.role)

      // If custom permissions exist, use them; otherwise use defaults
      const permissions = customPerms ? (customPerms.permissions as string[]) : DEFAULT_PERMISSIONS[sv.role] || []

      return {
        id: sv.venue.id,
        name: sv.venue.name,
        slug: sv.venue.slug,
        logo: sv.venue.logo,
        role: sv.role,
        isOnboardingDemo: sv.venue.isOnboardingDemo,
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

/**
 * Request password reset - generates token and sends email
 * SECURITY: Always returns success (no user enumeration)
 * @param data - Email address for reset
 */
export async function requestPasswordReset(data: RequestPasswordResetDto) {
  const { email } = data
  const normalizedEmail = email.toLowerCase()

  try {
    // 1. Find staff by email (case-insensitive)
    const staff = await prisma.staff.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        email: true,
        emailVerified: true,
        firstName: true,
        active: true,
      },
    })

    // SECURITY: If email doesn't exist, return success anyway (no user enumeration)
    if (!staff) {
      logger.info(`Password reset requested for non-existent email: ${normalizedEmail}`)
      return { message: 'Si existe una cuenta con este email, recibirás un enlace de restablecimiento.' }
    }

    // 2. Check if email is verified
    if (!staff.emailVerified) {
      logger.warn(`Password reset attempted for unverified email: ${normalizedEmail}`)
      // SECURITY: Don't reveal that email is unverified
      return { message: 'Si existe una cuenta con este email, recibirás un enlace de restablecimiento.' }
    }

    // 3. Check if account is active
    if (!staff.active) {
      logger.warn(`Password reset attempted for inactive account: ${normalizedEmail}`)
      // SECURITY: Don't reveal that account is inactive
      return { message: 'Si existe una cuenta con este email, recibirás un enlace de restablecimiento.' }
    }

    // 4. Generate secure random token (32 bytes = 64 hex characters)
    const resetToken = crypto.randomBytes(32).toString('hex')

    // 5. Hash the token before storing (bcrypt with 10 salt rounds)
    const hashedToken = await bcrypt.hash(resetToken, 10)

    // 6. Calculate expiry time (1 hour from now)
    const expiryTime = new Date()
    expiryTime.setHours(expiryTime.getHours() + 1)

    // 7. Store hashed token in database (invalidate any previous tokens)
    await prisma.staff.update({
      where: { id: staff.id },
      data: {
        resetToken: hashedToken,
        resetTokenExpiry: expiryTime,
        resetTokenUsedAt: null, // Clear any previous usage
      },
    })

    // 8. Generate reset link for email
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'
    const resetLink = `${frontendUrl}/auth/reset-password/${resetToken}`

    // 9. Send reset email
    const emailSent = await emailService.sendPasswordResetEmail(staff.email, {
      firstName: staff.firstName,
      resetLink,
      expiresInMinutes: 60,
    })

    if (!emailSent) {
      logger.error(`Failed to send password reset email to: ${normalizedEmail}`)
      // Don't throw error - still return success for security
    } else {
      logger.info(`Password reset email sent successfully to: ${normalizedEmail}`)
    }

    // SECURITY: Always return same success message
    return { message: 'Si existe una cuenta con este email, recibirás un enlace de restablecimiento.' }
  } catch (error) {
    logger.error('Error in requestPasswordReset:', error)
    // SECURITY: Don't reveal internal errors
    return { message: 'Si existe una cuenta con este email, recibirás un enlace de restablecimiento.' }
  }
}

/**
 * Validate reset token
 * @param token - Plain reset token from URL
 * @returns Staff email if valid
 */
export async function validateResetToken(token: string) {
  // 1. Find all staff with non-null reset tokens
  const staffWithTokens = await prisma.staff.findMany({
    where: {
      resetToken: { not: null },
      resetTokenExpiry: { not: null },
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      resetToken: true,
      resetTokenExpiry: true,
      resetTokenUsedAt: true,
    },
  })

  // 2. Compare provided token against all hashed tokens
  for (const staff of staffWithTokens) {
    if (!staff.resetToken || !staff.resetTokenExpiry) continue

    const isTokenValid = await bcrypt.compare(token, staff.resetToken)

    if (isTokenValid) {
      // 3. Check if token has expired (must be within 1 hour)
      const now = new Date()
      if (now > staff.resetTokenExpiry) {
        throw new BadRequestError('Este enlace de restablecimiento ha expirado. Por favor solicita uno nuevo.')
      }

      // 4. Check if token has already been used
      if (staff.resetTokenUsedAt) {
        throw new BadRequestError('Este enlace de restablecimiento ya fue utilizado. Por favor solicita uno nuevo.')
      }

      // 5. Token is valid - return masked email for confirmation
      const emailParts = staff.email.split('@')
      const maskedEmail = `${emailParts[0][0]}***@${emailParts[1]}`

      return {
        valid: true,
        email: maskedEmail,
      }
    }
  }

  // Token not found or invalid
  throw new BadRequestError('Este enlace de restablecimiento es inválido. Por favor solicita uno nuevo.')
}

/**
 * Reset password with token
 * @param data - Token and new password
 */
export async function resetPassword(data: ResetPasswordDto) {
  const { token, newPassword } = data

  // 1. Find all staff with non-null reset tokens
  const staffWithTokens = await prisma.staff.findMany({
    where: {
      resetToken: { not: null },
      resetTokenExpiry: { not: null },
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      resetToken: true,
      resetTokenExpiry: true,
      resetTokenUsedAt: true,
    },
  })

  // 2. Compare provided token against all hashed tokens
  let staffToUpdate: (typeof staffWithTokens)[0] | null = null

  for (const staff of staffWithTokens) {
    if (!staff.resetToken || !staff.resetTokenExpiry) continue

    const isTokenValid = await bcrypt.compare(token, staff.resetToken)

    if (isTokenValid) {
      // Check expiry
      const now = new Date()
      if (now > staff.resetTokenExpiry) {
        throw new BadRequestError('Este enlace de restablecimiento ha expirado. Por favor solicita uno nuevo.')
      }

      // Check if already used
      if (staff.resetTokenUsedAt) {
        throw new BadRequestError('Este enlace de restablecimiento ya fue utilizado. Por favor solicita uno nuevo.')
      }

      staffToUpdate = staff
      break
    }
  }

  if (!staffToUpdate) {
    throw new BadRequestError('Este enlace de restablecimiento es inválido. Por favor solicita uno nuevo.')
  }

  // 3. Hash new password
  const hashedPassword = await bcrypt.hash(newPassword, 10)

  // 4. Update staff: set new password, mark token as used, clear reset fields
  await prisma.staff.update({
    where: { id: staffToUpdate.id },
    data: {
      password: hashedPassword,
      resetToken: null, // Clear token
      resetTokenExpiry: null,
      resetTokenUsedAt: new Date(), // Mark as used
      lastPasswordReset: new Date(),
      // Reset failed login attempts (fresh start)
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  })

  // 5. TODO: Invalidate all refresh tokens (force re-login on all devices)
  // This requires Redis session management implementation

  logger.info(`Password reset successfully for staff: ${staffToUpdate.email}`)

  return { message: 'Contraseña restablecida exitosamente. Ya puedes iniciar sesión con tu nueva contraseña.' }
}
