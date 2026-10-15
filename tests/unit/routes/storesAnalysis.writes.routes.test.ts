import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * 🔴 Las escrituras del panel white-label (`/venues/:venueId/stores-analysis/...`) — quién puede.
 *
 * Sólo pedían `whiteLabelAccess` (sesión + ser miembro de una sucursal con white-label), así que
 * un cajero o un promotor:
 *   · aprobaba o rechazaba checadas de TODA la org, las suyas incluidas, y con `depositAmount`
 *     creaba un `CashDeposit` APROBADO (dinero); o las regresaba a pendiente;
 *   · le cambiaba a cualquiera sus sucursales: dejaba sin acceso a un gerente o al dueño, o
 *     reactivaba a alguien dado de baja;
 *   · creaba, cambiaba o borraba metas de venta de cualquier tienda.
 *
 * Ahora:
 *   · checadas (validar y regresar a pendiente): `attendance:manage` en la sucursal de la petición
 *     (lo tienen MANAGER, ADMIN y OWNER; «nunca a roles de piso»). Y nadie valida ni regresa SU
 *     PROPIA checada, el dueño de la org tampoco (precedente del founder, horas extra, 30-ago).
 *     La regla vive en el servicio: la puerta de la org también la cumple.
 *   · sucursales de una persona: `teams:update` + jerarquía (nadie toca a alguien de rol mayor; al
 *     dueño de la org sólo el dueño de la org), nadie se quita su último acceso ni se da sucursales
 *     a sí mismo (salvo el dueño de la org), y no se reactiva a alguien dado de baja.
 *   · metas por tienda: piso de supervisor (ningún permiso las da a MANAGER: `commissions:create`
 *     es de ADMIN para arriba, y los supervisores las ponen hoy).
 *
 * La autorización es la REAL (`checkPermission`, la regla del supervisor, `checkOrgAccess`,
 * `requireOrgManager`) y también el servicio de checadas; sólo se simulan la autenticación, el
 * candado white-label (sólo prueba membresía), la capa de datos y el servicio de metas.
 */

const createSalesGoalMock = jest.fn()
const updateSalesGoalMock = jest.fn()
const deleteSalesGoalMock = jest.fn()

