/**
 * Revisión final · ronda 3 (17-sep) — los 3 P1 preexistentes que Codex r8 dejó abiertos, contra Postgres REAL.
 *
 * Invariante: una solicitud LIBERADA (`FAILED` + `NO_EVIDENCE_AFTER_WINDOW` u `OPERATOR_RECONCILED_NO_CHARGE`, sin
 * `paymentId`) nunca puede seguir diciendo «no se cobró / puedes volver a cobrar» cuando existe una señal POSITIVA. Las tres
 * señales que faltaban:
 *
 *  · P1-A — un Payment ligado que llega FUERA de los 30 min del barrido (o cuyo evento el BACKFILL sella sin pasar por el
 *    vínculo). La RED DURABLE lo encuentra en una pasada del watchdog, y el backfill lo pide antes de sellar.
 *  · P1-B — la COLISIÓN DE REFERENCIA por REST: evidencia PENDING (no un Payment COMPLETED), respuesta 2xx al cajero y la
 *    solicitud liberada INTACTA. Ahora re-retiene… pero SÓLO si la identidad acreditada es la terminal de esa solicitud.
 *  · P1-C — una AFIRMACIÓN positiva tardía de la propia terminal sin Payment: el `claimedSuccess` se fundía sobre la fila
 *    FAILED y la ranura seguía LIBRE.
 *
 * Contra Postgres y sólo en la base desechable: los CAS con `EXISTS` evaluados en la escritura, el `JOIN LATERAL` de la red
 * durable, el plan del índice y «una sola vez» son cosas de la base, no de un mock.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { sendOpsAlert } from '@/services/alerts/opsAlert.service'
import { reconcileAngelPayWebhookForPayment } from '@/services/tpv/angelpay-webhook.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { resolveNoInstrument } from '@/services/tpv/no-instrument-resolution.service'
import { UNPROVEN_NEGATIVE_WINDOW_MS, sinAfirmacionDeLaTerminalSql, terminalPaymentService } from '@/services/terminal-payment.service'
import { evidenciaDeConciliacionDeLaFilaSql, pagoLigadoDeLaFilaSql } from '@/services/tpv/evidenciaPositivaSql'
import { Prisma } from '@prisma/client'
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

const SIN_LIGAR = 'TERMINAL_PAYMENT_UNBOUND_PAYMENT_AFTER_RELEASE'
const COLISION = 'TERMINAL_PAYMENT_REFERENCE_COLLISION_AFTER_RELEASE'
const AFIRMACION = 'TERMINAL_PAYMENT_TERMINAL_CLAIM_AFTER_RELEASE'
let f: Fixture
let duena: { id: string }
let otra: { id: string; serialNumber: string }

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('vsenales')
  duena = await prisma.staff.create({
    data: {
      email: `${f.fixture}-duena@example.test`,
      firstName: 'Dueña',
      lastName: 'Senales',
      organizations: { create: { organizationId: f.fixture, role: 'OWNER', isPrimary: true, isActive: true } },
      venues: { create: { venueId: f.venueId, role: 'OWNER', active: true, pin: '2468' } },
    },
    select: { id: true },
  })
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
const asientos = (entityId: string, action: string) => prisma.activityLog.findMany({ where: { venueId: f.venueId, action, entityId } })
const gritos = (aguja: string) =>
  (logger.error as jest.Mock).mock.calls.filter(c => String(c[0]).includes('🚨') && String(c[0]).includes(aguja))
const correos = (aguja: string) => (sendOpsAlert as jest.Mock).mock.calls.filter(c => String(c[0]?.subject).includes(aguja))

/** Una solicitud de la VENTANA (negativo de la terminal sin evidencia) con su intento vinculado, lista para liberarse. */
async function enLaVentana() {
  const venta = await f.nuevaVenta(100)
  const solicitud = await f.solicitud({
    orderId: venta.id,
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
async function liberadaPorLaVentana() {
  const r = await enLaVentana()
  expect(await terminalPaymentService.releaseUnprovenNegative(r.solicitud.requestId, f.venueId, 'WATCHDOG')).toBe('RELEASED')
  expect(await fila(r.solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW', paymentId: null })
  expect(await terminalPaymentService.isTerminalBusy(f.llaveTerminal, f.venueId)).toBe(false)
  expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, r.venta.id)).toBe(false)
  return r
}

/** Envejece la fila liberada: `updatedAt` y `createdAt` fuera de la ventana de 30 min del barrido. */
async function envejecer(id: string, minutos: number) {
  const cuando = new Date(Date.now() - minutos * 60_000)
  await prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "updatedAt" = ${utcTs(cuando)}, "createdAt" = ${utcTs(
    cuando,
  )} WHERE "id" = ${id}`
}

/** Un cobro con tarjeta COMPLETED del intento, escrito SIN pasar por el registrador; `terminalId` decide su atribución. */
async function pagoDelIntento(args: {
  attemptId: string
  orderId: string
  terminalId: string
  amount?: number
  /** El camino del SOCKET exige que el Payment YA venga etiquetado con la solicitud (`processorData`). */
  etiqueta?: string
}) {
  return prisma.payment.create({
    data: {
      venueId: f.venueId,
      orderId: args.orderId,
      source: 'TPV',
      terminalId: args.terminalId,
      amount: args.amount ?? 100,
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: args.amount ?? 100,
      idempotencyKey: args.attemptId,
      ...(args.etiqueta ? { processorData: { terminalPaymentRequestId: args.etiqueta, deviceSerialNumber: f.serial } } : {}),
    },
  })
}

/** El estado común de una fila RE-RETENIDA: orden y ranura bloqueadas, nada de «volver a cobrar», desenlace UNRESOLVED. */
async function retenida(requestId: string, ventaId: string) {
  const r = await fila(requestId)
  expect(r).toMatchObject({ status: 'TIMED_OUT', failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW', paymentId: null })
  expect(String((r.resultJson as Record<string, unknown>).errorMessage)).not.toMatch(/volver a cobrar\./)
  expect(await terminalPaymentService.isTerminalBusy(f.llaveTerminal, f.venueId)).toBe(true)
  expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, ventaId)).toBe(true)
  expect(await terminalPaymentService.getPaymentStatus(requestId, f.venueId)).toMatchObject({
    status: 'TIMED_OUT',
    outcome: 'UNRESOLVED',
    failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW',
  })
  return r
}

// ═════════════════ P1-A · la RED DURABLE: sin la ventana de 30 min ═════════════════
describe('Ronda 3 · P1-A: la red durable alcanza un Payment ligado que llega FUERA de los 30 min', () => {
  it('🔴 una liberada de 3 HORAS con un Payment ligado NO atribuible: el barrido de 30 min no la ve; la red durable la re-retiene', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    await envejecer(solicitud.id, 180)
    // Ligado por la llave del intento, pero atribuido a OTRA terminal ⇒ el cierre común no puede ligarlo.
    const pago = await pagoDelIntento({ attemptId, orderId: venta.id, terminalId: otra.id })

    const r = await terminalPaymentService.reconcileUnknownRequests(new Date())

    expect(r.heldWithLinkedPayment).toBeGreaterThanOrEqual(1)
    const retenidaR = await retenida(solicitud.requestId, venta.id)
    expect(retenidaR.resultJson).toMatchObject({
      unboundPaymentAfterRelease: {
        origen: 'BARRIDO_LIGADOS',
        previousFailureCode: 'NO_EVIDENCE_AFTER_WINDOW',
        paymentIds: [pago.id],
      },
    })
    const log = await asientos(retenidaR.id, SIN_LIGAR)
    expect(log).toHaveLength(1)
    expect(log[0].data).toMatchObject({ origen: 'BARRIDO_LIGADOS', paymentIds: [pago.id] })
    expect(gritos('held for review')).toHaveLength(1)
    expect(correos('sin ligar')).toHaveLength(1)

    // Idempotente: una segunda pasada no vuelve a retener ni deja un segundo asiento.
    jest.clearAllMocks()
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    expect(await asientos(retenidaR.id, SIN_LIGAR)).toHaveLength(1)
  })

  it('una liberada ANTIGUA SIN NINGUNA señal (ni cobro, ni evidencia, ni afirmación) no se toca', async () => {
    const { solicitud, venta } = await liberadaPorLaVentana()
    await envejecer(solicitud.id, 180)
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, venta.id)).toBe(false)
  })

  it('un Payment que SÍ es atribuible se cierra por el cierre común (COMPLETED), no por la re-retención', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    await envejecer(solicitud.id, 180)
    const pago = await pagoDelIntento({ attemptId, orderId: venta.id, terminalId: (await terminalPrincipal()).id })
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id })
  })

  it('el límite declarado: más allá del horizonte de 7 días la red ya no la recorre (queda para conciliación manual)', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    await envejecer(solicitud.id, 8 * 24 * 60)
    await pagoDelIntento({ attemptId, orderId: venta.id, terminalId: otra.id })
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
  })

  it('también alcanza a las DECLARADAS por el cajero, con su propio código previo', async () => {
    const r = await enLaVentana()
    await resolveNoInstrument(
      { venueId: f.venueId, terminalSerial: f.serial, attemptId: r.attemptId, actorStaffId: duena.id },
      { requestId: r.solicitud.requestId, resolutionId: randomUUID(), statement: 'NO_INSTRUMENT_PRESENTED', statementVersion: 1 },
    )
    expect(await fila(r.solicitud.requestId)).toMatchObject({ failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' })
    await envejecer(r.solicitud.id, 180)
    await pagoDelIntento({ attemptId: r.attemptId, orderId: r.venta.id, terminalId: otra.id })

    expect((await terminalPaymentService.reconcileUnknownRequests(new Date())).heldWithLinkedPayment).toBeGreaterThanOrEqual(1)
    const retenidaR = await retenida(r.solicitud.requestId, r.venta.id)
    expect(retenidaR.resultJson).toMatchObject({
      unboundPaymentAfterRelease: { previousFailureCode: 'OPERATOR_RECONCILED_NO_CHARGE', origen: 'BARRIDO_LIGADOS' },
    })
  })
})

const terminalPrincipal = () => exigir(prisma.terminal.findFirst({ where: { venueId: f.venueId, serialNumber: f.serial } }))

/** Un evento PENDING de AngelPay correlacionado con la llave del Payment (lo que el backfill busca). */
async function eventoPendiente(attemptId: string) {
  const eventId = `angelpay-${f.nuevoEventId()}`
  return prisma.providerEventLog.create({
    data: {
      provider: 'PAYMENT_PROCESSOR',
      type: 'send_transaction',
      eventId,
      status: 'PENDING',
      venueId: f.venueId,
      payload: f.eventoAngelPay(attemptId) as object,
    },
  })
}

/**
 * El cobro previo con la MISMA referencia, mismo importe, misma orden y misma terminal, pero de OTRA afiliación y SIN
 * autorización: la identidad queda INCIERTA (`AFILIACION_INCIERTA`) ⇒ el registro entrante nace como EVIDENCIA PENDING.
 */
async function cobroPrevioQueContradice(orderId: string, referencia: string) {
  const otraAfiliacion = await f.afiliacionSecundaria()
  return prisma.payment.create({
    data: {
      venueId: f.venueId,
      orderId,
      source: 'TPV',
      terminalId: (await terminalPrincipal()).id,
      merchantAccountId: otraAfiliacion.id,
      amount: 100,
      tipAmount: 0,
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      referenceNumber: referencia,
      authorizationNumber: null,
      feePercentage: 0,
      feeAmount: 0,
      netAmount: 100,
    },
  })
}

// ═════════════════ P1-A · el BACKFILL pide antes de sellar ═════════════════
describe('Ronda 3 · P1-A: el backfill del webhook pide la re-retención ANTES de sellar su evento', () => {
  it('re-retiene y sella: el evento queda PROCESSED y la solicitud liberada vuelve a estar retenida', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const pago = await pagoDelIntento({ attemptId, orderId: venta.id, terminalId: otra.id })
    const evento = await eventoPendiente(attemptId)

    await reconcileAngelPayWebhookForPayment({
      id: pago.id,
      idempotencyKey: attemptId,
      referenceNumber: null,
      venueId: f.venueId,
      amount: 100,
      tipAmount: 0,
      merchantAccountId: f.merchantId,
    })

    expect(await exigir(prisma.providerEventLog.findUnique({ where: { id: evento.id } }))).toMatchObject({ status: 'PROCESSED' })
    const retenidaR = await retenida(solicitud.requestId, venta.id)
    expect(retenidaR.resultJson).toMatchObject({ unboundPaymentAfterRelease: { origen: 'BACKFILL', paymentIds: [pago.id] } })
    expect(await asientos(retenidaR.id, SIN_LIGAR)).toHaveLength(1)
  })

  it('🔴 DEFERRED: el evento NO se sella — sigue PENDING y el worker lo repite', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const pago = await pagoDelIntento({ attemptId, orderId: venta.id, terminalId: otra.id })
    const evento = await eventoPendiente(attemptId)
    const diferida = jest.spyOn(terminalPaymentService, 'retenerSolicitudLiberadaPorPagoSinLigar').mockResolvedValue('DEFERRED')
    try {
      await reconcileAngelPayWebhookForPayment({
        id: pago.id,
        idempotencyKey: attemptId,
        referenceNumber: null,
        venueId: f.venueId,
        amount: 100,
        tipAmount: 0,
        merchantAccountId: f.merchantId,
      })
      expect(diferida).toHaveBeenCalledTimes(1)
      expect(await exigir(prisma.providerEventLog.findUnique({ where: { id: evento.id } }))).toMatchObject({
        status: 'PENDING',
        paymentId: null,
      })
      expect(await fila(solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
    } finally {
      diferida.mockRestore()
    }
    // Y la red durable la recupera igual en la siguiente pasada del watchdog: el DEFERRED no es un residuo indefinido.
    await envejecer(solicitud.id, 180)
    expect((await terminalPaymentService.reconcileUnknownRequests(new Date())).heldWithLinkedPayment).toBeGreaterThanOrEqual(1)
    await retenida(solicitud.requestId, venta.id)
  })
})

// ═════════════════ P1-B · la colisión de referencia por REST ═════════════════
describe('Ronda 3 · P1-B: la colisión de referencia sobre una solicitud LIBERADA', () => {
  it('🔴 la evidencia PENDING re-retiene la solicitud: razón propia, sin Payment ligado, UN asiento, 🚨 y correo', async () => {
    const { solicitud, venta } = await liberadaPorLaVentana()
    const referencia = `REF-${randomUUID().slice(0, 12)}`
    await cobroPrevioQueContradice(venta.id, referencia)

    const respuesta: any = await recordOrderPayment(
      f.venueId,
      venta.id,
      {
        ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: referencia, requestId: solicitud.requestId }),
        authorizationNumber: null,
      },
      duena.id,
    )
    // La terminal recibe 2xx con SU evidencia — nunca un error (un rechazo delante del cliente empuja a volver a cobrar).
    expect(respuesta.possibleReferenceCollision).toMatchObject({ referenceNumber: referencia })
    expect(respuesta.status).toBe('PENDING')

    const retenidaR = await retenida(solicitud.requestId, venta.id)
    expect(retenidaR.resultJson).toMatchObject({
      referenceCollisionAfterRelease: {
        paymentId: respuesta.id,
        reason: 'REFERENCE_COLLISION_AFTER_RELEASE',
        origen: 'REST',
        previousFailureCode: 'NO_EVIDENCE_AFTER_WINDOW',
      },
    })
    // No hay Payment LIGADO: la evidencia es PENDING, así que el CAS no pudo ser el de `hayPagoLigadoSql`.
    expect(
      await prisma.payment.count({ where: { venueId: f.venueId, status: 'COMPLETED', terminalPaymentRequestId: solicitud.requestId } }),
    ).toBe(0)
    const log = await asientos(retenidaR.id, COLISION)
    expect(log).toHaveLength(1)
    expect(log[0].data).toMatchObject({ reason: 'REFERENCE_COLLISION_AFTER_RELEASE', paymentId: respuesta.id, origen: 'REST' })
    expect(gritos('RELEASED')).toHaveLength(1)
    expect(correos('Colisión de referencia sobre un cobro ya liberado')).toHaveLength(1)
  })

  it('🔴 el control: la identidad acreditada NO es la terminal de la solicitud ⇒ la fila queda INTACTA y se grita', async () => {
    const { solicitud, venta } = await liberadaPorLaVentana()
    const referencia = `REF-${randomUUID().slice(0, 12)}`
    await cobroPrevioQueContradice(venta.id, referencia)

    const respuesta: any = await recordOrderPayment(
      f.venueId,
      venta.id,
      {
        ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: referencia, requestId: solicitud.requestId }),
        authorizationNumber: null,
        // La evidencia nace atribuida a la OTRA terminal del negocio: no puede retener la venta ni la ranura de esta.
        deviceSerialNumber: otra.serialNumber,
        authenticatedTerminalSerial: otra.serialNumber,
      },
      duena.id,
    )
    expect(respuesta.possibleReferenceCollision).toBeDefined()

    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW', paymentId: null })
    expect(await terminalPaymentService.isTerminalBusy(f.llaveTerminal, f.venueId)).toBe(false)
    expect(await asientos((await fila(solicitud.requestId)).id, COLISION)).toHaveLength(0)
    const grito = (logger.error as jest.Mock).mock.calls.find(c => String(c[0]).includes('does not own it'))
    expect(grito).toBeDefined()
    expect(grito?.[1]).toMatchObject({ requestId: solicitud.requestId, reason: 'TERMINAL_MISMATCH' })
    expect(correos('Colisión de referencia sobre un cobro ya liberado')).toHaveLength(0)
  })

  it('regresión: la MISMA colisión sobre una solicitud que NO está liberada no toca la fila (ni asiento ni correo)', async () => {
    const venta = await f.nuevaVenta(100)
    const solicitud = await f.solicitud({ orderId: venta.id })
    const referencia = `REF-${randomUUID().slice(0, 12)}`
    await cobroPrevioQueContradice(venta.id, referencia)

    await recordOrderPayment(
      f.venueId,
      venta.id,
      {
        ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: referencia, requestId: solicitud.requestId }),
        authorizationNumber: null,
      },
      duena.id,
    )
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'SENT', failureCode: null })
    expect(await asientos(solicitud.id, COLISION)).toHaveLength(0)
    expect(correos('Colisión de referencia sobre un cobro ya liberado')).toHaveLength(0)
  })
})

// ═════════════════ P1-C · la afirmación positiva tardía de la terminal ═════════════════
describe('Ronda 3 · P1-C: un `success` tardío sin Payment sobre una solicitud LIBERADA', () => {
  it('🔴 re-retiene con TERMINAL_CLAIMED_SUCCESS, RECUPERA la ranura y conserva la afirmación', async () => {
    const { solicitud, venta } = await liberadaPorLaVentana()

    const resultado = await (terminalPaymentService as any).closeRow(solicitud.requestId, f.venueId, {
      requestId: solicitud.requestId,
      status: 'success',
      transactionId: '260917120000',
      authorizationCode: 'A1B2C3',
    })

    // Lo que el POS recibe ya NO es «no se cobró»: es «pendiente de revisión».
    expect(resultado).toMatchObject({ status: 'timeout' })
    expect(String(resultado.errorMessage)).not.toMatch(/volver a cobrar/)
    expect(String(resultado.errorMessage)).toMatch(/se está revisando/)

    const retenidaR = await retenida(solicitud.requestId, venta.id)
    expect(retenidaR.resultJson).toMatchObject({
      claimedSuccess: { transactionId: '260917120000', authorizationCode: 'A1B2C3' },
      terminalClaimedSuccessAfterRelease: {
        reason: 'TERMINAL_CLAIMED_SUCCESS',
        origen: 'SOCKET',
        previousFailureCode: 'NO_EVIDENCE_AFTER_WINDOW',
        claimedSuccess: { transactionId: '260917120000' },
      },
    })
    const log = await asientos(retenidaR.id, AFIRMACION)
    expect(log).toHaveLength(1)
    expect(log[0].data).toMatchObject({ reason: 'TERMINAL_CLAIMED_SUCCESS', claimedSuccess: { transactionId: '260917120000' } })
    expect(gritos('CLAIMED')).toHaveLength(1)
    expect(correos('La terminal afirmó haber cobrado un cobro ya liberado')).toHaveLength(1)
  })

  it('un `success` repetido no deja un segundo asiento ni un segundo correo', async () => {
    const { solicitud, venta } = await liberadaPorLaVentana()
    const afirmacion = { requestId: solicitud.requestId, status: 'success' as const, transactionId: '260917120000' }
    await (terminalPaymentService as any).closeRow(solicitud.requestId, f.venueId, afirmacion)
    const id = (await fila(solicitud.requestId)).id
    jest.clearAllMocks()
    await (terminalPaymentService as any).closeRow(solicitud.requestId, f.venueId, afirmacion)
    expect(await asientos(id, AFIRMACION)).toHaveLength(1)
    expect(correos('La terminal afirmó haber cobrado un cobro ya liberado')).toHaveLength(0)
    await retenida(solicitud.requestId, venta.id)
  })

  it('la fila re-retenida NO la sueltan la ventana, la declaración ni un negativo tardío; a los 20 min suelta la RANURA y la venta sigue bloqueada', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    await (terminalPaymentService as any).closeRow(solicitud.requestId, f.venueId, {
      requestId: solicitud.requestId,
      status: 'success',
      transactionId: '260917120000',
    })
    await retenida(solicitud.requestId, venta.id)

    // La ventana ya no la toca.
    expect(await terminalPaymentService.releaseUnprovenNegative(solicitud.requestId, f.venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    // Un negativo tardío SIN evidencia tampoco.
    await (terminalPaymentService as any).closeRow(solicitud.requestId, f.venueId, {
      requestId: solicitud.requestId,
      status: 'failed',
      errorMessage: 'SDK U100',
    })
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW' })
    // Y la declaración del cajero queda VETADA por la afirmación: no puede declarar «no se presentó tarjeta» encima.
    await expect(
      resolveNoInstrument(
        { venueId: f.venueId, terminalSerial: f.serial, attemptId, actorStaffId: duena.id },
        { requestId: solicitud.requestId, resolutionId: randomUUID(), statement: 'NO_INSTRUMENT_PRESENTED', statementVersion: 1 },
      ),
    ).rejects.toThrow()
    expect(await fila(solicitud.requestId)).toMatchObject({ failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW' })

    // 20 min: la RANURA se suelta como siempre; la VENTA sigue bloqueada.
    await prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "updatedAt" = ${utcTs(
      new Date(Date.now() - 21 * 60_000),
    )} WHERE "id" = ${solicitud.id}`
    await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
    expect(await terminalPaymentService.isTerminalBusy(f.llaveTerminal, f.venueId)).toBe(false)
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, venta.id)).toBe(true)
  })

  it('regresión: un `success` con Payment ACREDITABLE cierra la fila como COMPLETED (nada de re-retención)', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const pago = await pagoDelIntento({
      attemptId,
      orderId: venta.id,
      terminalId: (await terminalPrincipal()).id,
      etiqueta: solicitud.requestId,
    })
    await (terminalPaymentService as any).closeRow(solicitud.requestId, f.venueId, {
      requestId: solicitud.requestId,
      status: 'success',
      paymentId: pago.id,
    })
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id })
    expect(await asientos(solicitud.id, AFIRMACION)).toHaveLength(0)
  })

  it('regresión: una solicitud que NO está liberada sigue su camino de siempre (UNKNOWN con la afirmación, sin marcador)', async () => {
    const venta = await f.nuevaVenta(100)
    const solicitud = await f.solicitud({ orderId: venta.id })
    await (terminalPaymentService as any).closeRow(solicitud.requestId, f.venueId, {
      requestId: solicitud.requestId,
      status: 'success',
      transactionId: '260917120000',
    })
    const r = await fila(solicitud.requestId)
    expect(r).toMatchObject({ status: 'UNKNOWN', failureCode: null })
    expect(r.resultJson).toMatchObject({ claimedSuccess: { transactionId: '260917120000' } })
    expect(await asientos(r.id, AFIRMACION)).toHaveLength(0)
  })
})

