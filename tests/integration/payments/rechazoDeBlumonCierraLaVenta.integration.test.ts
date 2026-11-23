/**
 * D26 · el rechazo que avisa Blumon cierra solo el cobro de la tablet (Testarudo, 22-nov-2026) — contra Postgres REAL.
 *
 * El incidente: la PAX `AVQD-2841653112` recibió el cobro de la tablet ($215 + $21.50) a las 09:25:11 (México), el banco lo rechazó a
 * las 09:25:18 y Blumon NOS AVISÓ a las 09:25:19 (`codeResponse = "12"`, «TRANSACCION NO PERMITIDA», `amount = "236.50"`). El
 * SERVIDOR lo guardó como `NOT_APPROVED` y no hizo nada: la tablet canceló, la terminal siguió diciendo «sigo cobrando» 25 min y la
 * venta sólo se cerró cuando una persona declaró «no se cobró».
 *
 * La promesa (`docs/audit/2026-11-22-terminal-sigue-cobrando/promesa-rechazo-blumon.md` del workspace): el aviso se ANOTA en la
 * solicitud que en ese momento ocupa la ranura de esa terminal con ese importe exacto (y hora del banco posterior a su creación); la
 * venta se cierra `FAILED/BANK_DECLINED` en cuanto ya no puede haber otro intento en vuelo: la terminal certificó el cese, o el
 * techo de la VENTA (150 s tras el cancel del POS, con la ranura suelta). Nunca en el instante del aviso (el «Reintentar» de la PAX).
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { bloqueaLaRanura, desenlaceCanonico, terminalPaymentService } from '@/services/terminal-payment.service'
import { processBlumonPaymentWebhook } from '@/services/tpv/blumon-webhook.service'
import { reconcileUncharged } from '@/services/tpv/uncharged-reconciliation.service'
import { TerminalPaymentWatchdogJob } from '@/jobs/terminal-payment-watchdog.job'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { _olvidarTodoParaPruebas } from '@/services/tpv/avisosNoGuardados'
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
/** El importe del incidente: $215 + $21.50 de propina = "236.50" en el aviso. */
const MONTO = 21_500
const PROPINA = 2_150
const VIVA = { disposition: 'ACTIVE', executionAlive: true, closedForExecution: false }
/** La TPV nueva certifica el cese: «cerré la solicitud y nada la ejecuta». */
const CERRADA = { disposition: 'ACTIVE', executionAlive: false, closedForExecution: true }
const SOCKET = 'socket-tpv'
const CERRADA_POR_EL_BANCO = 'TERMINAL_PAYMENT_BANK_DECLINED_RELEASED'
let f: Fixture
let operacion = 28_857_092

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('rechazo-blumon')
})

beforeEach(() => {
  jest.clearAllMocks()
  const emit = jest.fn((_e: string, _p: unknown, ack?: (err: Error | null) => void) => ack?.(new Error('lost ACK')))
  const socket = { emit, timeout: () => ({ emit }) }
  ;(socketManager.getServer as jest.Mock).mockReturnValue({
    sockets: { sockets: new Map([[SOCKET, socket]]) },
    to: () => ({ emit: jest.fn() }),
  })
  ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({
    terminalId,
    venueId: f.venueId,
    socketId: SOCKET,
    identityVerified: true,
    terminalPaymentAckVersion: 1,
    terminalPaymentCancelDispositionVersion: 2,
    terminalPaymentProbeVersion: 1,
    terminalPaymentExecutionVersion: 1,
  }))
})

afterEach(async () => {
  await _olvidarTodoParaPruebas()
  svc.techoCursor = null
  await prisma.providerEventLog.deleteMany({
    where: { OR: [{ venueId: f.venueId }, { payload: { path: ['business'], equals: f.venueId } }] },
  })
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
})
afterAll(() => f.destruir())

