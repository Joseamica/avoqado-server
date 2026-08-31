/**
 * Sockets + sesiones revocables (Parte A, Task 11)
 *
 * NEW FEATURE: hoy el JWT de un socket se verifica UNA sola vez, en el handshake, y el
 * contexto queda estático (`authentication.middleware.ts`) — una conexión abierta sobrevive
 * tanto al VENCIMIENTO del token como a la REVOCACIÓN de la sesión. Esta suite fija:
 *
 * 1. El handshake rechaza una sesión revocada (mismo contrato que
 *    `authenticateToken.middleware.ts`, ver `authenticateToken.session.test.ts`): un token
 *    con `sid` se valida contra `isSessionAliveCached`; un token LEGACY (sin `sid`) sigue
 *    conectando exactamente como hoy, SIN tocar la caché — hay tokens vivos así en
 *    dashboard, PAX, Android e iOS.
 * 2. Mientras el socket sigue abierto, se REVALIDA periódicamente (cada
 *    `REVALIDATION_INTERVAL_MS`, sobre el MISMO socket) que la sesión sigue viva y el
 *    token no venció — y sólo entonces se desconecta. El intervalo se limpia en
 *    `disconnect` (no debe quedar corriendo de más).
 * 3. `SocketManager.disconnectBySession(sid)` cierra, sobre el registro LOCAL de sockets
 *    (correcto y suficiente: producción corre UNA sola instancia — `.claude/rules/
 *    una-sola-instancia.md` — así que todo socket vivo de esa sesión está en este mismo
 *    proceso), únicamente los sockets de esa sesión.
 *
 * Sigue el mismo patrón de mocking que `authenticateToken.session.test.ts`, adaptado a que
 * la implementación del socket SÍ usa `prisma.venue.findUnique` para el chequeo de venue
 * operativo (`OPERATIONAL_VENUE_STATUSES`) — ausente en el lado HTTP.
 *
 * 🔴 4ª cosa, hallada al implementar (no estaba en el encargo, pero es la MISMA regla de
 * "no romper lo que ya funciona"): `ConnectionController.handleAuthentication` arma un
 * `mockSocket` con `{ ...socket, ... }` para el re-auth manual (evento `authenticate`).
 * `Socket extends EventEmitter`, así que `.on`/`.disconnect`/`.emit` viven en el
 * PROTOTIPO — un spread sólo copia propiedades PROPIAS y los pierde en silencio
 * (verificado con un `EventEmitter` real: `{...emitter}.on` sale `undefined`). Nada los
 * llamaba antes, así que el hueco era invisible; el candado de revalidación de esta tarea
 * SÍ los llama (`socket.on('disconnect', …)`, `socket.disconnect()`), así que sin
 * arreglarlo el re-auth manual habría empezado a fallar con "Invalid or expired token"
 * para CUALQUIER token, incluido uno perfectamente válido.
 *
 * 🔴 5ª cosa — SEGUNDA ronda de revisión: la primera versión de esta tarea cerraba el
 * socket con un temporizador único (tope de 24h o `exp` real). Eso rompía algo que no se
 * había visto: cuando el SERVIDOR cierra un socket de Socket.IO, la razón viaja como
 * `"io server disconnect"`, y los clientes (JS y Java) SE SALTAN la reconexión automática
 * para esa razón a propósito — ninguno de nuestros clientes reconecta solo. Con un tope de
 * 24h, una terminal PAX se quedaba muda cada día sin ningún error visible. La respuesta:
 * revalidar sin cerrar sockets sanos (ver `REVALIDATION_INTERVAL_MS` en
 * `authentication.middleware.ts`). Esta suite ya NO prueba "se cierra al vencer el tope" —
 * prueba lo contrario: un socket sano NUNCA se cierra, y sólo se cierra cuando la
 * revalidación misma encuentra un motivo real.
 */
