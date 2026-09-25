import { Prisma } from '@prisma/client'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * 🔴 IDOR cross-tenant (auditoría de Codex, 2026-09-16): las cuatro rutas de ajustes de una
 * terminal (`/dashboard/tpv/:tpvId/...`) evaluaban el permiso en el venue del header/JWT del
 * usuario y después leían o escribían la terminal SÓLO por id. Con permiso en su negocio, un
 * usuario tocaba la terminal de otro negocio si conocía su id.
 *
 * La autorización que se prueba aquí es la REAL: `checkPermission` no está simulado. Sólo se
 * simula la capa de datos (membresías, roles personalizados, superadmins), así que un "200" de
 * uso legítimo exige que el rol de verdad tenga el permiso (segunda ronda de Codex, C2: la
 * primera versión simulaba el permiso y aprobaba a un ADMIN que en realidad recibiría 403).
 */

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

const VENUE_A = 'venue-a'
const VENUE_B = 'venue-b'

const TERMINALS = [
  {
    id: 'terminal-a',
    venueId: VENUE_A,
    config: { settings: { showTipScreen: true, tipSuggestions: [10, 15, 20] } },
    configOverrides: null,
    assignedMerchantIds: ['merchant-a'],
    venue: { organizationId: null },
  },
  {
    id: 'terminal-b',
    venueId: VENUE_B,
    config: { settings: { showTipScreen: true, tipSuggestions: [5, 10] } },
    configOverrides: null,
    assignedMerchantIds: ['merchant-b'],
    venue: { organizationId: null },
  },
]

/**
 * Membresías con los roles REALES. Con los defaults de `permissions.ts`, MANAGER tiene
 * `tpv-settings:read/update` y CASHIER no.
 */
const MEMBERSHIPS: Record<string, { role: string; active: boolean }> = {
  'manager-a:venue-a': { role: 'MANAGER', active: true },
  'cashier-a:venue-a': { role: 'CASHIER', active: true },
}
const SUPERADMINS = new Set(['super-1'])

/** Honra el `where` que le pasen: si el servicio acota por el venue equivocado, no encuentra nada. */
function fakeTerminalLookup({ where }: { where: { id?: string; venueId?: string } }) {
  const found = TERMINALS.find(t => t.id === where.id && (where.venueId === undefined || t.venueId === where.venueId))
  return Promise.resolve(found ?? null)
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/dashboard', dashboardRoutes)
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code })
  })
  return app
}

/** Sesión de un usuario cuyo venue activo es A. El dashboard real siempre manda ese venue por header. */
function as(userId: string, tokenRole: string) {
  return {
    'x-test-auth-context': JSON.stringify({ userId, venueId: VENUE_A, orgId: 'org-a', role: tokenRole }),
    'x-venue-id': VENUE_A,
  }
}

function send(method: 'GET' | 'PUT' | 'POST', path: string, headers: Record<string, string>, body?: unknown) {
  const agent = request(makeApp())
  const url = `/api/v1/dashboard${path}`
  const req = method === 'GET' ? agent.get(url) : method === 'PUT' ? agent.put(url) : agent.post(url)
  return req.set(headers).send(body as any)
}

/** Venues en los que `checkPermission` buscó la membresía del usuario. */
function venuesEvaluated(): string[] {
  return prismaMock.staffVenue.findUnique.mock.calls.map((call: any[]) => call[0]?.where?.staffId_venueId?.venueId)
}