const fila = (requestId: string) => exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))
const tpv = () => ({ socketId: SOCKET, terminalId: f.serial, venueId: f.venueId, terminalPaymentExecutionVersion: 1 })
const sigoCobrando = async (requestId: string) => expect(await svc.handleProbeResultFromSocket({ requestId, ...VIVA }, tpv())).toBe(true)
const ocupada = () => terminalPaymentService.isTerminalBusy(f.llaveTerminal, f.venueId)
const ventaCercada = (orderId: string) => terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, orderId)
const vigia = () => new TerminalPaymentWatchdogJob().run()
const cerradasPorElBanco = (entityId: string) =>
  prisma.activityLog.findMany({ where: { venueId: f.venueId, action: CERRADA_POR_EL_BANCO, entityId } })
const declarar = (requestId: string) =>
  reconcileUncharged(
    { venueId: f.venueId, requestId, actorStaffId: f.staffId, source: 'MOBILE' },
    { requestId, resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
  )

/** La tablet cancela y la PAX (2.16.0) contesta «sigo» al cancel: ya lo recibió. */
async function cancelarYSigo(requestId: string) {
  const cancel = await terminalPaymentService.cancelPayment(f.serial, requestId, 'Cancelado desde el POS', f.venueId)
  expect(cancel.cancelIntent).toBe('RECORDED')
  expect(await svc.handleCancelDispositionFromSocket({ requestId, ...VIVA }, tpv())).toBe(true)
  return cancel
}

/** `dd/MM/yyyy HH:mm:ss` en la hora de México: el formato de `dateTransaction` de Blumon. */
function horaDelBanco(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Mexico_City',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map(x => [x.type, x.value]),
  )
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`
}

/** El aviso de Blumon con la forma REAL del de las 09:25:19 (rechazo «12»), de la terminal del fixture. */
function aviso(over: Record<string, unknown> = {}) {
  operacion += 1
  return {
    business: f.venueId, // sólo para limpiar: Blumon manda el nombre del comercio
    businessRfc: 'XAXX010101000',
    bin: '520416',
    lastFour: '1234',
    cardType: 'CREDITO',
    brand: 'MASTERCARD',
    bank: 'BANORTE',
    amount: '236.50',
    reference: `${Date.now()}`,
    cardHolder: 'CLIENTE PRUEBA',
    authorizationCode: '',
    operationType: 'VENTA',
    operationNumber: operacion,
    descriptionResponse: 'TRANSACCION NO PERMITIDA',
    dateTransaction: horaDelBanco(new Date()),
    authentication: 'signature',
    membership: '9999999',
    provideResponse: 'PR',
    codeResponse: '12',
    aid: 'A0000000041010',
    arqc: '0123456789ABCDEF',
    serialNumber: f.serialCrudo,
    realCounter: '10',
    ...over,
  }
}
const aprobado = (over: Record<string, unknown> = {}) =>
  aviso({ codeResponse: '00', descriptionResponse: 'APROBADA', authorizationCode: '123456', ...over })

/** La entrega durable de una TPV 2.16.0 (PAX): anuncia la capacidad de ejecución v1 y no liga intentos. */
const entrega = () => ({
  protocol: 'DURABLE',
  ackVersion: 1,
  cancelDispositionVersion: 2,
  probeVersion: 1,
  executionVersion: 1,
  socketId: SOCKET,
  at: new Date().toISOString(),
  replay: false,
})

/** La solicitud del incidente, ya en la terminal (SENT, con ACK), por $215 + $21.50. */
async function cobroEnLaTerminal(over: Record<string, unknown> = {}) {
  const venta = await f.nuevaVenta(236.5)
  const solicitud = await f.solicitud({
    orderId: venta.id,
    status: 'SENT',
    amountCents: MONTO,
    tipCents: PROPINA,
    // Creada y entregada 10 s antes del rechazo (en el incidente: 7 s; entrega, tarjeta y autorización).
    createdAt: new Date(Date.now() - 10_000),
    acknowledgedAt: new Date(Date.now() - 10_000),
    lastDeliveredAt: new Date(Date.now() - 10_000),
    deliveryProvenance: { deliveries: [entrega()] },
    ...over,
  })
  return { requestId: solicitud.requestId, venta, creada: solicitud.createdAt }
}

describe('D26 · el rechazo de Blumon se ANOTA en la solicitud que ocupa la ranura', () => {
  it('el incidente: el aviso se anota y NO cierra en el instante (la PAX puede estar en «Reintentar»)', async () => {
    const { requestId } = await cobroEnLaTerminal()
    const r = await processBlumonPaymentWebhook(aviso())
    expect(r.action).toBe('NOT_APPROVED')
    const anotada = await fila(requestId)
    expect(anotada.bankDeclineEventLogId).toBe(r.eventLogId)
    expect(anotada).toMatchObject({ status: 'SENT', failureCode: null })
    expect(await ocupada()).toBe(true)
  })

  it.each([
    ['otro importe', () => aviso({ amount: '215.00' })],
    ['otra terminal', () => aviso({ serialNumber: 'N86NOESMIA' })],
    ['hora del banco anterior a la solicitud', () => aviso({ dateTransaction: horaDelBanco(new Date(Date.now() - 60_000)) })],
    ['una devolución rechazada', () => aviso({ operationType: 'DEVOLUCION' })],
    ['sin hora del banco', () => aviso({ dateTransaction: undefined })],
    // Codex r1 #1: la hora repetida del cambio de horario se lee una hora DESPUÉS; una hora del banco posterior a la recepción no es suya.
    ['hora del banco en el futuro', () => aviso({ dateTransaction: horaDelBanco(new Date(Date.now() + 60 * 60_000)) })],
  ])('no se anota: %s', async (_caso, hacer) => {
    const { requestId } = await cobroEnLaTerminal()
    await processBlumonPaymentWebhook(hacer())
    expect((await fila(requestId)).bankDeclineEventLogId).toBeNull()
  })

  it('Codex r0 #2: un rechazo con la hora del banco en el MISMO segundo en que se creó la solicitud no es suyo', async () => {
    const { requestId, creada } = await cobroEnLaTerminal()
    await processBlumonPaymentWebhook(aviso({ dateTransaction: horaDelBanco(creada) }))
    expect((await fila(requestId)).bankDeclineEventLogId).toBeNull()
  })

  it('no se anota en una solicitud nunca entregada, ni en una con la ranura ya suelta', async () => {
    const nunca = await cobroEnLaTerminal({
      status: 'PENDING',
      acknowledgedAt: null,
      lastDeliveredAt: null,
      deliveryProvenance: { deliveries: [] },
    })
    await processBlumonPaymentWebhook(aviso())
    expect((await fila(nunca.requestId)).bankDeclineEventLogId).toBeNull()
    await prisma.terminalPaymentRequest.update({
      where: { requestId: nunca.requestId },
      data: { status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' },
    })

    const suelta = await cobroEnLaTerminal({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
    await processBlumonPaymentWebhook(aviso())
    expect((await fila(suelta.requestId)).bankDeclineEventLogId).toBeNull()
  })

  it('dos solicitudes seguidas del mismo importe: el rechazo cuenta sólo para la que ocupaba la ranura a la hora del banco', async () => {
    const primera = await cobroEnLaTerminal()
    // La primera ya cerró (la terminal reportó su rechazo) y la tablet mandó otra igual: ahora ocupa la ranura la SEGUNDA.
    await prisma.terminalPaymentRequest.update({
      where: { requestId: primera.requestId },
      data: { status: 'CANCELLED', cancelDisposition: 'ACCEPTED', createdAt: new Date(Date.now() - 120_000) },
    })
    const segunda = await cobroEnLaTerminal()
    // Llega tarde el aviso del rechazo de la PRIMERA (hora del banco de hace 90 s): no es de la segunda.
    await processBlumonPaymentWebhook(aviso({ dateTransaction: horaDelBanco(new Date(Date.now() - 90_000)) }))
    expect((await fila(segunda.requestId)).bankDeclineEventLogId).toBeNull()
    expect((await fila(primera.requestId)).bankDeclineEventLogId).toBeNull()
    // El rechazo de la segunda sí.
    const r = await processBlumonPaymentWebhook(aviso())
    expect((await fila(segunda.requestId)).bankDeclineEventLogId).toBe(r.eventLogId)
  })

  it('el aviso repetido es idempotente: DUPLICATE y la anotación no cambia', async () => {
    const { requestId } = await cobroEnLaTerminal()
    const payload = aviso()
    const r1 = await processBlumonPaymentWebhook(payload)
    const r2 = await processBlumonPaymentWebhook(payload)
    expect(r2.action).toBe('DUPLICATE')
    expect((await fila(requestId)).bankDeclineEventLogId).toBe(r1.eventLogId)
  })
})

describe('D26 · la venta se cierra SOLA como «rechazada por el banco» cuando la tablet ya soltó el cobro o la terminal certificó el cese', () => {
  it('el incidente: aviso del rechazo, cancel del POS y la PAX contesta «sigo» ⇒ BANK_DECLINED al instante, cuenta y terminal libres', async () => {
    const { requestId, venta } = await cobroEnLaTerminal()
    const aviso1 = await processBlumonPaymentWebhook(aviso())
    expect(await ventaCercada(venta.id)).toBe(true) // antes del cancel: la PAX puede estar en «Reintentar»

    const cancel = await terminalPaymentService.cancelPayment(f.serial, requestId, 'Cancelado desde el POS', f.venueId)
    expect(cancel.cancelIntent).toBe('RECORDED')
    // Codex r1 #2: el cancel todavía no cierra (si la PAX no lo recibió, el SERVIDOR se lo reenvía al reconectar)…
    expect(cancel.payment).toMatchObject({ status: 'CANCEL_REQUESTED', outcome: 'UNRESOLVED' })
    // …la PAX lo recibe y contesta «sigo» (09:25:24 en el incidente) ⇒ BANK_DECLINED ahí mismo (hoy: 25 min y una persona).
    expect(await svc.handleCancelDispositionFromSocket({ requestId, ...VIVA }, tpv())).toBe(true)
    const r = await fila(requestId)
    expect(r).toMatchObject({ status: 'FAILED', failureCode: 'BANK_DECLINED', paymentId: null })
    expect(desenlaceCanonico(r)).toMatchObject({ outcome: 'NOT_CHARGED', outcomeEvidence: 'PROCESSOR_DECLINED', evidenceClass: 'SERVER' })
    expect(bloqueaLaRanura(r, new Map([[f.venueId, new Date(0)]]))).toBe(false)
    expect(await ocupada()).toBe(false)
    expect(await ventaCercada(venta.id)).toBe(false) // se puede volver a cobrar con la misma tarjeta
    const estado = await terminalPaymentService.getPaymentStatus(requestId, f.venueId)
    expect(estado).toMatchObject({ status: 'FAILED', failureCode: 'BANK_DECLINED', outcome: 'NOT_CHARGED' })
    expect(estado?.errorMessage).toMatch(/^El banco rechazó este cobro\. El banco no pudo procesarla\. No se cobró nada/)
    const asientos = await cerradasPorElBanco(r.id)
    expect(asientos).toHaveLength(1)
    expect(asientos[0].data).toMatchObject({ origen: 'BLUMON', eventLogId: aviso1.eventLogId, requestId })

    // La PAX repite «sigo» y el vigía pasa: nada cambia, un solo asiento; la persona ya no tiene nada que declarar.
    expect(await svc.handleCancelDispositionFromSocket({ requestId, ...VIVA }, tpv())).toBe(true)
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'FAILED', failureCode: 'BANK_DECLINED' })
    expect(await cerradasPorElBanco(r.id)).toHaveLength(1)
    await expect(declarar(requestId)).rejects.toMatchObject({ code: 'ATTEMPT_NOT_ELIGIBLE' })
  })

  it('el cancel ANTES del aviso (la PAX contestó «sigo»): el aviso que llega después la cierra al anotarse', async () => {
    const { requestId } = await cobroEnLaTerminal()
    await terminalPaymentService.cancelPayment(f.serial, requestId, 'Cancelado desde el POS', f.venueId)
    expect(await svc.handleCancelDispositionFromSocket({ requestId, ...VIVA }, tpv())).toBe(true)
    expect(await fila(requestId)).toMatchObject({ status: 'CANCEL_REQUESTED', cancelDisposition: 'ACTIVE' })
    await processBlumonPaymentWebhook(aviso())
    expect(await fila(requestId)).toMatchObject({ status: 'FAILED', failureCode: 'BANK_DECLINED' })
  })

  it('Codex r1 #2: la PAX sin red al cancelar no recibe el cancel ⇒ se conserva la gracia (CANCEL_REQUESTED) y luego cierra el vigía', async () => {
    const { requestId } = await cobroEnLaTerminal()
    await terminalPaymentService.cancelPayment(f.serial, requestId, 'Cancelado desde el POS', f.venueId)
    // El rechazo llega después del cancel, que la PAX no recibió: se anota, pero no cierra (el cancel se le puede reenviar).
    const r = await processBlumonPaymentWebhook(aviso())
    expect((await fila(requestId)).bankDeclineEventLogId).toBe(r.eventLogId)
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'CANCEL_REQUESTED', cancelDisposition: null })
    // Pasa la gracia del cancel sin respuesta: el vigía la deja UNKNOWN y la red la cierra.
    await terminalPaymentService.reconcileStaleRequests(new Date(Date.now() + 31_000))
    expect(await fila(requestId)).toMatchObject({ status: 'UNKNOWN' })
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'FAILED', failureCode: 'BANK_DECLINED' })
  })

  it('Codex r1 #3: un POS que sigue esperando el cobro recibe el rechazo del banco por el rescate del vigía aunque se perdiera el aviso', async () => {
    const { requestId } = await cobroEnLaTerminal()
    await prisma.terminalPaymentRequest.update({
      where: { requestId },
      data: {
        status: 'FAILED',
        failureCode: 'BANK_DECLINED',
        resultJson: { requestId, status: 'failed', outcomeEvidence: 'BANK_DECLINED' },
      },
    })
    const resolve = jest.fn()
    svc.pendingPayments.set(requestId, {
      resolve,
      reject: jest.fn(),
      timeout: setTimeout(() => undefined, 60_000),
      requestId,
      terminalId: f.llaveTerminal,
      venueId: f.venueId,
      createdAt: new Date(),
    })
    expect(await terminalPaymentService.resolvePendingFromDurableState()).toMatchObject({ resolved: 1 })
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ requestId, status: 'failed' }))
    expect(svc.pendingPayments.has(requestId)).toBe(false)
  })

  it('la red del vigía: un rechazo anotado con el cobro ya cancelado que no se cerró (candado ocupado, reinicio) se cierra en la pasada', async () => {
    const { requestId } = await cobroEnLaTerminal()
    const r = await processBlumonPaymentWebhook(aviso())
    // El cancel quedó registrado y la fila pasó a UNKNOWN, pero el cierre no corrió (simulado: se escribe sin pasar por el cancel).
    await prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "status" = 'UNKNOWN', "cancelDisposition" = 'ACTIVE',
      "cancelRequestedAt" = (NOW() AT TIME ZONE 'UTC') - interval '40 seconds' WHERE "requestId" = ${requestId}`
    await sigoCobrando(requestId)
    expect((await fila(requestId)).bankDeclineEventLogId).toBe(r.eventLogId)
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'FAILED', failureCode: 'BANK_DECLINED' })
  })

  it('con el cese certificado por la terminal se cierra en cuanto lo certifica (sin cancel, sin esperar a S2 ni al vigía)', async () => {
    const { requestId } = await cobroEnLaTerminal()
    await processBlumonPaymentWebhook(aviso())
    expect(await svc.handleProbeResultFromSocket({ requestId, ...CERRADA }, tpv())).toBe(true)
    expect(await fila(requestId)).toMatchObject({ status: 'FAILED', failureCode: 'BANK_DECLINED' })
    expect(await ocupada()).toBe(false)
  })

  it('el aviso que llega DESPUÉS del cese certificado (fila UNKNOWN, ranura todavía apartada) también cierra al instante', async () => {
    const { requestId } = await cobroEnLaTerminal()
    expect(await svc.handleProbeResultFromSocket({ requestId, ...CERRADA }, tpv())).toBe(true)
    expect(await fila(requestId)).toMatchObject({ status: 'UNKNOWN', failureCode: 'EXECUTION_CLOSED' })
    await processBlumonPaymentWebhook(aviso())
    expect(await fila(requestId)).toMatchObject({ status: 'FAILED', failureCode: 'BANK_DECLINED' })
  })

  it('sin cancel del POS y con la TPV vieja diciendo «sigo» NO se cierra: la PAX puede estar en «Reintentar»', async () => {
    const { requestId } = await cobroEnLaTerminal({ expiresAt: new Date(Date.now() - 60 * 60_000) })
    await processBlumonPaymentWebhook(aviso())
    await terminalPaymentService.reconcileStaleRequests(new Date())
    await sigoCobrando(requestId)
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'UNKNOWN' })
  })

  it('una terminal que anuncia sus intentos: el rechazo de uno no habla por los demás (no cierra)', async () => {
    const { requestId } = await cobroEnLaTerminal()
    await prisma.terminalPaymentAttemptLink.create({
      data: {
        attemptId: randomUUID(),
        requestId,
        venueId: f.venueId,
        terminalId: f.llaveTerminal,
        createdAt: new Date(Date.now() - 10 * 60_000),
      },
    })
    await processBlumonPaymentWebhook(aviso())
    await cancelarYSigo(requestId)
    await vigia()
    expect((await fila(requestId)).status).not.toBe('FAILED')
  })
})

