/**
 * Cobro simple · S1 (founder, 22-nov-2026, «A todo automático») — contra Postgres REAL.
 *
 * La promesa: al cobrar con tarjeta manda lo que contesta el procesador. Aprobado o rechazado, al momento. SÓLO sin respuesta (la
 * terminal no dio veredicto, no acusó, se fue o no contestó al cancel) la cuenta espera a lo más 10 s el aviso del banco; si no llega,
 * queda «no cobrada» sola, con la forma que todas las apps de la calle pintan como «puedes volver a cobrar»
 * (`FAILED / NO_EVIDENCE_AFTER_WINDOW`, `NOT_CHARGED`, `cancelDisposition` null) y la causa en `noChargeCause`. La terminal no se
 * aparta por la duda. Un aprobado que llegue después se registra (una vez) y avisa al dueño. Nadie declara ni pone PIN.
 *
 * El reloj: `entrarSinRespuestaYProgramar` acepta `ahora` (el sello `noResponseAt` es del reloj del servidor) y `cerrarSinRespuesta`
 * recibe `ahora`; así se simula el paso de los 10 s sin dormir. Un par de pruebas esperan el temporizador REAL con 10 s acortados
 * por `TERMINAL_PAYMENT_SIN_RESPUESTA_MS` (sólo fuera de producción).
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { avisarAprobadoTardioDeLaSolicitud } from '@/services/tpv/avisoDeCobroTardio'
import { Prisma } from '@prisma/client'
import { TerminalBusyError } from '@/errors/AppError'
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
const SOCKET = 'socket-tpv'
const DIEZ_S = 10_000
let f: Fixture
let directEmit: jest.Mock
let cancelEmit: jest.Mock
let duenaId: string
let conectada = true

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('cs1')
  const duena = await prisma.staff.create({
    data: {
      email: `${f.fixture}-duena@example.test`,
      firstName: 'Dueña',
      lastName: 'S1',
      venues: { create: { venueId: f.venueId, role: 'OWNER', active: true } },
    },
    select: { id: true },
  })
  duenaId = duena.id
})

beforeEach(() => {
  jest.clearAllMocks()
  conectada = true
  directEmit = jest.fn((_evento: string, _payload: unknown, ack?: (err: Error | null, r?: unknown) => void) => {
    const p = _payload as { requestId?: string }
    ack?.(null, { accepted: true, requestId: p?.requestId })
  })
  cancelEmit = jest.fn()
  const socket = { emit: directEmit, timeout: () => ({ emit: directEmit }) }
  ;(socketManager.getServer as jest.Mock).mockReturnValue({
    sockets: { sockets: new Map([[SOCKET, socket]]) },
    to: () => ({ emit: cancelEmit }),
  })
  // Una TPV 2.16 / 2.20 en línea: acusa (ackVersion 1) y contesta la sonda.
  ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) =>
    conectada
      ? {
          terminalId,
          venueId: f.venueId,
          socketId: SOCKET,
          identityVerified: true,
          terminalPaymentAckVersion: 1,
          terminalPaymentCancelDispositionVersion: 2,
          terminalPaymentProbeVersion: 1,
          terminalPaymentExecutionVersion: 1,
        }
      : undefined,
  )
})

afterEach(async () => {
  for (const mapa of [svc.cierresSinRespuesta, svc.desconexiones] as Map<string, NodeJS.Timeout>[]) {
    for (const t of mapa.values()) clearTimeout(t)
    mapa.clear()
  }
  for (const [id, p] of svc.pendingPayments as Map<string, { resolve: (r: unknown) => void; timeout: NodeJS.Timeout }>) {
    clearTimeout(p.timeout)
    svc.pendingPayments.delete(id)
    p.resolve({ requestId: id, status: 'timeout' })
  }
  svc.preguntasSinFinal.clear()
  svc.activasTrasPregunta?.clear()
  svc.sinConexionVista?.clear()
  delete process.env.TERMINAL_PAYMENT_SIN_RESPUESTA_MS
  await prisma.notification.deleteMany({ where: { venueId: f.venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
})
afterAll(async () => {
  await prisma.staffVenue.deleteMany({ where: { staffId: duenaId } })
  await prisma.staff.deleteMany({ where: { id: duenaId } })
  await f.destruir()
})

const fila = (requestId: string) => exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))
const tpv = () => ({ socketId: SOCKET, terminalId: f.serial, venueId: f.venueId, terminalPaymentExecutionVersion: 1 })
const ocupada = () => terminalPaymentService.isTerminalBusy(f.llaveTerminal, f.venueId)
const cercada = (orderId: string) => terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, orderId)
const hace = (ms: number) => new Date(Date.now() - ms)
const enDiezS = () => new Date(Date.now() + DIEZ_S + 50)
const asientos = (action: string) => prisma.activityLog.findMany({ where: { venueId: f.venueId, action } })
const esperar = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Un intento que la terminal abrió y ligó a la solicitud (Nexgo/AngelPay). */
const intento = async (requestId: string) => {
  const attemptId = randomUUID()
  await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId, venueId: f.venueId, terminalId: f.llaveTerminal } })
  return attemptId
}
const webhook = (attemptId: string, over: Record<string, unknown> = {}) =>
  processAngelPayWebhook({
    payload: f.eventoAngelPay(attemptId, over),
    eventId: f.nuevoEventId(),
    merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
    retryDelaysMs: [0],
  })
