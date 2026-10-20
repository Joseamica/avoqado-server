import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'

/**
 * 🔴 Editar, activar o apagar una terminal desde el panel de la organización — quién puede.
 *
 * Tres puertas que cambian el estado de una terminal sólo pedían `checkOrgAccess`, o sea ser MIEMBRO
 * activo de la organización: un cajero o un promotor de cualquier sucursal podía, por la API,
 *   · `PATCH .../terminals/:terminalId`   cambiarle el nombre, la marca, el modelo y el ESTADO:
 *       `status: 'ACTIVE'` sobre una terminal nunca activada la ACTIVA (estampa `activatedAt`), y
 *       `RETIRED` / `INACTIVE` la apagan — sacaba de servicio la terminal de cobro de una tienda;
 *   · `POST .../generate-activation-code`  sacarle un código de activación (con él, un aparato la reclama);
 *   · `POST .../remote-activate`           mandarle la activación remota.
 *
 * Ahora las tres piden el mismo piso que `/command` y `/bulk-command`: `requireOrgManager` (supervisor
 * o más). Los comercios del PATCH siguen con su candado más estricto de la ronda 3 (dueño de la org o
 * `system:config` en la sucursal de la terminal): ese candado no cambia.
 *
 * La autorización es la REAL (`checkOrgAccess`, `requireOrgManager`, el candado de comercios); sólo se
 * simulan la autenticación, la capa de datos y el servicio que escribe.
 */

const updateTerminalForOrgMock = jest.fn()
const generateActivationCodeForOrgMock = jest.fn()
const sendRemoteActivationForOrgMock = jest.fn()

