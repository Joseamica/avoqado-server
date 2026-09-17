/**
 * Terminal Payment Service — durable per-terminal payment lock + recovery (Slice 1)
 *
 * The lock is a durable TerminalPaymentRequest row whose partial UNIQUE index
 * (active statuses) is the per-terminal mutex. A concurrent second active
 * charge fails with P2002 → rejected fast with TerminalBusyError; the in-memory
 * Map is only the long-poll transport. Recovery: closeRow (CAS), the TPV REST
 * close, and the watchdog reconcile.
 *
 * 1. NEW FEATURE TESTS — DB-backed lock, replay, recovery
 * 2. REGRESSION TESTS — single charge, not-connected, independent terminals
 */

import { Prisma, TerminalPaymentRequestStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import {
  desenlaceCanonico,
  leerProcedencia,
  TERMINAL_ATTEMPT_LINK_VERSION,
  terminalPaymentService,
  UNPROVEN_NEGATIVE_WINDOW_MS,
} from '@/services/terminal-payment.service'
import {
  BadRequestError,
  OrderAlreadyPaidError,
  TerminalBusyError,
  TerminalPaymentAdmissionRetryError,
  TerminalUnavailableError,
} from '@/errors/AppError'

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: jest.fn() },
  socketManager: { getServer: jest.fn() },
}))

jest.mock('@/communication/sockets/terminal-registry', () => {
  const normalizeTerminalId = (id: string) => id.replace(/^AVQD-/i, '').toLowerCase()
  return {
    normalizeTerminalId,
    terminalRegistry: {
      getTerminal: jest.fn(),
      getTerminalBySocketId: jest.fn(),
      getAllTerminalIds: jest.fn(() => []),
    },
  }
})

const prismaMock = prisma as any
const mockedGetServer = (socketManager as unknown as { getServer: jest.Mock }).getServer
const mockedGetTerminal = terminalRegistry.getTerminal as jest.Mock
const mockedGetTerminalBySocketId = terminalRegistry.getTerminalBySocketId as jest.Mock
const tpr = () => prismaMock.terminalPaymentRequest

const P2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
const flush = () => new Promise(resolve => setImmediate(resolve))

// Socket success references an already committed Payment. The real PostgreSQL
// suite exercises creation, transaction rollback and conflicting associations.
function committedRequests(payments: Record<string, string>) {
  tpr().findFirst.mockImplementation(async ({ where }: any) =>
    payments[where.requestId]
      ? {
          requestId: where.requestId,
          venueId: 'venue-1',
          status: 'COMPLETED',
          paymentId: payments[where.requestId],
          resultJson: null,
        }
      : null,
  )
}

/**
 * Codex r3 (P1-N2): los barridos (vencidas, UNKNOWN, liberadas) y la liberación manual cierran por `closeRowFromPaymentTx`
 * dentro de `prisma.$transaction` (el mock entrega el propio `prismaMock` como `tx`). Ese cierre RELEE la fila (`before`) y el
 * Payment con su procedencia, escribe la fila con CAS `paymentId: null` y ETIQUETA al Payment como ganador. Arma esas lecturas.
 */
function cierreComunCon(row: Record<string, unknown>, payment: Record<string, unknown>) {
  tpr().findFirst.mockResolvedValue(row)
  prismaMock.payment.findFirst.mockResolvedValue({
    processorData: {},
    terminalPaymentRequestId: null,
    orderId: row.orderId ?? null,
    source: 'TPV',
    amount: new Prisma.Decimal(100),
    tipAmount: new Prisma.Decimal(0),
    ...payment,
  })
  prismaMock.payment.updateMany.mockResolvedValue({ count: 1 })
}
/** La escritura del cierre común: CAS «todavía sin ganador» sobre la solicitud, y la etiqueta del ganador en el Payment. */
function cerradaPorElCierreComun(requestId: string, paymentId: string, data: Record<string, unknown> = {}) {
  expect(tpr().updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { requestId, venueId: 'venue-1', paymentId: null },
      data: expect.objectContaining({ status: 'COMPLETED', paymentId, ...data }),
    }),
  )
  expect(prismaMock.payment.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: paymentId, venueId: 'venue-1' },
      data: expect.objectContaining({
        terminalPaymentRequestId: requestId,
        processorData: expect.objectContaining({ terminalPaymentRequestId: requestId }),
      }),
    }),
  )
}

let emit: jest.Mock
let directEmit: jest.Mock

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    terminalId: 'T-DEFAULT',
    amountCents: 10000,
    venueId: 'venue-1',
    requestedBy: 'user-1',
    ...overrides,
  } as any
}

beforeEach(() => {
  jest.clearAllMocks()
  delete process.env.TERMINAL_PAYMENT_LOCK_ENABLED

  emit = jest.fn()
  directEmit = jest.fn((_event: string, payload: { requestId: string }, callback?: (error: null, response: unknown) => void) => {
    callback?.(null, { accepted: true, requestId: payload.requestId })
  })
  const directSocket = {
    emit: directEmit,
    timeout: jest.fn(() => ({ emit: directEmit })),
  }
  const io = {
    to: jest.fn(() => ({ emit })),
    sockets: { sockets: { get: jest.fn(() => directSocket) } },
  }
  mockedGetServer.mockReturnValue(io)

  mockedGetTerminal.mockImplementation((id: string) => {
    const normalized = id.replace(/^AVQD-/i, '').toLowerCase()
    return {
      socketId: `sock-${normalized}`,
      venueId: 'venue-1',
      terminalId: normalized,
      registeredAt: new Date(),
      lastHeartbeat: new Date(),
      terminalPaymentAckVersion: 1,
    }
  })
  mockedGetTerminalBySocketId.mockImplementation((socketId: string) => ({
    socketId,
    venueId: 'venue-1',
    terminalId: socketId.replace(/^sock-/, ''),
    registeredAt: new Date(),
    lastHeartbeat: new Date(),
    terminalPaymentAckVersion: 1,
  }))

  // Durable-row mock defaults: INSERT succeeds, nothing pre-existing, CAS updates 1 row.
  tpr().create.mockReset().mockResolvedValue({})
  tpr().findUnique.mockReset().mockResolvedValue(null)
  tpr().findFirst.mockReset().mockResolvedValue(null)
  tpr().findMany.mockReset().mockResolvedValue([])
  tpr().updateMany.mockReset().mockResolvedValue({ count: 1 })
  // Codex r1 (P1-A): `closeRow` enumera los vínculos de la solicitud ante TODO negativo; sin vínculos no consulta el veto bancario.
  // Sin este default el mock devolvía `undefined` y el `.map` caía al `catch` (UNKNOWN) — un camino distinto del real.
  prismaMock.terminalPaymentAttemptLink.findMany.mockReset().mockResolvedValue([])
  prismaMock.payment.findFirst.mockResolvedValue(null)
  prismaMock.order.findFirst.mockReset().mockResolvedValue({ paymentStatus: 'PENDING', orderNumber: 'TEST-ORDER' })
  // La procedencia de la entrega se graba con $executeRaw ANTES de emitir: 1 fila = grabada. (El mock global
  // resuelve 0, que el servicio lee —a propósito— como «no se pudo grabar» y entonces NO emite.)
  prismaMock.$executeRaw.mockReset().mockResolvedValue(1)
  prismaMock.activityLog.findFirst.mockReset().mockResolvedValue(null)
})

describe('leerProcedencia — qué dice la fila sobre sus entregas', () => {
  // Auditoría 11-sep (P3-4): filtrar las entradas malformadas convertía «hubo algo que no sé leer» en «nunca se
  // entregó» ([]), que es justo lo que autoriza a la sonda a liberar y al replay a reenviar. Lo que no se sabe leer
  // es procedencia DESCONOCIDA (null), igual que una fila anterior a la columna.
  const valida = {
    protocol: 'DURABLE',
    ackVersion: 1,
    cancelDispositionVersion: 1,
    probeVersion: 1,
    socketId: 's',
    at: '2026-09-11T10:00:00.000Z',
    replay: false,
  }
  it('sin columna, sin objeto o sin arreglo ⇒ desconocida', () => {
    expect(leerProcedencia(null)).toBeNull()
    expect(leerProcedencia('x')).toBeNull()
    expect(leerProcedencia({})).toBeNull()
    expect(leerProcedencia({ deliveries: 'x' })).toBeNull()
  })
  it('arreglo vacío ⇒ nunca entregada; entradas válidas ⇒ se devuelven tal cual', () => {
    expect(leerProcedencia({ deliveries: [] })).toEqual([])
    expect(leerProcedencia({ deliveries: [valida, { ...valida, protocol: 'LEGACY', ackVersion: 0 }] })).toHaveLength(2)
  })
  it('una sola entrada malformada o con protocolo desconocido vuelve DESCONOCIDA toda la procedencia', () => {
    expect(leerProcedencia({ deliveries: [{ foo: 1 }] })).toBeNull()
    expect(leerProcedencia({ deliveries: [valida, null] })).toBeNull()
    expect(leerProcedencia({ deliveries: [{ ...valida, protocol: 'OTRO' }] })).toBeNull()
  })
})