// ═════════════════ P2 · el plan: la expresión ya coincide con el índice ═════════════════
describe('Ronda 3 · P2: el plan de la pregunta «hay un cobro ligado» usa el índice de recuperación', () => {
  const INDICE = 'Payment_terminal_request_recovery_idx'
  /**
   * Con `enable_seqscan = off` el planificador usa el índice SI la expresión coincide con la indexada — y no puede usarlo si
   * no coincide, por muchas filas que haya. Eso demuestra el P2 sin depender del tamaño de los datos: la versión con `->>`
   * (la anterior) sigue recorriendo la tabla; la alineada con `#>` entra por el índice.
   */
  const plan = async (predicado: string, venueId: string, requestId: string) => {
    const filas = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN (ANALYZE, BUFFERS) SELECT p."id" FROM "Payment" p WHERE p."venueId" = $1 AND ${predicado} LIMIT 5`,
      venueId,
      requestId,
    )
    return filas.map(f2 => f2['QUERY PLAN']).join('\n')
  }

  it('la expresión ALINEADA entra por el índice; la anterior (`->>`) no puede', async () => {
    const venta = await f.nuevaVenta(100)
    const principal = await terminalPrincipal()
    // Suficientes filas del venue para que el plan sea informativo (y con la etiqueta en `processorData`, como las colas viejas).
    await prisma.payment.createMany({
      data: Array.from({ length: 400 }, (_, i) => ({
        venueId: f.venueId,
        orderId: venta.id,
        source: 'TPV' as const,
        terminalId: principal.id,
        amount: 1,
        method: 'CREDIT_CARD' as const,
        status: 'COMPLETED' as const,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 1,
        processorData: { terminalPaymentRequestId: `REQ-SEED-${i}` },
      })),
    })
    await prisma.$executeRawUnsafe(`ANALYZE "Payment"`)
    await prisma.$executeRawUnsafe(`SET enable_seqscan = off`)
    try {
      const alineada = await plan(`p."processorData" #> '{terminalPaymentRequestId}' = to_jsonb($2::text)`, f.venueId, 'REQ-SEED-7')
      const anterior = await plan(`p."processorData"->>'terminalPaymentRequestId' = $2`, f.venueId, 'REQ-SEED-7')
      console.log('\n[P2] plan ALINEADO (#>):\n' + alineada + '\n\n[P2] plan ANTERIOR (->>):\n' + anterior + '\n')
      expect(alineada).toContain(INDICE)
      expect(anterior).not.toContain(INDICE)
    } finally {
      await prisma.$executeRawUnsafe(`SET enable_seqscan = on`)
    }
  })

  it('el coste de la RED DURABLE: el plan de su consulta con datos, y cuántas filas candidatas hay', async () => {
    // Datos para que el plan sea informativo: 1 candidata real (liberada, con su cobro ligado) + historial del venue.
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const principal = await terminalPrincipal()
    await pagoDelIntento({ attemptId, orderId: venta.id, terminalId: otra.id })
    await prisma.payment.createMany({
      data: Array.from({ length: 400 }, (_, i) => ({
        venueId: f.venueId,
        orderId: venta.id,
        source: 'TPV' as const,
        terminalId: principal.id,
        amount: 1,
        method: 'CREDIT_CARD' as const,
        status: 'COMPLETED' as const,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 1,
        processorData: { terminalPaymentRequestId: `REQ-COST-${i}` },
      })),
    })
    await prisma.$executeRawUnsafe(`ANALYZE "Payment"`)
    await prisma.$executeRawUnsafe(`ANALYZE "TerminalPaymentRequest"`)
    expect(solicitud.requestId).toBeDefined()
    const [{ candidatas }] = await prisma.$queryRaw<{ candidatas: bigint }[]>`
      SELECT count(*) AS candidatas FROM "TerminalPaymentRequest" r
      WHERE r."status" = 'FAILED' AND r."failureCode" IN ('NO_EVIDENCE_AFTER_WINDOW', 'OPERATOR_RECONCILED_NO_CHARGE')
        AND r."paymentId" IS NULL AND r."createdAt" >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '7 days'`
    // 🔴 NO se transcribe a mano NADA del selector: las TRES piezas son las MISMAS que usa
    // `retenerLiberadasConSenalPositiva` en producción (`pagoLigadoDeLaFilaSql`, `evidenciaDeConciliacionDeLaFilaSql` y
    // `sinAfirmacionDeLaTerminalSql`). Si el código cambiara el `UNION` por un `OR` equivalente —la forma 300× más lenta
    // documentada en `evidenciaPositivaSql.ts`— este EXPLAIN lo vería, no una copia hecha a mano. Ronda 4: mide el selector
    // COMPLETO, con el segundo LATERAL de la evidencia de colisión.
    const hayAfirmacion = Prisma.sql`NOT (${sinAfirmacionDeLaTerminalSql(Prisma.raw('r."resultJson"'))})`
    const filas = await prisma.$queryRaw<{ 'QUERY PLAN': string }[]>`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT r."requestId", r."venueId", r."createdAt", r."id",
             ligado."id" AS "paymentId", colision."ids" AS "evidenciaIds", (${hayAfirmacion}) AS "afirmacion"
      FROM "TerminalPaymentRequest" r
      LEFT JOIN LATERAL (${pagoLigadoDeLaFilaSql('r')} LIMIT 1) ligado ON true
      LEFT JOIN LATERAL (
        SELECT array_agg(c."id") AS "ids" FROM (${evidenciaDeConciliacionDeLaFilaSql('r')} ORDER BY 1 LIMIT 5) c
      ) colision ON true
      WHERE r."status" = 'FAILED' AND r."failureCode" IN ('NO_EVIDENCE_AFTER_WINDOW','OPERATOR_RECONCILED_NO_CHARGE')
        AND r."paymentId" IS NULL AND r."createdAt" >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '7 days'
        AND (ligado."id" IS NOT NULL OR colision."ids" IS NOT NULL OR ${hayAfirmacion})
      ORDER BY r."createdAt" ASC, r."id" ASC LIMIT 200`
    console.log(`\n[P2] filas candidatas de la red durable: ${candidatas}\n` + filas.map(f2 => f2['QUERY PLAN']).join('\n') + '\n')
    expect(Number(candidatas)).toBeGreaterThanOrEqual(1)
    // 🔴 Lo que de verdad importa del plan: ninguna rama recorre `Payment` entera (con el `OR` anterior eran 1 092 ms y
    // 58 893 buffers por pasada — un Seq Scan de los pagos del venue POR cada fila candidata).
    const texto = filas.map(f2 => f2['QUERY PLAN']).join('\n')
    expect(texto).not.toMatch(/Seq Scan on "Payment"/)
    expect(texto).toContain('Payment_terminal_request_recovery_idx')
  })
})

