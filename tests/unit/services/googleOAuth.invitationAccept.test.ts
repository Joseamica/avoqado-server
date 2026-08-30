/**
 * Google sign-in that accepts an invitation must land the SAME data as the password path.
 *
 * There are two implementations of "accept this invitation": `invitation.service.acceptInvitation`
 * (the /invite/:token form) and the branch inside `googleOAuth.service.loginWithGoogle` that
 * creates a Staff row when an invited person signs in with Google for the first time. They drifted:
 * the Google branch hardcoded OrgRole.MEMBER, ignored `inviteToAllVenues` and `requirePin`, never
 * set `acceptedById`, and wrote no ActivityLog. Same invitation, different account — depending only
 * on which button the person happened to click.
 *
 * These tests pin the parity. They also cover the plain WAITER case that already worked, so the
 * parity fixes can't quietly break the common path.
 */
import { InvitationStatus, OrgRole, StaffRole } from '@prisma/client'

// --- Google ---------------------------------------------------------------------------------
const GOOGLE_PAYLOAD = {
  sub: 'google-uid-1',
  email: 'Invited@Test.com', // deliberately mixed case — everything downstream must lowercase it
  name: 'Invited Person',
  given_name: 'Invited',
  family_name: 'Person',
  picture: 'https://example.test/pic.png',
  email_verified: true,
}

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    generateAuthUrl: jest.fn().mockReturnValue('https://accounts.google.test/auth'),
    getToken: jest.fn().mockResolvedValue({ tokens: { id_token: 'id-token' } }),
    verifyIdToken: jest.fn().mockResolvedValue({ getPayload: () => GOOGLE_PAYLOAD }),
  })),
}))

// --- Mutable fixture state, reset per test --------------------------------------------------
interface MockState {
  invitation: any
  existingStaff: any
  orgVenues: { id: string }[]
  staffAfterCreate: any
  pendingInvitations: any[]
}

const state: MockState = {
  invitation: null,
  existingStaff: null,
  orgVenues: [],
  staffAfterCreate: null,
  pendingInvitations: [],
}

// Writes we assert on
const txStaffCreate = jest.fn()
const txStaffOrganizationCreate = jest.fn()
const txStaffVenueCreateMany = jest.fn()
const txInvitationUpdate = jest.fn()
const transactionRuns = jest.fn()

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: {
      findUnique: jest.fn(() => Promise.resolve(state.existingStaff)),
      findUniqueOrThrow: jest.fn(() => Promise.resolve(state.staffAfterCreate)),
      update: jest.fn().mockResolvedValue({}),
    },
    invitation: {
      findFirst: jest.fn(() => Promise.resolve(state.invitation)),
      findMany: jest.fn(() => Promise.resolve(state.pendingInvitations)),
    },
    venue: {
      findMany: jest.fn(() => Promise.resolve(state.orgVenues)),
    },
    $transaction: jest.fn(async (cb: any) => {
      transactionRuns()
      const tx = {
        staff: { create: txStaffCreate },
        staffOrganization: { create: txStaffOrganizationCreate },
        staffVenue: { createMany: txStaffVenueCreateMany },
        invitation: { update: txInvitationUpdate },
      }
      return cb(tx)
    }),
  },
}))

const assertCanAddSeatsBulk = jest.fn().mockResolvedValue(undefined)
jest.mock('../../../src/services/access/seatCap.service', () => ({ assertCanAddSeatsBulk }))

// Parte A (sesiones revocables): loginWithGoogle ahora crea una `Session` antes de emitir
// los tokens. El mock de prisma de este archivo enumera sus modelos a mano y no incluye
// `session`, asi que el servicio real reventaria aqui por una razon que no tiene nada que
// ver con lo que este archivo prueba (la paridad al aceptar una invitacion).
jest.mock('@/services/auth/session.service', () => ({
  createSession: jest.fn().mockResolvedValue({ id: 'sess_google_test' }),
}))

// Y por la MISMA razon, un piso mas abajo: al cerrar el P2 de la auditoria del 2026-08-30, este
// carril tambien emite su `RefreshGrant` — sin el, el refresh token lleva `sid` pero no tiene
// familia, y `rotateGrant` lo lee como reutilizado y REVOCA la sesion en su primer uso. El mock
// de prisma de arriba enumera sus modelos a mano y `refreshGrant` no esta, asi que se mockea el
// servicio, igual que la linea de arriba. Es la trampa del mock con lista fija: el error que sale
// (`Cannot read properties of undefined`) no menciona por ningun lado lo que se agrego.
jest.mock('@/services/auth/refreshGrant.service', () => ({
  issueGrant: jest.fn().mockResolvedValue(undefined),
}))

