import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * 🔴 Con qué COMERCIOS cobra una terminal (a dónde va el dinero), desde el panel de la organización.
 *
 * Dos puertas sólo pedían ser MIEMBRO activo de la organización (`checkOrgAccess`):
 *   · `PUT   /organizations/:orgId/terminals/:terminalId/merchants`  (`merchantIds`)
 *   · `PATCH /organizations/:orgId/terminals/:terminalId`            (`assignedMerchantIds`)
 * Un cajero de cualquier sucursal reasignaba los comercios de cualquier terminal de la org.
 *
 * La regla: «la ruta de la organización nunca concede más de lo que concedería la ruta del negocio».
 * Pasa el dueño de la organización (la regla de `requireOrgOwner`) o quien tenga, EN EL VENUE DE LA
 * TERMINAL, el permiso de la ruta del negocio que cambia los comercios de sus terminales:
 * `PUT /venues/:venueId/payment-config/:configId` → `system:config`. (La edición de terminal del
 * negocio, `PUT /venues/:venueId/tpv/:tpvId`, IGNORA `assignedMerchantIds` a propósito: asignar
 * comercios es de la consola de superadmin.) Hoy ningún rol de negocio trae `system:config`, así que
 * el OWNER de una sola sucursal tampoco pasa — la ruta del negocio tampoco se lo da.
 *
 * Lo demás del PATCH (nombre, estado, marca, modelo) queda como estaba.
 */

const assignMerchantsForOrgMock = jest.fn()
const updateTerminalForOrgMock = jest.fn()

