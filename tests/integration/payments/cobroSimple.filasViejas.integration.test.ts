/**
 * Cobro simple · S1.4 (las filas de antes de S1) y S1.5 (el rechazo de AngelPay sin el núcleo de la declaración) — Postgres REAL.
 *
 * S1.4: al publicar S1, lo que quedó «en duda» con las reglas viejas (UNKNOWN sin reloj, `TIMED_OUT` sin código o soltada por
 * política) lo cierra el vigía con la MISMA regla de los 10 s, con asiento `historico: true`. Medido el 22-nov en producción (Q1): 1
 * fila (de un negocio, `TIMED_OUT/AUTO_RELEASED`, 8-sep). Nunca reescribe una fila ya final.
 * S1.5: el rechazo del banco por aviso de AngelPay es un CAS directo a `FAILED/BANK_DECLINED` FUERA de vuelo (Codex S1 r2, R2-6: en
 * vuelo la Nexgo reintenta dentro de la misma solicitud), con dos guardas: el intento B abierto y el aprobado ya conocido.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { crearFixture, exigirBaseDesechable, exigir, type Fixture } from './webhookCheckpoint.fixture'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

const svc = terminalPaymentService as any
let f: Fixture

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('cs1v')
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(async () => {
  for (const t of (svc.cierresSinRespuesta as Map<string, NodeJS.Timeout>).values()) clearTimeout(t)
  svc.cierresSinRespuesta.clear()
  await prisma.notification.deleteMany({ where: { venueId: f.venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
})
afterAll(() => f.destruir())

const fila = (requestId: string) => exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))
const vieja = (dias: number) => new Date(Date.now() - dias * 24 * 60 * 60_000)
const alUpdatedAt = (id: string, d: Date) => prisma.terminalPaymentRequest.update({ where: { id }, data: { updatedAt: d } })
const intento = async (requestId: string) => {
  const attemptId = randomUUID()
  await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId, venueId: f.venueId, terminalId: f.llaveTerminal } })
  return attemptId
}
const rechazo = (attemptId: string, description = '51 FONDOS INSUFICIENTES') =>
  processAngelPayWebhook({
    payload: f.eventoAngelPay(attemptId, { status: 'rejected', description }),
    eventId: f.nuevoEventId(),
    merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
    retryDelaysMs: [0],
  })

describe('S1.4 · filas viejas: el vigía las cierra con la misma regla', () => {
  it('una TIMED_OUT/AUTO_RELEASED de hace 3 días queda NOT_CHARGED (asiento histórico) y su cuenta se puede cancelar', async () => {
    const venta = await f.nuevaVenta(308)
    const s = await f.solicitud({ orderId: venta.id, status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', amountCents: 30800, createdAt: vieja(3) })
    await alUpdatedAt(s.id, vieja(3))
    await terminalPaymentService.cerrarSinRespuestaVencidas(new Date())
    expect(await terminalPaymentService.getPaymentStatus(s.requestId, f.venueId)).toMatchObject({
      status: 'FAILED',
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW',
      noChargeCause: 'NO_RESPONSE',
    })
    const [asiento] = await prisma.activityLog.findMany({ where: { venueId: f.venueId, action: 'TERMINAL_PAYMENT_CLOSED_NO_RESPONSE', entityId: s.id } })
    expect(asiento.data).toMatchObject({ historico: true, priorStatus: 'TIMED_OUT', priorFailureCode: 'AUTO_RELEASED' })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, venta.id)).toBe(false)
  })

  it('una UNKNOWN vieja (sin reloj) con su Payment reconciliable queda COMPLETED, no «no cobrada»', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await f.solicitud({ orderId: venta.id, status: 'UNKNOWN', failureCode: 'TIMED_OUT', createdAt: vieja(1) })
    await alUpdatedAt(s.id, vieja(1))
    // El cobro entró por una cola vieja: etiquetado sólo en `processorData` (sin la llave del intento ni el requestId del registro).
    const pago = await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true }), f.staffId)
    const actual = await exigir(prisma.payment.findUnique({ where: { id: pago.id } }))
    await prisma.payment.update({
      where: { id: pago.id },
      data: { processorData: { ...((actual.processorData as object) ?? {}), terminalPaymentRequestId: s.requestId } },
    })
    await terminalPaymentService.cerrarSinRespuestaVencidas(new Date())
    expect(await fila(s.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id })
  })

  it('nunca reescribe una fila COMPLETED, FAILED con código final ni CANCELLED aceptada', async () => {
    const completada = await f.solicitud({ status: 'COMPLETED', paymentId: 'pay-x', createdAt: vieja(2) })
    const rechazada = await f.solicitud({ status: 'FAILED', failureCode: 'BANK_DECLINED', createdAt: vieja(2) })
    const cancelada = await f.solicitud({ status: 'CANCELLED', cancelDisposition: 'ACCEPTED', createdAt: vieja(2) })
    for (const r of [completada, rechazada, cancelada]) await alUpdatedAt(r.id, vieja(2))
    await terminalPaymentService.cerrarSinRespuestaVencidas(new Date())
    expect(await fila(completada.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: 'pay-x' })
    expect(await fila(rechazada.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'BANK_DECLINED' })
    expect(await fila(cancelada.requestId)).toMatchObject({ status: 'CANCELLED', cancelDisposition: 'ACCEPTED' })
    expect(await prisma.activityLog.count({ where: { venueId: f.venueId, action: 'TERMINAL_PAYMENT_CLOSED_NO_RESPONSE' } })).toBe(0)
  })

  it('una retenida con un aprobado conocido (`BANK_APPROVED_AWAITING_PAYMENT`) no se toca y sigue cercando su cuenta', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await f.solicitud({ orderId: venta.id, status: 'TIMED_OUT', failureCode: 'BANK_APPROVED_AWAITING_PAYMENT', createdAt: vieja(1) })
    await alUpdatedAt(s.id, vieja(1))
    await terminalPaymentService.cerrarSinRespuestaVencidas(new Date())
    expect(await fila(s.requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: 'BANK_APPROVED_AWAITING_PAYMENT' })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, venta.id)).toBe(true)
  })
})

/** Una solicitud fuera de vuelo: en sus 10 s de «sin respuesta». */
const enSusDiezSegundos = () => f.solicitud({ status: 'UNKNOWN', noResponseAt: new Date(), acknowledgedAt: new Date() })
const tpv = () => ({ socketId: 'socket-tpv', terminalId: f.serial, venueId: f.venueId })