describe('TerminalPaymentService — durable per-terminal lock (Slice 1)', () => {
  it.each(['ACK_TIMEOUT', 'ACK_REJECTED'])('legacy FAILED %s is UNKNOWN on recovery GET', async failureCode => {
    tpr().findFirst.mockResolvedValueOnce({
      requestId: 'REQ-OLD',
      venueId: 'venue-1',
      terminalId: 't-default',
      status: 'FAILED',
      failureCode,
      paymentId: null,
      amountCents: 10000,
      tipCents: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    expect(await terminalPaymentService.getPaymentStatus('REQ-OLD', 'venue-1')).toMatchObject({ status: 'UNKNOWN' })
  })

  it('a cancelled socket result cannot contradict an already committed payment in the HTTP response', async () => {
    const pending = terminalPaymentService.sendPaymentToTerminal(baseRequest({ requestId: 'REQ-RACE' }))
    await flush()
    tpr().findFirst.mockResolvedValue({ requestId: 'REQ-RACE', status: 'COMPLETED', paymentId: 'pay-committed', resultJson: null })
    tpr().updateMany.mockResolvedValue({ count: 0 })
    // Codex r2 (P1-A): el negativo se escribe con un UPDATE crudo condicional bajo candado; 0 filas = la fila ya no es la leída.
    prismaMock.$executeRaw.mockResolvedValue(0)
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: 'REQ-RACE', status: 'cancelled' },
      { terminalId: 't-default', venueId: 'venue-1', socketId: 'sock-t-default' },
    )
    expect(await pending).toMatchObject({ status: 'success', paymentId: 'pay-committed' })
  })

  it('a result whose durable close failed stays uncertain in the HTTP response', async () => {
    const pending = terminalPaymentService.sendPaymentToTerminal(baseRequest({ requestId: 'REQ-DB-FAIL' }))
    await flush()
    tpr().findFirst.mockResolvedValue({ requestId: 'REQ-DB-FAIL' })
    tpr().updateMany.mockRejectedValue(new Error('database offline'))
    prismaMock.$executeRaw.mockRejectedValue(new Error('database offline')) // Codex r2 (P1-A): la escritura del negativo es cruda
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: 'REQ-DB-FAIL', status: 'cancelled' },
      { terminalId: 't-default', venueId: 'venue-1', socketId: 'sock-t-default' },
    )
    expect(await pending).toMatchObject({ status: 'timeout' })
  })

  it('a cancellation without a request identity never reaches the native terminal', async () => {
    expect(await terminalPaymentService.cancelPayment('t-default', undefined, undefined, 'venue-1')).toEqual({
      cancelIntent: 'MISSING_REQUEST_ID',
      cancelEmitted: false,
      payment: null,
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it.each(['ACK_TIMEOUT', 'ACK_REJECTED'])('legacy FAILED %s replays uncertainty instead of permitting a charge', async failureCode => {
    tpr().create.mockRejectedValueOnce(P2002)
    tpr().findFirst.mockResolvedValueOnce({
      venueId: 'venue-1',
      terminalId: 't-default',
      tipCents: 0,
      orderId: null,
      requestId: 'REQ-LEGACY-ACK',
      status: 'FAILED',
      failureCode,
      paymentId: null,
      resultJson: { requestId: 'REQ-LEGACY-ACK', status: 'failed', errorMessage: 'No se inició ningún cargo' },
      amountCents: 10000,
      createdAt: new Date(),
    })
    expect(await terminalPaymentService.sendPaymentToTerminal(baseRequest({ requestId: 'REQ-LEGACY-ACK' }))).toMatchObject({
      status: 'timeout',
    })
    expect(directEmit).not.toHaveBeenCalled()
  })

  it('cancel cannot emit or unblock a different terminal request when its scoped CAS matched nothing', async () => {
    tpr().updateMany.mockResolvedValueOnce({ count: 0 })
    expect(await terminalPaymentService.cancelPayment('t-foreign', 'REQ-OTHER', undefined, 'venue-1')).toEqual({
      cancelIntent: 'NOT_FOUND',
      cancelEmitted: false,
      payment: null,
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it('committed Payment beats an older cancelled resultJson during idempotent replay', async () => {
    tpr().create.mockRejectedValueOnce(P2002)
    tpr().findFirst.mockResolvedValueOnce({
      venueId: 'venue-1',
      terminalId: 't-default',
      tipCents: 0,
      orderId: null,
      requestId: 'REQ-MONEY',
      status: 'COMPLETED',
      paymentId: 'pay-committed',
      resultJson: { requestId: 'REQ-MONEY', status: 'cancelled' },
      amountCents: 10000,
      createdAt: new Date(),
    })
    expect(await terminalPaymentService.sendPaymentToTerminal(baseRequest({ requestId: 'REQ-MONEY' }))).toMatchObject({
      status: 'success',
      paymentId: 'pay-committed',
    })
    expect(directEmit).not.toHaveBeenCalled()
  })

  it('terminal timeout leaves the execution protected instead of releasing the slot (ventana: TIMED_OUT con el sobre de la terminal)', async () => {
    const pending = terminalPaymentService.sendPaymentToTerminal(baseRequest({ requestId: 'REQ-UNKNOWN-RESULT' }))
    await flush()
    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-UNKNOWN-RESULT', status: 'timeout' })
    await pending
    await flush()
    // Plan 16-sep: un `timeout` que MANDA LA TERMINAL entra en la ventana de confirmación — TIMED_OUT (no UNKNOWN), sin código
    // y con el sobre original conservado en `terminalResult`. La ranura y la orden siguen bloqueadas mientras la ventana decide.
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requestId: 'REQ-UNKNOWN-RESULT' }),
        data: expect.objectContaining({
          status: 'TIMED_OUT',
          failureCode: null,
          resultJson: expect.objectContaining({ status: 'timeout', terminalResult: expect.objectContaining({ status: 'timeout' }) }),
        }),
      }),
    )
    expect(tpr().updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'UNKNOWN' }) }))
    const programadas = (terminalPaymentService as any).ventanasProgramadas as Map<string, NodeJS.Timeout>
    expect(programadas.has('REQ-UNKNOWN-RESULT')).toBe(true)
    clearTimeout(programadas.get('REQ-UNKNOWN-RESULT')!)
    programadas.delete('REQ-UNKNOWN-RESULT')
  })

  it('cancel intent is durable before the terminal can synchronously acknowledge it', async () => {
    let persisted = false
    tpr().updateMany.mockImplementation(async ({ data }: any) => {
      if (data.status === 'CANCEL_REQUESTED') persisted = true
      return { count: 1 }
    })
    emit.mockImplementation(() => {
      expect(persisted).toBe(true)
    })
    await terminalPaymentService.cancelPayment('T-CANCEL', 'REQ-CANCEL-ORDER', undefined, 'venue-1')
  })

  it('cancel admission refused by the terminal persists ACTIVE without a financial close', async () => {
    tpr().findFirst.mockResolvedValueOnce({ id: 'row-active', requestId: 'REQ-ACTIVE', status: 'CANCEL_REQUESTED' })
    const accepted = await (terminalPaymentService as any).handleCancelDispositionFromSocket(
      { requestId: 'REQ-ACTIVE', disposition: 'ACTIVE' },
      { socketId: 'socket-1', terminalId: 'T-ACTIVE', venueId: 'venue-1' },
    )
    expect(accepted).toBe(true)
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requestId: 'REQ-ACTIVE', venueId: 'venue-1', terminalId: 't-active' }),
        data: expect.objectContaining({ cancelDisposition: 'ACTIVE' }),
      }),
    )
    expect((tpr().updateMany as jest.Mock).mock.calls.some(([arg]) => ['CANCELLED', 'FAILED'].includes(arg.data.status))).toBe(false)
  })

  it('another terminal cannot report cancellation disposition for someone else’s charge', async () => {
    tpr().findFirst.mockResolvedValueOnce(null)
    expect(
      await (terminalPaymentService as any).handleCancelDispositionFromSocket(
        { requestId: 'REQ-FOREIGN', disposition: 'ACCEPTED' },
        { socketId: 'attacker', terminalId: 'attacker', venueId: 'venue-2' },
      ),
    ).toBe(false)
    expect(tpr().updateMany).not.toHaveBeenCalled()
  })

  it('a confirmed pre-execution cancellation is durable and explicitly safe for new POS clients', async () => {
    tpr().findFirst.mockResolvedValueOnce({ id: 'row-accepted', requestId: 'REQ-ACCEPTED', status: 'CANCEL_REQUESTED' })
    expect(
      await (terminalPaymentService as any).handleCancelDispositionFromSocket(
        { requestId: 'REQ-ACCEPTED', disposition: 'ACCEPTED' },
        { socketId: 'socket', terminalId: 't-accepted', venueId: 'venue-1' },
      ),
    ).toBe(true)
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED', cancelDisposition: 'ACCEPTED' }),
      }),
    )
  })

  it('rejects a second concurrent charge during physical admission with a busy error naming the blocker (and leaves its tombstone)', async () => {
    // El bloqueador se ve BAJO el candado de la terminal: la decisión es el rechazo, no un choque del índice.
    tpr()
      .findFirst.mockResolvedValueOnce(null) // my requestId not in table
      .mockResolvedValueOnce({
        requestId: 'REQ-A',
        venueId: 'venue-1',
        amountCents: 35000,
        senderDevice: 'iPad Caja 1',
        createdAt: new Date(Date.now() - 12_000),
        status: 'PENDING',
      })

    let busy: any
    try {
      await terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-LOCK', requestId: 'REQ-B' }))
      throw new Error('expected TerminalBusyError')
    } catch (e) {
      busy = e
    }

    expect(busy).toBeInstanceOf(TerminalBusyError)
    expect(busy.code).toBe('TERMINAL_BUSY')
    expect(busy.details.blockingRequest.requestId).toBe('REQ-A')
    expect(busy.details.blockingRequest.amountCents).toBe(35000)
    expect(busy.details.blockingRequest.senderDevice).toBe('iPad Caja 1')
    expect(busy.details.requestId).toBe('REQ-B') // correlación: el POS sabe que ESTE cobro no se creó
    // La ÚNICA escritura es la LÁPIDA (FAILED, fuera de la ranura): nunca una fila que ocupe la terminal.
    expect(tpr().create).toHaveBeenCalledTimes(1)
    expect(tpr().create.mock.calls[0][0].data).toMatchObject({
      requestId: 'REQ-B',
      terminalId: 't-lock',
      status: 'FAILED',
      failureCode: 'REJECTED_TERMINAL_BUSY',
      deliveryProvenance: { deliveries: [] },
      resultJson: { httpStatus: 409, code: 'TERMINAL_BUSY', message: busy.message, details: busy.details },
    })
    expect(directEmit).not.toHaveBeenCalled() // never reached the terminal
  })

  it('idempotent replay: same requestId on an already-COMPLETED row returns the stored result, no re-emit', async () => {
    tpr().create.mockRejectedValueOnce(P2002)
    tpr().findFirst.mockResolvedValueOnce({
      venueId: 'venue-1',
      terminalId: 't-replay',
      tipCents: 0,
      orderId: null,
      requestId: 'REQ-A',
      status: 'COMPLETED',
      paymentId: 'pay-1',
      resultJson: { requestId: 'REQ-A', status: 'success', paymentId: 'pay-1' },
      amountCents: 10000,
      createdAt: new Date(),
    })

    const result = await terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-REPLAY', requestId: 'REQ-A' }))
    expect(result.status).toBe('success')
    expect(result.paymentId).toBe('pay-1')
    expect(directEmit).not.toHaveBeenCalled()
  })

  it('same requestId still in flight replays uncertainty without a negative response or second emit', async () => {
    tpr().create.mockRejectedValueOnce(P2002)
    tpr().findFirst.mockResolvedValueOnce({
      venueId: 'venue-1',
      terminalId: 't-dup',
      tipCents: 0,
      orderId: null,
      requestId: 'REQ-A',
      status: 'PENDING',
      amountCents: 10000,
      senderDevice: null,
      createdAt: new Date(),
    })

    await expect(
      terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-DUP', requestId: 'REQ-A' })),
    ).resolves.toMatchObject({ status: 'timeout' })
    expect(directEmit).not.toHaveBeenCalled()
  })

  it('happy path: INSERT succeeds → emits → recorded payment produces the canonical result', async () => {
    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-OK', requestId: 'REQ-1' }))
    // give the async create a tick, then assert the emit happened
    await flush()
    expect(tpr().create).toHaveBeenCalledTimes(1)
    expect(directEmit).toHaveBeenCalledWith(
      'terminal:payment_request',
      expect.objectContaining({ requestId: 'REQ-1' }),
      expect.any(Function),
    )

    committedRequests({ 'REQ-1': 'pay-9' })
    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-1', status: 'success', paymentId: 'pay-9' })
    const result = await p1
    expect(result.status).toBe('success')

    await flush() // let the fire-and-forget closeRow run
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requestId: 'REQ-1', status: 'COMPLETED', paymentId: 'pay-9' }),
      }),
    )
  })

  it('persiste el contrato completo antes de entregar: vendedor, rating y omisión de review', async () => {
    const p1 = terminalPaymentService.sendPaymentToTerminal(
      baseRequest({
        terminalId: 'T-CONTRACT',
        requestId: 'REQ-CONTRACT',
        processedByStaffId: 'staff-pos',
        rating: 5,
        skipReview: true,
      }),
    )
    await flush()

    expect(tpr().create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processedByStaffId: 'staff-pos',
          rating: 5,
          skipReview: true,
        }),
      }),
    )

    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-CONTRACT', status: 'cancelled' })
    await p1
  })

  it('sólo marca SENT y renueva expiración después del ACK durable de la TPV', async () => {
    const before = Date.now()
    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-ACK', requestId: 'REQ-ACK' }))
    await flush()

    expect(directEmit).toHaveBeenCalledWith(
      'terminal:payment_request',
      expect.objectContaining({ requestId: 'REQ-ACK' }),
      expect.any(Function),
    )
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requestId: 'REQ-ACK', venueId: 'venue-1', status: 'PENDING' }),
        data: expect.objectContaining({
          status: 'SENT',
          acknowledgedAt: expect.any(Date),
          expiresAt: expect.any(Date),
        }),
      }),
    )
    const ackUpdate = (tpr().updateMany as jest.Mock).mock.calls.find(call => call[0]?.data?.status === 'SENT')?.[0]
    expect(ackUpdate.data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 299_000)

    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-ACK', status: 'cancelled' })
    await p1
  })

  it('un ACK perdido conserva resultado desconocido aunque la terminal ya haya iniciado el cobro', async () => {
    directEmit.mockImplementationOnce((_event: string, _payload: unknown, callback: (error: Error) => void) =>
      callback(new Error('operation has timed out')),
    )

    await expect(
      terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-NO-ACK', requestId: 'REQ-NO-ACK' })),
    ).resolves.toMatchObject({ requestId: 'REQ-NO-ACK', status: 'timeout' })
    await flush()

    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requestId: 'REQ-NO-ACK', venueId: 'venue-1', status: 'PENDING' },
        data: expect.objectContaining({ status: 'UNKNOWN', failureCode: 'ACK_TIMEOUT' }),
      }),
    )
  })

  it('una TPV publicada sin capacidad ACK conserva la entrega única compatible', async () => {
    mockedGetTerminal.mockReturnValueOnce({
      socketId: 'sock-t-legacy',
      venueId: 'venue-1',
      terminalId: 't-legacy',
      registeredAt: new Date(),
      lastHeartbeat: new Date(),
    })

    const pending = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-LEGACY', requestId: 'REQ-LEGACY' }))
    await flush()

    expect(directEmit).toHaveBeenCalledWith('terminal:payment_request', expect.objectContaining({ requestId: 'REQ-LEGACY' }))
    expect(directEmit).toHaveBeenCalledTimes(1)

    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-LEGACY', status: 'cancelled' })
    await pending
  })

  it('rechaza un resultado cuyo socket no corresponde a la terminal y venue de la solicitud', async () => {
    tpr().findFirst.mockResolvedValueOnce(null)

    const handled = await (terminalPaymentService as any).handlePaymentResultFromSocket(
      { requestId: 'REQ-FOREIGN', status: 'success', paymentId: 'pay-foreign' },
      { socketId: 'sock-attacker', terminalId: 'attacker', venueId: 'venue-2' },
    )

    expect(handled).toBe(false)
    expect(tpr().findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requestId: 'REQ-FOREIGN', terminalId: 'attacker', venueId: 'venue-2' }),
      }),
    )
    expect(tpr().updateMany).not.toHaveBeenCalled()
  })

  it('acepta el resultado sólo desde el socket registrado para esa solicitud', async () => {
    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-AUTH', requestId: 'REQ-AUTH' }))
    await flush()
    committedRequests({ 'REQ-AUTH': 'pay-auth' })

    const handled = await (terminalPaymentService as any).handlePaymentResultFromSocket(
      { requestId: 'REQ-AUTH', status: 'success', paymentId: 'pay-auth' },
      { socketId: 'sock-t-auth', terminalId: 't-auth', venueId: 'venue-1' },
    )

    expect(handled).toBe(true)
    expect((await p1).paymentId).toBe('pay-auth')
  })

  it('al reconectar reentrega una solicitud fresca SENT, nunca una expirada', async () => {
    tpr().findMany.mockResolvedValueOnce([
      {
        requestId: 'REQ-RECONNECT',
        terminalId: 't-reconnect',
        venueId: 'venue-1',
        status: 'SENT',
        amountCents: 10000,
        tipCents: 500,
        rating: 5,
        skipReview: true,
        orderId: null,
        senderDevice: 'iPad',
        processedByStaffId: 'staff-pos',
        expiresAt: new Date(Date.now() + 60_000),
        // Una SENT fue ACK-eada por un socket durable: su procedencia lo dice, y es lo que autoriza el replay.
        deliveryProvenance: {
          deliveries: [{ protocol: 'DURABLE', ackVersion: 1, socketId: 'sock-old', at: new Date().toISOString(), replay: false }],
        },
      },
    ])

    await (terminalPaymentService as any).replayPendingForTerminal('T-RECONNECT', 'venue-1', 'sock-t-reconnect')

    expect(tpr().findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          terminalId: 't-reconnect',
          venueId: 'venue-1',
          expiresAt: { gt: expect.any(Date) },
        }),
      }),
    )
    expect(directEmit).toHaveBeenCalledWith(
      'terminal:payment_request',
      expect.objectContaining({ requestId: 'REQ-RECONNECT', processedByStaffId: 'staff-pos' }),
      expect.any(Function),
    )
  })

  // Checkpoint 2 · N0 (Codex sobre el diseño v1, 16-sep): la capacidad del servidor viaja EN la solicitud, en los DOS payloads.
  // La TPV sólo espera el ACK del vínculo (S1) si la solicitud que está cobrando trae la bandera; contra un servidor anterior —o una
  // solicitud reentregada por uno— no espera nada. Aditivo: ningún campo desaparece.
  it('N0 · la entrega fresca lleva `attemptLinkVersion: 1` además de todos los campos de siempre', async () => {
    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-OK', requestId: 'REQ-N0' }))
    await flush()
    expect(directEmit).toHaveBeenCalledWith(
      'terminal:payment_request',
      expect.objectContaining({
        requestId: 'REQ-N0',
        amountCents: expect.any(Number),
        tipCents: expect.any(Number),
        venueId: expect.any(String),
        timestamp: expect.any(String),
        attemptLinkVersion: TERMINAL_ATTEMPT_LINK_VERSION,
      }),
      expect.any(Function),
    )
    expect(TERMINAL_ATTEMPT_LINK_VERSION).toBe(1)
    committedRequests({ 'REQ-N0': 'pay-n0' })
    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-N0', status: 'success', paymentId: 'pay-n0' })
    await p1
  })

  it('N0 · el replay al reconectar lleva la MISMA bandera, conservando la restricción de procedencia durable', async () => {
    tpr().findMany.mockResolvedValueOnce([
      {
        requestId: 'REQ-N0-REPLAY',
        terminalId: 't-reconnect',
        venueId: 'venue-1',
        status: 'SENT',
        amountCents: 10000,
        tipCents: 0,
        rating: null,
        skipReview: true,
        orderId: null,
        senderDevice: 'iPad',
        processedByStaffId: 'staff-pos',
        expiresAt: new Date(Date.now() + 60_000),
        deliveryProvenance: {
          deliveries: [{ protocol: 'DURABLE', ackVersion: 1, socketId: 'sock-old', at: new Date().toISOString(), replay: false }],
        },
      },
    ])
    await (terminalPaymentService as any).replayPendingForTerminal('T-RECONNECT', 'venue-1', 'sock-t-reconnect')
    expect(directEmit).toHaveBeenCalledWith(
      'terminal:payment_request',
      expect.objectContaining({ requestId: 'REQ-N0-REPLAY', attemptLinkVersion: TERMINAL_ATTEMPT_LINK_VERSION }),
      expect.any(Function),
    )
  })

  it('al reconectar NO reentrega una fila de procedencia desconocida ni una entregada a un socket legacy', async () => {
    // Codex 11-sep (3): la fila pudo llegar a una app SIN bandeja; reentregarla a una bandeja que no la conoce la ejecuta otra vez.
    tpr().findMany.mockResolvedValueOnce([
      {
        requestId: 'REQ-SIN-PROCEDENCIA',
        id: 'row-1',
        terminalId: 't-reconnect',
        venueId: 'venue-1',
        status: 'SENT',
        amountCents: 10000,
        tipCents: 0,
        orderId: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        requestId: 'REQ-LEGACY',
        id: 'row-2',
        terminalId: 't-reconnect',
        venueId: 'venue-1',
        status: 'PENDING',
        amountCents: 10000,
        tipCents: 0,
        orderId: null,
        expiresAt: new Date(Date.now() + 60_000),
        deliveryProvenance: {
          deliveries: [{ protocol: 'LEGACY', ackVersion: 0, socketId: 'sock-old', at: new Date().toISOString(), replay: false }],
        },
      },
    ])

    await (terminalPaymentService as any).replayPendingForTerminal('T-RECONNECT', 'venue-1', 'sock-t-reconnect')

    expect(directEmit).not.toHaveBeenCalled()
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
  })

  it('a legacy rollback flag cannot bypass the durable authorization barrier', async () => {
    process.env.TERMINAL_PAYMENT_LOCK_ENABLED = 'false'
    // La barrera es el candado de la terminal + el bloqueador visto BAJO él (ya no un choque del índice, que el
    // flujo viejo simulaba con un P2002 en el `create` del cobro). Con el flag puesto, igual rechaza y no emite.
    tpr().findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      requestId: 'REQ-A',
      amountCents: 10000,
      senderDevice: null,
      createdAt: new Date(),
      status: 'PENDING',
    })
    const result = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-FLAG', requestId: 'REQ-B' }))
    const settled = result.then(
      value => value,
      error => error,
    )
    await flush()
    const emitted = directEmit.mock.calls.length
    if (emitted) terminalPaymentService.handlePaymentResult({ requestId: 'REQ-B', status: 'timeout' })
    expect(await settled).toBeInstanceOf(TerminalBusyError)
    expect(emitted).toBe(0)
    // Ninguna fila que ocupe la terminal: la única escritura es la lápida del rechazo.
    for (const [{ data }] of tpr().create.mock.calls)
      expect(data).toMatchObject({ status: 'FAILED', failureCode: 'REJECTED_TERMINAL_BUSY' })
  })

  it('isTerminalBusy / getBusyTerminalIds read the durable rows', async () => {
    tpr().findFirst.mockResolvedValueOnce({ id: 'x' })
    expect(await terminalPaymentService.isTerminalBusy('AVQD-ABC', 'venue-1')).toBe(true)
    tpr().findFirst.mockResolvedValueOnce(null)
    expect(await terminalPaymentService.isTerminalBusy('AVQD-ABC', 'venue-1')).toBe(false)

    tpr().groupBy.mockResolvedValueOnce([{ terminalId: 'a' }, { terminalId: 'b' }])
    const set = await terminalPaymentService.getBusyTerminalIds('venue-1', ['a', 'b'])
    expect(set).toEqual(new Set(['a', 'b']))
  })

  it('cancelPayment marks the row CANCEL_REQUESTED (holds slot) and resolves the long-poll', async () => {
    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-CANCEL', requestId: 'REQ-C' }))
    await flush()

    await terminalPaymentService.cancelPayment('T-CANCEL', 'REQ-C', undefined, 'venue-1')
    const result = await p1
    expect(result.status).toBe('timeout')
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCEL_REQUESTED' }) }),
    )
  })

  it('cancelPayment scopes the row write by venueId (a requestId alone cannot touch another venue)', async () => {
    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-SCOPE', requestId: 'REQ-S1' }))
    await flush()

    await terminalPaymentService.cancelPayment('T-SCOPE', 'REQ-S1', 'user cancel', 'venue-1')

    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requestId: 'REQ-S1', venueId: 'venue-1' }),
        data: expect.objectContaining({ status: 'CANCEL_REQUESTED' }),
      }),
    )
    await p1
  })

  it('cancelPayment still cancels the row when the terminal is OFFLINE (intent is not lost)', async () => {
    // Returning early on an unreachable terminal used to leave the row holding the
    // slot until expiresAt (5 min) while the POS had already cancelled and moved on.
    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-OFF', requestId: 'REQ-OFF' }))
    await flush()
    mockedGetTerminal.mockReturnValue(null) // terminal dropped off after dispatch

    const resultado = await terminalPaymentService.cancelPayment('T-OFF', 'REQ-OFF', 'user cancel', 'venue-1')

    // …y ahora lo DICE por separado (§8 C.2): la intención quedó guardada aunque no se pudiera emitir. Antes los dos
    // casos salían como el mismo `false` y el POS no podía distinguirlos.
    expect(resultado).toMatchObject({ cancelIntent: 'RECORDED', cancelEmitted: false }) // could not notify the terminal…
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCEL_REQUESTED' }) }),
    ) // …but the row IS cancelled
    const result = await p1
    expect(result.status).toBe('timeout') // and the POS long-poll unblocks
  })

  it('getPaymentStatus returns a pesos projection and enforces tenant isolation', async () => {
    tpr().findFirst.mockResolvedValueOnce({
      requestId: 'REQ-A',
      venueId: 'venue-1',
      terminalId: 'abc',
      status: 'COMPLETED',
      amountCents: 35000,
      tipCents: 500,
      orderId: 'o1',
      paymentId: 'pay-1',
      senderDevice: 'iPad',
      lateResult: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const status = await terminalPaymentService.getPaymentStatus('REQ-A', 'venue-1')
    expect(status?.amount).toBe(350) // cents → pesos
    expect(status?.tip).toBe(5)
    expect(status?.status).toBe('COMPLETED')

    // Wrong venue → null (tenant isolation)
    tpr().findFirst.mockResolvedValueOnce(null)
    expect(await terminalPaymentService.getPaymentStatus('REQ-A', 'venue-OTHER')).toBeNull()
    expect(tpr().findFirst).toHaveBeenLastCalledWith({ where: { requestId: 'REQ-A', venueId: 'venue-OTHER' } })
  })
})