function settingsAuditCalls() {
  return (logAction as jest.Mock).mock.calls.filter(([params]) => String(params?.action).startsWith('TPV_SETTINGS_'))
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.terminal.findUnique.mockImplementation(fakeTerminalLookup as any)
  prismaMock.terminal.update.mockResolvedValue({} as any)
  prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue(null)
  prismaMock.merchantAccount.findMany.mockResolvedValue([{ id: 'merchant-a', displayName: 'Comercio A', active: true }] as any)

  // Capa de datos de la autorización real.
  prismaMock.staffVenue.findFirst.mockImplementation((({ where }: any) =>
    Promise.resolve(where?.role === 'SUPERADMIN' && SUPERADMINS.has(where?.staffId) ? { id: 'sv-super' } : null)) as any)
  prismaMock.staffVenue.findUnique.mockImplementation((({ where }: any) => {
    const key = `${where?.staffId_venueId?.staffId}:${where?.staffId_venueId?.venueId}`
    const m = MEMBERSHIPS[key]
    return Promise.resolve(m ? { role: m.role, active: m.active, permissionSetId: null, permissionSet: null } : null)
  }) as any)
  prismaMock.venue.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve({ id: where?.id, organizationId: `org-${where?.id}` })) as any)
  prismaMock.staffOrganization.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  // El resolutor de rol confirma que la persona siga ACTIVA (Codex H2, 24-sep).
  prismaMock.staff.findUnique.mockResolvedValue({ active: true } as any)
})

describe('Ajustes de una terminal: la autorización REAL se evalúa en el venue de la terminal', () => {
  it.each([
    ['ver los ajustes', 'GET', '/tpv/terminal-b/settings', undefined],
    ['cambiar los ajustes', 'PUT', '/tpv/terminal-b/settings', { showTipScreen: false }],
    ['restablecer los ajustes', 'POST', '/tpv/terminal-b/reset-to-defaults', {}],
    ['ver los comercios', 'GET', '/tpv/terminal-b/merchants', undefined],
  ] as const)(
    'el gerente del venue A NO puede %s de una terminal del venue B, aunque su header diga A',
    async (_label, method, path, body) => {
      const response = await send(method, path, as('manager-a', 'MANAGER'), body)

      expect(response.status).toBe(403)
      // La membresía se buscó en el venue de la TERMINAL, no en el del header ni en el del token.
      expect(venuesEvaluated()).toEqual([VENUE_B])
      expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'PERMISSION_DENIED', venueId: VENUE_B }))
      // Nada del negocio B se leyó ni se escribió.
      expect(response.body).not.toHaveProperty('tipSuggestions')
      expect(prismaMock.terminal.update).not.toHaveBeenCalled()
      expect(prismaMock.merchantAccount.findMany).not.toHaveBeenCalled()
      expect(settingsAuditCalls()).toHaveLength(0)
    },
  )

  it('el cajero del venue A no puede cambiar los ajustes ni de su propia terminal (permiso real)', async () => {
    const response = await send('PUT', '/tpv/terminal-a/settings', as('cashier-a', 'CASHIER'), { showTipScreen: false })

    expect(response.status).toBe(403)
    expect(venuesEvaluated()).toEqual([VENUE_A])
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
  })

  it('una terminal que no existe responde 404 sin evaluar permisos ni escribir', async () => {
    const response = await send('PUT', '/tpv/terminal-inexistente/settings', as('manager-a', 'MANAGER'), { showTipScreen: false })

    expect(response.status).toBe(404)
    expect(venuesEvaluated()).toEqual([])
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
  })

  it('uso legítimo: el gerente ve los ajustes de su propia terminal, con la lectura acotada a su venue', async () => {
    const response = await send('GET', '/tpv/terminal-a/settings', as('manager-a', 'MANAGER'))

    expect(response.status).toBe(200)
    expect(response.body.tipSuggestions).toEqual([10, 15, 20])
    expect(prismaMock.terminal.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'terminal-a', venueId: VENUE_A } }))
  })

  it('uso legítimo: el gerente cambia ajustes, escritura acotada a su venue y bitácora con autor', async () => {
    const response = await send('PUT', '/tpv/terminal-a/settings', as('manager-a', 'MANAGER'), { showTipScreen: false })

    expect(response.status).toBe(200)
    expect(response.body.showTipScreen).toBe(false)
    expect(prismaMock.terminal.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.terminal.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'terminal-a', venueId: VENUE_A } }))
    // `logAction` es la frontera de la bitácora (el setup global la simula).
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TPV_SETTINGS_UPDATED',
        entity: 'Terminal',
        entityId: 'terminal-a',
        venueId: VENUE_A,
        staffId: 'manager-a',
      }),
    )
  })

  it('uso legítimo: el gerente restablece, escritura acotada a su venue y bitácora con autor', async () => {
    const response = await send('POST', '/tpv/terminal-a/reset-to-defaults', as('manager-a', 'MANAGER'), {})

    expect(response.status).toBe(200)
    expect(prismaMock.terminal.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.terminal.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'terminal-a', venueId: VENUE_A } }))
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TPV_SETTINGS_RESET',
        entity: 'Terminal',
        entityId: 'terminal-a',
        venueId: VENUE_A,
        staffId: 'manager-a',
      }),
    )
  })

  it('uso legítimo: el gerente ve los comercios de su propia terminal', async () => {
    const response = await send('GET', '/tpv/terminal-a/merchants', as('manager-a', 'MANAGER'))

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual([{ id: 'merchant-a', displayName: 'Comercio A', active: true }])
    expect(prismaMock.merchantAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ['merchant-a'] } }) }),
    )
  })

  it.each([
    ['cambiar', 'PUT', '/tpv/terminal-a/settings', { showTipScreen: false }],
    ['restablecer', 'POST', '/tpv/terminal-a/reset-to-defaults', {}],
  ] as const)(
    'si la terminal se mueve de negocio a media operación, %s responde 404 y no deja bitácora',
    async (_label, method, path, body) => {
      // La escritura va acotada a { id, venueId }: si otro proceso movió la terminal, la base la
      // rechaza con P2025. Eso es un "no existe aquí", no un error del servidor.
      prismaMock.terminal.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('No record was found for an update.', { code: 'P2025', clientVersion: 'test' }),
      )

      const response = await send(method, path, as('manager-a', 'MANAGER'), body)

      expect(response.status).toBe(404)
      expect(settingsAuditCalls()).toHaveLength(0)
    },
  )

  it('SUPERADMIN (consola de superadmin) sigue pudiendo cambiar una terminal de otro venue, escrita en ESE venue', async () => {
    const response = await send('PUT', '/tpv/terminal-b/settings', as('super-1', 'SUPERADMIN'), { showTipScreen: false })

    expect(response.status).toBe(200)
    expect(prismaMock.terminal.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'terminal-b', venueId: VENUE_B } }))
  })
})

