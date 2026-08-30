/**
 * 🔴 [Auditoría de Codex, 2026-08-30, P1] Cerrar sesión en el dashboard tiene que REVOCAR la
 * `Session` que el token nombra.
 *
 * El defecto es mío y es de los que sólo existen a medias: al darle sesiones revocables al
 * dashboard (Parte A) le puse el claim `sid` al token del login, pero no toqué el logout. O sea
 * que construí la maquinaria para revocar y dejé el botón desconectado — «cerrar sesión» borraba
 * la cookie del navegador y el token seguía siendo válido hasta 24 h (30 días con «recuérdame»).
 * Quien tuviera una copia —una laptop compartida, un token pegado en un ticket de soporte— seguía
 * dentro después de que el dueño creyera haber salido.
 *
 * 🔑 La lección, que vale más que el arreglo: **añadir el mecanismo de revocación no revoca
 * nada.** Cada carril que EMITE una sesión tiene que tener su contraparte que la CIERRA, y hay
 * que enumerarlos a mano — el compilador no sabe que falta uno.
 */
import { StaffRole } from '@prisma/client'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/auth/session.service')
jest.mock('@/services/auth/sessionCache')
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { disconnectBySession: jest.fn() },
}))
jest.mock('@/utils/passwordChangeGuard', () => ({
  ...jest.requireActual('@/utils/passwordChangeGuard'),
  revokeAllSessions: jest.fn().mockResolvedValue(new Date()),
  cerrarSesionesDeStaff: jest.fn().mockResolvedValue(undefined),
}))

import { generateAccessToken } from '@/jwt.service'
import { revokeSession } from '@/services/auth/session.service'
import { invalidateSession } from '@/services/auth/sessionCache'
import socketManager from '@/communication/sockets/managers/socketManager'
import { cerrarSesionesDeStaff } from '@/utils/passwordChangeGuard'
import { dashboardLogoutController } from '@/controllers/dashboard/auth.dashboard.controller'

const fakeResponse = () => {
  const r: Record<string, unknown> = {}
  r.clearCookie = jest.fn().mockReturnValue(r)
  r.status = jest.fn().mockReturnValue(r)
  r.json = jest.fn().mockReturnValue(r)
  return r as never
}

const pedir = (token: string, body: Record<string, unknown> = {}) =>
  ({ cookies: { accessToken: token }, headers: {}, body, ip: '127.0.0.1', get: () => undefined }) as never

beforeEach(() => {
  jest.clearAllMocks()
  ;(revokeSession as jest.Mock).mockResolvedValue(1)
})

it('🔴 [P1] cerrar sesión REVOCA la Session del token — antes seguía viva hasta 24 h', async () => {
  const token = generateAccessToken('staff-1', 'org-1', 'venue-1', StaffRole.ADMIN, undefined, { sid: 'sess_web' })

  await dashboardLogoutController(pedir(token), fakeResponse())

  expect(revokeSession).toHaveBeenCalledWith('sess_web', expect.stringContaining('logout'))
})

it('🔴 invalida la caché y cierra el socket — revocar sin esto la deja viva 60 s más', async () => {
  // Mismo defecto que ya se midió EN VIVO en el relevo por PIN: `revokeSession` escribe en la
  // base, pero el middleware pregunta a una caché de 60 s, y el socket ya abierto vive aparte.
  const token = generateAccessToken('staff-1', 'org-1', 'venue-1', StaffRole.ADMIN, undefined, { sid: 'sess_web' })

  await dashboardLogoutController(pedir(token), fakeResponse())

  expect(invalidateSession).toHaveBeenCalledWith('sess_web')
  expect(socketManager.disconnectBySession).toHaveBeenCalledWith('sess_web')
})

it('«en todos mis dispositivos» cierra también las filas Session, no sólo la marca del Staff', async () => {
  // `revokeAllSessions` sólo escribe `Staff.sessionsRevokedAt`. Ese corte sí mata el acceso HTTP,
  // pero la revalidación de sockets consulta las filas `Session`: sin cerrarlas, la pantalla que
  // acabas de expulsar sigue recibiendo los eventos del negocio en tiempo real.
  const token = generateAccessToken('staff-1', 'org-1', 'venue-1', StaffRole.ADMIN, undefined, { sid: 'sess_web' })

  await dashboardLogoutController(pedir(token, { allDevices: true }), fakeResponse())

  expect(cerrarSesionesDeStaff).toHaveBeenCalledWith('staff-1', expect.stringContaining('logout'))
})

it('un token viejo SIN sid cierra sesión igual — nadie se queda encerrado por esto', async () => {
  // Los tokens emitidos antes de la Parte A no traen `sid`. Salir tiene que seguir funcionando:
  // fallar aquí dejaría a alguien sin poder cerrar sesión por una mejora de seguridad.
  const legacy = generateAccessToken('staff-2', 'org-1', 'venue-1', StaffRole.ADMIN)
  const res = fakeResponse()

  await dashboardLogoutController(pedir(legacy), res)

  expect(revokeSession).not.toHaveBeenCalled()
  expect(res.status).toHaveBeenCalledWith(200)
})

it('🔴 si la revocación truena, la persona SALE igual — el botón de salir no puede fallar', async () => {
  ;(revokeSession as jest.Mock).mockRejectedValue(new Error('Postgres caído'))
  const token = generateAccessToken('staff-1', 'org-1', 'venue-1', StaffRole.ADMIN, undefined, { sid: 'sess_web' })
  const res = fakeResponse()

  await dashboardLogoutController(pedir(token), res)

  expect(res.status).toHaveBeenCalledWith(200)
})
