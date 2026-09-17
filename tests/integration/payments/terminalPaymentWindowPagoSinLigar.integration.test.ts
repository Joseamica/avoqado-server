/**
 * Revisión final · ronda 2 (17-sep) · P1 (DINERO, preexistente — Codex r7): un Payment COMPLETED con tarjeta DEL INTENTO que llega
 * DESPUÉS de que la ventana (`FAILED/NO_EVIDENCE_AFTER_WINDOW`) o el cajero (`FAILED/OPERATOR_RECONCILED_NO_CHARGE`) liberaran la
 * solicitud, y que el cierre común NO puede ligar (atribuido a otra terminal, contradicción en la consolidación, token ajeno).
 *
 * Antes: el Payment quedaba registrado con la llave del intento (o la etiqueta, o el puntero) y la solicitud seguía FAILED ⇒ el POS
 * decía «puedes volver a cobrar» con un cobro con tarjeta encima. La guarda G1 de la ventana retiene ese caso ANTES de liberar
 * (`PAYMENT_UNBOUND_AWAITING_REVIEW`); DESPUÉS de liberar nadie lo hacía. Ahora vuelve a `TIMED_OUT / PAYMENT_UNBOUND_AWAITING_REVIEW`:
 * orden y ranura retenidas, UN asiento, 🚨 y correo; la ranura se suelta a los 20 min como siempre y un cierre posterior que SÍ
 * pueda ligar la cierra por el cierre común.
 *
 * Hermano: la aprobación tardía tras una DECLARACIÓN del cajero tiene la misma detección que la ventana (conteo, asiento
 * `TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW`, correo) — antes sólo el 🚨 genérico.
 *
 * Contra Postgres REAL y sólo en la base desechable: el CAS con el EXISTS evaluado en la escritura, la atribución física del cierre
 * común y «una sola vez» son cosas de la base, no de un mock.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { sendOpsAlert } from '@/services/alerts/opsAlert.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { runClaimedAngelPayEvent } from '@/services/tpv/angelpayEventWorker.service'
import { recordFastPayment, recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { resolveNoInstrument } from '@/services/tpv/no-instrument-resolution.service'
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

const ACCION = 'TERMINAL_PAYMENT_UNBOUND_PAYMENT_AFTER_RELEASE'
const TARDIA = 'TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW'
let f: Fixture
let duena: { id: string }
let otra: { id: string; serialNumber: string }

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('vsinligar')
  duena = await prisma.staff.create({
    data: {
      email: `${f.fixture}-duena@example.test`,
      firstName: 'Dueña',
      lastName: 'SinLigar',
      organizations: { create: { organizationId: f.fixture, role: 'OWNER', isPrimary: true, isActive: true } },
      venues: { create: { venueId: f.venueId, role: 'OWNER', active: true, pin: '1357' } },
    },
    select: { id: true },
  })
  // Una SEGUNDA terminal del mismo negocio: un cobro atribuido a ella no puede cerrar una solicitud de la primera.
  otra = await prisma.terminal.create({
    data: {
      venueId: f.venueId,
      name: 'N86 ajena',
      serialNumber: `AVQD-N86${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
      type: 'TPV_ANDROID',
    },
    select: { id: true, serialNumber: true },
  })
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(async () => {
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
const asientos = (entityId: string, action = ACCION) => prisma.activityLog.findMany({ where: { venueId: f.venueId, action, entityId } })
const gritos = () =>
  (logger.error as jest.Mock).mock.calls.filter(c => String(c[0]).includes('🚨') && String(c[0]).includes('held for review'))
const correosSinLigar = () => (sendOpsAlert as jest.Mock).mock.calls.filter(c => String(c[0]?.subject).includes('sin ligar'))
const correosTardios = () => (sendOpsAlert as jest.Mock).mock.calls.filter(c => String(c[0]?.subject).includes('Cobro aprobado tarde'))
const merchant = () => ({ id: f.merchantId, externalMerchantId: f.merchantExternalId })
const terminalPrincipal = () => exigir(prisma.terminal.findFirst({ where: { venueId: f.venueId, serialNumber: f.serial } }))

async function webhook(attemptId: string, over: Record<string, unknown> = {}) {
  const eventId = f.nuevoEventId()
  const result = await processAngelPayWebhook({
    payload: f.eventoAngelPay(attemptId, over),
    eventId,
    merchantAccount: merchant(),
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
  const attemptId = randomUUID()
  await prisma.terminalPaymentAttemptLink.create({
    data: { attemptId, requestId: solicitud.requestId, venueId: f.venueId, terminalId: f.llaveTerminal },
  })
  return { solicitud, venta, attemptId }
}

/** La ventana libera (sin dinero todavía): FAILED/NO_EVIDENCE_AFTER_WINDOW, orden y ranura libres. */
async function liberadaPorLaVentana(opciones: { conOrden?: boolean } = {}) {
  const r = await enLaVentana(opciones)
  expect(await terminalPaymentService.releaseUnprovenNegative(r.solicitud.requestId, f.venueId, 'WATCHDOG')).toBe('RELEASED')
  expect(await fila(r.solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW', paymentId: null })
  expect(await terminalPaymentService.isTerminalBusy(f.llaveTerminal, f.venueId)).toBe(false)
  if (r.venta) expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, r.venta.id)).toBe(false)
  return r
}

