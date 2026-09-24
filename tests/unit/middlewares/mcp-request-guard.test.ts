/**
 * Guardia de peticiones del MCP de clientes — el freno del incidente del 23-sep-2026.
 *
 * Ese día el Claude de un cliente mandó 4 llamadas en 81 s; cada una ocupó el único hilo del server ~40 s,
 * se amontonaron 3 en paralelo, /health dejó de contestar y Render mató la instancia. Y nadie supo QUÉ
 * herramienta fue: /mcp no tenía contexto y la herramienta sólo se registraba al terminar.
 *
 * Estas pruebas fijan las tres piezas que decidió el founder, con las correcciones de dos auditorías de Codex:
 *   1. una llamada de herramienta a la vez por persona. Si la anterior sigue CORRIENDO, la nueva se rechaza al
 *      instante; si ya respondió y sólo le falta calmarse, la nueva espera un momento. El cupo acompaña al
 *      TRABAJO, no a la conexión, y nunca se le quita a un trabajo vivo (sólo avisa si dura demasiado). Las
 *      peticiones de control esperan su turno (máximo 2 a la vez por persona); las notificaciones se contestan
 *      202 sin armar nada; los lotes JSON-RPC se rechazan (el protocolo actual los prohibió);
 *   2. tope de tiempo: al vencer, o si el cliente se fue, la petición queda CANCELADA para que el trabajo
 *      se detenga en su siguiente consulta — y el reloj nunca se apaga antes, para cortar ramas sobrantes;
 *   3. registrar al EMPEZAR qué método, qué herramienta y quién.
 */
import { EventEmitter } from 'events'
import type { NextFunction, Request, Response } from 'express'
import logger from '@/config/logger'
import { getContext, runWithContext, type ExecutionContext } from '@/observability/executionContext'
import {
  beginWork,
  extensionCancellableReads,
  isRequestCancelledError,
  RequestCancelledError,
  runCancellableTransaction,
} from '@/utils/requestCancellation'
import {
  describeMcpMessage,
  MCP_CONTROL_WAIT_MS,
  MCP_REATTACH_ALERT_MS,
  MCP_REQUEST_TIMEOUT_MS,
  MCP_SLOT_ALERT_MS,
  MCP_SLOT_QUIET_MS,
  MCP_STAFF_MAX_CONCURRENT_REQUESTS,
  MCP_STAFF_MAX_CONCURRENT_TOOL_CALLS,
  mcpRequestGuardMiddleware,
  mcpRequestSlots,
} from '@/middlewares/mcp-request-guard.middleware'

const mockedLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock }

const toolCall = (name = 'org_confirmed_sales_report', id: number | string = 7, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
})
const initialize = (id = 1) => ({ jsonrpc: '2.0', id, method: 'initialize', params: {} })
const toolsList = (id = 2) => ({ jsonrpc: '2.0', id, method: 'tools/list' })
const notificacion = (method = 'notifications/initialized') => ({ jsonrpc: '2.0', method })

const CABECERAS_VALIDAS = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }

function makeReq(body: unknown, staffId: string | null = 'staff-1', headers: Record<string, string> = CABECERAS_VALIDAS) {
  const extra: Record<string, unknown> = { activeOrg: 'org-1' }
  if (staffId) extra.staffId = staffId
  return { auth: { extra }, body, headers } as unknown as Request
}

type FakeRes = Response & {
  statusCode: number
  body: any
  headers: Record<string, string>
  ended: boolean
  writableFinished: boolean
  headersSent: boolean
  terminar: () => void
  clienteSeFue: () => void
}

function makeRes(alDecidir: () => void): FakeRes {
  const ee = new EventEmitter() as unknown as FakeRes
  Object.assign(ee, {
    statusCode: 200,
    body: undefined,
    headers: {},
    ended: false,
    writableFinished: false,
    headersSent: false,
    status(code: number) {
      ee.statusCode = code
      return ee
    },
    setHeader(name: string, value: string) {
      ee.headers[name.toLowerCase()] = value
    },
    json(payload: unknown) {
      ee.body = payload
      ee.headersSent = true
      alDecidir()
      return ee
    },
    end() {
      ee.ended = true
      ee.headersSent = true
      alDecidir()
      return ee
    },
  })
  ee.terminar = () => {
    ee.writableFinished = true
    ee.emit('finish')
    ee.emit('close')
  }
  ee.clienteSeFue = () => {
    ee.emit('close')
  }
  return ee
}

/**
 * Corre la guardia. `paso` dice si llegó al MCP (next). `conTrabajo` simula al manejador y a la herramienta:
 * marca trabajo vivo que la prueba termina cuando quiere. `listo` se resuelve cuando la guardia decidió (pasó al
 * MCP o contestó), para los casos que esperan turno.
 */
