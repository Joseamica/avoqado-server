import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * 🔴 Crear una terminal desde el panel de la organización NO puede anexarle comercios ajenos ni saltarse el
 * candado de comercios (auditoría de Codex de la rama, 15-oct-2026, P1-1).
 *
 * `POST /organizations/:orgId/terminals` pedía supervisor (`requireOrgManager`) y nada más:
 *   · el alta busca comercios con el MISMO serial (`MerchantAccount.blumonSerialNumber`) para anexárselos solos, y
 *     esa búsqueda no filtraba por organización: con un serial de un comercio de OTRA org que no tenga fila
 *     `Terminal` —un serial VIRTUAL de Blumon, que por diseño nunca la tiene— la terminal nueva de A cobraba con
 *     el comercio de B;
 *   · `assignedMerchantIds` en el alta no pasaba por el candado que sí tiene cambiarlos después (ronda 3:
 *     dueño de la org o `system:config` en el venue de la terminal).
 *
 * Ahora la asignación inicial respeta el MISMO candado que su modificación, y lo que se anexa solo es sólo de la
 * organización y sólo si quien crea podría asignarlo a mano. El alta del superadmin (consola de superadmin) no
 * cambia: el servicio sin alcance sigue anexando por serial exacto, como siempre.
 *
 * La autorización, el servicio de la org y el alta real (`createTerminal`) corren de verdad; sólo se simulan la
 * autenticación, la capa de datos y el aviso a las terminales.
 */

const notifyAffectedTerminalsMock = jest.fn()
jest.mock('@/services/superadmin/merchantAccount.service', () => ({
  ...jest.requireActual('@/services/superadmin/merchantAccount.service'),
  notifyAffectedTerminals: (...args: unknown[]) => notifyAffectedTerminalsMock(...args),
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
import { createTerminal } from '@/services/dashboard/terminals.superadmin.service'

const ORG = 'org-a'
const VENUE_A = 'venue-a'
const VENUE_DE_B = 'venue-de-otra-org'

/** Comercios: los de la org A están en la configuración de pago de su sucursal; el de B, en la de su org. */
const COMERCIOS: Array<{ id: string; displayName: string; blumonSerialNumber: string; venueId: string; organizationId: string }> = [
  { id: 'ma-a-1', displayName: 'Tienda A', blumonSerialNumber: '2840744167', venueId: VENUE_A, organizationId: ORG },
  { id: 'ma-a-virtual', displayName: 'Tienda A (virtual)', blumonSerialNumber: '28407441672', venueId: VENUE_A, organizationId: ORG },
  { id: 'ma-b-virtual', displayName: 'Comercio de B', blumonSerialNumber: '28415486242', venueId: VENUE_DE_B, organizationId: 'org-b' },
]

const SUCURSAL: Record<string, { venueId: string; role: string }> = {
  gerente: { venueId: VENUE_A, role: 'MANAGER' },
  'dueno-sucursal': { venueId: VENUE_A, role: 'OWNER' },
  'super-1': { venueId: 'venue-plataforma', role: 'SUPERADMIN' },
}
const ORGANIZACION: Record<string, { role: string; isActive: boolean }> = {
  'dueno-org': { role: 'OWNER', isActive: true },
}

function coincideRol(filtro: unknown, rol: string): boolean {
  if (filtro === undefined) return true
  if (typeof filtro === 'string') return filtro === rol
  return ((filtro as { in?: string[] }).in ?? []).includes(rol)
}

/** ¿El comercio cumple el `where` de Prisma que manda el servicio? Sólo lo que este código usa. */
function cumple(c: (typeof COMERCIOS)[number], where: any): boolean {
  if (!where) return true
  if (where.AND && !(where.AND as any[]).every(w => cumple(c, w))) return false
  if (where.OR && !(where.OR as any[]).some(w => cumple(c, w))) return false
  if (where.id?.in && !where.id.in.includes(c.id)) return false
  if ('blumonSerialNumber' in where && where.blumonSerialNumber !== c.blumonSerialNumber) return false
  // En este fixture cada comercio cuelga sólo de la configuración PRIMARIA de su sucursal.
  if (where.venueConfigsPrimary && !(where.venueConfigsPrimary.some?.venueId?.in ?? []).includes(c.venueId)) return false
  for (const rel of ['venueConfigsSecondary', 'venueConfigsTertiary', 'orgConfigsPrimary', 'orgConfigsSecondary', 'orgConfigsTertiary']) {
    if (where[rel]) return false
  }
  return true
}

let creada: any = null

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/dashboard/organizations', organizationDashboardRoutes)
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code })
  })
  return app
}