/** La forma «no cobrado» que pintan ANDROID 2.22/2.25.29/actual, TPV ≥ 2.11.1 e iOS 1.13 como «puedes volver a cobrar». */
const NO_COBRADO = { status: 'FAILED', outcome: 'NOT_CHARGED', outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW', cancelDisposition: null }

describe('S1.1 · la ranura sólo mientras el cobro está en vuelo; la cuenta, también en sus 10 s', () => {
  it('una fila UNKNOWN no aparta la terminal (otra venta entra a la misma terminal) pero sí cerca SU cuenta (409 ORDER)', async () => {
    const venta = await f.nuevaVenta(100)
    const enDuda = await f.solicitud({ orderId: venta.id, status: 'UNKNOWN', noResponseAt: new Date() })
    expect(await ocupada()).toBe(false)
    // El índice parcial ya no incluye UNKNOWN: una SENT nueva en la misma terminal cabe.
    const otra = await f.solicitud({ status: 'SENT' })
    expect(await ocupada()).toBe(true)
    await prisma.terminalPaymentRequest.delete({ where: { id: otra.id } })
    expect(await cercada(venta.id)).toBe(true)
    const misma = terminalPaymentService.sendPaymentToTerminal({
      terminalId: f.serial,
      venueId: f.venueId,
      amountCents: 10000,
      orderId: venta.id,
      requestedBy: f.staffId,
      requestId: randomUUID(),
    })
    await expect(misma).rejects.toBeInstanceOf(TerminalBusyError)
    await expect(misma).rejects.toMatchObject({ details: expect.objectContaining({ scope: 'ORDER' }) })
    expect(enDuda.status).toBe('UNKNOWN')
  })

  it('una TIMED_OUT/AUTO_RELEASED vieja cerca la cuenta hasta que el barrido la cierra; después ya no (nadie la declara)', async () => {
    const venta = await f.nuevaVenta(100)
    const vieja = await f.solicitud({ orderId: venta.id, status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
    expect(await ocupada()).toBe(false)
    expect(await cercada(venta.id)).toBe(true)
    await terminalPaymentService.cerrarSinRespuestaVencidas(enDiezS())
    expect(await fila(vieja.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
    expect(await cercada(venta.id)).toBe(false)
  })

  it('Codex S1 r2 (R2-2) · TIMED_OUT sin código con un aviso aprobado guardado y sin Payment: ANTES de cualquier barrido, otro cobro de esa cuenta ⇒ 409 ORDER', async () => {
    const venta = await f.nuevaVenta(100)
    const vieja = await f.solicitud({ orderId: venta.id, status: 'TIMED_OUT', failureCode: null })
    const attemptId = await intento(vieja.requestId)
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        type: 'send_transaction',
        eventId: `angelpay-${f.nuevoEventId()}`,
        venueId: f.venueId,
        attemptId,
        payload: f.eventoAngelPay(attemptId),
      } as any,
    })
    expect(await cercada(venta.id)).toBe(true)
    const otro = terminalPaymentService.sendPaymentToTerminal({
      terminalId: f.serial,
      venueId: f.venueId,
      amountCents: 10000,
      orderId: venta.id,
      requestedBy: f.staffId,
      requestId: randomUUID(),
    })
    await expect(otro).rejects.toMatchObject({ details: expect.objectContaining({ scope: 'ORDER' }) })
  })
})

describe('S1.2 · entrar a «sin respuesta» y cerrar a los 10 s', () => {
  it('G505 de la Nexgo (la terminal manda `timeout`): terminal libre al instante, cuenta cercada 10 s, luego «no cobrado» — también en un comercio SIN aviso comprobado (Q3)', async () => {
    // El fixture NO siembra `conAvisoDelBancoComprobado`: el comercio no tiene avisos recientes. S1 no tiene camino aparte para él.
    const venta = await f.nuevaVenta(100)
    const s = await f.solicitud({ orderId: venta.id, acknowledgedAt: new Date() })
    expect(await svc.handlePaymentResultFromSocket({ requestId: s.requestId, status: 'timeout', errorMessage: 'G505' }, tpv())).toBe(false)
    const enDuda = await fila(s.requestId)
    expect(enDuda).toMatchObject({ status: 'UNKNOWN' })
    expect(enDuda.noResponseAt).not.toBeNull()
    expect(enDuda.resultJson).toMatchObject({ noChargeCause: 'NO_RESPONSE', terminalResult: expect.objectContaining({ status: 'timeout' }) })
    expect(await ocupada()).toBe(false)
    expect(await cercada(venta.id)).toBe(true)
    // A los 9 s todavía no.
    expect(await terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId, new Date(Date.now() + 9_000))).toBe('NO_APLICA')
    expect(await terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId, enDiezS())).toBe('NO_COBRADO')
    expect(await terminalPaymentService.getPaymentStatus(s.requestId, f.venueId)).toMatchObject({ ...NO_COBRADO, noChargeCause: 'NO_RESPONSE' })
    expect(await fila(s.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
    expect(await cercada(venta.id)).toBe(false)
    expect(await asientos('TERMINAL_PAYMENT_CLOSED_NO_RESPONSE')).toHaveLength(1)
    // Repetir el cierre no reescribe ni re-audita.
    expect(await terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId, enDiezS())).toBe('NO_APLICA')
    expect(await asientos('TERMINAL_PAYMENT_CLOSED_NO_RESPONSE')).toHaveLength(1)
  })

  it('un `failed` SIN evidencia también es «sin respuesta» (no un rechazo): 10 s y «no cobrado»', async () => {
    const s = await f.solicitud({ acknowledgedAt: new Date() })
    await svc.handlePaymentResultFromSocket({ requestId: s.requestId, status: 'failed', errorMessage: 'U101' }, tpv())
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN' })
    expect(await terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId, enDiezS())).toBe('NO_COBRADO')
  })

  it('aviso APROBADO de AngelPay a los 4 s: COMPLETED con UN Payment, sin cierre «no cobrado»', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await f.solicitud({ orderId: venta.id, acknowledgedAt: new Date() })
    const attemptId = await intento(s.requestId)
    await svc.handlePaymentResultFromSocket({ requestId: s.requestId, status: 'timeout', errorMessage: 'G505' }, tpv())
    await webhook(attemptId)
    expect(await fila(s.requestId)).toMatchObject({ status: 'COMPLETED' })
    expect(await prisma.payment.count({ where: { venueId: f.venueId, orderId: venta.id } })).toBe(1)
    expect(await terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId, enDiezS())).toBe('NO_APLICA')
  })

  it('aviso RECHAZADO de AngelPay a los 4 s: FAILED/BANK_DECLINED con el motivo del banco', async () => {
    const s = await f.solicitud({ acknowledgedAt: new Date() })
    const attemptId = await intento(s.requestId)
    await svc.handlePaymentResultFromSocket({ requestId: s.requestId, status: 'timeout', errorMessage: 'G505' }, tpv())
    await webhook(attemptId, { status: 'rejected', description: '51 FONDOS INSUFICIENTES' })
    const r = await fila(s.requestId)
    expect(r).toMatchObject({ status: 'FAILED', failureCode: 'BANK_DECLINED' })
    expect(await terminalPaymentService.getPaymentStatus(s.requestId, f.venueId)).toMatchObject({
      outcome: 'NOT_CHARGED',
      errorMessage: expect.stringContaining('No tiene fondos suficientes'),
    })
  })

  it('sin acuse en 5 s: cancel a la terminal, el POS SIGUE esperando y a los 10 s recibe `failed` (422) con ACK_TIMEOUT — nunca 504', async () => {
    process.env.TERMINAL_PAYMENT_SIN_RESPUESTA_MS = '300'
    directEmit.mockImplementation((_e: string, _p: unknown, ack?: (err: Error | null) => void) => ack?.(new Error('operation has timed out')))
    const requestId = randomUUID()
    const respuesta = terminalPaymentService.sendPaymentToTerminal({
      terminalId: f.serial,
      venueId: f.venueId,
      amountCents: 10000,
      requestedBy: f.staffId,
      requestId,
    })
    // La admisión (alta, procedencia, emisión) puede tardar más de 100 ms con la máquina cargada: se espera al hecho, no al reloj.
    for (let i = 0; i < 100 && (await prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))?.status !== 'UNKNOWN'; i++) await esperar(20)
    expect(await fila(requestId)).toMatchObject({ status: 'UNKNOWN', failureCode: 'ACK_TIMEOUT' })
    expect(cancelEmit).toHaveBeenCalledWith('terminal:payment_cancel', expect.objectContaining({ requestId }))
    expect(await ocupada()).toBe(false)
    // El temporizador REAL (acortado) cierra y despierta al POS.
    const r = await respuesta
    expect(r).toMatchObject({ requestId, status: 'failed', outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW', noChargeCause: 'ACK_TIMEOUT' })
    expect(await terminalPaymentService.getPaymentStatus(requestId, f.venueId)).toMatchObject({ ...NO_COBRADO, noChargeCause: 'ACK_TIMEOUT' })
    // La réplica del MISMO POST tampoco dice `timeout` (el controlador lo haría 504).
    const replica = await terminalPaymentService.sendPaymentToTerminal({
      terminalId: f.serial,
      venueId: f.venueId,
      amountCents: 10000,
      requestedBy: f.staffId,
      requestId,
    })
    expect(replica.status).toBe('failed')
  })

  it('terminal desconectada 10 s con la solicitud SENT: entra a «sin respuesta» (TERMINAL_GONE) y luego «no cobrado»', async () => {
    process.env.TERMINAL_PAYMENT_SIN_RESPUESTA_MS = '200'
    const s = await f.solicitud({ acknowledgedAt: new Date() })
    conectada = false
    terminalPaymentService.alDesconectarseLaTerminal(f.serial, f.venueId)
    await esperar(500)
    expect((await fila(s.requestId)).resultJson).toMatchObject({ noChargeCause: 'TERMINAL_GONE' })
    await esperar(400)
    expect(await terminalPaymentService.getPaymentStatus(s.requestId, f.venueId)).toMatchObject({ ...NO_COBRADO, noChargeCause: 'TERMINAL_GONE' })
  })

  it('…y si reconecta antes de los 10 s y manda su resultado, gana el resultado', async () => {
    process.env.TERMINAL_PAYMENT_SIN_RESPUESTA_MS = '300'
    const s = await f.solicitud({ acknowledgedAt: new Date() })
    terminalPaymentService.alDesconectarseLaTerminal(f.serial, f.venueId)
    // `conectada` sigue en true: el registro ya tiene el socket nuevo.
    await esperar(400)
    expect(await fila(s.requestId)).toMatchObject({ status: 'SENT' })
    await svc.handlePaymentResultFromSocket(
      { requestId: s.requestId, status: 'failed', outcomeEvidence: 'PROCESSOR_DECLINED', errorMessage: 'Declinada' },
      tpv(),
    )
    expect(await fila(s.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'TPV_CONFIRMED_NO_CHARGE' })
  })

  it('cancel sin respuesta en 10 s: entra a «sin respuesta»; un cancel ACCEPTED cierra CANCELLED sin esperar', async () => {
    const sinRespuesta = await f.solicitud({ status: 'CANCEL_REQUESTED', cancelRequestedAt: hace(11_000), acknowledgedAt: hace(20_000) })
    await terminalPaymentService.reconcileStaleRequests(new Date())
    expect(await fila(sinRespuesta.requestId)).toMatchObject({ status: 'UNKNOWN' })
    expect(await terminalPaymentService.cerrarSinRespuesta(sinRespuesta.requestId, f.venueId, enDiezS())).toBe('NO_COBRADO')

    const aceptada = await f.solicitud({ status: 'CANCEL_REQUESTED', cancelRequestedAt: new Date() })
    await svc.handleCancelDispositionFromSocket({ requestId: aceptada.requestId, disposition: 'ACCEPTED' }, tpv())
    expect(await terminalPaymentService.getPaymentStatus(aceptada.requestId, f.venueId)).toMatchObject({
      status: 'CANCELLED',
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'CANCEL_ACCEPTED',
    })
  })

  it('residuo de TPV vieja (ACTIVE tras el cancel): se tolera 30 s; a los 30 s «sin respuesta» y la terminal libre; a los 40 s «no cobrado»', async () => {
    const s = await f.solicitud({ status: 'CANCEL_REQUESTED', cancelRequestedAt: hace(20_000), acknowledgedAt: hace(60_000) })
    await svc.handleCancelDispositionFromSocket({ requestId: s.requestId, disposition: 'ACTIVE', executionAlive: true, closedForExecution: false }, tpv())
    await terminalPaymentService.reconcileStaleRequests(new Date())
    expect(await fila(s.requestId)).toMatchObject({ status: 'CANCEL_REQUESTED', cancelDisposition: 'ACTIVE' })
    expect(await ocupada()).toBe(true)
    await prisma.terminalPaymentRequest.update({ where: { id: s.id }, data: { cancelRequestedAt: hace(31_000) } })
    await terminalPaymentService.reconcileStaleRequests(new Date())
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN' })
    expect(await ocupada()).toBe(false)
    expect(await terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId, enDiezS())).toBe('NO_COBRADO')
    expect(await terminalPaymentService.getPaymentStatus(s.requestId, f.venueId)).toMatchObject(NO_COBRADO)
  })

  it('Review Focus 1 · carrera aviso aprobado vs cierre: un solo desenlace y UN Payment', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await f.solicitud({ orderId: venta.id, acknowledgedAt: new Date() })
    const attemptId = await intento(s.requestId)
    await svc.entrarSinRespuestaYProgramar(s.requestId, f.venueId, 'NO_RESPONSE', { ahora: hace(DIEZ_S + 100) })
    const [cierre] = await Promise.all([terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId), webhook(attemptId)])
    expect(['NO_COBRADO', 'APROBADO_POR_REGISTRAR', 'COMPLETED', 'NO_APLICA']).toContain(cierre)
    expect(await fila(s.requestId)).toMatchObject({ status: 'COMPLETED' })
    expect(await prisma.payment.count({ where: { venueId: f.venueId, orderId: venta.id } })).toBe(1)
  })

  it('aprobado tardío a los 60 s: el registro REST reabre a COMPLETED una vez, con 🚨, asiento y aviso a la DUEÑA (no al cajero)', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await f.solicitud({ orderId: venta.id, acknowledgedAt: new Date() })
    const attemptId = await intento(s.requestId)
    await svc.entrarSinRespuestaYProgramar(s.requestId, f.venueId, 'NO_RESPONSE', { ahora: hace(DIEZ_S + 100) })
    expect(await terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId)).toBe('NO_COBRADO')
    const pago = await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId, requestId: s.requestId }), f.staffId)
    expect(await fila(s.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id, lateResult: true })
    expect(await terminalPaymentService.getPaymentStatus(s.requestId, f.venueId)).toMatchObject({ outcome: 'CHARGED' })
    expect(await asientos('TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW')).toHaveLength(1)
    expect((logger.error as jest.Mock).mock.calls.some(([m]) => String(m).includes('🚨'))).toBe(true)
    await esperar(300) // el aviso va fuera de la transacción
    // Sólo los avisos de ESTE cobro (un aviso tardío de la prueba anterior puede caer después de su limpieza).
    const avisos = (await prisma.notification.findMany({ where: { venueId: f.venueId } })).filter(
      a => (a.metadata as { paymentId?: string } | null)?.paymentId === pago.id,
    )
    expect(avisos.map(a => a.recipientId)).toEqual([duenaId])
    expect(avisos[0]).toMatchObject({ type: 'PAYMENT_RECEIVED', priority: 'HIGH' })
    expect(avisos[0].message).toContain('$100.00')
    expect(avisos[0].message).toContain('AngelPay')
    // Una segunda copia del registro no crea otro Payment ni otro asiento.
    await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId, requestId: s.requestId }), f.staffId)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, orderId: venta.id } })).toBe(1)
    expect(await asientos('TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW')).toHaveLength(1)
  })

  it('Codex r1 #4 · aviso APROBADO guardado y su Payment pendiente: ni el silencio ni un rechazo de la terminal la cierran «no cobrada»', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await f.solicitud({ orderId: venta.id, acknowledgedAt: new Date() })
    const attemptId = await intento(s.requestId)
    // El aviso aprobado quedó guardado; el Payment todavía no (el registrador lo reintenta).
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        type: 'send_transaction',
        eventId: `angelpay-${f.nuevoEventId()}`,
        venueId: f.venueId,
        attemptId,
        payload: f.eventoAngelPay(attemptId),
      } as any,
    })
    await svc.handlePaymentResultFromSocket(
      { requestId: s.requestId, status: 'failed', outcomeEvidence: 'PROCESSOR_DECLINED', errorMessage: 'Declinada' },
      tpv(),
    )
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN' })
    expect(await terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId, enDiezS())).toBe('APROBADO_POR_REGISTRAR')
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN' })
    expect(await cercada(venta.id)).toBe(true)
    // A los 5 min sin Payment: 🚨 y asiento, UNA vez.
    const cincoMin = new Date(Date.now() + 5 * 60_000 + DIEZ_S)
    expect(await terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId, cincoMin)).toBe('APROBADO_POR_REGISTRAR')
    expect(await terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId, cincoMin)).toBe('APROBADO_POR_REGISTRAR')
    expect(await asientos('TERMINAL_PAYMENT_APPROVED_NOT_RECORDED')).toHaveLength(1)
  })

  it('Codex r1 #6 · acuse sin final con la terminal conectada: se le pregunta; sin «sigo cobrando» entra a «sin respuesta» y luego «no cobrado»', async () => {
    const s = await f.solicitud({ acknowledgedAt: hace(61_000) })
    const ahora = new Date()
    expect(await terminalPaymentService.preguntarPorSolicitudesSinFinal(ahora)).toEqual({ entradas: 0, preguntas: 1 })
    expect(directEmit).toHaveBeenCalledWith('terminal:payment_probe', expect.objectContaining({ requestId: s.requestId }), expect.any(Function))
    expect(await fila(s.requestId)).toMatchObject({ status: 'SENT' })
    // La terminal no contestó «sigo cobrando»: la siguiente pasada (≥ 20 s) entra.
    const despues = new Date(ahora.getTime() + 30_000)
    expect(await terminalPaymentService.preguntarPorSolicitudesSinFinal(despues)).toEqual({ entradas: 1, preguntas: 0 })
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN' })
    expect(cancelEmit).toHaveBeenCalledWith('terminal:payment_cancel', expect.objectContaining({ requestId: s.requestId }))
    expect(await terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId, new Date(despues.getTime() + DIEZ_S + 50))).toBe('NO_COBRADO')
  })

  it('…con «sigo cobrando» (ACTIVE) se tolera hasta 150 s desde el acuse; luego entra', async () => {
    const s = await f.solicitud({ acknowledgedAt: hace(61_000) })
    const ahora = new Date()
    await terminalPaymentService.preguntarPorSolicitudesSinFinal(ahora)
    await svc.handleProbeResultFromSocket({ requestId: s.requestId, disposition: 'ACTIVE', executionAlive: true }, tpv())
    expect(await terminalPaymentService.preguntarPorSolicitudesSinFinal(new Date(ahora.getTime() + 30_000))).toEqual({ entradas: 0, preguntas: 1 })
    expect(await fila(s.requestId)).toMatchObject({ status: 'SENT' })
    expect(await terminalPaymentService.preguntarPorSolicitudesSinFinal(new Date(ahora.getTime() + 90_000))).toMatchObject({ entradas: 1 })
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN' })
  })

  it('la sonda contesta NOT_FOUND por una SENT acusada: «sin respuesta» (antes se quedaba reservada para una persona)', async () => {
    const s = await f.solicitud({ acknowledgedAt: hace(61_000) })
    await svc.handleProbeResultFromSocket({ requestId: s.requestId, disposition: 'NOT_FOUND' }, tpv())
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN' })
    expect(await ocupada()).toBe(false)
  })
})