describe('S1.5 · el rechazo de AngelPay es un CAS directo fuera de vuelo, con sus dos guardas', () => {
  it('Codex S1 r2 (R2-6) · rechazo con la solicitud EN VUELO no la cierra y la terminal puede reintentar (el intento B sigue autorizado)', async () => {
    const s = await f.solicitud({ status: 'SENT', acknowledgedAt: new Date() })
    const a = await intento(s.requestId)
    await rechazo(a)
    expect(await fila(s.requestId)).toMatchObject({ status: 'SENT' })
    // «Reintentar» de la Nexgo 2.20: el intento B dentro de la MISMA solicitud sigue autorizado.
    expect(await terminalPaymentService.handleAttemptOpenedFromSocket({ requestId: s.requestId, attemptId: randomUUID() }, tpv())).toMatchObject({
      success: true,
      executionAuthorized: true,
    })
  })

  it('Codex S1 r2 (R2-6) · …y al entrar a «sin respuesta», el rechazo guardado de su único intento la cierra BANK_DECLINED con su motivo', async () => {
    const sola = await f.solicitud({ status: 'SENT', acknowledgedAt: new Date() })
    const unico = await intento(sola.requestId)
    await rechazo(unico)
    expect(await fila(sola.requestId)).toMatchObject({ status: 'SENT' })
    expect(await svc.entrarSinRespuestaYProgramar(sola.requestId, f.venueId, 'NO_RESPONSE')).toBe(true)
    expect(await fila(sola.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'BANK_DECLINED', lateResult: true })
    expect(await terminalPaymentService.getPaymentStatus(sola.requestId, f.venueId)).toMatchObject({
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'PROCESSOR_DECLINED',
      errorMessage: 'El banco rechazó este cobro. No tiene fondos suficientes. No se cobró nada: puedes volver a cobrar.',
    })
  })

  it('el rechazo del intento A con el intento B abierto NO cierra (B pudo cobrar)', async () => {
    const s = await enSusDiezSegundos()
    const a = await intento(s.requestId)
    await intento(s.requestId)
    await rechazo(a)
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN' })
  })

  it('un rechazo repetido no reescribe ni re-audita', async () => {
    const s = await enSusDiezSegundos()
    const attemptId = await intento(s.requestId)
    await rechazo(attemptId)
    const primera = await fila(s.requestId)
    await rechazo(attemptId, '05 DECLINADA')
    const segunda = await fila(s.requestId)
    expect(segunda.updatedAt.getTime()).toBe(primera.updatedAt.getTime())
    expect(segunda.resultJson).toEqual(primera.resultJson)
    expect(
      await prisma.activityLog.count({ where: { venueId: f.venueId, action: 'TERMINAL_PAYMENT_BANK_DECLINED_RELEASED', entityId: s.id } }),
    ).toBe(1)
  })
})