jest.mock('@/services/dashboard/commission/sales-goal.service', () => ({
  ...jest.requireActual('@/services/dashboard/commission/sales-goal.service'),
  createSalesGoal: (...args: unknown[]) => createSalesGoalMock(...args),
  updateSalesGoal: (...args: unknown[]) => updateSalesGoalMock(...args),
  deleteSalesGoal: (...args: unknown[]) => deleteSalesGoalMock(...args),
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

// El candado white-label sólo prueba membresía + módulo; aquí pasa siempre (se prueba aparte).
jest.mock('@/middlewares/verifyAccess.middleware', () => ({
  verifyAccess: () => (req: any, _res: any, next: any) => {
    req.access = { role: req.authContext?.role }
    next()
  },
}))

import storesAnalysisRouter from '@/routes/dashboard/storesAnalysis.routes'
import organizationDashboardRoutes from '@/routes/dashboard/organizationDashboard.routes'

const ORG = 'org-pt'
const VA = 'venue-a' // la sucursal de la petición
const VB = 'venue-b' // otra tienda de la org
const ORG_DE_LA_SUCURSAL: Record<string, string> = { [VA]: ORG, [VB]: ORG, 'venue-plataforma': 'org-plataforma' }

/** Filas `StaffVenue`. */
const SUCURSAL: Array<{ staffId: string; venueId: string; role: string; active: boolean }> = [
  { staffId: 'cajero', venueId: VA, role: 'CASHIER', active: true },
  { staffId: 'promotor', venueId: VA, role: 'WAITER', active: true }, // los promotores de PlayTelecom son WAITER
  { staffId: 'hostess', venueId: VA, role: 'HOST', active: true },
  { staffId: 'cocina', venueId: VA, role: 'KITCHEN', active: true },
  { staffId: 'viewer', venueId: VA, role: 'VIEWER', active: true },
  { staffId: 'gerente', venueId: VA, role: 'MANAGER', active: true }, // el supervisor de PlayTelecom
  { staffId: 'gerente2', venueId: VA, role: 'MANAGER', active: true },
  { staffId: 'admin-suc', venueId: VA, role: 'ADMIN', active: true },
  { staffId: 'dueno-suc', venueId: VA, role: 'OWNER', active: true }, // dueño de la sucursal, NO de la org
  { staffId: 'admin-org', venueId: VA, role: 'CASHIER', active: true }, // ADMIN de la org, cajero en la tienda
  { staffId: 'baja', venueId: VA, role: 'CASHIER', active: true }, // persona dada de baja (Staff.active=false)
  { staffId: 'ex-gerente', venueId: VA, role: 'CASHIER', active: true },
  { staffId: 'ex-gerente', venueId: VB, role: 'OWNER', active: false }, // fila vieja, apagada, de rol mayor
  { staffId: 'super-1', venueId: 'venue-plataforma', role: 'SUPERADMIN', active: true },
]
/** Filas `StaffOrganization` de la org. */
const ORGANIZACION: Array<{ staffId: string; role: string; isActive: boolean }> = [
  ...['cajero', 'promotor', 'hostess', 'cocina', 'viewer', 'gerente', 'gerente2', 'admin-suc', 'dueno-suc', 'baja', 'ex-gerente'].map(
    staffId => ({ staffId, role: 'MEMBER', isActive: true }),
  ),
  { staffId: 'dueno-org', role: 'OWNER', isActive: true }, // Isaac: dueño de la org, sin fila de sucursal
  { staffId: 'admin-org', role: 'ADMIN', isActive: true },
  { staffId: 'ex-miembro', role: 'MEMBER', isActive: false }, // sacado de la org
]
const DADOS_DE_BAJA = new Set(['baja'])

/** Checadas: id → de quién y de qué sucursal. */
const CHECADAS: Record<string, { staffId: string; venueId: string }> = {
  'te-cajero': { staffId: 'cajero', venueId: VA },
  'te-gerente': { staffId: 'gerente', venueId: VA },
  'te-dueno-org': { staffId: 'dueno-org', venueId: VB },
}

function coincideRol(filtro: unknown, rol: string): boolean {
  if (filtro === undefined) return true
  if (typeof filtro === 'string') return filtro === rol
  return ((filtro as { in?: string[] }).in ?? []).includes(rol)
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/dashboard/venues/:venueId/stores-analysis', storesAnalysisRouter)
  app.use('/dashboard/organizations', organizationDashboardRoutes)
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code })
  })
  return app
}

const ROL_DEL_TOKEN: Record<string, string> = {
  cajero: 'CASHIER',
  promotor: 'WAITER',
  hostess: 'HOST',
  cocina: 'KITCHEN',
  viewer: 'VIEWER',
  gerente: 'MANAGER',
  gerente2: 'MANAGER',
  'admin-suc': 'ADMIN',
  'dueno-suc': 'OWNER',
  'dueno-org': 'OWNER',
  'super-1': 'SUPERADMIN',
}

function como(userId: string) {
  return { 'x-test-auth-context': JSON.stringify({ userId, orgId: ORG, venueId: VA, role: ROL_DEL_TOKEN[userId] ?? 'CASHIER' }) }
}

const BASE = `/dashboard/venues/${VA}/stores-analysis`

const EL_PISO = [
  ['un cajero', 'cajero'],
  ['un promotor (WAITER)', 'promotor'],
  ['una hostess', 'hostess'],
  ['cocina', 'cocina'],
  ['un viewer', 'viewer'],
] as const

function bitacora(action: string) {
  return (logAction as jest.Mock).mock.calls.map(([p]) => p).filter(p => p?.action === action)
}

