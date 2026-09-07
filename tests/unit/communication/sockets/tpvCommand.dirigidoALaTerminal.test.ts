/**
 * Comandos remotos dirigidos a UNA terminal (7-sep-2026).
 *
 * Caso real (Testarudo, 14:36Z): un SUPERADMIN mandó FACTORY_RESET a la PAX WHITE
 * (AVQD-2841653112) y quien contestó «Factory reset completed» fue la NEXGO BLACK
 * (AVQD-N860W173400). `broadcastTpvCommand` entregaba `tpv_command` a TODOS los sockets del
 * venue y confiaba en que cada aparato se filtrara solo — y el filtro del cliente
 * (`CommandTarget.kt`) llegó a la app apenas el 6-sep, en un APK que la flota no tiene. El
 * único control del servidor vivía en el ACK, DESPUÉS del borrado: servía para rechazar el
 * acuse, no para impedirlo.
 *
 * Tres garantías, cada una con su prueba:
 *  1. el socket de una terminal conoce SU serial por el JWT — firmado por el servidor en el
 *     login de la TPV —, nunca por lo que el cliente reclame en el handshake;
 *  2. `broadcastToTerminal` entrega sólo a los sockets de ESA terminal, y si no hay ninguno
 *     no entrega a NADIE (el heartbeat es el canal primario y ya va por serial). Jamás cae
 *     al venue;
 *  3. `broadcastTpvCommand` usa ese carril para `tpv_command` y deja `tpv_command_sent`
 *     —informativo, para el dashboard— al venue entero.
 */
import { EventEmitter } from 'events'
import jwt from 'jsonwebtoken'
import { StaffRole } from '@prisma/client'
import { socketAuthenticationMiddleware } from '@/communication/sockets/middleware/authentication.middleware'
import { BroadcastingService } from '@/communication/sockets/services/broadcasting.service'
import { RoomManagerService } from '@/communication/sockets/services/roomManager.service'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import type { AuthenticatedSocket, SocketEventType } from '@/communication/sockets/types'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/auth/sessionCache')

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET as string
const TPV_COMMAND = 'tpv_command' as SocketEventType

const WHITE = 'AVQD-2841653112'
const BLACK = 'AVQD-N860W173400'

/** Un socket autenticado de mentira, ya con su contexto, listo para `registerSocket`. */
function socketDe(id: string, venueId: string, terminalSerialNumber?: string) {
  const s = new EventEmitter() as unknown as AuthenticatedSocket & { emit: jest.Mock }
  ;(s as any).id = id
  ;(s as any).correlationId = `corr-${id}`
  s.emit = jest.fn() as any
  s.authContext = {
    userId: `staff-${id}`,
    orgId: 'org',
    venueId,
    role: StaffRole.CASHIER,
    socketId: id,
    connectedAt: new Date(),
    lastActivity: new Date(),
    ...(terminalSerialNumber ? { terminalSerialNumber } : {}),
  }
  return s
}

