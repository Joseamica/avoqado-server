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

import prisma from '@/utils/prismaClient'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { OrderAlreadyPaidError, TerminalBusyError } from '@/errors/AppError'

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
  tpr().create.mockResolvedValue({})
  tpr().findUnique.mockResolvedValue(null)
  tpr().findFirst.mockResolvedValue(null)
  tpr().findMany.mockResolvedValue([])
  tpr().updateMany.mockResolvedValue({ count: 1 })
  prismaMock.payment.findFirst.mockResolvedValue(null)
})

describe('TerminalPaymentService — durable per-terminal lock (Slice 1)', () => {
  it('rejects a second concurrent charge (P2002 on the slot index) with a busy error naming the blocker', async () => {
    tpr().create.mockRejectedValueOnce(P2002) // slot already held
    tpr().findFirst
      .mockResolvedValueOnce(null) // my requestId not in table → slot conflict
      .mockResolvedValueOnce({
        requestId: 'REQ-A',
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
    expect(directEmit).not.toHaveBeenCalled() // never reached the terminal
  })

  it('idempotent replay: same requestId on an already-COMPLETED row returns the stored result, no re-emit', async () => {
    tpr().create.mockRejectedValueOnce(P2002)
    tpr().findFirst.mockResolvedValueOnce({
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

  it('same requestId still in flight → busy (no double emit)', async () => {
    tpr().create.mockRejectedValueOnce(P2002)
    tpr().findFirst.mockResolvedValueOnce({
      requestId: 'REQ-A',
      status: 'PENDING',
      amountCents: 10000,
      senderDevice: null,
      createdAt: new Date(),
    })

    await expect(
      terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-DUP', requestId: 'REQ-A' })),
    ).rejects.toBeInstanceOf(TerminalBusyError)
    expect(directEmit).not.toHaveBeenCalled()
  })

  it('happy path: INSERT succeeds → emits → result closes the row via in-flight CAS', async () => {
    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-OK', requestId: 'REQ-1' }))
    // give the async create a tick, then assert the emit happened
    await flush()
    expect(tpr().create).toHaveBeenCalledTimes(1)
    expect(directEmit).toHaveBeenCalledWith(
      'terminal:payment_request',
      expect.objectContaining({ requestId: 'REQ-1' }),
      expect.any(Function),
    )

    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-1', status: 'success', paymentId: 'pay-9' })
    const result = await p1
    expect(result.status).toBe('success')

    await flush() // let the fire-and-forget closeRow run
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requestId: 'REQ-1', status: { in: expect.arrayContaining(['PENDING']) } }),
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

  it('si la TPV nueva no confirma persistencia, falla sin dejar el cobro activo', async () => {
    directEmit.mockImplementationOnce(
      (_event: string, _payload: unknown, callback: (error: Error) => void) => callback(new Error('operation has timed out')),
    )

    await expect(
      terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-NO-ACK', requestId: 'REQ-NO-ACK' })),
    ).rejects.toThrow('no confirmó que guardó el cobro')
    await flush()

    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requestId: 'REQ-NO-ACK', venueId: 'venue-1', status: 'PENDING' },
        data: expect.objectContaining({ status: 'FAILED', failureCode: 'ACK_TIMEOUT' }),
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

    const pending = terminalPaymentService.sendPaymentToTerminal(
      baseRequest({ terminalId: 'T-LEGACY', requestId: 'REQ-LEGACY' }),
    )
    await flush()

    expect(directEmit).toHaveBeenCalledWith(
      'terminal:payment_request',
      expect.objectContaining({ requestId: 'REQ-LEGACY' }),
    )
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
    tpr().findFirst.mockResolvedValueOnce({ requestId: 'REQ-AUTH' })

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

  it('rollback flag OFF: a busy-slot INSERT is swallowed and the charge proceeds (old behavior)', async () => {
    process.env.TERMINAL_PAYMENT_LOCK_ENABLED = 'false'
    tpr().create.mockRejectedValueOnce(P2002)
    tpr().findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        requestId: 'REQ-A',
        amountCents: 10000,
        senderDevice: null,
        createdAt: new Date(),
        status: 'PENDING',
      })

    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-FLAG', requestId: 'REQ-B' }))
    await flush()
    expect(directEmit).toHaveBeenCalledTimes(1) // proceeded despite the busy slot

    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-B', status: 'success' })
    await p1
  })

  it('isTerminalBusy / getBusyTerminalIds read the durable rows', async () => {
    tpr().findFirst.mockResolvedValueOnce({ id: 'x' })
    expect(await terminalPaymentService.isTerminalBusy('AVQD-ABC', 'venue-1')).toBe(true)
    tpr().findFirst.mockResolvedValueOnce(null)
    expect(await terminalPaymentService.isTerminalBusy('AVQD-ABC', 'venue-1')).toBe(false)

    tpr().findMany.mockResolvedValueOnce([{ terminalId: 'a' }, { terminalId: 'b' }])
    const set = await terminalPaymentService.getBusyTerminalIds('venue-1')
    expect(set).toEqual(new Set(['a', 'b']))
  })

  it('cancelPayment marks the row CANCEL_REQUESTED (holds slot) and resolves the long-poll', async () => {
    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-CANCEL', requestId: 'REQ-C' }))
    await flush()

    await terminalPaymentService.cancelPayment('T-CANCEL', 'REQ-C', undefined, 'venue-1')
    const result = await p1
    expect(result.status).toBe('cancelled')
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

    const emitted = await terminalPaymentService.cancelPayment('T-OFF', 'REQ-OFF', 'user cancel', 'venue-1')

    expect(emitted).toBe(false) // could not notify the terminal…
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCEL_REQUESTED' }) }),
    ) // …but the row IS cancelled
    const result = await p1
    expect(result.status).toBe('cancelled') // and the POS long-poll unblocks
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

  it('a stale row whose order now has a Payment → COMPLETED (late)', async () => {
    tpr().findMany.mockResolvedValueOnce([
      {
        id: 'row-1',
        requestId: 'REQ-A',
        venueId: 'venue-1',
        terminalId: 'abc',
        orderId: 'o1',
        status: 'PENDING',
        createdAt: new Date(now.getTime() - 400_000),
      },
    ])
    prismaMock.payment.findFirst.mockResolvedValueOnce({ id: 'pay-1' })

    const summary = await terminalPaymentService.reconcileStaleRequests(now)
    expect(summary.completed).toBe(1)
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED', paymentId: 'pay-1', lateResult: true }) }),
    )
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

  it('only reconciles a Payment that does NOT predate the request row (createdAt >= row.createdAt)', async () => {
    // A payment for THIS request cannot exist before the request row was created; the query
    // must carry that temporal filter so an unrelated PRIOR cash/split payment is excluded.
    const rowCreatedAt = new Date(now.getTime() - 200_000)
    tpr().findMany.mockResolvedValueOnce([
      { id: 'row-1', requestId: 'REQ-A', venueId: 'venue-1', terminalId: 'abc', orderId: 'o1', status: 'PENDING', createdAt: rowCreatedAt },
    ])
    prismaMock.payment.findFirst.mockResolvedValueOnce(null) // DB filter leaves no qualifying payment

    const summary = await terminalPaymentService.reconcileStaleRequests(now)
    expect(prismaMock.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orderId: 'o1', venueId: 'venue-1', createdAt: { gte: rowCreatedAt } }) }),
    )
    expect(summary.completed).toBe(0)
    expect(summary.unknown).toBe(1) // no qualifying payment → HELD, never falsely completed
  })

  it('does NOT complete against a Payment already claimed by ANOTHER request → UNKNOWN (never free blind)', async () => {
    // Split/multi-card orders record several payments; a payment already linked to a different
    // terminal request is not ours. Stealing it would free the slot on a mis-linked payment.
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
    prismaMock.payment.findFirst.mockResolvedValueOnce({ id: 'pay-other' }) // a payment exists on the order…
    tpr().findFirst.mockResolvedValueOnce({ id: 'row-owner' }) // …but it belongs to a DIFFERENT request

    const summary = await terminalPaymentService.reconcileStaleRequests(now)
    expect(prismaMock.terminalPaymentRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ paymentId: 'pay-other', id: { not: 'row-stale' } }) }),
    )
    expect(summary.completed).toBe(0)
    expect(tpr().updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }))
    expect(summary.unknown).toBe(1)
    expect(tpr().updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'UNKNOWN' }) }))
  })
})

