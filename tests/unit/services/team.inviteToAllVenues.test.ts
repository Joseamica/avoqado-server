/**
 * Tests for "Invite to All Venues" feature
 *
 * When inviting someone as OWNER with inviteToAllVenues=true:
 * 1. Creates StaffVenue for ALL venues in the organization
 * 2. Sets OrgRole.OWNER in StaffOrganization
 * 3. Works for both TPV-only and email invitations
 */

import { StaffRole, OrgRole, InvitationStatus } from '@prisma/client'
import { prismaMock } from '../../__helpers__/setup'

// Additional mocks
jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: {
    sendTeamInvitation: jest.fn().mockResolvedValue(true),
  },
}))
jest.mock('../../../src/services/dashboard/venueRoleConfig.dashboard.service', () => ({
  getRoleDisplayName: jest.fn().mockResolvedValue('Socio'),
}))

import { inviteTeamMember } from '../../../src/services/dashboard/team.dashboard.service'

describe('Invite to All Venues Feature', () => {
  const mockOrganizationId = 'org-123'
  const mockVenueId = 'venue-1'
  const mockInviterStaffId = 'inviter-123'

  const mockVenue = {
    id: mockVenueId,
    slug: 'test-venue',
    name: 'Test Venue',
    organizationId: mockOrganizationId,
    organization: {
      id: mockOrganizationId,
      name: 'Test Organization',
    },
  }

  const mockInviter = {
    firstName: 'Admin',
    lastName: 'User',
  }

  const mockAllVenues = [{ id: 'venue-1' }, { id: 'venue-2' }, { id: 'venue-3' }]

  beforeEach(() => {
    jest.clearAllMocks()

    // Setup common mocks
    prismaMock.venue.findUnique.mockResolvedValue(mockVenue as any)
    prismaMock.staff.findUnique.mockResolvedValue(mockInviter as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.invitation.findFirst.mockResolvedValue(null)
    prismaMock.venue.findMany.mockResolvedValue(mockAllVenues as any)
    prismaMock.invitation.create.mockResolvedValue({
      id: 'inv-123',
      email: 'test@example.com',
      role: StaffRole.OWNER,
      status: InvitationStatus.PENDING,
      expiresAt: new Date(),
      createdAt: new Date(),
    } as any)
    prismaMock.staff.create.mockResolvedValue({
      id: 'staff-new',
      email: 'test@example.com',
    } as any)
    prismaMock.staffOrganization.upsert.mockResolvedValue({} as any)
    prismaMock.staffOrganization.create.mockResolvedValue({} as any)
    prismaMock.staffVenue.upsert.mockResolvedValue({} as any)
    prismaMock.invitation.update.mockResolvedValue({} as any)
  })

  describe('TPV-only invitation with inviteToAllVenues', () => {
    it('should create StaffVenue for all venues when inviteToAllVenues is true', async () => {
      await inviteTeamMember(mockVenueId, mockInviterStaffId, {
        firstName: 'Partner',
        lastName: 'User',
        role: StaffRole.OWNER,
        type: 'tpv-only',
        pin: '1234',
        inviteToAllVenues: true,
      })

      // Should fetch all venues in organization
      expect(prismaMock.venue.findMany).toHaveBeenCalledWith({
        where: { organizationId: mockOrganizationId },
        select: { id: true },
      })

      // Should create StaffVenue for each venue (3 venues)
      expect(prismaMock.staffVenue.upsert).toHaveBeenCalledTimes(3)
    })

    it('should set OrgRole.OWNER when inviting as OWNER role', async () => {
      await inviteTeamMember(mockVenueId, mockInviterStaffId, {
        firstName: 'Partner',
        lastName: 'User',
        role: StaffRole.OWNER,
        type: 'tpv-only',
        pin: '1234',
        inviteToAllVenues: true,
      })

      // Should create StaffOrganization with OWNER role
      expect(prismaMock.staffOrganization.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            role: OrgRole.OWNER,
          }),
          update: expect.objectContaining({
            role: OrgRole.OWNER,
          }),
        }),
      )
    })

    it('should only create StaffVenue for primary venue when inviteToAllVenues is false', async () => {
      await inviteTeamMember(mockVenueId, mockInviterStaffId, {
        firstName: 'Regular',
        lastName: 'Staff',
        role: StaffRole.ADMIN,
        type: 'tpv-only',
        pin: '1234',
        inviteToAllVenues: false,
      })

      // Should NOT fetch all venues
      expect(prismaMock.venue.findMany).not.toHaveBeenCalled()

      // Should only create StaffVenue for primary venue
      expect(prismaMock.staffVenue.upsert).toHaveBeenCalledTimes(1)
    })

    it('should ignore inviteToAllVenues for non-OWNER roles', async () => {
      await inviteTeamMember(mockVenueId, mockInviterStaffId, {
        firstName: 'Admin',
        lastName: 'Staff',
        role: StaffRole.ADMIN, // Not OWNER
        type: 'tpv-only',
        pin: '1234',
        inviteToAllVenues: true, // Should be ignored
      })

      // Should NOT fetch all venues (inviteToAllVenues ignored for non-OWNER)
      expect(prismaMock.venue.findMany).not.toHaveBeenCalled()

      // Should only create StaffVenue for primary venue
      expect(prismaMock.staffVenue.upsert).toHaveBeenCalledTimes(1)
    })
  })

  describe('Email invitation with inviteToAllVenues', () => {
    it('should store inviteToAllVenues flag in permissions JSON', async () => {
      prismaMock.staff.findUnique
        .mockResolvedValueOnce(mockInviter as any) // inviter lookup
        .mockResolvedValueOnce(null) // no existing staff with this email

      await inviteTeamMember(mockVenueId, mockInviterStaffId, {
        email: 'partner@example.com',
        firstName: 'Partner',
        lastName: 'User',
        role: StaffRole.OWNER,
        type: 'email',
        inviteToAllVenues: true,
      })

      // Should create invitation with permissions containing inviteToAllVenues
      expect(prismaMock.invitation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'partner@example.com',
          role: StaffRole.OWNER,
          permissions: { inviteToAllVenues: true },
        }),
      })
    })

    it('should NOT store permissions when inviteToAllVenues is false or non-OWNER role', async () => {
      prismaMock.staff.findUnique.mockResolvedValueOnce(mockInviter as any).mockResolvedValueOnce(null)

      await inviteTeamMember(mockVenueId, mockInviterStaffId, {
        email: 'admin@example.com',
        firstName: 'Admin',
        lastName: 'User',
        role: StaffRole.ADMIN,
        type: 'email',
        inviteToAllVenues: false,
      })

      // Should create invitation without permissions
      expect(prismaMock.invitation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          permissions: undefined,
        }),
      })
    })
  })
})
