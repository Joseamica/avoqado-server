import prisma from '../../utils/prismaClient'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { AuthenticationError, ForbiddenError, BadRequestError } from '../../errors/AppError'
import { LoginDto, RequestPasswordResetDto, ResetPasswordDto } from '../../schemas/dashboard/auth.schema'
import { StaffRole, InvitationStatus } from '@prisma/client'
import * as jwtService from '../../jwt.service'
import { DEFAULT_PERMISSIONS } from '../../lib/permissions'
import emailService from '../email.service'
import logger from '@/config/logger'
import { getPrimaryOrganizationId, hasOrganizationAccess } from '../staffOrganization.service'
import { OPERATIONAL_VENUE_STATUSES } from '@/lib/venueStatus.constants'
import { logAction } from './activity-log.service'
// 🔐 Master TOTP Login imports
import { TOTP, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib'

/**
 * 🔐 MASTER TOTP LOGIN - Dashboard Emergency Access
 *
 * Static email for master login. When this email is used with an 8-digit
 * TOTP code as password, the system authenticates as SUPERADMIN.
 *
 * Usage:
 * - Email configured via MASTER_LOGIN_EMAIL environment variable
 * - Password: TOTP code from authenticator app
 *
 * Security:
 * - All master logins are audited
 * - Uses same TOTP_MASTER_SECRET as TPV
 * - 60-second code validity with tolerance
 */
const MASTER_LOGIN_EMAIL = process.env.MASTER_LOGIN_EMAIL || 'master@avoqado.io'

/**
 * 🔐 Handle Master TOTP Login for Dashboard
 *
 * Validates 8-digit TOTP code and returns synthetic SUPERADMIN session.
 * No real user is created in the database.
 *
 * @param totpCode - 8-digit code from Google Authenticator
 * @param rememberMe - Whether to extend token expiration
 * @returns Login response with synthetic SUPERADMIN staff
 */
async function handleMasterTotpLogin(totpCode: string, rememberMe?: boolean) {
  logger.warn(`🔐 [MASTER LOGIN] Dashboard master login attempt`)

  // Get TOTP secret from environment
  const totpSecret = process.env.TOTP_MASTER_SECRET
  if (!totpSecret) {
    logger.error('🔐 [MASTER LOGIN] TOTP_MASTER_SECRET not configured!')
    throw new AuthenticationError('Sistema de autenticación no configurado')
  }

  // Configure TOTP for 8 digits and 60-second window
  const totp = new TOTP({
    digits: 8,
    period: 60,
    secret: totpSecret,
    crypto: new NobleCryptoPlugin(),
    base32: new ScureBase32Plugin(),
  })

  // Validate TOTP code with 60-second tolerance
  const verifyResult = await totp.verify(totpCode, { epochTolerance: 60 })
  const isValid = verifyResult.valid

  if (!isValid) {
    logger.warn(`🔐 [MASTER LOGIN] FAILED - Invalid TOTP code for dashboard`)
    // Note: Audit log skipped for failed attempts (venueId required)
    // Security monitoring relies on server logs with timestamp
    throw new AuthenticationError('Código inválido o expirado')
  }

  // Get first available venue for context (SUPERADMIN can switch to any)
  const firstVenue = await prisma.venue.findFirst({
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      status: true,
      organizationId: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  if (!firstVenue) {
    throw new AuthenticationError('No hay venues disponibles en el sistema')
  }

  // Generate JWT tokens with SUPERADMIN role
  const accessToken = jwtService.generateAccessToken(
    'MASTER_ADMIN',
    firstVenue.organizationId || firstVenue.id,
    firstVenue.id,
    StaffRole.SUPERADMIN,
    rememberMe,
  )
  const refreshToken = jwtService.generateRefreshToken('MASTER_ADMIN', firstVenue.organizationId || firstVenue.id, rememberMe)

  // Audit log for successful master login
  logAction({
    venueId: firstVenue.id,
    action: 'MASTER_LOGIN_SUCCESS',
    entity: 'Dashboard',
    entityId: 'DASHBOARD_MASTER',
    data: {
      venueName: firstVenue.name,
      timestamp: new Date().toISOString(),
      source: 'dashboard',
    },
  })

  logger.warn(`🔐 [MASTER LOGIN] SUCCESS - Dashboard master login, initial venue: ${firstVenue.name}`)

  // Return synthetic SUPERADMIN staff (matches normal login response structure)
  return {
    accessToken,
    refreshToken,
    staff: {
      id: 'MASTER_ADMIN',
      email: MASTER_LOGIN_EMAIL,
      firstName: 'Master',
      lastName: 'Admin',
      organizationId: firstVenue.organizationId,
      photoUrl: null,
      phone: null,
      createdAt: new Date(),
      lastLogin: new Date(),
      role: StaffRole.SUPERADMIN, // Include role for frontend
      isMasterLogin: true, // 🔐 Flag so frontend knows this is master access
      venues: [
        {
          id: firstVenue.id,
          name: firstVenue.name,
          slug: firstVenue.slug,
          logo: firstVenue.logo,
          role: StaffRole.SUPERADMIN,
          status: firstVenue.status,
          permissions: ['*'], // Full permissions
        },
      ],
    },
  }
}

export async function loginStaff(loginData: LoginDto) {
  const { email, password, venueId, rememberMe } = loginData

  // 🔐 MASTER TOTP LOGIN - Check if this is a master login attempt
  // Condition: email matches master email AND password is 8 digits (TOTP code)
  const isMasterLoginAttempt = email.toLowerCase() === MASTER_LOGIN_EMAIL.toLowerCase() && /^\d{8}$/.test(password)

  if (isMasterLoginAttempt) {
    return handleMasterTotpLogin(password, rememberMe)
  }

  // 1. Buscar staff con TODOS sus venues (no solo el solicitado)
  // First query: get basic staff info to check if SUPERADMIN
  const staffBasic = await prisma.staff.findUnique({
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      venues: {
        where: { active: true },
        select: { role: true },
      },
    },
  })

  const isSuperadmin = staffBasic?.venues.some(sv => sv.role === StaffRole.SUPERADMIN) ?? false

  // Second query: get full staff with venues
  // SUPERADMIN can see ALL venues (including suspended), others only see operational venues
  const staff = await prisma.staff.findUnique({
    where: { email: email.toLowerCase() },
    include: {
      organizations: {
        where: { isPrimary: true, isActive: true },
        include: { organization: true },
        take: 1,
      },
      venues: {
        where: {
          active: true,
          // SUPERADMIN sees ALL venues, others only see operational venues
          ...(isSuperadmin ? {} : { venue: { status: { in: OPERATIONAL_VENUE_STATUSES } } }),
        },
        include: {
          venue: {
            select: {
              id: true,
              name: true,
              slug: true,
              logo: true,
              status: true, // Single source of truth for venue state
              kycStatus: true, // Include KYC status for frontend
              organizationId: true, // For deriving orgId in token generation
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
    // SECURITY: 60 min lockout (30 min was too short - 240 attempts/day possible)
    if (newAttempts >= 5) {
      updates.lockedUntil = new Date(Date.now() + 60 * 60 * 1000) // 60 minutes
      await prisma.staff.update({
        where: { id: staff.id },
        data: updates,
      })
      throw new ForbiddenError('Account locked due to too many failed login attempts. Please try again in 60 minutes.')
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
    const organization = staff.organizations[0]?.organization
    const hasOwnerRole = organization ? staff.email === organization.email : false // Primary owner (created during signup)

    // If OWNER and onboarding not completed, allow login with placeholder venueId
    if (hasOwnerRole && organization && !organization.onboardingCompletedAt) {
      // Generate token with placeholder venueId for onboarding flow
      const orgId = await getPrimaryOrganizationId(staff.id)
      const accessToken = jwtService.generateAccessToken(staff.id, orgId, 'pending', StaffRole.OWNER)
      const refreshToken = jwtService.generateRefreshToken(staff.id, orgId)

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
          organizationId: staff.organizations[0]?.organizationId ?? null,
          photoUrl: staff.photoUrl,
          phone: staff.phone,
          createdAt: staff.createdAt,
          lastLogin: staff.lastLoginAt,
          role: StaffRole.OWNER, // CRITICAL: Include role so frontend can detect OWNER status
          venues: [], // Empty venues array (user needs to complete onboarding)
        },
      }
    }

    // 3.6. Enterprise Pattern: Check for pending invitations before blocking
    // This allows users with no active venues but pending invitations to login
    // and be redirected to accept their invitations
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
      take: 10, // Limit to 10 most recent
    })

    if (pendingInvitations.length > 0) {
      // User has pending invitations - allow login with limited access
      // Frontend will redirect to invitation acceptance flow
      const orgId = staff.organizations[0]?.organizationId ?? pendingInvitations[0].organization.id
      const accessToken = jwtService.generateAccessToken(staff.id, orgId, 'pending-invitation', StaffRole.VIEWER)
      const refreshToken = jwtService.generateRefreshToken(staff.id, orgId)

      // Reset failed attempts
      await prisma.staff.update({
        where: { id: staff.id },
        data: {
          lastLoginAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      })

      logger.info('User logged in with pending invitations (no active venues)', {
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
          phone: staff.phone,
          createdAt: staff.createdAt,
          lastLogin: staff.lastLoginAt,
          role: StaffRole.VIEWER,
          venues: [],
        },
        // NEW: Include pending invitations for frontend to handle
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
    throw new ForbiddenError('No tienes acceso a ningún establecimiento', 'NO_VENUE_ACCESS')
  }

  // 4. Generar tokens con el venue seleccionado (derive orgId from venue)
  const selectedVenueOrgId = selectedVenue.venue.organizationId ?? staff.organizations[0]?.organizationId
  const accessToken = jwtService.generateAccessToken(staff.id, selectedVenueOrgId, selectedVenue.venueId, selectedVenue.role, rememberMe)

  const refreshToken = jwtService.generateRefreshToken(staff.id, selectedVenueOrgId, rememberMe)

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
    organizationId: staff.organizations[0]?.organizationId ?? null,
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
        status: sv.venue.status, // Single source of truth for venue state
        kycStatus: sv.venue.kycStatus, // KYC compliance status
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
    include: {
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

  // First check if venue exists and is operational
  const targetVenue = await prisma.venue.findUnique({
    where: { id: targetVenueId },
    select: {
      id: true,
      organizationId: true,
      status: true, // Include venue status for operational check
    },
  })

  if (!targetVenue) {
    throw new ForbiddenError('El establecimiento solicitado no existe.')
  }

  // Security Enhancement: Verify venue is operational before allowing switch
  // This prevents users from switching to SUSPENDED, ADMIN_SUSPENDED, or CLOSED venues
  // EXCEPTION: SUPERADMIN can switch to ANY venue (including suspended)
  if (!isSuperAdmin && !OPERATIONAL_VENUE_STATUSES.includes(targetVenue.status)) {
    logger.warn('switchVenue rejected: venue not operational', {
      staffId,
      targetVenueId,
      venueStatus: targetVenue.status,
    })
    throw new ForbiddenError('El establecimiento no está operacional. Contacta a soporte para más información.')
  }

  // Si es SUPERADMIN, permitir acceso a cualquier venue
  if (isSuperAdmin) {
    // Los SUPERADMINs mantienen su rol SUPERADMIN incluso al cambiar de venue
    roleInNewVenue = StaffRole.SUPERADMIN
  }
  // Si es OWNER, permitir acceso a cualquier venue de su organización (multi-org aware)
  else if (isOwner && (await hasOrganizationAccess(staffId, targetVenue.organizationId))) {
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

  // 2. Generar un nuevo set de tokens (derive orgId from target venue)
  const targetOrgId = targetVenue.organizationId
  const accessToken = jwtService.generateAccessToken(staffId, targetOrgId, targetVenueId, roleInNewVenue)
  const refreshToken = jwtService.generateRefreshToken(staffId, targetOrgId)

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

    // 5. SECURITY: Hash token with SHA256 for O(1) database lookup
    // SHA256 is sufficient here because:
    // - Token is cryptographically random (256 bits entropy)
    // - Token expires in 1 hour
    // - Single use only
    // bcrypt would require O(n) iteration over all tokens (timing attack)
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex')

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
 * SECURITY: Uses SHA256 for O(1) lookup (prevents timing attacks)
 * @param token - Plain reset token from URL
 * @returns { valid: true } if valid (no email exposed)
 */
export async function validateResetToken(token: string) {
  // 1. SECURITY: SHA256 hash for O(1) database lookup (prevents timing attack)
  // With bcrypt, we'd need to iterate all tokens and compare each (O(n))
  // which reveals information via response timing
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex')

  // 2. Direct database lookup (constant time)
  const staff = await prisma.staff.findFirst({
    where: {
      resetToken: hashedToken,
    },
    select: {
      id: true,
      resetTokenExpiry: true,
      resetTokenUsedAt: true,
    },
  })

  // 3. Token not found
  if (!staff) {
    throw new BadRequestError('Este enlace de restablecimiento es inválido. Por favor solicita uno nuevo.')
  }

  // 4. Check if token has expired
  if (!staff.resetTokenExpiry || new Date() > staff.resetTokenExpiry) {
    throw new BadRequestError('Este enlace de restablecimiento ha expirado. Por favor solicita uno nuevo.')
  }

  // 5. Check if token has already been used
  if (staff.resetTokenUsedAt) {
    throw new BadRequestError('Este enlace de restablecimiento ya fue utilizado. Por favor solicita uno nuevo.')
  }

  // 6. SECURITY: Don't return email (even masked) - reduces information leakage
  // Email domain was previously exposed via masked format
  return { valid: true }
}

/**
 * Reset password with token
 * SECURITY: Uses SHA256 for O(1) lookup + atomic update to prevent race conditions
 * @param data - Token and new password
 */
export async function resetPassword(data: ResetPasswordDto) {
  const { token, newPassword } = data

  // 1. SECURITY: SHA256 hash for O(1) database lookup (prevents timing attack)
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex')

  // 2. First verify token exists and is valid (for proper error messages)
  const staff = await prisma.staff.findFirst({
    where: {
      resetToken: hashedToken,
    },
    select: {
      id: true,
      email: true,
      resetTokenExpiry: true,
      resetTokenUsedAt: true,
    },
  })

  // 3. Token not found
  if (!staff) {
    throw new BadRequestError('Este enlace de restablecimiento es inválido. Por favor solicita uno nuevo.')
  }

  // 4. Check if token has expired
  if (!staff.resetTokenExpiry || new Date() > staff.resetTokenExpiry) {
    throw new BadRequestError('Este enlace de restablecimiento ha expirado. Por favor solicita uno nuevo.')
  }

  // 5. Check if token has already been used (informational only - atomic check below)
  if (staff.resetTokenUsedAt) {
    throw new BadRequestError('Este enlace de restablecimiento ya fue utilizado. Por favor solicita uno nuevo.')
  }

  // 6. Hash new password
  const hashedPassword = await bcrypt.hash(newPassword, 10)

  // 7. SECURITY: Atomic update with condition to prevent race condition
  // Two simultaneous requests with the same token:
  // - Request A: Checks resetTokenUsedAt is null ✓
  // - Request B: Checks resetTokenUsedAt is null ✓ (same time)
  // - Request A: Updates password to "pass1"
  // - Request B: Updates password to "pass2" (overwrites!)
  // Solution: Include the condition IN the update query itself
  const updateResult = await prisma.staff.updateMany({
    where: {
      id: staff.id,
      resetToken: hashedToken, // Verify token hasn't changed
      resetTokenUsedAt: null, // CRITICAL: Only update if NOT already used
    },
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

  // 8. Check if update actually happened (race condition lost)
  if (updateResult.count === 0) {
    // Another request already used this token
    throw new BadRequestError('Este enlace de restablecimiento ya fue utilizado. Por favor solicita uno nuevo.')
  }

  // 9. TODO: Invalidate all refresh tokens (force re-login on all devices)
  // This requires Redis session management implementation

  logger.info(`Password reset successfully for staff: ${staff.email}`)

  return { message: 'Contraseña restablecida exitosamente. Ya puedes iniciar sesión con tu nueva contraseña.' }
}
