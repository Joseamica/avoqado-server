import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import { SendOrgCommandSchema } from '@/schemas/dashboard/orgTerminals.schema'

/**
 * 🔴 `POST /dashboard/organizations/:orgId/terminals/:terminalId/command` — quién manda qué.
 *
 * Antes la ruta sólo pedía `checkOrgAccess`, o sea ser MIEMBRO activo de la organización: un cajero
 * o un promotor de cualquier sucursal mandaba LOCK, FORCE_UPDATE, UPDATE_CONFIG, UPDATE_MERCHANT o
 * FACTORY_RESET a cualquier terminal de la org. Su gemela masiva (`/bulk-command`) ya pedía
 * `requireOrgManager`.
 *
 * Ahora (decisión del 15-oct):
 *   · piso para TODO comando: `requireOrgManager` (supervisor o más), igual que `/bulk-command`;
 *   · UPDATE_MERCHANT (a qué comercio va el dinero) y FACTORY_RESET (borra la terminal): sólo el
 *     DUEÑO DE LA ORGANIZACIÓN — la regla de `requireOrgOwner` (fila ACTIVA de `StaffOrganization`
 *     con rol OWNER, o un superadmin de verdad), la misma del asistente de migración.
 *
 * La autorización es la REAL (`checkOrgAccess`, `requireOrgManager`, la regla del dueño); sólo se
 * simulan la autenticación, la capa de datos y el último paso que encola el comando.
 */

const sendCommandForOrgMock = jest.fn()

jest.mock('@/services/organization-dashboard/orgTerminals.service', () => ({
  ...jest.requireActual('@/services/organization-dashboard/orgTerminals.service'),
  sendCommandForOrg: (...args: unknown[]) => sendCommandForOrgMock(...args),
}))

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-auth-context']
    const value = Array.isArray(raw) ? raw[0] : raw
    if (!value) {
      res.status(401).json({ message: 'No autorizado' })
      return
    }
    ;(req as any).authContext = JSON.parse(value)
    next()
  },
}))

import organizationDashboardRoutes from '@/routes/dashboard/organizationDashboard.routes'

const ORG = 'org-a'
const VENUE = 'venue-a'
const TERMINAL = 'terminal-a'
const RUTA = `/dashboard/organizations/${ORG}/terminals/${TERMINAL}/command`

/** Todos los comandos que la ruta acepta, leídos del esquema real (si se agrega uno, entra solo). */
const TODOS: string[] = [...SendOrgCommandSchema.shape.body.shape.command.options]
const CRITICOS = ['UPDATE_MERCHANT', 'FACTORY_RESET']
const COMUNES = TODOS.filter(c => !CRITICOS.includes(c))

/** Filas `StaffVenue` en sucursales de la organización (y la del superadmin). */
const SUCURSAL: Record<string, { role: string; active: boolean }> = {
  cajero: { role: 'CASHIER', active: true },
  promotor: { role: 'WAITER', active: true }, // los promotores de PlayTelecom son WAITER
  gerente: { role: 'MANAGER', active: true },
  admin: { role: 'ADMIN', active: true },
  'dueno-sucursal': { role: 'OWNER', active: true },
  'dueno-org-bajo': { role: 'ADMIN', active: true }, // dueño de la org que además es ADMIN en la tienda
  'dueno-org-inactivo': { role: 'MANAGER', active: true },
  'super-1': { role: 'SUPERADMIN', active: true },
}
/** Filas `StaffOrganization` de ESTA organización. */
const ORGANIZACION: Record<string, { role: string; isActive: boolean }> = {
  cajero: { role: 'MEMBER', isActive: true },
  promotor: { role: 'MEMBER', isActive: true },
  'dueno-org': { role: 'OWNER', isActive: true },
  'dueno-org-bajo': { role: 'OWNER', isActive: true },
  'dueno-org-inactivo': { role: 'OWNER', isActive: false },
  'admin-org': { role: 'ADMIN', isActive: true },
}

function coincideRol(filtro: unknown, rol: string): boolean {
  if (filtro === undefined) return true
  if (typeof filtro === 'string') return filtro === rol
  return ((filtro as { in?: string[] }).in ?? []).includes(rol)
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/dashboard/organizations', organizationDashboardRoutes)
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code })
  })
  return app
}

function como(userId: string, tokenRole: string) {
  return { 'x-test-auth-context': JSON.stringify({ userId, orgId: ORG, venueId: VENUE, role: tokenRole }) }
}

function mandar(userId: string, tokenRole: string, command: string) {
  return request(makeApp()).post(RUTA).set(como(userId, tokenRole)).send({ command })
}

function denegacionesDelDueno() {
  return (logAction as jest.Mock).mock.calls.filter(([p]) => p?.action === 'PERMISSION_DENIED')
}

