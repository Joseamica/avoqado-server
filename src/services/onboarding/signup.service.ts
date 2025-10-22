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

  // 5. Generate JWT tokens (no venue yet, will be added during onboarding)
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
