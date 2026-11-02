/**
 * hz:f26b3afc:D4 — No se puede invitar a un negocio a un correo de usuario demo (`@demo.avoqado.io`): su contraseña es
 * pública. El dueño recibe la razón en vez de una invitación que nunca va a poder usarse.
 */
import { StaffRole } from '@prisma/client'
import { prismaMock } from '../../__helpers__/setup'

jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendTeamInvitation: jest.fn().mockResolvedValue(true) },
}))
jest.mock('../../../src/services/dashboard/venueRoleConfig.dashboard.service', () => ({
  getRoleDisplayName: jest.fn().mockResolvedValue('Mesero'),
}))

import { inviteTeamMember } from '../../../src/services/dashboard/team.dashboard.service'

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'venue-real',
    slug: 'testarudo',
    name: 'Testarudo',
    organizationId: 'org-1',
    organization: { id: 'org-1', name: 'Org' },
  } as any)
  prismaMock.staff.findUnique.mockResolvedValue({ firstName: 'Dueña', lastName: 'Real' } as any)
  prismaMock.invitation.findFirst.mockResolvedValue(null)
})

it.each(['bloom@demo.avoqado.io', '  Lunaria@DEMO.avoqado.io '])('🔴 invitar a %s se rechaza y no se crea la invitación', async email => {
  await expect(
    inviteTeamMember('venue-real', 'inviter-1', { email, firstName: 'X', lastName: 'Y', role: StaffRole.WAITER }),
  ).rejects.toMatchObject({ statusCode: 400 })
  expect(prismaMock.invitation.create).not.toHaveBeenCalled()
})