const logAction = jest.fn()
jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction }))

jest.mock('../../../src/jwt.service', () => ({
  generateAccessToken: jest.fn().mockReturnValue('access-token'),
  generateRefreshToken: jest.fn().mockReturnValue('refresh-token'),
}))
jest.mock('../../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('../../../src/services/staffOrganization.service', () => ({
  getPrimaryOrganizationId: jest.fn().mockResolvedValue('org-1'),
}))

import { loginWithGoogle } from '../../../src/services/dashboard/googleOAuth.service'

// --- Fixture builders -----------------------------------------------------------------------
const ORG_VENUE = {
  id: 'venue-1',
  name: 'Main Venue',
  slug: 'main-venue',
  logo: null,
  status: 'ACTIVE',
  organizationId: 'org-1',
  organization: { id: 'org-1', name: 'Test Org', email: 'owner@org.test', onboardingCompletedAt: new Date() },
}

function buildInvitation(overrides: Record<string, any> = {}) {
  return {
    id: 'inv-1',
    token: 'invite-token',
    email: 'invited@test.com',
    role: StaffRole.WAITER,
    status: InvitationStatus.PENDING,
    expiresAt: new Date(Date.now() + 86_400_000),
    organizationId: 'org-1',
    venueId: 'venue-1',
    invitedById: 'inviter-1',
    permissions: null,
    requirePin: false,
    venue: ORG_VENUE,
    ...overrides,
  }
}

/** The refetched staff the service returns once the transaction committed. */
function buildStaffAfterCreate(venueIds: string[], role: StaffRole = StaffRole.WAITER) {
  return {
    id: 'new-staff-1',
    email: 'invited@test.com',
    firstName: 'Invited',
    lastName: 'Person',
    photoUrl: GOOGLE_PAYLOAD.picture,
    active: true,
    googleId: GOOGLE_PAYLOAD.sub,
    organizations: [{ organizationId: 'org-1', organization: ORG_VENUE.organization }],
    venues: venueIds.map(id => ({
      staffId: 'new-staff-1',
      venueId: id,
      role,
      active: true,
      venue: { id, name: `Venue ${id}`, slug: id, logo: null, status: 'ACTIVE', organizationId: 'org-1' },
    })),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  txStaffCreate.mockResolvedValue({ id: 'new-staff-1' })
  txStaffOrganizationCreate.mockResolvedValue({})
  txStaffVenueCreateMany.mockResolvedValue({ count: 1 })
  txInvitationUpdate.mockResolvedValue({})

  state.invitation = buildInvitation()
  state.existingStaff = null
  state.orgVenues = [{ id: 'venue-1' }]
  state.staffAfterCreate = buildStaffAfterCreate(['venue-1'])
  state.pendingInvitations = []
})

