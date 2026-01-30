/**
 * Mobile Auth Service
 *
 * Authentication services for mobile apps (iOS, Android).
 * Includes:
 * - Email/password login with tokens in response body
 * - Token refresh
 * - Passkey (WebAuthn) authentication for passwordless login
 */

import prisma from '../../utils/prismaClient'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { AuthenticationError, ForbiddenError } from '../../errors/AppError'
import { StaffRole } from '@prisma/client'
import * as jwtService from '../../jwt.service'
import { DEFAULT_PERMISSIONS } from '../../lib/permissions'
import logger from '@/config/logger'
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server'

// ============================================================================
// PASSKEY (WebAuthn) AUTHENTICATION
// ============================================================================

// In-memory challenge store (use Redis in production for multi-instance)
// Challenge expires after 5 minutes
const challengeStore = new Map<string, { challenge: string; expiresAt: number }>()

// Relying Party configuration
const RP_ID = process.env.PASSKEY_RP_ID || 'avoqado.io'
const RP_ORIGIN = process.env.PASSKEY_RP_ORIGIN || 'https://avoqado.io'

/**
 * Generate a passkey authentication challenge
 * This is the first step in the passkey sign-in flow.
 * The challenge is stored temporarily and must be verified within 5 minutes.
 *
 * @returns { challenge: string } - Base64URL encoded challenge
 */
export async function generatePasskeyChallenge() {
  logger.info('🔐 [PASSKEY] Generating authentication challenge')

  // Get all registered passkeys to allow authentication with any of them
  // For a discoverable credential flow (modal-only), we don't need to specify allowCredentials
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    // allowCredentials is empty for discoverable credentials (passkeys)
    // The authenticator will show all available credentials for this RP
    allowCredentials: [],
    userVerification: 'preferred',
    timeout: 300000, // 5 minutes
  })

  // Store challenge with expiration (5 minutes)
  const challengeKey = crypto.randomBytes(16).toString('hex')
  challengeStore.set(challengeKey, {
    challenge: options.challenge,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
  })

  // Clean up expired challenges periodically
  cleanupExpiredChallenges()

  logger.info(`🔐 [PASSKEY] Challenge generated, key: ${challengeKey.substring(0, 8)}...`)

  return {
    challenge: options.challenge,
    challengeKey, // Client needs to send this back for verification
    rpId: RP_ID,
    timeout: options.timeout,
    userVerification: options.userVerification,
  }
}

/**
 * Verify a passkey assertion and authenticate the user
 * This is the second step in the passkey sign-in flow.
 *
 * @param credential - The WebAuthn credential assertion from the client
 * @param challengeKey - The challenge key returned from generatePasskeyChallenge
 * @param rememberMe - Whether to extend token expiration
 * @returns Login result with tokens and user data
 */
