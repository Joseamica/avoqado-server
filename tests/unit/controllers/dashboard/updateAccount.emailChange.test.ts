/**
 * El perfil ya no cambia el correo al instante: pide el cambio (enlace al correo NUEVO) y lo avisa.
 * Cambiarlo al instante permitía ponerse el correo de otra persona (Codex gpt-6-astra, 24-sep).
 */
const solicitar = jest.fn()
jest.mock('../../../../src/services/dashboard/cambioDeCorreo.service', () => ({
  solicitarCambioDeCorreo: (...a: unknown[]) => solicitar(...a),
  confirmarCambioDeCorreo: jest.fn(),
}))

import prisma from '../../../../src/utils/prismaClient'
import { updateAccountController } from '../../../../src/controllers/dashboard/auth.dashboard.controller'

const p = prisma as any

function llamar(body: Record<string, unknown>) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
  const next = jest.fn()
  const req = { body, authContext: { userId: 'staff-1', venueId: 'v-1' } } as never
  return updateAccountController(req, res as never, next).then(() => ({ res, next }))
}

beforeEach(() => {
  jest.clearAllMocks()
  p.staff.findUnique
    .mockReset()
    .mockImplementation(({ where }: any) => (where.id ? Promise.resolve({ password: 'h', email: 'yo@test.mx' }) : Promise.resolve(null)))
  p.staff.update.mockReset().mockResolvedValue({ id: 'staff-1', email: 'yo@test.mx' })
  solicitar.mockResolvedValue({ correoNuevo: 'nuevo@test.mx' })
})

it('🔴 un correo nuevo NO se guarda: se pide el cambio y la respuesta lo dice', async () => {
  const { res } = await llamar({ email: 'Nuevo@test.mx', firstName: 'Ana' })
  expect(solicitar).toHaveBeenCalledWith('staff-1', 'Nuevo@test.mx')
  const data = p.staff.update.mock.calls[0][0].data
  expect(data).not.toHaveProperty('email')
  expect(data.firstName).toBe('Ana')
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ emailChangePending: 'nuevo@test.mx' }))
})

it('el mismo correo (aunque cambien mayúsculas) no pide nada', async () => {
  const { res } = await llamar({ email: 'YO@test.mx' })
  expect(solicitar).not.toHaveBeenCalled()
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ emailChangePending: null }))
})

it('un correo que ya usa otra persona se rechaza sin pedir nada (regresión)', async () => {
  p.staff.findUnique.mockImplementation(({ where }: any) =>
    where.id ? Promise.resolve({ password: 'h', email: 'yo@test.mx' }) : Promise.resolve({ id: 'otra' }),
  )
  const { res } = await llamar({ email: 'ocupado@test.mx' })
  expect(res.status).toHaveBeenCalledWith(400)
  expect(solicitar).not.toHaveBeenCalled()
})