describe('TerminalPaymentService — watchdog reconcile (Slice 1)', () => {
  const now = new Date('2026-07-11T12:00:00.000Z')
  // Codex R14-4: la limpieza de aliases corre en `prisma.$transaction` (el mock entrega el propio `prismaMock`) con SAVEPOINT y una
  // relectura NOWAIT por `$queryRaw`; por defecto ninguna fila ajena queda tomada ni releída (`[]`) — así un mutante que llegue a la
  // limpieza donde no debía cae por ASERCIÓN (lo que afirma cada prueba) y no por un TypeError sobre `undefined`.
  beforeEach(() => {
    prismaMock.$executeRaw = jest.fn().mockResolvedValue(0)
    prismaMock.$queryRaw.mockResolvedValue([])
  })

  it('P1 la recuperación no cierra la petición con un cobro hecho en OTRA terminal', async () => {
    // El Payment lleva la etiqueta del requestId, es del mismo venue y está COMPLETED, pero se
    // cobró en OTRO aparato. El camino del socket ya exige que la terminal física coincida; la
    // recuperación se lo saltaba, así que el barrido siguiente cerraba la petición con un cobro
    // ajeno — y liberaba el slot de una terminal que quizá seguía ejecutando el suyo.
    tpr().findMany.mockResolvedValueOnce([
      {
        id: 'row-otra',
        requestId: 'REQ-OTRA-TERMINAL',
        venueId: 'venue-1',
        terminalId: 'abc',
        orderId: 'o-otra',
        status: 'PENDING',
        createdAt: new Date(now.getTime() - 400_000),
      },
    ])
    prismaMock.payment.findFirst.mockResolvedValueOnce({
      id: 'pay-de-otra-terminal',
      source: 'TPV',
      terminal: { serialNumber: 'XYZ-999' },
    })

    const summary = await terminalPaymentService.reconcileStaleRequests(now)
    expect(summary.completed).toBe(0)
    expect(tpr().updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentId: 'pay-de-otra-terminal' }) }),
    )
  })

  it('a stale row whose order now has a Payment → COMPLETED (late) por el cierre común, que ETIQUETA al Payment como ganador', async () => {
    const row = {
      id: 'row-1',
      requestId: 'REQ-A',
      venueId: 'venue-1',
      terminalId: 'abc',
      orderId: 'o1',
      status: 'PENDING',
      createdAt: new Date(now.getTime() - 400_000),
    }
    tpr().findMany.mockResolvedValueOnce([row])
    cierreComunCon(row, { id: 'pay-1', terminal: { serialNumber: 'abc' } })

    const summary = await terminalPaymentService.reconcileStaleRequests(now)
    expect(summary.completed).toBe(1)
    // Una fila en vuelo pero VENCIDA (el POS ya recibió su timeout) queda `lateResult`, como escribía el barrido de antes.
    cerradaPorElCierreComun('REQ-A', 'pay-1', { lateResult: true })
  })

  it('🔴 P1 la recuperación cierra un cobro por un importe DISTINTO del pedido sin marcarlo ni avisar', async () => {
    // El MISMO descuadre de dinero se descubre por DOS rutas y sólo una avisa: el cierre por
    // socket/REST (`closeRowFromPaymentTx`) marca CONTRACT_MISMATCH y dispara el 🚨; el barrido
    // que recupera un cobro tardío cierra la fila como si nada. Pedido $100.00, cobrado $150.00:
    // la orden queda «pagada» y los $50 de diferencia no aparecen en ningún lado.
    // No se puede rechazar el dinero — ya salió de la tarjeta. Lo mínimo es que quede MARCADO
    // en la fila y que un humano se entere, igual que en la otra ruta.
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    const row = {
      id: 'row-descuadre',
      requestId: 'REQ-DESCUADRE',
      venueId: 'venue-1',
      terminalId: 'abc',
      orderId: 'o-descuadre',
      status: 'PENDING',
      amountCents: 10_000,
      tipCents: 0,
      createdAt: new Date(now.getTime() - 400_000),
    }
    tpr().findMany.mockResolvedValueOnce([row])
    cierreComunCon(row, { id: 'pay-descuadre', terminal: { serialNumber: 'abc' }, amount: new Prisma.Decimal(150) })

    const summary = await terminalPaymentService.reconcileStaleRequests(now)
    // El dinero se movió: la fila SE CIERRA igual. Lo que cambia es que queda marcada (Codex r3: la marca la pone el cierre común).
    expect(summary.completed).toBe(1)
    cerradaPorElCierreComun('REQ-DESCUADRE', 'pay-descuadre', {
      failureCode: 'CONTRACT_MISMATCH',
      resultJson: expect.objectContaining({
        reconciliationRequired: true,
        requested: { amountCents: 10_000, tipCents: 0, totalCents: 10_000 },
        reported: { amountCents: 15_000, tipCents: 0, totalCents: 15_000 },
      }),
    })
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('🚨 [Terminal-payment contract mismatch]'),
      expect.objectContaining({ requestId: 'REQ-DESCUADRE', paymentId: 'pay-descuadre' }),
    )
    errSpy.mockRestore()
  })

  it('un importe IGUAL al pedido se cierra limpio, sin marca ni alarma (el camino normal no cambia)', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    const row = {
      id: 'row-cuadra',
      requestId: 'REQ-CUADRA',
      venueId: 'venue-1',
      terminalId: 'abc',
      orderId: 'o-cuadra',
      status: 'PENDING',
      amountCents: 10_000,
      tipCents: 1_500,
      createdAt: new Date(now.getTime() - 400_000),
    }
    tpr().findMany.mockResolvedValueOnce([row])
    cierreComunCon(row, { id: 'pay-cuadra', terminal: { serialNumber: 'abc' }, tipAmount: new Prisma.Decimal(15) })

    const summary = await terminalPaymentService.reconcileStaleRequests(now)
    expect(summary.completed).toBe(1)
    cerradaPorElCierreComun('REQ-CUADRA', 'pay-cuadra', { lateResult: true })
    expect(tpr().updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failureCode: 'CONTRACT_MISMATCH' }) }),
    )
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('contract mismatch'), expect.anything())
    errSpy.mockRestore()
  })

  it('a stale row with no reconcilable Payment → UNKNOWN + holds slot + alerts', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    tpr().findMany.mockResolvedValueOnce([
      {
        id: 'row-2',
        requestId: 'REQ-B',
        venueId: 'venue-1',
        terminalId: 'abc',
        orderId: null,
        status: 'PENDING',
        createdAt: new Date(now.getTime() - 400_000),
      },
    ])
    prismaMock.payment.findFirst.mockResolvedValue(null)

    const summary = await terminalPaymentService.reconcileStaleRequests(now)
    expect(summary.unknown).toBe(1)
    expect(tpr().updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'UNKNOWN' }) }))
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('🚨 [Terminal-payment watchdog]'), expect.any(Object))
    errSpy.mockRestore()
  })

  it('cancel silence after the grace is UNKNOWN, never proof of no charge', async () => {
    tpr().findMany.mockResolvedValueOnce([
      {
        id: 'row-cancel-silent',
        requestId: 'REQ-CANCEL-SILENT',
        venueId: 'venue-1',
        terminalId: 'abc',
        orderId: null,
        status: 'CANCEL_REQUESTED',
        createdAt: new Date(now.getTime() - 400_000),
      },
    ])
    const summary = await terminalPaymentService.reconcileStaleRequests(now)
    expect(summary.cancelled).toBe(0)
    expect(summary.unknown).toBe(1)
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'UNKNOWN' }),
      }),
    )
  })

  it('requires the exact request identity rather than a similar payment on the same order', async () => {
    const rowCreatedAt = new Date(now.getTime() - 200_000)
    tpr().findMany.mockResolvedValueOnce([
      { id: 'row-1', requestId: 'REQ-A', venueId: 'venue-1', terminalId: 'abc', orderId: 'o1', status: 'PENDING', createdAt: rowCreatedAt },
    ])
    prismaMock.payment.findFirst.mockResolvedValueOnce(null) // DB filter leaves no qualifying payment

    const summary = await terminalPaymentService.reconcileStaleRequests(now)
    // Codex r2 (P2-N1): la etiqueta de la solicitud es una rama del `OR` (la otra, la llave de intento, sólo existe con vínculos).
    expect(prismaMock.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orderId: 'o1',
          venueId: 'venue-1',
          status: 'COMPLETED',
          OR: [{ processorData: { path: ['terminalPaymentRequestId'], equals: 'REQ-A' } }],
        }),
      }),
    )
    expect(summary.completed).toBe(0)
    expect(summary.unknown).toBe(1) // no qualifying payment → HELD, never falsely completed
  })

  it('does NOT complete against a Payment whose ACCREDITED owner is ANOTHER request (tagged for it, charged on its terminal) → UNKNOWN (never free blind)', async () => {
    // Split/multi-card orders record several payments; a payment ACCREDITED to a different terminal request is not ours.
    // Stealing it would free the slot on a mis-linked payment. Codex R13-7: el veto exige procedencia, no mera existencia.
    const rowCreatedAt = new Date(now.getTime() - 400_000)
    tpr().findMany.mockResolvedValueOnce([
      {
        id: 'row-stale',
        requestId: 'REQ-STALE',
        venueId: 'venue-1',
        terminalId: 'abc',
        orderId: 'o1',
        status: 'PENDING',
        createdAt: rowCreatedAt,
      },
    ])
    prismaMock.payment.findFirst.mockResolvedValueOnce({
      id: 'pay-other',
      source: 'TPV',
      orderId: 'o1',
      processorData: { terminalPaymentRequestId: 'REQ-STALE' },
      terminalPaymentRequestId: 'REQ-OWNER',
      terminal: { serialNumber: 'abc' },
      amount: new Prisma.Decimal(100),
      tipAmount: new Prisma.Decimal(0),
    }) // a payment exists on the order… (la COLUMNA acredita a REQ-OWNER)
    // …y REQ-OWNER lo reclama con procedencia: etiquetado con ella (columna) y cobrado en su terminal.
    tpr().findMany.mockResolvedValueOnce([
      { id: 'row-owner', requestId: 'REQ-OWNER', orderId: 'o1', terminalId: 'abc', status: 'COMPLETED' },
    ])

    const summary = await terminalPaymentService.reconcileStaleRequests(now)
    expect(tpr().findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ paymentId: 'pay-other', requestId: { not: 'REQ-STALE' } }) }),
    )
    expect(summary.completed).toBe(0)
    expect(tpr().updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }))
    // El dueño acreditado se conserva: ningún puntero ajeno se retira.
    expect(tpr().updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: { paymentId: null } }))
    expect(summary.unknown).toBe(1)
    expect(tpr().updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'UNKNOWN' }) }))
  })

  // Codex R13-7: la pregunta inversa de R12-6 — «otra solicitud apunta a MI Payment» sin procedencia (alias contaminado por el
  // antiguo productor no-success) NO veta al cargo auténtico: el alias se retira (CAS sobre su valor), con 🚨 y bitácora.
  it('a contaminated alias (another request pointing at the Payment WITHOUT provenance) does not veto: the alias is resolved (CAS), audited, and the authentic row completes', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    const rowCreatedAt = new Date(now.getTime() - 400_000)
    tpr().findMany.mockResolvedValueOnce([
      {
        id: 'row-real',
        requestId: 'REQ-REAL',
        venueId: 'venue-1',
        terminalId: 'abc',
        orderId: 'o1',
        status: 'PENDING',
        createdAt: rowCreatedAt,
      },
    ])
    // Codex r3 (P1-N2): el cierre común relee la fila auténtica y el Payment (persistente: lo relee dos veces).
    cierreComunCon(
      {
        id: 'row-real',
        requestId: 'REQ-REAL',
        venueId: 'venue-1',
        terminalId: 'abc',
        orderId: 'o1',
        status: 'PENDING',
        createdAt: rowCreatedAt,
      },
      {
        id: 'pay-real',
        orderId: 'o1',
        processorData: { terminalPaymentRequestId: 'REQ-REAL', deviceSerialNumber: 'abc' },
        terminalPaymentRequestId: 'REQ-REAL',
        terminal: { serialNumber: 'abc' },
      },
    )
    // REQ-AJENA apunta a pay-real, pero pay-real está etiquetado con REQ-REAL: sin procedencia para REQ-AJENA.
    tpr().findMany.mockResolvedValueOnce([{ id: 'row-ajena', requestId: 'REQ-AJENA', orderId: null, terminalId: 'xyz', status: 'UNKNOWN' }])
    // Codex R14-4: la limpieza corre en una transacción real (aquí `$transaction` entrega el propio mock); la relectura NOWAIT del
    // alias ajeno devuelve la fila apuntando a pay-real.
    prismaMock.$executeRaw = jest.fn().mockResolvedValue(0)
    prismaMock.$queryRaw.mockImplementation((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join('').includes('alias ajeno') ? [{ paymentId: 'pay-real', orderId: null, terminalId: 'xyz', status: 'UNKNOWN' }] : [],
      ),
    )

    const summary = await terminalPaymentService.reconcileStaleRequests(now)
    expect(prismaMock.$transaction).toHaveBeenCalled()
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'row-ajena', paymentId: 'pay-real' }, data: { paymentId: null } }),
    )
    expect(summary.completed).toBe(1)
    cerradaPorElCierreComun('REQ-REAL', 'pay-real')
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('contaminated alias resolved'),
      expect.objectContaining({
        requestId: 'REQ-AJENA',
        paymentId: 'pay-real',
        authenticRequestId: 'REQ-REAL',
        reason: 'PAYMENT_TAGGED_FOR_ANOTHER_REQUEST',
        origen: 'barrido',
      }),
    )
    const { logAction } = require('@/services/dashboard/activity-log.service')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TERMINAL_PAYMENT_CONTAMINATED_ALIAS_RESOLVED',
        entityId: 'REQ-AJENA',
        venueId: 'venue-1',
        data: expect.objectContaining({
          paymentId: 'pay-real',
          authenticRequestId: 'REQ-REAL',
          reason: 'PAYMENT_TAGGED_FOR_ANOTHER_REQUEST',
        }),
      }),
    )
    errSpy.mockRestore()
  })
})

