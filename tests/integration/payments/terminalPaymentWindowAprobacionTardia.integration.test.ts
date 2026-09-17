/**
 * Revisión final de la rama (17-sep) · B (Important #3, DINERO): una aprobación del banco que llega DESPUÉS de que la ventana
 * (`FAILED/NO_EVIDENCE_AFTER_WINDOW`) o el cajero (`FAILED/OPERATOR_RECONCILED_NO_CHARGE`) liberaran la solicitud, y que NO crea
 * Payment (importe distinto, el registrador revienta, el serial contradice el vínculo, colisión de referencia).
 *
 * Antes: el evento quedaba como evidencia y la solicitud seguía FAILED ⇒ el POS decía «puedes volver a cobrar» con el banco
 * habiendo aprobado, y sólo la terminal (N3 al reconsultar S6) se cercaba. Ahora la solicitud vuelve a `TIMED_OUT /
 * BANK_APPROVED_AWAITING_PAYMENT` (el marcador que la ventana ya usa): orden y ranura retenidas, UN asiento, 🚨 y correo; la
 * ranura se suelta a los 20 min como siempre y el Payment, si llega, la cierra por el cierre común. La regla es literalmente lo
 * que el veto de la ventana habría visto un segundo antes: APROBADO vinculado del MISMO venue y ningún Payment ligado.
 *
 * Contra Postgres REAL y sólo en la base desechable: el CAS con los EXISTS evaluados en la escritura y la exactitud de «una sola
 * vez» son cosas de la base, no de un mock.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { sendOpsAlert } from '@/services/alerts/opsAlert.service'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { runClaimedAngelPayEvent } from '@/services/tpv/angelpayEventWorker.service'
import { recordFastPayment, recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { UNPROVEN_NEGATIVE_WINDOW_MS, terminalPaymentService } from '@/services/terminal-payment.service'
import { utcTs } from '@/utils/sqlDates'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { crearFixture, exigirBaseDesechable, type Fixture, exigir } from './webhookCheckpoint.fixture'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

const ACCION = 'TERMINAL_PAYMENT_WINDOW_BANK_APPROVED_AWAITING_PAYMENT'
const DISTINTO = '000000009900' // $99.00 contra un contrato de $100.00
let f: Fixture
let duena: { id: string }

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('vtardia')
  duena = await prisma.staff.create({
    data: {
      email: `${f.fixture}-duena@example.test`,
      firstName: 'Dueña',
      lastName: 'Tardía',
      organizations: { create: { organizationId: f.fixture, role: 'OWNER', isPrimary: true, isActive: true } },
      venues: { create: { venueId: f.venueId, role: 'OWNER', active: true, pin: '2468' } },
    },
    select: { id: true },
  })
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(async () => {
  // Los temporizadores de la ventana que `closeRow` pudiera programar en este proceso no disparan sobre la siguiente prueba.
  const programadas = (terminalPaymentService as any).ventanasProgramadas as Map<string, NodeJS.Timeout> | undefined
  for (const t of programadas?.values() ?? []) clearTimeout(t)
  programadas?.clear()
  await f.limpiar()
})
afterAll(async () => {
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  if (duena) {
    await prisma.staffVenue.deleteMany({ where: { staffId: duena.id } })
    await prisma.staffOrganization.deleteMany({ where: { staffId: duena.id } })
    await prisma.staff.deleteMany({ where: { id: duena.id } })
  }
  await f.destruir()
})

const fila = (requestId: string) => exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))
const pagos = () => prisma.payment.findMany({ where: { venueId: f.venueId } })
const asientos = (entityId: string, action = ACCION) => prisma.activityLog.findMany({ where: { venueId: f.venueId, action, entityId } })
const gritosDeRetencion = () =>
  (logger.error as jest.Mock).mock.calls.filter(c => String(c[0]).includes('🚨') && String(c[0]).includes('held again'))
const merchant = () => ({ id: f.merchantId, externalMerchantId: f.merchantExternalId })

async function webhook(attemptId: string, over: Record<string, unknown> = {}, receptor = merchant()) {
  const eventId = f.nuevoEventId()
  const result = await processAngelPayWebhook({
    payload: f.eventoAngelPay(attemptId, over),
    eventId,
    merchantAccount: receptor,
    retryDelaysMs: [0],
  })
  return { result, evento: await exigir(prisma.providerEventLog.findFirst({ where: { eventId: `angelpay-${eventId}` } })) }
}

/** El worker S4 procesa ESTE evento (reclamo propio, sin barrer los de otras suites de la misma base). */
async function comoWorker(eventLogId: string) {
  const claimToken = randomUUID()
  const leaseUntil = new Date(Date.now() + 120_000)
  const ev = await prisma.providerEventLog.update({
    where: { id: eventLogId },
    data: { claimToken, leaseUntil, attempts: { increment: 1 } },
  })
  return runClaimedAngelPayEvent({
    id: ev.id,
    eventId: ev.eventId ?? '',
    payload: ev.payload,
    venueId: ev.venueId,
    attempts: ev.attempts,
    claimToken,
    leaseUntil,
  })
}

