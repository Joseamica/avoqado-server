/**
 * D3: una invitación al negocio interno del equipo de ventas (la fila `CrmTeam`) manda el correo del CRM; cualquier otra,
 * el de siempre. Se decide por el DATO (`CrmTeam.venueId`), nunca por el nombre ni el slug.
 */
import { InvitationStatus, StaffRole } from '@prisma/client'
import { prismaMock } from '../../__helpers__/setup'

const sendTeamInvitation = jest.fn().mockResolvedValue(true)
const sendCrmTeamInvitation = jest.fn().mockResolvedValue(true)
jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: {
    sendTeamInvitation: (...a: unknown[]) => sendTeamInvitation(...a),
    sendCrmTeamInvitation: (...a: unknown[]) => sendCrmTeamInvitation(...a),
  },
}))
jest.mock('../../../src/services/dashboard/venueRoleConfig.dashboard.service', () => ({
  getRoleDisplayName: jest.fn().mockResolvedValue('Observador'),
}))

import { inviteTeamMember } from '../../../src/services/dashboard/team.dashboard.service'

const VENUE = {
  id: 'venue-equipo',
  slug: 'avoqado-equipo-de-ventas',
  name: 'Avoqado · Equipo de ventas',
  organizationId: 'org-equipo',
  seatCapExempt: true,
  organization: { id: 'org-equipo', name: 'Avoqado · Equipo de ventas' },
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.SUPERADMIN_URL = 'https://superadmin.avoqado.io'
  process.env.FRONTEND_URL = 'https://dashboard.avoqado.io'
  prismaMock.venue.findUnique.mockResolvedValue(VENUE as any)
  prismaMock.staff.findUnique.mockResolvedValue({ firstName: 'Jose', lastName: 'Amieva' } as any)
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.invitation.findFirst.mockResolvedValue(null)
  prismaMock.invitation.create.mockResolvedValue({
    id: 'inv-rafa',
    token: 'tok-rafa',
    email: 'rafael@playtelecom.com',
    role: StaffRole.VIEWER,
    status: InvitationStatus.PENDING,
    expiresAt: new Date(),
    createdAt: new Date(),
  } as any)
  prismaMock.staff.create.mockResolvedValue({ id: 'staff-rafa', email: 'rafael@playtelecom.com' } as any)
  prismaMock.staffOrganization.create.mockResolvedValue({} as any)
})

const invitarARafa = () =>
  inviteTeamMember('venue-equipo', 'inviter-1', {
    email: 'rafael@playtelecom.com',
    firstName: 'Rafa',
    lastName: 'A',
    role: StaffRole.VIEWER,
  })

it('🔴 al negocio del equipo de ventas le manda el correo del CRM, con la liga al SUPERADMIN', async () => {
  prismaMock.crmTeam.findUnique.mockResolvedValue({ id: 'crm-team' } as any)

  await invitarARafa()

  expect(prismaMock.crmTeam.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'venue-equipo' } }))
  expect(sendCrmTeamInvitation).toHaveBeenCalledWith('rafael@playtelecom.com', {
    inviterName: 'Jose Amieva',
    crmUrl: 'https://superadmin.avoqado.io/login',
    inviteLink: 'https://dashboard.avoqado.io/invite/tok-rafa',
  })
  expect(sendTeamInvitation).not.toHaveBeenCalled()
})

it('a cualquier otro negocio le manda el correo de siempre (regresión)', async () => {
  prismaMock.crmTeam.findUnique.mockResolvedValue(null)

  await invitarARafa()

  expect(sendTeamInvitation).toHaveBeenCalledWith(
    'rafael@playtelecom.com',
    expect.objectContaining({ inviteLink: 'https://dashboard.avoqado.io/invite/tok-rafa' }),
  )
  expect(sendCrmTeamInvitation).not.toHaveBeenCalled()
})