describe('TerminalPaymentService — regression (existing behavior intact)', () => {
  it('single charges to different terminals do not block each other', async () => {
    const pA = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-A', requestId: 'REQ-A' }))
    const pB = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-B', requestId: 'REQ-B' }))
    await flush()
    expect(directEmit).toHaveBeenCalledTimes(2)

    committedRequests({ 'REQ-A': 'pay-a', 'REQ-B': 'pay-b' })
    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-A', status: 'success', paymentId: 'pay-a' })
    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-B', status: 'success', paymentId: 'pay-b' })
    const [rA, rB] = await Promise.all([pA, pB])
    expect(rA.status).toBe('success')
    expect(rB.status).toBe('success')
  })

  it('still throws when the terminal is not connected: with the POS requestId it writes ONLY its tombstone, never an admitted row', async () => {
    mockedGetTerminal.mockReturnValueOnce(null)
    await expect(
      terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-GONE', requestId: 'REQ-X' })),
    ).rejects.toMatchObject({
      message: expect.stringContaining('no está conectada'),
      statusCode: 404,
      code: 'TERMINAL_NOT_CONNECTED',
      details: { requestId: 'REQ-X' },
    })
    expect(tpr().create).toHaveBeenCalledTimes(1)
    expect(tpr().create.mock.calls[0][0].data).toMatchObject({
      requestId: 'REQ-X',
      status: 'FAILED',
      failureCode: 'REJECTED_TERMINAL_NOT_CONNECTED',
    })
    expect(directEmit).not.toHaveBeenCalled()
  })

  it('still throws when the terminal is not connected, and without a POS requestId never writes a row', async () => {
    mockedGetTerminal.mockReturnValueOnce(null)
    await expect(terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-GONE' }))).rejects.toThrow('no está conectada')
    expect(tpr().create).not.toHaveBeenCalled()
  })
})

describe('TerminalPaymentService — closeRowFromPaymentTx (money moved beats a prior close)', () => {
  // Un cobro de terminal SIEMPRE trae su procedencia: la fila conoce su terminal y el Payment la
  // suya (resuelta del serial del token). Un fixture sin ninguna de las dos describe un estado que
  // no existe — y desde la auditoría del 10-sep el cierre sin identidad acreditada se NIEGA.
  /**
   * Codex R14-4: el alias ajeno se toma con `FOR UPDATE NOWAIT` (marcador `alias ajeno`) y se RELEE bajo el candado; el mock
   * contesta esa relectura con la fila que la prueba declare en `aliasAjeno` (por defecto ninguna).
   */
  const txWith = (status: string, payment: Record<string, unknown> = {}, aliasAjeno: Record<string, unknown> | null = null) =>
    ({
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest
        .fn()
        .mockImplementation((strings: TemplateStringsArray) =>
          Promise.resolve(strings.join('').includes('alias ajeno') && aliasAjeno ? [aliasAjeno] : []),
        ),
      payment: {
        findFirst: jest.fn().mockResolvedValue({
          processorData: {},
          amount: new Prisma.Decimal(100),
          tipAmount: new Prisma.Decimal(0),
          source: 'TPV',
          terminal: { serialNumber: 'AVQD-T-1' },
          ...payment,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      terminalPaymentRequest: {
        findFirst: jest
          .fn()
          .mockImplementation(({ where }: any) => Promise.resolve(where.paymentId ? null : { status, terminalId: 't-1' })),
        // Codex R13-7: las reclamaciones de OTRAS solicitudes sobre el Payment (ninguna, por defecto).
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    }) as any

  it('refuses to close when the Payment carries NO accredited identity (no FK, no caller serial, no persisted serial)', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    const tx = txWith('SENT', { terminal: null })
    await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-SIN-ID', 'pay-sin-id', 'venue-1')
    expect(tx.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
    expect(tx.payment.updateMany).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('no accredited terminal identity'), expect.any(Object))
    errSpy.mockRestore()
  })

  it('closes from the AUTHENTICATED serial when the FK did not resolve, and persists that provenance', async () => {
    const tx = txWith('SENT', { terminal: null })
    await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-FK', 'pay-fk', 'venue-1', undefined, 'REST', 'AVQD-T-1')
    expect(tx.terminalPaymentRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED', paymentId: 'pay-fk' }) }),
    )
    // S0: la columna del ganador viaja en la MISMA escritura que la procedencia.
    expect(tx.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          terminalPaymentRequestId: 'REQ-FK',
          processorData: expect.objectContaining({ deviceSerialNumber: 'AVQD-T-1' }),
        }),
      }),
    )
  })

  it('refuses to close when the authenticated serial contradicts the request terminal', async () => {
    const tx = txWith('SENT', { terminal: null })
    await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-OTRA', 'pay-otra', 'venue-1', undefined, 'REST', 'AVQD-T-2')
    expect(tx.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
  })

  it('a committed payment replaces stale cancel admission and response in the same transaction', async () => {
    const tx = txWith('CANCEL_REQUESTED')
    await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-PAID', 'pay-durable', 'venue-1')
    expect(tx.terminalPaymentRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cancelDisposition: null,
          resultJson: { requestId: 'REQ-PAID', status: 'success', paymentId: 'pay-durable' },
        }),
      }),
    )
  })

  it('reconciles an already-CANCELLED row to COMPLETED (a recorded Payment is money-moved ground truth) and alerts 🚨', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    const tx = txWith('CANCELLED')

    await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-Z', 'pay-late', 'venue-1')

    expect(tx.terminalPaymentRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // S0: el CAS es «todavía sin ganador», no «todavía no COMPLETED» (una COMPLETED sin paymentId también liga).
        where: { requestId: 'REQ-Z', venueId: 'venue-1', paymentId: null },
        data: expect.objectContaining({ status: 'COMPLETED', paymentId: 'pay-late', lateResult: true }),
      }),
    )
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('🚨 [Terminal-payment]'), expect.any(Object))
    errSpy.mockRestore()
  })

  // 🔴 Hallazgo de la auditoría de Codex (12-sep): el 🚨 sólo cubría CANCELLED/FAILED/CANCEL_REQUESTED.
  // Una fila SOLTADA POR TIEMPO queda TIMED_OUT/AUTO_RELEASED, y es justo el caso donde un cobro
  // tardío es un DOBLE COBRO probable (la ranura ya se reutilizó): cerrarla en silencio es lo peor.
  it('money landing on a TIMED_OUT row (auto-released by time) reconciles to COMPLETED AND alerts 🚨 — the release was by policy, not by evidence', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    const tx = txWith('TIMED_OUT')

    await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-T', 'pay-late-t', 'venue-1')

    expect(tx.terminalPaymentRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requestId: 'REQ-T', venueId: 'venue-1', paymentId: null },
        data: expect.objectContaining({ status: 'COMPLETED', paymentId: 'pay-late-t', lateResult: true }),
      }),
    )
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('🚨 [Terminal-payment]'),
      expect.objectContaining({ requestId: 'REQ-T', priorStatus: 'TIMED_OUT' }),
    )
    errSpy.mockRestore()
  })

  it('normal in-flight close (PENDING → COMPLETED) sets lateResult=false and does NOT alert', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    const tx = txWith('PENDING')

    await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-P', 'pay-1', 'venue-1')

    expect(tx.terminalPaymentRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED', lateResult: false }) }),
    )
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('🚨 [Terminal-payment]'), expect.any(Object))
    errSpy.mockRestore()
  })

  it('registra y alerta una diferencia de base, propina y total sin rechazar dinero ya cobrado', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      payment: {
        findFirst: jest.fn().mockResolvedValue({
          processorData: {},
          amount: new Prisma.Decimal(100),
          tipAmount: new Prisma.Decimal(0),
          source: 'TPV',
          terminal: { serialNumber: 'AVQD-T-1' },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      terminalPaymentRequest: {
        findFirst: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            Promise.resolve(where.paymentId ? null : { status: 'SENT', terminalId: 't-1', amountCents: 47_500, tipCents: 4_750 }),
          ),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any

    await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-MISMATCH', 'pay-mismatch', 'venue-1', {
      amountCents: 52_250,
      tipCents: 0,
    })

    expect(tx.terminalPaymentRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'COMPLETED',
          paymentId: 'pay-mismatch',
          failureCode: 'CONTRACT_MISMATCH',
          resultJson: expect.objectContaining({
            requested: { amountCents: 47_500, tipCents: 4_750, totalCents: 52_250 },
            reported: { amountCents: 52_250, tipCents: 0, totalCents: 52_250 },
          }),
        }),
      }),
    )
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('🚨 [Terminal-payment contract mismatch]'),
      expect.objectContaining({ requestId: 'REQ-MISMATCH', paymentId: 'pay-mismatch' }),
    )
    errSpy.mockRestore()
  })

  it('is a no-op on a row that ALREADY has its ACCREDITED winner (idempotent — never clobbers a stored paymentId that is a charge of this request)', async () => {
    // Codex R12-6: «ya ligada» exige que el puntero sea un cobro acreditado de ESTA solicitud (etiquetado con ella y de
    // esta terminal) — el mismo criterio que el árbitro. El ganador `pay-1` lo es.
    const tx = txWith('COMPLETED', { terminalPaymentRequestId: 'REQ-DONE' })
    tx.terminalPaymentRequest.findFirst = jest.fn().mockResolvedValue({ status: 'COMPLETED', terminalId: 't-1', paymentId: 'pay-1' })
    expect(await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-DONE', 'pay-2', 'venue-1')).toEqual({
      bound: false,
      reason: 'ALREADY_BOUND',
    })
    expect(tx.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'pay-1', venueId: 'venue-1', status: { in: ['COMPLETED', 'REFUNDED'] } }),
      }),
    )
    expect(tx.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
    expect(tx.payment.updateMany).not.toHaveBeenCalled()
  })

  // Codex R12-6: un resultado no-success del socket podía escribir en `paymentId` una venta AJENA; el cierre la trataba
  // como «ya ligada» y el cargo auténtico quedaba fuera. Un puntero sin procedencia se reemplaza — con CAS sobre SU valor
  // (nunca sobre un ganador acreditado escrito en medio), 🚨 y bitácora.
  it('a stored pointer WITHOUT provenance (not tagged for this request) is replaced by the authentic charge: CAS on the old pointer, 🚨 and audit trail', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    const tx = txWith('TIMED_OUT')
    // `pay-ajeno` es un cobro real del mismo venue, pero de OTRA venta (sin la etiqueta de REQ-CONTAMINADA) y de otra terminal.
    tx.payment.findFirst = jest.fn().mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.id === 'pay-ajeno'
          ? {
              processorData: {},
              amount: new Prisma.Decimal(100),
              tipAmount: new Prisma.Decimal(0),
              source: 'TPV',
              terminalPaymentRequestId: null,
              terminal: { serialNumber: 'AVQD-T-9' },
            }
          : {
              processorData: {},
              amount: new Prisma.Decimal(100),
              tipAmount: new Prisma.Decimal(0),
              source: 'TPV',
              terminalPaymentRequestId: null,
              terminal: { serialNumber: 'AVQD-T-1' },
            },
      ),
    )
    tx.terminalPaymentRequest.findFirst = jest
      .fn()
      .mockImplementation(({ where }: any) =>
        Promise.resolve(where.paymentId ? null : { status: 'TIMED_OUT', terminalId: 't-1', paymentId: 'pay-ajeno' }),
      )
    tx.terminalPaymentRequest.findMany = jest.fn().mockResolvedValue([])

    const outcome = await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-CONTAMINADA', 'pay-autentico', 'venue-1')

    expect(outcome).toMatchObject({ bound: true, reopened: true, previousStatus: 'TIMED_OUT' })
    expect(tx.terminalPaymentRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requestId: 'REQ-CONTAMINADA', venueId: 'venue-1', paymentId: 'pay-ajeno' },
        data: expect.objectContaining({ status: 'COMPLETED', paymentId: 'pay-autentico', lateResult: true }),
      }),
    )
    expect(tx.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay-autentico', venueId: 'venue-1' },
        data: expect.objectContaining({ terminalPaymentRequestId: 'REQ-CONTAMINADA' }),
      }),
    )
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('NOT an accredited charge of this request'),
      expect.objectContaining({
        requestId: 'REQ-CONTAMINADA',
        ignoredPaymentId: 'pay-ajeno',
        reason: 'NOT_TAGGED_FOR_THIS_REQUEST',
        origen: 'cierre',
      }),
    )
    const { logAction } = require('@/services/dashboard/activity-log.service') // mock global del setup
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TERMINAL_PAYMENT_UNACCREDITED_WINNER_IGNORED',
        entityId: 'REQ-CONTAMINADA',
        venueId: 'venue-1',
        data: expect.objectContaining({ ignoredPaymentId: 'pay-ajeno', reason: 'NOT_TAGGED_FOR_THIS_REQUEST', origen: 'cierre' }),
      }),
    )
    errSpy.mockRestore()
  })

  // Codex R13-7: la reclamación de OTRA solicitud sobre el Payment sólo veta el cierre si está acreditada por el mismo criterio.
  it('Codex R13-7 · another request that claims the Payment WITH provenance (tagged for it, charged on its terminal) vetoes: PAYMENT_BOUND_ELSEWHERE, nothing written', async () => {
    const tx = txWith('UNKNOWN', { terminalPaymentRequestId: 'REQ-DUENA', orderId: null })
    tx.terminalPaymentRequest.findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'row-duena', requestId: 'REQ-DUENA', orderId: null, terminalId: 't-1', status: 'COMPLETED' }])
    expect(await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-OTRA', 'pay-1', 'venue-1')).toEqual({
      bound: false,
      reason: 'PAYMENT_BOUND_ELSEWHERE',
    })
    expect(tx.terminalPaymentRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ paymentId: 'pay-1', venueId: 'venue-1', requestId: { not: 'REQ-OTRA' } }),
      }),
    )
    expect(tx.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
    expect(tx.payment.updateMany).not.toHaveBeenCalled()
  })

  it('Codex R13-7 · another request pointing at the Payment WITHOUT provenance (contaminated alias) does not veto: the alias is resolved by CAS, 🚨 + audit, and this request binds', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    const tx = txWith(
      'UNKNOWN',
      { terminalPaymentRequestId: null, orderId: null },
      { paymentId: 'pay-1', orderId: null, terminalId: 't-9', status: 'UNKNOWN' },
    )
    tx.terminalPaymentRequest.findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'row-ajena', requestId: 'REQ-AJENA', orderId: null, terminalId: 't-9', status: 'UNKNOWN' }])
    const outcome = await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-REAL', 'pay-1', 'venue-1')
    expect(outcome).toMatchObject({ bound: true, previousStatus: 'UNKNOWN' })
    // Codex R14-4: la fila ajena se tomó SIN esperar (NOWAIT) dentro de un savepoint, y se releyó antes del CAS.
    expect(tx.$executeRaw.mock.calls.map((c: TemplateStringsArray[]) => c[0].join(''))).toEqual([
      expect.stringContaining('SAVEPOINT alias_ajeno'),
      expect.stringContaining('RELEASE SAVEPOINT alias_ajeno'),
    ])
    expect(
      tx.$queryRaw.mock.calls.map((c: TemplateStringsArray[]) => c[0].join('')).filter((q: string) => q.includes('alias ajeno')),
    ).toEqual([expect.stringContaining('FOR UPDATE NOWAIT')])
    expect(tx.terminalPaymentRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'row-ajena', paymentId: 'pay-1' }, data: { paymentId: null } }),
    )
    expect(tx.terminalPaymentRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requestId: 'REQ-REAL', venueId: 'venue-1', paymentId: null },
        data: expect.objectContaining({ status: 'COMPLETED', paymentId: 'pay-1' }),
      }),
    )
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('contaminated alias resolved'),
      expect.objectContaining({
        requestId: 'REQ-AJENA',
        paymentId: 'pay-1',
        authenticRequestId: 'REQ-REAL',
        reason: 'NOT_TAGGED_FOR_THIS_REQUEST',
        origen: 'cierre',
      }),
    )
    const { logAction } = require('@/services/dashboard/activity-log.service')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TERMINAL_PAYMENT_CONTAMINATED_ALIAS_RESOLVED', entityId: 'REQ-AJENA', venueId: 'venue-1' }),
    )
    errSpy.mockRestore()
  })

  it('a stored pointer that is the SAME payment being bound is idempotent (ALREADY_BOUND) without re-reading it', async () => {
    const tx = txWith('COMPLETED')
    tx.terminalPaymentRequest.findFirst = jest.fn().mockResolvedValue({ status: 'COMPLETED', terminalId: 't-1', paymentId: 'pay-1' })
    expect(await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-MISMO', 'pay-1', 'venue-1')).toEqual({
      bound: false,
      reason: 'ALREADY_BOUND',
    })
    expect(tx.payment.findFirst).not.toHaveBeenCalled()
    expect(tx.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
  })

  // S0 (Codex, 13-sep): cerrada por el SOCKET antes de que llegara el registro ⇒ COMPLETED sin paymentId. Antes salía
  // en falso y dejaba al primer registro sin vínculo — y al segundo sin nadie que le dijera que era el segundo.
  // No es un «reopen» (la terminal la cerró con éxito): sin lateResult y sin 🚨.
  it('a COMPLETED row WITHOUT paymentId (closed by socket before the REST registration) binds the first recorded Payment', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    const tx = txWith('COMPLETED')
    expect(await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-SOCKET-FIRST', 'pay-2', 'venue-1')).toEqual({
      bound: true,
      reopened: false,
      contractMismatch: false,
      previousStatus: 'COMPLETED',
      alarmed: false,
    })
    expect(tx.terminalPaymentRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requestId: 'REQ-SOCKET-FIRST', venueId: 'venue-1', paymentId: null },
        data: expect.objectContaining({ paymentId: 'pay-2', closedVia: 'terminal', lateResult: false }),
      }),
    )
    expect(tx.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ terminalPaymentRequestId: 'REQ-SOCKET-FIRST' }) }),
    )
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('🚨 [Terminal-payment] Payment recorded'), expect.anything())
    errSpy.mockRestore()
  })

  // P1-5 (Codex): la SOLICITUD se bloquea antes que el Payment, también cuando se llega desde el socket.
  it('locks the request row BEFORE the Payment row (same lock protocol as the registrar)', async () => {
    const tx = txWith('SENT')
    await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-LOCKS', 'pay-1', 'venue-1')
    const sqls = (tx.$queryRaw as jest.Mock).mock.calls.map(([strings]: [unknown]) =>
      Array.isArray(strings) ? strings.join('?') : String(strings),
    )
    expect(sqls[0]).toContain('"TerminalPaymentRequest"')
    expect(sqls[1]).toContain('"Payment"')
  })

  // El perdedor de la carrera por la fila NO estampa su Payment: la fila primero, el Payment después.
  it('when the row CAS loses (already bound by a concurrent close), the Payment is left untouched', async () => {
    const tx = txWith('SENT')
    tx.terminalPaymentRequest.updateMany = jest.fn().mockResolvedValue({ count: 0 })
    expect(await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-RACE', 'pay-9', 'venue-1')).toEqual({
      bound: false,
      reason: 'ALREADY_BOUND',
    })
    expect(tx.payment.updateMany).not.toHaveBeenCalled()
  })

  it('money landing on a CANCEL_REQUESTED row reconciles to COMPLETED AND alerts 🚨 (cancel lost the race — a human must know)', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    const tx = txWith('CANCEL_REQUESTED')

    await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-CR', 'pay-race', 'venue-1')

    // CANCEL_REQUESTED is still in-flight → a normal close (lateResult=false), not a reopen
    expect(tx.terminalPaymentRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED', paymentId: 'pay-race', lateResult: false }) }),
    )
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('🚨 [Terminal-payment]'),
      expect.objectContaining({ priorStatus: 'CANCEL_REQUESTED' }),
    )
    errSpy.mockRestore()
  })
})

