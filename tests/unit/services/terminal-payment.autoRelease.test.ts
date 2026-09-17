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

import { Prisma } from '@prisma/client'
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
  tpr().findMany.mockReset().mockResolvedValue([])
  tpr().findFirst.mockReset().mockResolvedValue(null)
  tpr().updateMany.mockReset().mockResolvedValue({ count: 1 })
  prismaMock.payment.findFirst.mockReset().mockResolvedValue(null)
  prismaMock.payment.updateMany.mockReset().mockResolvedValue({ count: 1 })
  prismaMock.terminal.findFirst.mockReset().mockResolvedValue(null)
  // Codex r2 (P2-N1): `findReconcilablePayment` enumera los vínculos de la solicitud; sin default el mock devolvía `undefined` y
  // el `.map` reventaba (la clase «mock de lista fija»: 22 pruebas cayeron por TypeError, no por lo que afirman).
  prismaMock.terminalPaymentAttemptLink.findMany.mockReset().mockResolvedValue([])
  prismaMock.$queryRaw.mockReset().mockResolvedValue([])
})

/**
 * Codex r3 (P1-N2): los barridos y la liberación manual cierran por `closeRowFromPaymentTx` dentro de `prisma.$transaction` (el mock
 * entrega el propio `prismaMock` como `tx`). Ese cierre RELEE la fila (`before`) y el Payment con su procedencia, escribe la fila con
 * CAS `paymentId: null` y ETIQUETA al Payment como ganador. Arma esas lecturas.
 */
