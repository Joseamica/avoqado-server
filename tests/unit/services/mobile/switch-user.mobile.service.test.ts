/**
 * Cambiar de usuario por PIN en el POS móvil.
 *
 * El flujo que pidió el founder (2026-08-29): «en lugar de que tenga que cerrar sesión, poner su
 * mail y contraseña otra vez, que esté un apartado Cambiar usuario, salga el pinpad, y así cambie
 * el usuario». Cerrar sesión con contraseña se queda como está.
 *
 * 🔴 Lo que hace segura esta operación NO es el PIN — son 4 dígitos. Es que el PIN sólo se acepta
 * ENCIMA de una sesión ya abierta en ese aparato, y esa sesión nació de un login con contraseña.
 * En una tablet donde nadie entró nunca, este endpoint no tiene sesión sobre la cual operar.
 *
 * 🔑 Y el matiz que define el riesgo real: esto YA SE PUEDE HACER HOY cerrando sesión y entrando
 * con contraseña. No abre una puerta nueva — cambia la llave de esa puerta.
 */
import { StaffRole, AuthMethod } from '@prisma/client'

jest.mock('../../../../src/utils/prismaClient')
jest.mock('@/services/auth/session.service')
jest.mock('@/services/auth/sessionCache')
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import prisma from '../../../../src/utils/prismaClient'
import * as sessionService from '@/services/auth/session.service'
import { invalidateSession } from '@/services/auth/sessionCache'
import { switchUserByPin } from '../../../../src/services/mobile/switch-user.mobile.service'
import { logAction } from '../../../../src/services/dashboard/activity-log.service' // mockeado global en setup.ts

const mockPrisma = prisma as any
const createSessionMock = sessionService.createSession as jest.Mock
const revokeSessionMock = sessionService.revokeSession as jest.Mock

const VENUE = 'venue_1'
const SESION_ACTUAL = 'sess_saliente'
const SESION_NUEVA = 'sess_entrante'

function staffVenueEncontrado(over: Record<string, unknown> = {}) {
  return {
    staffId: 'staff_ana',
    venueId: VENUE,
    role: StaffRole.WAITER,
    permissionSetId: null,
    permissionSet: null,
    staff: { id: 'staff_ana', firstName: 'Ana', lastName: 'Ruiz', email: 'ana@x.com', photoUrl: null, active: true },
    venue: {
      id: VENUE,
      name: 'Amaena',
      slug: 'amaena',
      logo: null,
      type: 'SALON',
      status: 'ACTIVE',
      kycStatus: 'APPROVED',
      organizationId: 'org_1',
      timezone: 'America/Mexico_City',
    },
    ...over,
  }
}