function crear(userId: string, rol: string, body: Record<string, unknown>) {
  return request(makeApp())
    .post(`/dashboard/organizations/${ORG}/terminals`)
    .set({ 'x-test-auth-context': JSON.stringify({ userId, orgId: ORG, venueId: VENUE_A, role: rol }) })
    .send({ venueId: VENUE_A, name: 'Caja nueva', type: 'TPV_ANDROID', ...body })
}

function comerciosDeLaTerminal(): string[] {
  return creada?.assignedMerchantIds ?? []
}

beforeEach(() => {
  jest.clearAllMocks()
  creada = null
  notifyAffectedTerminalsMock.mockResolvedValue(undefined)

  prismaMock.staff.findUnique.mockResolvedValue({ active: true, firstName: 'Ana', lastName: 'Prueba' } as any)
  // checkOrgAccess / requireOrgManager / dueño de la org / superadmin real
  prismaMock.staffVenue.findFirst.mockImplementation((({ where }: any) => {
    const fila = SUCURSAL[where?.staffId]
    if (!fila || !coincideRol(where?.role, fila.role)) return Promise.resolve(null)
    if (where?.venue?.organizationId && (where.venue.organizationId !== ORG || fila.role === 'SUPERADMIN')) return Promise.resolve(null)
    return Promise.resolve({ id: `sv-${where.staffId}`, role: fila.role })
  }) as any)
  prismaMock.staffOrganization.findFirst.mockImplementation((({ where }: any) => {
    const fila = ORGANIZACION[where?.staffId]
    if (!fila || where?.organizationId !== ORG || !coincideRol(where?.role, fila.role)) return Promise.resolve(null)
    return Promise.resolve({ id: `so-${where.staffId}`, role: fila.role })
  }) as any)
  prismaMock.staffVenue.findUnique.mockImplementation((({ where }: any) => {
    const { staffId, venueId } = where?.staffId_venueId ?? {}
    const fila = SUCURSAL[staffId]
    return Promise.resolve(
      fila && fila.venueId === venueId ? { role: fila.role, active: true, permissionSetId: null, permissionSet: null } : null,
    )
  }) as any)
  prismaMock.staffOrganization.findUnique.mockImplementation((({ where }: any) => {
    const { staffId } = where?.staffId_organizationId ?? {}
    const fila = ORGANIZACION[staffId]
    return Promise.resolve(fila ? { role: fila.role, isActive: fila.isActive } : null)
  }) as any)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)

  // Sucursales y comercios
  prismaMock.venue.findFirst.mockImplementation((({ where }: any) =>
    Promise.resolve(where?.id === VENUE_A && where?.organizationId === ORG ? { id: VENUE_A, name: 'Tienda A' } : null)) as any)
  prismaMock.venue.findMany.mockImplementation((({ where }: any) =>
    Promise.resolve(where?.organizationId === ORG ? [{ id: VENUE_A }] : [])) as any)
  prismaMock.venue.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve({ id: where?.id, organizationId: where?.id === VENUE_DE_B ? 'org-b' : ORG })) as any)
  prismaMock.merchantAccount.findMany.mockImplementation((({ where }: any) =>
    Promise.resolve(
      COMERCIOS.filter(c => cumple(c, where) && (where?.active === undefined || where.active === true)).map(c => ({
        id: c.id,
        displayName: c.displayName,
        provider: { code: 'BLUMON' },
      })),
    )) as any)
  prismaMock.merchantAccount.count.mockImplementation((({ where }: any) =>
    Promise.resolve(COMERCIOS.filter(c => cumple(c, where)).length)) as any)

  // El alta
  prismaMock.terminal.findFirst.mockResolvedValue(null) // el serial no existe todavía
  prismaMock.terminal.create.mockImplementation((({ data }: any) => {
    creada = { id: 'terminal-nueva', ...data, venue: { id: VENUE_A, name: 'Tienda A', slug: 'tienda-a' } }
    return Promise.resolve({ ...creada })
  }) as any)
  prismaMock.terminal.update.mockImplementation((({ data }: any) => {
    if (data?.assignedMerchantIds?.push) creada.assignedMerchantIds = [...creada.assignedMerchantIds, ...data.assignedMerchantIds.push]
    return Promise.resolve({ ...creada })
  }) as any)
})

