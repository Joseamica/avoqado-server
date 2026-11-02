/**
 * H0 (28-oct-2026, Codex r1 #2): el alta ya puede terminarse sin el navegador (el cobro, el aviso de Stripe o el barrido).
 * Quien vuelve al panel con su cookie del alta (sucursal `pending`) y sin tocar «Entrar» se quedaba con esa sesión 24 h:
 * todo lo que lee la sucursal del token (conectar Google Calendar, `/dashboard/tokens/*`) fallaba. Ahora `/auth/status`
 * la renueva con la sucursal real, con la MISMA función que usa «Entrar».
 */
const staffMock = { findUnique: jest.fn() }
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { staff: staffMock } }))
jest.mock('@/utils/passwordChangeGuard', () => ({
  motivoDeSesionInvalidada: jest.fn().mockResolvedValue(null),
  mensajeDeCorte: jest.fn(),
}))
jest.mock('@/services/onboarding/sesionTrasElAlta', () => ({
  __esModule: true,
  sucursalDelAltaTerminada: jest.fn(),
  renovarSesionConLaSucursal: jest.fn().mockResolvedValue(undefined),
}))

import { StaffRole } from '@prisma/client'
import { generateAccessToken } from '@/jwt.service'
import { getAuthStatus } from '@/controllers/dashboard/auth.dashboard.controller'
import { renovarSesionConLaSucursal, sucursalDelAltaTerminada } from '@/services/onboarding/sesionTrasElAlta'

function fakeResponse() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  res.clearCookie = jest.fn().mockReturnValue(res)
  res.cookie = jest.fn().mockReturnValue(res)
  return res
}
const request = (token: string) => ({ cookies: { accessToken: token } }) as never

beforeEach(() => {
  jest.clearAllMocks()
  staffMock.findUnique.mockResolvedValue({ id: 'staff-1', email: 'ana@x.com', emailVerified: true, organizations: [], venues: [] })
})

describe('🔴 H0: /auth/status renueva la sesión del alta cuando el alta ya terminó', () => {
  it('token con sucursal pendiente y alta terminada → renueva con la sucursal real', async () => {
    ;(sucursalDelAltaTerminada as jest.Mock).mockResolvedValue('venue-9')
    const res = fakeResponse()

    await getAuthStatus(request(generateAccessToken('staff-1', 'org-1', 'pending', StaffRole.OWNER)), res)

    expect(sucursalDelAltaTerminada).toHaveBeenCalledWith('staff-1', 'org-1')
    expect(renovarSesionConLaSucursal).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'staff-1', orgId: 'org-1', venueId: 'pending' }),
      res,
      'venue-9',
    )
    // Lo de siempre sigue: el estado se arma igual.
    expect(staffMock.findUnique).toHaveBeenCalled()
  })

  it('alta todavía sin terminar → no renueva nada', async () => {
    ;(sucursalDelAltaTerminada as jest.Mock).mockResolvedValue(null)
    await getAuthStatus(request(generateAccessToken('staff-1', 'org-1', 'pending', StaffRole.OWNER)), fakeResponse())
    expect(renovarSesionConLaSucursal).not.toHaveBeenCalled()
  })

  it('una sesión con sucursal REAL no se toca ni se consulta', async () => {
    await getAuthStatus(request(generateAccessToken('staff-1', 'org-1', 'venue-1', StaffRole.OWNER)), fakeResponse())
    expect(sucursalDelAltaTerminada).not.toHaveBeenCalled()
    expect(renovarSesionConLaSucursal).not.toHaveBeenCalled()
  })

  it('si la consulta del alta falla, el estado de sesión responde igual (nunca se cae por esto)', async () => {
    ;(sucursalDelAltaTerminada as jest.Mock).mockRejectedValue(new Error('base caída'))
    const res = fakeResponse()
    await getAuthStatus(request(generateAccessToken('staff-1', 'org-1', 'pending', StaffRole.OWNER)), res)
    expect(renovarSesionConLaSucursal).not.toHaveBeenCalled()
    expect(staffMock.findUnique).toHaveBeenCalled()
  })
})