describe('S1.3 · lo que leen las apps sin temporizador (publicación del SERVIDOR)', () => {
  it('Review Focus 2 · sin temporizador, el GET del POS y la consulta de la TPV cierran la fila vencida', async () => {
    const a = await f.solicitud({ status: 'UNKNOWN', noResponseAt: hace(DIEZ_S + 1_000), resultJson: { noChargeCause: 'NO_RESPONSE' } })
    expect(await terminalPaymentService.getPaymentStatus(a.requestId, f.venueId)).toMatchObject(NO_COBRADO)
    const b = await f.solicitud({ status: 'UNKNOWN', noResponseAt: hace(DIEZ_S + 1_000), resultJson: { noChargeCause: 'NO_RESPONSE' } })
    const r = await terminalPaymentService.consultarSolicitudDeTerminal({ requestId: b.requestId, venueId: f.venueId, terminalSerial: f.serial })
    expect(r).toMatchObject({ resuelta: true, request: expect.objectContaining(NO_COBRADO) })
  })

  it('el vigía cierra las vencidas y no toca las que todavía no cumplen sus 10 s', async () => {
    const vencida = await f.solicitud({ status: 'UNKNOWN', noResponseAt: hace(DIEZ_S + 1_000) })
    const fresca = await f.solicitud({ status: 'UNKNOWN', noResponseAt: hace(2_000) })
    const r = await terminalPaymentService.cerrarSinRespuestaVencidas(new Date())
    expect(r.NO_COBRADO).toBeGreaterThanOrEqual(1)
    expect(await fila(vencida.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
    expect(await fila(fresca.requestId)).toMatchObject({ status: 'UNKNOWN' })
  })
})

describe('Codex S1 r1 · el cancel sin respuesta y el «sigo cobrando»', () => {
  it('#6 · el cancel sin respuesta se revisa en proceso: a los 10 s (aquí, acortados) entra a «sin respuesta» sin esperar al vigía', async () => {
    process.env.TERMINAL_PAYMENT_SIN_RESPUESTA_MS = '200'
    const s = await f.solicitud({ status: 'SENT', acknowledgedAt: new Date() })
    await terminalPaymentService.cancelPayment(f.serial, s.requestId, 'prueba', f.venueId)
    expect(await fila(s.requestId)).toMatchObject({ status: 'CANCEL_REQUESTED' })
    await esperar(600)
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN' })
  })

  it('#7 · un «sigo cobrando» (ACTIVE) dentro de los 30 s del cancel no deja entrar a «sin respuesta» aunque el barrido la haya leído antes', async () => {
    const s = await f.solicitud({ status: 'CANCEL_REQUESTED', cancelRequestedAt: hace(12_000), cancelDisposition: 'ACTIVE' })
    const entro = await svc.entrarSinRespuestaYProgramar(s.requestId, f.venueId, 'NO_RESPONSE', { respetarActiveHasta: hace(30_000) })
    expect(entro).toBe(false)
    expect(await fila(s.requestId)).toMatchObject({ status: 'CANCEL_REQUESTED' })
  })

  it('#8 · en sus 10 s el GET la muestra EN VUELO (las apps viejas siguen consultando) y después «no cobrado»', async () => {
    const s = await f.solicitud({ status: 'UNKNOWN', noResponseAt: new Date(), acknowledgedAt: new Date() })
    expect(await terminalPaymentService.getPaymentStatus(s.requestId, f.venueId)).toMatchObject({ status: 'SENT', outcome: 'UNRESOLVED' })
    await prisma.terminalPaymentRequest.update({ where: { id: s.id }, data: { noResponseAt: hace(DIEZ_S + 500) } })
    expect(await terminalPaymentService.getPaymentStatus(s.requestId, f.venueId)).toMatchObject(NO_COBRADO)
  })
})

describe('Codex S1 r2', () => {
  /** Otro cobro de la MISMA cuenta (en la misma terminal): si la cuenta está cercada, 409 con `scope: ORDER`. */
  const otroCobroDeLaCuenta = (orderId: string) =>
    terminalPaymentService.sendPaymentToTerminal({
      terminalId: f.serial,
      venueId: f.venueId,
      amountCents: 10000,
      orderId,
      requestedBy: f.staffId,
      requestId: randomUUID(),
    })

  it('R2-1 · la Nexgo manda `success` sin paymentId ni transactionId y su registro todavía no llega: a los 10 s NO queda «no cobrada», la cuenta sigue cercada y el Payment la cierra COMPLETED con UN Payment', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await f.solicitud({ orderId: venta.id, acknowledgedAt: new Date() })
    const attemptId = await intento(s.requestId)
    await svc.handlePaymentResultFromSocket({ requestId: s.requestId, status: 'success' }, tpv())
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })
    expect(await terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId, enDiezS())).toBe('APROBADO_POR_REGISTRAR')
    await terminalPaymentService.cerrarSinRespuestaVencidas(enDiezS())
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })
    expect(await cercada(venta.id)).toBe(true)
    await expect(otroCobroDeLaCuenta(venta.id)).rejects.toMatchObject({ details: expect.objectContaining({ scope: 'ORDER' }) })
    const pago = await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId, requestId: s.requestId }), f.staffId)
    expect(await fila(s.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id })
    expect(await prisma.payment.count({ where: { venueId: f.venueId, orderId: venta.id } })).toBe(1)
  })

  it('R2-5 · 60 cobros con tarjeta de otros importes y luego uno del mismo TOTAL: el posible duplicado sale en el aviso a la dueña', async () => {
    const desde = new Date(Date.now() - 1_000)
    const D = (n: number) => new Prisma.Decimal(n)
    const pagoBase = { venueId: f.venueId, source: 'TPV', method: 'CREDIT_CARD', status: 'COMPLETED', feePercentage: D(0), feeAmount: D(0) }
    const otraVenta = await f.nuevaVenta(500)
    await prisma.payment.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        ...pagoBase,
        orderId: otraVenta.id,
        amount: D(200 + i),
        tipAmount: D(0),
        netAmount: D(200 + i),
        createdAt: new Date(desde.getTime() + 10 + i),
      })) as Prisma.PaymentCreateManyInput[],
    })
    const duplicado = await f.nuevaVenta(120)
    await prisma.payment.create({
      data: { ...pagoBase, orderId: duplicado.id, amount: D(100), tipAmount: D(20), netAmount: D(120), createdAt: new Date(desde.getTime() + 500) } as any,
    })
    const tardia = await f.nuevaVenta(120)
    const aprobado = await prisma.payment.create({
      data: { ...pagoBase, orderId: tardia.id, amount: D(120), tipAmount: D(0), netAmount: D(120) } as any,
    })
    await avisarAprobadoTardioDeLaSolicitud({ requestId: randomUUID(), venueId: f.venueId, paymentId: aprobado.id, orderId: tardia.id, desde })
    const aviso = await prisma.notification.findFirst({ where: { venueId: f.venueId, recipientId: duenaId } })
    expect(aviso?.message).toContain(duplicado.orderNumber)
  })

  it('R2-7 · un ACTIVE con la base 8 s atrasada o adelantada no corta el cobro antes de 150 s', async () => {
    const s = await f.solicitud({ acknowledgedAt: hace(61_000) })
    const ahora = new Date()
    await terminalPaymentService.preguntarPorSolicitudesSinFinal(ahora)
    await svc.handleProbeResultFromSocket({ requestId: s.requestId, disposition: 'ACTIVE', executionAlive: true }, tpv())
    // El sello de la base, 8 s ATRASADO respecto al servidor.
    await prisma.terminalPaymentRequest.update({ where: { id: s.id }, data: { probeActiveAt: new Date(ahora.getTime() - 8_000) } })
    expect(await terminalPaymentService.preguntarPorSolicitudesSinFinal(new Date(ahora.getTime() + 30_000))).toEqual({ entradas: 0, preguntas: 1 })
    await svc.handleProbeResultFromSocket({ requestId: s.requestId, disposition: 'ACTIVE', executionAlive: true }, tpv())
    // …y ADELANTADO.
    await prisma.terminalPaymentRequest.update({ where: { id: s.id }, data: { probeActiveAt: new Date(ahora.getTime() + 38_000) } })
    expect(await terminalPaymentService.preguntarPorSolicitudesSinFinal(new Date(ahora.getTime() + 60_000))).toEqual({ entradas: 0, preguntas: 1 })
    expect(await fila(s.requestId)).toMatchObject({ status: 'SENT' })
  })

  it('R2-7 · un cancel del POS entre la lectura del barrido y su escritura: el barrido no la mete a «sin respuesta»', async () => {
    const s = await f.solicitud({ acknowledgedAt: hace(151_000) })
    const original = svc.entrarSinRespuestaYProgramar.bind(svc)
    const espia = jest.spyOn(svc, 'entrarSinRespuestaYProgramar').mockImplementationOnce(async (...args: unknown[]) => {
      await prisma.terminalPaymentRequest.update({
        where: { id: s.id },
        data: { status: 'CANCEL_REQUESTED', cancelRequestedAt: new Date() },
      })
      return original(...args)
    })
    try {
      expect(await terminalPaymentService.preguntarPorSolicitudesSinFinal(new Date())).toEqual({ entradas: 0, preguntas: 0 })
      expect(await fila(s.requestId)).toMatchObject({ status: 'CANCEL_REQUESTED', noResponseAt: null })
    } finally {
      espia.mockRestore()
    }
  })

  it('R2-7 · primera pasada (tras un reinicio) con la terminal todavía sin socket no entra; si vuelve, nada; si ≥ 10 s después sigue fuera, TERMINAL_GONE', async () => {
    const s = await f.solicitud({ acknowledgedAt: hace(61_000) })
    const ahora = new Date()
    conectada = false
    expect(await terminalPaymentService.preguntarPorSolicitudesSinFinal(ahora)).toEqual({ entradas: 0, preguntas: 0 })
    expect(await fila(s.requestId)).toMatchObject({ status: 'SENT' })
    conectada = true
    expect(await terminalPaymentService.preguntarPorSolicitudesSinFinal(new Date(ahora.getTime() + 15_000))).toMatchObject({ entradas: 0 })
    conectada = false
    expect(await terminalPaymentService.preguntarPorSolicitudesSinFinal(new Date(ahora.getTime() + 20_000))).toMatchObject({ entradas: 0 })
    expect(await fila(s.requestId)).toMatchObject({ status: 'SENT' })
    expect(await terminalPaymentService.preguntarPorSolicitudesSinFinal(new Date(ahora.getTime() + 31_000))).toMatchObject({ entradas: 1 })
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN', resultJson: expect.objectContaining({ noChargeCause: 'TERMINAL_GONE' }) })
  })
})
