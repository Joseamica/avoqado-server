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
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { disconnectBySession: jest.fn() },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import prisma from '../../../../src/utils/prismaClient'
import * as sessionService from '@/services/auth/session.service'
import { invalidateSession } from '@/services/auth/sessionCache'
import socketManager from '@/communication/sockets/managers/socketManager'
import { switchUserByPin } from '../../../../src/services/mobile/switch-user.mobile.service'
import { logAction } from '../../../../src/services/dashboard/activity-log.service' // mockeado global en setup.ts

const mockPrisma = prisma as any
const createSessionMock = sessionService.createSession as jest.Mock
const revokeSessionMock = sessionService.revokeSession as jest.Mock

const VENUE = 'venue_1'
const SESION_ACTUAL = 'sess_saliente'
const SESION_NUEVA = 'sess_entrante'
const APARATO = 'tablet-caja-1'

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
    revokeSessionMock.mockResolvedValue(1)
    // La sesión saliente ES el modelo de seguridad: el servicio la lee para comprobar que está
    // viva, que es de ESTE venue y que corre en el MISMO aparato que dice el header.
    mockPrisma.session = {
      findUnique: jest.fn().mockResolvedValue({ id: SESION_ACTUAL, venueId: VENUE, deviceId: APARATO, revokedAt: null }),
    }
    mockPrisma.staffVenue = { findFirst: jest.fn().mockResolvedValue(staffVenueEncontrado()) }
    mockPrisma.venueRolePermission = { findFirst: jest.fn().mockResolvedValue(null) }
    // El nombre visible del rol sale de aquí (getRoleDisplayNamesForVenues); sin este mock el
    // servicio revienta por una razón ajena a lo que cada prueba mira.
    mockPrisma.venueRoleConfig = { findMany: jest.fn().mockResolvedValue([]) }
    mockPrisma.activityLog = { create: jest.fn().mockResolvedValue({}) }
    mockPrisma.$transaction = jest.fn(async (fn: any) => (typeof fn === 'function' ? fn(mockPrisma) : Promise.all(fn)))
  })

  const llamar = (over: Record<string, unknown> = {}) =>
    switchUserByPin({ venueId: VENUE, pin: '1234', sesionActualId: SESION_ACTUAL, deviceId: APARATO, ...over } as any)

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

  it('🔴 CIERRA el socket del anterior — si no, sigue recibiendo avisos en tiempo real como él', async () => {
    // Revocar la sesión y vaciar la caché corta el acceso HTTP, pero el socket ya abierto vive
    // aparte: sin cerrarlo, el aparato sigue recibiendo eventos bajo la identidad de quien acaba
    // de salir hasta que la revalidación periódica lo cace, y eso son hasta 10 minutos.
    await llamar()

    expect(socketManager.disconnectBySession).toHaveBeenCalledWith(SESION_ACTUAL)
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

/**
 * Hallazgos de la auditoría de Codex del 2026-08-30 sobre este mismo diff (6 P1).
 *
 * Los cuatro que tocan este servicio tienen una raíz común y vale nombrarla: yo escribí el
 * modelo de seguridad en el docstring —«el PIN sólo se acepta ENCIMA de una sesión viva de ESTE
 * aparato»— y después NO lo hice cumplir en el código. El `sid` se exigía, pero la sesión que
 * nombra nunca se leía; el `X-Device-Id` se guardaba sin compararlo con nada. Una comprobación
 * que vive sólo en un comentario no es una comprobación.
 */
describe('switchUserByPin — cierres de la auditoría (2026-08-30)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    createSessionMock.mockResolvedValue({ id: SESION_NUEVA })
    revokeSessionMock.mockResolvedValue(1)
    mockPrisma.session = {
      findUnique: jest.fn().mockResolvedValue({ id: SESION_ACTUAL, venueId: VENUE, deviceId: APARATO, revokedAt: null }),
    }
    mockPrisma.staffVenue = { findFirst: jest.fn().mockResolvedValue(staffVenueEncontrado()) }
    mockPrisma.venueRolePermission = { findFirst: jest.fn().mockResolvedValue(null) }
    mockPrisma.venueRoleConfig = { findMany: jest.fn().mockResolvedValue([]) }
    mockPrisma.activityLog = { create: jest.fn().mockResolvedValue({}) }
    mockPrisma.$transaction = jest.fn(async (fn: any) => (typeof fn === 'function' ? fn(mockPrisma) : Promise.all(fn)))
  })

  const llamar = (over: Record<string, unknown> = {}) =>
    switchUserByPin({ venueId: VENUE, pin: '1234', sesionActualId: SESION_ACTUAL, deviceId: APARATO, ...over } as any)

  it('🔴 [P1] dos relevos a la vez: el que PIERDE el reclamo no crea sesión', async () => {
    // El orden original era crear-y-luego-revocar, sin mirar el resultado. Dos peticiones
    // concurrentes pasaban ambas la autenticación, ambas creaban su sesión y ambas revocaban
    // la misma saliente: quedaban DOS sesiones válidas nacidas de un solo relevo, es decir dos
    // personas cobrando con identidades distintas desde una tablet que sólo cambió de manos una
    // vez. `revokeSession` es ahora el reclamo atómico (`updateMany` con `revokedAt: null`) y
    // quien recibe 0 filas es quien llegó segundo.
    revokeSessionMock.mockResolvedValue(0)

    await expect(llamar()).rejects.toThrow()
    expect(createSessionMock).not.toHaveBeenCalled()
  })

  it('🔴 [P1] un PIN equivocado NO revoca la sesión de quien estaba operando', async () => {
    // La contracara del arreglo de arriba, y la razón de que el reclamo vaya DESPUÉS de validar
    // el PIN y no antes: revocar primero convertiría cada dedazo del pinpad en un cierre de
    // sesión, y el cajero tendría que buscar su contraseña a media fila.
    mockPrisma.staffVenue.findFirst.mockResolvedValue(null)

    await expect(llamar()).rejects.toThrow()
    expect(revokeSessionMock).not.toHaveBeenCalled()
    expect(createSessionMock).not.toHaveBeenCalled()
  })

  it('🔴 [P1] una sesión SIN aparato (la del dashboard web) no puede relevar', async () => {
    // Éste es el hueco que más lejos llegaba: la ruta sólo exige token válido + membresía del
    // venue, así que una sesión del dashboard —que nunca manda `X-Device-Id`— podía inventarse
    // el header y acuñar una sesión de POS por PIN. Exigir que la saliente TENGA aparato cierra
    // la puerta por construcción, sin listas de qué carril puede y qué carril no.
    mockPrisma.session.findUnique.mockResolvedValue({ id: SESION_ACTUAL, venueId: VENUE, deviceId: null, revokedAt: null })

    // Y el mensaje NO es «PIN incorrecto»: quien teclea bien y lee eso lo repite convencido de
    // que la máquina se equivoca. Se le dice el camino de salida — entrar con su contraseña.
    await expect(llamar()).rejects.toThrow(/contraseña/i)
    expect(createSessionMock).not.toHaveBeenCalled()
  })

  it('🔴 [P1] el aparato del header tiene que ser EL MISMO de la sesión saliente', async () => {
    // Sin esto el `X-Device-Id` era decoración: se heredaba a la sesión entrante sin comprobar
    // nada, así que la tablet A podía declararse tablet B — y entonces «sacar la tablet B» desde
    // el dashboard mataba una sesión que estaba corriendo en otro mostrador.
    await expect(llamar({ deviceId: 'otra-tablet' })).rejects.toThrow()
    expect(createSessionMock).not.toHaveBeenCalled()
  })

  it('🔴 la sesión saliente tiene que ser de ESTE venue, y estar viva', async () => {
    mockPrisma.session.findUnique.mockResolvedValue({ id: SESION_ACTUAL, venueId: 'otro_venue', deviceId: APARATO, revokedAt: null })
    await expect(llamar()).rejects.toThrow()

    mockPrisma.session.findUnique.mockResolvedValue({ id: SESION_ACTUAL, venueId: VENUE, deviceId: APARATO, revokedAt: new Date() })
    await expect(llamar()).rejects.toThrow()

    mockPrisma.session.findUnique.mockResolvedValue(null)
    await expect(llamar()).rejects.toThrow()

    expect(createSessionMock).not.toHaveBeenCalled()
  })

  it.each(['SUSPENDED', 'ADMIN_SUSPENDED', 'CLOSED'])('🔴 [P1] un venue %s no puede acuñar tokens nuevos por PIN', async estado => {
    // Yo leía `venue.status` en el `select` y no lo comparaba con nada. El login móvil sí lo
    // aplica (`pickOperationalVenueForLogin`), así que un local cortado por falta de pago no
    // puede entrar por la puerta principal — pero sí por ésta, que es la misma puerta con otra
    // llave. Se reusa `OPERATIONAL_VENUE_STATUSES`, no una segunda lista que pueda divergir.
    mockPrisma.staffVenue.findFirst.mockResolvedValue(staffVenueEncontrado({ venue: { ...staffVenueEncontrado().venue, status: estado } }))

    await expect(llamar()).rejects.toThrow()
    expect(createSessionMock).not.toHaveBeenCalled()
  })
})