describe('D26 · el dinero gana: un aprobado después del rechazo (el «Reintentar» que pasó) nunca queda BANK_DECLINED', () => {
  it('Payment registrado antes del cancel ⇒ no se cierra; el vigía la concilia a COMPLETED con su Payment', async () => {
    const { requestId, venta } = await cobroEnLaTerminal()
    await processBlumonPaymentWebhook(aviso())
    const pago = await pagoDeLaSolicitud(requestId, venta.id)
    await cancelarYSigo(requestId)
    expect((await fila(requestId)).status).not.toBe('FAILED')
    await terminalPaymentService.reconcileStaleRequests(new Date(Date.now() + 31_000))
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id })
  })

  it('aviso APROBADO de Blumon del mismo importe DESPUÉS del rechazo, sin Payment ⇒ el rechazo ya no es la última palabra: no cierra', async () => {
    const { requestId } = await cobroEnLaTerminal()
    await processBlumonPaymentWebhook(aviso())
    const ok = await processBlumonPaymentWebhook(aprobado())
    expect(ok.paymentId).toBeUndefined()
    await cancelarYSigo(requestId)
    await vigia()
    const r = await fila(requestId)
    expect(r.status).not.toBe('FAILED')
    expect(await cerradasPorElBanco(r.id)).toHaveLength(0)
  })

  it('un aviso APROBADO de OTRO importe no impide el cierre', async () => {
    const { requestId } = await cobroEnLaTerminal()
    await processBlumonPaymentWebhook(aviso())
    await processBlumonPaymentWebhook(aprobado({ amount: '99.00' }))
    await cancelarYSigo(requestId)
    expect(await fila(requestId)).toMatchObject({ status: 'FAILED', failureCode: 'BANK_DECLINED' })
  })

  it('Payment que llega DESPUÉS del cierre ⇒ concilia a COMPLETED y grita 🚨', async () => {
    const { requestId, venta } = await cobroEnLaTerminal()
    await processBlumonPaymentWebhook(aviso())
    await cancelarYSigo(requestId)
    expect(await fila(requestId)).toMatchObject({ status: 'FAILED', failureCode: 'BANK_DECLINED' })
    const pago = await pagoDeLaSolicitud(requestId, venta.id)
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id })
    const alarmas = (logger.error as jest.Mock).mock.calls.filter(([m]) => String(m).includes('🚨'))
    expect(alarmas.length).toBeGreaterThan(0)
  })
})

/** El COMPLETED de la terminal etiquetado con la solicitud y atribuido a ESTA terminal (el registro de la TPV). */
async function pagoDeLaSolicitud(requestId: string, orderId: string) {
  const terminal = await prisma.terminal.findUniqueOrThrow({ where: { serialNumber: f.serial }, select: { id: true } })
  return prisma.payment.create({
    data: {
      venueId: f.venueId,
      orderId,
      amount: new Prisma.Decimal(215),
      tipAmount: new Prisma.Decimal(21.5),
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      source: 'TPV',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: 236.5,
      terminalId: terminal.id,
      processorData: { terminalPaymentRequestId: requestId, deviceSerialNumber: f.serial },
    },
  })
}