// ═══════════ RONDA 4 · la red durable recoge TODO lo que quedó a medias, no sólo lo que trae Payment ═══════════
//
// 🔑 La causa de fondo que Codex r9 nombró: `DEFERRED` no tenía quién lo reintentara. Las dos señales que NO producen un
// `Payment` COMPLETED —la evidencia de colisión y la afirmación de la terminal— quedaban fuera del selector de la red, así
// que un conflicto transitorio de candado dejaba la solicitud liberada PARA SIEMPRE diciendo «puedes volver a cobrar».
describe('Ronda 4 · P1-B: la colisión cuya re-retención se DIFIRIÓ ya no se queda sin recuperación', () => {
  it('🔴 el REST se difiere y la RED DURABLE la retiene en la pasada siguiente, con su propia razón', async () => {
    const { solicitud, venta } = await liberadaPorLaVentana()
    const referencia = `REF-${randomUUID().slice(0, 12)}`
    await cobroPrevioQueContradice(venta.id, referencia)
    // El candado ocupado del núcleo: `DEFERRED` sin escribir nada. El registrador responde su evidencia igual (2xx).
    const diferida = jest
      .spyOn(terminalPaymentService, 'retenerSolicitudLiberadaPorColisionDeReferencia')
      .mockImplementationOnce(async () => 'DEFERRED')
    let evidenciaId = ''
    try {
      const respuesta: any = await recordOrderPayment(
        f.venueId,
        venta.id,
        {
          ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: referencia, requestId: solicitud.requestId }),
          authorizationNumber: null,
        },
        duena.id,
      )
      expect(respuesta.possibleReferenceCollision).toBeDefined()
      evidenciaId = respuesta.id
      // El hueco que Codex encontró: la fila sigue LIBERADA y nadie más iba a pasar por aquí.
      expect(await fila(solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
    } finally {
      diferida.mockRestore()
    }

    const r = await terminalPaymentService.reconcileUnknownRequests(new Date())
    expect(r.heldWithoutPayment).toBeGreaterThanOrEqual(1)
    const retenidaR = await retenida(solicitud.requestId, venta.id)
    expect(retenidaR.resultJson).toMatchObject({
      referenceCollisionAfterRelease: { paymentId: evidenciaId, reason: 'REFERENCE_COLLISION_AFTER_RELEASE', origen: 'BARRIDO_SENALES' },
    })
    // No hay ningún Payment COMPLETED ligado: es exactamente la señal que la red de la ronda 3 no podía ver.
    expect(
      await prisma.payment.count({ where: { venueId: f.venueId, status: 'COMPLETED', terminalPaymentRequestId: solicitud.requestId } }),
    ).toBe(0)
    expect(await asientos(retenidaR.id, COLISION)).toHaveLength(1)
    // Idempotente: una segunda pasada no deja un segundo asiento.
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    expect(await asientos(retenidaR.id, COLISION)).toHaveLength(1)
  })

  it('control: la evidencia de OTRA terminal no retiene la venta ajena, y la contradicción no se grita en cada pasada', async () => {
    const { solicitud, venta } = await liberadaPorLaVentana()
    const referencia = `REF-${randomUUID().slice(0, 12)}`
    await cobroPrevioQueContradice(venta.id, referencia)
    const diferida = jest
      .spyOn(terminalPaymentService, 'retenerSolicitudLiberadaPorColisionDeReferencia')
      .mockImplementationOnce(async () => 'DEFERRED')
    try {
      await recordOrderPayment(
        f.venueId,
        venta.id,
        {
          ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: referencia, requestId: solicitud.requestId }),
          authorizationNumber: null,
          deviceSerialNumber: otra.serialNumber,
          authenticatedTerminalSerial: otra.serialNumber,
        },
        duena.id,
      )
    } finally {
      diferida.mockRestore()
    }

    jest.clearAllMocks()
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
    expect(await terminalPaymentService.isTerminalBusy(f.llaveTerminal, f.venueId)).toBe(false)
    const contradicciones = () => (logger.error as jest.Mock).mock.calls.filter(c => String(c[0]).includes('does not own it'))
    expect(contradicciones()).toHaveLength(1)
    // 🔴 Y en la pasada siguiente NO se vuelve a gritar: la evidencia no cambió, así que repetirlo sólo taparía alarmas reales.
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    expect(contradicciones()).toHaveLength(1)
  })
})

