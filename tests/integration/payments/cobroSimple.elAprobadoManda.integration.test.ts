/**
 * Cobro simple · S1 — «el aprobado manda» frente a TODO escritor de un negativo (Codex S1 r3), contra Postgres REAL.
 *
 * La causa de fondo que encontró la ronda 3: cada escritor de un desenlace negativo armaba su propia lista de vetos, y a dos de ellos
 * (el rechazo directo del banco y el cancel aceptado) les faltaba «la terminal ya dijo que sí» (`claimedSuccess`). Aquí cada escritor
 * se prueba contra cada señal de que el banco o la terminal ya dijeron que sí: en ninguna celda queda un negativo ni la cuenta libre.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { reconcileBankDeclined } from '@/services/tpv/uncharged-reconciliation.service'
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
let f: Fixture

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('cs1am')
})
beforeEach(() => {
  jest.clearAllMocks()
  const emit = jest.fn()
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
  }))
})
afterEach(async () => {
  for (const mapa of [svc.cierresSinRespuesta] as Map<string, NodeJS.Timeout>[]) {
    for (const t of mapa.values()) clearTimeout(t)
    mapa.clear()
  }
  for (const [id, p] of svc.pendingPayments as Map<string, { resolve: (r: unknown) => void; timeout: NodeJS.Timeout }>) {
    clearTimeout(p.timeout)
    svc.pendingPayments.delete(id)
    p.resolve({ requestId: id, status: 'timeout' })
  }
  await prisma.notification.deleteMany({ where: { venueId: f.venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
})
afterAll(() => f.destruir())

const fila = (requestId: string) => exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))
const tpv = () => ({ socketId: SOCKET, terminalId: f.serial, venueId: f.venueId, terminalPaymentExecutionVersion: 1 })
const cercada = (orderId: string) => terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, orderId)
const enDiezS = () => new Date(Date.now() + 10_050)
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
const rechazoGuardado = (attemptId: string) =>
  prisma.providerEventLog.create({
    data: {
      provider: 'PAYMENT_PROCESSOR',
      type: 'send_transaction',
      eventId: `angelpay-${f.nuevoEventId()}`,
      venueId: f.venueId,
      attemptId,
      payload: f.eventoAngelPay(attemptId, { status: 'rejected', description: '51 FONDOS INSUFICIENTES' }),
    } as any,
  })
const NEGATIVOS = ['FAILED', 'CANCELLED']

describe('R3-1 · el rechazo del banco no le gana a un «sí cobré» de la terminal ya guardado', () => {
  it('fila en duda con `claimedSuccess`: el aviso rechazado de su intento NO la cierra BANK_DECLINED', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await f.solicitud({
      orderId: venta.id,
      status: 'UNKNOWN',
      noResponseAt: new Date(),
      resultJson: { status: 'timeout', claimedSuccess: { status: 'success' } },
    })
    const a = await intento(s.requestId)
    await rechazo(a)
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN' })
    expect(await cercada(venta.id)).toBe(true)
  })

  it('rechazo de A guardado en vuelo y luego `success` sin ids de la terminal: ni al cierre de los 10 s gana el rechazo', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await f.solicitud({ orderId: venta.id, acknowledgedAt: new Date() })
    const a = await intento(s.requestId)
    await rechazo(a)
    expect(await fila(s.requestId)).toMatchObject({ status: 'SENT' })
    await svc.handlePaymentResultFromSocket({ requestId: s.requestId, status: 'success' }, tpv())
    expect(await terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId, enDiezS())).toBe('APROBADO_POR_REGISTRAR')
    expect(NEGATIVOS).not.toContain((await fila(s.requestId)).status)
    expect(await cercada(venta.id)).toBe(true)
  })

  it('la entrada a «sin respuesta» con un rechazo guardado y un `claimedSuccess` ya en el sobre tampoco cierra', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await f.solicitud({ orderId: venta.id, acknowledgedAt: new Date(), resultJson: { claimedSuccess: { status: 'success' } } })
    const a = await intento(s.requestId)
    await rechazoGuardado(a)
    expect(await svc.entrarSinRespuestaYProgramar(s.requestId, f.venueId, 'NO_RESPONSE')).toBe(true)
    expect(await fila(s.requestId)).toMatchObject({ status: 'UNKNOWN' })
    expect(
      await reconcileBankDeclined({
        venueId: f.venueId,
        requestId: s.requestId,
        origen: 'ANGELPAY',
        evidencia: { eventLogId: 'x', attemptId: a },
      }),
    ).toMatchObject({ closed: false, reason: 'POSITIVE_EVIDENCE_EXISTS' })
  })
})

describe('R3-2 · un negativo posterior de la terminal o un cancel ACCEPTED no borran el «sí»', () => {
  const afirmada = (orderId: string) =>
    f.solicitud({
      orderId,
      status: 'UNKNOWN',
      noResponseAt: null,
      acknowledgedAt: new Date(),
      resultJson: { status: 'timeout', claimedSuccess: { status: 'success' } },
    })

  it('negativo ACREDITADO (PROCESSOR_DECLINED) sobre una afirmada: no la cierra, conserva `claimedSuccess` y el cierre dice «aprobado, por registrar»', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await afirmada(venta.id)
    await svc.handlePaymentResultFromSocket(
      { requestId: s.requestId, status: 'failed', outcomeEvidence: 'PROCESSOR_DECLINED', errorMessage: 'Declinada' },
      tpv(),
    )
    const r = await fila(s.requestId)
    expect(NEGATIVOS).not.toContain(r.status)
    expect((r.resultJson as any).claimedSuccess).toEqual({ status: 'success' })
    expect(await terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId, enDiezS())).toBe('APROBADO_POR_REGISTRAR')
    expect(await cercada(venta.id)).toBe(true)
  })

  it('negativo SIN evidencia sobre una afirmada: entra a «sin respuesta» conservando `claimedSuccess`; a los 10 s, nunca «no cobrado»', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await afirmada(venta.id)
    await svc.handlePaymentResultFromSocket({ requestId: s.requestId, status: 'failed', errorMessage: 'U101' }, tpv())
    const r = await fila(s.requestId)
    expect(r.status).toBe('UNKNOWN')
    expect((r.resultJson as any).claimedSuccess).toEqual({ status: 'success' })
    expect(await terminalPaymentService.cerrarSinRespuesta(s.requestId, f.venueId, enDiezS())).toBe('APROBADO_POR_REGISTRAR')
    expect(await cercada(venta.id)).toBe(true)
  })

  it('cancel ACCEPTED sobre una afirmada: no la cierra CANCELLED y el POS que espera no recibe `cancelled`', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await afirmada(venta.id)
    const resolve = jest.fn()
    svc.pendingPayments.set(s.requestId, {
      resolve,
      reject: jest.fn(),
      timeout: setTimeout(() => undefined, 60_000),
      requestId: s.requestId,
      terminalId: f.llaveTerminal,
      venueId: f.venueId,
    })
    await svc.handleCancelDispositionFromSocket({ requestId: s.requestId, disposition: 'ACCEPTED' }, tpv())
    const r = await fila(s.requestId)
    expect(NEGATIVOS).not.toContain(r.status)
    expect((r.resultJson as any).claimedSuccess).toEqual({ status: 'success' })
    expect(resolve).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }))
    expect(await cercada(venta.id)).toBe(true)
  })

  it('cancel ACCEPTED con un aviso APROBADO ya guardado de su intento: no la cierra CANCELLED', async () => {
    const venta = await f.nuevaVenta(100)
    const s = await f.solicitud({
      orderId: venta.id,
      status: 'CANCEL_REQUESTED',
      cancelRequestedAt: new Date(),
      acknowledgedAt: new Date(),
    })
    const a = await intento(s.requestId)
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        type: 'send_transaction',
        eventId: `angelpay-${f.nuevoEventId()}`,
        venueId: f.venueId,
        attemptId: a,
        payload: f.eventoAngelPay(a),
      } as any,
    })
    await svc.handleCancelDispositionFromSocket({ requestId: s.requestId, disposition: 'ACCEPTED' }, tpv())
    expect(NEGATIVOS).not.toContain((await fila(s.requestId)).status)
    expect(await cercada(venta.id)).toBe(true)
  })

  it('CONTROL: sin señal de dinero, el cancel ACCEPTED sí cierra CANCELLED/ACCEPTED y el POS recibe `cancelled`', async () => {
    const s = await f.solicitud({ status: 'CANCEL_REQUESTED', cancelRequestedAt: new Date(), acknowledgedAt: new Date() })
    const resolve = jest.fn()
    svc.pendingPayments.set(s.requestId, {
      resolve,
      reject: jest.fn(),
      timeout: setTimeout(() => undefined, 60_000),
      requestId: s.requestId,
      terminalId: f.llaveTerminal,
      venueId: f.venueId,
    })
    await svc.handleCancelDispositionFromSocket({ requestId: s.requestId, disposition: 'ACCEPTED' }, tpv())
    expect(await fila(s.requestId)).toMatchObject({ status: 'CANCELLED', cancelDisposition: 'ACCEPTED' })
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }))
  })
})
