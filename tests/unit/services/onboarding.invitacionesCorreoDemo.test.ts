/**
 * hz:f26b3afc:D4 (Codex r1 y r2) — El alta da la membresía de la organización ANTES de que la invitación se acepte: si un
 * invitado era el correo de un usuario demo (contraseña pública), cualquiera entraba al negocio real. El alta salta ese
 * correo, como ya salta un rol inválido, y sigue con los demás.
 */
import { StaffRole } from '@prisma/client'
import { prismaMock } from '../../__helpers__/setup'

const mockEnviar = jest.fn(async () => true)
jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendTeamInvitation: (...a: unknown[]) => mockEnviar(...(a as [])) },
}))

import { processTeamInvites } from '../../../src/services/onboarding/venueCreation.service'

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.staff.findUnique.mockImplementation((async (args: any) => {
    if (args.where?.id === 'inviter-1') return { firstName: 'Dueña', lastName: 'Real' }
    if (args.where?.email === 'bloom@demo.avoqado.io') return { id: 'staff-bloom', email: 'bloom@demo.avoqado.io' }
    return null
  }) as never)
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
  prismaMock.invitation.findFirst.mockResolvedValue(null)
  prismaMock.invitation.create.mockImplementation((async (args: any) => ({ id: 'inv', token: 't', ...args.data })) as never)
  prismaMock.staff.create.mockImplementation((async (args: any) => ({ id: 'staff-nuevo', ...args.data })) as never)
  prismaMock.staffOrganization.upsert.mockResolvedValue({} as never)
})

it('🔴 el correo de un usuario demo no se invita ni recibe membresía; los demás sí', async () => {
  await processTeamInvites(
    'venue-real',
    'org-real',
    'inviter-1',
    [
      { email: 'Bloom@Demo.Avoqado.io', firstName: 'X', lastName: 'Y', role: StaffRole.OWNER },
      { email: 'ana@negocio.mx', firstName: 'Ana', lastName: 'Ruiz', role: StaffRole.WAITER },
    ],
    'Negocio real',
    'Org real',
  )

  const correosInvitados = prismaMock.invitation.create.mock.calls.map(([a]: any) => a.data.email)
  expect(correosInvitados).toEqual(['ana@negocio.mx'])
  expect(prismaMock.staffOrganization.upsert).not.toHaveBeenCalledWith(
    expect.objectContaining({ where: { staffId_organizationId: expect.objectContaining({ staffId: 'staff-bloom' }) } }),
  )
  expect(mockEnviar).toHaveBeenCalledTimes(1)
})