// ═══════ RONDA 5 · una evidencia AJENA no puede tapar a una LEGÍTIMA (Codex r10, P1-B) ═══════
//
// 🔑 Contra Postgres REAL porque lo que estaba mal era la CONSULTA: el `LIMIT 1` del LATERAL acotaba el conjunto ANTES de
// que nadie comprobara la identidad acreditada (regla T10), así que la evidencia de otra terminal —rechazada, con razón—
// se devolvía en cada pasada y la legítima no se examinaba jamás. Un mock no puede demostrar qué devuelve el selector.
describe('Ronda 5 · P1-B: el selector surfacea TODAS las evidencias acotadas, no sólo la primera', () => {
  /**
   * Una EVIDENCIA de conciliación tal como la escribe el registrador: Payment PENDING apuntado a la solicitud con su
   * `reconciliation.kind`. El `terminalId` decide su procedencia acreditada (`Payment.terminal.serialNumber`), que es lo
   * único que separa a la legítima de la ajena. El `id` es explícito para fijar el orden del conjunto (`ORDER BY 1`).
   */
  const evidencia = async (args: { id: string; orderId: string; requestId: string; terminalId: string }) =>
    prisma.payment.create({
      data: {
        id: args.id,
        venueId: f.venueId,
        orderId: args.orderId,
        source: 'TPV',
        terminalId: args.terminalId,
        terminalPaymentRequestId: args.requestId,
        amount: 100,
        method: 'CREDIT_CARD',
        status: 'PENDING',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 100,
        processorData: { reconciliation: { kind: 'POSSIBLE_REFERENCE_COLLISION' } },
      },
      select: { id: true },
    })

  it('🔴 la secuencia de Codex: E1 ajena PRIMERO + E2 legítima ⇒ la red retiene por E2, y la ajena sigue gritando una vez', async () => {
    const { solicitud, venta } = await liberadaPorLaVentana()
    const principal = await terminalPrincipal()
    // El orden importa: `ORDER BY 1` sobre el id pone la AJENA primero, que es exactamente el caso que tapaba a la otra.
    const ajena = await evidencia({ id: `${f.fixture}-ev-1-ajena`, orderId: venta.id, requestId: solicitud.requestId, terminalId: otra.id })
    const legitima = await evidencia({
      id: `${f.fixture}-ev-2-legitima`,
      orderId: venta.id,
      requestId: solicitud.requestId,
      terminalId: principal.id,
    })

    const r = await terminalPaymentService.reconcileUnknownRequests(new Date())

    expect(r.heldWithoutPayment).toBeGreaterThanOrEqual(1)
    const retenidaR = await retenida(solicitud.requestId, venta.id)
    // Retenida por la LEGÍTIMA, nunca por la ajena.
    expect(retenidaR.resultJson).toMatchObject({
      referenceCollisionAfterRelease: { paymentId: legitima.id, reason: 'REFERENCE_COLLISION_AFTER_RELEASE', origen: 'BARRIDO_SENALES' },
    })
    const log = await asientos(retenidaR.id, COLISION)
    expect(log).toHaveLength(1)
    expect(log[0].data).toMatchObject({ paymentId: legitima.id })
    // T10 intacta: la ajena NO retuvo nada y sí gritó su contradicción, una sola vez.
    const contradicciones = () =>
      (logger.error as jest.Mock).mock.calls.filter(c => String(c[0]).includes('does not own it') && c[1]?.paymentId === ajena.id)
    expect(contradicciones()).toHaveLength(1)
    // Idempotente: una segunda pasada no deja un segundo asiento ni repite el 🚨.
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    expect(await asientos(retenidaR.id, COLISION)).toHaveLength(1)
    expect(contradicciones()).toHaveLength(1)
  })

  it('el selector REAL devuelve el conjunto de evidencias (no una), acotado y ordenado', async () => {
    const { solicitud, venta } = await liberadaPorLaVentana()
    const principal = await terminalPrincipal()
    const ids: string[] = []
    for (let i = 0; i < 7; i++) {
      const { id } = await evidencia({
        id: `${f.fixture}-ev-${i}`,
        orderId: venta.id,
        requestId: solicitud.requestId,
        terminalId: i === 6 ? principal.id : otra.id,
      })
      ids.push(id)
    }
    const filas = await prisma.$queryRaw<{ requestId: string; evidenciaIds: string[] | null }[]>`
      SELECT r."requestId", colision."ids" AS "evidenciaIds"
      FROM "TerminalPaymentRequest" r
      LEFT JOIN LATERAL (
        SELECT array_agg(c."id") AS "ids" FROM (${evidenciaDeConciliacionDeLaFilaSql('r')} ORDER BY 1 LIMIT 5) c
      ) colision ON true
      WHERE r."requestId" = ${solicitud.requestId} AND r."venueId" = ${f.venueId}`
    // Prisma devuelve el `text[]` como arreglo de JS: es lo que el recorrido consume.
    expect(Array.isArray(filas[0].evidenciaIds)).toBe(true)
    // Acotado al tope y determinista: las 5 primeras por id, de las 7 que existen.
    expect(filas[0].evidenciaIds).toEqual([...ids].sort().slice(0, 5))
  })

  it('control: sin ninguna evidencia el conjunto es NULL — el mismo filtro `IS NOT NULL` de antes', async () => {
    const { solicitud } = await liberadaPorLaVentana()
    const filas = await prisma.$queryRaw<{ evidenciaIds: string[] | null }[]>`
      SELECT colision."ids" AS "evidenciaIds"
      FROM "TerminalPaymentRequest" r
      LEFT JOIN LATERAL (
        SELECT array_agg(c."id") AS "ids" FROM (${evidenciaDeConciliacionDeLaFilaSql('r')} ORDER BY 1 LIMIT 5) c
      ) colision ON true
      WHERE r."requestId" = ${solicitud.requestId} AND r."venueId" = ${f.venueId}`
    expect(filas).toHaveLength(1)
    expect(filas[0].evidenciaIds).toBeNull()
  })
})

