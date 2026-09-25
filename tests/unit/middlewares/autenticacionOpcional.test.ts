/**
 * `autenticacionOpcional`: identifica a quien trae sesión válida y deja pasar como anónimo a todos
 * los demás — nunca responde por su cuenta. Es lo que usa aceptar una invitación para saber si la
 * cuenta sin contraseña la está aceptando su propia dueña.
 */
const autenticar = jest.fn()
jest.mock('../../../src/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (...a: unknown[]) => autenticar(...a),
  extraerToken: (req: { cookies?: { accessToken?: string } }) => req.cookies?.accessToken,
}))

import { autenticacionOpcional } from '../../../src/middlewares/autenticacionOpcional.middleware'

function correr(req: Record<string, unknown>) {
  const res = { status: jest.fn(), json: jest.fn(), clearCookie: jest.fn() }
  const next = jest.fn()
  return autenticacionOpcional(req as never, res as never, next).then(() => ({ res, next }))
}

beforeEach(() => autenticar.mockReset())

it('sin token: pasa como anónimo y ni siquiera intenta autenticar', async () => {
  const req: Record<string, unknown> = { cookies: {} }
  const { next } = await correr(req)
  expect(autenticar).not.toHaveBeenCalled()
  expect(next).toHaveBeenCalledWith()
  expect(req.authContext).toBeUndefined()
})

it('con sesión válida: deja el authContext de ESA persona', async () => {
  autenticar.mockImplementation(async (req: any, _res: unknown, next: () => void) => {
    req.authContext = { userId: 'staff-1' }
    next()
  })
  const req: Record<string, unknown> = { cookies: { accessToken: 't' } }
  const { next } = await correr(req)
  expect(req.authContext).toEqual({ userId: 'staff-1' })
  expect(next).toHaveBeenCalledWith()
})

it('🔴 sesión rechazada (vencida, revocada): sigue como anónimo, sin 401 y sin borrar la cookie', async () => {
  autenticar.mockImplementation(async (_req: unknown, res: any) => {
    res.clearCookie('accessToken')
    res.status(401).json({ error: 'Unauthorized' })
  })
  const req: Record<string, unknown> = { cookies: { accessToken: 'vencido' } }
  const { res, next } = await correr(req)
  expect(req.authContext).toBeUndefined()
  expect(res.status).not.toHaveBeenCalled()
  expect(res.clearCookie).not.toHaveBeenCalled()
  expect(next).toHaveBeenCalledWith()
})

it('🔴 si el middleware real pasa un error, no queda authContext a medias', async () => {
  autenticar.mockImplementation(async (req: any, _res: unknown, next: (e?: unknown) => void) => {
    req.authContext = { userId: 'a-medias' }
    next(new Error('Sesión cerrada'))
  })
  const req: Record<string, unknown> = { cookies: { accessToken: 't' } }
  const { next } = await correr(req)
  expect(req.authContext).toBeUndefined()
  expect(next).toHaveBeenCalledWith()
})
