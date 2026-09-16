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
 * Mismo molde que `tpv-command.tenant-binding.routes.test.ts`: la terminal se amarra a SU venue
 * antes de `checkPermission`, y el servicio acota lecturas y escrituras a ese venue.
 */

const checkedVenues: Array<string | undefined> = []

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

jest.mock('@/middlewares/checkPermission.middleware', () => {
  // El ORDEN real (params → header x-venue-id → token): es justo lo que decide si un header
  // puede desviar la autorización hacia el venue del atacante.
  const actual = jest.requireActual('@/middlewares/checkPermission.middleware')
  return {
    ...actual,
    checkPermission: () => (req: Request, res: Response, next: NextFunction) => {
      const auth = (req as any).authContext
      const effectiveVenueId = actual.resolveRequestVenueId(req, auth)
      checkedVenues.push(effectiveVenueId)
      if (auth?.role !== 'SUPERADMIN' && !auth?.authorizedVenueIds?.includes(effectiveVenueId)) {
        res.status(403).json({ message: 'No tienes permiso' })
        return
      }
      next()
    },
  }
})

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

/** Staff con permiso SÓLO en el venue A. El dashboard real siempre manda su venue activo por header. */
function staffA(overrides: Record<string, unknown> = {}) {
  return {
    'x-test-auth-context': JSON.stringify({
      userId: 'staff-a',
      venueId: VENUE_A,
      role: 'ADMIN',
      authorizedVenueIds: [VENUE_A],
      ...overrides,
    }),
    'x-venue-id': VENUE_A,
  }
}

function send(method: 'GET' | 'PUT' | 'POST', path: string, headers: Record<string, string>, body?: unknown) {
  const agent = request(makeApp())
  const url = `/api/v1/dashboard${path}`
  const req = method === 'GET' ? agent.get(url) : method === 'PUT' ? agent.put(url) : agent.post(url)
  return req.set(headers).send(body as any)
}

beforeEach(() => {
  jest.clearAllMocks()
  checkedVenues.length = 0
  prismaMock.terminal.findUnique.mockImplementation(fakeTerminalLookup as any)
  prismaMock.terminal.findFirst.mockImplementation(fakeTerminalLookup as any)
  prismaMock.terminal.update.mockResolvedValue({} as any)
  prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue(null)
  prismaMock.merchantAccount.findMany.mockResolvedValue([{ id: 'merchant-a', displayName: 'Comercio A', active: true }] as any)
})

describe('Ajustes de una terminal: la autorización se amarra al venue REAL de la terminal', () => {
  it.each([
    ['ver ajustes', 'GET', '/tpv/terminal-b/settings', undefined],
    ['cambiar ajustes', 'PUT', '/tpv/terminal-b/settings', { showTipScreen: false }],
    ['restablecer ajustes', 'POST', '/tpv/terminal-b/reset-to-defaults', {}],
    ['ver comercios', 'GET', '/tpv/terminal-b/merchants', undefined],
  ] as const)('staff del venue A NO puede %s de una terminal del venue B, aunque su header diga A', async (_label, method, path, body) => {
    const response = await send(method, path, staffA(), body)

    expect(response.status).toBe(403)
    // El permiso se evaluó en el venue de la TERMINAL, no en el del header ni en el del token.
    expect(checkedVenues).toEqual([VENUE_B])
    // Nada del negocio B se leyó ni se escribió.
    expect(response.body).not.toHaveProperty('tipSuggestions')
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
    expect(prismaMock.merchantAccount.findMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('una terminal que no existe responde 404 sin escribir nada', async () => {
    const response = await send('PUT', '/tpv/terminal-inexistente/settings', staffA(), { showTipScreen: false })

    expect(response.status).toBe(404)
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('uso legítimo: ver los ajustes de su propia terminal, con la lectura acotada a su venue', async () => {
    const response = await send('GET', '/tpv/terminal-a/settings', staffA())

    expect(response.status).toBe(200)
    expect(response.body.tipSuggestions).toEqual([10, 15, 20])
    expect(checkedVenues).toEqual([VENUE_A])
    expect(prismaMock.terminal.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'terminal-a', venueId: VENUE_A } }))
  })

  it('uso legítimo: cambiar ajustes escribe acotado a su venue y deja bitácora con autor', async () => {
    const response = await send('PUT', '/tpv/terminal-a/settings', staffA(), { showTipScreen: false })

    expect(response.status).toBe(200)
    expect(response.body.showTipScreen).toBe(false)
    expect(prismaMock.terminal.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.terminal.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'terminal-a', venueId: VENUE_A } }))
    // `logAction` es la frontera de la bitácora (el setup global la simula): se revisa lo que el
    // servicio le entrega, que es lo que termina en ActivityLog.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TPV_SETTINGS_UPDATED',
        entity: 'Terminal',
        entityId: 'terminal-a',
        venueId: VENUE_A,
        staffId: 'staff-a',
      }),
    )
  })

  it('uso legítimo: restablecer escribe acotado a su venue y deja bitácora con autor', async () => {
    const response = await send('POST', '/tpv/terminal-a/reset-to-defaults', staffA(), {})

    expect(response.status).toBe(200)
    expect(prismaMock.terminal.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.terminal.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'terminal-a', venueId: VENUE_A } }))
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TPV_SETTINGS_RESET',
        entity: 'Terminal',
        entityId: 'terminal-a',
        venueId: VENUE_A,
        staffId: 'staff-a',
      }),
    )
  })

  it('uso legítimo: ver los comercios de su propia terminal', async () => {
    const response = await send('GET', '/tpv/terminal-a/merchants', staffA())

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual([{ id: 'merchant-a', displayName: 'Comercio A', active: true }])
    expect(prismaMock.merchantAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ['merchant-a'] } }) }),
    )
  })

  it('SUPERADMIN (consola de superadmin) sigue pudiendo cambiar una terminal de otro venue, evaluado en ESE venue', async () => {
    const response = await send('PUT', '/tpv/terminal-b/settings', staffA({ role: 'SUPERADMIN' }), { showTipScreen: false })

    expect(response.status).toBe(200)
    expect(checkedVenues).toEqual([VENUE_B])
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
      const req = { params: { tpvId: 'terminal-b' }, body: { showTipScreen: false }, authContext: { userId: 'staff-a' } } as any
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
      authContext: { userId: 'staff-a' },
      tpvSettingsTarget: { id: 'terminal-a', venueId: VENUE_A },
    } as any
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
    const next = jest.fn()

    await updateTpvSettings(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
  })
})
