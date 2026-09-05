/**
 * Terminal Payment Service — UNKNOWN is no longer a dead end (auto-release + manual release)
 *
 * Incident (Testarudo, 2026-09-04): a charge the PAX never answered went UNKNOWN and held the
 * terminal's slot for 3 hours until a human ran SQL. The founder's rule: the server frees the
 * slot on its own once the terminal is back (a heartbeat AFTER the request expired) and
 * 2 more minutes pass with no card payment. Money-safety: a recorded card payment ALWAYS wins
 * over a release, and nothing is freed while the terminal is still gone.
 *
 * 1. NEW FEATURE TESTS — reconcileUnknownRequests, releaseUnknownRequest, busy message
 * 2. REGRESSION TESTS — in-flight rows untouched, existing close paths unchanged
 */

import prisma from '@/utils/prismaClient'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { sendOpsAlert } from '@/services/alerts/opsAlert.service'
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
      getTerminalBySocketId: jest.fn(),
      getAllTerminalIds: jest.fn(() => []),
    },
  }
})

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/alerts/opsAlert.service', () => ({
  sendOpsAlert: jest.fn().mockResolvedValue(undefined),
}))

const prismaMock = prisma as any
const mockedGetServer = (socketManager as unknown as { getServer: jest.Mock }).getServer
const mockedGetTerminal = terminalRegistry.getTerminal as jest.Mock
const mockedLogAction = logAction as jest.Mock
const mockedSendOpsAlert = sendOpsAlert as jest.Mock
const tpr = () => prismaMock.terminalPaymentRequest

const NOW = new Date('2026-09-04T20:40:00.000Z')
const EXPIRED_AT = new Date('2026-09-04T20:33:20.000Z') // the request's 5-min deadline, in the past
// 20 min, not 2: the TPV replays its offline payment queue every 15 min (PaymentSyncScheduler), so a
// charge whose REST record got cut can land up to 15 min after the terminal is back. Freeing earlier
// would invite a second charge.
const GRACE_MS = 20 * 60_000
const ALIVE_WINDOW_MS = 5 * 60_000

function unknownRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-u',
    requestId: 'REQ-U',
    venueId: 'venue-1',
    terminalId: '2841653112',
    orderId: 'order-1',
    amountCents: 13500,
    tipCents: 0,
    status: 'UNKNOWN',
    failureCode: 'TIMED_OUT',
    senderDevice: 'Sunmi D3',
    createdAt: new Date('2026-09-04T20:28:20.000Z'),
    expiresAt: EXPIRED_AT,
    terminalReturnedAt: null,
    ...overrides,
  }
}

function terminalWithHeartbeat(lastHeartbeat: Date | null) {
  prismaMock.terminal.findFirst.mockResolvedValue({ id: 'term-1', lastHeartbeat })
}

beforeEach(() => {
  jest.clearAllMocks()
  delete process.env.TERMINAL_PAYMENT_LOCK_ENABLED
  mockedGetServer.mockReturnValue({ to: jest.fn(() => ({ emit: jest.fn() })), sockets: { sockets: { get: jest.fn() } } })
  mockedGetTerminal.mockReturnValue(null)
  tpr().findMany.mockResolvedValue([])
  tpr().findFirst.mockResolvedValue(null)
  tpr().updateMany.mockResolvedValue({ count: 1 })
  prismaMock.payment.findFirst.mockResolvedValue(null)
  prismaMock.terminal.findFirst.mockResolvedValue(null)
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. reconcileUnknownRequests — the watchdog keeps asking until it can decide
// ═══════════════════════════════════════════════════════════════════════════
describe('reconcileUnknownRequests — money first: a recorded card payment always wins', () => {
  it('UNKNOWN row whose order got a reconcilable card payment → COMPLETED (late) + 🚨', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    tpr().findMany.mockResolvedValueOnce([unknownRow()])
    prismaMock.payment.findFirst.mockResolvedValueOnce({ id: 'pay-late' })

    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    expect(summary.completed).toBe(1)
    expect(summary.released).toBe(0)
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'row-u', status: 'UNKNOWN' }),
        data: expect.objectContaining({ status: 'COMPLETED', paymentId: 'pay-late', lateResult: true }),
      }),
    )
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('🚨'), expect.objectContaining({ requestId: 'REQ-U' }))
    errSpy.mockRestore()
  })

  it('the payment lookup carries the same 4 guards as the stale sweep (after the row, COMPLETED, card, not claimed)', async () => {
    const row = unknownRow()
    tpr().findMany.mockResolvedValueOnce([row])
    prismaMock.payment.findFirst.mockResolvedValueOnce({ id: 'pay-x' })
    tpr().findFirst.mockResolvedValueOnce({ id: 'row-other' }) // already claimed by another request

    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    expect(prismaMock.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orderId: 'order-1',
          venueId: 'venue-1',
          createdAt: { gte: row.createdAt },
          status: 'COMPLETED',
          method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] },
        }),
      }),
    )
    expect(summary.completed).toBe(0) // claimed by another row → not ours → never completes on it
  })
})

