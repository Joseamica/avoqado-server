/**
 * Signup Service
 *
 * Handles new user registration and organization creation.
 * This service creates a new staff member with OWNER role and their organization.
 */

import bcrypt from 'bcryptjs'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import * as jwtService from '@/jwt.service'
import { StaffRole } from '@prisma/client'
import emailService from '@/services/email.service'

export interface SignupInput {
  email: string
  password: string
  firstName: string
  lastName: string
  organizationName: string
}

export interface SignupResult {
  accessToken: string
  refreshToken: string
  staff: {
    id: string
    email: string
    firstName: string
    lastName: string
    organizationId: string
    photoUrl: string | null
  }
  organization: {
    id: string
    name: string
  }
}

export interface VerifyEmailResult {
  emailVerified: boolean
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
        organizationId: organization.id,
        active: true,
        emailVerified: false,
        lastLoginAt: new Date(),
      },
    })

    return { organization, staff }
  })

  // 5. Generate 4-digit verification code and send email
  const verificationCode = Math.floor(1000 + Math.random() * 9000).toString()

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

  // 6. Generate JWT tokens (no venue yet, will be added during onboarding)
  // We'll use a temporary venue-less token for the onboarding process
  const accessToken = jwtService.generateAccessToken(
    result.staff.id,
    result.organization.id,
    'pending', // Temporary placeholder until venue is created
    StaffRole.OWNER,
  )

  const refreshToken = jwtService.generateRefreshToken(result.staff.id, result.organization.id)

  // 6. Return sanitized data
  return {
    accessToken,
    refreshToken,
    staff: {
      id: result.staff.id,
      email: result.staff.email,
      firstName: result.staff.firstName,
      lastName: result.staff.lastName,
      organizationId: result.staff.organizationId,
      photoUrl: result.staff.photoUrl,
    },
    organization: {
      id: result.organization.id,
      name: result.organization.name,
    },
  }
}

/**
 * Verifies user email with 4-digit PIN code
 *
 * @param email - User's email address
 * @param verificationCode - 4-digit PIN code
 * @returns Verification result
 */
export async function verifyEmailCode(email: string, verificationCode: string): Promise<VerifyEmailResult> {
  // 1. Find staff by email
  const staff = await prisma.staff.findUnique({
    where: { email: email.toLowerCase() },
  })

  if (!staff) {
    throw new BadRequestError('Invalid email or verification code')
  }

  // 2. Check if already verified
  if (staff.emailVerified) {
    return { emailVerified: true }
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

  return { emailVerified: true }
}
