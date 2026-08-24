/**
 * Signup Service
 *
 * Handles new user registration and organization creation.
 * This service creates a new staff member with OWNER role and their organization.
 */

import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import * as jwtService from '@/jwt.service'
import { StaffRole, OrgRole } from '@prisma/client'
import emailService from '@/services/email.service'
import { getPrimaryOrganizationId } from '@/services/staffOrganization.service'

export interface SignupInput {
  email: string
  password: string
  firstName?: string
  lastName?: string
  organizationName?: string
  wizardVersion?: number
}

export interface SignupResult {
  staff: {
    id: string
    email: string
    firstName: string
    lastName: string
    organizationId: string | null
    photoUrl: string | null
  }
  organization: {
    id: string
    name: string
  }
}

export interface LandingSignupInput {
  email: string
  firstName?: string
  lastName?: string
  organizationName?: string
  phone?: string
  /** De que landing vino (`landing_restaurantes`, `landing_retail`…). Queda en
   *  el ActivityLog del alta para poder partir el embudo por campana. */
  source?: string
  /** Parametros de campana que traia la URL de aterrizaje (`utm_source`,
   *  `utm_campaign`, `fbclid`, `gclid`…). Antes solo se pegaban en el correo
   *  interno, asi que "de que campana vino este lead" no se podia CONSULTAR:
   *  habia que abrir correos a mano. Guardarlos junto a `source` los vuelve
   *  parte del alta y hace comparable una campana contra otra. */
  utm?: Record<string, string>
}

export interface LandingSignupResult {
  staff: { id: string; email: string }
  organizationId: string | null
  /** Token EN CLARO para el magic link. En la DB solo vive su hash SHA-256.
   *  null cuando la cuenta YA es de un cliente con contrasena: a ese no se le
   *  toca el token ni se le manda un magic link. */
  magicLinkToken: string | null
  alreadyExisted: boolean
  /** true = ya es cliente (tiene contrasena). Cambia el correo que se le manda
   *  y el aviso interno: no es un prospecto nuevo. */
  yaEsCliente: boolean
}

export interface VerifyEmailResult {
  emailVerified: boolean
  accessToken: string
  refreshToken: string
}

/**
 * Creates a new user account with organization
 *
 * @param input - Signup data
 * @returns JWT tokens and user data
 */
export async function signupUser(input: SignupInput): Promise<SignupResult> {
  const { email, password, firstName = '', lastName = '', organizationName = '', wizardVersion } = input

  // 1. Check if email already exists
  const existingStaff = await prisma.staff.findUnique({
    where: { email: email.toLowerCase() },
  })

  if (existingStaff) {
    throw new BadRequestError('Email already registered. Please login instead.')
  }

  // 2. Validate password strength
  if (password.length < 8) {
    throw new BadRequestError('Password must be at least 8 characters long')
  }

  // 3. Hash password
  const hashedPassword = await bcrypt.hash(password, 12)

  // 4. Create organization and staff in a transaction
  const result = await prisma.$transaction(async tx => {
    // Create organization
    const organization = await tx.organization.create({
      data: {
        name: organizationName || 'Nuevo Negocio',
        email: email.toLowerCase(), // Use user's email as organization email
        phone: '', // Placeholder, will be updated in onboarding Step 3
      },
    })

    // Create staff member as OWNER of the organization
    const staff = await tx.staff.create({
      data: {
        email: email.toLowerCase(),
        password: hashedPassword,
        firstName,
        lastName,
        active: true,
        emailVerified: false,
        lastLoginAt: new Date(),
      },
    })

    // Create StaffOrganization junction table entry (multi-org support)
    await tx.staffOrganization.create({
      data: {
        staffId: staff.id,
        organizationId: organization.id,
        role: OrgRole.OWNER,
        isPrimary: true,
        isActive: true,
      },
    })

    // Create OnboardingProgress (V2 wizard sets wizardVersion: 2)
    await tx.onboardingProgress.create({
      data: {
        organizationId: organization.id,
        currentStep: 0,
        completedSteps: [],
        ...(wizardVersion ? { wizardVersion } : {}),
      },
    })

    return { organization, staff }
  })

  // 5. Generate 6-digit cryptographically secure verification code and send email
  const verificationCode = crypto.randomInt(100000, 999999).toString()

  // Set expiration to 10 minutes from now
  const expirationTime = new Date()
  expirationTime.setMinutes(expirationTime.getMinutes() + 10)

  // Update staff record with verification code
  await prisma.staff.update({
    where: { id: result.staff.id },
    data: {
      emailVerificationCode: verificationCode,
      emailVerificationExpires: expirationTime,
    },
  })

  // Send verification email
  await emailService.sendEmailVerification(result.staff.email, {
    firstName: result.staff.firstName || 'Usuario',
    verificationCode,
  })

  // 6. Return sanitized data (no tokens - user must verify email first)
  // FAANG Pattern (Approach B): Tokens are generated only after email verification
  return {
    staff: {
      id: result.staff.id,
      email: result.staff.email,
      firstName: result.staff.firstName,
      lastName: result.staff.lastName,
      organizationId: result.organization.id,
      photoUrl: result.staff.photoUrl,
    },
    organization: {
      id: result.organization.id,
      name: result.organization.name,
    },
  }
}