/** Una solicitud de la VENTANA (negativo de la terminal sin evidencia) con su intento vinculado, lista para liberarse. */
async function enLaVentana(opciones: { conOrden?: boolean } = {}) {
  const venta = opciones.conOrden === false ? null : await f.nuevaVenta(100)
  const solicitud = await f.solicitud({
    orderId: venta?.id ?? null,
    status: 'TIMED_OUT',
    failureCode: null,
    expiresAt: new Date(Date.now() - 60_000),
    resultJson: {
      requestId: 'x',
      status: 'timeout',
      errorMessage: 'El resultado del cobro sigue pendiente de confirmar',
      terminalResult: { status: 'failed', errorMessage: 'SDK U100: Operacion cancelada por el usuario', outcomeEvidence: null },
    },
  })
  await prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "updatedAt" = ${utcTs(
    new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000),
  )} WHERE "id" = ${solicitud.id}`
  return { solicitud, venta }
}

const vincular = async (requestId: string, attemptId = randomUUID()) => {
  await prisma.terminalPaymentAttemptLink.create({
    data: { attemptId, requestId, venueId: f.venueId, terminalId: f.llaveTerminal },
  })
  return attemptId
}

/** La ventana libera (sin webhook todavía): FAILED/NO_EVIDENCE_AFTER_WINDOW, orden y ranura libres. */
async function liberadaPorLaVentana(opciones: { conOrden?: boolean } = {}) {
  const { solicitud, venta } = await enLaVentana(opciones)
  const attemptId = await vincular(solicitud.requestId)
  expect(await terminalPaymentService.releaseUnprovenNegative(solicitud.requestId, f.venueId, 'WATCHDOG')).toBe('RELEASED')
  expect(await fila(solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW', paymentId: null })
  expect(await terminalPaymentService.isTerminalBusy(f.llaveTerminal, f.venueId)).toBe(false)
  if (venta) expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, venta.id)).toBe(false)
  return { solicitud, venta, attemptId }
}

/** Lo que tiene que quedar tras re-retener: TIMED_OUT/BANK_APPROVED_AWAITING_PAYMENT, orden y ranura retenidas, sin dinero. */
async function retenida(requestId: string, ventaId: string | null, previousFailureCode: string, motivo: string) {
  const r = await fila(requestId)
  expect(r).toMatchObject({ status: 'TIMED_OUT', failureCode: 'BANK_APPROVED_AWAITING_PAYMENT', paymentId: null })
  expect(r.resultJson).toMatchObject({
    status: 'timeout',
    outcomeEvidence: null,
    bankApprovedAfterRelease: { reason: motivo, previousFailureCode },
  })
  expect(await terminalPaymentService.isTerminalBusy(f.llaveTerminal, f.venueId)).toBe(true)
  if (ventaId) expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, ventaId)).toBe(true)
  // El POS lo ve indeterminado (TIMED_OUT, UNRESOLVED): ya no «puedes volver a cobrar».
  expect(await terminalPaymentService.getPaymentStatus(requestId, f.venueId)).toMatchObject({
    status: 'TIMED_OUT',
    outcome: 'UNRESOLVED',
    failureCode: 'BANK_APPROVED_AWAITING_PAYMENT',
  })
  const log = await asientos(r.id)
  expect(log).toHaveLength(1)
  expect(log[0].data).toMatchObject({ requestId, previousFailureCode, reason: motivo })
  return r
}

describe('Revisión final · B: la aprobación tardía que NO crea dinero re-retiene la solicitud liberada', () => {
  it('ventana liberó ⇒ webhook APROBADO con importe DISTINTO (misma integratorReference): TIMED_OUT/BANK_APPROVED_AWAITING_PAYMENT, ranura y orden retenidas, sin Payment, UN asiento aunque se repita y aunque lo reprocese el worker', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const primero = await webhook(attemptId, { amount: DISTINTO })
    expect(primero.result).toMatchObject({ action: 'ORPHANED', errorReason: 'AMOUNT_MISMATCH' })
    expect(primero.evento).toMatchObject({ status: 'PENDING', errorReason: 'AMOUNT_MISMATCH', paymentId: null })
    const r = await retenida(solicitud.requestId, venta!.id, 'NO_EVIDENCE_AFTER_WINDOW', 'AMOUNT_MISMATCH')
    // La liberación sigue escrita (historia) y la retención dice qué evento la motivó.
    expect(r.resultJson).toMatchObject({
      releasedAfterWindow: { windowMs: UNPROVEN_NEGATIVE_WINDOW_MS },
      bankApprovedAfterRelease: { eventLogId: primero.evento.id, attemptId, otherCardPaymentsOnOrderAfterRelease: 0 },
    })
    expect(await pagos()).toEqual([])
    expect(gritosDeRetencion()).toHaveLength(1)
    expect(sendOpsAlert).toHaveBeenCalledTimes(1)
    expect(sendOpsAlert).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining(f.llaveTerminal) }))

    // Se repite (otro eventId del MISMO intento) y el worker reprocesa los dos: nada se vuelve a escribir.
    const segundo = await webhook(attemptId, { amount: DISTINTO })
    expect(segundo.result).toMatchObject({ action: 'ORPHANED', errorReason: 'AMOUNT_MISMATCH' })
    expect(await comoWorker(primero.evento.id)).toBe('PENDING')
    expect(await comoWorker(segundo.evento.id)).toBe('PENDING')
    expect(await asientos(r.id)).toHaveLength(1)
    expect(sendOpsAlert).toHaveBeenCalledTimes(1)
    expect((await fila(solicitud.requestId)).updatedAt.getTime()).toBe(r.updatedAt.getTime())
    expect(await pagos()).toEqual([])
  })

  it('el cajero DECLARÓ «no se presentó tarjeta» ⇒ el mismo webhook con importe distinto la re-retiene; la declaración se conserva', async () => {
    const { solicitud, venta } = await enLaVentana()
    const attemptId = await vincular(solicitud.requestId)
    const { resolveNoInstrument } = await import('@/services/tpv/no-instrument-resolution.service')
    const declaracion = await resolveNoInstrument(
      { venueId: f.venueId, terminalSerial: f.serial, attemptId, actorStaffId: duena.id },
      { requestId: solicitud.requestId, resolutionId: randomUUID(), statement: 'NO_INSTRUMENT_PRESENTED', statementVersion: 1 },
    )
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, venta!.id)).toBe(false)

    const { result } = await webhook(attemptId, { amount: DISTINTO })
    expect(result).toMatchObject({ action: 'ORPHANED', errorReason: 'AMOUNT_MISMATCH' })
    const r = await retenida(solicitud.requestId, venta!.id, 'OPERATOR_RECONCILED_NO_CHARGE', 'AMOUNT_MISMATCH')
    // El testimonio del cajero sobrevive: en el sobre (fusión) y, inmutable, en el vínculo.
    expect(r.resultJson).toMatchObject({ operatorResolution: { id: declaracion.resolution.id } })
    const link = await exigir(prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId } }))
    expect(link.operatorResolution).toMatchObject({ id: declaracion.resolution.id, staffId: duena.id })
    expect(await pagos()).toEqual([])
    // El banco repite el aviso: la fila ya no está liberada — ni otro asiento ni otro correo, y la retención no se mueve.
    const repetido = await webhook(attemptId, { amount: DISTINTO })
    expect(repetido.result).toMatchObject({ action: 'ORPHANED', errorReason: 'AMOUNT_MISMATCH' })
    expect(await asientos(r.id)).toHaveLength(1)
    expect(sendOpsAlert).toHaveBeenCalledTimes(1)
    expect((await fila(solicitud.requestId)).updatedAt.getTime()).toBe(r.updatedAt.getTime())
  })

  it('control: la aprobación tardía con el importe IGUAL sigue el camino normal — el webhook crea el Payment y reabre la fila a COMPLETED, sin retención', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const { result } = await webhook(attemptId)
    expect(result).toMatchObject({ action: 'CONFIRMED' })
    const [pago] = await pagos()
    expect(pago).toMatchObject({ status: 'COMPLETED', idempotencyKey: attemptId, orderId: venta!.id })
    const r = await fila(solicitud.requestId)
    expect(r).toMatchObject({ status: 'COMPLETED', paymentId: pago.id, closedVia: 'webhook', lateResult: true })
    expect(await asientos(r.id)).toEqual([])
    expect(await asientos(r.id, 'TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW')).toHaveLength(1)
    expect(gritosDeRetencion()).toEqual([])
  })

  it('LINK_TERMINAL_MISMATCH (el webhook dice que se cobró en OTRA terminal) sobre una liberada ⇒ también la re-retiene; el evento queda ERROR como siempre', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const { result, evento } = await webhook(attemptId, { terminalSerial: 'N86OTRA00001' })
    expect(result).toMatchObject({ action: 'ERROR', errorReason: 'LINK_TERMINAL_MISMATCH' })
    expect(evento).toMatchObject({ status: 'ERROR', errorReason: 'LINK_TERMINAL_MISMATCH', paymentId: null })
    await retenida(solicitud.requestId, venta!.id, 'NO_EVIDENCE_AFTER_WINDOW', 'LINK_TERMINAL_MISMATCH')
    expect(await pagos()).toEqual([])
  })

  it('PROCESSING_ERROR (el registrador revienta DENTRO de su transacción) sobre una liberada ⇒ la re-retiene; el evento queda PENDING para el worker', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    // El corte ocurre DESPUÉS de crear el Payment, dentro de la transacción del registrador (el patrón de la suite del worker):
    // el rollback es real, así que no queda dinero y el webhook contesta PROCESSING_ERROR.
    const corte = jest.spyOn(terminalPaymentService, 'closeRowFromPaymentTx').mockImplementationOnce(async () => {
      throw new Error('corte simulado dentro de la transacción del registrador')
    })
    try {
      const { result, evento } = await webhook(attemptId)
      expect(result).toMatchObject({ action: 'ERROR', errorReason: 'PROCESSING_ERROR' })
      expect(evento).toMatchObject({ status: 'PENDING', errorReason: 'PROCESSING_ERROR', paymentId: null })
      expect(corte).toHaveBeenCalledTimes(1)
    } finally {
      corte.mockRestore()
    }
    await retenida(solicitud.requestId, venta!.id, 'NO_EVIDENCE_AFTER_WINDOW', 'PROCESSING_ERROR')
    expect(await pagos()).toEqual([])
  })

  it('POSSIBLE_REFERENCE_COLLISION (evidencia PENDING, no un cobro) sobre una liberada ⇒ la re-retiene; el evento queda PROCESSED sobre la evidencia', async () => {
    const { solicitud } = await liberadaPorLaVentana({ conOrden: false })
    const R = `${Date.now()}`
    const pagoB = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, auth: 'AUTH-B' }),
      f.staffId,
    )
    const K1 = randomUUID()
    const evidencia = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: K1, ref: R, auth: 'AUTH-K1', requestId: solicitud.requestId }),
      f.staffId,
    )
    expect(evidencia.status).toBe('PENDING')
    await vincular(solicitud.requestId, K1)
    const { result, evento } = await webhook(K1, { transactionId: R })
    expect(result).toMatchObject({ action: 'REFERENCE_COLLISION', paymentId: evidencia.id })
    expect(evento).toMatchObject({ status: 'PROCESSED', errorReason: 'POSSIBLE_REFERENCE_COLLISION', paymentId: evidencia.id })
    await retenida(solicitud.requestId, null, 'NO_EVIDENCE_AFTER_WINDOW', 'POSSIBLE_REFERENCE_COLLISION')
    expect((await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))).status).toBe('COMPLETED')
  })

  it('LINK_VENUE_MISMATCH (vínculo de OTRO venue) NO toca la solicitud ajena: sigue liberada', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const otroOrg = `${f.fixture}-otro`
    await prisma.organization.create({ data: { id: otroOrg, name: otroOrg, email: `${otroOrg}@example.test`, phone: '5500000003' } })
    await prisma.venue.create({ data: { id: otroOrg, organizationId: otroOrg, name: otroOrg, slug: otroOrg } })
    const provider = await exigir(prisma.paymentProvider.findUnique({ where: { code: 'ANGELPAY' } }))
    const login = await prisma.angelPayUserAccount.create({
      data: { venueId: otroOrg, email: `${otroOrg}@angelpay.test`, environment: 'QA', status: 'ACTIVE' },
    })
    const ajeno = await prisma.merchantAccount.create({
      data: { providerId: provider.id, externalMerchantId: `${otroOrg}-m`, credentialsEncrypted: {}, angelpayUserAccountId: login.id },
    })
    try {
      const { result } = await webhook(attemptId, { amount: DISTINTO }, { id: ajeno.id, externalMerchantId: ajeno.externalMerchantId })
      expect(result).toMatchObject({ action: 'ERROR', errorReason: 'LINK_VENUE_MISMATCH' })
      expect(await fila(solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
      expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, venta!.id)).toBe(false)
      expect(await asientos((await fila(solicitud.requestId)).id)).toEqual([])
    } finally {
      await prisma.providerEventLog.deleteMany({ where: { venueId: otroOrg } })
      await prisma.merchantAccount.deleteMany({ where: { id: ajeno.id } })
      await prisma.angelPayUserAccount.deleteMany({ where: { id: login.id } })
      await prisma.venue.deleteMany({ where: { id: otroOrg } })
      await prisma.organization.deleteMany({ where: { id: otroOrg } })
    }
  })

  it('retenida ⇒ a los 20 min se suelta SÓLO la ranura (AUTO_RELEASED, destrabe de siempre) y la orden sigue bloqueada; el Payment de la terminal la cierra después (CONTRACT_MISMATCH)', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    await webhook(attemptId, { amount: DISTINTO })
    const r = await retenida(solicitud.requestId, venta!.id, 'NO_EVIDENCE_AFTER_WINDOW', 'AMOUNT_MISMATCH')
    await prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "updatedAt" = ${utcTs(new Date(Date.now() - 21 * 60_000))} WHERE "id" = ${r.id}`
    await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
    expect(await terminalPaymentService.isTerminalBusy(f.llaveTerminal, f.venueId)).toBe(false)
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, venta!.id)).toBe(true)
    // La terminal registra por REST lo que el banco de verdad cobró ($99): el cierre común la cierra, marcada para conciliar.
    const pago = await recordOrderPayment(
      f.venueId,
      venta!.id,
      f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId, amount: 9900 }),
      f.staffId,
    )
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id, failureCode: 'CONTRACT_MISMATCH' })
    expect(await asientos(r.id)).toHaveLength(1)
  })
})

