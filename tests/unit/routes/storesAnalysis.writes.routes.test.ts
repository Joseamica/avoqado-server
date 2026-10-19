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
import organizationConfigRoutes from '@/routes/dashboard/organizationConfig.routes'
import { organizationDashboardService } from '@/services/organization-dashboard/organizationDashboard.service'

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
  { staffId: 'dueno-org-cajero', venueId: VA, role: 'CASHIER', active: true }, // dueño de la org con una fila MENOR en la tienda
]
/** Filas `StaffOrganization` de la org. */
const ORGANIZACION: Array<{ staffId: string; role: string; isActive: boolean }> = [
  ...['cajero', 'promotor', 'hostess', 'cocina', 'viewer', 'gerente', 'gerente2', 'admin-suc', 'dueno-suc', 'baja', 'ex-gerente'].map(
    staffId => ({ staffId, role: 'MEMBER', isActive: true }),
  ),
  { staffId: 'dueno-org', role: 'OWNER', isActive: true }, // Isaac: dueño de la org, sin fila de sucursal
  { staffId: 'admin-org', role: 'ADMIN', isActive: true },
  { staffId: 'ex-miembro', role: 'MEMBER', isActive: false }, // sacado de la org
  { staffId: 'dueno-org-cajero', role: 'OWNER', isActive: true },
  { staffId: 'ex-dueno-org', role: 'OWNER', isActive: false }, // fue dueño de la org; su fila ya está apagada
  { staffId: 'dueno-org-baja', role: 'OWNER', isActive: true }, // fila de dueño viva, pero la persona está dada de baja
]
const DADOS_DE_BAJA = new Set(['baja', 'dueno-org-baja'])

/** Checadas: id → de quién y de qué sucursal. */
let ESTADO: Record<
  string,
  { id: string; staffId: string; venueId: string; validationStatus: string; validatedAt: Date | null; validatedBy: string | null }
> = {}
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
  app.use('/dashboard/organizations/:orgId', organizationConfigRoutes)
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
  'dueno-org-cajero': 'CASHIER',
  'ex-dueno-org': 'OWNER', // el token se emitió cuando todavía lo era
  'dueno-org-baja': 'OWNER',
}

/** `VenueRolePermission` por `venueId:rol` (lo que el negocio personalizó); se cambia por prueba. */
let PERSONALIZACION: Record<string, { permissions: string[]; deniedPermissions: string[] }> = {}

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
    // La org puede venir directa o por el venue (`organization.venues.some.id`, el resolutor de rol, P2-6).
    const orgPedida = where?.organizationId ?? ORG_DE_LA_SUCURSAL[where?.organization?.venues?.some?.id]
    const fila = ORGANIZACION.find(
      f =>
        orgPedida === ORG &&
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
  PERSONALIZACION = {}
  prismaMock.venueRolePermission.findUnique.mockImplementation((({ where }: any) => {
    const { venueId, role } = where?.venueId_role ?? {}
    return Promise.resolve(PERSONALIZACION[`${venueId}:${role}`] ?? null)
  }) as any)

  // Estado de cada checada en la «base»: la transición atómica (`updateMany` con el estado previo en el
  // `where`) sólo escribe si la fila sigue en ese estado, como Postgres.
  ESTADO = Object.fromEntries(
    Object.entries(CHECADAS).map(([id, c]) => [
      id,
      { id, ...c, validationStatus: 'PENDING', validatedAt: null as Date | null, validatedBy: null as string | null },
    ]),
  )
  prismaMock.timeEntry.findFirst.mockImplementation((({ where }: any) => {
    const checada = ESTADO[where?.id]
    if (!checada || ORG_DE_LA_SUCURSAL[checada.venueId] !== where?.venue?.organizationId) return Promise.resolve(null)
    return Promise.resolve({ ...checada })
  }) as any)
  prismaMock.timeEntry.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve(ESTADO[where?.id] ? { ...ESTADO[where.id] } : null)) as any)
  prismaMock.timeEntry.updateMany.mockImplementation((({ where, data }: any) => {
    const checada = ESTADO[where?.id]
    const mismaFecha = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null)
    if (
      !checada ||
      (where?.validationStatus !== undefined && checada.validationStatus !== where.validationStatus) ||
      ('validatedAt' in (where ?? {}) && !mismaFecha(checada.validatedAt, where.validatedAt)) ||
      ('validatedBy' in (where ?? {}) && checada.validatedBy !== where.validatedBy)
    ) {
      return Promise.resolve({ count: 0 })
    }
    Object.assign(checada, data)
    return Promise.resolve({ count: 1 })
  }) as any)
  prismaMock.timeEntry.update.mockImplementation((({ where, data }: any) => {
    if (ESTADO[where?.id]) Object.assign(ESTADO[where.id], data)
    return Promise.resolve({ id: where.id, ...data })
  }) as any)
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
  expect(prismaMock.timeEntry.updateMany).not.toHaveBeenCalled()
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
    expect(prismaMock.timeEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'te-cajero', validationStatus: 'PENDING' },
        data: expect.objectContaining({ validatedBy: userId }),
      }),
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
    // Regresar a pendiente es un CAS sobre la validación leída (ronda 8).
    expect(prismaMock.timeEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'te-cajero', validationStatus: 'PENDING' }) }),
    )
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
    expect(prismaMock.timeEntry.updateMany).toHaveBeenCalled()
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