function correr(body: unknown, staffId: string | null = 'staff-1', opts: { conTrabajo?: boolean; headers?: Record<string, string> } = {}) {
  let decidir!: () => void
  const listo = new Promise<void>(r => (decidir = r))
  const res = makeRes(() => decidir())
  const estado = { paso: false, visto: undefined as ExecutionContext | undefined, terminarTrabajo: () => {} }
  const next: NextFunction = () => {
    estado.paso = true
    estado.visto = getContext()
    if (opts.conTrabajo) estado.terminarTrabajo = beginWork()
    decidir()
  }
  mcpRequestGuardMiddleware(makeReq(body, staffId, opts.headers), res, next)
  return {
    res,
    listo,
    get paso() {
      return estado.paso
    },
    contexto: () => estado.visto,
    terminarTrabajo: () => estado.terminarTrabajo(),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mcpRequestSlots.reset()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('describeMcpMessage', () => {
  it('una llamada de herramienta: método, herramienta, id y venue', () => {
    expect(describeMcpMessage(toolCall('daily_sales', 9, { venueId: 'v-1' }))).toEqual({
      kind: 'request',
      id: 9,
      method: 'tools/call',
      tool: 'daily_sales',
      venueId: 'v-1',
    })
  })

  it('initialize y tools/list son peticiones sin herramienta', () => {
    expect(describeMcpMessage(initialize())).toMatchObject({ kind: 'request', method: 'initialize', tool: undefined })
    expect(describeMcpMessage(toolsList())).toMatchObject({ kind: 'request', method: 'tools/list' })
  })

  it('un mensaje sin id es una notificación', () => {
    expect(describeMcpMessage(notificacion())).toMatchObject({ kind: 'notification', method: 'notifications/initialized' })
  })

  it('un arreglo es un lote, con cada mensaje descrito', () => {
    const lote = describeMcpMessage([toolCall('a', 1), notificacion(), toolsList(3)])
    expect(lote.kind).toBe('batch')
    expect(lote.items?.map(i => i.kind)).toEqual(['request', 'notification', 'request'])
  })

  it('cualquier otra cosa es inválida (y no truena)', () => {
    for (const basura of [null, undefined, 'hola', 42, {}, { method: 5 }]) {
      expect(describeMcpMessage(basura).kind).toBe('invalid')
    }
  })

  it('un venueId que no es texto no se toma', () => {
    expect(describeMcpMessage(toolCall('x', 1, { venueId: 123 })).venueId).toBeUndefined()
  })
})

describe('cupo: una llamada de herramienta a la vez por persona', () => {
  it('los topes por default son los que decidió el founder: 1 herramienta y 2 peticiones a la vez', () => {
    expect(MCP_STAFF_MAX_CONCURRENT_TOOL_CALLS).toBe(1)
    expect(MCP_STAFF_MAX_CONCURRENT_REQUESTS).toBe(2)
  })

  it('con la primera CORRIENDO, la segunda de la misma persona se rechaza al instante, sin llegar al MCP', () => {
    const primera = correr(toolCall('org_confirmed_sales_report', 7), 'staff-1', { conTrabajo: true })
    expect(primera.paso).toBe(true)

    const segunda = correr(toolCall('org_structure', 8))
    expect(segunda.paso).toBe(false)
    // HTTP 200 con resultado de herramienta isError: el modelo LEE el motivo y el transporte no se rompe.
    expect(segunda.res.statusCode).toBe(200)
    expect(segunda.res.body).toMatchObject({ jsonrpc: '2.0', id: 8, result: { isError: true } })
    expect(segunda.res.body.result.content[0].text).toMatch(/otra consulta/i)
    expect(mockedLogger.warn).toHaveBeenCalled()
  })

  it('otra persona no se ve afectada', () => {
    correr(toolCall(), 'staff-1', { conTrabajo: true })
    expect(correr(toolCall(), 'staff-2').paso).toBe(true)
  })

  it('al terminar la primera (sin trabajo pendiente), la persona puede volver a llamar', () => {
    const primera = correr(toolCall())
    primera.res.terminar()
    expect(correr(toolCall('otra', 9)).paso).toBe(true)
  })

  it('una llamada sin identidad no consume cupo (no hay a quién atribuirla) y sigue su camino', () => {
    expect(correr(toolCall(), null).paso).toBe(true)
    expect(correr(toolCall(), null).paso).toBe(true)
  })
})

describe('el cupo acompaña al TRABAJO, no a la conexión (Codex P1-2 y ronda 2)', () => {
  it('si el cliente se fue pero la herramienta sigue trabajando, una llamada nueva se RECHAZA hasta que termine', async () => {
    jest.useFakeTimers()
    const primera = correr(toolCall(), 'staff-1', { conTrabajo: true })
    primera.res.clienteSeFue()
    expect(correr(toolCall('b', 2)).res.body?.result?.isError).toBe(true)
    primera.terminarTrabajo()
    await jest.advanceTimersByTimeAsync(MCP_SLOT_QUIET_MS + 1)
    expect(correr(toolCall('c', 3)).paso).toBe(true)
  })

  it('aunque la respuesta ya salió, el cupo sigue tomado mientras quede trabajo vivo', async () => {
    jest.useFakeTimers()
    const primera = correr(toolCall(), 'staff-1', { conTrabajo: true })
    primera.res.terminar()
    expect(correr(toolCall('b', 2)).res.body?.result?.isError).toBe(true)
    primera.terminarTrabajo()
    await jest.advanceTimersByTimeAsync(MCP_SLOT_QUIET_MS + 1)
    expect(correr(toolCall('c', 3)).paso).toBe(true)
  })

  it('después de la última actividad hay un momento de calma antes de soltar el cupo', async () => {
    jest.useFakeTimers()
    const primera = correr(toolCall(), 'staff-1', { conTrabajo: true })
    primera.res.terminar()
    primera.terminarTrabajo()
    expect(mockedLogger.info).not.toHaveBeenCalledWith('mcp.request fin', expect.anything())
    await jest.advanceTimersByTimeAsync(MCP_SLOT_QUIET_MS + 1)
    expect(mockedLogger.info).toHaveBeenCalledWith(
      'mcp.request fin',
      expect.objectContaining({ outcome: 'ok', ms: expect.any(Number), respuestaMs: expect.any(Number) }),
    )
  })

  it('una llamada que llega en ese momento de calma ESPERA y luego corre (no se rechaza)', async () => {
    jest.useFakeTimers()
    const primera = correr(toolCall(), 'staff-1', { conTrabajo: true })
    primera.res.terminar()
    primera.terminarTrabajo()
    const segunda = correr(toolCall('b', 2))
    expect(segunda.paso).toBe(false)
    expect(segunda.res.body).toBeUndefined()
    await jest.advanceTimersByTimeAsync(MCP_SLOT_QUIET_MS + 1)
    await segunda.listo
    expect(segunda.paso).toBe(true)
  })

  it('si durante la calma vuelve a haber trabajo, una llamada nueva se RECHAZA: ya no se está calmando', async () => {
    jest.useFakeTimers()
    const primera = correr(toolCall('a', 1), 'staff-1', { conTrabajo: true })
    const ctx = primera.contexto()!
    primera.res.terminar()
    primera.terminarTrabajo() // respondió y no queda nada corriendo: empieza la calma
    let soltar!: () => void
    const operacion = runWithContext(ctx, () =>
      extensionCancellableReads.query.$allOperations({
        operation: 'create',
        args: {},
        query: () => new Promise(r => (soltar = () => r(1))),
      }),
    )
    await jest.advanceTimersByTimeAsync(1)
    const nueva = correr(toolCall('b', 2))
    expect(nueva.res.body?.result?.isError).toBe(true) // rechazada al instante, no esperando la calma
    soltar()
    await operacion
  })

  it('un cupo viejo NUNCA se le quita a un trabajo vivo: sólo avisa, una vez', () => {
    const t0 = 1_000_000
    const pide = { requests: 1, tools: 1, label: 'tools/call vieja' }
    expect(mcpRequestSlots.tryAcquire('staff-9', pide, t0)).not.toBeNull()
    expect(mcpRequestSlots.tryAcquire('staff-9', pide, t0 + MCP_SLOT_ALERT_MS + 1)).toBeNull()
    expect(mcpRequestSlots.tryAcquire('staff-9', pide, t0 + MCP_SLOT_ALERT_MS * 10)).toBeNull()
    expect(mockedLogger.error).toHaveBeenCalledTimes(1)
    expect(mockedLogger.error).toHaveBeenCalledWith(
      'mcp.cupo retenido demasiado tiempo',
      expect.objectContaining({ staffId: 'staff-9', label: 'tools/call vieja' }),
    )
  })

  it('cada liberación suelta sólo su propio cupo', () => {
    const control = { requests: 1, tools: 0, label: 'initialize' }
    const a = mcpRequestSlots.tryAcquire('staff-9', control)!
    const b = mcpRequestSlots.tryAcquire('staff-9', control)!
    expect(mcpRequestSlots.tryAcquire('staff-9', control)).toBeNull()
    a.release()
    a.release() // idempotente
    const c = mcpRequestSlots.tryAcquire('staff-9', control)
    expect(c).not.toBeNull()
    expect(mcpRequestSlots.tryAcquire('staff-9', control)).toBeNull()
    b.release()
    c!.release()
  })
})

describe('peticiones de control: tope de 2 por persona, pero esperan su turno (Codex P2-7 y ronda 2)', () => {
  it('con una herramienta en curso, una petición de control de otra conversación todavía entra (2 a la vez)', () => {
    correr(toolCall(), 'staff-1', { conTrabajo: true })
    expect(correr(toolsList(4)).paso).toBe(true)
  })

  it('una tercera petición simultánea ESPERA su turno en vez de fallar, y corre al liberarse uno', async () => {
    jest.useFakeTimers()
    correr(toolCall(), 'staff-1', { conTrabajo: true })
    const otra = correr(toolsList(4))
    const lista = correr(toolsList(5))
    expect(lista.paso).toBe(false)
    expect(lista.res.body).toBeUndefined()
    otra.res.terminar()
    await jest.advanceTimersByTimeAsync(1)
    await lista.listo
    expect(lista.paso).toBe(true)
  })

  it('si el turno no llega a tiempo, se rechaza con 429 + Retry-After y error JSON-RPC', async () => {
    jest.useFakeTimers()
    correr(toolCall(), 'staff-1', { conTrabajo: true })
    correr(toolsList(4), 'staff-1', { conTrabajo: true })
    const lista = correr(toolsList(5))
    await jest.advanceTimersByTimeAsync(MCP_CONTROL_WAIT_MS + 1)
    await lista.listo
    expect(lista.paso).toBe(false)
    expect(lista.res.statusCode).toBe(429)
    expect(lista.res.headers['retry-after']).toBeDefined()
    expect(lista.res.body).toMatchObject({ jsonrpc: '2.0', id: 5, error: { code: -32000 } })
    expect(lista.res.body.error.message).toMatch(/consultas en proceso/i)
  })

  it('si el cliente se va mientras espera, no se contesta nada ni se llega al MCP', async () => {
    jest.useFakeTimers()
    correr(toolCall(), 'staff-1', { conTrabajo: true })
    correr(toolsList(4), 'staff-1', { conTrabajo: true })
    const lista = correr(toolsList(5))
    lista.res.clienteSeFue()
    await jest.advanceTimersByTimeAsync(MCP_CONTROL_WAIT_MS + 1)
    expect(lista.paso).toBe(false)
    expect(lista.res.body).toBeUndefined()
  })

  it('no hay fila infinita: con 4 en espera, la siguiente se rechaza al instante', () => {
    jest.useFakeTimers()
    correr(toolCall(), 'staff-1', { conTrabajo: true })
    correr(toolsList(4), 'staff-1', { conTrabajo: true })
    for (let i = 0; i < 4; i++) expect(correr(toolsList(10 + i)).res.body).toBeUndefined()
    expect(correr(toolsList(20)).res.statusCode).toBe(429)
  })
})

describe('notificaciones: 202 sin armar nada, igual que el SDK', () => {
  it('con cabeceras válidas se contestan 202 al instante, sin tomar cupo, aunque haya dos consultas en curso', () => {
    correr(toolCall(), 'staff-1', { conTrabajo: true })
    correr(toolsList(4), 'staff-1', { conTrabajo: true })
    for (const n of [notificacion(), notificacion('notifications/cancelled')]) {
      const r = correr(n)
      expect(r.paso).toBe(false)
      expect(r.res.statusCode).toBe(202)
      expect(r.res.ended).toBe(true)
      expect(r.res.body).toBeUndefined()
    }
  })

  it('con una versión de protocolo soportada también', () => {
    const r = correr(notificacion(), 'staff-1', { headers: { ...CABECERAS_VALIDAS, 'mcp-protocol-version': '2025-06-18' } })
    expect(r.res.statusCode).toBe(202)
  })

  it('con una versión de protocolo NO soportada va al SDK (que contesta 400), no al atajo (Codex P3)', () => {
    const r = correr(notificacion(), 'staff-1', { headers: { ...CABECERAS_VALIDAS, 'mcp-protocol-version': '1999-01-01' } })
    expect(r.paso).toBe(true)
    expect(r.res.ended).toBe(false)
  })

  it('sin Accept completo va al SDK (que contesta 406), no al atajo', () => {
    const r = correr(notificacion(), 'staff-1', { headers: { accept: 'application/json', 'content-type': 'application/json' } })
    expect(r.paso).toBe(true)
  })
})

describe('lotes JSON-RPC: rechazados (Codex P1-1 y ronda 2)', () => {
  it.each([
    ['dos herramientas', [toolCall('a', 1), toolCall('b', 2)]],
    [
      'una herramienta con su notifications/cancelled',
      [toolCall('a', 1), { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }],
    ],
    ['sólo notificaciones', [notificacion(), notificacion('notifications/cancelled')]],
  ])('un lote con %s se rechaza con 400 y error JSON-RPC, sin llegar al MCP', (_caso, lote) => {
    const r = correr(lote)
    expect(r.paso).toBe(false)
    expect(r.res.statusCode).toBe(400)
    expect(r.res.body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } })
  })
})

