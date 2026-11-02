/**
 * QUÉ permiso pide `/terminal-payment/:requestId/release` según el cuerpo — probado directo sobre el middleware.
 *
 * 🔴 Existe por lo mismo que su hermano de cumpleaños: una prueba con ROLES no distinguiría los dos casos, porque
 * MANAGER, ADMIN y OWNER tienen los dos permisos. La distinción sólo se nota con el cajero — y el punto entero de
 * este cambio es que el CAJERO pueda declarar sin poder liberar terminales a secas. La única forma honesta de
 * fijar la regla es mirar qué permiso pide el middleware.
 *
 * El riesgo que cuidan estas pruebas es de dinero en una dirección concreta: que un campo libre que YA existía
 * (`reason`, `confirm`) acabe leyéndose como una afirmación sobre un cobro y baje el candado sin que nadie lo
 * decidiera.
 */
const delegado = jest.fn()
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: jest.fn(() => delegado),
  checkAnyPermission: jest.fn(() => delegado),
  resolveUserRoleForVenue: jest.fn(),
  evaluateRolePermission: jest.fn(),
}))

import {
  checkAnyPermission,
  checkPermission,
  evaluateRolePermission,
  resolveUserRoleForVenue,
} from '@/middlewares/checkPermission.middleware'
import { permisoDeLiberacion } from '@/routes/mobile.routes'
import logger from '@/config/logger'

const checkPermissionMock = checkPermission as unknown as jest.Mock
const checkAnyPermissionMock = checkAnyPermission as unknown as jest.Mock
const rolMock = resolveUserRoleForVenue as unknown as jest.Mock
const evaluarMock = evaluateRolePermission as unknown as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  rolMock.mockResolvedValue({ role: 'WAITER', source: 'staffVenue', permissionSet: null })
})

/** La declaración de una sesión de ESTE venue (lo que deja `authenticateTokenMiddleware`). */
const declaracion = () =>
  ({
    body: { statement: 'UNCHARGED_VERIFIED' },
    params: { venueId: 'v1' },
    headers: {},
    authContext: { userId: 'staff-1', venueId: 'v1', role: 'WAITER' },
  }) as any

describe('permisoDeLiberacion', () => {
  it('DECLARAR con `payments:create` EFECTIVO (el mesero, A5 E7) pasa la puerta: el servicio le pide el PIN de un gerente', async () => {
    // El permiso de la declaración NO se relaja: lo exige `reconcileUncharged` a la sesión o al dueño del PIN.
    evaluarMock.mockImplementation(async ({ permission }: { permission: string }) => permission === 'payments:create')
    const next = jest.fn()
    await permisoDeLiberacion(declaracion(), {} as any, next)
    expect(next).toHaveBeenCalledTimes(1)
    // Resuelto como `checkPermission`: el rol en ESE venue (con la memoria del request) y la evaluación efectiva.
    expect(rolMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'staff-1', targetVenueId: 'v1' }))
    expect(evaluarMock).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'v1', role: 'WAITER', permission: 'payments:create' }))
    expect(checkPermissionMock).not.toHaveBeenCalled()
    expect(checkAnyPermissionMock).not.toHaveBeenCalled()
  })

  it('DECLARAR sin `payments:create` delega en `checkPermission(payments:reconcile-uncharged)`: la misma puerta (y negación) de develop', async () => {
    // Codex servidor r4 + re-revisión (M1): quien sólo tiene el permiso de declarar pasa por la puerta de `c137ec666`; quien no
    // tiene ninguno recibe EXACTAMENTE su 403 (bitácora `PERMISSION_DENIED`, `required` como texto y `overridable`).
    evaluarMock.mockResolvedValue(false)
    const req = declaracion()
    const next = jest.fn()
    await permisoDeLiberacion(req, {} as any, next)
    expect(checkPermissionMock).toHaveBeenCalledWith('payments:reconcile-uncharged')
    expect(delegado).toHaveBeenCalledWith(req, {}, next)
    expect(next).not.toHaveBeenCalled()
    expect(checkAnyPermissionMock).not.toHaveBeenCalled()
  })

  it('DECLARAR sin sesión o sin rol en el venue también delega (la respuesta canónica la da `checkPermission`)', async () => {
    await permisoDeLiberacion({ body: { statement: 'UNCHARGED_VERIFIED' }, params: {}, headers: {} } as any, {} as any, jest.fn())
    expect(checkPermissionMock).toHaveBeenLastCalledWith('payments:reconcile-uncharged')
    rolMock.mockResolvedValueOnce({ role: null, source: 'none' })
    await permisoDeLiberacion(declaracion(), {} as any, jest.fn())
    expect(checkPermissionMock).toHaveBeenLastCalledWith('payments:reconcile-uncharged')
    expect(evaluarMock).not.toHaveBeenCalled()
  })

  it('DECLARAR con un ERROR al leer el rol sigue fallando cerrado (delega) y deja un warn con venue, usuario y error', async () => {
    // Revisión de A7 (fix round 2, minor): el `catch {}` se tragaba el error y un 403 transitorio quedaba sin rastro para soporte.
    rolMock.mockRejectedValueOnce(new Error('db down'))
    const next = jest.fn()
    await permisoDeLiberacion(declaracion(), {} as any, next)
    expect(next).not.toHaveBeenCalled()
    expect(checkPermissionMock).toHaveBeenCalledWith('payments:reconcile-uncharged')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ venueId: 'v1', userId: 'staff-1', error: 'db down' }),
    )
  })

  it('liberar a secas sigue pidiendo tpv:update (gerencia)', () => {
    permisoDeLiberacion({ body: { reason: 'la PAX se reinició' } } as any, {} as any, jest.fn())
    expect(checkPermissionMock).toHaveBeenCalledWith('tpv:update')
  })

  it('🔴 `reason` y `confirm` NO bajan el candado: no son una declaración', () => {
    permisoDeLiberacion({ body: { reason: 'ya revisé, no se cobró', confirm: true } } as any, {} as any, jest.fn())
    expect(checkPermissionMock).toHaveBeenCalledWith('tpv:update')
    expect(checkPermissionMock).not.toHaveBeenCalledWith('payments:create')
    expect(checkAnyPermissionMock).not.toHaveBeenCalled()
  })

  it('un cuerpo ausente no baja el candado por accidente', () => {
    permisoDeLiberacion({} as any, {} as any, jest.fn())
    expect(checkPermissionMock).toHaveBeenCalledWith('tpv:update')
  })

  it('🔴 un `statement` DESCONOCIDO cae al permiso ALTO, nunca al del cajero', () => {
    permisoDeLiberacion({ body: { statement: 'LO_QUE_SEA' } } as any, {} as any, jest.fn())
    expect(checkPermissionMock).toHaveBeenCalledWith('tpv:update')
  })

  it('🔴 el `statement` de la declaración de GERENCIA tampoco baja el candado a cajero', () => {
    // `NO_INSTRUMENT_PRESENTED` es la otra declaración, y esa SÍ es de gerencia: si cayera aquí, un cajero
    // podría hacerla por esta puerta.
    permisoDeLiberacion({ body: { statement: 'NO_INSTRUMENT_PRESENTED' } } as any, {} as any, jest.fn())
    expect(checkPermissionMock).toHaveBeenCalledWith('tpv:update')
  })
})