describe('lo que el alta anexa SOLA por serial', () => {
  it('🔴 el caso de Codex: un serial VIRTUAL de un comercio de OTRA organización no se anexa', async () => {
    const res = await crear('dueno-org', 'OWNER', { serialNumber: '28415486242' })

    expect(res.status).toBe(201)
    expect(comerciosDeLaTerminal()).toEqual([])
    expect(res.body.data.autoAttachedMerchants).toEqual([])
    expect(notifyAffectedTerminalsMock).not.toHaveBeenCalled()
  })

  it('el dueño de la org: el serial virtual de un comercio de SU organización sí se anexa (match exacto)', async () => {
    const res = await crear('dueno-org', 'OWNER', { serialNumber: '28407441672' })

    expect(res.status).toBe(201)
    expect(comerciosDeLaTerminal()).toEqual(['ma-a-virtual'])
  })

  it('🔴 un gerente (sin el candado de comercios) crea la terminal, pero NO se le anexa ningún comercio', async () => {
    const res = await crear('gerente', 'MANAGER', { serialNumber: '2840744167' })

    expect(res.status).toBe(201)
    expect(comerciosDeLaTerminal()).toEqual([])
    expect(notifyAffectedTerminalsMock).not.toHaveBeenCalled()
  })

  it('el match es EXACTO: un serial que sólo se parece (sin el dígito virtual) no anexa el virtual', async () => {
    const res = await crear('dueno-org', 'OWNER', { serialNumber: '2841548624' })

    expect(res.status).toBe(201)
    expect(comerciosDeLaTerminal()).toEqual([])
  })
})

describe('assignedMerchantIds en el alta: el MISMO candado que cambiarlos después', () => {
  it.each([
    ['🔴 el gerente', 'gerente', 'MANAGER'],
    ['🔴 el OWNER de la sucursal que no es dueño de la org', 'dueno-sucursal', 'OWNER'],
  ])('%s → 403 en español, bitácora y nada creado', async (_l, userId, rol) => {
    const res = await crear(userId, rol, { serialNumber: 'N860W000001', assignedMerchantIds: ['ma-a-1'] })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ORG_OWNER_REQUIRED')
    expect(res.body.message).toMatch(/comercios/)
    expect(prismaMock.terminal.create).not.toHaveBeenCalled()
    expect((logAction as jest.Mock).mock.calls.filter(([p]) => p?.action === 'PERMISSION_DENIED')).toHaveLength(1)
  })

  it('el dueño de la org sí la crea con comercios de su organización', async () => {
    const res = await crear('dueno-org', 'OWNER', { serialNumber: 'N860W000001', assignedMerchantIds: ['ma-a-1'] })

    expect(res.status).toBe(201)
    expect(comerciosDeLaTerminal()).toEqual(['ma-a-1'])
  })

  it('🔴 ni el dueño de la org le pone un comercio de OTRA organización (403, nada creado)', async () => {
    const res = await crear('dueno-org', 'OWNER', { serialNumber: 'N860W000001', assignedMerchantIds: ['ma-b-virtual'] })

    expect(res.status).toBe(403)
    expect(prismaMock.terminal.create).not.toHaveBeenCalled()
  })

  it('regresión: el gerente sigue creando una terminal SIN comercios', async () => {
    const res = await crear('gerente', 'MANAGER', { serialNumber: 'N860W000001' })

    expect(res.status).toBe(201)
    expect(prismaMock.terminal.create).toHaveBeenCalled()
  })
})

describe('regresión: el alta del SUPERADMIN (servicio sin alcance de organización) no cambia', () => {
  it('sigue anexando por serial exacto, como siempre', async () => {
    const r = await createTerminal({ venueId: VENUE_A, serialNumber: '28415486242', name: 'Caja', type: 'TPV_ANDROID', staffId: 'super-1' })

    expect(r.autoAttachedMerchants.map(m => m.id)).toEqual(['ma-b-virtual'])
  })
})