describe('TerminalPaymentService — hasChargeBlockingOrderCancel (guard for cancelOrder)', () => {
  it('blocks cancelling the order until a requested terminal cancellation is actually confirmed', async () => {
    tpr().findFirst.mockResolvedValueOnce({ requestId: 'REQ-LIVE' })

    const blocked = await terminalPaymentService.hasChargeBlockingOrderCancel('venue-1', 'order-1')

    expect(blocked).toBe(true)
    const where = (tpr().findFirst as jest.Mock).mock.calls[0][0].where
    expect(where).toMatchObject({ venueId: 'venue-1', orderId: 'order-1' })
    expect(where.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: { in: expect.arrayContaining(['PENDING', 'SENT', 'UNKNOWN', 'CANCEL_REQUESTED', 'TIMED_OUT']) },
        }),
      ]),
    )
  })

  it('returns false when the order has no live/unknown terminal charge', async () => {
    tpr().findFirst.mockResolvedValueOnce(null)
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel('venue-1', 'order-2')).toBe(false)
  })
})

describe('TerminalPaymentService — candado de sobrepago (orden YA pagada, caso Mindform 2026-06-21)', () => {
  /**
   * Una cuenta de $380 YA saldada aceptó $122 y luego $232 más porque el POS tenía la lista de
   * órdenes rancia y la mandó a cobrar de nuevo. Este es el ÚNICO punto del flujo remoto donde
   * bloquear es seguro: el request aún no llegó a la terminal, no hay dinero movido.
   */
  const order = () => prismaMock.order

  it('🔴 REGRESIÓN: orden PAID → rechaza con ORDER_ALREADY_PAID ANTES de tocar la terminal', async () => {
    order().findFirst.mockResolvedValue({ paymentStatus: 'PAID', orderNumber: 'ORD-380' })

    await expect(
      terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-PAID', orderId: 'order-mindform' })),
    ).rejects.toThrow(OrderAlreadyPaidError)

    // Ni fila del lock, ni emit a la terminal: el cobro murió antes de existir
    expect(tpr().create).not.toHaveBeenCalled()
    expect(directEmit).not.toHaveBeenCalled()
  })

  it('orden PENDING → el cobro procede normal (el candado no estorba cuentas abiertas)', async () => {
    order().findFirst.mockResolvedValue({ paymentStatus: 'PENDING', orderNumber: 'ORD-OPEN' })

    const p1 = terminalPaymentService.sendPaymentToTerminal(
      baseRequest({ terminalId: 'T-OPEN', orderId: 'order-open', requestId: 'REQ-G1' }),
    )
    await flush()
    expect(tpr().create).toHaveBeenCalledTimes(1)
    expect(directEmit).toHaveBeenCalledWith(
      'terminal:payment_request',
      expect.objectContaining({ requestId: 'REQ-G1' }),
      expect.any(Function),
    )

    committedRequests({ 'REQ-G1': 'pay-g1' })
    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-G1', status: 'success', paymentId: 'pay-g1' })
    expect((await p1).status).toBe('success')
  })

  it('orden PARTIAL → procede (los pagos divididos son legítimos)', async () => {
    order().findFirst.mockResolvedValue({ paymentStatus: 'PARTIAL', orderNumber: 'ORD-SPLIT' })

    const p1 = terminalPaymentService.sendPaymentToTerminal(
      baseRequest({ terminalId: 'T-SPLIT', orderId: 'order-split', requestId: 'REQ-G2' }),
    )
    await flush()
    expect(tpr().create).toHaveBeenCalledTimes(1)

    committedRequests({ 'REQ-G2': 'pay-g2' })
    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-G2', status: 'success', paymentId: 'pay-g2' })
    expect((await p1).status).toBe('success')
  })

  it('a failed order read must not authorize a charge whose unpaid state cannot be verified', async () => {
    order().findFirst.mockRejectedValue(new Error('connection refused'))
    const pending = terminalPaymentService.sendPaymentToTerminal(
      baseRequest({ terminalId: 'T-FO', orderId: 'order-x', requestId: 'REQ-G3' }),
    )
    const settled = pending.then(
      value => value,
      error => error,
    )
    await flush()
    const emitted = directEmit.mock.calls.length
    if (emitted) terminalPaymentService.handlePaymentResult({ requestId: 'REQ-G3', status: 'timeout' })
    expect(await settled).toBeInstanceOf(Error)
    expect(emitted).toBe(0)
  })

  it('cobro rápido SIN orden → ni siquiera consulta la orden (cero costo para el flujo Cobrar)', async () => {
    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-FAST', requestId: 'REQ-G4' }))
    await flush()
    expect(order().findFirst).not.toHaveBeenCalled()

    committedRequests({ 'REQ-G4': 'pay-g4' })
    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-G4', status: 'success', paymentId: 'pay-g4' })
    expect((await p1).status).toBe('success')
  })
})