describe('tope de tiempo y cliente que se va', () => {
  it('al vencer el tope, la petición queda cancelada por TIEMPO', () => {
    jest.useFakeTimers()
    const { contexto } = correr(toolCall())
    const signal = contexto()?.cancellation?.signal
    expect(signal?.aborted).toBe(false)
    jest.advanceTimersByTime(MCP_REQUEST_TIMEOUT_MS + 1)
    expect(signal?.aborted).toBe(true)
    expect(isRequestCancelledError(signal?.reason)).toBe(true)
    expect((signal?.reason as RequestCancelledError).reason).toBe('timeout')
  })

  it('si el cliente se fue antes de terminar, queda cancelada por CLIENTE', () => {
    const { res, contexto } = correr(toolCall())
    res.clienteSeFue()
    const signal = contexto()?.cancellation?.signal
    expect(signal?.aborted).toBe(true)
    expect((signal?.reason as RequestCancelledError).reason).toBe('client-closed')
  })

  it('el reloj NO se apaga con la respuesta: si el trabajo sigue vivo, al vencer el tope se corta por TIEMPO', () => {
    jest.useFakeTimers()
    const { res, contexto } = correr(toolCall(), 'staff-1', { conTrabajo: true })
    res.terminar() // la respuesta ya salió, pero la herramienta sigue trabajando
    jest.advanceTimersByTime(MCP_REQUEST_TIMEOUT_MS + 1)
    const signal = contexto()?.cancellation?.signal
    expect(signal?.aborted).toBe(true)
    expect((signal?.reason as RequestCancelledError).reason).toBe('timeout')
  })

  it('el tope por default deja margen sobre la llamada más lenta vista (8.2 s) y queda bajo el corte del proxy', () => {
    expect(MCP_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000)
    expect(MCP_REQUEST_TIMEOUT_MS).toBeLessThan(100_000)
  })
})