beforeEach(() => {
  jest.clearAllMocks()
  createSalesGoalMock.mockResolvedValue({ id: 'g1' })
  updateSalesGoalMock.mockResolvedValue({ id: 'g1' })
  deleteSalesGoalMock.mockResolvedValue(undefined)

  prismaMock.staff.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve({ id: where?.id, active: !DADOS_DE_BAJA.has(where?.id), firstName: 'Ana', lastName: 'Prueba' })) as any)

  prismaMock.venue.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve(
      ORG_DE_LA_SUCURSAL[where?.id]
        ? { id: where.id, organizationId: ORG_DE_LA_SUCURSAL[where.id], timezone: 'America/Mexico_City' }
        : null,
    )) as any)
  prismaMock.venue.findMany.mockImplementation((({ where }: any) =>
    Promise.resolve(
      where?.organizationId === ORG
        ? [
            { id: VA, name: 'Tienda A' },
            { id: VB, name: 'Tienda B' },
          ]
        : [],
    )) as any)

  prismaMock.staffVenue.findFirst.mockImplementation((({ where }: any) => {
    const fila = SUCURSAL.find(
      f =>
        f.staffId === where?.staffId &&
        (where?.active !== true || f.active) &&
        (where?.staff?.active !== true || !DADOS_DE_BAJA.has(f.staffId)) &&
        coincideRol(where?.role, f.role) &&
        (!where?.venue?.organizationId || ORG_DE_LA_SUCURSAL[f.venueId] === where.venue.organizationId),
    )
    return Promise.resolve(fila ? { id: `sv-${fila.staffId}-${fila.venueId}`, role: fila.role } : null)
  }) as any)
  prismaMock.staffVenue.findUnique.mockImplementation((({ where }: any) => {
    const { staffId, venueId } = where?.staffId_venueId ?? {}
    const fila = SUCURSAL.find(f => f.staffId === staffId && f.venueId === venueId)
    return Promise.resolve(fila ? { role: fila.role, active: fila.active, permissionSetId: null, permissionSet: null } : null)
  }) as any)
  prismaMock.staffVenue.findMany.mockImplementation((({ where }: any) => {
    const enVenues: string[] | undefined = where?.venueId?.in
    const filas = SUCURSAL.filter(f => f.staffId === where?.staffId && (!enVenues || enVenues.includes(f.venueId)))
    return Promise.resolve(
      filas.map(f => ({ id: `sv-${f.staffId}-${f.venueId}`, ...f, venue: { name: f.venueId === VA ? 'Tienda A' : 'Tienda B' } })),
    )
  }) as any)
  prismaMock.staffVenue.upsert.mockResolvedValue({ pin: null } as any)
  prismaMock.staffVenue.update.mockResolvedValue({} as any)

  prismaMock.staffOrganization.findFirst.mockImplementation((({ where }: any) => {
    const fila = ORGANIZACION.find(
      f =>
        where?.organizationId === ORG &&
        f.staffId === where?.staffId &&
        (where?.isActive !== true || f.isActive) &&
        (where?.staff?.active !== true || !DADOS_DE_BAJA.has(f.staffId)) &&
        coincideRol(where?.role, f.role),
    )
    return Promise.resolve(fila ? { id: `so-${fila.staffId}`, role: fila.role, isActive: fila.isActive } : null)
  }) as any)
  prismaMock.staffOrganization.findUnique.mockImplementation((({ where }: any) => {
    const { staffId, organizationId } = where?.staffId_organizationId ?? {}
    const fila = organizationId === ORG ? ORGANIZACION.find(f => f.staffId === staffId) : undefined
    return Promise.resolve(fila ? { role: fila.role, isActive: fila.isActive } : null)
  }) as any)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null as any)

  prismaMock.timeEntry.findFirst.mockImplementation((({ where }: any) => {
    const checada = CHECADAS[where?.id]
    if (!checada || ORG_DE_LA_SUCURSAL[checada.venueId] !== where?.venue?.organizationId) return Promise.resolve(null)
    return Promise.resolve({ id: where.id, ...checada, validatedAt: null })
  }) as any)
  prismaMock.timeEntry.update.mockImplementation((({ where, data }: any) => Promise.resolve({ id: where.id, ...data })) as any)
  prismaMock.cashDeposit.create.mockResolvedValue({ id: 'dep-1' } as any)
  prismaMock.cashDeposit.deleteMany.mockResolvedValue({ count: 0 } as any)
})

// ─────────────────────────────────────────────────────────────────────────────
// Checadas
// ─────────────────────────────────────────────────────────────────────────────