/** El cajero declara «no se presentó tarjeta»: FAILED/OPERATOR_RECONCILED_NO_CHARGE, orden y ranura libres. */
async function declaradaPorElCajero() {
  const r = await enLaVentana()
  const declaracion = await resolveNoInstrument(
    { venueId: f.venueId, terminalSerial: f.serial, attemptId: r.attemptId, actorStaffId: duena.id },
    { requestId: r.solicitud.requestId, resolutionId: randomUUID(), statement: 'NO_INSTRUMENT_PRESENTED', statementVersion: 1 },
  )
  expect(await fila(r.solicitud.requestId)).toMatchObject({
    status: 'FAILED',
    failureCode: 'OPERATOR_RECONCILED_NO_CHARGE',
    paymentId: null,
  })
  expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, r.venta!.id)).toBe(false)
  return { ...r, declaracion }
}

/**
 * Un cobro con tarjeta COMPLETED del intento escrito SIN pasar por el registrador (un escritor anterior a este cambio): la llave
 * del intento lo liga a la solicitud. `terminalId` decide a qué aparato está atribuido.
 */
async function pagoDelIntentoSinRegistrador(args: {
  attemptId?: string
  orderId: string | null
  terminalId: string
  amount?: number
  etiqueta?: string
}) {
  return prisma.payment.create({
    data: {
      venueId: f.venueId,
      orderId: args.orderId as string,
      source: 'TPV',
      terminalId: args.terminalId,
      amount: args.amount ?? 100,
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: args.amount ?? 100,
      ...(args.attemptId ? { idempotencyKey: args.attemptId } : {}),
      ...(args.etiqueta ? { processorData: { terminalPaymentRequestId: args.etiqueta } } : {}),
    },
  })
}

/** Lo que tiene que quedar tras re-retener: TIMED_OUT/PAYMENT_UNBOUND_AWAITING_REVIEW, orden y ranura retenidas, UN asiento, 🚨 y correo. */
async function retenidaSinLigar(requestId: string, ventaId: string | null, previousFailureCode: string, origen: string, paymentId: string) {
  const r = await fila(requestId)
  expect(r).toMatchObject({ status: 'TIMED_OUT', failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW', paymentId: null })
  expect(r.resultJson).toMatchObject({
    status: 'timeout',
    outcomeEvidence: null,
    unboundPaymentAfterRelease: { previousFailureCode, origen, paymentIds: expect.arrayContaining([paymentId]) },
  })
  // Ya no dice «puedes volver a cobrar».
  expect(String((r.resultJson as Record<string, unknown>).errorMessage)).not.toMatch(/volver a cobrar\./)
  expect(await terminalPaymentService.isTerminalBusy(f.llaveTerminal, f.venueId)).toBe(true)
  if (ventaId) expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, ventaId)).toBe(true)
  expect(await terminalPaymentService.getPaymentStatus(requestId, f.venueId)).toMatchObject({
    status: 'TIMED_OUT',
    outcome: 'UNRESOLVED',
    failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW',
  })
  const log = await asientos(r.id)
  expect(log).toHaveLength(1)
  expect(log[0].data).toMatchObject({ requestId, previousFailureCode, origen, paymentIds: expect.arrayContaining([paymentId]) })
  expect(gritos()).toHaveLength(1)
  expect(correosSinLigar()).toHaveLength(1)
  expect(correosSinLigar()[0][0]).toMatchObject({
    subject: expect.stringContaining(f.llaveTerminal),
    lines: expect.arrayContaining([expect.stringContaining(requestId)]),
  })
  return r
}

