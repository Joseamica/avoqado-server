import bcrypt from 'bcrypt'
import prisma from '@/utils/prismaClient'

/** Thrown for any login failure shown on the consent page. Message is user-safe. */
export class McpLoginError extends Error {}

const GENERIC = 'Email or password is incorrect.'
const LOCK_THRESHOLD = 5
const LOCK_MINUTES = 60

/**
 * Verify operator credentials for the MCP consent page. Mirrors loginStaff
 * (src/services/dashboard/auth.service.ts:151): active + lockout + bcrypt + emailVerified.
 * Returns the Staff id. Throws McpLoginError on any failure.
 */
export async function authenticateForMcp(emailRaw: string, password: string): Promise<string> {
  const email = emailRaw.trim().toLowerCase()
  const staff = await prisma.staff.findUnique({
    where: { email },
    select: { id: true, password: true, active: true, emailVerified: true, lockedUntil: true, failedLoginAttempts: true },
  })
  if (!staff || !staff.password) throw new McpLoginError(GENERIC)
  if (!staff.active) throw new McpLoginError('This account is deactivated.')
  if (staff.lockedUntil && staff.lockedUntil.getTime() > Date.now()) {
    throw new McpLoginError('Account temporarily locked due to too many failed attempts. Try again later.')
  }

  const ok = await bcrypt.compare(password, staff.password)
  if (!ok) {
    const attempts = staff.failedLoginAttempts + 1
    const data: { failedLoginAttempts: number; lockedUntil?: Date } = { failedLoginAttempts: attempts }
    if (attempts >= LOCK_THRESHOLD) data.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
    await prisma.staff.update({ where: { id: staff.id }, data })
    throw new McpLoginError(data.lockedUntil ? 'Account locked due to too many failed attempts. Try again in 60 minutes.' : GENERIC)
  }

  if (!staff.emailVerified) throw new McpLoginError('Please verify your email before connecting.')

  if (staff.failedLoginAttempts > 0) {
    await prisma.staff.update({ where: { id: staff.id }, data: { failedLoginAttempts: 0 } })
  }
  return staff.id
}