/**
 * Verifies user email with 6-digit PIN code and generates auth tokens
 * FAANG Pattern (Approach B): Tokens generated only after email verification
 *
 * @param email - User's email address
 * @param verificationCode - 6-digit PIN code
 * @returns Verification result with auth tokens for auto-login
 */
export async function verifyEmailCode(email: string, verificationCode: string): Promise<VerifyEmailResult> {
  // 1. Find staff by email
  const staff = await prisma.staff.findUnique({
    where: { email: email.toLowerCase() },
  })

  if (!staff) {
    throw new BadRequestError('Invalid email or verification code')
  }

  // DEV BYPASS: Accept '000000' code in development mode
  const isDev = process.env.NODE_ENV === 'development'
  const isBypassCode = verificationCode === '000000'

  if (isDev && isBypassCode && !staff.emailVerified) {
    // Auto-verify in dev mode with bypass code
    await prisma.staff.update({
      where: { id: staff.id },
      data: {
        emailVerified: true,
        emailVerificationCode: null,
        emailVerificationExpires: null,
      },
    })

    // Generate JWT tokens for auto-login
    const orgId = await getPrimaryOrganizationId(staff.id)
    const accessToken = jwtService.generateAccessToken(staff.id, orgId, 'pending', StaffRole.OWNER)
    const refreshToken = jwtService.generateRefreshToken(staff.id, orgId)

    return {
      emailVerified: true,
      accessToken,
      refreshToken,
    }
  }

  // 2. Check if already verified
  if (staff.emailVerified) {
    // Already verified - generate tokens for auto-login
    const orgId = await getPrimaryOrganizationId(staff.id)
    const accessToken = jwtService.generateAccessToken(
      staff.id,
      orgId,
      'pending', // Temporary placeholder until venue is created
      StaffRole.OWNER,
    )
    const refreshToken = jwtService.generateRefreshToken(staff.id, orgId)

    return {
      emailVerified: true,
      accessToken,
      refreshToken,
    }
  }

  // 3. Check if verification code exists
  if (!staff.emailVerificationCode || !staff.emailVerificationExpires) {
    throw new BadRequestError('No verification code found. Please request a new one.')
  }

  // 4. Check if code has expired
  if (new Date() > staff.emailVerificationExpires) {
    throw new BadRequestError('Verification code has expired. Please request a new one.')
  }

  // 5. Check if code matches
  if (staff.emailVerificationCode !== verificationCode) {
    throw new BadRequestError('Invalid verification code')
  }

  // 6. Mark email as verified and clear verification fields
  await prisma.staff.update({
    where: { id: staff.id },
    data: {
      emailVerified: true,
      emailVerificationCode: null,
      emailVerificationExpires: null,
    },
  })

  // 7. Generate JWT tokens for auto-login
  const orgId = await getPrimaryOrganizationId(staff.id)
  const accessToken = jwtService.generateAccessToken(
    staff.id,
    orgId,
    'pending', // Temporary placeholder until venue is created
    StaffRole.OWNER,
  )
  const refreshToken = jwtService.generateRefreshToken(staff.id, orgId)

  return {
    emailVerified: true,
    accessToken,
    refreshToken,
  }
}