import { EventEmitter } from 'events'
import jwt from 'jsonwebtoken'
import { socketAuthenticationMiddleware, REVALIDATION_INTERVAL_MS } from '@/communication/sockets/middleware/authentication.middleware'
import { SocketManager } from '@/communication/sockets/managers/socketManager'
import { ConnectionController } from '@/communication/sockets/controllers/connection.controller'
import { RoomManagerService } from '@/communication/sockets/services/roomManager.service'
import type { AuthenticatedSocket } from '@/communication/sockets/types'
import * as sessionCache from '@/services/auth/sessionCache'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/auth/sessionCache')

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET as string

/** Segundos desde epoch — misma unidad que el claim `exp` de un JWT. */
function ahora(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Firma un JWT real (no se mockea `jsonwebtoken`: la agenda de cierre-por-vencimiento
 * depende de la matemática real de `exp`, y es más simple confiar en `jwt.sign`/`jwt.verify`
 * de verdad que reconstruirla a mano). Si el payload no trae `exp`, se le da 1h para que el
 * token no nazca ya vencido.
 */
function firmar(payload: Record<string, unknown>): string {
  const { exp, ...resto } = payload as { exp?: number; [k: string]: unknown }
  if (typeof exp === 'number') {
    return jwt.sign({ ...resto, exp }, ACCESS_TOKEN_SECRET, { algorithm: 'HS256' })
  }
  return jwt.sign(resto, ACCESS_TOKEN_SECRET, { algorithm: 'HS256', expiresIn: '1h' })
}

/**
 * Un socket real de Socket.IO SIEMPRE trae `handshake.headers` (poblado por el transporte),
 * aunque venga vacío — la implementación real lee `headers.cookie`, `headers['user-agent']`
 * y `headers.authorization` sin optional-chaining, así que un fixture sin `headers` truena
 * antes de llegar al código que esta tarea agrega.
 */
function handshake(payload: Record<string, unknown>) {
  return {
    handshake: { auth: { token: firmar(payload) }, address: '127.0.0.1', headers: {} },
    id: 'sock-1',
    disconnect: jest.fn(),
    on: jest.fn(),
  } as unknown as AuthenticatedSocket & { disconnect: jest.Mock; on: jest.Mock }
}

describe('socketAuthenticationMiddleware — sesiones revocables', () => {
  beforeEach(() => {
    // El venue del handshake se consulta SIEMPRE que venueId no sea 'pending' ni el rol
    // SUPERADMIN — que es el caso de todos los payloads de esta suite. Operativo por
    // default; los tests de esta suite no ejercitan el candado de venue, ya cubierto en
    // otro lado.
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ id: 'v1', status: 'ACTIVE' })
  })

  it('rechaza el handshake si la sesion fue revocada', async () => {
    ;(sessionCache.isSessionAliveCached as jest.Mock).mockResolvedValue(false)
    const next = jest.fn()

    await socketAuthenticationMiddleware(handshake({ sub: 'st1', venueId: 'v1', role: 'CASHIER', sid: 's1' }), next)

    expect(sessionCache.isSessionAliveCached).toHaveBeenCalledWith('s1')
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    // el candado de venue ni se consulta si la sesión ya murió
    expect(prisma.venue.findUnique).not.toHaveBeenCalled()
  })

  it('🔴 un token LEGACY sin sid sigue conectando, y no consulta la sesion', async () => {
    const next = jest.fn()

    await socketAuthenticationMiddleware(handshake({ sub: 'st1', venueId: 'v1', role: 'CASHIER' }), next)

    expect(sessionCache.isSessionAliveCached).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith() // sin error
  })

  it('acepta el handshake si la sesion vive', async () => {
    ;(sessionCache.isSessionAliveCached as jest.Mock).mockResolvedValue(true)
    const next = jest.fn()
    const socket = handshake({ sub: 'st1', venueId: 'v1', role: 'CASHIER', sid: 's1' })

    await socketAuthenticationMiddleware(socket, next)

    expect(sessionCache.isSessionAliveCached).toHaveBeenCalledWith('s1')
    expect(next).toHaveBeenCalledWith()
    expect(socket.authContext).toMatchObject({ userId: 'st1', venueId: 'v1', sessionId: 's1' })
  })

  // ────────────────────────────────────────────────────────────────────────────────
  // 🔴 [CRÍTICO, primera ronda] `setTimeout` usa un entero de 32 bits: Node CLAMPA A
  // 1 MS cualquier delay mayor a 2_147_483_647 ms (~24.8 días). El token de la PAX
  // dura 30 días EXACTOS (TPV_ACCESS_TOKEN_EXPIRES_IN_SECONDS, security.ts) y también
  // dashboard/móvil con "recuérdame" y los tokens de cliente/consumidor
  // (jwt.service.ts, expiresIn: 2592000) — los cuatro superan el límite.
  //
  // 🔴 [CRÍTICO, segunda ronda] La primera corrección (tope de 24h) desbordaba menos,
  // pero cerraba sockets SANOS — y ni socket.io-client (JS) ni socket.io-client-java
  // reconectan solos cuando es el SERVIDOR quien cierra (`reason: "io server
  // disconnect"`, ambos lo saltan a propósito). Con eso, una terminal PAX se quedaba
  // muda cada día sin un solo error visible. La versión final NUNCA cierra un socket
  // sano — revalida cada `REVALIDATION_INTERVAL_MS` sobre el MISMO socket, y sólo
  // desconecta cuando la revalidación misma encuentra un motivo real.
  // ────────────────────────────────────────────────────────────────────────────────

  it('🔴 [CRÍTICO] un socket sano (sesion viva, token no vencido) NUNCA se cierra — ni con el viejo tope de 24h', async () => {
    jest.useFakeTimers()
    try {
      ;(sessionCache.isSessionAliveCached as jest.Mock).mockResolvedValue(true)
      const TREINTA_DIAS_SEGUNDOS = 60 * 60 * 24 * 30 // TPV_ACCESS_TOKEN_EXPIRES_IN_SECONDS
      const sock = handshake({ sub: 'st1', venueId: 'v1', role: 'CASHIER', sid: 's1', exp: ahora() + TREINTA_DIAS_SEGUNDOS })

      await socketAuthenticationMiddleware(sock, jest.fn())

      // 25h: más allá del tope de la primera corrección (24h). La sesión sigue "viva"
      // todo el tiempo (mock constante) — un socket sano no tiene por qué cerrarse
      // jamás, así que 25h, 25 días o 25 meses darían el mismo resultado.
      // advanceTimersByTimeAsync (no la versión síncrona): la revalidación es async
      // (`await isSessionAliveCached`) y cada uno de los ~150 disparos del intervalo
      // (25h / 10min) necesita que su microtarea drene antes del siguiente.
      await jest.advanceTimersByTimeAsync(25 * 60 * 60 * 1000)

      expect(sock.disconnect).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('🔴 desconecta en la SIGUIENTE revalidacion si la sesion se revoca a media vida', async () => {
    jest.useFakeTimers()
    try {
      ;(sessionCache.isSessionAliveCached as jest.Mock).mockResolvedValue(true)
      const TREINTA_DIAS_SEGUNDOS = 60 * 60 * 24 * 30
      const sock = handshake({ sub: 'st1', venueId: 'v1', role: 'CASHIER', sid: 's1', exp: ahora() + TREINTA_DIAS_SEGUNDOS })

      await socketAuthenticationMiddleware(sock, jest.fn())

      // Una vuelta con la sesión todavía viva: no pasa nada.
      await jest.advanceTimersByTimeAsync(REVALIDATION_INTERVAL_MS)
      expect(sock.disconnect).not.toHaveBeenCalled()

      // La sesión se revoca DESPUÉS de conectar (a media vida del socket) — como si
      // alguien hubiera tocado "cerrar sesión" mientras la terminal seguía prendida.
      ;(sessionCache.isSessionAliveCached as jest.Mock).mockResolvedValue(false)
      await jest.advanceTimersByTimeAsync(REVALIDATION_INTERVAL_MS)

      expect(sock.disconnect).toHaveBeenCalledWith(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('🔴 limpia el intervalo de revalidacion al desconectarse — no se dispara de mas', async () => {
    jest.useFakeTimers()
    try {
      ;(sessionCache.isSessionAliveCached as jest.Mock).mockResolvedValue(true)
      const sock = handshake({ sub: 'st1', venueId: 'v1', role: 'CASHIER', sid: 's1', exp: ahora() + 60 * 60 * 24 * 30 })

      await socketAuthenticationMiddleware(sock, jest.fn())
      const llamadasAlConectar = (sessionCache.isSessionAliveCached as jest.Mock).mock.calls.length

      // El socket se registró para limpiar el intervalo en 'disconnect' — lo simulamos
      // disparando el handler que la implementación registró con socket.on.
      const handlerDeDisconnect = sock.on.mock.calls.find(([evento]) => evento === 'disconnect')?.[1]
      expect(handlerDeDisconnect).toBeDefined()
      handlerDeDisconnect()

      // Varias vueltas de sobra — si el intervalo no se hubiera limpiado, cada una
      // habría llamado isSessionAliveCached otra vez.
      await jest.advanceTimersByTimeAsync(REVALIDATION_INTERVAL_MS * 5)

      expect((sessionCache.isSessionAliveCached as jest.Mock).mock.calls.length).toBe(llamadasAlConectar)
      expect(sock.disconnect).not.toHaveBeenCalled() // el disconnect fue simulado, no forzado por el candado
    } finally {
      jest.useRealTimers()
    }
  })

  it('🔴 un LEGACY sin sid tambien se desconecta cuando SU exp vence — pero jamas consulta la sesion', async () => {
    jest.useFakeTimers()
    try {
      // 15 min: entre la primera vuelta (10 min, exp aún no vence) y la segunda
      // (20 min, exp ya vencido) — separa a propósito las dos revalidaciones.
      const sock = handshake({ sub: 'st1', venueId: 'v1', role: 'CASHIER', exp: ahora() + 15 * 60 })

      await socketAuthenticationMiddleware(sock, jest.fn())
      expect(sessionCache.isSessionAliveCached).not.toHaveBeenCalled() // legacy: nunca en el handshake

      await jest.advanceTimersByTimeAsync(REVALIDATION_INTERVAL_MS) // 10 min — exp (15 min) aún no llega
      expect(sock.disconnect).not.toHaveBeenCalled()

      await jest.advanceTimersByTimeAsync(REVALIDATION_INTERVAL_MS) // 20 min — exp ya pasó
      expect(sock.disconnect).toHaveBeenCalledWith(true)

      // Ni en el handshake ni en ninguna de las dos vueltas: un legacy no tiene sid,
      // así que la revalidación periódica nunca tuvo sesión que consultar.
      expect(sessionCache.isSessionAliveCached).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('🔴 falla CERRADO si la revalidacion truena (la base cae, etc.) — nunca se deja el socket abierto "por si acaso"', async () => {
    jest.useFakeTimers()
    try {
      ;(sessionCache.isSessionAliveCached as jest.Mock)
        .mockResolvedValueOnce(true) // el handshake: la sesión vive, el socket conecta
        .mockRejectedValueOnce(new Error('la base no responde')) // la revalidación periódica truena
      const sock = handshake({ sub: 'st1', venueId: 'v1', role: 'CASHIER', sid: 's1', exp: ahora() + 60 * 60 * 24 * 30 })

      await socketAuthenticationMiddleware(sock, jest.fn())
      expect(sock.disconnect).not.toHaveBeenCalled() // el handshake conectó normal

      await jest.advanceTimersByTimeAsync(REVALIDATION_INTERVAL_MS)

      // Mismo criterio que sessionCache.ts: un error NUNCA se traduce en "dejar pasar".
      expect(sock.disconnect).toHaveBeenCalledWith(true)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('SocketManager.disconnectBySession', () => {
  function fakeSocket(id: string, sessionId: string | undefined, venueId = 'v1'): AuthenticatedSocket & { disconnect: jest.Mock } {
    return {
      id,
      disconnect: jest.fn(),
      authContext: {
        socketId: id,
        userId: `user-${id}`,
        orgId: 'org-1',
        venueId,
        role: 'CASHIER',
        connectedAt: new Date(),
        lastActivity: new Date(),
        ...(sessionId ? { sessionId } : {}),
      },
    } as unknown as AuthenticatedSocket & { disconnect: jest.Mock }
  }

  it('cierra los sockets de ese sid y sólo esos', () => {
    const manager = new SocketManager()
    // Registro LOCAL de sockets (RoomManagerService) — sin servidor real de Socket.IO ni
    // Redis: es exactamente lo que un venue con UNA instancia necesita.
    const roomManager = (manager as unknown as { roomManager: { registerSocket: (s: AuthenticatedSocket) => void } }).roomManager

    const deLaSesion = fakeSocket('sock-a', 's1')
    const otraSesion = fakeSocket('sock-b', 's2')
    const sinSesion = fakeSocket('sock-c', undefined)

    roomManager.registerSocket(deLaSesion)
    roomManager.registerSocket(otraSesion)
    roomManager.registerSocket(sinSesion)

    manager.disconnectBySession('s1')

    expect(deLaSesion.disconnect).toHaveBeenCalledWith(true)
    expect(otraSesion.disconnect).not.toHaveBeenCalled()
    expect(sinSesion.disconnect).not.toHaveBeenCalled()
  })

  it('desconectar una sesion sin sockets no revienta', () => {
    const manager = new SocketManager()

    expect(() => manager.disconnectBySession('sesion-que-no-tiene-sockets')).not.toThrow()
  })
})

describe('ConnectionController.handleAuthentication — regresión del mockSocket', () => {
  /**
   * Mismo hueco que un socket.io real: `.on`/`.disconnect`/`.emit` viven en el prototipo
   * (heredado de EventEmitter), NUNCA como propiedad propia — así que `{ ...socket }`
   * los pierde exactamente igual que con un `Socket` de verdad. Definidos con la
   * sintaxis de método (no como class field / arrow function) a propósito: un class
   * field SÍ queda como propiedad propia y no reproduciría el hueco.
   */
  class FakeSocket extends EventEmitter {
    id = 'sock-manual-1'
    correlationId?: string
    authContext?: unknown
    handshake = { auth: {}, address: '127.0.0.1', headers: {} }
    onAny(_listener: (...args: unknown[]) => void): this {
      return this
    }
    disconnect(_close?: boolean): this {
      return this
    }
  }

  beforeEach(() => {
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ id: 'v1', status: 'ACTIVE' })
  })

  it('🔴 el re-auth manual no truena al pasar por el candado de vencimiento (exp)', done => {
    ;(sessionCache.isSessionAliveCached as jest.Mock).mockResolvedValue(true)
    const controller = new ConnectionController(new RoomManagerService())
    const socket = new FakeSocket() as unknown as AuthenticatedSocket
    const token = firmar({ sub: 'st1', venueId: 'v1', role: 'CASHIER', sid: 's1', exp: ahora() + 600 })

    controller.handleAuthentication(socket, { token }, response => {
      // Antes del fix, esto llegaba con success:false ("Invalid or expired token") por un
      // TypeError interno (mockSocket.on is not a function) — con un token perfectamente
      // válido.
      expect(response.success).toBe(true)
      expect((socket as unknown as { authContext: unknown }).authContext).toMatchObject({ userId: 'st1', sessionId: 's1' })
      done()
    })
  })
})