jest.mock('@/services/organization-dashboard/orgTerminals.service', () => ({
  ...jest.requireActual('@/services/organization-dashboard/orgTerminals.service'),
  assignMerchantsForOrg: (...args: unknown[]) => assignMerchantsForOrgMock(...args),
  updateTerminalForOrg: (...args: unknown[]) => updateTerminalForOrgMock(...args),
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
const VENUE_B = 'venue-b' // otra sucursal de la misma org
const TERMINAL = 'terminal-a'
const COMERCIOS_ACTUALES = ['ma-1', 'ma-2']

/** Filas `StaffVenue`: staffId → { venueId, role }. */
const SUCURSAL: Record<string, { venueId: string; role: string }> = {
  cajero: { venueId: VENUE_A, role: 'CASHIER' },
  gerente: { venueId: VENUE_A, role: 'MANAGER' },
  'dueno-sucursal-a': { venueId: VENUE_A, role: 'OWNER' },
  'dueno-sucursal-b': { venueId: VENUE_B, role: 'OWNER' },
  'con-permiso-a': { venueId: VENUE_A, role: 'MANAGER' },
  'con-permiso-b': { venueId: VENUE_B, role: 'MANAGER' },
  'super-1': { venueId: 'venue-plataforma', role: 'SUPERADMIN' },
}
/** Filas `StaffOrganization` de ESTA organización. */
const ORGANIZACION: Record<string, { role: string; isActive: boolean }> = {
  'dueno-org': { role: 'OWNER', isActive: true },
}
/** `VenueRolePermission` por venue y rol: el negocio le dio el permiso de comercios a su gerente. */
const PERSONALIZADO: Record<string, { permissions: string[]; deniedPermissions: string[] }> = {
  [`${VENUE_A}:MANAGER:con-permiso-a`]: { permissions: ['system:config'], deniedPermissions: [] },
  [`${VENUE_B}:MANAGER:con-permiso-b`]: { permissions: ['system:config'], deniedPermissions: [] },
}

let quienPide = ''

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
  quienPide = userId
  return { 'x-test-auth-context': JSON.stringify({ userId, orgId: ORG, venueId: SUCURSAL[userId]?.venueId ?? VENUE_A, role: tokenRole }) }
}

const PUT_COMERCIOS = `/dashboard/organizations/${ORG}/terminals/${TERMINAL}/merchants`
const PATCH_TERMINAL = `/dashboard/organizations/${ORG}/terminals/${TERMINAL}`

function cambiarComercios(userId: string, rol: string) {
  return request(makeApp())
    .put(PUT_COMERCIOS)
    .set(como(userId, rol))
    .send({ merchantIds: ['ma-9'] })
}
function editarTerminal(userId: string, rol: string, body: Record<string, unknown>) {
  return request(makeApp()).patch(PATCH_TERMINAL).set(como(userId, rol)).send(body)
}

function denegaciones() {
  return (logAction as jest.Mock).mock.calls.filter(([p]) => p?.action === 'PERMISSION_DENIED')
}

beforeEach(() => {
  jest.clearAllMocks()
  quienPide = ''
  assignMerchantsForOrgMock.mockResolvedValue({ id: TERMINAL })
  updateTerminalForOrgMock.mockResolvedValue({ id: TERMINAL })

  prismaMock.staff.findUnique.mockResolvedValue({ active: true, firstName: 'Ana', lastName: 'Prueba' } as any)
  prismaMock.terminal.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve(
      where?.id === TERMINAL
        ? { id: TERMINAL, venueId: VENUE_A, assignedMerchantIds: [...COMERCIOS_ACTUALES], venue: { id: VENUE_A, organizationId: ORG } }
        : null,
    )) as any)

  // checkOrgAccess / requireOrgOwner / superadmin real
  prismaMock.staffVenue.findFirst.mockImplementation((({ where }: any) => {
    const fila = SUCURSAL[where?.staffId]
    if (!fila || !coincideRol(where?.role, fila.role)) return Promise.resolve(null)
    if (where?.venue?.organizationId && (where.venue.organizationId !== ORG || fila.role === 'SUPERADMIN')) return Promise.resolve(null)
    return Promise.resolve({ id: `sv-${where.staffId}` })
  }) as any)
  prismaMock.staffOrganization.findFirst.mockImplementation((({ where }: any) => {
    const fila = ORGANIZACION[where?.staffId]
    if (!fila || where?.organizationId !== ORG) return Promise.resolve(null)
    if (where?.isActive === true && !fila.isActive) return Promise.resolve(null)
    if (!coincideRol(where?.role, fila.role)) return Promise.resolve(null)
    return Promise.resolve({ id: `so-${where.staffId}` })
  }) as any)

  // El resolvedor canónico del permiso EN EL VENUE de la terminal (tienePermisoEnElVenue).
  prismaMock.staffVenue.findUnique.mockImplementation((({ where }: any) => {
    const { staffId, venueId } = where?.staffId_venueId ?? {}
    const fila = SUCURSAL[staffId]
    return Promise.resolve(
      fila && fila.venueId === venueId ? { role: fila.role, active: true, permissionSetId: null, permissionSet: null } : null,
    )
  }) as any)
  prismaMock.venue.findUnique.mockImplementation((({ where }: any) => Promise.resolve({ id: where?.id, organizationId: ORG })) as any)
  prismaMock.staffOrganization.findUnique.mockImplementation((({ where }: any) => {
    const { staffId, organizationId } = where?.staffId_organizationId ?? {}
    const fila = ORGANIZACION[staffId]
    return Promise.resolve(fila && organizationId === ORG ? { role: fila.role, isActive: fila.isActive } : null)
  }) as any)
  prismaMock.venueRolePermission.findUnique.mockImplementation((({ where }: any) => {
    const { venueId, role } = where?.venueId_role ?? {}
    return Promise.resolve(PERSONALIZADO[`${venueId}:${role}:${quienPide}`] ?? null)
  }) as any)
})

