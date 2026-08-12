import type { Socket } from 'socket.io'
import { runWithContext } from './executionContext'
import { resolveCorrelationId } from './correlationId'
import { getVenueName } from './venueNames'

type Handler = (...args: any[]) => unknown

/** What the socket authentication middleware attaches (see sockets/middleware/authentication.middleware.ts). */
interface SocketWithAuth extends Socket {
  authContext?: { userId?: string; venueId?: string; role?: string }
  correlationId?: string
}

/**
 * Registers a socket event handler that runs inside an execution context.
 *
 * Drop-in for `socket.on(event, handler)`, one argument in front:
 *
 *   ❌ socket.on('terminal:payment_result', handler)
 *   ✅ onWithContext(socket, 'terminal:payment_result', handler)
 *
 * The handler is passed through **verbatim** — same reason as `scheduleJob`: rewriting
 * callbacks is where bindings get dropped, and copying the argument untouched makes that
 * class of mistake unreachable rather than merely detectable.
 *
 * Why this matters here specifically: payment results and remote-command acknowledgements
 * from PAX terminals arrive over these events. Today a failure logs
 * `Error processing terminal payment result` with no venue and no terminal, which is the
 * starting point of every one of those investigations.
 *
 * Two details that are easy to get wrong:
 *
 * - **The context is built per EVENT, not at registration.** Authentication completes after
 *   the connection is set up, and a socket can be re-authenticated; reading `authContext`
 *   once at registration would stamp every later event with a stale tenant, or none.
 * - **A client-supplied correlation id is honored when it is safe.** `BaseEventPayload`
 *   declares `correlationId`, so terminals already send one — reusing it is what ties a
 *   terminal's payment result to the operation that produced it. It goes through the same
 *   sanitizer as the HTTP header, because it is equally untrusted input.
 */
export function onWithContext(socket: Socket, event: string, handler: Handler): Socket {
  return socket.on(event, (...args: unknown[]) => {
    const withAuth = socket as SocketWithAuth
    const payload = args[0] as { correlationId?: unknown } | undefined
    const fromPayload = payload && typeof payload === 'object' ? payload.correlationId : undefined

    return runWithContext(
      {
        correlationId: resolveCorrelationId(fromPayload ?? withAuth.correlationId),
        source: 'socket',
        entrypoint: `socket:${event}`,
        venueId: withAuth.authContext?.venueId,
        venueName: getVenueName(withAuth.authContext?.venueId),
        userId: withAuth.authContext?.userId,
        role: withAuth.authContext?.role,
      },
      () => handler(...args),
    )
  })
}
