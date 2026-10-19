/**
 * Cambiar la contraseña también tiene que cerrar las `Session` NUEVAS (T1-T6),
 * no sólo mover `lastPasswordReset`.
 *
 * Antes de esto, un token que trae `sid` (los que emite el login móvil desde
 * la Task 6) sobrevivía al cambio de contraseña por un camino distinto del que
 * ya cazaba `passwordChangeGuard`: el refresco vuelve a comparar `iat` contra
 * `lastPasswordReset` y rechaza — pero la fila `Session` que ese `sid` señala
 * se quedaba con `revokedAt: null`, así que el corte viejo y las Session
 * nuevas dejaban de decir lo mismo. Esta es la pieza que los sincroniza:
 * quien cierra sesión por cambio de contraseña también revoca sus `Session`
 * vivas y tumba su caché, para que otra instancia dejara de servir "viva"
 * dentro de la ventana de TTL de `sessionCache` (ver `sessionCache.ts`).
 *
 * Best-effort a propósito: el corte viejo (`lastPasswordReset`) YA protege en
 * cada request, síncronamente. Esto es defensa en profundidad para las
 * Session con `sid` — un tropiezo aquí no puede bloquear el cambio de
 * contraseña en sí.
 */
import prisma from '@/utils/prismaClient'
import { cerrarSesionesNuevasPorCambioDeContrasena } from '@/utils/passwordChangeGuard'
import * as sessionService from '@/services/auth/session.service'
import * as sessionCache from '@/services/auth/sessionCache'
import logger from '@/config/logger'

jest.mock('@/services/auth/session.service')
jest.mock('@/services/auth/sessionCache')

const prismaMock = prisma as any

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.session.findMany.mockReset()
  ;(sessionService.revokeAllSessionsForStaff as jest.Mock).mockResolvedValue(0)
  ;(sessionCache.invalidateSession as jest.Mock).mockResolvedValue(undefined)
})

describe('cerrarSesionesNuevasPorCambioDeContrasena', () => {
  it('🔴 revoca las Session del staff con el motivo password_changed', async () => {
    prismaMock.session.findMany.mockResolvedValue([])

    await cerrarSesionesNuevasPorCambioDeContrasena('staff_1')

    expect(sessionService.revokeAllSessionsForStaff).toHaveBeenCalledWith('staff_1', 'password_changed')
  })

  it('🔴 invalida la caché de CADA Session que estaba viva, para que otra instancia no la sirva hasta el TTL', async () => {
    prismaMock.session.findMany.mockResolvedValue([{ id: 'sess_1' }, { id: 'sess_2' }])

    await cerrarSesionesNuevasPorCambioDeContrasena('staff_1')

    expect(sessionCache.invalidateSession).toHaveBeenCalledWith('sess_1')
    expect(sessionCache.invalidateSession).toHaveBeenCalledWith('sess_2')
    expect(sessionCache.invalidateSession).toHaveBeenCalledTimes(2)
  })

  it('limpia sólo lo que cerró ESTA llamada (su motivo, desde que empezó) — no reinvalida lo que ya estaba cerrado', async () => {
    prismaMock.session.findMany.mockResolvedValue([])
    const antes = Date.now()

    await cerrarSesionesNuevasPorCambioDeContrasena('staff_1')

    const args = prismaMock.session.findMany.mock.calls.at(-1)![0]
    expect(args.where).toEqual({ staffId: 'staff_1', revokedReason: 'password_changed', revokedAt: { gte: expect.any(Date) } })
    expect(args.where.revokedAt.gte.getTime()).toBeGreaterThanOrEqual(antes)
  })

  it('invalida la caché DESPUÉS de que el revoke ya comprometió el cambio en la base', async () => {
    const orden: string[] = []
    prismaMock.session.findMany.mockResolvedValue([{ id: 'sess_1' }])
    ;(sessionService.revokeAllSessionsForStaff as jest.Mock).mockImplementation(async () => {
      orden.push('revoke')
      return 1
    })
    ;(sessionCache.invalidateSession as jest.Mock).mockImplementation(async () => {
      orden.push('invalidate')
    })

    await cerrarSesionesNuevasPorCambioDeContrasena('staff_1')

    expect(orden).toEqual(['revoke', 'invalidate'])
  })

  it('🔴 no revienta el cambio de contraseña si session.service truena (best-effort)', async () => {
    prismaMock.session.findMany.mockResolvedValue([{ id: 'sess_1' }])
    ;(sessionService.revokeAllSessionsForStaff as jest.Mock).mockRejectedValue(new Error('db down'))

    await expect(cerrarSesionesNuevasPorCambioDeContrasena('staff_1')).resolves.toBeUndefined()
  })

  it('no revienta el cambio de contraseña si invalidar la caché truena (best-effort)', async () => {
    prismaMock.session.findMany.mockResolvedValue([{ id: 'sess_1' }])
    ;(sessionCache.invalidateSession as jest.Mock).mockRejectedValue(new Error('redis down'))

    await expect(cerrarSesionesNuevasPorCambioDeContrasena('staff_1')).resolves.toBeUndefined()
  })

  it('no revienta si leer las Session cerradas truena (best-effort): el cierre en la base ya ocurrió', async () => {
    prismaMock.session.findMany.mockRejectedValue(new Error('db down'))

    await expect(cerrarSesionesNuevasPorCambioDeContrasena('staff_1')).resolves.toBeUndefined()
    expect(sessionService.revokeAllSessionsForStaff).toHaveBeenCalledWith('staff_1', 'password_changed')
  })
})