/**
 * Resends verification code to user's email
 *
 * @param email - User's email address
 * @returns Success result
 */
export async function resendVerificationCode(email: string): Promise<{ success: boolean; message: string }> {
  // 1. Find staff by email
  const staff = await prisma.staff.findUnique({
    where: { email: email.toLowerCase() },
  })

  if (!staff) {
    throw new BadRequestError('Email not found. Please sign up first.')
  }

  // 2. Check if already verified
  if (staff.emailVerified) {
    throw new BadRequestError('Email is already verified')
  }

  // 3. Generate new 6-digit cryptographically secure verification code
  const verificationCode = crypto.randomInt(100000, 999999).toString()

  // 4. Set expiration to 10 minutes from now
  const expirationTime = new Date()
  expirationTime.setMinutes(expirationTime.getMinutes() + 10)

  // 5. Update staff record with new verification code
  await prisma.staff.update({
    where: { id: staff.id },
    data: {
      emailVerificationCode: verificationCode,
      emailVerificationExpires: expirationTime,
    },
  })

  // 6. Send verification email
  await emailService.sendEmailVerification(staff.email, {
    firstName: staff.firstName,
    verificationCode,
  })

  return {
    success: true,
    message: 'Verification code sent successfully',
  }
}

/**
 * Checks if an email exists and is verified (public endpoint for UI)
 *
 * @param email - User's email address
 * @returns Email status
 */
export async function checkEmailVerificationStatus(email: string): Promise<{ emailExists: boolean; emailVerified: boolean }> {
  // Find staff by email
  const staff = await prisma.staff.findUnique({
    where: { email: email.toLowerCase() },
    select: {
      emailVerified: true,
    },
  })

  if (!staff) {
    return {
      emailExists: false,
      emailVerified: false,
    }
  }

  return {
    emailExists: true,
    emailVerified: staff.emailVerified,
  }
}

/**
 * Alta desde una landing publica (avoqado.io/restaurants y hermanas).
 *
 * Difiere de `signupUser` en UNA cosa: aqui NO se pide contrasena, porque el
 * formulario vive en una landing de trafico pagado y cada campo extra cuesta
 * conversion (decision de la junta del 17-ago-2026).
 *
 * El usuario la define despues, con el magic link del correo de bienvenida.
 * Ese link es el flujo de reset de contrasena que YA existe — mismo token
 * hasheado, misma caducidad, mismo un-solo-uso, misma pantalla del dashboard.
 * No se invento un mecanismo nuevo ni se toco `signupUser`: quien entra por
 * dashboard.avoqado.io/signup sigue exactamente el mismo camino de siempre.
 *
 * Por que la cuenta nace con `emailVerified: true` y `password: null`:
 *   - `password: null` la deja inaccesible por login normal — la unica puerta
 *     es el magic link, que solo llega al correo que el usuario escribio.
 *   - El login exige `emailVerified` (auth.service.ts:294); dejarla en false
 *     dejaria al usuario fuera aun despues de fijar su contrasena.
 *   - La cuenta nace vacia (sin venue ni datos), asi que no hay nada que
 *     proteger todavia mas alla del acceso mismo.
 */
