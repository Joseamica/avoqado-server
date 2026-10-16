import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * 🔴 Borrar de fábrica una terminal es del DUEÑO — en TODAS las puertas que lo encolan.
 *
 * Hallazgo 1 de la auditoría de Codex (14-oct-2026): `tpv-factory-reset:execute` existía (OWNER sí,
 * ADMIN y MANAGER no), pero ninguna ruta lo pedía. `POST /dashboard/tpv/:terminalId/command` sólo
 * exigía `tpv:command`, que ADMIN (por `tpv:*`) y MANAGER tienen, y el controlador aceptaba
 * `FACTORY_RESET` sin mirar nada más. El dashboard sólo le pinta el botón al dueño: un ADMIN con la
 * consola del navegador borraba la terminal igual.
 *
 * La autorización que se prueba es la REAL: ni `checkPermission` ni el resolvedor del permiso de
 * borrado están simulados. Sólo se simula la autenticación (un header de prueba), la capa de datos
 * y el último paso que encola el comando — si la petición llega hasta ahí, el borrado se habría
 * encolado.
 */

const sendCommandMock = jest.fn()
const getTerminalHealthMock = jest.fn()
const executeCommandMock = jest.fn()
const sendCommandToTerminalMock = jest.fn()

jest.mock('@/services/tpv/tpv-health.service', () => ({
  tpvHealthService: {
    sendCommand: (...args: unknown[]) => sendCommandMock(...args),
    getTerminalHealth: (...args: unknown[]) => getTerminalHealthMock(...args),
  },
}))

jest.mock('@/services/tpv/command-execution.service', () => ({
  ...jest.requireActual('@/services/tpv/command-execution.service'),
  tpvCommandExecutionService: {
    executeCommand: (...args: unknown[]) => executeCommandMock(...args),
    sendCommandToTerminal: (...args: unknown[]) => sendCommandToTerminalMock(...args),
  },
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

import dashboardRoutes from '@/routes/dashboard.routes'

const ORG = 'org-a'
const VENUE = 'venue-a'
const TERMINAL = {
  id: 'terminal-a',
  venueId: VENUE,
  serialNumber: 'AVQD-A-001',
  lastHeartbeat: new Date('2026-10-15T17:00:00.000Z'),
}

/** Membresías con los roles REALES de `permissions.ts`. */
const MEMBRESIAS: Record<string, string> = {
  'admin-a': 'ADMIN',
  'manager-a': 'MANAGER',
  'owner-a': 'OWNER',
  'cashier-a': 'CASHIER',
}
/** Dueño de la ORGANIZACIÓN sin fila en la sucursal: el resolvedor lo trata como OWNER del venue. */
const DUENOS_DE_ORG = new Set(['org-owner'])
const SUPERADMINS = new Set(['super-1'])

/** Lo que el venue personalizó por rol (`VenueRolePermission`): se cambia por prueba. */
let personalizacion: Record<string, { permissions: string[]; deniedPermissions: string[] }> = {}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/dashboard', dashboardRoutes)
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code })
  })
  return app
}

function como(userId: string, tokenRole: string) {
  return {
    'x-test-auth-context': JSON.stringify({ userId, venueId: VENUE, orgId: ORG, role: tokenRole }),
    'x-venue-id': VENUE,
  }
}

function post(path: string, headers: Record<string, string>, body: unknown) {
  return request(makeApp())
    .post(`/api/v1/dashboard${path}`)
    .set(headers)
    .send(body as any)
}

