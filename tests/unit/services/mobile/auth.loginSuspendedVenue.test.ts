/**
 * A suspended venue must not let anyone in on mobile either.
 *
 * The PAX has blocked this since day one, with a message that names the state
 * (`auth.tpv.service.ts`), and the dashboard simply does not list a suspended
 * venue at login. Android and iOS were the one rail nobody applied it to: the
 * refresh now rejects it, but the LOGIN still walked straight in.
 *
 * 🔴 It filters, it does not slam the door. Someone with three shops and one
 * suspended keeps working in the other two — same as the dashboard. Only when
 * NOTHING of theirs is operational do they get stopped, and then the message
 * says which state it is, never a bare "no puedes entrar": the repo's own rule
 * is that switched-off has to be visible and explained.
 */
import { VenueStatus } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import * as jwtService from '../../../../src/jwt.service'
import bcrypt from 'bcryptjs'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loginWithEmail, pickOperationalVenueForLogin } from '../../../../src/services/mobile/auth.mobile.service'

const prismaMock = prisma as any

const venue = (id: string, status: VenueStatus) => ({
  venueId: id,
  role: 'MANAGER',
  permissionSetId: null,
  permissionSet: null,
  venue: {
    id,
    name: id,
    slug: id,
    logo: null,
    type: 'SALON',
    status,
    kycStatus: 'APPROVED',
    organizationId: 'org_1',
    timezone: 'America/Mexico_City',
  },
})

function staffWith(venues: ReturnType<typeof venue>[]) {
  return {
    id: 'staff_1',
    email: 'gerente@local.com',
    emailVerified: true,
    firstName: 'Ana',
    lastName: 'Ruiz',
    password: 'hash',
    active: true,
    photoUrl: null,
    phone: null,
    lockedUntil: null,
    failedLoginAttempts: 0,
    createdAt: new Date(),
    lastLoginAt: null,
    venues,
  }
}

beforeEach(() => {
  jest.spyOn(bcrypt, 'compare').mockImplementation(() => Promise.resolve(true) as any)
  jest.spyOn(jwtService, 'generateAccessToken').mockReturnValue('access')
  jest.spyOn(jwtService, 'generateRefreshToken').mockReturnValue('refresh')
  prismaMock.staff.update.mockResolvedValue({})
  prismaMock.venueRolePermission.findMany.mockResolvedValue([])
  prismaMock.venueRoleConfig.findMany.mockResolvedValue([])
})

describe('pickOperationalVenueForLogin', () => {
  it('🔴 keeps the operational shop and skips the suspended one', () => {
    const picked = pickOperationalVenueForLogin([venue('suspendida', 'SUSPENDED'), venue('abierta', 'ACTIVE')])

    expect(picked.venueId).toBe('abierta')
  })

  it('🔴 stops the login when NOTHING of theirs is operational, naming the state', () => {
    expect(() => pickOperationalVenueForLogin([venue('unica', 'SUSPENDED')])).toThrow(/suspendido temporalmente/i)
    expect(() => pickOperationalVenueForLogin([venue('unica', 'ADMIN_SUSPENDED')])).toThrow(/suspendido por el administrador/i)
    expect(() => pickOperationalVenueForLogin([venue('unica', 'CLOSED')])).toThrow(/cerrado permanentemente/i)
  })

  it('does not put a specific reason on several shops with different states', () => {
    // Saying "cerrado permanentemente" to someone whose other shop is only
    // paused for a week would be a lie that costs a support call.
    expect(() => pickOperationalVenueForLogin([venue('a', 'CLOSED'), venue('b', 'SUSPENDED')])).toThrow(
      /ninguno de tus establecimientos/i,
    )
  })

  it('stops someone with no shops at all', () => {
    expect(() => pickOperationalVenueForLogin([])).toThrow(/no tienes acceso/i)
  })

  // REGRESSION — the statuses that must keep working, or onboarding venues,
  // trials and the public demo all lose the ability to log in.
  it.each<VenueStatus>(['LIVE_DEMO', 'TRIAL', 'ONBOARDING', 'PENDING_ACTIVATION', 'ACTIVE'])('lets %s through', status => {
    expect(pickOperationalVenueForLogin([venue('v', status)]).venueId).toBe('v')
  })
})

describe('loginWithEmail — end to end', () => {
  it('🔴 refuses to sign in when the only shop is suspended', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(staffWith([venue('unica', 'ADMIN_SUSPENDED')]))

    await expect(loginWithEmail('gerente@local.com', 'la-contraseña')).rejects.toThrow(/suspendido por el administrador/i)
    expect(jwtService.generateAccessToken).not.toHaveBeenCalled()
  })

  it('signs in on the operational shop and ignores the suspended one', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(staffWith([venue('suspendida', 'SUSPENDED'), venue('abierta', 'ACTIVE')]))

    await loginWithEmail('gerente@local.com', 'la-contraseña')

    // The venueId sealed into the access token (3rd argument).
    expect((jwtService.generateAccessToken as jest.Mock).mock.calls.at(-1)![2]).toBe('abierta')
  })
})

describe('both login rails go through the same picker', () => {
  // 🔴 The passkey rail is expensive to drive end-to-end (WebAuthn assertion),
  // so this guards it structurally: `staff.venues[0]` was the exact line that
  // let a suspended venue in, and it must not come back on either rail.
  it('neither login path takes staff.venues[0] directly', () => {
    const source = readFileSync(join(__dirname, '../../../../src/services/mobile/auth.mobile.service.ts'), 'utf8')

    expect(source).not.toMatch(/const selectedVenue = staff\.venues\[0\]/)
    // Los DOS caminos de login (contraseña y passkey) tienen que pasar por él.
    expect((source.match(/pickOperationalVenueForLogin\(staff\.venues/g) ?? []).length).toBe(2)
  })
})
