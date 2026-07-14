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
import { TerminalBusyError } from '@/errors/AppError'

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
      getAllTerminalIds: jest.fn(() => []),
    },
  }
})

const prismaMock = prisma as any
const mockedGetServer = (socketManager as unknown as { getServer: jest.Mock }).getServer
const mockedGetTerminal = terminalRegistry.getTerminal as jest.Mock
const tpr = () => prismaMock.terminalPaymentRequest

const P2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
const flush = () => new Promise(resolve => setImmediate(resolve))

let emit: jest.Mock

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
  const io = { to: jest.fn(() => ({ emit })) }
  mockedGetServer.mockReturnValue(io)

  mockedGetTerminal.mockImplementation((id: string) => {
    const normalized = id.replace(/^AVQD-/i, '').toLowerCase()
    return {
      socketId: `sock-${normalized}`,
      venueId: 'venue-1',
      terminalId: normalized,
      registeredAt: new Date(),
      lastHeartbeat: new Date(),
    }
  })

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
    tpr().findUnique.mockResolvedValueOnce(null) // my requestId not in table → slot conflict
    tpr().findFirst.mockResolvedValueOnce({
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
    expect(emit).not.toHaveBeenCalled() // never reached the terminal
  })

  it('idempotent replay: same requestId on an already-COMPLETED row returns the stored result, no re-emit', async () => {
    tpr().create.mockRejectedValueOnce(P2002)
    tpr().findUnique.mockResolvedValueOnce({
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
    expect(emit).not.toHaveBeenCalled()
  })

  it('same requestId still in flight → busy (no double emit)', async () => {
    tpr().create.mockRejectedValueOnce(P2002)
    tpr().findUnique.mockResolvedValueOnce({
      requestId: 'REQ-A',
      status: 'PENDING',
      amountCents: 10000,
      senderDevice: null,
      createdAt: new Date(),
    })

    await expect(
      terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-DUP', requestId: 'REQ-A' })),
    ).rejects.toBeInstanceOf(TerminalBusyError)
    expect(emit).not.toHaveBeenCalled()
  })

  it('happy path: INSERT succeeds → emits → result closes the row via in-flight CAS', async () => {
    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-OK', requestId: 'REQ-1' }))
    // give the async create a tick, then assert the emit happened
    await flush()
    expect(tpr().create).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('terminal:payment_request', expect.objectContaining({ requestId: 'REQ-1' }))

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

  it('rollback flag OFF: a busy-slot INSERT is swallowed and the charge proceeds (old behavior)', async () => {
    process.env.TERMINAL_PAYMENT_LOCK_ENABLED = 'false'
    tpr().create.mockRejectedValueOnce(P2002)
    tpr().findUnique.mockResolvedValueOnce(null)
    tpr().findFirst.mockResolvedValueOnce({
      requestId: 'REQ-A',
      amountCents: 10000,
      senderDevice: null,
      createdAt: new Date(),
      status: 'PENDING',
    })

    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-FLAG', requestId: 'REQ-B' }))
    await flush()
    expect(emit).toHaveBeenCalledTimes(1) // proceeded despite the busy slot

    terminalPaymentService.handlePaymentResult({ requestId: 'REQ-B', status: 'success' })
    await p1
  })

  it('isTerminalBusy / getBusyTerminalIds read the durable rows', async () => {
    tpr().findFirst.mockResolvedValueOnce({ id: 'x' })
    expect(await terminalPaymentService.isTerminalBusy('AVQD-ABC')).toBe(true)
    tpr().findFirst.mockResolvedValueOnce(null)
    expect(await terminalPaymentService.isTerminalBusy('AVQD-ABC')).toBe(false)

    tpr().findMany.mockResolvedValueOnce([{ terminalId: 'a' }, { terminalId: 'b' }])
    const set = await terminalPaymentService.getBusyTerminalIds('venue-1')
    expect(set).toEqual(new Set(['a', 'b']))
  })

  it('cancelPayment marks the row CANCEL_REQUESTED (holds slot) and resolves the long-poll', async () => {
    const p1 = terminalPaymentService.sendPaymentToTerminal(baseRequest({ terminalId: 'T-CANCEL', requestId: 'REQ-C' }))
    await flush()

    await terminalPaymentService.cancelPayment('T-CANCEL', 'REQ-C')
    const result = await p1
    expect(result.status).toBe('cancelled')
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCEL_REQUESTED' }) }),
    )
  })

  it('getPaymentStatus returns a pesos projection and enforces tenant isolation', async () => {
    tpr().findUnique.mockResolvedValueOnce({
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
    tpr().findUnique.mockResolvedValueOnce({
      requestId: 'REQ-A',
      venueId: 'venue-1',
      amountCents: 1,
      tipCents: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    expect(await terminalPaymentService.getPaymentStatus('REQ-A', 'venue-OTHER')).toBeNull()
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
    expect(emit).toHaveBeenCalledTimes(2)

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
        findUnique: jest.fn().mockResolvedValue({ status }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    }) as any

  it('reconciles an already-CANCELLED row to COMPLETED (a recorded Payment is money-moved ground truth) and alerts 🚨', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    const tx = txWith('CANCELLED')

    await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-Z', 'pay-late')

    expect(tx.terminalPaymentRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requestId: 'REQ-Z', status: { not: 'COMPLETED' } },
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

    await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-P', 'pay-1')

    expect(tx.terminalPaymentRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED', lateResult: false }) }),
    )
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('🚨 [Terminal-payment]'), expect.any(Object))
    errSpy.mockRestore()
  })

  it('is a no-op on an already-COMPLETED row (idempotent — never clobbers the stored paymentId)', async () => {
    const tx = txWith('COMPLETED')
    await terminalPaymentService.closeRowFromPaymentTx(tx, 'REQ-DONE', 'pay-2')
    expect(tx.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
  })
})
