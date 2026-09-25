/** El controlador pasa al servicio QUIÉN tiene la sesión (o nadie): es lo que protege la cuenta sin contraseña. */
const aceptar = jest.fn()
jest.mock('../../../src/services/invitation.service', () => ({ acceptInvitation: (...a: unknown[]) => aceptar(...a) }))

import { acceptInvitation } from '../../../src/controllers/invitation.controller'

function llamar(authContext?: { userId: string }) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
  const req = { params: { token: 'tok' }, body: { password: 'Algo1234' }, authContext } as never
  return acceptInvitation(req, res as never, jest.fn())
}

beforeEach(() => aceptar.mockReset().mockResolvedValue({ user: { id: 'u' }, tokens: {} }))

it('con sesión: el servicio recibe el staff de la sesión', async () => {
  await llamar({ userId: 'staff-9' })
  expect(aceptar).toHaveBeenCalledWith('tok', expect.objectContaining({ password: 'Algo1234' }), { sesionStaffId: 'staff-9' })
})

it('sin sesión: el servicio recibe sesionStaffId vacío (anónimo)', async () => {
  await llamar()
  expect(aceptar).toHaveBeenCalledWith('tok', expect.anything(), { sesionStaffId: undefined })
})