describe.each([
  ['PUT .../merchants', (u: string, r: string) => cambiarComercios(u, r), () => assignMerchantsForOrgMock],
  [
    'PATCH .../:terminalId con assignedMerchantIds',
    (u: string, r: string) => editarTerminal(u, r, { name: 'Caja 1', assignedMerchantIds: ['ma-9'] }),
    () => updateTerminalForOrgMock,
  ],
])('%s', (_label, cambiar, servicio) => {
  it.each([
    ['🔴 un cajero de la sucursal', 'cajero', 'CASHIER'],
    ['🔴 el gerente de la sucursal', 'gerente', 'MANAGER'],
    ['🔴 el OWNER de la sucursal sin el permiso del negocio (la ruta del negocio tampoco se lo da)', 'dueno-sucursal-a', 'OWNER'],
    ['🔴 el OWNER de OTRA sucursal', 'dueno-sucursal-b', 'OWNER'],
    ['🔴 quien tiene el permiso del negocio pero en OTRA sucursal', 'con-permiso-b', 'MANAGER'],
  ])('%s → 403 en español, bitácora y nada escrito', async (_l, userId, rol) => {
    const res = await cambiar(userId, rol)

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ORG_OWNER_REQUIRED')
    expect(res.body.message).toMatch(/comercios/)
    expect(servicio()).not.toHaveBeenCalled()
    expect(denegaciones()).toHaveLength(1)
    expect(denegaciones()[0][0]).toMatchObject({ staffId: userId, venueId: VENUE_A })
  })

  it.each([
    ['el dueño de la organización', 'dueno-org', 'OWNER'],
    ['quien tiene, en ESA sucursal, el permiso de la ruta del negocio', 'con-permiso-a', 'MANAGER'],
    ['el superadmin de verdad', 'super-1', 'SUPERADMIN'],
  ])('%s sí puede', async (_l, userId, rol) => {
    const res = await cambiar(userId, rol)

    expect(res.status).toBe(200)
    expect(servicio()).toHaveBeenCalled()
    expect(denegaciones()).toHaveLength(0)
  })
})

describe('PATCH sin cambiar comercios: queda como estaba', () => {
  it('REGRESIÓN: un cajero de la org sigue editando el nombre, el estado, la marca y el modelo (como hoy)', async () => {
    const body = { name: 'Caja nueva', status: 'MAINTENANCE', brand: 'PAX', model: 'A920' }
    const res = await editarTerminal('cajero', 'CASHIER', body)

    expect(res.status).toBe(200)
    expect(updateTerminalForOrgMock).toHaveBeenCalledWith(ORG, TERMINAL, body, 'cajero')
  })

  it('reenviar los MISMOS comercios (el diálogo de editar siempre los manda) no es un cambio: pasa y no se escriben', async () => {
    const res = await editarTerminal('gerente', 'MANAGER', { name: 'Caja 2', assignedMerchantIds: [...COMERCIOS_ACTUALES] })

    expect(res.status).toBe(200)
    expect(updateTerminalForOrgMock).toHaveBeenCalledWith(ORG, TERMINAL, { name: 'Caja 2' }, 'gerente')
  })

  it('🔴 los mismos comercios en OTRO ORDEN sí es un cambio (el orden decide el comercio principal)', async () => {
    const res = await editarTerminal('gerente', 'MANAGER', { assignedMerchantIds: [...COMERCIOS_ACTUALES].reverse() })

    expect(res.status).toBe(403)
    expect(updateTerminalForOrgMock).not.toHaveBeenCalled()
  })

  it('🔴 vaciar la lista también es un cambio', async () => {
    const res = await editarTerminal('gerente', 'MANAGER', { assignedMerchantIds: [] })

    expect(res.status).toBe(403)
    expect(updateTerminalForOrgMock).not.toHaveBeenCalled()
  })
})

describe('terminal de OTRA organización', () => {
  it('ni el dueño de esta org la toca', async () => {
    prismaMock.terminal.findUnique.mockResolvedValue({
      id: TERMINAL,
      venueId: 'venue-z',
      assignedMerchantIds: [],
      venue: { id: 'venue-z', organizationId: 'org-z' },
    } as any)

    const res = await cambiarComercios('dueno-org', 'OWNER')

    expect(res.status).toBe(403)
    expect(assignMerchantsForOrgMock).not.toHaveBeenCalled()
  })
})