describe('contexto de ejecución: todo log del MCP ya dice qué y quién', () => {
  it('el handler ve la herramienta, la persona, el venue y la cancelación', () => {
    const { contexto } = correr(toolCall('daily_sales', 3, { venueId: 'v-77' }))
    expect(contexto()).toMatchObject({
      source: 'http',
      entrypoint: 'POST /mcp tools/call daily_sales',
      userId: 'staff-1',
      venueId: 'v-77',
    })
    expect(contexto()?.correlationId).toEqual(expect.any(String))
    expect(contexto()?.cancellation).toMatchObject({ hasWritten: false, refused: false })
  })

  it('un método sin herramienta queda nombrado por el método', () => {
    const { contexto } = correr(initialize())
    expect(contexto()?.entrypoint).toBe('POST /mcp initialize')
  })
})

describe('registro: al empezar y al terminar', () => {
  it('al empezar registra método, herramienta, persona y organización', () => {
    correr(toolCall('org_structure', 5))
    expect(mockedLogger.info).toHaveBeenCalledWith(
      'mcp.request inicio',
      expect.objectContaining({ mcp: true, method: 'tools/call', tool: 'org_structure', staffId: 'staff-1', org: 'org-1' }),
    )
  })

  it('el inicio se registra DENTRO del contexto (lleva el mismo correlationId que el fin)', () => {
    let entrypointAlRegistrar: string | undefined
    mockedLogger.info.mockImplementation((msg: string) => {
      if (msg === 'mcp.request inicio') entrypointAlRegistrar = getContext()?.entrypoint
    })
    correr(toolCall('org_structure', 5))
    expect(entrypointAlRegistrar).toBe('POST /mcp tools/call org_structure')
    mockedLogger.info.mockReset()
  })

  it('si la herramienta ya respondió, el fin dice ok (su cierre no es una cancelación)', () => {
    const r = correr(toolCall())
    r.contexto()?.cancellation?.cancel?.(new RequestCancelledError('tool-finished'))
    r.res.terminar()
    expect(mockedLogger.info).toHaveBeenCalledWith('mcp.request fin', expect.objectContaining({ outcome: 'ok' }))
  })

  it('si el cliente se fue, el fin lo dice', () => {
    const { res } = correr(toolCall())
    res.clienteSeFue()
    expect(mockedLogger.info).toHaveBeenCalledWith('mcp.request fin', expect.objectContaining({ outcome: 'cliente-se-fue' }))
  })

  it('si venció el tope, el fin lo dice', () => {
    jest.useFakeTimers()
    const { res } = correr(toolCall())
    jest.advanceTimersByTime(MCP_REQUEST_TIMEOUT_MS + 1)
    res.terminar()
    expect(mockedLogger.info).toHaveBeenCalledWith('mcp.request fin', expect.objectContaining({ outcome: 'cancelada' }))
  })
})