describe('TerminalPaymentService — regression (existing behavior intact)', () => {
  it('single charges to different terminals do not block each other', async () => {
    const pA = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-A', requestId: 'REQ-A' }))
    const pB = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-B', requestId: 'REQ-B' }))
    await flush()
    expect(directEmit).toHaveBeenCalledTimes(2)

    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-A', status: 'success' })
    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-B', status: 'success' })
    const [rA, rB] = await Promise.all([pA, pB])
    expect(rA.status).toBe('success')
    expect(rB.status).toBe('success')
  })

  it('still throws when the terminal is not connected, and never writes a row', async () => {
    mockedGetTerminal.mockReturnValueOnce(null)
    await expect(terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-GONE', requestId: 'REQ-X' }))).rejects.toThrow(
      'no está conectada',
    )
    expect(tpr().create).not.toHaveBeenCalled()
  })
})

describe('TerminalPaymentService — closeRowFromPaymentTx (money moved beats a prior close)', () => {
  const txWith = (status: string) =>
    ({
      terminalPaymentRequest: {
        findFirst: jest.fn().mockResolvedValue({ status }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    }) as any

  it('reconciles an already-CANCELLED row to COMPLETED (a recorded Payment is money-moved ground truth) and alerts 🚨', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    const tx = txWith('CANCELLED')

    await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-Z', 'pay-late', 'venue-1')

    expect(tx.terminalPaymentRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requestId: 'REQ-Z', venueId: 'venue-1', status: { not: 'COMPLETED' } },
        data: expect.objectContaining({ status: 'COMPLETED', paymentId: 'pay-late', lateResult: true }),
      }),
    )
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('🚨 [Terminal-payment]'), expect.any(Object))
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
      terminalPaymentRequest: {
        findFirst: jest.fn().mockResolvedValue({ status: 'SENT', amountCents: 47_500, tipCents: 4_750 }),
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

  it('is a no-op on an already-COMPLETED row (idempotent — never clobbers the stored paymentId)', async () => {
    const tx = txWith('COMPLETED')
    await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-DONE', 'pay-2', 'venue-1')
    expect(tx.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
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
  it('blocks on PENDING/SENT/UNKNOWN but deliberately EXCLUDES CANCEL_REQUESTED (normal POS cancel flow must not 409)', async () => {
    tpr().findFirst.mockResolvedValueOnce({ requestId: 'REQ-LIVE' })

    const blocked = await terminalPaymentService.hasChargeBlockingOrderCancel('venue-1', 'order-1')

    expect(blocked).toBe(true)
    const where = (tpr().findFirst as jest.Mock).mock.calls[0][0].where
    expect(where).toMatchObject({ venueId: 'venue-1', orderId: 'order-1' })
    expect(where.status.in).toEqual(expect.arrayContaining(['PENDING', 'SENT', 'UNKNOWN']))
    expect(where.status.in).not.toContain('CANCEL_REQUESTED')
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

    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-G2', status: 'success', paymentId: 'pay-g2' })
    expect((await p1).status).toBe('success')
  })

  it('fail-open: si la verificación truena (DB caída), el cobro procede — un fallo de infra jamás bloquea un cobro legítimo', async () => {
    order().findFirst.mockRejectedValue(new Error('connection refused'))

    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-FO', orderId: 'order-x', requestId: 'REQ-G3' }))
    await flush()
    expect(tpr().create).toHaveBeenCalledTimes(1)

    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-G3', status: 'success', paymentId: 'pay-g3' })
    expect((await p1).status).toBe('success')
  })

  it('cobro rápido SIN orden → ni siquiera consulta la orden (cero costo para el flujo Cobrar)', async () => {
    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-FAST', requestId: 'REQ-G4' }))
    await flush()
    expect(order().findFirst).not.toHaveBeenCalled()

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

  it('un pago con TARJETA y COMPLETED sí la cierra — el camino bueno no se rompe', async () => {
    tpr().findMany.mockResolvedValueOnce([staleRow({ id: 'row-3', requestId: 'REQ-W3' })])
    prismaMock.payment.findFirst.mockResolvedValueOnce({ id: 'pay-ok' })
    tpr().findFirst.mockResolvedValueOnce(null) // no reclamado por otra solicitud
    tpr().updateMany.mockResolvedValueOnce({ count: 1 })

    const res = await terminalPaymentService.reconcileStaleRequests(new Date('2026-08-11T10:10:00Z'))

    expect(res.completed).toBe(1)
    expect(res.unknown).toBe(0)
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

    tpr().findMany.mockResolvedValueOnce([
      {
        id: 'row-c1',
        requestId: 'REQ-C1',
        venueId: 'venue-1',
        terminalId: 't-c1',
        orderId: 'order-c1',
        status: 'CANCEL_REQUESTED',
        createdAt: new Date('2026-08-11T10:00:00Z'),
      },
    ])
    prismaMock.payment.findFirst.mockResolvedValueOnce({ id: 'pay-c1' })
    tpr().findFirst.mockResolvedValueOnce(null)
    tpr().updateMany.mockResolvedValueOnce({ count: 1 })

    await terminalPaymentService.reconcileStaleRequests(new Date('2026-08-11T10:10:00Z'))

    const alerted = errSpy.mock.calls.some(c => String(c[0]).includes('🚨') && String(c[0]).toLowerCase().includes('cancel'))
    expect(alerted).toBe(true)
  })

  it('un cobro normal que sólo llegó tarde NO dispara la alarma — no se cansa a nadie con ruido', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    errSpy.mockClear()

    tpr().findMany.mockResolvedValueOnce([
      {
        id: 'row-c2',
        requestId: 'REQ-C2',
        venueId: 'venue-1',
        terminalId: 't-c2',
        orderId: 'order-c2',
        status: 'SENT', // nadie canceló: es una reconciliación normal
        createdAt: new Date('2026-08-11T10:00:00Z'),
      },
    ])
    prismaMock.payment.findFirst.mockResolvedValueOnce({ id: 'pay-c2' })
    tpr().findFirst.mockResolvedValueOnce(null)
    tpr().updateMany.mockResolvedValueOnce({ count: 1 })

    await terminalPaymentService.reconcileStaleRequests(new Date('2026-08-11T10:10:00Z'))

    const alerted = errSpy.mock.calls.some(c => String(c[0]).includes('🚨'))
    expect(alerted).toBe(false)
  })
})