describe('BroadcastingService.broadcastToTerminal — el comando llega SÓLO a su destinataria', () => {
  let rooms: RoomManagerService
  let svc: BroadcastingService
  let white: ReturnType<typeof socketDe>
  let black: ReturnType<typeof socketDe>
  let dashboard: ReturnType<typeof socketDe>
  let ajena: ReturnType<typeof socketDe>

  beforeEach(() => {
    rooms = new RoomManagerService()
    svc = new BroadcastingService({} as any, rooms)
    white = socketDe('s-white', 'testarudo', WHITE)
    black = socketDe('s-black', 'testarudo', BLACK)
    dashboard = socketDe('s-dash', 'testarudo') // el dueño mirando el dashboard: sin serial
    ajena = socketDe('s-ajena', 'otro-venue', WHITE) // mismo serial, OTRO venue
    for (const s of [white, black, dashboard, ajena]) rooms.registerSocket(s)
  })

  it('🔴 FACTORY_RESET a la WHITE: la recibe la WHITE y nadie más — ni la BLACK del mismo venue', () => {
    svc.broadcastToTerminal('testarudo', WHITE, TPV_COMMAND, { type: 'FACTORY_RESET', terminalId: WHITE })

    expect(white.emit).toHaveBeenCalledTimes(1)
    expect(white.emit).toHaveBeenCalledWith(TPV_COMMAND, expect.objectContaining({ type: 'FACTORY_RESET', venueId: 'testarudo' }))
    expect(black.emit).not.toHaveBeenCalled()
    expect(dashboard.emit).not.toHaveBeenCalled()
    expect(ajena.emit).not.toHaveBeenCalled()
  })

  it('el serial se compara NORMALIZADO: con o sin AVQD-, en cualquier caja (así circula en producción)', () => {
    for (const objetivo of ['2841653112', 'avqd-2841653112', 'AVQD-2841653112']) {
      white.emit.mockClear()
      svc.broadcastToTerminal('testarudo', objetivo, TPV_COMMAND, { type: 'LOCK' })
      expect(white.emit).toHaveBeenCalledTimes(1)
    }
    expect(black.emit).not.toHaveBeenCalled()
  })

  it('🔴 sin socket de la terminal NO cae al venue: NADIE recibe el comando (lo entrega el heartbeat)', () => {
    svc.broadcastToTerminal('testarudo', 'AVQD-9999999999', TPV_COMMAND, { type: 'FACTORY_RESET' })

    for (const s of [white, black, dashboard, ajena]) expect(s.emit).not.toHaveBeenCalled()
  })

  it('un socket SIN serial en el JWT sólo cuenta si el registro de terminales lo ata a ese serial (respaldo para tokens legacy)', () => {
    const legacy = socketDe('s-legacy', 'testarudo')
    rooms.registerSocket(legacy)
    terminalRegistry.register('AVQD-LEGACY001', 's-legacy', 'testarudo')
    try {
      svc.broadcastToTerminal('testarudo', 'AVQD-LEGACY001', TPV_COMMAND, { type: 'RESTART' })

      expect(legacy.emit).toHaveBeenCalledTimes(1)
      expect(dashboard.emit).not.toHaveBeenCalled()
      expect(white.emit).not.toHaveBeenCalled()
    } finally {
      terminalRegistry.unregisterBySocketId('s-legacy')
    }
  })

  it('🔴 el JWT manda sobre el registro: un socket con serial firmado de OTRA terminal no recibe aunque su handshake reclame el destino', () => {
    // La BLACK se conecta reclamando en el handshake ser la WHITE (el registro le cree).
    terminalRegistry.register(WHITE, 's-black', 'testarudo')
    try {
      svc.broadcastToTerminal('testarudo', WHITE, TPV_COMMAND, { type: 'FACTORY_RESET' })

      expect(black.emit).not.toHaveBeenCalled()
      expect(white.emit).toHaveBeenCalledTimes(1)
    } finally {
      terminalRegistry.unregisterBySocketId('s-black')
    }
  })
})

/**
 * El middleware de sockets. Mismo patrón que `socket-session.test.ts`: JWT real (no se
 * mockea `jsonwebtoken`), `handshake.headers` presente porque la implementación lo lee sin
 * optional-chaining, y `on`/`disconnect` porque la revalidación periódica los engancha.
 */
function firmar(payload: Record<string, unknown>): string {
  return jwt.sign(payload, ACCESS_TOKEN_SECRET, { algorithm: 'HS256', expiresIn: '1h' })
}

function handshake(payload: Record<string, unknown>, auth: Record<string, unknown> = {}) {
  return {
    handshake: { auth: { token: firmar(payload), ...auth }, address: '127.0.0.1', headers: {} },
    id: 'sock-1',
    disconnect: jest.fn(),
    on: jest.fn(),
  } as unknown as AuthenticatedSocket
}

describe('socketAuthenticationMiddleware — la identidad de la terminal viene del JWT', () => {
  beforeEach(() => {
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ id: 'v1', status: 'ACTIVE' })
  })

  it('🔴 copia terminalSerialNumber del JWT al authContext del socket', async () => {
    const socket = handshake({ sub: 'st1', venueId: 'v1', role: 'CASHIER', terminalSerialNumber: WHITE })
    const next = jest.fn()

    await socketAuthenticationMiddleware(socket, next)

    expect(next).toHaveBeenCalledWith()
    expect(socket.authContext?.terminalSerialNumber).toBe(WHITE)
  })

  it('un token sin serial (dashboard, Android, iOS) deja el campo AUSENTE — no se inventa del handshake', async () => {
    // Lo que el cliente reclame en `auth.terminalId` no es identidad firmada.
    const socket = handshake({ sub: 'st1', venueId: 'v1', role: 'OWNER' }, { terminalId: WHITE })

    await socketAuthenticationMiddleware(socket, jest.fn())

    expect(socket.authContext).toBeDefined()
    expect(socket.authContext?.terminalSerialNumber).toBeUndefined()
  })
})