function denegacionesDeBorrado() {
  return (logAction as jest.Mock).mock.calls.filter(
    ([p]) => p?.action === 'PERMISSION_DENIED' && p?.entityId === 'tpv-factory-reset:execute',
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  personalizacion = {}

  sendCommandMock.mockResolvedValue({ commandId: 'cmd-new' })
  getTerminalHealthMock.mockResolvedValue({ status: 'ACTIVE' })
  executeCommandMock.mockResolvedValue({ commandId: 'cmd-new', queued: true })
  sendCommandToTerminalMock.mockResolvedValue(undefined)

  prismaMock.terminal.findFirst.mockResolvedValue(TERMINAL as any)
  prismaMock.terminal.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve(where?.id === TERMINAL.id ? { ...TERMINAL, venue: { id: VENUE, organizationId: ORG } } : null)) as any)
  prismaMock.terminal.updateMany.mockResolvedValue({ count: 1 } as any)

  // Capa de datos de la autorización real (`checkPermission`, `checkOrgAccess`, el resolvedor de rol).
  prismaMock.staff.findUnique.mockResolvedValue({ active: true, firstName: 'Ana', lastName: 'Prueba' } as any)
  prismaMock.staffVenue.findFirst.mockImplementation((({ where }: any) => {
    if (where?.role === 'SUPERADMIN') return Promise.resolve(SUPERADMINS.has(where?.staffId) ? { id: 'sv-super' } : null)
    // Membresía a la organización por una sucursal (checkOrgAccess).
    if (where?.venue?.organizationId === ORG && MEMBRESIAS[where?.staffId]) return Promise.resolve({ id: `sv-${where.staffId}` })
    return Promise.resolve(null)
  }) as any)
  prismaMock.staffVenue.findUnique.mockImplementation((({ where }: any) => {
    const { staffId, venueId } = where?.staffId_venueId ?? {}
    const role = venueId === VENUE ? MEMBRESIAS[staffId] : undefined
    return Promise.resolve(role ? { role, active: true, permissionSetId: null, permissionSet: null } : null)
  }) as any)
  prismaMock.venue.findUnique.mockResolvedValue({ id: VENUE, organizationId: ORG } as any)
  prismaMock.staffOrganization.findFirst.mockImplementation((({ where }: any) =>
    Promise.resolve(where?.organizationId === ORG && DUENOS_DE_ORG.has(where?.staffId) ? { id: 'so-owner' } : null)) as any)
  prismaMock.staffOrganization.findUnique.mockImplementation((({ where }: any) => {
    const { staffId, organizationId } = where?.staffId_organizationId ?? {}
    return Promise.resolve(organizationId === ORG && DUENOS_DE_ORG.has(staffId) ? { role: 'OWNER', isActive: true } : null)
  }) as any)
  prismaMock.venueRolePermission.findUnique.mockImplementation((({ where }: any) => {
    const { venueId, role } = where?.venueId_role ?? {}
    return Promise.resolve(venueId === VENUE ? (personalizacion[role] ?? null) : null)
  }) as any)
  prismaMock.venueSettings.findUnique.mockResolvedValue(null)
})

describe.each([
  ['POST /tpv/:terminalId/command (la que usa el dashboard)', `/tpv/${TERMINAL.id}/command`],
  ['POST /venues/:venueId/tpv/:terminalId/command', `/venues/${VENUE}/tpv/${TERMINAL.id}/command`],
])('%s', (_label, ruta) => {
  it.each([
    ['ADMIN', 'admin-a'],
    ['MANAGER', 'manager-a'],
  ])('🔴 un %s NO puede borrar de fábrica: 403 en español y no se encola nada', async (rol, userId) => {
    const res = await post(ruta, como(userId, rol), { command: 'FACTORY_RESET' })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FACTORY_RESET_OWNER_ONLY')
    expect(res.body.message).toMatch(/dueño/)
    expect(sendCommandMock).not.toHaveBeenCalled()
    expect(prismaMock.terminal.updateMany).not.toHaveBeenCalled()
    // Queda en la bitácora del dueño, con el permiso que faltó.
    expect(denegacionesDeBorrado()).toHaveLength(1)
    expect(denegacionesDeBorrado()[0][0]).toMatchObject({ staffId: userId, venueId: VENUE })
  })

  it('el dueño SÍ puede, y el borrado se encola en su terminal', async () => {
    const res = await post(ruta, como('owner-a', 'OWNER'), { command: 'FACTORY_RESET' })

    expect(res.status).toBe(200)
    expect(sendCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: TERMINAL.id, venueId: VENUE }),
      expect.objectContaining({ type: 'FACTORY_RESET', requestedBy: 'owner-a' }),
    )
  })

  it('🔴 si el negocio le QUITÓ el permiso al dueño, el dueño tampoco puede', async () => {
    personalizacion.OWNER = { permissions: [], deniedPermissions: ['tpv-factory-reset:execute'] }

    const res = await post(ruta, como('owner-a', 'OWNER'), { command: 'FACTORY_RESET' })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FACTORY_RESET_OWNER_ONLY')
    expect(sendCommandMock).not.toHaveBeenCalled()
  })

  it('es por PERMISO, no por nombre de rol: si el negocio se lo da al ADMIN, el ADMIN puede', async () => {
    personalizacion.ADMIN = { permissions: ['tpv-factory-reset:execute'], deniedPermissions: [] }

    const res = await post(ruta, como('admin-a', 'ADMIN'), { command: 'FACTORY_RESET' })

    expect(res.status).toBe(200)
    expect(sendCommandMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'FACTORY_RESET' }))
  })

  it('el superadmin de verdad sí puede', async () => {
    const res = await post(ruta, como('super-1', 'SUPERADMIN'), { command: 'FACTORY_RESET' })

    expect(res.status).toBe(200)
    expect(sendCommandMock).toHaveBeenCalled()
  })

  // ---- REGRESIÓN: lo demás no cambia ----

  it.each(['LOCK', 'RESTART'])('el ADMIN sigue mandando %s como siempre', async command => {
    const res = await post(ruta, como('admin-a', 'ADMIN'), { command })

    expect(res.status).toBe(200)
    expect(sendCommandMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: command }))
    expect(denegacionesDeBorrado()).toHaveLength(0)
  })

  it('el MANAGER sigue mandando LOCK', async () => {
    const res = await post(ruta, como('manager-a', 'MANAGER'), { command: 'LOCK' })

    expect(res.status).toBe(200)
    expect(sendCommandMock).toHaveBeenCalled()
  })

  it('el cajero sigue sin poder mandar comandos (lo frena `tpv:command`, como antes)', async () => {
    const res = await post(ruta, como('cashier-a', 'CASHIER'), { command: 'LOCK' })

    expect(res.status).toBe(403)
    expect(sendCommandMock).not.toHaveBeenCalled()
  })
})