function validarEnSucursal(userId: string, checada: string, body: Record<string, unknown> = { status: 'APPROVED', depositAmount: 150 }) {
  return request(makeApp()).post(`${BASE}/time-entry/${checada}/validate`).set(como(userId)).send(body)
}
function regresarAPendiente(userId: string, checada: string) {
  return request(makeApp()).post(`${BASE}/time-entry/${checada}/reset-validation`).set(como(userId)).send({})
}
function validarEnLaOrg(userId: string, checada: string) {
  return request(makeApp())
    .patch(`/dashboard/organizations/${ORG}/time-entries/${checada}/validate`)
    .set(como(userId))
    .send({ status: 'APPROVED' })
}

function nadaEscritoEnLaChecada() {
  expect(prismaMock.timeEntry.update).not.toHaveBeenCalled()
  expect(prismaMock.cashDeposit.create).not.toHaveBeenCalled()
  expect(prismaMock.cashDeposit.deleteMany).not.toHaveBeenCalled()
}

describe('POST .../time-entry/:id/validate (aprobar con depósito = dinero)', () => {
  it.each(EL_PISO)('🔴 %s → 403 y nada escrito (ni la checada ni el depósito)', async (_l, userId) => {
    const res = await validarEnSucursal(userId, 'te-cajero')

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('attendance:manage')
    nadaEscritoEnLaChecada()
  })

  it.each([
    ['el gerente de la sucursal (supervisor)', 'gerente'],
    ['el dueño de la organización', 'dueno-org'],
    ['el superadmin de verdad', 'super-1'],
  ])('%s aprueba la checada de otro, con su depósito, y queda en la bitácora con autor, sucursal y org', async (_l, userId) => {
    const res = await validarEnSucursal(userId, 'te-cajero')

    expect(res.status).toBe(200)
    expect(prismaMock.timeEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'te-cajero' }, data: expect.objectContaining({ validatedBy: userId }) }),
    )
    expect(prismaMock.cashDeposit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ staffId: 'cajero', approvedById: userId }) }),
    )
    expect(bitacora('TIME_ENTRY_APPROVED')).toEqual([
      expect.objectContaining({ staffId: userId, venueId: VA, organizationId: ORG, entityId: 'te-cajero' }),
    ])
  })

  it.each([
    ['🔴 el gerente NO aprueba su propia checada', 'gerente', 'te-gerente'],
    ['🔴 el dueño de la org tampoco (por persona, no por rol)', 'dueno-org', 'te-dueno-org'],
  ])('%s → 403 en español y nada escrito', async (_l, userId, checada) => {
    const res = await validarEnSucursal(userId, checada)

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('SELF_VALIDATION_FORBIDDEN')
    expect(res.body.message).toMatch(/propia checada/)
    nadaEscritoEnLaChecada()
  })
})

describe('POST .../time-entry/:id/reset-validation', () => {
  it.each(EL_PISO)('🔴 %s → 403 y nada escrito', async (_l, userId) => {
    const res = await regresarAPendiente(userId, 'te-cajero')

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('attendance:manage')
    nadaEscritoEnLaChecada()
  })

  it.each([
    ['el gerente de la sucursal', 'gerente'],
    ['el dueño de la organización', 'dueno-org'],
  ])('%s la regresa a pendiente, con autor y org en la bitácora', async (_l, userId) => {
    const res = await regresarAPendiente(userId, 'te-cajero')

    expect(res.status).toBe(200)
    expect(prismaMock.timeEntry.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'te-cajero' } }))
    expect(bitacora('TIME_ENTRY_VALIDATION_RESET')).toEqual([
      expect.objectContaining({ staffId: userId, venueId: VA, organizationId: ORG, entityId: 'te-cajero' }),
    ])
  })

  it.each([
    ['🔴 el gerente NO regresa la suya', 'gerente', 'te-gerente'],
    ['🔴 el dueño de la org tampoco', 'dueno-org', 'te-dueno-org'],
  ])('%s → 403 y nada escrito', async (_l, userId, checada) => {
    const res = await regresarAPendiente(userId, checada)

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('SELF_VALIDATION_FORBIDDEN')
    nadaEscritoEnLaChecada()
  })
})

