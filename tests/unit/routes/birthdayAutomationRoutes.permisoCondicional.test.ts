/**
 * QUÉ permiso pide el PUT según el cuerpo — probado directo sobre el middleware.
 *
 * 🔴 Este archivo existe porque el de roles NO puede distinguirlos: en los permisos de
 * fábrica ningún rol tiene `marketing:manage` sin `marketing:send` (los de piso sólo tienen
 * `:read`; ADMIN y OWNER tienen `marketing:*`), así que encender y editar dan el mismo
 * resultado con cualquier rol default. La distinción sólo se nota con un conjunto de
 * permisos PERSONALIZADO, y hasta entonces la única forma honesta de fijar la regla es
 * mirar qué permiso pide el middleware. Una prueba con roles habría parecido cubrirlo sin
 * cubrirlo.
 */
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { permisoSegunElCuerpo } from '@/routes/dashboard/birthdayAutomation.routes'

const checkPermissionMock = checkPermission as unknown as jest.Mock

beforeEach(() => checkPermissionMock.mockClear())

describe('permisoSegunElCuerpo', () => {
  it('🔴 ENCENDER pide marketing:send — es autorizar envíos recurrentes a los clientes', () => {
    permisoSegunElCuerpo({ body: { activa: true } } as any, {} as any, jest.fn())
    expect(checkPermissionMock).toHaveBeenCalledWith('marketing:send')
  })

  it('editar sin encender pide marketing:manage', () => {
    permisoSegunElCuerpo({ body: { activa: false } } as any, {} as any, jest.fn())
    expect(checkPermissionMock).toHaveBeenCalledWith('marketing:manage')
  })

  it('🔴 APAGAR pide el permiso menor: parar nunca puede ser más difícil que arrancar', () => {
    // Si apagar exigiera el permiso alto, un negocio con su encargado de marketing de
    // vacaciones no podría detener un envío que está haciendo daño.
    permisoSegunElCuerpo({ body: { activa: false } } as any, {} as any, jest.fn())
    expect(checkPermissionMock).not.toHaveBeenCalledWith('marketing:send')
  })

  it('un cuerpo ausente no escala el permiso por accidente', () => {
    permisoSegunElCuerpo({} as any, {} as any, jest.fn())
    expect(checkPermissionMock).toHaveBeenCalledWith('marketing:manage')
  })

  it('un `activa` que no es booleano NO cuenta como encender', () => {
    // Zod ya lo rechaza antes (por eso valida primero), pero el middleware no puede
    // depender de eso para no escalar: compara con `=== true`.
    permisoSegunElCuerpo({ body: { activa: 'true' } } as any, {} as any, jest.fn())
    expect(checkPermissionMock).toHaveBeenCalledWith('marketing:manage')
  })
})