export async function verifyPasskeyAssertion(credential: AuthenticationResponseJSON, challengeKey?: string, rememberMe?: boolean) {
  logger.info(`🔐 [PASSKEY] Verifying assertion for credential: ${credential.id.substring(0, 20)}...`)

  // 1. Find the stored challenge
  let expectedChallenge: string | undefined

  if (challengeKey) {
    const storedChallenge = challengeStore.get(challengeKey)
    if (!storedChallenge) {
      throw new AuthenticationError('Challenge expirado o inválido. Por favor intenta de nuevo.')
    }
    if (Date.now() > storedChallenge.expiresAt) {
      challengeStore.delete(challengeKey)
      throw new AuthenticationError('Challenge expirado. Por favor intenta de nuevo.')
    }
    expectedChallenge = storedChallenge.challenge
    // Delete challenge after use (single-use)
    challengeStore.delete(challengeKey)
  } else {
    // For clients that don't send challengeKey, try to find the most recent unexpired challenge
    // This is less secure but provides backward compatibility
    const now = Date.now()
    for (const [key, value] of challengeStore.entries()) {
      if (value.expiresAt > now) {
        expectedChallenge = value.challenge
        challengeStore.delete(key)
        break
      }
    }
    if (!expectedChallenge) {
      throw new AuthenticationError('No se encontró un challenge válido. Por favor intenta de nuevo.')
    }
  }

  // 2. Find the passkey credential in database
  const passkey = await prisma.staffPasskey.findUnique({
    where: { credentialId: credential.id },
    include: {
      staff: {
        select: {
          id: true,
          email: true,
          emailVerified: true,
          firstName: true,
          lastName: true,
          active: true,
          photoUrl: true,
          phone: true,
          createdAt: true,
          lastLoginAt: true,
          lockedUntil: true,
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
                  kycStatus: true,
                  organizationId: true,
                },
              },
            },
          },
        },
      },
    },
  })

  if (!passkey) {
    logger.warn(`🔐 [PASSKEY] Credential not found: ${credential.id.substring(0, 20)}...`)
    throw new AuthenticationError('Passkey no registrado. Por favor usa otro método de autenticación.')
  }

  const staff = passkey.staff

  // 3. Validate staff account status
  if (!staff.active) {
    throw new AuthenticationError('Tu cuenta está desactivada')
  }

  if (!staff.emailVerified) {
    throw new ForbiddenError('Por favor verifica tu email antes de iniciar sesión.')
  }

  if (staff.lockedUntil && new Date() < staff.lockedUntil) {
    const minutesLeft = Math.ceil((staff.lockedUntil.getTime() - Date.now()) / 60000)
    throw new ForbiddenError(`Cuenta bloqueada. Intenta de nuevo en ${minutesLeft} minuto${minutesLeft > 1 ? 's' : ''}.`)
  }

  // 4. Verify the WebAuthn assertion
  try {
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: [RP_ORIGIN, 'https://api.avoqado.io', 'https://dashboard.avoqado.io'],
      expectedRPID: RP_ID,
      credential: {
        id: passkey.credentialId,
        publicKey: Buffer.from(passkey.publicKey, 'base64'),
        counter: passkey.counter,
        transports: (passkey.deviceType === 'platform' ? ['internal'] : ['usb', 'ble', 'nfc']) as AuthenticatorTransportFuture[],
      },
    })

    if (!verification.verified) {
      logger.warn(`🔐 [PASSKEY] Verification failed for staff: ${staff.email}`)
      throw new AuthenticationError('Verificación de passkey fallida')
    }

    // 5. Update counter to prevent replay attacks
    await prisma.staffPasskey.update({
      where: { id: passkey.id },
      data: {
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: new Date(),
      },
    })

    logger.info(`🔐 [PASSKEY] Verification successful for staff: ${staff.email}`)
  } catch (error) {
    if (error instanceof AuthenticationError || error instanceof ForbiddenError) throw error
    logger.error(`🔐 [PASSKEY] Verification error: ${error}`)
    throw new AuthenticationError('Error al verificar el passkey')
  }

  // 6. Check venue access
  if (staff.venues.length === 0) {
    throw new ForbiddenError('No tienes acceso a ningún establecimiento')
  }

  const selectedVenue = staff.venues[0]

  // 7. Generate tokens (derive orgId from venue)
  const venueOrgId = selectedVenue.venue.organizationId
  const accessToken = jwtService.generateAccessToken(staff.id, venueOrgId, selectedVenue.venueId, selectedVenue.role, rememberMe)
  const refreshToken = jwtService.generateRefreshToken(staff.id, venueOrgId, rememberMe)

  // 8. Update last login
  await prisma.staff.update({
    where: { id: staff.id },
    data: {
      lastLoginAt: new Date(),
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  })

  // 9. Fetch custom role permissions
  const venueIds = staff.venues.map(sv => sv.venueId)
  const customRolePermissions = await prisma.venueRolePermission.findMany({
    where: { venueId: { in: venueIds } },
    select: { venueId: true, role: true, permissions: true },
  })

  // 10. Format response (same structure as email login)
  const sanitizedStaff = {
    id: staff.id,
    email: staff.email,
    firstName: staff.firstName,
    lastName: staff.lastName,
    organizationId: venueOrgId,
    photoUrl: staff.photoUrl,
    phone: staff.phone,
    createdAt: staff.createdAt,
    lastLogin: staff.lastLoginAt,
    venues: staff.venues.map(sv => {
      const customPerms = customRolePermissions.find(crp => crp.venueId === sv.venueId && crp.role === sv.role)
      const permissions = customPerms ? (customPerms.permissions as string[]) : DEFAULT_PERMISSIONS[sv.role] || []

      return {
        id: sv.venue.id,
        name: sv.venue.name,
        slug: sv.venue.slug,
        logo: sv.venue.logo,
        role: sv.role,
        status: sv.venue.status,
        kycStatus: sv.venue.kycStatus,
        permissions,
      }
    }),
  }

  logger.info(`🔐 [PASSKEY] Login successful for staff: ${staff.email}`)

  return {
    accessToken,
    refreshToken,
    staff: sanitizedStaff,
  }
}