describe('ronda 3 de Codex — el cliente que se va justo al recibir su turno (P2-4)', () => {
  it('no llega al MCP y su cupo queda libre al instante', async () => {
    jest.useFakeTimers()
    const a = correr(toolsList(1), 'staff-1', { conTrabajo: true })
    correr(toolsList(2), 'staff-1', { conTrabajo: true })
    const c = correr(toolsList(3))
    expect(c.res.body).toBeUndefined() // espera su turno
    a.res.terminar()
    a.terminarTrabajo()
    // Síncrono: la liberación le asigna el turno a `c`, pero su `await` todavía no continúa…
    jest.advanceTimersByTime(MCP_SLOT_QUIET_MS + 1)
    // …y su conexión se cierra justo ahí.
    c.res.clienteSeFue()
    await jest.advanceTimersByTimeAsync(1)
    expect(c.paso).toBe(false)
    // Su cupo se soltó: otra petición de control cabe ya (la de `b` sigue ocupando el otro lugar).
    expect(correr(toolsList(4)).paso).toBe(true)
  })
})

describe('ronda 4 de Codex — una conexión que ya estaba cerrada no se forma en la fila', () => {
  it('no espera turno ni ocupa un lugar en la fila: no hay a quién contestar', () => {
    correr(toolCall(), 'staff-1', { conTrabajo: true })
    correr(toolsList(4), 'staff-1', { conTrabajo: true })
    const req = makeReq(toolsList(5))
    ;(req as unknown as { socket: { destroyed: boolean } }).socket = { destroyed: true }
    const res = makeRes(() => {})
    const next = jest.fn()
    mcpRequestGuardMiddleware(req, res, next)
    expect(mcpRequestSlots.waitingCount('staff-1')).toBe(0)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('ronda 3 de Codex — el atajo 202 sólo para lo que el SDK también contestaría 202 (P3)', () => {
  it.each([
    ['sin jsonrpc', { method: 'notifications/initialized' }],
    ['con id: null', { jsonrpc: '2.0', method: 'notifications/initialized', id: null }],
    ['con params que no es objeto', { jsonrpc: '2.0', method: 'notifications/initialized', params: 42 }],
  ])('una notificación %s va al SDK (que contesta 400), no al atajo', (_caso, cuerpo) => {
    const r = correr(cuerpo)
    expect(r.res.statusCode).not.toBe(202)
    expect(r.paso).toBe(true)
  })
})

describe('ronda 3 de Codex — initialize y ping no toman cupo: conectar nunca espera (P2-5)', () => {
  it('una conversación nueva conecta aunque la persona tenga sus DOS peticiones ocupadas', () => {
    correr(toolCall(), 'staff-1', { conTrabajo: true })
    correr(toolsList(4), 'staff-1', { conTrabajo: true })
    expect(correr(initialize(9)).paso).toBe(true)
    expect(correr({ jsonrpc: '2.0', id: 10, method: 'ping' }).paso).toBe(true)
  })

  it('y no ocupan lugar: con handshakes en curso, una petición de control todavía entra', () => {
    correr(toolCall(), 'staff-1', { conTrabajo: true })
    correr(initialize(9), 'staff-1', { conTrabajo: true })
    correr(initialize(10), 'staff-1', { conTrabajo: true })
    expect(correr(toolsList(4)).paso).toBe(true)
  })

  it('una petición de control espera más que una consulta completa (su tope de tiempo)', () => {
    expect(MCP_CONTROL_WAIT_MS).toBeGreaterThan(MCP_REQUEST_TIMEOUT_MS)
  })
})

describe('ronda 3 de Codex — la alarma de cupo retenido suena sola (P3)', () => {
  it('sin que nadie vuelva a consultar el registro', () => {
    jest.useFakeTimers()
    correr(toolCall('lenta', 1), 'staff-1', { conTrabajo: true })
    jest.advanceTimersByTime(MCP_SLOT_ALERT_MS + 1)
    expect(mockedLogger.error).toHaveBeenCalledWith(
      'mcp.cupo retenido demasiado tiempo',
      expect.objectContaining({ staffId: 'staff-1', label: 'tools/call lenta' }),
    )
  })
})

/** Una operación de base de datos por la extensión real del freno, en el contexto de la unidad `ctx`. */
const extension = extensionCancellableReads.query.$allOperations
function operar(ctx: ExecutionContext, operation: string, opts: { alCorrer?: () => void } = {}) {
  return runWithContext(ctx, () =>
    extension({
      operation,
      args: {},
      query: async () => {
        opts.alCorrer?.()
        return []
      },
    }),
  )
}

describe('ronda 3 de Codex — una rama que sobrevive a su herramienta no corre junto a la siguiente consulta (P1)', () => {
  /** Una herramienta que escribió, respondió y se calmó: su cupo ya se soltó. Devuelve su contexto. */
  async function unidadQueEscribioYSoltoElCupo(): Promise<ExecutionContext> {
    const primera = correr(toolCall('a', 1), 'staff-1', { conTrabajo: true })
    const ctx = primera.contexto()!
    await operar(ctx, 'create')
    primera.res.terminar()
    primera.terminarTrabajo()
    await jest.advanceTimersByTimeAsync(MCP_SLOT_QUIET_MS + 1)
    return ctx
  }

  it('si ya escribió, su siguiente lectura ESPERA el turno de la persona en vez de correr en paralelo', async () => {
    jest.useFakeTimers()
    const vieja = await unidadQueEscribioYSoltoElCupo()
    const nueva = correr(toolCall('b', 2), 'staff-1', { conTrabajo: true })
    expect(nueva.paso).toBe(true)
    let leyo = false
    const lectura = operar(vieja, 'findMany', { alCorrer: () => (leyo = true) })
    await jest.advanceTimersByTimeAsync(1_000)
    expect(leyo).toBe(false)
    nueva.res.terminar()
    nueva.terminarTrabajo()
    await jest.advanceTimersByTimeAsync(MCP_SLOT_QUIET_MS + 1)
    await lectura
    expect(leyo).toBe(true)
  })

  it('sus ESCRITURAS también esperan su turno: nunca se cortan, sólo se ordenan', async () => {
    jest.useFakeTimers()
    const vieja = await unidadQueEscribioYSoltoElCupo()
    const nueva = correr(toolCall('b', 2), 'staff-1', { conTrabajo: true })
    let escribio = false
    const escritura = operar(vieja, 'update', { alCorrer: () => (escribio = true) })
    await jest.advanceTimersByTimeAsync(1_000)
    expect(escribio).toBe(false)
    nueva.res.terminar()
    nueva.terminarTrabajo()
    await jest.advanceTimersByTimeAsync(MCP_SLOT_QUIET_MS + 1)
    await escritura
    expect(escribio).toBe(true)
  })

  it('mientras esa rama retomó el cupo, una consulta nueva se rechaza como "otra consulta en proceso"', async () => {
    jest.useFakeTimers()
    const vieja = await unidadQueEscribioYSoltoElCupo()
    let soltar!: () => void
    const lectura = runWithContext(vieja, () =>
      extension({ operation: 'findMany', args: {}, query: () => new Promise(r => (soltar = () => r([]))) }),
    )
    await jest.advanceTimersByTimeAsync(1)
    const nueva = correr(toolCall('b', 2))
    expect(nueva.res.body?.result?.isError).toBe(true)
    soltar()
    await lectura
  })

  it('si NO escribió, al soltar el cupo su siguiente lectura se rechaza al instante (no espera)', async () => {
    jest.useFakeTimers()
    const primera = correr(toolCall('a', 1), 'staff-1', { conTrabajo: true })
    const ctx = primera.contexto()!
    primera.res.terminar()
    primera.terminarTrabajo()
    await jest.advanceTimersByTimeAsync(MCP_SLOT_QUIET_MS + 1)
    await expect(operar(ctx, 'findMany')).rejects.toMatchObject({ reason: 'tool-finished' })
  })

  it('lo mismo para una petición de control (tools/list): sus lecturas sobrantes se cortan al soltar el cupo', async () => {
    jest.useFakeTimers()
    const lista = correr(toolsList(1), 'staff-1', { conTrabajo: true })
    const ctx = lista.contexto()!
    lista.res.terminar()
    lista.terminarTrabajo()
    await jest.advanceTimersByTimeAsync(MCP_SLOT_QUIET_MS + 1)
    await expect(operar(ctx, 'count')).rejects.toMatchObject({ reason: 'tool-finished' })
  })

  it('una TRANSACCIÓN de esa rama espera su turno ANTES de empezar (sin candados ni conexión tomados)', async () => {
    jest.useFakeTimers()
    const vieja = await unidadQueEscribioYSoltoElCupo()
    const nueva = correr(toolCall('b', 2), 'staff-1', { conTrabajo: true })
    let empezo = false
    const transaccion = runWithContext(vieja, () =>
      runCancellableTransaction(async () => {
        empezo = true
        return 1
      }),
    )
    await jest.advanceTimersByTimeAsync(1_000)
    expect(empezo).toBe(false)
    nueva.res.terminar()
    nueva.terminarTrabajo()
    await jest.advanceTimersByTimeAsync(MCP_SLOT_QUIET_MS + 1)
    await transaccion
    expect(empezo).toBe(true)
  })

  it('si la operación que recuperó el cupo ya no puede correr, el cupo se suelta igual tras la calma', async () => {
    jest.useFakeTimers()
    const vieja = await unidadQueEscribioYSoltoElCupo()
    const nueva = correr(toolCall('b', 2), 'staff-1', { conTrabajo: true })
    // El rechazo llega mientras avanza el reloj: se atrapa desde ya, o el vigilante de promesas sin manejar lo tumba.
    const escritura = operar(vieja, 'update').catch((e: unknown) => e)
    await jest.advanceTimersByTimeAsync(1)
    // Mientras esperaba, otra rama de la unidad fue cortada (p. ej. tras un endOfWriteUnit): ya no se escribe nada.
    vieja.cancellation!.refused = true
    nueva.res.terminar()
    nueva.terminarTrabajo()
    await jest.advanceTimersByTimeAsync(MCP_SLOT_QUIET_MS + 1)
    expect(await escritura).toBeInstanceOf(RequestCancelledError)
    await jest.advanceTimersByTimeAsync(MCP_SLOT_QUIET_MS + 1)
    expect(correr(toolCall('c', 3)).paso).toBe(true)
  })

  it('la rama sobrante va ANTES que una petición nueva que también esperaba su turno', () => {
    const control = { requests: 1, tools: 0, label: 'tools/list' }
    const a = mcpRequestSlots.tryAcquire('staff-7', control)!
    mcpRequestSlots.tryAcquire('staff-7', control)
    const orden: string[] = []
    void mcpRequestSlots.waitForRoom('staff-7', control, 60_000).then(s => s && orden.push('nueva'))
    void mcpRequestSlots.waitForRoom('staff-7', control, 60_000, undefined, { priority: true }).then(s => s && orden.push('sobrante'))
    a.release()
    return new Promise<void>(resolve =>
      setImmediate(() => {
        expect(orden).toEqual(['sobrante'])
        resolve()
      }),
    )
  })

  it('NUNCA sigue sin cupo (Codex ronda 4): a los 30 s avisa y sigue esperando hasta que haya lugar', async () => {
    jest.useFakeTimers()
    const vieja = await unidadQueEscribioYSoltoElCupo()
    const nueva = correr(toolCall('b', 2), 'staff-1', { conTrabajo: true })
    let leyo = false
    const lectura = operar(vieja, 'findMany', { alCorrer: () => (leyo = true) })
    await jest.advanceTimersByTimeAsync(MCP_REATTACH_ALERT_MS * 3)
    expect(leyo).toBe(false)
    expect(mockedLogger.error).toHaveBeenCalledWith(
      'mcp.rama desatada sigue esperando cupo',
      expect.objectContaining({ staffId: 'staff-1' }),
    )
    expect(mockedLogger.error.mock.calls.filter(([m]) => m === 'mcp.rama desatada sigue esperando cupo')).toHaveLength(1)
    nueva.res.terminar()
    nueva.terminarTrabajo()
    await jest.advanceTimersByTimeAsync(MCP_SLOT_QUIET_MS + 1)
    await lectura
    expect(leyo).toBe(true)
  })
})

describe('ronda 5 de Codex — una transacción que sobrevive a la exterior sigue reteniendo el cupo (P1)', () => {
  it('la siguiente herramienta de la persona NO entra mientras vive la transacción hija', async () => {
    jest.useFakeTimers()
    const primera = correr(toolCall('a', 1), 'staff-1', { conTrabajo: true })
    const ctx = primera.contexto()!
    let terminarHija!: () => void
    let hija!: Promise<unknown>
    // La exterior abre una transacción INDEPENDIENTE y termina antes que ella: comparten contexto, no transacción.
    await runWithContext(ctx, () =>
      runCancellableTransaction(async () => {
        hija = runCancellableTransaction(() => new Promise<void>(r => (terminarHija = r)))
      }),
    )
    primera.res.terminar()
    primera.terminarTrabajo()
    await jest.advanceTimersByTimeAsync(MCP_SLOT_QUIET_MS + 50)
    const nueva = correr(toolCall('b', 2))
    expect(nueva.paso).toBe(false)
    expect(nueva.res.body?.result?.isError).toBe(true)
    terminarHija()
    await hija
    await jest.advanceTimersByTimeAsync(MCP_SLOT_QUIET_MS + 1)
    expect(correr(toolCall('c', 3)).paso).toBe(true)
  })
})