describe('Controladores de ajustes: sin terminal amarrada NO operan', () => {
  // La guarda existe para el día en que alguien conecte una ruta nueva a estos controladores y
  // olvide `bindTpvSettingsTarget`: sin ella el permiso se habría evaluado en el venue del header.
  it.each([['getTpvSettings'], ['updateTpvSettings'], ['resetTpvToDefaults'], ['getTerminalMerchants']] as const)(
    '%s responde 404 y no toca la base si la ruta no amarró la terminal',
    async controllerName => {
      const controllers = await import('@/controllers/dashboard/tpv.dashboard.controller')
      const req = { params: { tpvId: 'terminal-b' }, body: { showTipScreen: false }, authContext: { userId: 'manager-a' } } as any
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
      const next = jest.fn()

      await controllers[controllerName](req, res, next)

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))
      expect(res.json).not.toHaveBeenCalled()
      expect(prismaMock.terminal.findUnique).not.toHaveBeenCalled()
      expect(prismaMock.terminal.update).not.toHaveBeenCalled()
    },
  )

  it('tampoco opera si la terminal amarrada no es la del path', async () => {
    const { updateTpvSettings } = await import('@/controllers/dashboard/tpv.dashboard.controller')
    const req = {
      params: { tpvId: 'terminal-b' },
      body: { showTipScreen: false },
      authContext: { userId: 'manager-a' },
      tpvSettingsTarget: { id: 'terminal-a', venueId: VENUE_A },
    } as any
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
    const next = jest.fn()

    await updateTpvSettings(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
  })
})