/**
 * «Cerrar todas» no se rinde (19-oct): el cierre de las filas Session es lo único que mata un token con `sid` emitido
 * dentro del margen de 5 s anterior al corte. Un tropiezo de conexión de la base ya no lo deja a medias en silencio.
 */
describe('cerrarSesionesDeStaff ante un tropiezo de la base', () => {
  const tropiezo = () => Object.assign(new Error("Can't reach database server"), { code: 'P1001' })

  it('🔴 si cerrar tropieza una vez, lo reintenta y limpia la caché de lo que cerró', async () => {
    ;(sessionService.revokeAllSessionsForStaff as jest.Mock).mockRejectedValueOnce(tropiezo()).mockResolvedValueOnce(1)
    prismaMock.session.findMany.mockResolvedValue([{ id: 'sess_1' }])

    await cerrarSesionesNuevasPorCambioDeContrasena('staff_1')

    expect(sessionService.revokeAllSessionsForStaff).toHaveBeenCalledTimes(2)
    expect(sessionCache.invalidateSession).toHaveBeenCalledWith('sess_1')
  })

  it('🔴 si la base ya cerró y lo que tropieza es la lectura, la vuelta siguiente igual limpia esas sesiones', async () => {
    // 1.ª vuelta: el UPDATE sí se aplicó, pero leer lo cerrado tropieza. 2.ª: el UPDATE ya no alcanza nada (0) y la
    // lectura de «cerradas por esta llamada» sí las trae.
    ;(sessionService.revokeAllSessionsForStaff as jest.Mock).mockResolvedValueOnce(2).mockResolvedValueOnce(0)
    prismaMock.session.findMany.mockRejectedValueOnce(tropiezo()).mockResolvedValueOnce([{ id: 'sess_1' }, { id: 'sess_2' }])

    await cerrarSesionesNuevasPorCambioDeContrasena('staff_1')

    expect(sessionCache.invalidateSession).toHaveBeenCalledWith('sess_1')
    expect(sessionCache.invalidateSession).toHaveBeenCalledWith('sess_2')
  })

  it('🔴 una sesión que nació a media operación (el UPDATE la cerró sin que nadie la leyera antes) también se limpia', async () => {
    // Lo que se lee es lo que cerró ESTA llamada, después de cerrar: B entra aunque no existía al empezar.
    prismaMock.session.findMany.mockResolvedValue([{ id: 'sess_A' }, { id: 'sess_B' }])

    await cerrarSesionesNuevasPorCambioDeContrasena('staff_1')

    expect(sessionCache.invalidateSession).toHaveBeenCalledWith('sess_B')
    expect(prismaMock.session.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      (sessionService.revokeAllSessionsForStaff as jest.Mock).mock.invocationCallOrder[0],
    )
  })

  it('si la base sigue caída, no revienta y deja un ERROR visible con el motivo (no un aviso)', async () => {
    const error = jest.spyOn(logger, 'error')
    ;(sessionService.revokeAllSessionsForStaff as jest.Mock).mockRejectedValue(tropiezo())

    await expect(cerrarSesionesNuevasPorCambioDeContrasena('staff_1')).resolves.toBeUndefined()

    expect(sessionService.revokeAllSessionsForStaff).toHaveBeenCalledTimes(3) // 1 + 2 reintentos
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('No se pudieron cerrar'),
      expect.objectContaining({ staffId: 'staff_1', motivo: 'password_changed' }),
    )
    expect(sessionCache.invalidateSession).not.toHaveBeenCalled()
    error.mockRestore()
  })
})
