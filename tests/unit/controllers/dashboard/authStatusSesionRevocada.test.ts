/**
 * hz:f26b3afc:D2 — `/auth/status` no lleva `authenticateTokenMiddleware` (revisa el token él mismo), y sólo aplicaba el
 * corte por persona (`motivoDeSesionInvalidada`), no la sesión del token (`sid`). Al cerrar a la fuerza UNA sesión, el
 * middleware contestaba 401 en cada ruta de datos y `/auth/status` seguía diciendo `authenticated: true`: el panel
 * mandaba al inicio, los datos daban 401, volvía al login y el status lo regresaba al inicio, en ciclo. Aquí el status
 * dice lo mismo que el middleware: sesión cerrada ⇒ no autenticado, y se borra la cookie.
 */
const staffMock = { findUnique: jest.fn() }
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { staff: staffMock } }))
jest.mock('@/utils/passwordChangeGuard', () => ({
  motivoDeSesionInvalidada: jest.fn(async () => null),
  mensajeDeCorte: jest.requireActual('@/utils/passwordChangeGuard').mensajeDeCorte,
}))
jest.mock('@/services/auth/sessionCache', () => ({ isSessionAliveCached: jest.fn() }))
jest.mock('@/utils/tokenRevocation', () => ({ isJtiRevoked: jest.fn(async () => false) }))

import { StaffRole } from '@prisma/client'
import { generateAccessToken } from '@/jwt.service'
import { isSessionAliveCached } from '@/services/auth/sessionCache'
import { isJtiRevoked } from '@/utils/tokenRevocation'
import { getAuthStatus } from '@/controllers/dashboard/auth.dashboard.controller'

const sesionViva = isSessionAliveCached as jest.Mock
const SID = 'csesion00000000000000000a'

function fakeResponse() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  res.clearCookie = jest.fn().mockReturnValue(res)
  return res
}

const token = (sid?: string) => generateAccessToken('staff-1', 'org-1', 'venue-1', StaffRole.OWNER, false, sid ? { sid } : undefined)
const request = (t: string) => ({ cookies: { accessToken: t } }) as never

beforeEach(() => {
  jest.clearAllMocks()
  staffMock.findUnique.mockResolvedValue({ id: 'staff-1', organizations: [], venues: [] })
})

it('🔴 sesión cerrada a la fuerza: no autenticado, sin buscar a la persona, y se borra la cookie', async () => {
  sesionViva.mockResolvedValue(false)
  const res = fakeResponse()

  await getAuthStatus(request(token(SID)), res)

  expect(sesionViva).toHaveBeenCalledWith(SID)
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ authenticated: false, user: null }))
  expect(res.clearCookie).toHaveBeenCalledWith('accessToken')
  expect(staffMock.findUnique).not.toHaveBeenCalled()
})

it('🔴 token revocado por su jti (p. ej. al empezar una suplantación): no autenticado (Codex r1)', async () => {
  sesionViva.mockResolvedValue(true)
  ;(isJtiRevoked as jest.Mock).mockResolvedValueOnce(true)
  const res = fakeResponse()

  await getAuthStatus(request(token(SID)), res)

  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ authenticated: false, user: null }))
  expect(staffMock.findUnique).not.toHaveBeenCalled()
})

it('🔴 fase 4 (tokens sin sesión retirados): no autenticado, igual que el middleware', async () => {
  const antes = process.env.AUTH_LEGACY_TOKEN_PHASE
  process.env.AUTH_LEGACY_TOKEN_PHASE = '4'
  try {
    const res = fakeResponse()
    await getAuthStatus(request(token()), res)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ authenticated: false, user: null }))
    expect(staffMock.findUnique).not.toHaveBeenCalled()
  } finally {
    if (antes === undefined) delete process.env.AUTH_LEGACY_TOKEN_PHASE
    else process.env.AUTH_LEGACY_TOKEN_PHASE = antes
  }
})

it('regresión: con la sesión viva, el flujo sigue a buscar a la persona', async () => {
  sesionViva.mockResolvedValue(true)
  const res = fakeResponse()

  await getAuthStatus(request(token(SID)), res)

  expect(staffMock.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'staff-1' } }))
})

it('regresión: un token sin sesión (de antes del cambio) no pregunta por ella', async () => {
  const res = fakeResponse()

  await getAuthStatus(request(token()), res)

  expect(sesionViva).not.toHaveBeenCalled()
  expect(staffMock.findUnique).toHaveBeenCalled()
})