describe('TerminalPaymentService — el CLIENTE de la venta va a la FILA, nunca a la terminal', () => {
  // 🔴 El defecto: el cobro con TARJETA nacía anónimo. En efectivo el POS registra el
  // cobro él mismo y manda el cliente; con tarjeta lo registra la TPV con su propio
  // payload, que no lleva cliente. La fila de arbitraje es el único punto donde el
  // server tiene el cliente que eligió el cajero — por eso se persiste aquí.

  it('persiste el customerId que mandó el POS en la fila de arbitraje', async () => {
    const p1 = terminalPaymentService.sendPaymentToTerminal(
      baseRequest({ terminalId: 'T-CUST', requestId: 'REQ-CUST', customerId: 'cust-1' }),
    )
    await flush()

    expect(tpr().create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ customerId: 'cust-1' }) }))

    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-CUST', status: 'success' })
    await p1
  })

  it('🔴 el payload del socket NO lleva el customerId', async () => {
    // La TPV no consume ese id y no tiene nada que hacer con él: mandarlo sería PII
    // viajando a un aparato en el mostrador sin ningún consumidor. Además obligaría a
    // desplegar la TPV (3-5 días por la firma PAX) para un arreglo que es sólo del
    // server.
    const p1 = terminalPaymentService.sendPaymentToTerminal(
      baseRequest({ terminalId: 'T-PII', requestId: 'REQ-PII', customerId: 'cust-1' }),
    )
    await flush()

    const payload = directEmit.mock.calls[0][1]
    expect(payload.requestId).toBe('REQ-PII') // el emit sí ocurrió…
    expect(payload).not.toHaveProperty('customerId') // …y no lleva al cliente

    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-PII', status: 'success' })
    await p1
  })

  it('sin cliente escribe null explícito — la venta anónima se comporta igual que hoy', async () => {
    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-ANON', requestId: 'REQ-ANON' }))
    await flush()

    expect(tpr().create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ customerId: null }) }))

    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-ANON', status: 'success' })
    await p1
  })
})

describe('TerminalPaymentService — el watchdog no cierra con el pago de otro', () => {
  // 🔴 El watchdog reconcilia una solicitud vencida contra un Payment de la MISMA orden.
  // Tenía dos guardas (no anterior a la solicitud, no reclamado por otra) pero NINGUNA
  // sobre qué CLASE de pago es. Una orden lleva varios pagos por split/tender parcial, así
  // que un efectivo posterior —o una tarjeta RECHAZADA— cerraba la solicitud como cobrada.
  //
  // El daño es el caro y silencioso: el POS le dice al cajero "ya se cobró", el cajero no
  // cobra, y el comercio pierde la venta. Nadie reclama un cobro que no ocurrió.
  //
  // La dirección segura ya la eligió este archivo: si no consta, cae en UNKNOWN, que RETIENE
  // la ranura y levanta alerta. Molesto y correcto — nunca liberar a ciegas.

  const staleRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'row-1',
    requestId: 'REQ-W1',
    venueId: 'venue-1',
    terminalId: 't-w1',
    orderId: 'order-w1',
    status: 'SENT',
    createdAt: new Date('2026-08-11T10:00:00Z'),
    ...overrides,
  })

  it('un pago RECHAZADO de la misma orden NO cierra la solicitud como cobrada', async () => {
    tpr().findMany.mockResolvedValueOnce([staleRow()])
    prismaMock.payment.findFirst.mockResolvedValueOnce(null) // el filtro lo descarta

    const res = await terminalPaymentService.reconcileStaleRequests(new Date('2026-08-11T10:10:00Z'))

    expect(res.completed).toBe(0)
    expect(res.unknown).toBe(1)
    const where = prismaMock.payment.findFirst.mock.calls[0][0].where
    expect(where.status).toBe('COMPLETED')
  })

  it('un pago en EFECTIVO de la misma orden tampoco la cierra — no prueba que la tarjeta pasó', async () => {
    tpr().findMany.mockResolvedValueOnce([staleRow({ id: 'row-2', requestId: 'REQ-W2' })])
    prismaMock.payment.findFirst.mockResolvedValueOnce(null)

    await terminalPaymentService.reconcileStaleRequests(new Date('2026-08-11T10:10:00Z'))

    const where = prismaMock.payment.findFirst.mock.calls[0][0].where
    expect(where.method).toEqual({ in: ['CREDIT_CARD', 'DEBIT_CARD'] })
  })

  it('un pago con TARJETA y COMPLETED sí la cierra — el camino bueno no se rompe (por el cierre común, con etiqueta)', async () => {
    const row = staleRow({ id: 'row-3', requestId: 'REQ-W3' })
    tpr().findMany.mockResolvedValueOnce([row])
    cierreComunCon(row, { id: 'pay-ok', terminal: { serialNumber: 't-w1' } })

    const res = await terminalPaymentService.reconcileStaleRequests(new Date('2026-08-11T10:10:00Z'))

    expect(res.completed).toBe(1)
    expect(res.unknown).toBe(0)
    cerradaPorElCierreComun('REQ-W3', 'pay-ok', { lateResult: true })
  })
})

describe('TerminalPaymentService — un cobro que pasó pese al cancel SIEMPRE avisa', () => {
  // 🔴 El mismo evento de dinero se descubre por DOS rutas, y sólo una avisaba.
  //
  // `closeRowFromPaymentTx` (la TPV registra el pago por REST) dispara el 🚨 cuando la fila
  // venía cancelada: "a human must know a cancelled attempt actually took money".
  // El WATCHDOG hace el mismo ascenso a COMPLETED y no avisaba nada — así que si el
  // descubrimiento llegaba por ahí, nadie se enteraba de que el cajero canceló y el dinero
  // se fue igual.
  //
  // Importa porque no hay forma de prevenirlo en la caja: medido en esta base, el registro
  // tardío llega entre 65 s y 3 HORAS después. Retener la venta ese tiempo sería peor que el
  // problema. Si no se puede prevenir, lo mínimo es que un humano se entere.

  it('el watchdog también dispara la alerta cuando el dinero se movió pese a la cancelación', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    errSpy.mockClear()

    const row = {
      id: 'row-c1',
      requestId: 'REQ-C1',
      venueId: 'venue-1',
      terminalId: 't-c1',
      orderId: 'order-c1',
      status: 'CANCEL_REQUESTED',
      createdAt: new Date('2026-08-11T10:00:00Z'),
    }
    tpr().findMany.mockResolvedValueOnce([row])
    cierreComunCon(row, { id: 'pay-c1', terminal: { serialNumber: 't-c1' } })

    await terminalPaymentService.reconcileStaleRequests(new Date('2026-08-11T10:10:00Z'))

    cerradaPorElCierreComun('REQ-C1', 'pay-c1')
    const alerted = errSpy.mock.calls.some(c => String(c[0]).includes('🚨') && String(c[0]).toLowerCase().includes('cancel'))
    expect(alerted).toBe(true)
    // El token del vigía sigue (Better Stack lo machea), además del del cierre común.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('money moved despite cancel)'),
      expect.objectContaining({ requestId: 'REQ-C1' }),
    )
  })

  it('un cobro normal que sólo llegó tarde NO dispara la alarma — no se cansa a nadie con ruido', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    errSpy.mockClear()

    const row = {
      id: 'row-c2',
      requestId: 'REQ-C2',
      venueId: 'venue-1',
      terminalId: 't-c2',
      orderId: 'order-c2',
      status: 'SENT', // nadie canceló: es una reconciliación normal
      createdAt: new Date('2026-08-11T10:00:00Z'),
    }
    tpr().findMany.mockResolvedValueOnce([row])
    cierreComunCon(row, { id: 'pay-c2', terminal: { serialNumber: 't-c2' } })

    await terminalPaymentService.reconcileStaleRequests(new Date('2026-08-11T10:10:00Z'))

    cerradaPorElCierreComun('REQ-C2', 'pay-c2') // sí se cerró (antes esta prueba pasaba sin cerrar nada: `findFirst` → null)
    const alerted = errSpy.mock.calls.some(c => String(c[0]).includes('🚨'))
    expect(alerted).toBe(false)
  })
})