describe('Ronda 2 · P1: un cobro del intento que no se puede ligar tras liberar re-retiene la solicitud', () => {
  it('(a) REST: la terminal registra su cobro y el cierre común NO lo liga (atribuido a OTRA terminal) ⇒ TIMED_OUT/PAYMENT_UNBOUND_AWAITING_REVIEW, UN asiento + 🚨 + correo aunque repita el registro', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const registro = {
      ...f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId }),
      deviceSerialNumber: otra.serialNumber,
    }
    const pago = await recordOrderPayment(f.venueId, venta!.id, registro, f.staffId)
    expect(pago).toMatchObject({ status: 'COMPLETED', idempotencyKey: attemptId, terminalId: otra.id })
    const r = await retenidaSinLigar(solicitud.requestId, venta!.id, 'NO_EVIDENCE_AFTER_WINDOW', 'REST', pago.id)
    // La liberación sigue escrita (historia).
    expect(r.resultJson).toMatchObject({ releasedAfterWindow: { windowMs: UNPROVEN_NEGATIVE_WINDOW_MS } })

    // La terminal repite el registro (idempotente por la llave): el cierre sigue sin poder ligar y nada se vuelve a escribir.
    const repetido = await recordOrderPayment(f.venueId, venta!.id, registro, f.staffId)
    expect(repetido.id).toBe(pago.id)
    expect(await asientos(r.id)).toHaveLength(1)
    expect(gritos()).toHaveLength(1)
    expect(correosSinLigar()).toHaveLength(1)
    expect((await fila(solicitud.requestId)).updatedAt.getTime()).toBe(r.updatedAt.getTime())
  })

  it('(a) REST · asociación inválida (el token es de OTRA terminal): el cobro se registra normal, sin ligar, y la solicitud liberada se re-retiene igual', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const pago = await recordOrderPayment(
      f.venueId,
      venta!.id,
      f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId, serialAutenticado: otra.serialNumber }),
      f.staffId,
    )
    expect(pago).toMatchObject({ status: 'COMPLETED', idempotencyKey: attemptId })
    await retenidaSinLigar(solicitud.requestId, venta!.id, 'NO_EVIDENCE_AFTER_WINDOW', 'REST', pago.id)
  })

  it('(a) REST · venta rápida (solicitud sin orden): la misma re-retención', async () => {
    const { solicitud, attemptId } = await liberadaPorLaVentana({ conOrden: false })
    const pago = await recordFastPayment(
      f.venueId,
      { ...f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId }), deviceSerialNumber: otra.serialNumber },
      f.staffId,
    )
    expect(pago).toMatchObject({ status: 'COMPLETED', idempotencyKey: attemptId })
    await retenidaSinLigar(solicitud.requestId, null, 'NO_EVIDENCE_AFTER_WINDOW', 'REST', pago.id)
  })

  it('(a) REST · contradicción en la consolidación: el cobro del intento ya estaba registrado y la terminal lo repite con OTRO importe ⇒ no se liga y la solicitud se re-retiene', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const previo = await pagoDelIntentoSinRegistrador({ attemptId, orderId: venta!.id, terminalId: (await terminalPrincipal()).id })
    const devuelto = await recordOrderPayment(
      f.venueId,
      venta!.id,
      f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId, amount: 9900 }),
      f.staffId,
    )
    expect(devuelto.id).toBe(previo.id)
    // La bitácora de la contradicción va por `logAction` (mockeado en la integración): se comprueba la llamada.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TERMINAL_PAYMENT_ENRICHMENT_CONTRADICTION', entityId: previo.id }),
    )
    await retenidaSinLigar(solicitud.requestId, venta!.id, 'NO_EVIDENCE_AFTER_WINDOW', 'REST', previo.id)
  })

  it('(b) WEBHOOK: MATCHED sin ser el primer confirmador (el cobro del intento ya existía y no se puede ligar) ⇒ se re-retiene; UN asiento aunque el banco repita el aviso y el worker lo reprocese', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const previo = await pagoDelIntentoSinRegistrador({ attemptId, orderId: venta!.id, terminalId: otra.id })
    const primero = await webhook(attemptId)
    expect(primero.result).toMatchObject({ action: 'MATCHED', paymentId: previo.id })
    const r = await retenidaSinLigar(solicitud.requestId, venta!.id, 'NO_EVIDENCE_AFTER_WINDOW', 'WEBHOOK', previo.id)
    const segundo = await webhook(attemptId)
    expect(segundo.result).toMatchObject({ action: 'MATCHED', paymentId: previo.id })
    expect(await asientos(r.id)).toHaveLength(1)
    expect(correosSinLigar()).toHaveLength(1)
    expect((await fila(solicitud.requestId)).updatedAt.getTime()).toBe(r.updatedAt.getTime())
  })

  it('(b) WEBHOOK · la retención del registrador se DIFIERE ⇒ el webhook la pide otra vez antes de sellar; si también se difiere, el evento NO se sella y el worker la completa', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const previo = await pagoDelIntentoSinRegistrador({ attemptId, orderId: venta!.id, terminalId: otra.id })
    const diferida = jest
      .spyOn(terminalPaymentService, 'retenerSolicitudLiberadaPorPagoSinLigar')
      .mockResolvedValueOnce('DEFERRED')
      .mockResolvedValueOnce('DEFERRED')
    let evento: { id: string }
    try {
      const primero = await webhook(attemptId)
      evento = primero.evento
      expect(primero.result).toMatchObject({ action: 'ORPHANED', paymentId: previo.id, message: 'HOLD_DEFERRED' })
      expect(primero.evento).toMatchObject({ status: 'PENDING', paymentId: null })
      expect(diferida).toHaveBeenCalledTimes(2)
    } finally {
      diferida.mockRestore()
    }
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
    expect(await comoWorker(evento.id)).toBe('PROCESSED')
    await retenidaSinLigar(solicitud.requestId, venta!.id, 'NO_EVIDENCE_AFTER_WINDOW', 'WEBHOOK', previo.id)
  })

  it('(c) tras una DECLARACIÓN del cajero: el REST registra el cobro y no se puede ligar ⇒ se re-retiene; la declaración se conserva (sobre y vínculo) y el conteo va desde la declaración', async () => {
    const { solicitud, venta, attemptId, declaracion } = await declaradaPorElCajero()
    const pago = await recordOrderPayment(
      f.venueId,
      venta!.id,
      { ...f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId }), deviceSerialNumber: otra.serialNumber },
      f.staffId,
    )
    const r = await retenidaSinLigar(solicitud.requestId, venta!.id, 'OPERATOR_RECONCILED_NO_CHARGE', 'REST', pago.id)
    expect(r.resultJson).toMatchObject({
      operatorResolution: { id: declaracion.resolution.id },
      unboundPaymentAfterRelease: { releasedAt: declaracion.resolution.acceptedAt },
    })
    const link = await exigir(prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId } }))
    expect(link.operatorResolution).toMatchObject({ id: declaracion.resolution.id, staffId: duena.id })
    // Repetir el registro no mueve nada.
    await recordOrderPayment(
      f.venueId,
      venta!.id,
      { ...f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId }), deviceSerialNumber: otra.serialNumber },
      f.staffId,
    )
    expect(await asientos(r.id)).toHaveLength(1)
    expect(correosSinLigar()).toHaveLength(1)
  })

  it('(minor) un RECOBRO en vuelo de la misma orden admitido después de liberar se cuenta APARTE —sobre, asiento y correo—; uno ya cobrado o de otra orden no', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    // Que el alta quede estrictamente DESPUÉS del instante de la liberación (el filtro es `createdAt > releasedAt`).
    await new Promise(resolve => setTimeout(resolve, 5))
    // Admitidas después de liberar: un recobro EN VUELO de la misma orden (cuenta) y dos que no — uno de la misma orden ya
    // cobrado (COMPLETED con su Payment) y uno en vuelo de OTRA orden (en otro aparato: la ranura activa es única por terminal).
    await f.solicitud({ orderId: venta!.id, status: 'SENT' })
    await f.solicitud({ orderId: venta!.id, status: 'COMPLETED', paymentId: `pago-${randomUUID()}` })
    const otraVenta = await f.nuevaVenta(100)
    await f.solicitud({ orderId: otraVenta.id, status: 'SENT', terminalId: `otro-aparato-${randomUUID()}` })
    const pago = await recordOrderPayment(
      f.venueId,
      venta!.id,
      { ...f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId }), deviceSerialNumber: otra.serialNumber },
      f.staffId,
    )
    const r = await retenidaSinLigar(solicitud.requestId, venta!.id, 'NO_EVIDENCE_AFTER_WINDOW', 'REST', pago.id)
    expect(r.resultJson).toMatchObject({
      unboundPaymentAfterRelease: { otherUnresolvedRequestsOnOrderAfterRelease: 1, otherCardPaymentsOnOrderAfterRelease: 0 },
    })
    expect((await asientos(r.id))[0].data).toMatchObject({ otherUnresolvedRequestsOnOrderAfterRelease: 1 })
    expect(correosSinLigar()[0][0].lines).toEqual(
      expect.arrayContaining([expect.stringContaining(`La orden ${venta!.id} tiene 1 solicitud(es) de cobro sin desenlace admitida(s)`)]),
    )
  })

  it('SOCKET: el `success` de la terminal con un Payment que no se puede ligar sobre una liberada ⇒ se re-retiene (la fila no vuelve a decir «puedes volver a cobrar»)', async () => {
    const { solicitud, venta } = await liberadaPorLaVentana()
    const ajeno = await pagoDelIntentoSinRegistrador({ orderId: venta!.id, terminalId: otra.id, etiqueta: solicitud.requestId })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: solicitud.requestId, status: 'success', paymentId: ajeno.id },
      { socketId: 'socket-principal', terminalId: f.llaveTerminal, venueId: f.venueId },
    )
    const r = await retenidaSinLigar(solicitud.requestId, venta!.id, 'NO_EVIDENCE_AFTER_WINDOW', 'SOCKET', ajeno.id)
    // La afirmación de la terminal se conserva en el sobre, como en cualquier `success` que no acredita.
    expect(r.resultJson).toMatchObject({ claimedSuccess: { paymentId: ajeno.id } })
  })

  it('BARRIDO de 30 min (G1 tras liberar): un cobro etiquetado con la solicitud pero atribuido a OTRA terminal ⇒ el barrido no lo puede conciliar y re-retiene', async () => {
    const { solicitud, venta } = await liberadaPorLaVentana()
    const ajeno = await pagoDelIntentoSinRegistrador({ orderId: venta!.id, terminalId: otra.id, etiqueta: solicitud.requestId })
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    const r = await retenidaSinLigar(solicitud.requestId, venta!.id, 'NO_EVIDENCE_AFTER_WINDOW', 'BARRIDO_LIBERADAS', ajeno.id)
    // Otra pasada no escribe nada: la fila ya no está liberada.
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    expect(await asientos(r.id)).toHaveLength(1)
    expect(correosSinLigar()).toHaveLength(1)
  })

  it('(d) control: el cobro del intento que SÍ se puede ligar ⇒ COMPLETED por el cierre común, sin retención (camino de siempre)', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const pago = await recordOrderPayment(
      f.venueId,
      venta!.id,
      f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId }),
      f.staffId,
    )
    const r = await fila(solicitud.requestId)
    expect(r).toMatchObject({ status: 'COMPLETED', paymentId: pago.id, closedVia: 'terminal', lateResult: true })
    expect(await asientos(r.id)).toEqual([])
    expect(await asientos(r.id, TARDIA)).toHaveLength(1)
    expect(gritos()).toEqual([])
    expect(correosSinLigar()).toEqual([])
    expect(correosTardios()).toHaveLength(1)
  })

  it('(e) re-retenida: la ventana, la declaración y un negativo tardío NO la liberan; a los 20 min se suelta SÓLO la ranura y un cierre que SÍ puede ligar la cierra después', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const previo = await pagoDelIntentoSinRegistrador({ attemptId, orderId: venta!.id, terminalId: (await terminalPrincipal()).id })
    await recordOrderPayment(
      f.venueId,
      venta!.id,
      f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId, amount: 9900 }),
      f.staffId,
    )
    const r = await retenidaSinLigar(solicitud.requestId, venta!.id, 'NO_EVIDENCE_AFTER_WINDOW', 'REST', previo.id)
    const intacta = async () => {
      const ahora = await fila(solicitud.requestId)
      expect(ahora).toMatchObject({ status: 'TIMED_OUT', failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW', paymentId: null })
      return ahora
    }

    // La ventana: su CAS exige `failureCode IS NULL`.
    expect(await terminalPaymentService.releaseUnprovenNegative(solicitud.requestId, f.venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    await intacta()
    // La declaración: hay un cobro del intento (y la fila está retenida).
    await expect(
      resolveNoInstrument(
        { venueId: f.venueId, terminalSerial: f.serial, attemptId, actorStaffId: duena.id },
        { requestId: solicitud.requestId, resolutionId: randomUUID(), statement: 'NO_INSTRUMENT_PRESENTED', statementVersion: 1 },
      ),
    ).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
    await intacta()
    // Un negativo tardío de la terminal, acreditado o sin evidencia: el brazo tardío excluye los marcadores.
    const socket = { socketId: 'socket-principal', terminalId: f.llaveTerminal, venueId: f.venueId }
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: solicitud.requestId, status: 'failed', outcomeEvidence: 'PROCESSOR_DECLINED', errorMessage: 'DECLINADA' },
      socket,
    )
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: solicitud.requestId, status: 'cancelled', errorMessage: 'U100' },
      socket,
    )
    await intacta()
    expect(await asientos(r.id)).toHaveLength(1)

    // A los 20 min: se suelta la RANURA (AUTO_RELEASED) y la VENTA sigue protegida.
    await prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "updatedAt" = ${utcTs(new Date(Date.now() - 21 * 60_000))} WHERE "id" = ${r.id}`
    await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', paymentId: null })
    expect(await terminalPaymentService.isTerminalBusy(f.llaveTerminal, f.venueId)).toBe(false)
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, venta!.id)).toBe(true)
    // El barrido de las soltadas encuentra el cobro del intento (atribuido a esta terminal) y lo liga por el cierre común.
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: previo.id })
  })
})

describe('Ronda 2 · hermano: la aprobación tardía tras una DECLARACIÓN tiene la misma detección que la ventana', () => {
  it('(f) declaración → la terminal registra el cobro (ligable) ⇒ COMPLETED con el conteo desde la declaración, el asiento de aprobación tardía y el correo', async () => {
    const { solicitud, venta, attemptId, declaracion } = await declaradaPorElCajero()
    // El cajero ya recobró la misma orden en otro intento (el caso que esta alarma existe para detectar).
    await pagoDelIntentoSinRegistrador({ orderId: venta!.id, terminalId: (await terminalPrincipal()).id, etiqueta: 'otra-solicitud' })
    const pago = await recordOrderPayment(
      f.venueId,
      venta!.id,
      f.registroDeLaTerminal({ attemptId, requestId: solicitud.requestId }),
      f.staffId,
    )
    const r = await fila(solicitud.requestId)
    expect(r).toMatchObject({ status: 'COMPLETED', paymentId: pago.id, lateResult: true })
    const log = await asientos(r.id, TARDIA)
    expect(log).toHaveLength(1)
    expect(log[0].data).toMatchObject({
      requestId: solicitud.requestId,
      paymentId: pago.id,
      previousFailureCode: 'OPERATOR_RECONCILED_NO_CHARGE',
      otherCardPaymentsOnOrderAfterRelease: 1,
      releasedAt: declaracion.resolution.acceptedAt,
    })
    expect(correosTardios()).toHaveLength(1)
    // El registrador nombra la terminal por su serial acreditado (el del token, con prefijo), como en la ventana.
    expect(correosTardios()[0][0]).toMatchObject({
      subject: `Cobro aprobado tarde tras la declaración del cajero — ${f.serial}`,
      lines: expect.arrayContaining([
        expect.stringContaining('declarara que no se presentó tarjeta'),
        expect.stringContaining(`La orden ${venta!.id} tiene 1 cobro(s) con tarjeta`),
      ]),
    })
    expect(correosSinLigar()).toEqual([])
  })

  it('(f) declaración → un cobro etiquetado llega sin el registrador ⇒ el barrido de 30 min de las DECLARADAS lo concilia, con asiento y correo', async () => {
    const { solicitud, venta } = await declaradaPorElCajero()
    const tardio = await pagoDelIntentoSinRegistrador({
      orderId: venta!.id,
      terminalId: (await terminalPrincipal()).id,
      etiqueta: solicitud.requestId,
    })
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    const r = await fila(solicitud.requestId)
    expect(r).toMatchObject({ status: 'COMPLETED', paymentId: tardio.id, lateResult: true })
    const log = await asientos(r.id, TARDIA)
    expect(log).toHaveLength(1)
    expect(log[0].data).toMatchObject({ previousFailureCode: 'OPERATOR_RECONCILED_NO_CHARGE', otherCardPaymentsOnOrderAfterRelease: 0 })
    expect(correosTardios()).toHaveLength(1)
    // Otra pasada: la fila ya es COMPLETED, el correo no se repite.
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    expect(correosTardios()).toHaveLength(1)
  })
})
