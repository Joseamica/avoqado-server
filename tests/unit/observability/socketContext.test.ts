/**
 * Payment results and remote-command acknowledgements from PAX terminals arrive over socket
 * events. Today a failure there logs `Error processing terminal payment result` with no
 * venue and no terminal — which is where the Amaena merchant mismatch and the ghost-terminal
 * investigations both had to start.
 *
 * Two behaviours carry the weight here, and both are easy to get subtly wrong:
 *
 * 1. The context is built per EVENT. Authentication finishes after the connection exists, so
 *    reading `authContext` once at registration would stamp every later event with no tenant.
 * 2. A correlation id sent by the terminal is honored. `BaseEventPayload` declares one, so
 *    reusing it is what ties a terminal's payment result back to the operation that caused it.
 */

import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Socket } from 'socket.io'
import { onWithContext } from '@/observability/socketContext'
import { getContext } from '@/observability/executionContext'

/** A socket double: a real emitter, plus the fields the auth middleware attaches. */
const buildSocket = (auth?: { userId?: string; venueId?: string; role?: string }) => {
  const socket = new EventEmitter() as unknown as Socket & {
    authContext?: typeof auth
    correlationId?: string
  }
  socket.authContext = auth
  return socket
}

describe('onWithContext', () => {
  it('opens a context with source socket and the event as entrypoint', () => {
    const socket = buildSocket()
    let seen: ReturnType<typeof getContext>

    onWithContext(socket, 'terminal:payment_result', () => {
      seen = getContext()
    })
    socket.emit('terminal:payment_result', {})

    expect(seen?.source).toBe('socket')
    expect(seen?.entrypoint).toBe('socket:terminal:payment_result')
  })

  it('🔴 stamps the tenant so a failed payment result says which venue it was', () => {
    const socket = buildSocket({ userId: 'staff-1', venueId: 'venue-1', role: 'ADMIN' })
    let seen: ReturnType<typeof getContext>

    onWithContext(socket, 'terminal:payment_result', () => {
      seen = getContext()
    })
    socket.emit('terminal:payment_result', {})

    expect(seen).toMatchObject({ venueId: 'venue-1', userId: 'staff-1', role: 'ADMIN' })
  })

  it('🔴 reads the tenant at EVENT time, not at registration', () => {
    // Authentication completes after the handlers are wired up. Reading authContext once at
    // registration would leave every later event without a venue.
    const socket = buildSocket(undefined)
    const seen: Array<string | undefined> = []

    onWithContext(socket, 'tpv:log', () => {
      seen.push(getContext()?.venueId)
    })

    socket.emit('tpv:log', {})
    ;(socket as unknown as { authContext?: unknown }).authContext = { venueId: 'venue-late', userId: 'u1' }
    socket.emit('tpv:log', {})

    expect(seen).toEqual([undefined, 'venue-late'])
  })

  it('🔴 honors a correlation id the terminal sent in the payload', () => {
    const socket = buildSocket()
    let seen: string | undefined

    onWithContext(socket, 'terminal:payment_result', () => {
      seen = getContext()?.correlationId
    })
    socket.emit('terminal:payment_result', { correlationId: 'tpv_01HX8ZQ4M9KJ3N', amount: 850 })

    expect(seen).toBe('tpv_01HX8ZQ4M9KJ3N')
  })

  it('🔴 rejects a hostile payload correlation id instead of logging it', () => {
    const socket = buildSocket()
    let seen: string | undefined

    onWithContext(socket, 'terminal:payment_result', () => {
      seen = getContext()?.correlationId
    })
    socket.emit('terminal:payment_result', { correlationId: 'a'.repeat(500) })

    expect(seen).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('generates an id when the payload carries none', () => {
    const socket = buildSocket()
    let seen: string | undefined

    onWithContext(socket, 'tpv:heartbeat', () => {
      seen = getContext()?.correlationId
    })
    socket.emit('tpv:heartbeat', {})

    expect(seen).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('survives a payload that is not an object', () => {
    const socket = buildSocket()
    let ran = false

    onWithContext(socket, 'error', () => {
      ran = true
    })
    expect(() => socket.emit('error', 'a plain string')).not.toThrow()
    expect(ran).toBe(true)
  })

  it('🔴 passes every argument through untouched, including the ack callback', () => {
    const socket = buildSocket()
    const handler = jest.fn()
    const ack = jest.fn()

    onWithContext(socket, 'tpv:command_ack', handler)
    socket.emit('tpv:command_ack', { commandId: 'c1' }, ack)

    expect(handler).toHaveBeenCalledWith({ commandId: 'c1' }, ack)
  })

  it('🔴 does not swallow an error the handler throws', () => {
    const socket = buildSocket()

    onWithContext(socket, 'tpv:log', () => {
      throw new Error('boom')
    })

    expect(() => socket.emit('tpv:log', {})).toThrow('boom')
  })

  it('does not leak the context after the handler returns', () => {
    const socket = buildSocket({ venueId: 'venue-1' })
    onWithContext(socket, 'tpv:log', () => undefined)
    socket.emit('tpv:log', {})

    expect(getContext()).toBeUndefined()
  })

  it('gives concurrent events from different sockets their own context', async () => {
    const results: Array<{ expected: string; seen?: string }> = []

    const handle = (venueId: string, delayMs: number) =>
      new Promise<void>(resolve => {
        const socket = buildSocket({ venueId })
        onWithContext(socket, 'tpv:log', async () => {
          await new Promise(r => setTimeout(r, delayMs))
          results.push({ expected: venueId, seen: getContext()?.venueId })
          resolve()
        })
        socket.emit('tpv:log', {})
      })

    await Promise.all([handle('venue-a', 15), handle('venue-b', 1), handle('venue-a', 8)])

    expect(results.filter(r => r.expected !== r.seen)).toEqual([])
    expect(results).toHaveLength(3)
  })
})

/**
 * Same invariant as the cron jobs, for the same reason: registering a handler directly is
 * how the next event ends up anonymous, and nothing would tell you until an incident.
 */
describe('no socket handler is registered without a context', () => {
  const SOCKETS_DIR = path.join(__dirname, '../../../src/communication/sockets')

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return walk(full)
      return entry.isFile() && entry.name.endsWith('.ts') ? [full] : []
    })

  const files = walk(SOCKETS_DIR)

  it('finds the socket source files', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('🔴 no file calls socket.on directly', () => {
    const offenders = files
      .map(file => ({
        file: path.relative(SOCKETS_DIR, file),
        hits: (fs.readFileSync(file, 'utf8').match(/\bsocket\.on\(/g) ?? []).length,
      }))
      .filter(({ hits }) => hits > 0)
      .map(({ file, hits }) => `${file}: ${hits} registro(s) sin onWithContext`)

    expect(offenders).toEqual([])
  })

  it('the guard detects a direct registration', () => {
    // A guard never shown to fail is not a guard.
    expect((`socket.on('x', handler)`.match(/\bsocket\.on\(/g) ?? []).length).toBe(1)
    expect((`onWithContext(socket, 'x', handler)`.match(/\bsocket\.on\(/g) ?? []).length).toBe(0)
  })
})
