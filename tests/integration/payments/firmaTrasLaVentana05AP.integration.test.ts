/**
 * F1 · salida del gerente para el `05AP` (20-nov, `decisiones-codigo-r1.md` «20-nov 06:30») — contra Postgres REAL.
 *
 * El historial de AngelPay trae la venta de un intento en duda SIN aprobar (`05AP`: llegó al procesador, el banco no contestó). La N86
 * conserva la marca de lectura y la TARJETA de esa cuenta sigue frenada en esa terminal, aunque la ventana del SERVIDOR ya soltó la
 * solicitud (`FAILED / NO_EVIDENCE_AFTER_WINDOW`). Antes el gerente no podía firmar («un FAILED ya acreditado no se declara») y esa
 * tarjeta quedaba frenada SIN salida. Ahora la firma —el MISMO PIN y el MISMO permiso de siempre— deja el asiento con la persona
 * (comprobante de persona, `UNCHARGED_VERIFIED`) SIN cambiar el estado financiero de la solicitud: sigue liberada por la ventana, y si
 * el aprobado llega tarde se aplica lo de siempre con una fila liberada (un solo `Payment`).
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { UNPROVEN_NEGATIVE_WINDOW_MS, terminalPaymentService } from '@/services/terminal-payment.service'
import { utcTs } from '@/utils/sqlDates'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { crearFixture, exigir, exigirBaseDesechable, type Fixture } from './webhookCheckpoint.fixture'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), emitDurableTerminalPaymentResult: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

const ASIENTO = 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED'
const PIN_CAJERO = '135792'
let f: Fixture
let cajeroConPin: { id: string }

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('firma05ap')
  // A8: la ventana sólo escribe «no se cobró» donde el aviso del banco de la terminal está comprobado (el caso de Testarudo).
  await f.conAvisoDelBancoComprobado()
  cajeroConPin = await prisma.staff.create({
    data: {
      email: `${f.fixture}-cajero-pin@example.test`,
      firstName: 'Cajera',
      lastName: 'Con PIN',
      organizations: { create: { organizationId: f.fixture, role: 'MEMBER', isPrimary: true, isActive: true } },
      venues: { create: { venueId: f.venueId, role: 'CASHIER', active: true, pin: PIN_CAJERO } },
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
  const programadas = (terminalPaymentService as any).ventanasProgramadas as Map<string, NodeJS.Timeout> | undefined
  for (const t of programadas?.values() ?? []) clearTimeout(t)
  programadas?.clear()
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await prisma.notification.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
})
afterAll(async () => {
  await prisma.staffVenue.deleteMany({ where: { staffId: cajeroConPin.id } })
  await prisma.staffOrganization.deleteMany({ where: { staffId: cajeroConPin.id } })
  await prisma.staff.deleteMany({ where: { id: cajeroConPin.id } })
  await f.destruir()
})

const fila = (requestId: string) => exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))
const asientos = () => prisma.activityLog.findMany({ where: { venueId: f.venueId, action: ASIENTO } })

/** POS → N86: la terminal contestó sin respuesta del banco y la VENTANA soltó la solicitud (`FAILED / NO_EVIDENCE_AFTER_WINDOW`). */
async function liberadaPorLaVentana() {
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
      terminalResult: { status: 'failed', errorMessage: 'G505 sin respuesta del banco', outcomeEvidence: null },
    },
  })
  await prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "updatedAt" = ${utcTs(
    new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000),
  )} WHERE "id" = ${solicitud.id}`
  const attemptId = randomUUID()
  await prisma.terminalPaymentAttemptLink.create({
    data: { attemptId, requestId: solicitud.requestId, venueId: f.venueId, terminalId: f.llaveTerminal },
  })
  expect(await terminalPaymentService.releaseUnprovenNegative(solicitud.requestId, f.venueId, 'WATCHDOG')).toBe('RELEASED')
  const liberada = await fila(solicitud.requestId)
  expect(liberada).toMatchObject({
    status: 'FAILED',
    failureCode: 'NO_EVIDENCE_AFTER_WINDOW',
    paymentId: null,
    operatorReconciliation: null,
  })
  return { requestId: solicitud.requestId, attemptId, venta, liberada }
}

/** La firma desde «Por revisar» de la terminal (la MISMA ruta de la declaración del banner). */
function firmar(requestId: string, pin: string | undefined, resolutionId = randomUUID()) {
  return terminalPaymentService.releaseUnknownRequest({
    requestId,
    venueId: f.venueId,
    actor: { staffId: f.staffId, source: 'TPV' },
    reason: 'Liberada desde la terminal',
    declaration: { requestId, resolutionId, statement: 'UNCHARGED_VERIFIED', statementVersion: 1, supervisorPin: pin },
  })
}

describe('firma del gerente sobre una venta que la VENTANA ya soltó (la N86 la sigue frenando por el 05AP)', () => {
  it('PIN de gerente ⇒ 2xx con comprobante de PERSONA, asiento con su nombre y el estado financiero intacto', async () => {
    const { requestId, attemptId, venta, liberada } = await liberadaPorLaVentana()
    const resolutionId = randomUUID()

    const r = await firmar(requestId, f.gerente.pin, resolutionId)

    expect(r.released).toBe(true)
    expect(r.declarationReceipt).toMatchObject({
      id: resolutionId,
      kind: 'UNCHARGED_VERIFIED',
      by: 'SUPERVISOR_PIN',
      staffId: f.gerente.staffId,
      scope: 'REQUEST',
      requestId,
      humanSignature: true,
      alreadyStored: false,
    })
    // El estado financiero NO se mueve: sigue liberada por la ventana, con su sobre, sin Payment y con la misma hora.
    const despues = await fila(requestId)
    expect(despues).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW', paymentId: null })
    expect(despues.resultJson).toEqual(liberada.resultJson)
    expect(despues.updatedAt.getTime()).toBe(liberada.updatedAt.getTime())
    expect(despues.operatorReconciliation).toMatchObject({
      id: resolutionId,
      kind: 'UNCHARGED_VERIFIED',
      staffId: f.gerente.staffId,
      by: 'SUPERVISOR_PIN',
      sessionStaffId: f.staffId,
      source: 'TPV',
      previousRequest: { status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' },
    })
    // Un asiento, con la persona.
    const log = await asientos()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ staffId: f.gerente.staffId, entityId: despues.id })
    expect(log[0].data).toMatchObject({ requestId, resolutionId, previousStatus: 'FAILED', liberadaPorLaVentana: true })
    // Lo que lee la terminal: la proyección sigue siendo la de la ventana y el comprobante es de persona (S6 y GET por solicitud).
    const porSolicitud = await terminalPaymentService.consultarSolicitudDeTerminal({
      requestId,
      venueId: f.venueId,
      terminalSerial: f.serial,
    })
    expect(porSolicitud!.request).toMatchObject({ outcome: 'NOT_CHARGED', outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW' })
    expect(porSolicitud!.declarationReceipt).toEqual({ ...r.declarationReceipt, alreadyStored: true })
    const s6 = await terminalPaymentService.consultarIntentoDeTerminal({ attemptId, venueId: f.venueId, terminalSerial: f.serial })
    expect(s6!.request).toMatchObject({ outcome: 'NOT_CHARGED', outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW' })
    expect(s6!.declarationReceipt).toEqual({ ...r.declarationReceipt, alreadyStored: true })
    // Ni la ranura ni la orden se vuelven a retener.
    expect(await terminalPaymentService.isTerminalBusy(f.llaveTerminal, f.venueId)).toBe(false)
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, venta.id)).toBe(false)
  })

  it('PIN de cajero (o sin PIN) ⇒ el MISMO rechazo de siempre, nada escrito', async () => {
    const { requestId } = await liberadaPorLaVentana()
    await expect(firmar(requestId, PIN_CAJERO)).rejects.toMatchObject({ code: 'SUPERVISOR_AUTHORIZATION_REQUIRED', statusCode: 403 })
    await expect(firmar(requestId, undefined)).rejects.toMatchObject({ code: 'SUPERVISOR_AUTHORIZATION_REQUIRED', statusCode: 403 })
    expect((await fila(requestId)).operatorReconciliation).toBeNull()
    expect(await asientos()).toEqual([])
  })

  it('repetida (respuesta perdida, u otro gerente con el mismo id) ⇒ el MISMO comprobante; con otro id ⇒ RESOLUTION_CONFLICT', async () => {
    const { requestId } = await liberadaPorLaVentana()
    const resolutionId = randomUUID()
    const primera = await firmar(requestId, f.gerente.pin, resolutionId)
    const repetida = await firmar(requestId, f.gerente.pin, resolutionId)
    expect(repetida.released).toBe(true)
    expect(repetida.declarationReceipt).toEqual({ ...primera.declarationReceipt, alreadyStored: true })
    await expect(firmar(requestId, f.gerente.pin)).rejects.toMatchObject({ code: 'RESOLUTION_CONFLICT' })
    expect(await asientos()).toHaveLength(1)
  })

  it('con dinero del intento (un Payment con su llave) ⇒ POSITIVE_EVIDENCE_EXISTS, como hoy', async () => {
    const { requestId, attemptId, venta } = await liberadaPorLaVentana()
    await prisma.payment.create({
      data: {
        venueId: f.venueId,
        orderId: venta.id,
        amount: 100,
        method: 'CREDIT_CARD',
        status: 'PENDING',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 100,
        idempotencyKey: attemptId,
      },
    })
    await expect(firmar(requestId, f.gerente.pin)).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
    expect((await fila(requestId)).operatorReconciliation).toBeNull()
    expect(await asientos()).toEqual([])
  })

  it('con el APROBADO del procesador sin Payment (veto) ⇒ POSITIVE_EVIDENCE_EXISTS, como hoy', async () => {
    const { requestId, attemptId } = await liberadaPorLaVentana()
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        eventId: `angelpay-${f.nuevoEventId()}`,
        type: 'send_transaction',
        payload: f.eventoAngelPay(attemptId, { amount: '000000009900' }) as never,
        venueId: f.venueId,
        status: 'PENDING',
        errorReason: 'AMOUNT_MISMATCH',
        attemptId,
      },
    })
    await expect(firmar(requestId, f.gerente.pin)).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
    expect((await fila(requestId)).operatorReconciliation).toBeNull()
  })

  it('otro «no se cobró» ya acreditado por el procesador (BANK_DECLINED) ⇒ ATTEMPT_NOT_ELIGIBLE, como hoy', async () => {
    const venta = await f.nuevaVenta(100)
    const solicitud = await f.solicitud({
      orderId: venta.id,
      status: 'FAILED',
      failureCode: 'BANK_DECLINED',
      acknowledgedAt: new Date(),
      expiresAt: new Date(Date.now() - 60_000),
      resultJson: { requestId: 'x', status: 'failed', outcomeEvidence: 'BANK_DECLINED', errorMessage: 'El banco rechazó este cobro.' },
    })
    await prisma.terminalPaymentAttemptLink.create({
      data: { attemptId: randomUUID(), requestId: solicitud.requestId, venueId: f.venueId, terminalId: f.llaveTerminal },
    })
    await expect(firmar(solicitud.requestId, f.gerente.pin)).rejects.toMatchObject({ code: 'ATTEMPT_NOT_ELIGIBLE' })
    expect((await fila(solicitud.requestId)).operatorReconciliation).toBeNull()
  })

  it('el aprobado llega DESPUÉS de la firma (aviso del banco y registro de la terminal) ⇒ exactamente UN Payment, y se le avisa a quien firmó', async () => {
    const { requestId, attemptId, venta } = await liberadaPorLaVentana()
    const firma = await firmar(requestId, f.gerente.pin)

    const eventId = f.nuevoEventId()
    const aviso = await processAngelPayWebhook({
      payload: f.eventoAngelPay(attemptId),
      eventId,
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    })
    expect(aviso).toMatchObject({ action: 'CONFIRMED' })
    // La terminal registra el MISMO cobro por REST con la llave del intento (su recuperación tras el `05AP` → aprobada).
    const porRest = await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId, requestId }), f.staffId)

    const pagos = await prisma.payment.findMany({ where: { venueId: f.venueId } })
    expect(pagos).toHaveLength(1)
    expect(pagos[0]).toMatchObject({ status: 'COMPLETED', idempotencyKey: attemptId, orderId: venta.id })
    expect(porRest.id).toBe(pagos[0].id)
    const r = await fila(requestId)
    expect(r).toMatchObject({ status: 'COMPLETED', paymentId: pagos[0].id })
    // La firma queda como historia; el aprobado tardío se trata como con cualquier fila liberada por la ventana.
    expect(r.operatorReconciliation).toMatchObject({ id: firma.declarationReceipt!.id, staffId: f.gerente.staffId })
    expect(await prisma.activityLog.count({ where: { venueId: f.venueId, action: 'TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW' } })).toBe(1)
    // Quien firmó «no se cobró» se entera en su aparato: no lo vuelvan a cobrar.
    expect(
      await f.esperar(
        async () => (await prisma.notification.count({ where: { venueId: f.venueId, recipientId: f.gerente.staffId } })) === 1,
      ),
    ).toBe(true)
  })

  it('control: una liberada por la ventana SIN firma no avisa a nadie en particular cuando llega el aprobado', async () => {
    const { attemptId } = await liberadaPorLaVentana()
    await processAngelPayWebhook({
      payload: f.eventoAngelPay(attemptId),
      eventId: f.nuevoEventId(),
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    })
    expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(1)
    await new Promise(r => setTimeout(r, 300))
    expect(await prisma.notification.count({ where: { venueId: f.venueId } })).toBe(0)
  })
})