describe('switchUserByPin', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    createSessionMock.mockResolvedValue({ id: SESION_NUEVA })
    revokeSessionMock.mockResolvedValue(undefined)
    mockPrisma.staffVenue = { findFirst: jest.fn().mockResolvedValue(staffVenueEncontrado()) }
    mockPrisma.venueRolePermission = { findFirst: jest.fn().mockResolvedValue(null) }
    // El nombre visible del rol sale de aquí (getRoleDisplayNamesForVenues); sin este mock el
    // servicio revienta por una razón ajena a lo que cada prueba mira.
    mockPrisma.venueRoleConfig = { findMany: jest.fn().mockResolvedValue([]) }
    mockPrisma.activityLog = { create: jest.fn().mockResolvedValue({}) }
    mockPrisma.$transaction = jest.fn(async (fn: any) => (typeof fn === 'function' ? fn(mockPrisma) : Promise.all(fn)))
  })

  const llamar = (over: Record<string, unknown> = {}) =>
    switchUserByPin({ venueId: VENUE, pin: '1234', sesionActualId: SESION_ACTUAL, ...over } as any)

  it('🔑 devuelve LA MISMA FORMA que el login — es un logout/login con PIN, y el cliente reusa su mismo camino', async () => {
    const r: any = await llamar()

    // El founder lo definió así: "es como un logout login pero con pin". Si la forma
    // difiere, el cliente tiene que escribir un SEGUNDO camino de guardado y refresco, y
    // ahí es donde aparecen los defectos: una pantalla que se queda con los permisos viejos.
    // 🔴 `user`, NO `staff`: verificado llamando al login real. La primera version usaba `staff`
    // y la app habria leido undefined sin un solo error de por medio.
    expect(r).toHaveProperty('accessToken')
    expect(r).toHaveProperty('refreshToken')
    expect(r).toHaveProperty('user')
    expect(r).not.toHaveProperty('staff')
    expect(r.user.venues[0]).toHaveProperty('roleDisplayName')
    expect(r.user.id).toBe('staff_ana')
    expect(r.user.venues[0].role).toBe(StaffRole.WAITER)
    expect(Array.isArray(r.user.venues[0].permissions)).toBe(true)
  })

  it('crea la sesión entrante con authMethod PIN y colgada de la saliente', async () => {
    await llamar()

    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'staff_ana', venueId: VENUE, authMethod: AuthMethod.PIN, parentSessionId: SESION_ACTUAL }),
    )
  })

  it('🔴 REVOCA la sesión saliente — si no, el token del anterior sigue sirviendo', async () => {
    await llamar()

    expect(revokeSessionMock).toHaveBeenCalledWith(SESION_ACTUAL, expect.stringContaining('switch'))
  })

  it('🔴 INVALIDA la caché de la sesión saliente — revocar sin invalidar la deja viva hasta 60 s', async () => {
    // Encontrado EN VIVO, no con mocks: tras cambiar de usuario, el token del anterior seguía
    // devolviendo 200. `revokeSession` escribe en la base, pero el middleware pregunta a una
    // caché de 60 s (`isSessionAliveCached`). En un mostrador, 60 segundos con el token del
    // dueño todavía sirviendo es exactamente el hueco que esta feature venía a cerrar.
    await llamar()

    expect(invalidateSession).toHaveBeenCalledWith(SESION_ACTUAL)
  })

  it('🔴 sólo busca en ESTE venue, con la persona y su acceso activos', async () => {
    await llamar()

    expect(mockPrisma.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: VENUE, pin: '1234', active: true, staff: { active: true } }),
      }),
    )
  })

  it('🔴 un PIN que no existe da el MISMO error genérico que una persona inactiva', async () => {
    mockPrisma.staffVenue.findFirst.mockResolvedValue(null)
    const e1 = await llamar().catch(e => e.message)

    mockPrisma.staffVenue.findFirst.mockResolvedValue(null) // el filtro staff.active ya lo excluyó
    const e2 = await llamar({ pin: '9999' }).catch(e => e.message)

    // Si los mensajes distinguen, el aparato se vuelve un buscador de PINes válidos.
    expect(e1).toBe(e2)
    expect(e1).not.toMatch(/inactiv|baja|existe/i)
  })

  it('🔴 sin sesión actual NO se puede cambiar de usuario — el PIN no abre una tablet fría', async () => {
    await expect(llamar({ sesionActualId: undefined })).rejects.toThrow()
    expect(createSessionMock).not.toHaveBeenCalled()
  })

  it('🔴 aunque la forma sea la del login, trae SÓLO este negocio — no las otras sucursales', async () => {
    const r: any = await llamar()

    expect(r.user.venues).toHaveLength(1)
    expect(r.user.venues[0].id).toBe(VENUE)
  })

  it('deja rastro en la bitácora: quién entró, a quién relevó y en qué sesión', async () => {
    // `logAction` está mockeado GLOBALMENTE en tests/__helpers__/setup.ts (trampa documentada del
    // repo): mirar prisma.activityLog.create aquí no vería nada aunque el código sí registre.
    await llamar()

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'POS_USER_SWITCHED',
        venueId: VENUE,
        staffId: 'staff_ana',
        data: expect.objectContaining({ sesionSaliente: SESION_ACTUAL }),
      }),
    )
  })
})