describe('Codex S1 r1 · arreglos', () => {
  const aprobadoGuardado = async (attemptId: string) =>
    prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        type: 'send_transaction',
        eventId: `angelpay-${f.nuevoEventId()}`,
        venueId: f.venueId,
        attemptId,
        payload: f.eventoAngelPay(attemptId),
      } as any,
    })

  it('#1 · una TIMED_OUT vieja con un aprobado conocido pasa a UNKNOWN y su cuenta queda cercada (no se vuelve a cobrar)', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await f.solicitud({ orderId: venta.id, status: 'TIMED_OUT', failureCode: null, createdAt: vieja(1) })
    await aprobadoGuardado(await intento(s.requestId))
    await alUpdatedAt(s.id, vieja(1))
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, venta.id)).toBe(false)
    await terminalPaymentService.cerrarSinRespuestaVencidas(new Date())
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, venta.id)).toBe(true)
  })

  it('#10 · una CANCELLED sin ACCEPTED y una FAILED sin código acreditado viejas convergen a «no cobrado»', async () => {
    const cancelada = await f.solicitud({ status: 'CANCELLED', cancelDisposition: null, createdAt: vieja(2) })
    const fallida = await f.solicitud({ status: 'FAILED', failureCode: 'TPV_ERROR', createdAt: vieja(2) })
    for (const r of [cancelada, fallida]) await alUpdatedAt(r.id, vieja(2))
    await terminalPaymentService.cerrarSinRespuestaVencidas(new Date())
    for (const r of [cancelada, fallida])
      expect(await terminalPaymentService.getPaymentStatus(r.requestId, f.venueId)).toMatchObject({ status: 'FAILED', outcome: 'NOT_CHARGED' })
  })

  it('#5 · dos rechazos confirmados (A y B) cierran como rechazo del banco, con su motivo', async () => {
    const s = await enSusDiezSegundos()
    const a = await intento(s.requestId)
    const b = await intento(s.requestId)
    await rechazo(a)
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN' })
    await rechazo(b)
    expect(await fila(s.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'BANK_DECLINED' })
  })

  it('#3 · el aprobado tardío sobre una liberada que se RE-RETUVO también avisa al dueño (asiento de aprobado tardío)', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await f.solicitud({
      orderId: venta.id,
      status: 'TIMED_OUT',
      failureCode: 'BANK_APPROVED_AWAITING_PAYMENT',
      resultJson: { status: 'failed', releasedAfterWindow: { windowMs: 10000, releasedAt: new Date(Date.now() - 60_000).toISOString() } },
    })
    const attemptId = await intento(s.requestId)
    await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId, requestId: s.requestId }), f.staffId)
    expect(await fila(s.requestId)).toMatchObject({ status: 'COMPLETED' })
    expect(
      await prisma.activityLog.count({ where: { venueId: f.venueId, action: 'TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW', entityId: s.id } }),
    ).toBe(1)
  })
})
