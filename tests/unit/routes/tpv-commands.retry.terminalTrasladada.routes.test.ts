import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'

/**
 * 🔴 Reintentar un comando NO puede entregárselo a una terminal que ya está en OTRO negocio (auditoría de Codex de la
 * rama, 15-oct-2026, P1-2).
 *
 * `POST /venues/:venueId/tpv-commands/:commandId/retry` autoriza contra el venue HISTÓRICO del comando (`:venueId`,
 * que debe coincidir con `command.venueId`), pero la entrega (`sendCommandToTerminal`) va al venue ACTUAL de la
 * terminal. Si la terminal se trasladó de A a B, un operador de A con `tpv-commands:write` y el permiso de borrado
 * en A reintentaba un FACTORY_RESET fallido y lo mandaba a la terminal, ya de B (Codex reprodujo 200 + envío a B).
 *
 * Ahora el reintento comprueba —y el re-armado lo exige en el mismo `UPDATE`— que la terminal siga en el venue del
 * comando. Si no, 409 en español y el comando se queda como estaba.
 *
 * La parte que decide el destino es la REAL: `sendCommandToTerminal` y la cola de comandos corren de verdad sobre una
 * «base» en memoria; sólo se simulan la autenticación, Prisma y el socket (para ver a quién se emitió).
 */

const broadcastToTerminalMock = jest.fn()
const broadcastTpvCommandMock = jest.fn()
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: {
    getServer: () => ({}),
    broadcastToTerminal: (...args: unknown[]) => broadcastToTerminalMock(...args),
  },
  broadcastTpvCommand: (...args: unknown[]) => broadcastTpvCommandMock(...args),
  broadcastSuperadminTerminalUpdate: jest.fn(),
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
const VENUE_A = 'venue-a'
const VENUE_B = 'venue-b'

/** La «base»: una terminal y un comando fallido de la sucursal A. */
let terminal: { id: string; venueId: string; serialNumber: string; name: string; lastHeartbeat: Date }
let comando: Record<string, any>

function conTerminal() {
  return { ...comando, terminal: { ...terminal }, venue: { name: 'Tienda A' } }
}

function cumpleWhere(where: any): boolean {
  if (where?.id && where.id !== comando.id) return false
  if (where?.venueId && where.venueId !== comando.venueId) return false
  if (where?.status) {
    const estados: string[] = typeof where.status === 'string' ? [where.status] : (where.status.in ?? [])
    if (!estados.includes(comando.status)) return false
  }
  const filtroTerminal = where?.terminal?.is ?? where?.terminal
  const venueFiltro = filtroTerminal?.venueId
  if (typeof venueFiltro === 'string' && venueFiltro !== terminal.venueId) return false
  if (venueFiltro?.not !== undefined && venueFiltro.not === terminal.venueId) return false // la terminal de HOY
  return true
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

function reintentarComoDuenoDeA() {
  return request(makeApp())
    .post(`/api/v1/dashboard/venues/${VENUE_A}/tpv-commands/cmd-1/retry`)
    .set({
      'x-test-auth-context': JSON.stringify({ userId: 'owner-a', venueId: VENUE_A, orgId: ORG, role: 'OWNER' }),
      'x-venue-id': VENUE_A,
    })
    .send({})
}

beforeEach(() => {
  jest.clearAllMocks()
  terminal = { id: 'terminal-1', venueId: VENUE_A, serialNumber: 'AVQD-2840744167', name: 'Caja 1', lastHeartbeat: new Date() }
  comando = {
    id: 'cmd-1',
    terminalId: terminal.id,
    venueId: VENUE_A,
    commandType: 'FACTORY_RESET',
    status: 'FAILED',
    payload: null,
    priority: 'CRITICAL',
    requiresPin: false,
    correlationId: 'corr-1',
    requestedBy: 'owner-a',
    requestedByName: 'Dueña A',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    scheduledFor: null,
  }

  // El dueño de A, con `tpv-commands:write` personalizado en A (por defecto sólo SUPERADMIN lo trae).
  prismaMock.staff.findUnique.mockResolvedValue({ active: true, firstName: 'Ana', lastName: 'Prueba' } as any)
  prismaMock.staffVenue.findFirst.mockResolvedValue(null) // no es superadmin
  prismaMock.staffVenue.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve(
      where?.staffId_venueId?.staffId === 'owner-a' && where?.staffId_venueId?.venueId === VENUE_A
        ? { role: 'OWNER', active: true, permissionSetId: null, permissionSet: null }
        : null,
    )) as any)
  prismaMock.venueRolePermission.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve(
      where?.venueId_role?.venueId === VENUE_A && where?.venueId_role?.role === 'OWNER'
        ? { permissions: ['tpv-commands:write'], deniedPermissions: [] }
        : null,
    )) as any)
  prismaMock.venue.findUnique.mockResolvedValue({ id: VENUE_A, organizationId: ORG } as any)
  prismaMock.staffOrganization.findUnique.mockResolvedValue(null)

  // La cola de comandos y la terminal, en memoria. (El historial no está en el mock global de Prisma.)
  ;(prismaMock as any).tpvCommandHistory = { create: jest.fn().mockResolvedValue({}) }
  prismaMock.terminal.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve(where?.id === terminal.id ? { ...terminal } : null)) as any)
  prismaMock.tpvCommandQueue.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve(where?.id === comando.id ? conTerminal() : null)) as any)
  prismaMock.tpvCommandQueue.update.mockImplementation((({ data }: any) => {
    Object.assign(comando, data)
    return Promise.resolve({ ...comando })
  }) as any)
  prismaMock.tpvCommandQueue.updateMany.mockImplementation((({ where, data }: any) => {
    if (!cumpleWhere(where)) return Promise.resolve({ count: 0 })
    const { attempts, ...resto } = data ?? {}
    Object.assign(comando, resto)
    if (typeof attempts === 'number') comando.attempts = attempts
    return Promise.resolve({ count: 1 })
  }) as any)
})

