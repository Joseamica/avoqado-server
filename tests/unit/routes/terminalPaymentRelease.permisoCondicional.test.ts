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
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}))

import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { permisoDeLiberacion } from '@/routes/mobile.routes'

const checkPermissionMock = checkPermission as unknown as jest.Mock

beforeEach(() => checkPermissionMock.mockClear())

describe('permisoDeLiberacion', () => {
  it('DECLARAR que no se cobró pide el permiso del cajero', () => {
    permisoDeLiberacion({ body: { statement: 'UNCHARGED_VERIFIED' } } as any, {} as any, jest.fn())
    expect(checkPermissionMock).toHaveBeenCalledWith('payments:reconcile-uncharged')
  })

  it('liberar a secas sigue pidiendo tpv:update (gerencia)', () => {
    permisoDeLiberacion({ body: { reason: 'la PAX se reinició' } } as any, {} as any, jest.fn())
    expect(checkPermissionMock).toHaveBeenCalledWith('tpv:update')
  })

  it('🔴 `reason` y `confirm` NO bajan el candado: no son una declaración', () => {
    permisoDeLiberacion({ body: { reason: 'ya revisé, no se cobró', confirm: true } } as any, {} as any, jest.fn())
    expect(checkPermissionMock).toHaveBeenCalledWith('tpv:update')
    expect(checkPermissionMock).not.toHaveBeenCalledWith('payments:reconcile-uncharged')
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
