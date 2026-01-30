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
  firstName: string
  lastName: string
  organizationName: string
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
  const { email, password, firstName, lastName, organizationName } = input

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
        name: organizationName,
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
    firstName: result.staff.firstName,
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