/**
 * Clean up expired challenges from memory
 */
function cleanupExpiredChallenges() {
  const now = Date.now()
  for (const [key, value] of challengeStore.entries()) {
    if (value.expiresAt < now) {
      challengeStore.delete(key)
    }
  }
}

// ============================================================================
// EMAIL/PASSWORD AUTHENTICATION
// ============================================================================

/**
 * Login with email and password
 * Returns tokens in response body (mobile apps can't read httpOnly cookies)
 *
 * @param email - User email
 * @param password - User password
 * @param rememberMe - Whether to extend token expiration (30 days vs 24 hours)
 * @returns Login result with tokens and user data
 */
export async function loginWithEmail(email: string, password: string, rememberMe?: boolean) {
  logger.info(`🔐 [MOBILE AUTH] Login attempt for: ${email}`)

  // 1. Find staff with all active venues
  const staff = await prisma.staff.findUnique({
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      email: true,
      emailVerified: true,
      firstName: true,
      lastName: true,
      password: true,
      active: true,
      photoUrl: true,
      phone: true,
      lockedUntil: true,
      failedLoginAttempts: true,
      createdAt: true,
      lastLoginAt: true,
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
              kycStatus: true,
              organizationId: true,
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

  // 2. Check if account is locked
  if (staff.lockedUntil && new Date() < staff.lockedUntil) {
    const minutesLeft = Math.ceil((staff.lockedUntil.getTime() - Date.now()) / 60000)
    throw new ForbiddenError(`Cuenta bloqueada temporalmente. Intenta de nuevo en ${minutesLeft} minuto${minutesLeft > 1 ? 's' : ''}.`)
  }

  // 3. Verify password
  const passwordMatch = await bcrypt.compare(password, staff.password)
  if (!passwordMatch) {
    // Increment failed attempts
    const newAttempts = staff.failedLoginAttempts + 1
    const updates: any = { failedLoginAttempts: newAttempts }

    // Lock account after 5 failed attempts (60 minute lockout)
    if (newAttempts >= 5) {
      updates.lockedUntil = new Date(Date.now() + 60 * 60 * 1000)
      await prisma.staff.update({
        where: { id: staff.id },
        data: updates,
      })
      throw new ForbiddenError('Cuenta bloqueada por demasiados intentos fallidos. Intenta de nuevo en 60 minutos.')
    }

    await prisma.staff.update({
      where: { id: staff.id },
      data: updates,
    })
    throw new AuthenticationError('Correo electrónico o contraseña incorrectos.')
  }

  // 4. Verify email is verified
  if (!staff.emailVerified) {
    throw new ForbiddenError('Por favor verifica tu correo electrónico antes de iniciar sesión.')
  }

  // 5. Check venue access
  if (staff.venues.length === 0) {
    throw new ForbiddenError('No tienes acceso a ningún establecimiento', 'NO_VENUE_ACCESS')
  }

  const selectedVenue = staff.venues[0]

  // 6. Generate tokens (derive orgId from venue)
  const emailLoginOrgId = selectedVenue.venue.organizationId
  const accessToken = jwtService.generateAccessToken(staff.id, emailLoginOrgId, selectedVenue.venueId, selectedVenue.role, rememberMe)
  const refreshToken = jwtService.generateRefreshToken(staff.id, emailLoginOrgId, rememberMe)

  // 7. Update last login and reset failed attempts
  await prisma.staff.update({
    where: { id: staff.id },
    data: {
      lastLoginAt: new Date(),
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  })

  // 8. Fetch custom role permissions
  const venueIds = staff.venues.map(sv => sv.venueId)
  const customRolePermissions = await prisma.venueRolePermission.findMany({
    where: { venueId: { in: venueIds } },
    select: { venueId: true, role: true, permissions: true },
  })

  // 9. Format response
  const sanitizedStaff = {
    id: staff.id,
    email: staff.email,
    firstName: staff.firstName,
    lastName: staff.lastName,
    organizationId: emailLoginOrgId,
    photoUrl: staff.photoUrl,
    phone: staff.phone,
    createdAt: staff.createdAt,
    lastLogin: staff.lastLoginAt,
    venues: staff.venues.map(sv => {
      const customPerms = customRolePermissions.find(crp => crp.venueId === sv.venueId && crp.role === sv.role)
      const permissions = customPerms ? (customPerms.permissions as string[]) : DEFAULT_PERMISSIONS[sv.role] || []

      return {
        id: sv.venue.id,
        name: sv.venue.name,
        slug: sv.venue.slug,
        logo: sv.venue.logo,
        role: sv.role,
        status: sv.venue.status,
        kycStatus: sv.venue.kycStatus,
        permissions,
      }
    }),
  }

  logger.info(`🔐 [MOBILE AUTH] Login successful for: ${staff.email}`)

  return {
    accessToken,
    refreshToken,
    staff: sanitizedStaff,
  }
}

// ============================================================================
// TOKEN REFRESH
// ============================================================================

/**
 * Refresh access token using refresh token
 * Mobile apps send refresh token in request body (not cookies)
 *
 * @param refreshToken - The refresh token from the client
 * @returns New access token and optionally new refresh token
 */
export async function refreshAccessToken(refreshToken: string) {
  logger.info('🔐 [MOBILE AUTH] Token refresh attempt')

  // 1. Verify refresh token
  let payload: jwtService.RefreshTokenPayload
  try {
    payload = jwtService.verifyRefreshToken(refreshToken)
  } catch (error) {
    logger.warn('🔐 [MOBILE AUTH] Invalid refresh token')
    throw new AuthenticationError('Token de refresco inválido o expirado')
  }

  // 2. Find the staff
  const staff = await prisma.staff.findUnique({
    where: { id: payload.sub },
    select: {
      id: true,
      email: true,
      active: true,
      venues: {
        where: { active: true },
        include: {
          venue: {
            select: {
              id: true,
              status: true,
              organizationId: true,
            },
          },
        },
      },
    },
  })

  if (!staff) {
    throw new AuthenticationError('Usuario no encontrado')
  }

  if (!staff.active) {
    throw new AuthenticationError('Cuenta desactivada')
  }

  // 3. Get first active venue
  if (staff.venues.length === 0) {
    throw new ForbiddenError('No tienes acceso a ningún establecimiento')
  }

  const selectedVenue = staff.venues[0]

  // 4. Generate new tokens (derive orgId from venue)
  const refreshOrgId = selectedVenue.venue.organizationId
  const newAccessToken = jwtService.generateAccessToken(staff.id, refreshOrgId, selectedVenue.venueId, selectedVenue.role)
  const newRefreshToken = jwtService.generateRefreshToken(staff.id, refreshOrgId)

  logger.info(`🔐 [MOBILE AUTH] Token refreshed for: ${staff.email}`)

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
  }
}