describe('loginWithGoogle — invitation acceptance parity with the password path', () => {
  describe('organization role', () => {
    it('makes an OWNER invitation an OWNER at the organization level', async () => {
      state.invitation = buildInvitation({ role: StaffRole.OWNER })
      state.staffAfterCreate = buildStaffAfterCreate(['venue-1'], StaffRole.OWNER)

      await loginWithGoogle('id-token', false)

      expect(txStaffOrganizationCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ role: OrgRole.OWNER }) }),
      )
    })

    it('still makes a non-OWNER invitation a MEMBER (regression)', async () => {
      await loginWithGoogle('id-token', false)

      expect(txStaffOrganizationCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ role: OrgRole.MEMBER }) }),
      )
    })

    it('records who invited them on the org membership', async () => {
      await loginWithGoogle('id-token', false)

      expect(txStaffOrganizationCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ joinedById: 'inviter-1' }) }),
      )
    })
  })

  describe('inviteToAllVenues', () => {
    it('grants every venue in the org when the invitation carries the flag', async () => {
      state.invitation = buildInvitation({ role: StaffRole.OWNER, permissions: { inviteToAllVenues: true } })
      state.orgVenues = [{ id: 'venue-1' }, { id: 'venue-2' }, { id: 'venue-3' }]
      state.staffAfterCreate = buildStaffAfterCreate(['venue-1', 'venue-2', 'venue-3'], StaffRole.OWNER)

      await loginWithGoogle('id-token', false)

      const created = txStaffVenueCreateMany.mock.calls[0][0].data
      expect(created.map((r: any) => r.venueId).sort()).toEqual(['venue-1', 'venue-2', 'venue-3'])
      // Seat cap is checked for the whole set, excluding this invite's own pending row.
      expect(assertCanAddSeatsBulk).toHaveBeenCalledWith(['venue-1', 'venue-2', 'venue-3'], {
        primaryVenueId: 'venue-1',
        excludeInvitationId: 'inv-1',
      })
    })

    it('grants only the invitation venue without the flag (regression)', async () => {
      await loginWithGoogle('id-token', false)

      const created = txStaffVenueCreateMany.mock.calls[0][0].data
      expect(created).toHaveLength(1)
      expect(created[0]).toMatchObject({ venueId: 'venue-1', role: StaffRole.WAITER, active: true })
    })
  })

  describe('requirePin', () => {
    it('does NOT auto-accept — a PIN cannot be captured in an OAuth redirect', async () => {
      state.invitation = buildInvitation({ requirePin: true })
      state.staffAfterCreate = buildStaffAfterCreate([]) // no venue granted
      state.pendingInvitations = [
        {
          id: 'inv-1',
          token: 'invite-token',
          role: StaffRole.WAITER,
          venue: { id: 'venue-1', name: 'Main Venue' },
          organization: { id: 'org-1', name: 'Test Org' },
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      ]

      const result = await loginWithGoogle('id-token', false)

      // Account created so the person can get in...
      expect(txStaffCreate).toHaveBeenCalled()
      // ...but the invitation is untouched and no venue was granted.
      expect(txInvitationUpdate).not.toHaveBeenCalled()
      expect(txStaffVenueCreateMany).not.toHaveBeenCalled()
      expect(assertCanAddSeatsBulk).not.toHaveBeenCalled()

      // It comes back as pending so the frontend routes them to /invite/:token to enter the PIN.
      expect(result.pendingInvitations).toHaveLength(1)
      expect(result.pendingInvitations?.[0].token).toBe('invite-token')
      expect(logAction).not.toHaveBeenCalled()
    })

    it('auto-accepts when no PIN is required (regression)', async () => {
      await loginWithGoogle('id-token', false)

      expect(txInvitationUpdate).toHaveBeenCalled()
      expect(txStaffVenueCreateMany).toHaveBeenCalled()
    })
  })

  describe('audit trail', () => {
    it('stamps acceptedById on the invitation', async () => {
      await loginWithGoogle('id-token', false)

      expect(txInvitationUpdate).toHaveBeenCalledWith({
        where: { id: 'inv-1' },
        data: expect.objectContaining({
          status: InvitationStatus.ACCEPTED,
          acceptedById: 'new-staff-1',
        }),
      })
    })

    it('writes an ActivityLog row so the owner audit screen can see the accept', async () => {
      await loginWithGoogle('id-token', false)

      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'INVITATION_ACCEPTED',
          entity: 'Invitation',
          entityId: 'inv-1',
          staffId: 'new-staff-1',
          venueId: 'venue-1',
          data: expect.objectContaining({ via: 'GOOGLE_OAUTH', role: StaffRole.WAITER }),
        }),
      )
    })
  })

  describe('atomicity', () => {
    it('creates staff, org membership, venues and the accept inside ONE transaction', async () => {
      await loginWithGoogle('id-token', false)

      expect(transactionRuns).toHaveBeenCalledTimes(1)
      // All four writes went through the tx client, not the global one.
      expect(txStaffCreate).toHaveBeenCalledTimes(1)
      expect(txStaffOrganizationCreate).toHaveBeenCalledTimes(1)
      expect(txStaffVenueCreateMany).toHaveBeenCalledTimes(1)
      expect(txInvitationUpdate).toHaveBeenCalledTimes(1)
    })

    it('normalizes the Google email to lowercase before creating the account', async () => {
      await loginWithGoogle('id-token', false)

      expect(txStaffCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ email: 'invited@test.com' }) }))
    })
  })

  describe('regressions on the non-invitation paths', () => {
    it('rejects a Google sign-in with no account and no invitation', async () => {
      state.invitation = null

      await expect(loginWithGoogle('id-token', false)).rejects.toThrow(/No invitation found/i)
      expect(txStaffCreate).not.toHaveBeenCalled()
    })

    it('logs an existing staff member in without touching any invitation', async () => {
      state.existingStaff = buildStaffAfterCreate(['venue-1'])

      const result = await loginWithGoogle('id-token', false)

      expect(result.isNewUser).toBe(false)
      expect(result.accessToken).toBe('access-token')
      expect(transactionRuns).not.toHaveBeenCalled()
      expect(txInvitationUpdate).not.toHaveBeenCalled()
      // This used to assert `logAction` was never called, which only meant "no invitation
      // was touched" for as long as a plain login wrote nothing. A sign-in now DOES leave a
      // row (the access log), so the assertion has to say what it actually means: that no
      // invitation acceptance was recorded.
      expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'INVITATION_ACCEPTED' }))
      expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_LOGIN', staffId: 'new-staff-1' }))
    })
  })
})