describe('reconcileUnknownRequests — the terminal must be BACK before anything is freed', () => {
  it('terminal never sent a heartbeat → row untouched, no release', async () => {
    tpr().findMany.mockResolvedValueOnce([unknownRow()])
    terminalWithHeartbeat(null)

    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    expect(summary.released).toBe(0)
    expect(summary.marked).toBe(0)
    expect(tpr().updateMany).not.toHaveBeenCalled()
  })

  it('last heartbeat is OLDER than the request deadline → the terminal has not come back → untouched', async () => {
    tpr().findMany.mockResolvedValueOnce([unknownRow()])
    terminalWithHeartbeat(new Date(EXPIRED_AT.getTime() - 60_000))

    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    expect(summary.released).toBe(0)
    expect(summary.marked).toBe(0)
    expect(tpr().updateMany).not.toHaveBeenCalled()
  })

  it('first heartbeat AFTER the deadline → stamps terminalReturnedAt with the OBSERVATION time (CAS on UNKNOWN + unmarked), does NOT release', async () => {
    tpr().findMany.mockResolvedValueOnce([unknownRow()])
    // Heartbeat after the deadline but ~6 min old (server was down in between): stamping ITS time
    // instead of the observation time would shorten the grace by those 6 minutes.
    const back = new Date(EXPIRED_AT.getTime() + 30_000)
    terminalWithHeartbeat(back)

    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    expect(summary.marked).toBe(1)
    expect(summary.released).toBe(0)
    expect(tpr().updateMany).toHaveBeenCalledTimes(1)
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'row-u', status: 'UNKNOWN', terminalReturnedAt: null }),
        data: expect.objectContaining({ terminalReturnedAt: NOW }),
      }),
    )
    expect(mockedSendOpsAlert).not.toHaveBeenCalled()
  })

  it('marked, grace elapsed, but the terminal went dark again (no heartbeat in the alive window) → stamp reset, NOT released', async () => {
    const returnedAt = new Date(NOW.getTime() - GRACE_MS - 60_000)
    tpr().findMany.mockResolvedValueOnce([unknownRow({ terminalReturnedAt: returnedAt })])
    terminalWithHeartbeat(new Date(NOW.getTime() - ALIVE_WINDOW_MS - 1_000)) // last seen just outside the window

    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    expect(summary.released).toBe(0)
    expect(summary.reset).toBe(1)
    expect(tpr().updateMany).toHaveBeenCalledTimes(1)
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'row-u', status: 'UNKNOWN', terminalReturnedAt: returnedAt }),
        data: { terminalReturnedAt: null },
      }),
    )
    expect(mockedLogAction).not.toHaveBeenCalled()
    expect(mockedSendOpsAlert).not.toHaveBeenCalled()
  })

  it('marked but the grace has not elapsed → untouched', async () => {
    const returnedAt = new Date(NOW.getTime() - GRACE_MS + 5_000)
    tpr().findMany.mockResolvedValueOnce([unknownRow({ terminalReturnedAt: returnedAt })])
    terminalWithHeartbeat(new Date(NOW.getTime() - 10_000))

    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    expect(summary.released).toBe(0)
    expect(tpr().updateMany).not.toHaveBeenCalled()
  })

  it('marked, grace elapsed, no card payment → released as TIMED_OUT/AUTO_RELEASED with audit trail, 🚨 log and ops email', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    const returnedAt = new Date(NOW.getTime() - GRACE_MS)
    tpr().findMany.mockResolvedValueOnce([unknownRow({ terminalReturnedAt: returnedAt })])
    terminalWithHeartbeat(new Date(NOW.getTime() - 10_000))

    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    expect(summary.released).toBe(1)
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'row-u', status: 'UNKNOWN' }), // CAS: only if still UNKNOWN
        data: expect.objectContaining({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' }),
      }),
    )
    // resultJson stays untouched: resultFromRow must keep replaying "timeout" to a POS that retries the id
    const releaseCall = tpr().updateMany.mock.calls.find((c: any[]) => c[0]?.data?.failureCode === 'AUTO_RELEASED')
    expect(releaseCall[0].data).not.toHaveProperty('resultJson')

    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'venue-1',
        action: 'TERMINAL_PAYMENT_AUTO_RELEASED',
        entity: 'TerminalPaymentRequest',
        entityId: 'row-u',
        data: expect.objectContaining({ requestId: 'REQ-U', terminalId: '2841653112', amountCents: 13500, orderId: 'order-1' }),
      }),
    )
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('🚨 [Terminal-payment watchdog] UNKNOWN request auto-released'),
      expect.objectContaining({ requestId: 'REQ-U', terminalId: '2841653112' }),
    )
    expect(mockedSendOpsAlert).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining('2841653112') }))
    errSpy.mockRestore()
  })

  it('marked and grace elapsed, but a card payment appeared meanwhile → COMPLETED wins, never released', async () => {
    const returnedAt = new Date(NOW.getTime() - GRACE_MS - 60_000)
    tpr().findMany.mockResolvedValueOnce([unknownRow({ terminalReturnedAt: returnedAt })])
    terminalWithHeartbeat(new Date(NOW.getTime() - 10_000))
    prismaMock.payment.findFirst.mockResolvedValueOnce({ id: 'pay-late' })

    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    expect(summary.completed).toBe(1)
    expect(summary.released).toBe(0)
    const calls = tpr().updateMany.mock.calls.map((c: any[]) => c[0].data.status)
    expect(calls).toEqual(['COMPLETED'])
  })

  it('a release that loses the CAS (row already closed by a late result) is not counted and not alerted', async () => {
    const returnedAt = new Date(NOW.getTime() - GRACE_MS)
    tpr().findMany.mockResolvedValueOnce([unknownRow({ terminalReturnedAt: returnedAt })])
    terminalWithHeartbeat(new Date(NOW.getTime() - 10_000))
    tpr().updateMany.mockResolvedValueOnce({ count: 0 })

    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    expect(summary.released).toBe(0)
    expect(mockedLogAction).not.toHaveBeenCalled()
    expect(mockedSendOpsAlert).not.toHaveBeenCalled()
  })

  it('resolves the Terminal by serial with and without the AVQD- prefix, case-insensitive, and NOT scoped by venue (a migrated terminal must still count as back)', async () => {
    tpr().findMany.mockResolvedValueOnce([unknownRow({ terminalId: 'n860w173400' })])
    terminalWithHeartbeat(null)

    await terminalPaymentService.reconcileUnknownRequests(NOW)

    const where = prismaMock.terminal.findFirst.mock.calls[0][0].where
    expect(where).not.toHaveProperty('venueId')
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { serialNumber: { equals: 'n860w173400', mode: 'insensitive' } },
            { serialNumber: { equals: 'AVQD-n860w173400', mode: 'insensitive' } },
          ]),
        }),
      }),
    )
  })

  it('reads only UNKNOWN rows (never touches in-flight ones) with the cron-safe entry read', async () => {
    await terminalPaymentService.reconcileUnknownRequests(NOW)
    expect(tpr().findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'UNKNOWN' }) }))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// releaseUnknownRequest — the manual path (MCP / superadmin / manager on the tablet)