// ─────────────────────────────────────────────────────────────────────────────
// P2-6 (Codex, 15-oct): el dueño de la ORGANIZACIÓN con una fila MENOR en la tienda
// ─────────────────────────────────────────────────────────────────────────────

describe('el dueño de la organización que además es CAJERO en la tienda', () => {
  it('🔴 checkPermission lo trata como OWNER, igual que getUserAccess: valida checadas ajenas (attendance:manage)', async () => {
    const res = await validarEnSucursal('dueno-org-cajero', 'te-cajero')

    expect(res.status).toBe(200)
    expect(prismaMock.cashDeposit.create).toHaveBeenCalledTimes(1)
  })

  it('🔴 …y cambia las sucursales de un cajero (teams:update)', async () => {
    const res = await cambiarSucursales('dueno-org-cajero', 'cajero', [VA, VB])

    expect(res.status).toBe(200)
    expect(prismaMock.staffVenue.upsert).toHaveBeenCalled()
  })

  it('conserva las exclusiones del negocio para el rol OWNER: si la tienda le quitó attendance:manage al OWNER, 403', async () => {
    PERSONALIZACION[`${VA}:OWNER`] = { permissions: [], deniedPermissions: ['attendance:manage'] }

    const res = await validarEnSucursal('dueno-org-cajero', 'te-cajero')

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('attendance:manage')
    nadaEscritoEnLaChecada()
  })

  it('regresión: un cajero que NO es dueño de la org sigue siendo cajero (403)', async () => {
    const res = await validarEnSucursal('cajero', 'te-gerente')

    expect(res.status).toBe(403)
    nadaEscritoEnLaChecada()
  })

  it('regresión: el ADMIN de la org con fila de cajero NO sube a OWNER (sólo el dueño tiene precedencia)', async () => {
    const res = await validarEnSucursal('admin-org', 'te-cajero')

    expect(res.status).toBe(403)
    nadaEscritoEnLaChecada()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// P1-5 (Codex, 15-oct): repetir una aprobación con depósito creaba DOS depósitos aprobados
// ─────────────────────────────────────────────────────────────────────────────

describe('aprobar es idempotente: la repetición no crea otro depósito', () => {
  it('🔴 por la puerta de la sucursal: la misma aprobación con $150 dos veces → un solo depósito, y la 2ª responde la checada ya aprobada', async () => {
    const primera = await validarEnSucursal('gerente', 'te-cajero')
    const segunda = await validarEnSucursal('gerente', 'te-cajero')

    expect(primera.status).toBe(200)
    expect(segunda.status).toBe(200)
    expect(segunda.body.data).toMatchObject({ id: 'te-cajero', validationStatus: 'APPROVED', validatedBy: 'gerente' })
    expect(prismaMock.cashDeposit.create).toHaveBeenCalledTimes(1)
    // La repetición no es otra aprobación: un solo asiento en la bitácora.
    expect(bitacora('TIME_ENTRY_APPROVED')).toHaveLength(1)
  })

  it('🔴 dos supervisores distintos aprobando la misma checada: un solo depósito, a nombre del primero', async () => {
    await validarEnSucursal('gerente', 'te-cajero')
    const segunda = await validarEnSucursal('dueno-org', 'te-cajero')

    expect(segunda.status).toBe(200)
    expect(segunda.body.data.validatedBy).toBe('gerente')
    expect(prismaMock.cashDeposit.create).toHaveBeenCalledTimes(1)
  })

  it('🔴 por la puerta de la organización la repetición tampoco escribe de nuevo', async () => {
    await validarEnLaOrg('gerente', 'te-cajero')
    const segunda = await validarEnLaOrg('gerente', 'te-cajero')

    expect(segunda.status).toBe(200)
    expect(prismaMock.timeEntry.updateMany).toHaveBeenCalledTimes(2) // la 2ª intenta la transición y no ocurre
    expect(ESTADO['te-cajero'].validationStatus).toBe('APPROVED')
    expect(bitacora('TIME_ENTRY_APPROVED')).toHaveLength(1)
  })

  it('🔴 aprobar una checada ya RECHAZADA (sin regresarla a pendiente) → 409 en español y ni depósito ni cambio', async () => {
    await validarEnSucursal('gerente', 'te-cajero', { status: 'REJECTED' })
    const res = await validarEnSucursal('gerente', 'te-cajero')

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TIME_ENTRY_ALREADY_VALIDATED')
    expect(res.body.message).toMatch(/pendiente/)
    expect(ESTADO['te-cajero'].validationStatus).toBe('REJECTED')
    expect(prismaMock.cashDeposit.create).not.toHaveBeenCalled()
  })

  it('regresión: regresarla a pendiente y volver a aprobar sí crea el depósito nuevo (el viejo lo borra el reinicio)', async () => {
    await validarEnSucursal('gerente', 'te-cajero')
    await regresarAPendiente('gerente', 'te-cajero')
    const res = await validarEnSucursal('gerente', 'te-cajero')

    expect(res.status).toBe(200)
    expect(prismaMock.cashDeposit.create).toHaveBeenCalledTimes(2)
    expect(prismaMock.cashDeposit.deleteMany).toHaveBeenCalledTimes(1)
  })

  it('regresión: rechazar no crea depósito aunque traiga monto', async () => {
    const res = await validarEnSucursal('gerente', 'te-cajero', { status: 'REJECTED', depositAmount: 150 })

    expect(res.status).toBe(200)
    expect(prismaMock.cashDeposit.create).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// P1-4 (Codex, 15-oct): la OTRA puerta — PATCH /organizations/:orgId/team/:staffId/venues
// ─────────────────────────────────────────────────────────────────────────────

/**
 * El panel de la organización tiene su propia ruta para lo mismo, con otro `requireOrgOwner` que acepta ser
 * OWNER de UNA sucursal y sin ninguna de las reglas de arriba: el dueño de la tienda A se agregaba la B como
 * OWNER (200). Ahora las dos puertas usan la MISMA función (`revisarCambioDeSucursales`).
 */
describe('PATCH /organizations/:orgId/team/:staffId/venues — las mismas reglas que la puerta de la sucursal', () => {
  function cambiarPorLaOrg(actor: string, staffId: string, venueIds: string[]) {
    return request(makeApp()).patch(`/dashboard/organizations/${ORG}/team/${staffId}/venues`).set(como(actor)).send({ venueIds })
  }

  beforeEach(() => {
    // Revisiones de seguridad de la ruta al quitar sucursales (turno abierto, corte abierto): no hay ninguno.
    prismaMock.timeEntry.findMany.mockResolvedValue([] as any)
    prismaMock.shift.findMany.mockResolvedValue([] as any)
  })

  it('🔴 el caso de Codex: el dueño de UNA sucursal no se agrega otra a sí mismo → 403 y nada escrito', async () => {
    const res = await cambiarPorLaOrg('dueno-suc', 'dueno-suc', [VA, VB])

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('self_assignment')
    nadaEscritoEnSucursales()
  })

  it('🔴 el dueño de una sucursal no toca al dueño de la organización → 403', async () => {
    const res = await cambiarPorLaOrg('dueno-suc', 'dueno-org', [VA])

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('owner_required')
    nadaEscritoEnSucursales()
  })

  it('🔴 nadie se quita su último acceso → 409', async () => {
    const res = await cambiarPorLaOrg('dueno-suc', 'dueno-suc', [])

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('last_access')
    nadaEscritoEnSucursales()
  })

  it('🔴 no le devuelve sucursales a quien está dado de baja → 409', async () => {
    const res = await cambiarPorLaOrg('dueno-suc', 'baja', [VA, VB])

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('staff_deactivated')
    nadaEscritoEnSucursales()
  })

  it('🔴 a quien ya no es de la organización: 404 y nada escrito (antes el upsert le creaba filas)', async () => {
    const res = await cambiarPorLaOrg('dueno-suc', 'ex-miembro', [VA])

    expect(res.status).toBe(404)
    nadaEscritoEnSucursales()
  })

  it('el dueño de una sucursal sí le agrega la tienda B a un cajero, con autor y org en la bitácora', async () => {
    const res = await cambiarPorLaOrg('dueno-suc', 'cajero', [VA, VB])

    expect(res.status).toBe(200)
    expect(prismaMock.staffVenue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { staffId_venueId: { staffId: 'cajero', venueId: VB } } }),
    )
    expect(bitacora('VENUE_ASSIGNED')).toEqual([
      expect.objectContaining({ staffId: 'dueno-suc', venueId: VB, organizationId: ORG, entityId: 'cajero' }),
    ])
  })

  it('el superadmin de verdad sí cambia las sucursales del dueño de la org', async () => {
    const res = await cambiarPorLaOrg('super-1', 'dueno-org', [VA])

    expect(res.status).toBe(200)
    expect(prismaMock.staffVenue.upsert).toHaveBeenCalled()
  })

  it('quitarle una tienda sigue siendo borrado suave, con autor y org en la bitácora', async () => {
    const res = await cambiarPorLaOrg('dueno-suc', 'cajero', [])

    expect(res.status).toBe(200)
    expect(prismaMock.staffVenue.update).toHaveBeenCalledWith({
      where: { staffId_venueId: { staffId: 'cajero', venueId: VA } },
      data: { active: false, pin: null },
    })
    expect(bitacora('VENUE_REMOVED')).toEqual([expect.objectContaining({ staffId: 'dueno-suc', venueId: VA, organizationId: ORG })])
  })

  it('regresión: un gerente no pasa la puerta de la org (sigue siendo de dueño) → 403', async () => {
    const res = await cambiarPorLaOrg('gerente', 'cajero', [VA, VB])

    expect(res.status).toBe(403)
    nadaEscritoEnSucursales()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Ronda 8 (Codex r2, 16-oct): un «deshacer» ATRASADO duplicaba depósitos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `resetTimeEntryValidation` leía la checada ANTES de la transacción y escribía PENDING sin comprobar que siguiera
 * siendo la misma validación. La secuencia de Codex: dos «deshacer» leen la checada rechazada → el primero termina →
 * se aprueba ($150) → el segundo, tarde, la regresa a PENDING (y borra por la fecha VIEJA, así que no toca el depósito
 * nuevo) → se aprueba otra vez ($300). Ahora la vuelta a pendiente es un CAS sobre el estado Y la marca de la
 * validación que se leyó; si no coincide, 409 y no se borra nada.
 */
describe('regresar a pendiente es un CAS sobre la validación que se leyó', () => {
  it('🔴 la secuencia de Codex: el «deshacer» atrasado → 409, nada borrado, y la re-aprobación NO crea un segundo depósito', async () => {
    await validarEnSucursal('gerente', 'te-cajero', { status: 'REJECTED' })
    const lecturaVieja = { ...ESTADO['te-cajero'] } // lo que leyó el segundo «deshacer» antes de que pasara nada

    const primero = await regresarAPendiente('gerente', 'te-cajero')
    const aprobacion = await validarEnSucursal('gerente', 'te-cajero') // $150
    prismaMock.timeEntry.findFirst.mockImplementationOnce((() => Promise.resolve({ ...lecturaVieja })) as any)
    const segundo = await regresarAPendiente('gerente', 'te-cajero')
    const reaprobacion = await validarEnSucursal('gerente', 'te-cajero')

    expect(primero.status).toBe(200)
    expect(aprobacion.status).toBe(200)
    expect(segundo.status).toBe(409)
    expect(segundo.body.code).toBe('TIME_ENTRY_CHANGED')
    expect(segundo.body.message).toMatch(/cambió/)
    expect(ESTADO['te-cajero'].validationStatus).toBe('APPROVED')
    expect(prismaMock.cashDeposit.deleteMany).toHaveBeenCalledTimes(1) // sólo el primer «deshacer»
    expect(reaprobacion.status).toBe(200) // repetición idempotente de la ronda 7
    expect(prismaMock.cashDeposit.create).toHaveBeenCalledTimes(1) // $150, no $300
    expect(bitacora('TIME_ENTRY_VALIDATION_RESET')).toHaveLength(1)
  })

  it('🔴 dos «deshacer» de la misma aprobación (doble clic, o el reintento de red): el segundo no vuelve a borrar', async () => {
    await validarEnSucursal('gerente', 'te-cajero')
    const lecturaVieja = { ...ESTADO['te-cajero'] }

    const primero = await regresarAPendiente('gerente', 'te-cajero')
    prismaMock.timeEntry.findFirst.mockImplementationOnce((() => Promise.resolve({ ...lecturaVieja })) as any)
    const segundo = await regresarAPendiente('gerente', 'te-cajero')

    expect(primero.status).toBe(200)
    // Ya quedó en pendiente: es una repetición, se responde como está, sin borrar ni otro asiento.
    expect(segundo.status).toBe(200)
    expect(segundo.body.data.validationStatus).toBe('PENDING')
    expect(prismaMock.cashDeposit.deleteMany).toHaveBeenCalledTimes(1)
    expect(bitacora('TIME_ENTRY_VALIDATION_RESET')).toHaveLength(1)
  })

  it('regresión: un «deshacer» normal regresa a pendiente y borra el depósito de esa aprobación', async () => {
    await validarEnSucursal('gerente', 'te-cajero')

    const res = await regresarAPendiente('gerente', 'te-cajero')

    expect(res.status).toBe(200)
    expect(ESTADO['te-cajero']).toMatchObject({ validationStatus: 'PENDING', validatedAt: null, validatedBy: null })
    expect(prismaMock.cashDeposit.deleteMany).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Valores por defecto de TPV de la organización (17-oct): sólo el dueño de la org
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `PUT …/org-tpv-defaults` guarda los ajustes de TPV de la organización y los EMPUJA a todas las terminales de
 * todas sus sucursales (cobro con tarjeta incluido). Las dos puertas lo dejaban al dueño de UNA sucursal: la de la
 * sucursal con `requireOwnerPlus` (OWNER del token/acceso) y la de la org con el `requireOrgOwner` que acepta ser
 * OWNER de cualquier tienda. Ahora las dos piden la regla estrecha `esDuenoDeEstaOrganizacionOSuperadmin`: fila
 * ACTIVA de dueño de ESTA org, de una persona activa, o un superadmin de verdad. Leer (GET y /stats) no cambia.
 */
describe('PUT org-tpv-defaults — sólo el dueño de la organización (las dos puertas)', () => {
  const AJUSTES = { enableCardPayments: false, requireAvoqadoServerForCardPayment: false }
  const MENSAJE = 'Sólo el dueño de la organización puede cambiar los valores por defecto de todas las terminales. Pídeselo al dueño.'
  const PUERTAS = [
    ['la puerta de la sucursal', `${BASE}/org-tpv-defaults`],
    ['la puerta de la organización', `/dashboard/organizations/${ORG}/org-tpv-defaults`],
  ] as const

  let guardar: jest.SpyInstance
  let leer: jest.SpyInstance
  let contar: jest.SpyInstance
  beforeEach(() => {
    guardar = jest.spyOn(organizationDashboardService, 'upsertOrgTpvDefaults').mockResolvedValue({ config: AJUSTES, terminalsUpdated: 3 })
    leer = jest.spyOn(organizationDashboardService, 'getOrgTpvDefaults').mockResolvedValue(AJUSTES)
    contar = jest.spyOn(organizationDashboardService, 'getOrgTpvStats').mockResolvedValue({ totalTerminals: 3, venues: [] } as any)
  })
  afterEach(() => {
    guardar.mockRestore()
    leer.mockRestore()
    contar.mockRestore()
  })

  function guardarPor(ruta: string, actor: string) {
    return request(makeApp()).put(ruta).set(como(actor)).send({ settings: AJUSTES })
  }

  describe.each(PUERTAS)('%s', (_puerta, ruta) => {
    it.each([
      ['🔴 el dueño de UNA sucursal que no es dueño de la org', 'dueno-suc'],
      ['🔴 quien fue dueño de la org (fila apagada)', 'ex-dueno-org'],
      ['🔴 el dueño de la org dado de baja (persona inactiva)', 'dueno-org-baja'],
    ])('%s → 403 en español, con código, nada escrito y la negativa en la bitácora', async (_l, actor) => {
      const res = await guardarPor(ruta, actor)

      expect(res.status).toBe(403)
      expect(res.body.message).toBe(MENSAJE)
      expect(res.body.code).toBe('ORG_OWNER_REQUIRED')
      expect(guardar).not.toHaveBeenCalled()
      expect(prismaMock.organizationAttendanceConfig.upsert).not.toHaveBeenCalled()
      expect(prismaMock.terminal.updateMany).not.toHaveBeenCalled()
      expect(bitacora('PERMISSION_DENIED')).toEqual([
        expect.objectContaining({ staffId: actor, organizationId: ORG, entity: 'organization-owner', entityId: 'ORG_TPV_DEFAULTS' }),
      ])
    })

    it.each([
      ['el dueño de la org', 'dueno-org'],
      ['el superadmin de verdad', 'super-1'],
    ])('%s sí guarda, y el servicio recibe quién lo hizo', async (_l, actor) => {
      const res = await guardarPor(ruta, actor)

      expect(res.status).toBe(200)
      expect(res.body.data.terminalsUpdated).toBe(3)
      // La puerta de la sucursal pasa además SU sucursal, para que el asiento salga en la bitácora de esa tienda.
      const sucursal = ruta.startsWith(BASE) ? [VA] : []
      expect(guardar).toHaveBeenCalledWith(ORG, AJUSTES, actor, ...sucursal)
      expect(bitacora('PERMISSION_DENIED')).toEqual([])
    })

    it.each([
      ['GET', ''],
      ['GET', '/stats'],
    ])('regresión: leer (%s%s) sigue abierto al dueño de una sucursal', async (_m, sufijo) => {
      const res = await request(makeApp()).get(`${ruta}${sufijo}`).set(como('dueno-suc'))

      expect(res.status).toBe(200)
      expect(sufijo ? contar : leer).toHaveBeenCalledWith(ORG)
    })
  })

  it('el dueño de la org que además es CAJERO en una tienda sigue siendo el dueño (puerta de la org)', async () => {
    const res = await guardarPor(`/dashboard/organizations/${ORG}/org-tpv-defaults`, 'dueno-org-cajero')

    expect(res.status).toBe(200)
    expect(guardar).toHaveBeenCalledWith(ORG, AJUSTES, 'dueno-org-cajero')
  })

  it('🔴 la consulta de dueño mira ESTA org, la fila activa, el rol OWNER y la persona activa', async () => {
    await guardarPor(`${BASE}/org-tpv-defaults`, 'dueno-suc')

    expect(prismaMock.staffOrganization.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { staffId: 'dueno-suc', organizationId: ORG, isActive: true, role: 'OWNER', staff: { active: true } },
      }),
    )
  })
})

/**
 * Ronda 2 (17-oct): el mismo hueco sobre el MISMO dato. `org-attendance-config` escribe la fila
 * `OrganizationAttendanceConfig` (checador, cobro en efectivo/tarjeta, escáner, cambaceo — y su `settings` es el JSON
 * de TPV de arriba, que las terminales heredan) y su DELETE la borra entera. Las dos puertas se la dejaban al dueño
 * de UNA tienda. Ahora: la misma regla estrecha. Leer (GET) no cambia.
 */
describe('PUT/DELETE org-attendance-config — sólo el dueño de la organización (las dos puertas)', () => {
  const CUERPO = { attendanceTracking: true, enableCardPayments: false }
  const MENSAJE =
    'Sólo el dueño de la organización puede cambiar la configuración de checador y terminales de todas las sucursales. Pídeselo al dueño.'
  const ORG_BASE = `/dashboard/organizations/${ORG}`
  const ESCRITURAS = [
    ['PUT por la sucursal', 'put', `${BASE}/org-attendance-config`],
    ['DELETE por la sucursal', 'delete', `${BASE}/org-attendance-config`],
    ['PUT por la organización', 'put', `${ORG_BASE}/org-attendance-config`],
    ['DELETE por la organización', 'delete', `${ORG_BASE}/org-attendance-config`],
  ] as const

  let guardar: jest.SpyInstance
  let borrar: jest.SpyInstance
  let leer: jest.SpyInstance
  beforeEach(() => {
    guardar = jest.spyOn(organizationDashboardService, 'upsertOrgAttendanceConfig').mockResolvedValue({ id: 'cfg-1' } as any)
    borrar = jest.spyOn(organizationDashboardService, 'deleteOrgAttendanceConfig').mockResolvedValue(undefined)
    leer = jest.spyOn(organizationDashboardService, 'getOrgAttendanceConfig').mockResolvedValue({ id: 'cfg-1' } as any)
  })
  afterEach(() => {
    guardar.mockRestore()
    borrar.mockRestore()
    leer.mockRestore()
  })

  function escribir(metodo: 'put' | 'delete', ruta: string, actor: string) {
    const r = request(makeApp())[metodo](ruta).set(como(actor))
    return metodo === 'put' ? r.send(CUERPO) : r
  }

  describe.each(ESCRITURAS)('%s', (_l, metodo, ruta) => {
    it.each([
      ['🔴 el dueño de UNA sucursal que no es dueño de la org', 'dueno-suc'],
      ['🔴 quien fue dueño de la org (fila apagada)', 'ex-dueno-org'],
      ['🔴 el dueño de la org dado de baja (persona inactiva)', 'dueno-org-baja'],
    ])('%s → 403 en español, con código, nada escrito y la negativa en la bitácora', async (_a, actor) => {
      const res = await escribir(metodo, ruta, actor)

      expect(res.status).toBe(403)
      expect(res.body.message).toBe(MENSAJE)
      expect(res.body.code).toBe('ORG_OWNER_REQUIRED')
      expect(guardar).not.toHaveBeenCalled()
      expect(borrar).not.toHaveBeenCalled()
      expect(prismaMock.organizationAttendanceConfig.upsert).not.toHaveBeenCalled()
      expect(prismaMock.organizationAttendanceConfig.deleteMany).not.toHaveBeenCalled()
      expect(bitacora('PERMISSION_DENIED')).toEqual([
        expect.objectContaining({ staffId: actor, organizationId: ORG, entity: 'organization-owner', entityId: 'ORG_ATTENDANCE_CONFIG' }),
      ])
    })

    it.each([
      ['el dueño de la org', 'dueno-org'],
      ['el superadmin de verdad', 'super-1'],
    ])('%s sí escribe, y el servicio recibe quién lo hizo', async (_a, actor) => {
      const res = await escribir(metodo, ruta, actor)

      expect(res.status).toBe(200)
      const sucursal = ruta.startsWith(BASE) ? [VA] : []
      if (metodo === 'put') expect(guardar).toHaveBeenCalledWith(ORG, CUERPO, actor, ...sucursal)
      else expect(borrar).toHaveBeenCalledWith(ORG, actor, ...sucursal)
      expect(bitacora('PERMISSION_DENIED')).toEqual([])
    })
  })

  it.each([
    ['la puerta de la sucursal', `${BASE}/org-attendance-config`],
    ['la puerta de la organización', `${ORG_BASE}/org-attendance-config`],
  ])('regresión: leer por %s sigue abierto al dueño de una sucursal', async (_l, ruta) => {
    const res = await request(makeApp()).get(ruta).set(como('dueno-suc'))

    expect(res.status).toBe(200)
    expect(leer).toHaveBeenCalledWith(ORG)
  })
})