describe('POST /venues/:venueId/tpv-commands (registro de comandos, hoy sólo SUPERADMIN por defecto)', () => {
  const ruta = `/venues/${VENUE}/tpv-commands`
  const borrado = { terminalId: TERMINAL.id, commandType: 'FACTORY_RESET', confirmationPin: '1234' }

  it('🔴 un ADMIN al que el negocio le dio `tpv-commands:write` sigue SIN poder borrar de fábrica', async () => {
    // El PIN de 4 dígitos que pide el esquema no se valida contra nada: no es una barrera.
    personalizacion.ADMIN = { permissions: ['tpv-commands:write'], deniedPermissions: [] }

    const res = await post(ruta, como('admin-a', 'ADMIN'), borrado)

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FACTORY_RESET_OWNER_ONLY')
    expect(executeCommandMock).not.toHaveBeenCalled()
  })

  it('…y con ese mismo permiso sí manda un LOCK', async () => {
    personalizacion.ADMIN = { permissions: ['tpv-commands:write'], deniedPermissions: [] }

    const res = await post(ruta, como('admin-a', 'ADMIN'), { terminalId: TERMINAL.id, commandType: 'LOCK' })

    expect(res.status).toBe(201)
    expect(executeCommandMock).toHaveBeenCalledWith(expect.objectContaining({ commandType: 'LOCK', venueId: VENUE }))
  })

  it('el dueño con `tpv-commands:write` sí puede borrar de fábrica por aquí', async () => {
    personalizacion.OWNER = { permissions: ['tpv-commands:write'], deniedPermissions: [] }

    const res = await post(ruta, como('owner-a', 'OWNER'), borrado)

    expect(res.status).toBe(201)
    expect(executeCommandMock).toHaveBeenCalledWith(expect.objectContaining({ commandType: 'FACTORY_RESET' }))
  })

  it('sin `tpv-commands:write` el ADMIN sigue fuera, como antes', async () => {
    const res = await post(ruta, como('admin-a', 'ADMIN'), { terminalId: TERMINAL.id, commandType: 'LOCK' })

    expect(res.status).toBe(403)
    expect(executeCommandMock).not.toHaveBeenCalled()
  })
})

describe('POST /venues/:venueId/tpv-commands/:commandId/retry (re-arma un comando fallido o vencido)', () => {
  const ruta = `/venues/${VENUE}/tpv-commands/cmd-1/retry`

  function comandoFallido(commandType: string) {
    prismaMock.tpvCommandQueue.findUnique.mockResolvedValue({
      id: 'cmd-1',
      venueId: VENUE,
      terminalId: TERMINAL.id, // la terminal sigue en el venue del comando (ronda 7: si no, no se re-arma)
      status: 'FAILED',
      commandType,
    } as any)
    prismaMock.tpvCommandQueue.updateMany.mockResolvedValue({ count: 1 } as any)
  }

  it('🔴 un ADMIN con `tpv-commands:write` NO puede re-armar un FACTORY_RESET', async () => {
    personalizacion.ADMIN = { permissions: ['tpv-commands:write'], deniedPermissions: [] }
    comandoFallido('FACTORY_RESET')

    const res = await post(ruta, como('admin-a', 'ADMIN'), {})

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FACTORY_RESET_OWNER_ONLY')
    expect(prismaMock.tpvCommandQueue.updateMany).not.toHaveBeenCalled()
    expect(sendCommandToTerminalMock).not.toHaveBeenCalled()
  })

  it('…pero sí re-arma un LOCK', async () => {
    personalizacion.ADMIN = { permissions: ['tpv-commands:write'], deniedPermissions: [] }
    comandoFallido('LOCK')

    const res = await post(ruta, como('admin-a', 'ADMIN'), {})

    expect(res.status).toBe(200)
    expect(prismaMock.tpvCommandQueue.updateMany).toHaveBeenCalled()
  })

  it('el dueño con `tpv-commands:write` sí re-arma el FACTORY_RESET', async () => {
    personalizacion.OWNER = { permissions: ['tpv-commands:write'], deniedPermissions: [] }
    comandoFallido('FACTORY_RESET')

    const res = await post(ruta, como('owner-a', 'OWNER'), {})

    expect(res.status).toBe(200)
    expect(sendCommandToTerminalMock).toHaveBeenCalledWith('cmd-1')
  })
})

// La ruta de la ORGANIZACIÓN (`/organizations/:orgId/terminals/:terminalId/command`) tiene su propio candado —el
// dueño de la organización, no este permiso de venue— y su prueba: organizationDashboard.terminalCommand.routes.test.ts.