function cierreComunCon(row: Record<string, unknown>, payment: Record<string, unknown>) {
  tpr().findFirst.mockResolvedValue(row)
  prismaMock.payment.findFirst.mockResolvedValue({
    processorData: {},
    terminalPaymentRequestId: null,
    orderId: row.orderId ?? null,
    source: 'TPV',
    amount: new Prisma.Decimal(135),
    tipAmount: new Prisma.Decimal(0),
    ...payment,
  })
}
/** La escritura del cierre común: CAS «todavía sin ganador» sobre la solicitud, y la etiqueta del ganador en el Payment. */
function cerradaPorElCierreComun(requestId: string, paymentId: string, data: Record<string, unknown> = {}) {
  expect(tpr().updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { requestId, venueId: 'venue-1', paymentId: null },
      data: expect.objectContaining({ status: 'COMPLETED', paymentId, lateResult: true, ...data }),
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

// ═══════════════════════════════════════════════════════════════════════════
// 1. reconcileUnknownRequests — the watchdog keeps asking until it can decide
// ═══════════════════════════════════════════════════════════════════════════
describe('reconcileUnknownRequests — money first: a recorded card payment always wins', () => {
  it('UNKNOWN row whose order got a reconcilable card payment → COMPLETED (late) + 🚨', async () => {
    const logger = require('@/config/logger').default
    const errSpy = jest.spyOn(logger, 'error')
    tpr().findMany.mockResolvedValueOnce([unknownRow()])
    cierreComunCon(unknownRow(), { id: 'pay-late', terminal: { serialNumber: '2841653112' } })

    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    expect(summary.completed).toBe(1)
    expect(summary.released).toBe(0)
    // Codex r3 (P1-N2): por el cierre común — CAS «sin ganador» + etiqueta del Payment — y el 🚨 propio del barrido de UNKNOWN.
    cerradaPorElCierreComun('REQ-U', 'pay-late')
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('🚨'), expect.objectContaining({ requestId: 'REQ-U' }))
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('UNKNOWN request'),
      expect.objectContaining({ requestId: 'REQ-U', paymentId: 'pay-late' }),
    )
    expect(mockedLogAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'TERMINAL_PAYMENT_LATE_RECONCILED', entityId: 'row-u' }))
    errSpy.mockRestore()
  })

  // 🔴 El importe COBRADO puede no ser el que pidió el POS (el cajero tecleó otro en la terminal,
  // la propina cambió). Esta ruta —el barrido de UNKNOWN— cerraba la fila como «pagada» SIN dejar
  // rastro: la orden quedaba saldada y la diferencia no aparecía en ningún lado. El dinero no se
  // rechaza, ya salió de la tarjeta; se cierra igual, pero MARCADO para que un humano lo concilie.
  it('un cobro por OTRO importe se cierra MARCADO como CONTRACT_MISMATCH, no como si nada', async () => {
    tpr().findMany.mockResolvedValueOnce([unknownRow()]) // pidió 13500 centavos
    cierreComunCon(unknownRow(), {
      id: 'pay-otro-importe',
      terminal: { serialNumber: '2841653112' },
      amount: new Prisma.Decimal(200), // 20000 centavos: 65 pesos de más
    })

    await terminalPaymentService.reconcileUnknownRequests(NOW)

    // Codex r3 (P1-N2): la marca la pone el cierre común (`contratoDescuadrado`), en la MISMA escritura que liga el ganador.
    cerradaPorElCierreComun('REQ-U', 'pay-otro-importe', {
      failureCode: 'CONTRACT_MISMATCH',
      resultJson: expect.objectContaining({
        reconciliationRequired: true,
        requested: expect.objectContaining({ amountCents: 13500, tipCents: 0, totalCents: 13500 }),
        reported: expect.objectContaining({ amountCents: 20000, tipCents: 0, totalCents: 20000 }),
      }),
    })
  })

  // El caso normal NO puede quedar marcado: marcar de más volvería inútil la señal.
  it('un cobro por el importe pedido se cierra SIN marca', async () => {
    tpr().findMany.mockResolvedValueOnce([unknownRow()])
    cierreComunCon(unknownRow(), { id: 'pay-cuadra', terminal: { serialNumber: '2841653112' } })

    await terminalPaymentService.reconcileUnknownRequests(NOW)

    cerradaPorElCierreComun('REQ-U', 'pay-cuadra')
    const escritura = tpr().updateMany.mock.calls.at(-1)?.[0]
    expect(escritura.data.status).toBe('COMPLETED')
    expect(escritura.data.failureCode).toBeUndefined()
    // El cierre común escribe el sobre canónico del ganador (`{requestId, status:'success', paymentId}`), sin `reconciliationRequired`.
    expect(escritura.data.resultJson).toEqual({ requestId: 'REQ-U', status: 'success', paymentId: 'pay-cuadra' })
  })

  it('the payment lookup carries the same 4 guards as the stale sweep (after the row, COMPLETED, card, not claimed by an ACCREDITED owner)', async () => {
    const row = unknownRow()
    tpr().findMany.mockResolvedValueOnce([row])
    prismaMock.payment.findFirst.mockResolvedValueOnce({
      id: 'pay-x',
      source: 'TPV',
      orderId: 'order-1',
      processorData: { terminalPaymentRequestId: row.requestId },
      terminalPaymentRequestId: 'REQ-OWNER',
      terminal: { serialNumber: '2841653112' },
      amount: new Prisma.Decimal(135),
      tipAmount: new Prisma.Decimal(0),
    })
    // Codex R13-7: ya reclamado por otra solicitud CON procedencia (la columna la acredita y se cobró en su terminal): veta.
    tpr().findMany.mockResolvedValueOnce([
      { id: 'row-other', requestId: 'REQ-OWNER', orderId: 'order-1', terminalId: '2841653112', status: 'COMPLETED' },
    ])

    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    // Codex r2 (P2-N1): la etiqueta de la solicitud es una rama del `OR` (la llave de intento sólo se suma con vínculos).
    expect(prismaMock.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orderId: 'order-1',
          venueId: 'venue-1',
          OR: [{ processorData: { path: ['terminalPaymentRequestId'], equals: row.requestId } }],
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

  // 🔴 CAMBIO DE POLÍTICA (12-sep). Estas dos pruebas fijaban «pasada la gracia NO se suelta nada»,
  // y eran correctas para esa política. La política cambió porque su consecuencia era que una
  // terminal cuya evidencia no llega NUNCA queda muerta para siempre — medido en hardware y vivido
  // por el cliente (Testarudo, 4-sep, 3 h sin poder cobrar).
  //
  // 🔑 Lo que NO cambió, y es lo que estas pruebas siguen guardando: el latido y el plazo siguen sin
  // probar que la autorización terminó. Por eso soltar libera CAPACIDAD y jamás acredita «no se
  // cobró»: la fila se queda pendiente de desenlace (su venta sigue cerrada, la sonda sigue
  // preguntando) y ningún mensaje puede insinuar que cobrar de nuevo esa venta sea seguro.
  it('pasada la gracia suelta la RANURA con su código, pero NUNCA acredita que no se cobró', async () => {
    tpr().findMany.mockResolvedValueOnce([unknownRow({ terminalReturnedAt: new Date(NOW.getTime() - GRACE_MS) })])
    terminalWithHeartbeat(NOW)
    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    expect(summary.released).toBe(1)
    // Se marca TIMED_OUT/AUTO_RELEASED: el código es lo que separa una liberación DELIBERADA (que
    // suelta la ranura) de un TIMED_OUT histórico sin explicación (que la sigue reteniendo).
    expect(tpr().updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'row-u', status: 'UNKNOWN' }),
        data: { status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' },
      }),
    )
    // 🔴 Y NO se escribe ningún código de la lista blanca: esos afirman «no hubo cobro», y el plazo
    // no demuestra eso. Si alguien mete AUTO_RELEASED en `CODIGOS_SIN_COBRO`, esto cae.
    const escritos = tpr().updateMany.mock.calls.map((c: any[]) => c[0].data?.failureCode)
    expect(
      escritos.filter((f: string) => ['TPV_NEVER_RECEIVED', 'TPV_INBOX_NOT_FOUND', 'OPERATOR_RECONCILED_NO_CHARGE'].includes(f)),
    ).toEqual([])
  })

  it('al soltar deja rastro auditable y su aviso DICE que la venta sigue protegida (nunca que sea seguro recobrar)', async () => {
    tpr().findMany.mockResolvedValueOnce([unknownRow({ terminalReturnedAt: new Date(NOW.getTime() - GRACE_MS) })])
    terminalWithHeartbeat(NOW)
    await terminalPaymentService.reconcileUnknownRequests(NOW)

    // Soltar una terminal por política es exactamente lo que un dueño audita después.
    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TERMINAL_PAYMENT_AUTO_RELEASED', entity: 'TerminalPaymentRequest' }),
    )
    expect(mockedSendOpsAlert).toHaveBeenCalled()

    // 🔴 El aviso tiene que decir las DOS cosas. Con sólo la primera, quien lo lee concluye que la
    // venta quedó libre y la cobra otra vez — que es el daño que este trabajo existe para evitar.
    const aviso = mockedSendOpsAlert.mock.calls[0][0]
    const texto = [aviso.subject, ...(aviso.lines ?? [])].join(' ')
    expect(texto).toMatch(/liberad[ao]|liberó/i) // la TERMINAL se soltó
    expect(texto).toMatch(/VENTA sigue protegida/i) // …y la VENTA no
  })

  it('marked and grace elapsed, but a card payment appeared meanwhile → COMPLETED wins, never released', async () => {
    const returnedAt = new Date(NOW.getTime() - GRACE_MS - 60_000)
    tpr().findMany.mockResolvedValueOnce([unknownRow({ terminalReturnedAt: returnedAt })])
    terminalWithHeartbeat(new Date(NOW.getTime() - 10_000))
    cierreComunCon(unknownRow({ terminalReturnedAt: returnedAt }), { id: 'pay-late', terminal: { serialNumber: '2841653112' } })

    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    expect(summary.completed).toBe(1)
    expect(summary.released).toBe(0)
    const calls = tpr().updateMany.mock.calls.map((c: any[]) => c[0].data.status)
    expect(calls).toEqual(['COMPLETED'])
    cerradaPorElCierreComun('REQ-U', 'pay-late')
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

  it('retains UNKNOWN without confirmed execution completion even when an operator requests release', async () => {
    tpr().findFirst.mockResolvedValueOnce(unknownRow())
    const result = await terminalPaymentService.releaseUnknownRequest({
      requestId: 'REQ-U',
      venueId: 'venue-1',
      actor,
      reason: 'PAX reiniciada',
    })
    expect(result).toMatchObject({ released: false, status: 'UNKNOWN' })
    expect(tpr().updateMany).not.toHaveBeenCalled()
    expect(mockedLogAction).not.toHaveBeenCalled()
  })

  it('refuses to release when a reconcilable card payment exists → reconciles to COMPLETED instead (por el cierre común, con etiqueta)', async () => {
    cierreComunCon(unknownRow(), { id: 'pay-late', terminal: { serialNumber: '2841653112' } })

    const r = await terminalPaymentService.releaseUnknownRequest({ requestId: 'REQ-U', venueId: 'venue-1', actor, reason: 'x' })

    expect(r).toEqual(expect.objectContaining({ released: false, status: 'COMPLETED', paymentId: 'pay-late' }))
    const statuses = tpr().updateMany.mock.calls.map((c: any[]) => c[0].data.status)
    expect(statuses).toEqual(['COMPLETED'])
    cerradaPorElCierreComun('REQ-U', 'pay-late')
    expect(mockedLogAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'TERMINAL_PAYMENT_LATE_RECONCILED', entityId: 'row-u' }))
  })

  it('payment exists but another path closed the row first (the common close finds it already bound to an ACCREDITED winner) → reports the fresh status, never claims its own paymentId', async () => {
    // Codex r3 (P1-N2): el cierre común relee la fila y la encuentra COMPLETED con OTRO ganador acreditado (`pay-from-socket`,
    // etiquetado y cobrado en esta terminal) ⇒ `ALREADY_BOUND`; la liberación manual relee y reporta lo que quedó.
    tpr().findFirst.mockImplementation(async ({ select }: any) =>
      select?.status && select?.paymentId && Object.keys(select).length === 2
        ? { status: 'COMPLETED', paymentId: 'pay-from-socket' } // la relectura final de `releaseUnknownRequest`
        : unknownRow({ status: 'COMPLETED', paymentId: 'pay-from-socket' }),
    )
    // La primera lectura de `releaseUnknownRequest` tiene que ver la fila UNKNOWN (si no, ni busca el Payment).
    tpr().findFirst.mockResolvedValueOnce(unknownRow())
    prismaMock.payment.findFirst.mockImplementation(async ({ where }: any) => ({
      id: where.id ?? 'pay-late',
      source: 'TPV',
      orderId: 'order-1',
      processorData: where.id === 'pay-from-socket' ? { terminalPaymentRequestId: 'REQ-U' } : {},
      terminalPaymentRequestId: where.id === 'pay-from-socket' ? 'REQ-U' : null,
      terminal: { serialNumber: '2841653112' },
      amount: new Prisma.Decimal(135),
      tipAmount: new Prisma.Decimal(0),
    }))

    const r = await terminalPaymentService.releaseUnknownRequest({ requestId: 'REQ-U', venueId: 'venue-1', actor, reason: 'x' })

    expect(r).toEqual(expect.objectContaining({ released: false, status: 'COMPLETED', paymentId: 'pay-from-socket' }))
    expect(tpr().updateMany).not.toHaveBeenCalled() // nada se reescribió: el ganador ya estaba
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
// The busy rejection explains same-venue blockers and hides other venues’ financial details
// ═══════════════════════════════════════════════════════════════════════════
describe('busy message — explains unresolved outcomes without leaking another venue', () => {
  const P2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })

  function primeBusy(blocker: Record<string, unknown>) {
    mockedGetTerminal.mockReturnValue({ socketId: 'sock-a', venueId: 'venue-1', terminalId: '2841653112', terminalPaymentAckVersion: 0 })
    tpr().create.mockRejectedValueOnce(P2002)
    tpr()
      .findFirst.mockResolvedValueOnce(null) // not my requestId → slot held by another
      .mockResolvedValueOnce(blocker)
  }

  it('reserves a physical slot across venues while hiding the foreign blocker details', async () => {
    const foreignCreatedAt = new Date('2026-09-01T12:34:56.000Z')
    primeBusy({
      venueId: 'venue-OTHER',
      requestId: 'REQ-FOREIGN-PRIVATE',
      status: 'UNKNOWN',
      amountCents: 987654,
      senderDevice: 'Private foreign cashier',
      createdAt: foreignCreatedAt,
    })
    const emit = jest.fn()
    mockedGetServer.mockReturnValue({ sockets: { sockets: new Map([['sock-a', { emit }]]) }, to: () => ({ emit }) })
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
    expect(busy.details.blockingRequest.requestId).toBe('unknown')
    expect(busy.details.blockingRequest.senderDevice).toBeUndefined()
    expect(busy.details.blockingRequest.ageSeconds).toBe(0)
    const serialized = JSON.stringify({ message: busy.message, details: busy.details })
    for (const privateValue of [
      'venue-OTHER',
      'REQ-FOREIGN-PRIVATE',
      '987654',
      'Private foreign cashier',
      foreignCreatedAt.toISOString(),
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
    // Physical admission must see reservations from any venue; only its projection is tenant-scoped.
    const blockerWhere = tpr().findFirst.mock.calls[1][0].where
    expect(blockerWhere).toEqual(expect.objectContaining({ terminalId: '2841653112' }))
    expect(blockerWhere).not.toHaveProperty('venueId')
    expect(tpr().create).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('in-flight blocker: names amount, minutes and sender device', async () => {
    primeBusy({
      venueId: 'venue-1',
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

  it('UNKNOWN blocker: tells the cashier to confirm the unresolved outcome before another charge', async () => {
    primeBusy({
      venueId: 'venue-1',
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
    expect((busy as Error).message).toMatch(/sin respuesta.*hace 40 min.*confirma el resultado/)
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
    cierreComunCon(releasedRow(), { id: 'pay-after-release', terminal: { serialNumber: '2841653112' } })

    const summary = await terminalPaymentService.reconcileUnknownRequests(NOW)

    expect(summary.lateReconciled).toBe(1)
    expect(tpr().findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ status: 'TIMED_OUT', failureCode: { in: ['AUTO_RELEASED', 'MANUAL_RELEASE'] } }),
      }),
    )
    // Codex r2/r3: por el cierre común (CAS «sin ganador» + etiqueta), no por un `updateMany` propio.
    cerradaPorElCierreComun('REQ-R', 'pay-after-release')
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

describe('Audit round1 truthful watchdog instructions', () => {
  it('never promises elapsed-time release of a financially unknown request', async () => {
    tpr().findMany.mockResolvedValueOnce([{ ...unknownRow(), status: 'PENDING', amountCents: 10000 }])
    await terminalPaymentService.reconcileStaleRequests(NOW)
    expect(mockedSendOpsAlert).toHaveBeenCalled()
    const text = mockedSendOpsAlert.mock.calls[0][0].lines.join(' ')
    expect(text).not.toMatch(/liberar[aá] solo|20 minutos/i)
    expect(text).toMatch(/confirma|concilia/i)
  })
})