describe('Audit round1 lost captured socket', () => {
  it('post-reservation socket loss never claims no authorization started', async () => {
    mockedGetServer().sockets.sockets.get.mockReturnValue(undefined)
    // 🔴 Se EXIGE el desenlace canónico incierto, no «algún error». Antes se rechazaba, y un
    // rechazo sale como HTTP 400: para un POS publicado eso significa «no se cobró» y le da
    // permiso para volver a pasar la tarjeta. La afirmación que este test guarda —«nunca
    // afirma que no se inició autorización»— sólo se cumple de verdad con `status:'timeout'`,
    // que los clientes ya publicados leen como incierto (504).
    await expect(terminalPaymentService.sendPaymentToTerminal(baseRequest({ requestId: 'lost-captured-socket' }))).resolves.toMatchObject({
      requestId: 'lost-captured-socket',
      status: 'timeout',
    })
    await flush()
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'UNKNOWN' }),
      }),
    )
    expect(tpr().updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    )
  })
})

describe('Busy picker query budget', () => {
  it('P2 no anuncia libre una terminal cuya reserva viva quedó en otro venue', async () => {
    // La terminal se movió de sucursal y su cobro sin resolver quedó en la anterior. La reserva
    // es FÍSICA —del aparato, no del venue—, así que el picker de la sucursal nueva tiene que
    // verla OCUPADA; si la anuncia libre, se manda un segundo cobro al mismo aparato.
    // Se fija la FORMA de la consulta: acotarla por venue es exactamente lo que la ocultaba.
    // El retorno sigue siendo sólo el flag de ocupado — ningún dato financiero ajeno cruza.
    // 🔴 El mock SIMULA la base: devuelve la fila SÓLO si el `where` de verdad la alcanzaría.
    // Un mock que la devuelve pase lo que pase no guarda nada — con el filtro por venue
    // reintroducido seguiría diciendo «ocupada» y esta prueba pasaría por el motivo equivocado.
    // Así, si alguien vuelve a acotar la consulta al venue, la fila no se encuentra y esto FALLA.
    const filaViva = { terminalId: 't-movida', venueId: 'venue-viejo' }
    tpr().groupBy.mockImplementation(async ({ where }: any) => {
      const alcanzaElVenue = where.venueId === undefined || where.venueId === filaViva.venueId
      const alcanzaLaTerminal = where.terminalId?.in?.includes(filaViva.terminalId) ?? false
      return alcanzaElVenue && alcanzaLaTerminal ? [{ terminalId: filaViva.terminalId }] : []
    })

    // COMPORTAMIENTO: desde la sucursal NUEVA, la terminal se reporta OCUPADA.
    const busy = await terminalPaymentService.getBusyTerminalIds('venue-nuevo', ['t-movida'])
    expect(busy.has('t-movida')).toBe(true)
    // Y no se filtra nada más que el hecho de estar ocupada.
    expect([...busy]).toEqual(['t-movida'])
    for (const [query] of tpr().groupBy.mock.calls) {
      expect(query.where).not.toHaveProperty('venueId')
    }
  })

  it('aggregates every candidate in bounded batches without dropping the last terminal', async () => {
    const candidates = Array.from({ length: 201 }, (_, index) => 'terminal-' + index)
    tpr().groupBy.mockImplementation(async ({ where }: any) => where.terminalId.in.map((terminalId: string) => ({ terminalId })))
    const busy = await terminalPaymentService.getBusyTerminalIds('venue-1', candidates)
    expect(busy.size).toBe(201)
    expect(busy.has('terminal-200')).toBe(true)
    expect(tpr().groupBy).toHaveBeenCalledTimes(3)
    for (const [query] of tpr().groupBy.mock.calls) {
      expect(query.take).toBe(100)
      expect(query.where.terminalId.in.length).toBeLessThanOrEqual(100)
      expect(query.by).toEqual(['terminalId'])
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Lápida de admisión (H.5/H.6): contención de la transacción, choque de unicidad y réplica
// ═══════════════════════════════════════════════════════════════════════════
describe('TerminalPaymentService — lápida de admisión: contención, choque de unicidad y réplica', () => {
  const send = (overrides: Record<string, unknown>) => terminalPaymentService.sendPaymentToTerminal(baseRequest(overrides))
  const P2028 = Object.assign(new Error('Transaction already closed: A query cannot be executed on an expired transaction'), {
    code: 'P2028',
  })
  const P2034 = Object.assign(new Error('Transaction failed due to a write conflict or a deadlock. Please retry your transaction'), {
    code: 'P2034',
  })
  const errorDe = async (promesa: Promise<unknown>) =>
    promesa.then(
      () => {
        throw new Error('se esperaba un rechazo')
      },
      (e: unknown) => e as any,
    )

  it.each([
    ['P2028', P2028],
    ['P2034', P2034],
  ])(
    '(h) %s en la admisión ⇒ 503 TERMINAL_PAYMENT_ADMISSION_RETRY con details.requestId: «reintenta con la MISMA solicitud; todavía no se sabe»',
    async (_code, err) => {
      prismaMock.$transaction.mockImplementationOnce(() => Promise.reject(err))
      const error = await errorDe(send({ terminalId: 'T-TX', requestId: 'REQ-TX' }))
      expect(error).toBeInstanceOf(TerminalPaymentAdmissionRetryError)
      expect(error).toMatchObject({ statusCode: 503, code: 'TERMINAL_PAYMENT_ADMISSION_RETRY', details: { requestId: 'REQ-TX' } })
      expect(tpr().create).not.toHaveBeenCalled()
      expect(directEmit).not.toHaveBeenCalled()
    },
  )

  it('la transacción de admisión espera hasta 15 s y hasta 5 s por una conexión', async () => {
    const pending = send({ terminalId: 'T-OPTS', requestId: 'REQ-OPTS' })
    await flush()
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 15_000, maxWait: 5_000 })
    committedRequests({ 'REQ-OPTS': 'pay-opts' })
    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-OPTS', status: 'success', paymentId: 'pay-opts' })
    expect((await pending).status).toBe('success')
  })

  it('P2002 al escribir la lápida (otra copia del MISMO requestId ganó) ⇒ relee y REPRODUCE su rechazo; nunca crea', async () => {
    const lapidaGanadora = {
      requestId: 'REQ-DUP',
      venueId: 'venue-1',
      terminalId: 't-dup',
      amountCents: 10000,
      tipCents: 0,
      orderId: null,
      status: 'FAILED',
      failureCode: 'REJECTED_TERMINAL_BUSY',
      resultJson: {
        requestId: 'REQ-DUP',
        status: 'failed',
        httpStatus: 409,
        code: 'TERMINAL_BUSY',
        message: 'La terminal T-DUP está ocupada por un cobro de $350.00 enviado hace 0 min',
        details: { requestId: 'REQ-DUP', blockingRequest: { requestId: 'REQ-A', amountCents: 35000, ageSeconds: 3 } },
      },
    }
    tpr()
      .findFirst.mockResolvedValueOnce(null) // la fila de esta solicitud todavía no se ve
      .mockResolvedValueOnce({
        requestId: 'REQ-A',
        venueId: 'venue-1',
        amountCents: 35000,
        senderDevice: null,
        createdAt: new Date(),
        status: 'PENDING',
      })
      .mockResolvedValueOnce(lapidaGanadora) // relectura tras el choque
    tpr().create.mockRejectedValueOnce(P2002)
    const error = await errorDe(send({ terminalId: 'T-DUP', requestId: 'REQ-DUP' }))
    expect(error).toBeInstanceOf(TerminalBusyError)
    expect(error.message).toBe(lapidaGanadora.resultJson.message)
    expect(error.details).toEqual(lapidaGanadora.resultJson.details)
    expect(tpr().create).toHaveBeenCalledTimes(1) // sólo la lápida que chocó: ninguna fila que ocupe la terminal
    expect(directEmit).not.toHaveBeenCalled()
  })

  it('P2002 al crear el cobro sin que aparezca la fila de esta solicitud ⇒ re-decide UNA vez bajo el candado y, si sigue sin poder, 503 — nunca un «no se creó» sin lápida', async () => {
    tpr().create.mockRejectedValue(P2002) // la ranura choca siempre y nunca se ve quién la ocupa
    const error = await errorDe(send({ terminalId: 'T-GHOST', requestId: 'REQ-GHOST' }))
    expect(error).toBeInstanceOf(TerminalPaymentAdmissionRetryError)
    expect(error).toMatchObject({ statusCode: 503, code: 'TERMINAL_PAYMENT_ADMISSION_RETRY', details: { requestId: 'REQ-GHOST' } })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    expect(tpr().create).toHaveBeenCalledTimes(2)
    expect(directEmit).not.toHaveBeenCalled()
  })

  it('sin requestId del cliente, el choque de ranura sigue saliendo como TERMINAL_BUSY y no escribe lápida (nada podría reproducirla)', async () => {
    tpr().create.mockRejectedValueOnce(P2002)
    tpr()
      .findFirst.mockResolvedValueOnce(null) // la fila propia antes del choque
      .mockResolvedValueOnce(null) // bloqueador bajo el candado: no se ve
      // Este cobro va SIN orden, así que la admisión comprueba además si la terminal arrastra una venta sin
      // desenlace — el rastro del «rodeo del pago rápido» (P1-2 de Codex). Aquí no hay ninguna.
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null) // relectura tras el choque: la fila propia no existe
      .mockResolvedValueOnce({
        requestId: 'REQ-HOLD',
        venueId: 'venue-1',
        amountCents: 5000,
        senderDevice: null,
        createdAt: new Date(),
        status: 'PENDING',
      })
    const error = await errorDe(send({ terminalId: 'T-LEGACY' }))
    expect(error).toBeInstanceOf(TerminalBusyError)
    expect(error.details.blockingRequest.requestId).toBe('REQ-HOLD')
    expect(error.details.requestId).toBeUndefined()
    expect(tpr().create).toHaveBeenCalledTimes(1)
    expect(tpr().create.mock.calls[0][0].data.status).toBe('PENDING')
    expect(directEmit).not.toHaveBeenCalled()
  })

  it.each([
    { failureCode: 'REJECTED_TERMINAL_NOT_CONNECTED', httpStatus: 404, code: 'TERMINAL_NOT_CONNECTED', clase: TerminalUnavailableError },
    { failureCode: 'REJECTED_TERMINAL_NO_SOCKET', httpStatus: 422, code: 'TERMINAL_NO_SOCKET', clase: TerminalUnavailableError },
    { failureCode: 'REJECTED_TERMINAL_OTHER_VENUE', httpStatus: 403, code: 'TERMINAL_NOT_IN_VENUE', clase: TerminalUnavailableError },
    { failureCode: 'REJECTED_TERMINAL_BUSY', httpStatus: 409, code: 'TERMINAL_BUSY', clase: TerminalBusyError },
    { failureCode: 'REJECTED_ORDER_BUSY', httpStatus: 409, code: 'TERMINAL_BUSY', clase: TerminalBusyError },
    { failureCode: 'REJECTED_ORDER_CANCELLED', httpStatus: 400, code: 'ORDER_CANCELLED_NO_NEW_CHARGE', clase: BadRequestError },
    { failureCode: 'REJECTED_ORDER_PAID', httpStatus: 409, code: 'ORDER_ALREADY_PAID', clase: OrderAlreadyPaidError },
    { failureCode: 'REJECTED_ORDER_NOT_FOUND', httpStatus: 400, code: 'ORDER_NOT_FOUND', clase: BadRequestError },
  ])(
    'la réplica de una lápida $failureCode reproduce el rechazo ($httpStatus $code) aunque su respuesta guardada no se pueda leer',
    async ({ failureCode, httpStatus, code, clase }) => {
      tpr().findFirst.mockResolvedValueOnce({
        requestId: 'REQ-L',
        venueId: 'venue-1',
        terminalId: 't-l',
        amountCents: 10000,
        tipCents: 0,
        orderId: null,
        status: 'FAILED',
        failureCode,
        resultJson: null,
      })
      const error = await errorDe(send({ terminalId: 'T-L', requestId: 'REQ-L' }))
      expect(error).toBeInstanceOf(clase)
      expect(error).toMatchObject({ statusCode: httpStatus, code, details: { requestId: 'REQ-L' } })
      expect(error.message).toEqual(expect.any(String))
      expect(tpr().create).not.toHaveBeenCalled()
      expect(directEmit).not.toHaveBeenCalled()
    },
  )

  it('una copia con OTRO contrato sobre una lápida es conflicto de solicitud: no hereda el rechazo ajeno', async () => {
    tpr().findFirst.mockResolvedValueOnce({
      requestId: 'REQ-L2',
      venueId: 'venue-1',
      terminalId: 't-l2',
      amountCents: 10000,
      tipCents: 0,
      orderId: null,
      status: 'FAILED',
      failureCode: 'REJECTED_TERMINAL_NOT_CONNECTED',
      resultJson: null,
    })
    await expect(send({ terminalId: 'T-L2', requestId: 'REQ-L2', amountCents: 20000 })).rejects.toThrow(
      'Esta solicitud ya pertenece a otro cobro',
    )
    expect(directEmit).not.toHaveBeenCalled()
  })

  it('la terminal de OTRO venue se rechaza en el servicio, bajo el candado y con su lápida (403 TERMINAL_NOT_IN_VENUE)', async () => {
    mockedGetTerminal.mockReturnValueOnce({ socketId: 'sock-x', venueId: 'venue-OTRO', terminalId: 't-x', terminalPaymentAckVersion: 1 })
    const error = await errorDe(send({ terminalId: 'T-X', requestId: 'REQ-X2' }))
    expect(error).toBeInstanceOf(TerminalUnavailableError)
    expect(error).toMatchObject({ statusCode: 403, code: 'TERMINAL_NOT_IN_VENUE', details: { requestId: 'REQ-X2' } })
    expect(tpr().create.mock.calls[0][0].data).toMatchObject({
      requestId: 'REQ-X2',
      status: 'FAILED',
      failureCode: 'REJECTED_TERMINAL_OTHER_VENUE',
    })
    expect(directEmit).not.toHaveBeenCalled()
  })
})

describe('Codex R1 (P2) · resolvePendingFromDurableState consulta por LOTES acotados', () => {
  it('con 250 esperas en memoria hace 3 consultas de a lo sumo 100 ids, nunca una sola con todos', async () => {
    const { terminalPaymentService } = await import('../../../src/services/terminal-payment.service')
    const mapa = (terminalPaymentService as unknown as { pendingPayments: Map<string, { requestId: string }> }).pendingPayments
    const ids = Array.from({ length: 250 }, (_, i) => `lote-${i}`)
    for (const id of ids) mapa.set(id, { requestId: id })
    const findMany = prismaMock.terminalPaymentRequest.findMany as jest.Mock
    findMany.mockReset()
    findMany.mockResolvedValue([])
    try {
      const r = await terminalPaymentService.resolvePendingFromDurableState()
      expect(r).toEqual({ resolved: 0, checked: 250 })
      expect(findMany).toHaveBeenCalledTimes(3)
      const tamanos = findMany.mock.calls.map(([args]) => (args.where.requestId.in as string[]).length)
      expect(tamanos).toEqual([100, 100, 50])
      for (const [args] of findMany.mock.calls) expect(args.take).toBe((args.where.requestId.in as string[]).length)
    } finally {
      for (const id of ids) mapa.delete(id)
    }
  })
})

describe('desenlaceCanonico — ventana de confirmación', () => {
  it('FAILED/NO_EVIDENCE_AFTER_WINDOW acredita «no se cobró» con clase SERVER (la ventana venció sin webhook, historial ni cajero)', () => {
    expect(desenlaceCanonico({ status: TerminalPaymentRequestStatus.FAILED, failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })).toEqual({
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW',
      evidenceClass: 'SERVER',
    })
  })

  it('un TIMED_OUT con resultado de la terminal pero sin código sigue UNRESOLVED: la ventana todavía no venció', () => {
    expect(
      desenlaceCanonico({ status: TerminalPaymentRequestStatus.TIMED_OUT, failureCode: null, resultJson: { status: 'timeout' } }).outcome,
    ).toBe('UNRESOLVED')
  })
})

describe('programarLiberacionPorVentana', () => {
  it('a los 30 s llama a releaseUnprovenNegative con origen TIMER, una sola vez por solicitud, y no retiene el proceso', () => {
    jest.useFakeTimers()
    try {
      const spy = jest.spyOn(terminalPaymentService, 'releaseUnprovenNegative').mockResolvedValue('NOT_ELIGIBLE')
      const svc = terminalPaymentService as any
      svc.programarLiberacionPorVentana('req-t', 'venue-t')
      svc.programarLiberacionPorVentana('req-t', 'venue-t') // idempotente: un solo temporizador
      jest.advanceTimersByTime(UNPROVEN_NEGATIVE_WINDOW_MS - 1)
      expect(spy).not.toHaveBeenCalled()
      jest.advanceTimersByTime(2)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith('req-t', 'venue-t', 'TIMER')
      expect((svc.ventanasProgramadas as Map<string, unknown>).has('req-t')).toBe(false)
      spy.mockRestore()
    } finally {
      jest.useRealTimers()
    }
  })
})

// ── Codex r1 · P1-B: el barrido de 30 min de las filas LIBERADAS avanza (keyset), no relee las mismas 200 ──
describe('P1-B · reconcileUnknownRequests pagina las filas liberadas por keyset (updatedAt, id) con tope de lotes', () => {
  const logger = require('@/config/logger').default
  const now = new Date('2026-09-16T12:00:00.000Z')
  const fila = (prefijo: string, i: number, extra: Record<string, unknown>) => ({
    id: `${prefijo}-id-${String(i).padStart(5, '0')}`,
    requestId: `${prefijo}-req-${i}`,
    venueId: 'venue-1',
    terminalId: 't-1',
    orderId: `o-${i}`,
    amountCents: 10_000,
    tipCents: 0,
    createdAt: new Date(now.getTime() - 25 * 60_000),
    // Dos filas por instante: el desempate por `id` es lo que hace estable el cursor.
    updatedAt: new Date(now.getTime() - 20 * 60_000 + Math.floor(i / 2) * 1000),
    ...extra,
  })
  const liberada = (i: number) => fila('rel', i, { status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
  const porVentana = (i: number) => fila('win', i, { status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
  const esLiberadas = (where: any) => where?.status === 'TIMED_OUT' && !!where?.failureCode?.in
  const esVentana = (where: any) => where?.status === 'FAILED' && where?.failureCode === 'NO_EVIDENCE_AFTER_WINDOW'
  /** La etiqueta que `findReconcilablePayment` busca (Codex r2, P2-N1: vive en la primera rama del `OR`). */
  const etiquetaBuscada = (where: any) => where?.OR?.[0]?.processorData?.equals

  beforeEach(() => {
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.payment.findFirst.mockReset().mockResolvedValue(null)
  })

  it('con findMany devolviendo 200, 200 y 3 filas liberadas (y 200 + 1 por ventana) las recorre TODAS: tres/dos consultas con el cursor de la última fila del lote anterior', async () => {
    const paginasLiberadas = [
      Array.from({ length: 200 }, (_, i) => liberada(i)),
      Array.from({ length: 200 }, (_, i) => liberada(200 + i)),
      [400, 401, 402].map(liberada),
    ]
    const paginasVentana = [Array.from({ length: 200 }, (_, i) => porVentana(i)), [porVentana(200)]]
    tpr().findMany.mockImplementation(async ({ where }: any) => {
      if (esLiberadas(where)) return paginasLiberadas.shift() ?? []
      if (esVentana(where)) return paginasVentana.shift() ?? []
      return []
    })
    await terminalPaymentService.reconcileUnknownRequests(now)
    const llamadas = tpr().findMany.mock.calls.map(([args]: any[]) => args)
    const deLiberadas = llamadas.filter((a: any) => esLiberadas(a.where))
    const deVentana = llamadas.filter((a: any) => esVentana(a.where))
    expect(deLiberadas).toHaveLength(3)
    expect(deVentana).toHaveLength(2)
    for (const a of [...deLiberadas, ...deVentana]) {
      expect(a.take).toBe(200)
      expect(a.orderBy).toEqual([{ updatedAt: 'asc' }, { id: 'asc' }])
    }
    // Primera consulta SIN cursor; segunda y tercera con el cursor keyset de la última fila del lote anterior.
    expect(deLiberadas[0].where.OR).toBeUndefined()
    const ultima1 = liberada(199)
    expect(deLiberadas[1].where.OR).toEqual([
      { updatedAt: { gt: ultima1.updatedAt } },
      { updatedAt: ultima1.updatedAt, id: { gt: ultima1.id } },
    ])
    const ultima2 = liberada(399)
    expect(deLiberadas[2].where.OR).toEqual([
      { updatedAt: { gt: ultima2.updatedAt } },
      { updatedAt: ultima2.updatedAt, id: { gt: ultima2.id } },
    ])
    const ultimaV = porVentana(199)
    expect(deVentana[1].where.OR).toEqual([
      { updatedAt: { gt: ultimaV.updatedAt } },
      { updatedAt: ultimaV.updatedAt, id: { gt: ultimaV.id } },
    ])
    // Y el filtro de la ventana de 30 min se conserva en TODAS las consultas (el cursor se le suma, no lo sustituye).
    for (const a of [...deLiberadas, ...deVentana]) expect(a.where.updatedAt).toEqual({ gte: expect.any(Date) })
    // Se procesaron las 403 + 201: cada fila buscó su Payment reconciliable.
    const buscadas = prismaMock.payment.findFirst.mock.calls.map(([a]: any[]) => etiquetaBuscada(a.where))
    expect(buscadas.filter((r: string) => r?.startsWith('rel-req-'))).toHaveLength(403)
    expect(buscadas.filter((r: string) => r?.startsWith('win-req-'))).toHaveLength(201)
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('batch cap'), expect.anything())
  })

  it('el tope corta: con lotes de 200 sin fin se detiene en 25 (5 000 filas) y lo avisa con logger.warn', async () => {
    let n = 0
    tpr().findMany.mockImplementation(async ({ where }: any) => {
      if (esLiberadas(where)) return Array.from({ length: 200 }, () => liberada(n++))
      return []
    })
    await terminalPaymentService.reconcileUnknownRequests(now)
    const deLiberadas = tpr().findMany.mock.calls.filter(([a]: any[]) => esLiberadas(a.where))
    expect(deLiberadas).toHaveLength(25)
    expect(
      prismaMock.payment.findFirst.mock.calls.filter(([a]: any[]) => String(etiquetaBuscada(a.where)).startsWith('rel-req-')),
    ).toHaveLength(5000)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('batch cap'), expect.objectContaining({ lotes: 25, filas: 5000 }))
  })
})

// ── Codex r2 · P1-D: la sonda pasa TODAS las señales positivas del sobre de la bandeja a `closeRow`, no sólo paymentId ──
describe('P1-D (r2) · handleProbeResultFromSocket conserva las señales positivas del finalResult', () => {
  it('un RESOLVED/success con paymentId, transactionId, authorizationCode, reference, readMode y approved llega a closeRow con las seis', async () => {
    const svc = terminalPaymentService as any
    tpr().findFirst.mockResolvedValue({
      id: 'row-p',
      status: 'UNKNOWN',
      acknowledgedAt: null,
      lastDeliveredAt: null,
      deliveryProvenance: null,
      expiresAt: new Date(0),
      terminalId: 't-probe',
    })
    const closeRow = jest.spyOn(svc, 'closeRow').mockResolvedValue({ requestId: 'REQ-PROBE', status: 'timeout' })
    try {
      const ok = await svc.handleProbeResultFromSocket(
        {
          requestId: 'REQ-PROBE',
          disposition: 'RESOLVED',
          finalResult: {
            requestId: 'REQ-PROBE',
            status: 'success',
            paymentId: 'pay-p',
            transactionId: 'tx-p',
            authorizationCode: 'A1',
            reference: 'ref-p',
            readMode: 'CONTACTLESS',
            approved: true,
            errorMessage: 'ok',
            completedAt: '2026-09-16T00:00:00.000Z', // NO es señal positiva: no viaja
          },
        },
        { socketId: 'sock-t-probe', terminalId: 't-probe', venueId: 'venue-1' },
      )
      expect(ok).toBe(true)
      expect(closeRow).toHaveBeenCalledTimes(1)
      expect(closeRow.mock.calls[0][2]).toEqual({
        requestId: 'REQ-PROBE',
        status: 'success',
        paymentId: 'pay-p',
        transactionId: 'tx-p',
        authorizationCode: 'A1',
        reference: 'ref-p',
        readMode: 'CONTACTLESS',
        approved: true,
        errorMessage: 'ok',
      })
    } finally {
      closeRow.mockRestore()
    }
  })

  it('las señales vacías o de tipo equivocado no viajan (una cadena vacía o un `approved: "yes"` no afirman nada)', async () => {
    const svc = terminalPaymentService as any
    tpr().findFirst.mockResolvedValue({
      id: 'row-q',
      status: 'UNKNOWN',
      acknowledgedAt: null,
      lastDeliveredAt: null,
      deliveryProvenance: null,
      expiresAt: new Date(0),
      terminalId: 't-probe',
    })
    const closeRow = jest.spyOn(svc, 'closeRow').mockResolvedValue({ requestId: 'REQ-PROBE-2', status: 'timeout' })
    try {
      await svc.handleProbeResultFromSocket(
        {
          requestId: 'REQ-PROBE-2',
          disposition: 'RESOLVED',
          finalResult: { requestId: 'REQ-PROBE-2', status: 'success', transactionId: '', reference: 7, approved: 'yes', readMode: null },
        },
        { socketId: 'sock-t-probe', terminalId: 't-probe', venueId: 'venue-1' },
      )
      expect(closeRow.mock.calls[0][2]).toEqual({ requestId: 'REQ-PROBE-2', status: 'success' })
    } finally {
      closeRow.mockRestore()
    }
  })
})