describe('Ronda 4 · P1-C: la afirmación de la terminal, sin Payment y diferida, también tiene red', () => {
  const unSuccess = (requestId: string) => ({ requestId, status: 'success' as const, transactionId: '260917120000' })

  it('🔴 (a) la re-retención se DIFIERE: el POS no oye «puedes volver a cobrar» y la red la retiene en la pasada siguiente', async () => {
    const { solicitud, venta } = await liberadaPorLaVentana()
    const diferida = jest
      .spyOn(terminalPaymentService as any, 'retenerSolicitudLiberadaPorAfirmacionDeLaTerminal')
      .mockImplementationOnce(async () => 'DEFERRED')
    try {
      const resultado = await (terminalPaymentService as any).closeRow(solicitud.requestId, f.venueId, unSuccess(solicitud.requestId))
      // El piso de seguridad: con una AFIRMACIÓN en la mano la respuesta nunca puede ser «no se cobró».
      expect(resultado.status).toBe('timeout')
      expect(String(resultado.errorMessage)).not.toMatch(/volver a cobrar/)
      // La fila sigue liberada (eso es el diferimiento), pero la afirmación YA es durable: es lo que la red usa de selector.
      const antes = await fila(solicitud.requestId)
      expect(antes).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
      expect(antes.resultJson).toMatchObject({ claimedSuccess: { transactionId: '260917120000' } })
    } finally {
      diferida.mockRestore()
    }

    const r = await terminalPaymentService.reconcileUnknownRequests(new Date())
    expect(r.heldWithoutPayment).toBeGreaterThanOrEqual(1)
    const retenidaR = await retenida(solicitud.requestId, venta.id)
    expect(retenidaR.resultJson).toMatchObject({
      terminalClaimedSuccessAfterRelease: { reason: 'TERMINAL_CLAIMED_SUCCESS', origen: 'BARRIDO_SENALES' },
    })
    expect(await asientos(retenidaR.id, AFIRMACION)).toHaveLength(1)
    // Sin un solo Payment en toda la venta: la señal que la red de la ronda 3 no podía ver.
    expect(await prisma.payment.count({ where: { venueId: f.venueId, orderId: venta.id } })).toBe(0)
  })

  it('🔴 (b) la CARRERA: otro proceso retiene entre las dos lecturas y el POS recibe la fila RETENIDA, no la anterior', async () => {
    const { solicitud, venta } = await liberadaPorLaVentana()
    const real = (terminalPaymentService as any).retenerSolicitudLiberadaPorAfirmacionDeLaTerminal.bind(terminalPaymentService)
    const perdedor = jest
      .spyOn(terminalPaymentService as any, 'retenerSolicitudLiberadaPorAfirmacionDeLaTerminal')
      .mockImplementationOnce(async (input: any) => {
        await real(input) // OTRO proceso gana la carrera y retiene la fila DE VERDAD
        return 'NOT_APPLICABLE' // y el núcleo le contesta esto a ESTA llamada: ya no la ve liberada
      })
    try {
      const resultado = await (terminalPaymentService as any).closeRow(solicitud.requestId, f.venueId, unSuccess(solicitud.requestId))
      expect(resultado.status).toBe('timeout')
      expect(String(resultado.errorMessage)).toMatch(/se está revisando/)
      expect(String(resultado.errorMessage)).not.toMatch(/volver a cobrar/)
    } finally {
      perdedor.mockRestore()
    }
    await retenida(solicitud.requestId, venta.id)
  })
})