export async function signupFromLanding(input: LandingSignupInput): Promise<LandingSignupResult> {
  const { email, firstName = '', lastName = '', organizationName = '', phone, source, utm } = input
  const normalizedEmail = email.toLowerCase().trim()

  // 1. Cuenta existente: hay DOS casos y tratarlos igual hace dano.
  const existing = await prisma.staff.findUnique({ where: { email: normalizedEmail } })

  if (existing && existing.password !== null) {
    // YA ES CLIENTE (tiene contrasena, su negocio opera). Aqui NO se le toca el
    // resetToken: sobrescribirlo invalidaria una recuperacion de contrasena
    // legitima en curso, y dejaria que cualquiera dispare correos a cualquier
    // cuenta con solo escribir ese correo en la landing. Tampoco se le manda el
    // correo de bienvenida: lleva meses siendo cliente, decirle "ya quedo tu
    // registro" es absurdo. El controller usa `yaEsCliente` para mandarle otro
    // mensaje y para avisar a ventas que NO es un prospecto nuevo.
    return {
      staff: { id: existing.id, email: existing.email },
      organizationId: await getPrimaryOrganizationId(existing.id),
      magicLinkToken: null,
      alreadyExisted: true,
      yaEsCliente: true,
    }
  }

  const { resetToken, hashedToken, expiryTime } = buildMagicLinkToken()

  if (existing) {
    // Alta previa por landing que nunca se completo (sin contrasena). Aqui SI se
    // renueva el link: es un recordatorio util, no una intromision.
    await prisma.staff.update({
      where: { id: existing.id },
      data: { resetToken: hashedToken, resetTokenExpiry: expiryTime, resetTokenUsedAt: null },
    })
    return {
      staff: { id: existing.id, email: existing.email },
      organizationId: await getPrimaryOrganizationId(existing.id),
      magicLinkToken: resetToken,
      alreadyExisted: true,
      yaEsCliente: false,
    }
  }

  // 2. Crear organizacion + staff OWNER + progreso, igual que el signup normal
  const result = await prisma.$transaction(async tx => {
    const organization = await tx.organization.create({
      data: {
        name: organizationName || 'Nuevo Negocio',
        email: normalizedEmail,
        phone: phone || '',
      },
    })

    const staff = await tx.staff.create({
      data: {
        email: normalizedEmail,
        password: null, // sin contrasena: se fija al canjear el magic link
        firstName,
        lastName,
        phone: phone || null,
        active: true,
        emailVerified: true, // ver nota del encabezado
        resetToken: hashedToken,
        resetTokenExpiry: expiryTime,
        resetTokenUsedAt: null,
      },
    })

    await tx.staffOrganization.create({
      data: {
        staffId: staff.id,
        organizationId: organization.id,
        role: OrgRole.OWNER,
        isPrimary: true,
        isActive: true,
      },
    })

    // wizardVersion 2 = el wizard vigente (/setup). Sin esto cae al legacy.
    await tx.onboardingProgress.create({
      data: { organizationId: organization.id, currentStep: 0, completedSteps: [], wizardVersion: 2 },
    })

    // 🔴 Marca PERMANENTE de que esta cuenta nacio en una landing.
    //
    // No se puede usar `password IS NULL` para eso, que fue el primer intento:
    // esa condicion se deja de cumplir justo cuando la persona fija su
    // contrasena — o sea, en la conversion que queremos medir. El embudo
    // terminaba contando solo a los que NO convirtieron.
    //
    // `source` ademas separa el embudo por landing (restaurantes vs retail vs
    // servicios), que es lo que hace comparable una campana contra otra.
    // `utm` solo se escribe cuando la URL de aterrizaje traia algo: un `{}` en
    // cada alta organica no dice nada y ensucia la consulta del embudo.
    const utmLimpio = utm && Object.keys(utm).length > 0 ? utm : undefined
    await tx.activityLog.create({
      data: {
        staffId: staff.id,
        action: 'LANDING_SIGNUP_CREATED',
        entity: 'Staff',
        entityId: staff.id,
        data: { source: source || 'landing', organizationId: organization.id, ...(utmLimpio ? { utm: utmLimpio } : {}) },
      },
    })

    return { organization, staff }
  })

  return {
    staff: { id: result.staff.id, email: result.staff.email },
    organizationId: result.organization.id,
    magicLinkToken: resetToken,
    alreadyExisted: false,
    yaEsCliente: false,
  }
}

/** Mismo esquema que el reset de contrasena: 32 bytes, hash SHA-256, 1 hora. */
function buildMagicLinkToken() {
  const resetToken = crypto.randomBytes(32).toString('hex')
  const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex')
  const expiryTime = new Date()
  expiryTime.setHours(expiryTime.getHours() + 24) // 24h: el correo de una landing se abre mas tarde que un reset pedido a proposito
  return { resetToken, hashedToken, expiryTime }
}