describe('Revisión final · B: el CAS decide con lo que el veto de la ventana vería (llamada directa, Postgres real)', () => {
  const entrada = (requestId: string, attemptId: string, eventLogId = 'evt-directo') => ({
    requestId,
    venueId: f.venueId,
    attemptId,
    eventLogId,
    motivo: 'AMOUNT_MISMATCH' as const,
  })
  const eventoDelIntento = (attemptId: string, over: Record<string, unknown> = {}, venueId = f.venueId) =>
    prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        eventId: `angelpay-${f.nuevoEventId()}`,
        type: 'send_transaction',
        payload: f.eventoAngelPay(attemptId, over) as never,
        venueId,
        status: 'PENDING',
        errorReason: 'AMOUNT_MISMATCH',
        attemptId,
      },
    })

  it('sin ningún APROBADO del intento (nada, o sólo un RECHAZADO) ⇒ NOT_APPLICABLE: la solicitud sigue liberada', async () => {
    const { solicitud, attemptId } = await liberadaPorLaVentana()
    expect(await terminalPaymentService.retenerSolicitudLiberadaPorAprobacion(entrada(solicitud.requestId, attemptId))).toBe(
      'NOT_APPLICABLE',
    )
    await eventoDelIntento(attemptId, { status: 'declined' })
    expect(await terminalPaymentService.retenerSolicitudLiberadaPorAprobacion(entrada(solicitud.requestId, attemptId))).toBe(
      'NOT_APPLICABLE',
    )
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
  })

  it('un APROBADO registrado con OTRO venue no cuenta (el veto es del venue de la solicitud) ⇒ NOT_APPLICABLE', async () => {
    const { solicitud, attemptId } = await liberadaPorLaVentana()
    // Un venue REAL distinto (antes esta prueba sembraba `venueId: null`, que es el caso de abajo, no éste).
    const otroVenue = `${f.fixture}-otro-venue`
    await prisma.organization.create({ data: { id: otroVenue, name: otroVenue, email: `${otroVenue}@example.test`, phone: '5500000004' } })
    await prisma.venue.create({ data: { id: otroVenue, organizationId: otroVenue, name: otroVenue, slug: otroVenue } })
    try {
      await eventoDelIntento(attemptId, {}, otroVenue)
      expect(await terminalPaymentService.retenerSolicitudLiberadaPorAprobacion(entrada(solicitud.requestId, attemptId))).toBe(
        'NOT_APPLICABLE',
      )
      expect(await fila(solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
    } finally {
      await prisma.providerEventLog.deleteMany({ where: { venueId: otroVenue } })
      await prisma.venue.deleteMany({ where: { id: otroVenue } })
      await prisma.organization.deleteMany({ where: { id: otroVenue } })
    }
  })

  it('un APROBADO registrado SIN venue (NULL) tampoco cuenta ⇒ NOT_APPLICABLE', async () => {
    const { solicitud, attemptId } = await liberadaPorLaVentana()
    await eventoDelIntento(attemptId, {}, null as unknown as string)
    expect(await terminalPaymentService.retenerSolicitudLiberadaPorAprobacion(entrada(solicitud.requestId, attemptId))).toBe(
      'NOT_APPLICABLE',
    )
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
  })

  it('ronda 2 · el hermano con un Payment COMPLETED ligado: la regla de la aprobación NO aplica, la del cobro sin ligar SÍ la re-retiene', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    await eventoDelIntento(attemptId)
    const terminal = await exigir(prisma.terminal.findFirst({ where: { venueId: f.venueId } }))
    const pago = await prisma.payment.create({
      data: {
        venueId: f.venueId,
        orderId: venta!.id,
        source: 'TPV',
        terminalId: terminal.id,
        amount: 99,
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 99,
        idempotencyKey: attemptId,
      },
    })
    expect(await terminalPaymentService.retenerSolicitudLiberadaPorAprobacion(entrada(solicitud.requestId, attemptId))).toBe(
      'NOT_APPLICABLE',
    )
    expect(
      await terminalPaymentService.retenerSolicitudLiberadaPorPagoSinLigar({
        requestId: solicitud.requestId,
        venueId: f.venueId,
        paymentId: pago.id,
        origen: 'REST',
      }),
    ).toBe('HELD')
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW' })
    expect(await asientos((await fila(solicitud.requestId)).id)).toEqual([])
    expect(await asientos((await fila(solicitud.requestId)).id, 'TERMINAL_PAYMENT_UNBOUND_PAYMENT_AFTER_RELEASE')).toHaveLength(1)
  })

  it('con un Payment COMPLETED ligado a la solicitud (aunque no se haya podido ligar) ⇒ NOT_APPLICABLE: ya hay dinero registrado', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    await eventoDelIntento(attemptId)
    const terminal = await exigir(prisma.terminal.findFirst({ where: { venueId: f.venueId } }))
    await prisma.payment.create({
      data: {
        venueId: f.venueId,
        orderId: venta!.id,
        source: 'TPV',
        terminalId: terminal.id,
        amount: 99,
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 99,
        idempotencyKey: attemptId,
      },
    })
    expect(await terminalPaymentService.retenerSolicitudLiberadaPorAprobacion(entrada(solicitud.requestId, attemptId))).toBe(
      'NOT_APPLICABLE',
    )
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
  })

  it('con el APROBADO del intento y sin Payment ⇒ HELD una vez; la segunda llamada es NOT_APPLICABLE (la fila ya no está liberada)', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const evento = await eventoDelIntento(attemptId)
    expect(await terminalPaymentService.retenerSolicitudLiberadaPorAprobacion(entrada(solicitud.requestId, attemptId, evento.id))).toBe(
      'HELD',
    )
    await retenida(solicitud.requestId, venta!.id, 'NO_EVIDENCE_AFTER_WINDOW', 'AMOUNT_MISMATCH')
    expect(await terminalPaymentService.retenerSolicitudLiberadaPorAprobacion(entrada(solicitud.requestId, attemptId, evento.id))).toBe(
      'NOT_APPLICABLE',
    )
    expect(await asientos((await fila(solicitud.requestId)).id)).toHaveLength(1)
  })

  it('una solicitud todavía EN la ventana (TIMED_OUT sin código) no es asunto de esta regla: NOT_APPLICABLE (la ventana la retendrá por su veto)', async () => {
    const { solicitud } = await enLaVentana()
    const attemptId = await vincular(solicitud.requestId)
    await eventoDelIntento(attemptId)
    expect(await terminalPaymentService.retenerSolicitudLiberadaPorAprobacion(entrada(solicitud.requestId, attemptId))).toBe(
      'NOT_APPLICABLE',
    )
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: null })
    expect(await terminalPaymentService.releaseUnprovenNegative(solicitud.requestId, f.venueId, 'WATCHDOG')).toBe('HELD_BY_BANK_EVIDENCE')
  })
})