describe('la misma regla por la puerta de la ORGANIZACIÓN (PATCH /organizations/:orgId/time-entries/:id/validate)', () => {
  it('el gerente aprueba la checada de otro', async () => {
    const res = await validarEnLaOrg('gerente', 'te-cajero')

    expect(res.status).toBe(200)
    expect(prismaMock.timeEntry.update).toHaveBeenCalled()
  })

  it.each([
    ['🔴 el gerente NO aprueba la suya', 'gerente', 'te-gerente'],
    ['🔴 el dueño de la org tampoco', 'dueno-org', 'te-dueno-org'],
  ])('%s → 403 y nada escrito', async (_l, userId, checada) => {
    const res = await validarEnLaOrg(userId, checada)

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('SELF_VALIDATION_FORBIDDEN')
    nadaEscritoEnLaChecada()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Metas por tienda
// ─────────────────────────────────────────────────────────────────────────────

const PUERTAS_DE_METAS: Array<[string, (u: string) => request.Test, () => jest.Mock, unknown[], number]> = [
  [
    'POST .../store/:storeId/goals',
    u => request(makeApp()).post(`${BASE}/store/${VB}/goals`).set(como(u)).send({ goal: 1000, goalType: 'AMOUNT', period: 'MONTHLY' }),
    () => createSalesGoalMock,
    [VB, { staffId: null, goal: 1000, goalType: 'AMOUNT', period: 'MONTHLY' }],
    201,
  ],
  [
    'PATCH .../store/:storeId/goals/:goalId',
    u => request(makeApp()).patch(`${BASE}/store/${VB}/goals/g1`).set(como(u)).send({ goal: 2000 }),
    () => updateSalesGoalMock,
    [VB, 'g1', { goal: 2000 }],
    200,
  ],
  [
    'DELETE .../store/:storeId/goals/:goalId',
    u => request(makeApp()).delete(`${BASE}/store/${VB}/goals/g1`).set(como(u)),
    () => deleteSalesGoalMock,
    [VB, 'g1'],
    200,
  ],
]

describe.each(PUERTAS_DE_METAS)('%s', (_label, pedir, servicio, argumentos, estadoSiPasa) => {
  it.each(EL_PISO)('🔴 %s → 403 en español y nada escrito', async (_l, userId) => {
    const res = await pedir(userId)

    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ success: false, error: 'insufficient_role', message: 'Se requiere rol de supervisor o superior' })
    expect(servicio()).not.toHaveBeenCalled()
  })

  it.each([
    ['el gerente (supervisor)', 'gerente'],
    ['el dueño de la organización', 'dueno-org'],
    ['el superadmin de verdad', 'super-1'],
  ])('%s sí puede, y el servicio recibe autor y org para la bitácora', async (_l, userId) => {
    const res = await pedir(userId)

    expect(res.status).toBe(estadoSiPasa)
    expect(servicio()).toHaveBeenCalledWith(...argumentos, { staffId: userId, organizationId: ORG })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Sucursales de una persona
// ─────────────────────────────────────────────────────────────────────────────

function cambiarSucursales(actor: string, staffId: string, venueIds: string[]) {
  return request(makeApp()).patch(`${BASE}/team/${staffId}/venues`).set(como(actor)).send({ venueIds })
}

function nadaEscritoEnSucursales() {
  expect(prismaMock.staffVenue.upsert).not.toHaveBeenCalled()
  expect(prismaMock.staffVenue.update).not.toHaveBeenCalled()
}

describe('PATCH .../team/:staffId/venues — el piso', () => {
  it.each(EL_PISO)('🔴 %s no le cambia las sucursales a nadie: 403 y nada escrito', async (_l, userId) => {
    const res = await cambiarSucursales(userId, 'promotor', [])

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('teams:update')
    nadaEscritoEnSucursales()
  })
})

describe('PATCH .../team/:staffId/venues — quién sí, y a quién', () => {
  it.each([
    ['el gerente (supervisor)', 'gerente'],
    ['el dueño de la organización', 'dueno-org'],
    ['el superadmin de verdad', 'super-1'],
  ])('%s le agrega la tienda B a un cajero, con autor, la sucursal tocada y la org en la bitácora', async (_l, actor) => {
    const res = await cambiarSucursales(actor, 'cajero', [VA, VB])

    expect(res.status).toBe(200)
    expect(prismaMock.staffVenue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { staffId_venueId: { staffId: 'cajero', venueId: VB } },
        create: expect.objectContaining({ role: 'CASHIER' }),
      }),
    )
    expect(bitacora('VENUE_ASSIGNED')).toEqual([
      expect.objectContaining({ staffId: actor, venueId: VB, organizationId: ORG, entityId: 'cajero' }),
    ])
  })

  it('el gerente le cambia las sucursales a otro gerente (mismo rol)', async () => {
    const res = await cambiarSucursales('gerente', 'gerente2', [VA, VB])

    expect(res.status).toBe(200)
    expect(prismaMock.staffVenue.upsert).toHaveBeenCalled()
  })

  it('quitarle una tienda es borrado SUAVE (active:false, pin:null) y queda en la bitácora', async () => {
    const res = await cambiarSucursales('dueno-org', 'cajero', [])

    expect(res.status).toBe(200)
    expect(prismaMock.staffVenue.update).toHaveBeenCalledWith({
      where: { staffId_venueId: { staffId: 'cajero', venueId: VA } },
      data: { active: false, pin: null },
    })
    expect(bitacora('VENUE_REMOVED')).toEqual([expect.objectContaining({ staffId: 'dueno-org', venueId: VA, organizationId: ORG })])
  })

  it.each([
    ['🔴 el gerente NO toca al ADMIN de la org (aunque en la tienda sea cajero)', 'gerente', 'admin-org', 'role_above'],
    ['🔴 el gerente NO toca al ADMIN de la sucursal', 'gerente', 'admin-suc', 'role_above'],
    ['🔴 el gerente NO toca a quien tuvo un rol mayor (fila apagada de OWNER)', 'gerente', 'ex-gerente', 'role_above'],
    ['🔴 el gerente NO toca al dueño de la org', 'gerente', 'dueno-org', 'owner_required'],
    ['🔴 el dueño de una SUCURSAL tampoco toca al dueño de la org', 'dueno-suc', 'dueno-org', 'owner_required'],
  ])('%s → 403 y nada escrito', async (_l, actor, objetivo, error) => {
    const res = await cambiarSucursales(actor, objetivo, [VA])

    expect(res.status).toBe(403)
    expect(res.body.error).toBe(error)
    nadaEscritoEnSucursales()
  })

  it('🔴 nadie se quita su último acceso: 409 y nada escrito', async () => {
    const res = await cambiarSucursales('gerente', 'gerente', [])

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('last_access')
    nadaEscritoEnSucursales()
  })

  it('🔴 el gerente no se da tiendas a sí mismo: 403 y nada escrito', async () => {
    const res = await cambiarSucursales('gerente', 'gerente', [VA, VB])

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('self_assignment')
    nadaEscritoEnSucursales()
  })

  it('🔴 no reactiva a alguien dado de baja (Staff.active=false): 409 y nada escrito', async () => {
    const res = await cambiarSucursales('dueno-org', 'baja', [VA, VB])

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('staff_deactivated')
    nadaEscritoEnSucursales()
  })

  it('a alguien dado de baja sí se le pueden QUITAR tiendas (sigue siendo borrado suave)', async () => {
    const res = await cambiarSucursales('dueno-org', 'baja', [])

    expect(res.status).toBe(200)
    expect(prismaMock.staffVenue.update).toHaveBeenCalledWith(expect.objectContaining({ data: { active: false, pin: null } }))
    expect(prismaMock.staffVenue.upsert).not.toHaveBeenCalled()
  })

  it('🔴 a quien ya no es de la organización: 404 y nada escrito', async () => {
    const res = await cambiarSucursales('dueno-org', 'ex-miembro', [VA])

    expect(res.status).toBe(404)
    nadaEscritoEnSucursales()
  })
})