jest.mock('@/services/organization-dashboard/orgTerminals.service', () => ({
  ...jest.requireActual('@/services/organization-dashboard/orgTerminals.service'),
  updateTerminalForOrg: (...args: unknown[]) => updateTerminalForOrgMock(...args),
  generateActivationCodeForOrg: (...args: unknown[]) => generateActivationCodeForOrgMock(...args),
  sendRemoteActivationForOrg: (...args: unknown[]) => sendRemoteActivationForOrgMock(...args),
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
const VENUE_A = 'venue-a' // la sucursal de la terminal
const TERMINAL = 'terminal-a'
const COMERCIOS_ACTUALES = ['ma-1', 'ma-2']

/** Filas `StaffVenue`. */
const SUCURSAL: Array<{ staffId: string; venueId: string; organizationId: string; role: string }> = [
  { staffId: 'cajero', venueId: VENUE_A, organizationId: ORG, role: 'CASHIER' },
  { staffId: 'promotor', venueId: VENUE_A, organizationId: ORG, role: 'WAITER' }, // los promotores de PlayTelecom son WAITER
  { staffId: 'gerente', venueId: VENUE_A, organizationId: ORG, role: 'MANAGER' },
  { staffId: 'dueno-sucursal', venueId: VENUE_A, organizationId: ORG, role: 'OWNER' },
  { staffId: 'super-1', venueId: 'venue-plataforma', organizationId: 'org-plataforma', role: 'SUPERADMIN' },
]
/** Filas `StaffOrganization`. */
const ORGANIZACION: Array<{ staffId: string; organizationId: string; role: string; isActive: boolean }> = [
  { staffId: 'cajero', organizationId: ORG, role: 'MEMBER', isActive: true },
  { staffId: 'promotor', organizationId: ORG, role: 'MEMBER', isActive: true },
  { staffId: 'miembro-org', organizationId: ORG, role: 'MEMBER', isActive: true }, // sólo fila de la org, sin sucursal
  { staffId: 'dueno-org', organizationId: ORG, role: 'OWNER', isActive: true },
]

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
  const venueId = SUCURSAL.find(f => f.staffId === userId)?.venueId ?? VENUE_A
  return { 'x-test-auth-context': JSON.stringify({ userId, orgId: ORG, venueId, role: tokenRole }) }
}

const PATCH_TERMINAL = `/dashboard/organizations/${ORG}/terminals/${TERMINAL}`
const CODIGO = `/dashboard/organizations/${ORG}/terminals/${TERMINAL}/generate-activation-code`
const ACTIVAR = `/dashboard/organizations/${ORG}/terminals/${TERMINAL}/remote-activate`

function editar(userId: string, rol: string, body: Record<string, unknown>) {
  return request(makeApp()).patch(PATCH_TERMINAL).set(como(userId, rol)).send(body)
}
function sacarCodigo(userId: string, rol: string) {
  return request(makeApp()).post(CODIGO).set(como(userId, rol)).send({})
}
function activarRemoto(userId: string, rol: string) {
  return request(makeApp()).post(ACTIVAR).set(como(userId, rol)).send({})
}

function esElPisoDeSupervisor(res: request.Response) {
  expect(res.status).toBe(403)
  expect(res.body).toMatchObject({ success: false, error: 'insufficient_role', message: 'Se requiere rol de supervisor o superior' })
}

beforeEach(() => {
  jest.clearAllMocks()
  updateTerminalForOrgMock.mockResolvedValue({ id: TERMINAL })
  generateActivationCodeForOrgMock.mockResolvedValue({ activationCode: 'ABC123' })
  sendRemoteActivationForOrgMock.mockResolvedValue({ commandId: 'cmd-1' })

  prismaMock.staff.findUnique.mockResolvedValue({ active: true, firstName: 'Ana', lastName: 'Prueba' } as any)
  prismaMock.terminal.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve(
      where?.id === TERMINAL
        ? { id: TERMINAL, venueId: VENUE_A, assignedMerchantIds: [...COMERCIOS_ACTUALES], venue: { id: VENUE_A, organizationId: ORG } }
        : null,
    )) as any)

  // checkOrgAccess / requireOrgManager / requireOrgOwner / superadmin real
  prismaMock.staffVenue.findFirst.mockImplementation((({ where }: any) => {
    const fila = SUCURSAL.find(
      f =>
        f.staffId === where?.staffId &&
        coincideRol(where?.role, f.role) &&
        (!where?.venue?.organizationId || where.venue.organizationId === f.organizationId),
    )
    return Promise.resolve(fila ? { id: `sv-${fila.staffId}` } : null)
  }) as any)
  prismaMock.staffOrganization.findFirst.mockImplementation((({ where }: any) => {
    const fila = ORGANIZACION.find(
      f =>
        f.staffId === where?.staffId &&
        f.organizationId === where?.organizationId &&
        (where?.isActive !== true || f.isActive) &&
        coincideRol(where?.role, f.role),
    )
    return Promise.resolve(fila ? { id: `so-${fila.staffId}` } : null)
  }) as any)

  // El resolvedor canónico del permiso EN EL VENUE de la terminal (candado de comercios, ronda 3).
  prismaMock.staffVenue.findUnique.mockImplementation((({ where }: any) => {
    const { staffId, venueId } = where?.staffId_venueId ?? {}
    const fila = SUCURSAL.find(f => f.staffId === staffId && f.venueId === venueId)
    return Promise.resolve(fila ? { role: fila.role, active: true, permissionSetId: null, permissionSet: null } : null)
  }) as any)
  prismaMock.venue.findUnique.mockImplementation((({ where }: any) => Promise.resolve({ id: where?.id, organizationId: ORG })) as any)
  prismaMock.staffOrganization.findUnique.mockImplementation((({ where }: any) => {
    const { staffId, organizationId } = where?.staffId_organizationId ?? {}
    const fila = ORGANIZACION.find(f => f.staffId === staffId && f.organizationId === organizationId)
    return Promise.resolve(fila ? { role: fila.role, isActive: fila.isActive } : null)
  }) as any)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null as any)
})

const EL_PISO = [
  ['un cajero de la sucursal de la terminal', 'cajero', 'CASHIER'],
  ['un promotor', 'promotor', 'WAITER'],
  ['un miembro de la org sin sucursal', 'miembro-org', 'VIEWER'],
] as const

describe('PATCH .../terminals/:terminalId — el piso ya no edita ni apaga terminales', () => {
  describe.each(EL_PISO)('%s', (_label, userId, rol) => {
    it.each([
      ['🔴 activar una terminal nunca activada (status ACTIVE)', { status: 'ACTIVE' }],
      ['🔴 retirarla (status RETIRED)', { status: 'RETIRED' }],
      ['🔴 apagarla (status INACTIVE)', { status: 'INACTIVE' }],
      ['🔴 ponerla en mantenimiento', { status: 'MAINTENANCE' }],
      ['🔴 cambiarle el nombre', { name: 'Caja pirata' }],
      ['🔴 cambiarle la marca y el modelo', { brand: 'Otra', model: 'X1' }],
      ['🔴 cambiarle los comercios', { assignedMerchantIds: ['ma-9'] }],
      ['🔴 reenviar los mismos comercios con otro nombre', { name: 'Caja 9', assignedMerchantIds: [...COMERCIOS_ACTUALES] }],
    ])('%s → 403 en español y nada escrito', async (_l, body) => {
      const res = await editar(userId, rol, body)

      esElPisoDeSupervisor(res)
      expect(updateTerminalForOrgMock).not.toHaveBeenCalled()
    })
  })
})