describe('POST /venues/:venueId/tpv-commands/:commandId/retry — la terminal ya se fue a otro negocio', () => {
  it('🔴 el caso de Codex: la terminal se trasladó de A a B → 409 en español, NO se re-arma y NADA se emite', async () => {
    terminal.venueId = VENUE_B

    const res = await reintentarComoDuenoDeA()

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TERMINAL_MOVED')
    expect(res.body.message).toMatch(/ya no está en esta sucursal/)
    expect(comando.status).toBe('FAILED')
    expect(broadcastToTerminalMock).not.toHaveBeenCalled()
    expect(broadcastTpvCommandMock).not.toHaveBeenCalled()
  })

  it('🔴 traslado justo entre la revisión y el re-armado: el UPDATE exige que la terminal siga en el venue (409, nada emitido)', async () => {
    // La revisión ve la terminal en A; el UPDATE condicionado la encuentra ya en B.
    prismaMock.terminal.findUnique.mockImplementationOnce((({ where }: any) => {
      const vista = { ...terminal }
      if (where?.id === terminal.id) terminal.venueId = VENUE_B
      return Promise.resolve(vista)
    }) as any)

    const res = await reintentarComoDuenoDeA()

    expect(res.status).toBe(409)
    expect(comando.status).toBe('FAILED')
    expect(broadcastToTerminalMock).not.toHaveBeenCalled()
  })

  it('regresión: si la terminal sigue en A, se re-arma y se le entrega a ELLA, en A', async () => {
    const res = await reintentarComoDuenoDeA()

    expect(res.status).toBe(200)
    expect(comando.status).toBe('SENT')
    expect(broadcastToTerminalMock).toHaveBeenCalledTimes(1)
    expect(broadcastToTerminalMock).toHaveBeenCalledWith(
      VENUE_A,
      terminal.serialNumber,
      expect.anything(),
      expect.objectContaining({ commandId: 'cmd-1', type: 'FACTORY_RESET' }),
    )
  })

  // Ronda 8 (Codex r2, 16-oct): el traslado llega DESPUÉS del re-armado y antes de la entrega.
  it.each(['FACTORY_RESET', 'LOCK'])(
    '🔴 %s: traslado después del re-armado → la entrega real no emite a B, el comando queda retirado y el reintento responde 409',
    async tipo => {
      comando.commandType = tipo
      const rearmar = prismaMock.tpvCommandQueue.updateMany.getMockImplementation()!
      prismaMock.tpvCommandQueue.updateMany.mockImplementationOnce(((args: any) =>
        (rearmar(args) as Promise<any>).then(r => {
          terminal.venueId = VENUE_B // otra petición mueve la terminal justo después de que el re-armado escribe
          return r
        })) as any)

      const res = await reintentarComoDuenoDeA()

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('TERMINAL_MOVED')
      expect(broadcastToTerminalMock).not.toHaveBeenCalled()
      expect(broadcastTpvCommandMock).not.toHaveBeenCalled()
      expect(comando).toMatchObject({ status: 'CANCELLED', resultMessage: expect.stringMatching(/^TERMINAL_MOVED/) })
    },
  )

  it('regresión: un LOCK fallido de una terminal que se fue tampoco se re-arma (cualquier comando, no sólo el borrado)', async () => {
    comando.commandType = 'LOCK'
    terminal.venueId = VENUE_B

    const res = await reintentarComoDuenoDeA()

    expect(res.status).toBe(409)
    expect(broadcastToTerminalMock).not.toHaveBeenCalled()
  })
})