describe('Ronda 4 · P2: una comprobación que no se pudo hacer no autoriza a sellar', () => {
  it('🔴 si la lectura del vínculo revienta, el backfill NO sella (el evento sigue PENDING para el worker)', async () => {
    const { solicitud, venta, attemptId } = await liberadaPorLaVentana()
    const pago = await pagoDelIntento({ attemptId, orderId: venta.id, terminalId: otra.id })
    const evento = await eventoPendiente(attemptId)
    // Sólo la lectura del VÍNCULO que hace `retenerLiberadasPorPagoSinLigar` (su `select` la identifica); el resto normal.
    const original = prisma.terminalPaymentAttemptLink.findUnique.bind(prisma.terminalPaymentAttemptLink)
    const rota = jest
      .spyOn(prisma.terminalPaymentAttemptLink, 'findUnique')
      .mockImplementation((args: any) =>
        args?.select?.requestId === true && args?.select?.venueId === true
          ? (Promise.reject(new Error('pool agotado')) as any)
          : original(args),
      )
    try {
      await reconcileAngelPayWebhookForPayment({
        id: pago.id,
        idempotencyKey: attemptId,
        referenceNumber: null,
        venueId: f.venueId,
        amount: 100,
        tipAmount: 0,
        merchantAccountId: f.merchantId,
      })
      expect(await exigir(prisma.providerEventLog.findUnique({ where: { id: evento.id } }))).toMatchObject({
        status: 'PENDING',
        paymentId: null,
      })
      expect(await fila(solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
    } finally {
      rota.mockRestore()
    }
    // Y la red durable la recupera igual: el Payment ligado sigue ahí. Se envejece para que el barrido de 30 min NO la
    // alcance y sea la RED —la que no depende de esa ventana— la que la retenga.
    await envejecer(solicitud.id, 180)
    expect((await terminalPaymentService.reconcileUnknownRequests(new Date())).heldWithLinkedPayment).toBeGreaterThanOrEqual(1)
    await retenida(solicitud.requestId, venta.id)
  })

  it('control: con el vínculo legible y sin nada que retener, el backfill SÍ sella', async () => {
    const venta = await f.nuevaVenta(100)
    const attemptId = randomUUID()
    const pago = await pagoDelIntento({ attemptId, orderId: venta.id, terminalId: (await terminalPrincipal()).id })
    const evento = await eventoPendiente(attemptId)
    await reconcileAngelPayWebhookForPayment({
      id: pago.id,
      idempotencyKey: attemptId,
      referenceNumber: null,
      venueId: f.venueId,
      amount: 100,
      tipAmount: 0,
      merchantAccountId: f.merchantId,
    })
    expect(await exigir(prisma.providerEventLog.findUnique({ where: { id: evento.id } }))).toMatchObject({ status: 'PROCESSED' })
  })
})