describe('PATCH .../terminals/:terminalId — supervisor o más', () => {
  it.each([
    ['el nombre', { name: 'Caja 2' }],
    ['el estado: activarla', { status: 'ACTIVE' }],
    ['el estado: retirarla', { status: 'RETIRED' }],
    ['la marca y el modelo', { brand: 'PAX', model: 'A920' }],
  ])('el GERENTE de la sucursal edita %s', async (_l, body) => {
    const res = await editar('gerente', 'MANAGER', body)

    expect(res.status).toBe(200)
    expect(updateTerminalForOrgMock).toHaveBeenCalledWith(ORG, TERMINAL, body, 'gerente')
  })

  it('el gerente sigue sin cambiar comercios (candado de la ronda 3, sin cambios)', async () => {
    const res = await editar('gerente', 'MANAGER', { name: 'Caja 2', assignedMerchantIds: ['ma-9'] })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ORG_OWNER_REQUIRED')
    expect(updateTerminalForOrgMock).not.toHaveBeenCalled()
  })

  it('el gerente reenvía los MISMOS comercios del diálogo: pasa y no se escriben (ronda 3, sin cambios)', async () => {
    const res = await editar('gerente', 'MANAGER', { name: 'Caja 2', assignedMerchantIds: [...COMERCIOS_ACTUALES] })

    expect(res.status).toBe(200)
    expect(updateTerminalForOrgMock).toHaveBeenCalledWith(ORG, TERMINAL, { name: 'Caja 2' }, 'gerente')
  })

  it('el OWNER de la sucursal (el que entra al panel de la org) edita nombre y estado', async () => {
    const res = await editar('dueno-sucursal', 'OWNER', { name: 'Caja 3', status: 'INACTIVE' })

    expect(res.status).toBe(200)
    expect(updateTerminalForOrgMock).toHaveBeenCalledWith(ORG, TERMINAL, { name: 'Caja 3', status: 'INACTIVE' }, 'dueno-sucursal')
  })

  it.each([
    ['el dueño de la organización', 'dueno-org', 'OWNER'],
    ['el superadmin de verdad', 'super-1', 'SUPERADMIN'],
  ])('%s edita todo, comercios incluidos', async (_l, userId, rol) => {
    const body = { name: 'Caja 4', status: 'ACTIVE', brand: 'PAX', model: 'A920', assignedMerchantIds: ['ma-9'] }
    const res = await editar(userId, rol, body)

    expect(res.status).toBe(200)
    expect(updateTerminalForOrgMock).toHaveBeenCalledWith(ORG, TERMINAL, body, userId)
  })
})

describe.each([
  ['POST .../generate-activation-code', sacarCodigo, () => generateActivationCodeForOrgMock],
  ['POST .../remote-activate', activarRemoto, () => sendRemoteActivationForOrgMock],
])('%s', (_label, pedir, servicio) => {
  it.each(EL_PISO)('🔴 %s → 403 en español y nada escrito', async (_l, userId, rol) => {
    const res = await pedir(userId, rol)

    esElPisoDeSupervisor(res)
    expect(servicio()).not.toHaveBeenCalled()
  })

  it.each([
    ['el gerente de la sucursal', 'gerente', 'MANAGER'],
    ['el OWNER de la sucursal', 'dueno-sucursal', 'OWNER'],
    ['el dueño de la organización', 'dueno-org', 'OWNER'],
    ['el superadmin de verdad', 'super-1', 'SUPERADMIN'],
  ])('%s sí puede', async (_l, userId, rol) => {
    const res = await pedir(userId, rol)

    expect(res.status).toBe(200)
    expect(servicio()).toHaveBeenCalledWith(ORG, TERMINAL, userId)
  })
})
