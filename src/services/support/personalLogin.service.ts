import { randomUUID } from 'crypto'
import { AuthMethod, StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as jwtService from '@/jwt.service'
import { createSession } from '@/services/auth/session.service'
import { issueGrant } from '@/services/auth/refreshGrant.service'
import { refreshGrantExpiry } from '@/services/mobile/auth.mobile.service'

// Only called after the existing credential verifier succeeds; this grants no venue or organization scope.
export async function createSupportPersonalLogin(
  staff: { id: string; email: string; firstName: string; lastName: string; photoUrl: string | null; phone: string | null; createdAt: Date },
  strongAuthAt: Date,
  rememberMe?: boolean,
) {
  const scope = 'support-personal'
  const session = await createSession({ staffId: staff.id, venueId: scope, authMethod: AuthMethod.PASSWORD, strongAuthAt })
  const accessToken = jwtService.generateAccessToken(staff.id, scope, scope, StaffRole.VIEWER, rememberMe, { sid: session.id })
  const refreshToken = jwtService.generateRefreshToken(staff.id, scope, rememberMe, scope, { sid: session.id })
  await issueGrant(session.id, randomUUID(), refreshToken, refreshGrantExpiry(rememberMe))
  await prisma.staff.update({ where: { id: staff.id }, data: { lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null } })
  return {
    accessToken,
    refreshToken,
    staff: {
      id: staff.id,
      email: staff.email,
      firstName: staff.firstName,
      lastName: staff.lastName,
      photoUrl: staff.photoUrl,
      phone: staff.phone,
      createdAt: staff.createdAt,
      role: StaffRole.VIEWER,
      venues: [],
    },
  }
}