// ═══════════════════════════════════════════════════════════════════════════
describe('releaseUnknownRequest — a human may free the slot, but never on top of money', () => {
  const actor = { staffId: 'staff-9', source: 'MOBILE' as const }

  it('releases an UNKNOWN row with no card payment: TIMED_OUT / MANUAL_RELEASE, audited with actor and reason', async () => {
    tpr().findFirst.mockResolvedValueOnce(unknownRow())

    const r = await terminalPaymentService.releaseUnknownRequest({
      requestId: 'REQ-U',
      venueId: 'venue-1',
      actor,
      reason: 'PAX reiniciada',
    })

    expect(r).toEqual(expect.objectContaining({ released: true, status: 'TIMED_OUT' }))
    expect(tpr().findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ requestId: 'REQ-U', venueId: 'venue-1' }) }),
    )
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'row-u', venueId: 'venue-1', status: 'UNKNOWN' }),
        data: expect.objectContaining({ status: 'TIMED_OUT', failureCode: 'MANUAL_RELEASE' }),
      }),
    )
    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staff-9',
        venueId: 'venue-1',
        action: 'TERMINAL_PAYMENT_MANUAL_RELEASE',
        entityId: 'row-u',
        data: expect.objectContaining({ requestId: 'REQ-U', reason: 'PAX reiniciada', source: 'MOBILE' }),
      }),
    )
    expect(mockedSendOpsAlert).toHaveBeenCalled()
  })

  it('refuses to release when a reconcilable card payment exists → reconciles to COMPLETED instead', async () => {
    tpr().findFirst.mockResolvedValueOnce(unknownRow())
    prismaMock.payment.findFirst.mockResolvedValueOnce({ id: 'pay-late' })

    const r = await terminalPaymentService.releaseUnknownRequest({ requestId: 'REQ-U', venueId: 'venue-1', actor, reason: 'x' })

    expect(r).toEqual(expect.objectContaining({ released: false, status: 'COMPLETED', paymentId: 'pay-late' }))
    const statuses = tpr().updateMany.mock.calls.map((c: any[]) => c[0].data.status)
    expect(statuses).toEqual(['COMPLETED'])
  })

  it('payment exists but another path closed the row first (CAS count 0) → reports the fresh status, never claims its own paymentId', async () => {
    tpr()
      .findFirst.mockResolvedValueOnce(unknownRow()) // the row
      .mockResolvedValueOnce(null) // findReconcilablePayment: not claimed by another request
      .mockResolvedValueOnce({ status: 'COMPLETED', paymentId: 'pay-from-socket' }) // re-read after the lost CAS
    prismaMock.payment.findFirst.mockResolvedValueOnce({ id: 'pay-late' })
    tpr().updateMany.mockResolvedValueOnce({ count: 0 })

    const r = await terminalPaymentService.releaseUnknownRequest({ requestId: 'REQ-U', venueId: 'venue-1', actor, reason: 'x' })

    expect(r).toEqual(expect.objectContaining({ released: false, status: 'COMPLETED', paymentId: 'pay-from-socket' }))
    expect(mockedLogAction).not.toHaveBeenCalled()
  })

  it('a row that is not UNKNOWN (or belongs to another venue) is reported as-is and nothing is written', async () => {
    tpr().findFirst.mockResolvedValueOnce(unknownRow({ status: 'COMPLETED' }))
    const r = await terminalPaymentService.releaseUnknownRequest({ requestId: 'REQ-U', venueId: 'venue-1', actor, reason: 'x' })
    expect(r).toEqual(expect.objectContaining({ released: false, status: 'COMPLETED' }))
    expect(tpr().updateMany).not.toHaveBeenCalled()

    tpr().findFirst.mockResolvedValueOnce(null)
    const missing = await terminalPaymentService.releaseUnknownRequest({ requestId: 'REQ-U', venueId: 'venue-OTHER', actor, reason: 'x' })
    expect(missing).toEqual(expect.objectContaining({ released: false, status: null }))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// The busy rejection tells the cashier WHY (amount, age, sender) and, if stuck, that it self-heals
// ═══════════════════════════════════════════════════════════════════════════
describe('busy message — says why and, for an UNKNOWN blocker, that it frees itself', () => {
  const P2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })

  function primeBusy(blocker: Record<string, unknown>) {
    mockedGetTerminal.mockReturnValue({ socketId: 'sock-a', venueId: 'venue-1', terminalId: '2841653112', terminalPaymentAckVersion: 0 })
    tpr().create.mockRejectedValueOnce(P2002)
    tpr()
      .findFirst.mockResolvedValueOnce(null) // not my requestId → slot held by another
      .mockResolvedValueOnce(blocker)
  }

  it('looks the blocker up WITHIN the venue: a slot held by another venue (migrated terminal) gets the generic message, nothing leaks', async () => {
    primeBusy(null as unknown as Record<string, unknown>) // no blocker visible from this venue
    let busy: any
    try {
      await terminalPaymentService.sendPaymentToTerminal({ terminalId: '2841653112', amountCents: 5000, venueId: 'venue-1' } as any)
      throw new Error('expected TerminalBusyError')
    } catch (e) {
      busy = e
    }
    expect(busy).toBeInstanceOf(TerminalBusyError)
    expect(busy.message).toBe('La terminal 2841653112 está ocupada procesando otro cobro')
    expect(busy.details.blockingRequest.amountCents).toBeUndefined()
    // second findFirst = the blocker lookup → must carry the venue
    expect(tpr().findFirst.mock.calls[1][0].where).toEqual(expect.objectContaining({ venueId: 'venue-1', terminalId: '2841653112' }))
  })

  it('in-flight blocker: names amount, minutes and sender device', async () => {
    primeBusy({
      requestId: 'REQ-B',
      status: 'PENDING',
      amountCents: 13500,
      senderDevice: 'Sunmi D3',
      createdAt: new Date(Date.now() - 12 * 60_000),
    })
    await expect(
      terminalPaymentService.sendPaymentToTerminal({ terminalId: '2841653112', amountCents: 5000, venueId: 'venue-1' } as any),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/está ocupada.*\$135\.00.*hace 12 min.*Sunmi D3/),
      details: { blockingRequest: expect.objectContaining({ requestId: 'REQ-B', amountCents: 13500 }) },
    })
  })

  it('UNKNOWN blocker: says it never answered and will free itself when the terminal reconnects', async () => {
    primeBusy({
      requestId: 'REQ-U',
      status: 'UNKNOWN',
      amountCents: 13500,
      senderDevice: null,
      createdAt: new Date(Date.now() - 40 * 60_000),
    })
    let busy: unknown
    try {
      await terminalPaymentService.sendPaymentToTerminal({ terminalId: '2841653112', amountCents: 5000, venueId: 'venue-1' } as any)
      throw new Error('expected TerminalBusyError')
    } catch (e) {
      busy = e
    }
    expect(busy).toBeInstanceOf(TerminalBusyError)
    expect((busy as Error).message).toMatch(/sin respuesta.*hace 40 min.*se liberará sola/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Released rows are not forgotten: a late payment must still reach them (the double-charge alarm)
// ═══════════════════════════════════════════════════════════════════════════
describe('reconcileUnknownRequests — a payment landing on an already-RELEASED row reconciles it and raises the alarm', () => {
  function releasedRow(overrides: Record<string, unknown> = {}) {
    return unknownRow({ id: 'row-r', requestId: 'REQ-R', status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', ...overrides })
  }

  it('AUTO_RELEASED row + reconcilable card payment → COMPLETED (late), 🚨, audit and ops email', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    tpr().findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([releasedRow()])
    prismaMock.payment.findFirst.mockResolvedValueOnce({ id: 'pay-after-release' })

    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    expect(summary.lateReconciled).toBe(1)
    expect(tpr().findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ status: 'TIMED_OUT', failureCode: { in: ['AUTO_RELEASED', 'MANUAL_RELEASE'] } }),
      }),
    )
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'row-r', status: 'TIMED_OUT' }),
        data: expect.objectContaining({ status: 'COMPLETED', paymentId: 'pay-after-release', lateResult: true }),
      }),
    )
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('RELEASED request'), expect.objectContaining({ requestId: 'REQ-R' }))
    expect(mockedLogAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'TERMINAL_PAYMENT_LATE_RECONCILED', entityId: 'row-r' }))
    expect(mockedSendOpsAlert).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining('doble cobro') }))
    errSpy.mockRestore()
  })

  it('a released row with no payment is left alone', async () => {
    tpr().findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([releasedRow()])
    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)
    expect(summary.lateReconciled).toBe(0)
    expect(tpr().updateMany).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. REGRESSION — the stale sweep still parks UNKNOWN exactly as before
// ═══════════════════════════════════════════════════════════════════════════
describe('regression — reconcileStaleRequests keeps parking UNKNOWN and still holds the slot', () => {
  it('a stale in-flight row with no payment → UNKNOWN + TIMED_OUT failureCode (unchanged)', async () => {
    tpr().findMany.mockResolvedValueOnce([
      {
        id: 'row-s',
        requestId: 'REQ-S',
        venueId: 'venue-1',
        terminalId: 'abc',
        orderId: null,
        status: 'PENDING',
        createdAt: new Date(NOW.getTime() - 400_000),
      },
    ])
    const summary = await terminalPaymentService.reconcileStaleRequests(NOW)
    expect(summary.unknown).toBe(1)
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'UNKNOWN', failureCode: 'TIMED_OUT' }) }),
    )
  })

  it('entering UNKNOWN now also sends the ops email (the Better Stack alarm is no longer the only channel)', async () => {
    tpr().findMany.mockResolvedValueOnce([
      {
        id: 'row-s',
        requestId: 'REQ-S',
        venueId: 'venue-1',
        terminalId: 'abc',
        orderId: null,
        amountCents: 100,
        status: 'PENDING',
        createdAt: new Date(NOW.getTime() - 400_000),
      },
    ])
    await terminalPaymentService.reconcileStaleRequests(NOW)
    expect(mockedSendOpsAlert).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining('abc') }))
  })
})