beforeEach(() => {
  jest.clearAllMocks()
  sendCommandForOrgMock.mockResolvedValue({ commandId: 'cmd-org' })

  prismaMock.staff.findUnique.mockResolvedValue({ active: true, firstName: 'Ana', lastName: 'Prueba' } as any)
  prismaMock.terminal.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve(where?.id === TERMINAL ? { id: TERMINAL, venueId: VENUE, venue: { id: VENUE, organizationId: ORG } } : null)) as any)
  prismaMock.staffVenue.findFirst.mockImplementation((({ where }: any) => {
    const fila = SUCURSAL[where?.staffId]
    if (!fila) return Promise.resolve(null)
    if (where?.active === true && !fila.active) return Promise.resolve(null)
    if (!coincideRol(where?.role, fila.role)) return Promise.resolve(null)
    if (where?.venue?.organizationId && where.venue.organizationId !== ORG) return Promise.resolve(null)
    if (where?.venue?.organizationId && fila.role === 'SUPERADMIN') return Promise.resolve(null) // su fila no es de esta org
    return Promise.resolve({ id: `sv-${where.staffId}` })
  }) as any)
  prismaMock.staffOrganization.findFirst.mockImplementation((({ where }: any) => {
    const fila = ORGANIZACION[where?.staffId]
    if (!fila || where?.organizationId !== ORG) return Promise.resolve(null)
    if (where?.isActive === true && !fila.isActive) return Promise.resolve(null)
    if (!coincideRol(where?.role, fila.role)) return Promise.resolve(null)
    return Promise.resolve({ id: `so-${where.staffId}` })
  }) as any)
})

describe('el piso (cajero y promotor) ya no manda NINGÚN comando por la ruta de la organización', () => {
  it('el esquema real trae los comandos críticos (si no, esta prueba no prueba nada)', () => {
    expect(TODOS).toEqual(expect.arrayContaining(CRITICOS))
    expect(COMUNES.length).toBeGreaterThan(5)
  })

  describe.each([
    ['un cajero', 'cajero', 'CASHIER'],
    ['un promotor', 'promotor', 'WAITER'],
  ])('%s', (_label, userId, rol) => {
    it.each(TODOS)('🔴 %s → 403 y no se encola nada', async command => {
      const res = await mandar(userId, rol, command)

      expect(res.status).toBe(403)
      expect(sendCommandForOrgMock).not.toHaveBeenCalled()
    })
  })
})

describe('gerente de una sucursal de la org (piso de supervisor)', () => {
  it.each(['RESTART', 'LOCK'])('sí manda %s', async command => {
    const res = await mandar('gerente', 'MANAGER', command)

    expect(res.status).toBe(200)
    expect(sendCommandForOrgMock).toHaveBeenCalledWith(ORG, TERMINAL, command, 'gerente', expect.anything(), undefined)
  })

  it.each(CRITICOS)('🔴 NO manda %s: 403 en español, bitácora con el venue de la terminal, nada encolado', async command => {
    const res = await mandar('gerente', 'MANAGER', command)

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ORG_OWNER_REQUIRED')
    expect(res.body.message).toMatch(/dueño de la organización/)
    expect(sendCommandForOrgMock).not.toHaveBeenCalled()
    expect(denegacionesDelDueno()).toHaveLength(1)
    expect(denegacionesDelDueno()[0][0]).toMatchObject({ staffId: 'gerente', venueId: VENUE, entityId: command })
  })
})

describe.each([
  ['el ADMIN de la sucursal', 'admin', 'ADMIN'],
  ['el DUEÑO DE LA SUCURSAL (sin fila de dueño en la org)', 'dueno-sucursal', 'OWNER'],
  ['el ADMIN de la organización', 'admin-org', 'ADMIN'],
])('%s', (_label, userId, rol) => {
  it('manda los comandos comunes', async () => {
    const res = await mandar(userId, rol, 'RESTART')
    expect(res.status).toBe(200)
  })

  it.each(CRITICOS)('🔴 NO manda %s por esta ruta: es del dueño de la organización', async command => {
    const res = await mandar(userId, rol, command)

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ORG_OWNER_REQUIRED')
    expect(sendCommandForOrgMock).not.toHaveBeenCalled()
  })
})

describe('el dueño de la organización', () => {
  it.each(TODOS)('sin fila en la sucursal, manda %s', async command => {
    const res = await mandar('dueno-org', 'OWNER', command)

    expect(res.status).toBe(200)
    expect(sendCommandForOrgMock).toHaveBeenCalledWith(ORG, TERMINAL, command, 'dueno-org', expect.anything(), undefined)
    expect(denegacionesDelDueno()).toHaveLength(0)
  })

  it.each(CRITICOS)('🔴 aunque en ESA tienda tenga una fila más baja (ADMIN), manda %s', async command => {
    const res = await mandar('dueno-org-bajo', 'ADMIN', command)

    expect(res.status).toBe(200)
    expect(sendCommandForOrgMock).toHaveBeenCalledWith(ORG, TERMINAL, command, 'dueno-org-bajo', expect.anything(), undefined)
  })

  it('🔴 con su fila de dueño INACTIVA ya no manda FACTORY_RESET (aunque sea gerente de la tienda)', async () => {
    const res = await mandar('dueno-org-inactivo', 'MANAGER', 'FACTORY_RESET')

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ORG_OWNER_REQUIRED')
    expect(sendCommandForOrgMock).not.toHaveBeenCalled()
  })

  it('una terminal de OTRA organización: ni se evalúa ni se encola', async () => {
    prismaMock.terminal.findUnique.mockResolvedValue({
      id: TERMINAL,
      venueId: 'venue-z',
      venue: { id: 'venue-z', organizationId: 'org-z' },
    } as any)

    const res = await mandar('dueno-org', 'OWNER', 'FACTORY_RESET')

    expect(res.status).toBe(403)
    expect(sendCommandForOrgMock).not.toHaveBeenCalled()
  })
})

describe('superadmin de verdad', () => {
  it.each(CRITICOS)('manda %s', async command => {
    const res = await mandar('super-1', 'SUPERADMIN', command)

    expect(res.status).toBe(200)
    expect(sendCommandForOrgMock).toHaveBeenCalled()
  })
})
