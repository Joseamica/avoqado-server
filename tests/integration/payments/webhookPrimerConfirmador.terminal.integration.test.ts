/**
 * S6 + S5 del checkpoint 1: lo que la TERMINAL puede saber de SU intento, y a quién se despierta cuando el webhook fue
 * el primer confirmador.
 *
 *  · S6 `consultarIntentoDeTerminal`: separa el RESULTADO DEL INTENTO (el Payment cuya llave es ESTE attemptId, nunca
 *    el de otro intento) del ESTADO DE LA SOLICITUD (la misma proyección que ve el POS y el MCP). Sólo intentos de la
 *    terminal autenticada y del venue del token; un intento desconocido, de otra terminal o de otro venue se ve igual
 *    (`null`) y NUNCA se traduce a «no cobrado». Un timeout o un rechazo aislado tampoco.
 *  · S5: al confirmar por webhook se despierta al POS que sigue en el long-poll y se avisa a la terminal por su socket
 *    (`terminal:payment_confirmed`, sin ACK). El cierre por REST no pasa por ahí. Si el aviso se pierde o el POS vive
 *    en otra instancia, el vigía recupera el resultado durable de la fila (`resolvePendingFromDurableState`).
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { recordFastPayment } from '@/services/tpv/payment.tpv.service'
import { terminalPaymentService, type AttemptOutcome, type AttemptProcessorEvidence } from '@/services/terminal-payment.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { terminalIdentityKey } from '@/utils/terminalSerial'
import { crearFixture, exigirBaseDesechable, type Fixture, exigir } from './webhookCheckpoint.fixture'
import { actores, type Fallo } from './actores'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn(async () => undefined) }))

let f: Fixture
let emitDeLaTerminal: jest.Mock

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('s6')
})
beforeEach(() => {
  jest.clearAllMocks()
  emitDeLaTerminal = jest.fn()
  const socket = { emit: emitDeLaTerminal, timeout: () => ({ emit: emitDeLaTerminal }) }
  ;(socketManager.getServer as jest.Mock).mockReturnValue({
    sockets: { sockets: new Map([['socket-s6', socket]]) },
    to: () => ({ emit: jest.fn() }),
  })
  ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({
    terminalId,
    venueId: f.venueId,
    socketId: 'socket-s6',
    terminalPaymentAckVersion: 1,
  }))
})
afterEach(() => f.limpiar())
afterAll(() => f.destruir())

const fila = (requestId: string) => exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))
const evento = (eventId: string) =>
  exigir(prisma.providerEventLog.findFirst({ where: { provider: 'PAYMENT_PROCESSOR', eventId: `angelpay-${eventId}` } }))

async function vincular(requestId: string, attemptId = randomUUID(), serial = f.serial) {
  const ack = await terminalPaymentService.handleAttemptOpenedFromSocket(
    { requestId, attemptId },
    { socketId: 's', terminalId: serial, venueId: f.venueId },
  )
  expect(ack.success).toBe(true)
  return attemptId
}

async function webhook(attemptId: string | undefined, over: Record<string, unknown> = {}) {
  const eventId = f.nuevoEventId()
  const result = await processAngelPayWebhook({
    payload: f.eventoAngelPay(attemptId, over),
    eventId,
    merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
    retryDelaysMs: [0],
  })
  return { result, eventId }
}

const consultar = (attemptId: string, serial = f.serial, venueId = f.venueId) =>
  terminalPaymentService.consultarIntentoDeTerminal({ attemptId, venueId, terminalSerial: serial })

/** El POS manda el cobro y se queda esperando en el long-poll (la terminal falsa da ACK durable). */
async function posEsperando(overrides: Record<string, unknown> = {}) {
  const requestId = randomUUID()
  emitDeLaTerminal.mockImplementation((_e: string, _p: unknown, cb?: (e: Error | null, r?: unknown) => void) =>
    cb?.(null, { accepted: true, requestId }),
  )
  const espera = terminalPaymentService.sendPaymentToTerminal({
    requestId,
    venueId: f.venueId,
    terminalId: f.serial,
    amountCents: 10000,
    tipCents: 0,
    requestedBy: f.staffId,
    ...overrides,
  })
  // Deja que la admisión escriba la fila y emita antes de seguir.
  for (let i = 0; i < 50; i++) {
    const row = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
    if (row && row.status === 'SENT') break
    await new Promise(r => setTimeout(r, 20))
  }
  return { requestId, espera }
}

describe('S6 · consulta durable POR INTENTO, sólo de la terminal del JWT', () => {
  it('el intento que ganó por webhook: RECORDED con su Payment, vía webhook; la solicitud cerrada como webhook y con ese intento como ganador', async () => {
    const solicitud = await f.solicitud({ amountCents: 10000 })
    const A = await vincular(solicitud.requestId)
    expect((await webhook(A)).result.action).toBe('CONFIRMED')

    const estado = await consultar(A)
    expect(estado).not.toBeNull()
    const despues = await fila(solicitud.requestId)
    expect(estado!.attempt).toMatchObject({
      attemptId: A,
      outcome: 'RECORDED',
      paymentId: despues.paymentId,
      paymentStatus: 'COMPLETED',
      recordedVia: 'webhook',
      isWinner: true,
      amountCents: 10000,
      tipCents: 0,
      processorEvidence: 'APPROVED',
    })
    expect(estado!.request).toMatchObject({
      requestId: solicitud.requestId,
      status: 'COMPLETED',
      outcome: 'CHARGED',
      paymentId: despues.paymentId,
      closedVia: 'webhook',
      winnerAttemptId: A,
    })
  })

  it('nunca atribuye a B el Payment de A: B es evidencia de segunda captura con SU Payment PENDING y el ganador aparte', async () => {
    const solicitud = await f.solicitud({ amountCents: 10000 })
    const A = await vincular(solicitud.requestId)
    const B = await vincular(solicitud.requestId)
    const ganador = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: solicitud.requestId }), f.staffId)
    expect((await webhook(B)).result.action).toBe('SECOND_CAPTURE')

    const deB = await consultar(B)
    expect(deB!.attempt.outcome).toBe('SECOND_CAPTURE_EVIDENCE')
    expect(deB!.attempt.paymentId).not.toBeNull()
    expect(deB!.attempt.paymentId).not.toBe(ganador.id)
    expect(deB!.attempt.paymentStatus).toBe('PENDING')
    expect(deB!.attempt.isWinner).toBe(false)
    expect(deB!.attempt.winnerPaymentId).toBe(ganador.id)
    expect(deB!.request).toMatchObject({ status: 'COMPLETED', paymentId: ganador.id, closedVia: 'terminal', winnerAttemptId: A })

    const deA = await consultar(A)
    expect(deA!.attempt).toMatchObject({
      outcome: 'RECORDED',
      paymentId: ganador.id,
      recordedVia: 'terminal',
      isWinner: true,
      winnerPaymentId: null,
    })
  })

  // Checkpoint 2 · N0b (Codex sobre el diseño v3, cambio 3): «COMPLETED no basta para acreditar al ganador». La prueba durable
  // de que ESTE Payment cerró la solicitud es la columna `Payment.terminalPaymentRequestId`, que sólo escribe
  // `closeRowFromPaymentTx` al ligar — y el 2xx del REST tiene que devolverla YA en el mismo cuerpo (el objeto del
  // `create` nace sin ella): con ella la terminal resuelve su bandeja; sin ella conserva la obligación.
  it('N0b · el 2xx del REST del ganador trae la solicitud ligada; una segunda captura por REST la trae con status PENDING; sin ligar, null', async () => {
    const solicitud = await f.solicitud({ amountCents: 10000 })
    const A = await vincular(solicitud.requestId)
    const B = await vincular(solicitud.requestId)
    const ganador = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: solicitud.requestId }), f.staffId)
    expect(ganador.status).toBe('COMPLETED')
    expect(ganador.terminalPaymentRequestId).toBe(solicitud.requestId)
    // La relectura idempotente (mismo intento) también la trae: es la fila.
    const otraVez = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: solicitud.requestId }), f.staffId)
    expect(otraVez.id).toBe(ganador.id)
    expect(otraVez.terminalPaymentRequestId).toBe(solicitud.requestId)

    const segunda = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: B, requestId: solicitud.requestId }), f.staffId)
    expect(segunda.status).toBe('PENDING')
    expect(segunda.id).not.toBe(ganador.id)
    expect((segunda.processorData as any).reconciliation.kind).toBe('POSSIBLE_SECOND_CAPTURE')
    expect((segunda.processorData as any).reconciliation.winnerPaymentId).toBe(ganador.id)
  })

  it('vinculado sin dinero ni eventos: NOT_RECORDED / NONE, la solicitud sigue en vuelo — y en ningún lado dice «no cobrado»', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)

    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({
      outcome: 'NOT_RECORDED',
      paymentId: null,
      paymentStatus: null,
      recordedVia: null,
      isWinner: false,
      processorEvidence: 'NONE',
    })
    expect(estado!.request).toMatchObject({ status: 'SENT', outcome: 'UNRESOLVED', paymentId: null, winnerAttemptId: null })
    expect(JSON.stringify(estado)).not.toContain('NOT_CHARGED')
  })

  it('declined del procesador: evidencia DECLINED sobre el intento, pero NOT_RECORDED y la solicitud sigue en vuelo (un approved posterior aún puede crear)', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    expect((await webhook(A, { status: 'declined', description: 'RECHAZADA' })).result.action).toBe('NOT_APPROVED')

    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({ outcome: 'NOT_RECORDED', paymentId: null, processorEvidence: 'DECLINED' })
    expect(estado!.attempt.processorEvidenceAt).not.toBeNull()
    expect(estado!.request).toMatchObject({ status: 'SENT', outcome: 'UNRESOLVED' })
    expect(JSON.stringify(estado)).not.toContain('NOT_CHARGED')
  })

  it.each([
    ['un número (123)', 123],
    ['un objeto ({})', {}],
    ['null presente', null],
    ['sólo espacios Unicode', '\u00a0\t'],
  ])(
    'Codex R14-3 · S6: un estado bancario ILEGIBLE — %s — NO es un veredicto: ni APPROVED ni DECLINED (processorEvidence NONE), el evento sigue PENDING/INVALID_STATUS y la solicitud en vuelo',
    async (_n, status) => {
      const solicitud = await f.solicitud()
      const A = await vincular(solicitud.requestId)
      const { result, eventId } = await webhook(A, { status })
      expect(result.action).toBe('INVALID_STATUS')
      expect(await evento(eventId)).toMatchObject({ status: 'PENDING', errorReason: 'INVALID_STATUS', attemptId: A, paymentId: null })

      const estado = await consultar(A)
      expect(estado!.attempt).toMatchObject({ outcome: 'NOT_RECORDED', paymentId: null, processorEvidence: 'NONE' })
      expect(estado!.attempt.processorEvidenceAt).toBeNull()
      expect(estado!.request).toMatchObject({ status: 'SENT', outcome: 'UNRESOLVED' })
      expect(JSON.stringify(estado)).not.toContain('NOT_CHARGED')
    },
  )

  it('Codex R14-3 · S6: una aprobación NORMALIZADA («\\tApproved\\u00a0») que no creó dinero (importe distinto) cuenta como evidencia APPROVED', async () => {
    const solicitud = await f.solicitud({ amountCents: 10000 })
    const A = await vincular(solicitud.requestId)
    const { result } = await webhook(A, { amount: '000000012000', status: '\tApproved\u00a0' })
    expect(result.action).not.toBe('CONFIRMED')
    expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(0)
    expect((await consultar(A))!.attempt).toMatchObject({ outcome: 'NOT_RECORDED', paymentId: null, processorEvidence: 'APPROVED' })
  })

  it('approved que NO creó dinero (importe distinto): evidencia APPROVED sin Payment — pendiente de conciliar, no «cobrado» ni «no cobrado»', async () => {
    const solicitud = await f.solicitud({ amountCents: 10000 })
    const A = await vincular(solicitud.requestId)
    const { result, eventId } = await webhook(A, { amount: '000000012000' })
    expect(result.action).not.toBe('CONFIRMED')
    expect(await evento(eventId)).toMatchObject({ status: 'PENDING', errorReason: 'AMOUNT_MISMATCH', attemptId: A, paymentId: null })
    expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(0)

    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({ outcome: 'NOT_RECORDED', paymentId: null, processorEvidence: 'APPROVED' })
    expect(estado!.request).toMatchObject({ status: 'SENT', outcome: 'UNRESOLVED' })
  })

  it('la solicitud que el vigía dejó UNKNOWN/TIMED_OUT con un intento vinculado y sin Payment: NOT_RECORDED y UNRESOLVED — un timeout no es «no cobrado»', async () => {
    const solicitud = await f.solicitud({ status: 'UNKNOWN', failureCode: 'TIMED_OUT' })
    const A = await vincular(solicitud.requestId)

    const estado = await consultar(A)
    expect(estado!.attempt.outcome).toBe('NOT_RECORDED')
    expect(estado!.request).toMatchObject({ status: 'UNKNOWN', outcome: 'UNRESOLVED' })
    expect(JSON.stringify(estado)).not.toContain('NOT_CHARGED')
  })

  it('un intento desconocido sigue sin ser una NEGACIÓN — ahora lo dice con NOT_RECORDED/NONE en vez de callarse', async () => {
    // Antes del 22-sep esto era `null` (404). Cambió el VEHÍCULO, no la garantía: sin solicitud no hay `request`, y la
    // liberación del cliente exige `request.outcome === 'NOT_CHARGED'` con evidencia de lista blanca
    // (`LiberacionDelServidor.desdeConsultaS6`), así que esta respuesta no puede soltar nada; `NOT_RECORDED` es «no sé»
    // y el cliente lo trata como «nada que aplicar». Lo que se gana: la pantalla de un cobro LOCAL entra a la ventana
    // de confirmación en vez de quedarse en un callejón sin reloj ni botón.
    const visto = await consultar(randomUUID())
    expect(visto).not.toBeNull()
    expect(visto!.attempt.outcome).toBe<AttemptOutcome>('NOT_RECORDED')
    expect(visto!.attempt.processorEvidence).toBe<AttemptProcessorEvidence>('NONE')
    expect(visto!.attempt.paymentId).toBeNull()
    // 🔴 Lo que NO puede aparecer: nada que el cliente pueda leer como liberación.
    expect(visto!.request).toBeNull()
  })

  it('un intento de OTRA terminal del mismo venue se ve igual que uno desconocido (null); la dueña sí lo ve', async () => {
    const otroSerial = `AVQD-N86${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
    const solicitud = await f.solicitud({ terminalId: terminalIdentityKey(otroSerial) })
    const A = await vincular(solicitud.requestId, randomUUID(), otroSerial)

    expect(await consultar(A, f.serial)).toBeNull()
    expect((await consultar(A, otroSerial))!.attempt.attemptId).toBe(A)
  })

  it('un intento de otro venue es null aunque el serial coincida', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    expect(await consultar(A, f.serial, `${f.venueId}-otro`)).toBeNull()
  })

  it('el serial del JWT vale con o sin prefijo AVQD- y en cualquier caja', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    expect((await consultar(A, f.serialCrudo.toLowerCase()))!.attempt.attemptId).toBe(A)
    expect((await consultar(A, `avqd-${f.serialCrudo}`))!.attempt.attemptId).toBe(A)
  })
})

/**
 * Codex R12-13 (l): el long-poll del POS es un ACTOR registrado desde su lanzamiento y, si la prueba cae antes de que se
 * resuelva, la LIBERACIÓN cancela la solicitud por su camino de siempre — así ninguna espera ni timer sobrevive a una
 * aserción caída (limpiar filas no cancela `pendingPayments`). El `afterEach` lo comprueba: cero esperas en el servicio.
 */
const posEsperandoComoActor = async (A: ReturnType<typeof actores>) => {
  const { requestId, espera } = await posEsperando()
  const pos = A.lanzar('long-poll del POS', espera)
  const limpiar = async () => {
    if ((await A.carrera(pos, 50)).estado === 'BLOQUEADA')
      await terminalPaymentService.cancelPayment(f.serial, requestId, 'limpieza de la prueba', f.venueId)
    await pos.resultado().catch(() => undefined) // el desenlace se entrega (y queda examinado) también en la limpieza
  }
  return { requestId, pos, limpiar }
}

describe('S5 · el webhook como primer confirmador despierta al POS y avisa a la terminal', () => {
  afterEach(async () => {
    expect(await terminalPaymentService.resolvePendingFromDurableState()).toMatchObject({ checked: 0 })
  })

  it('con el POS esperando en el long-poll: el approved lo despierta con success + paymentId y la terminal recibe terminal:payment_confirmed', async () => {
    const A = actores()
    const { requestId, pos, limpiar } = await posEsperandoComoActor(A)
    const obs = { attemptId: '', accion: '' as string, desenlace: null as Awaited<ReturnType<typeof A.carrera>> | null }
    let fallo: Fallo = null
    try {
      obs.attemptId = await vincular(requestId)
      emitDeLaTerminal.mockClear()
      obs.accion = (await webhook(obs.attemptId)).result.action
      obs.desenlace = await A.carrera(pos, 3000)
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'long-poll del POS': limpiar })
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      expect(obs.accion).toBe('CONFIRMED')
      const despues = await fila(requestId)
      expect(obs.desenlace).toMatchObject({
        estado: 'ASENTADA',
        ok: true,
        value: { requestId, status: 'success', paymentId: despues.paymentId },
      })
      expect(despues).toMatchObject({ status: 'COMPLETED', closedVia: 'webhook' })
      const avisos = emitDeLaTerminal.mock.calls.filter(([evento]) => evento === 'terminal:payment_confirmed')
      expect(avisos).toHaveLength(1)
      expect(avisos[0][1]).toMatchObject({
        requestId,
        attemptId: obs.attemptId,
        paymentId: despues.paymentId,
        amountCents: 10000,
        tipCents: 0,
        via: 'webhook',
      })
    })
  })

  it('el POS despertado por el webhook recibe la LIGA DEL RECIBO (receipt.receiptUrl) y la fila la conserva: sin ella el ticket sale sin QR', async () => {
    // Testarudo, 18-sep → 21-sep: desde que el webhook gana la carrera, el POS recibía `success` SIN `receipt` (0/389 filas
    // cerradas por webhook la traían; 21/21 cerradas por la terminal sí) ⇒ el ticket del cobro y el «volver a imprimir» de
    // la pantalla de cobro salían sin QR de recibo/factura. El registrador ya generó el recibo antes de confirmar.
    const A = actores()
    const { requestId, pos, limpiar } = await posEsperandoComoActor(A)
    const obs = { desenlace: null as Awaited<ReturnType<typeof A.carrera>> | null }
    let fallo: Fallo = null
    try {
      const attemptId = await vincular(requestId)
      await webhook(attemptId)
      obs.desenlace = await A.carrera(pos, 3000)
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'long-poll del POS': limpiar })
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      const despues = await fila(requestId)
      expect(despues).toMatchObject({ status: 'COMPLETED', closedVia: 'webhook' })
      const recibo = await exigir(prisma.digitalReceipt.findFirst({ where: { paymentId: despues.paymentId! } }))
      const receipt = {
        receiptUrl: expect.stringMatching(new RegExp(`/receipts/public/${recibo.accessKey}$`)),
        receiptAccessKey: recibo.accessKey,
      }
      // Lo que despierta al long-poll del POS (es lo que imprime el ticket del cobro).
      expect(obs.desenlace).toMatchObject({ estado: 'ASENTADA', ok: true, value: { status: 'success', paymentId: despues.paymentId, receipt } })
      // Lo que queda DURABLE en la fila (el GET del POS, la réplica del POST y el vigía leen de aquí).
      expect(despues.resultJson).toMatchObject({ requestId, status: 'success', paymentId: despues.paymentId, receipt })
      // Un `success` tardío de la terminal SIN receipt (lo que manda la TPV 2.10.0 cuando el webhook ya cerró) no la borra.
      await terminalPaymentService.handlePaymentResultFromSocket(
        { requestId, status: 'success', paymentId: despues.paymentId!, transactionId: despues.paymentId!, errorMessage: null } as any,
        { socketId: 's', terminalId: f.serial, venueId: f.venueId },
      )
      expect((await fila(requestId)).resultJson).toMatchObject({ receipt, transactionId: despues.paymentId })
    })
  })

  it('el cierre por REST NO pasa por confirmFromWebhook ni emite payment_confirmed (la terminal ya sabe); el vigía recupera el resultado durable si el aviso al POS se perdió', async () => {
    const A = actores()
    const { requestId, pos, limpiar } = await posEsperandoComoActor(A)
    const confirmar = jest.spyOn(terminalPaymentService, 'confirmFromWebhook')
    const obs = {
      pagoId: '',
      filaTrasRest: null as unknown,
      confirmaciones: -1,
      avisos: -1,
      antes: null as Awaited<ReturnType<typeof A.carrera>> | null,
      recuperados: null as unknown,
      despues: null as Awaited<ReturnType<typeof A.carrera>> | null,
    }
    let fallo: Fallo = null
    try {
      const attemptId = await vincular(requestId)
      emitDeLaTerminal.mockClear()
      const pago = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId, requestId }), f.staffId)
      obs.pagoId = pago.id
      obs.filaTrasRest = await fila(requestId)
      obs.confirmaciones = confirmar.mock.calls.length
      obs.avisos = emitDeLaTerminal.mock.calls.filter(([evento]) => evento === 'terminal:payment_confirmed').length
      // El resultado de la terminal por socket nunca llegó (aviso perdido / el POS vive en otra instancia): la fila manda.
      obs.antes = await A.carrera(pos, 300)
      obs.recuperados = await terminalPaymentService.resolvePendingFromDurableState()
      obs.despues = await A.carrera(pos, 3000)
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'long-poll del POS': limpiar, 'espía de confirmFromWebhook': () => confirmar.mockRestore() })
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      expect(obs.filaTrasRest).toMatchObject({ status: 'COMPLETED', paymentId: obs.pagoId, closedVia: 'terminal' })
      expect(obs.confirmaciones).toBe(0)
      expect(obs.avisos).toBe(0)
      expect(obs.antes).toEqual({ estado: 'BLOQUEADA' })
      expect(obs.recuperados).toMatchObject({ resolved: 1 })
      expect(obs.despues).toMatchObject({ estado: 'ASENTADA', ok: true, value: { requestId, status: 'success', paymentId: obs.pagoId } })
    })
  })

  it('la recuperación durable no toca a un POS cuya solicitud sigue en vuelo, ni inventa un desenlace', async () => {
    const A = actores()
    const { requestId, pos, limpiar } = await posEsperandoComoActor(A)
    const obs = { recuperados: null as unknown, bloqueada: null as Awaited<ReturnType<typeof A.carrera>> | null, estado: '' }
    let fallo: Fallo = null
    try {
      await vincular(requestId)
      obs.recuperados = await terminalPaymentService.resolvePendingFromDurableState()
      obs.bloqueada = await A.carrera(pos, 300)
      obs.estado = (await fila(requestId)).status
    } catch (error) {
      fallo = { error }
    } finally {
      // Limpieza: el POS cancela y la espera termina por su camino de siempre (es la misma liberación que usa toda la suite).
      await A.liberar({ 'long-poll del POS': limpiar })
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      expect(obs.recuperados).toMatchObject({ resolved: 0 })
      expect(obs.bloqueada).toEqual({ estado: 'BLOQUEADA' })
      expect(obs.estado).toBe('SENT')
      await expect(pos.resultado()).resolves.toMatchObject({ requestId })
    })
  })
})

describe('Codex R1 · P1-7: la procedencia del Payment y de los eventos', () => {
  it('un Payment con la llave del intento pero de OTRA terminal/solicitud no se atribuye: NOT_RECORDED con contradicción declarada', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const venta = await f.nuevaVenta()
    await prisma.payment.create({
      data: {
        venueId: f.venueId,
        orderId: venta.id,
        amount: 100,
        tipAmount: 0,
        status: 'COMPLETED',
        method: 'CREDIT_CARD',
        source: 'TPV',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 100,
        idempotencyKey: A,
        processedById: f.staffId,
        processorData: { deviceSerialNumber: 'AVQD-N86AJENA0001' },
      },
    })
    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({ outcome: 'NOT_RECORDED', paymentId: null, isWinner: false, paymentContradiction: true })
    expect(estado!.request).toMatchObject({ status: 'SENT', outcome: 'UNRESOLVED' })
    expect(JSON.stringify(estado)).not.toContain('NOT_CHARGED')
  })

  it('un approved de OTRO venue con este attemptId (LINK_VENUE_MISMATCH) no es evidencia de este intento', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    // Un venue REAL distinto (misma organización): el evento quedó atado a él cuando el receptor no coincidió con el vínculo.
    const otro = await prisma.venue.create({
      data: {
        id: `${f.venueId}-otro`,
        organizationId: f.fixture,
        name: `${f.fixture}-otro`,
        slug: `${f.fixture}-otro`,
        timezone: 'America/Mexico_City',
        currency: 'MXN',
      },
    })
    try {
      await prisma.providerEventLog.create({
        data: {
          provider: 'PAYMENT_PROCESSOR',
          eventId: `angelpay-${f.fixture}-ajeno-${A}`,
          type: 'send_transaction',
          payload: { event_type: 'send_transaction', payload: { status: 'approved', integratorReference: A, amount: '000000010000' } },
          status: 'ERROR',
          errorReason: 'LINK_VENUE_MISMATCH',
          attemptId: A,
          venueId: otro.id,
        },
      })
      expect((await consultar(A))!.attempt.processorEvidence).toBe('NONE')
    } finally {
      await prisma.providerEventLog.deleteMany({ where: { venueId: otro.id } })
      await prisma.venue.delete({ where: { id: otro.id } })
    }
  })

  it('P2: un Payment COMPLETED con `type` NULL (fila vieja) cuenta como RECORDED', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const pago = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: solicitud.requestId }), f.staffId)
    await prisma.$executeRaw`UPDATE "Payment" SET "type" = NULL WHERE "id" = ${pago.id}`
    expect((await consultar(A))!.attempt).toMatchObject({ outcome: 'RECORDED', paymentId: pago.id, isWinner: true })
  })

  it('P2: un approved antiguo no se pierde detrás de doce declined posteriores', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const base = { provider: 'PAYMENT_PROCESSOR' as const, type: 'send_transaction', attemptId: A, venueId: f.venueId }
    await prisma.providerEventLog.create({
      data: {
        ...base,
        eventId: `angelpay-${f.fixture}-viejo-${A}`,
        status: 'PENDING',
        errorReason: 'AMOUNT_MISMATCH',
        payload: { event_type: 'send_transaction', payload: { status: 'approved', integratorReference: A } },
        createdAt: new Date(Date.now() - 60_000),
      },
    })
    for (let i = 0; i < 12; i++) {
      await prisma.providerEventLog.create({
        data: {
          ...base,
          eventId: `angelpay-${f.fixture}-declined-${i}-${A}`,
          status: 'ERROR',
          errorReason: 'NOT_APPROVED',
          payload: { event_type: 'send_transaction', payload: { status: 'declined', integratorReference: A } },
        },
      })
    }
    expect((await consultar(A))!.attempt.processorEvidence).toBe('APPROVED')
  })
})

describe('Codex R1 · P2: el long-poll al vencer relee la fila', () => {
  afterEach(() => {
    delete process.env.TERMINAL_PAYMENT_LONG_POLL_MS
  })

  it('con la fila ya COMPLETED por REST (aviso perdido), al vencer contesta success, no timeout', async () => {
    // Vence DESPUÉS de que el REST cierre la fila: lo que se prueba es la relectura al vencer. La ventana es holgada (10 s) porque
    // bajo carga el vínculo + el REST pueden tardar varios segundos; y si aun así el REST terminara DESPUÉS de vencer la ventana, la
    // prueba no pudo observar la relectura ⇒ INCONCLUSO (no un rojo falso por carga; el runner certificado no lo cuenta como caída).
    const VENTANA_MS = 10_000
    process.env.TERMINAL_PAYMENT_LONG_POLL_MS = `${VENTANA_MS}`
    const A = actores()
    const inicio = Date.now()
    const { requestId, pos, limpiar } = await posEsperandoComoActor(A)
    const obs = { pagoId: '', desenlace: null as Awaited<ReturnType<typeof A.carrera>> | null, restTerminoEn: 0 }
    let fallo: Fallo = null
    try {
      const attemptId = await vincular(requestId)
      obs.pagoId = (await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId, requestId }), f.staffId)).id
      obs.restTerminoEn = Date.now() - inicio
      if (obs.restTerminoEn >= VENTANA_MS - 500)
        throw new Error(
          `INCONCLUSO — el REST cerró la fila a los ${obs.restTerminoEn} ms, con la ventana del long-poll (${VENTANA_MS} ms) ya vencida: no se pudo observar la relectura al vencer`,
        )
      obs.desenlace = await A.carrera(pos, VENTANA_MS + 5000)
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'long-poll del POS': limpiar })
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      expect(obs.desenlace).toMatchObject({ estado: 'ASENTADA', ok: true, value: { requestId, status: 'success', paymentId: obs.pagoId } })
    })
  })

  it('sin desenlace durable, al vencer contesta timeout (incierto) y la fila sigue en vuelo', async () => {
    process.env.TERMINAL_PAYMENT_LONG_POLL_MS = '500'
    const A = actores()
    const { requestId, pos, limpiar } = await posEsperandoComoActor(A)
    const obs = { desenlace: null as Awaited<ReturnType<typeof A.carrera>> | null, estado: '' }
    let fallo: Fallo = null
    try {
      obs.desenlace = await A.carrera(pos, 3000)
      obs.estado = (await fila(requestId)).status
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'long-poll del POS': limpiar })
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      expect(obs.desenlace).toMatchObject({ estado: 'ASENTADA', ok: true, value: { requestId, status: 'timeout' } })
      expect(obs.estado).toBe('SENT')
    })
  })
})

describe('Codex R2 · P1-7: la evidencia del procesador también exige procedencia', () => {
  it('un approved del MISMO venue pero con el serial de OTRA terminal (LINK_TERMINAL_MISMATCH) no es evidencia: NONE + contradicción declarada', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        eventId: `angelpay-${f.fixture}-serial-ajeno-${A}`,
        type: 'send_transaction',
        payload: f.eventoAngelPay(A, { terminalSerial: 'N86OTRATERMINAL' }) as never,
        status: 'ERROR',
        errorReason: 'LINK_TERMINAL_MISMATCH',
        attemptId: A,
        venueId: f.venueId,
      },
    })
    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({ processorEvidence: 'NONE', evidenceContradiction: true, outcome: 'NOT_RECORDED' })
    expect(JSON.stringify(estado)).not.toContain('NOT_CHARGED')
  })

  it('un approved de la terminal CORRECTA con importe discrepante (AMOUNT_MISMATCH) sigue siendo APPROVED aunque exista otro contradictorio', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        eventId: `angelpay-${f.fixture}-serial-ajeno-${A}`,
        type: 'send_transaction',
        payload: f.eventoAngelPay(A, { terminalSerial: 'N86OTRATERMINAL' }) as never,
        status: 'ERROR',
        errorReason: 'LINK_TERMINAL_MISMATCH',
        attemptId: A,
        venueId: f.venueId,
        createdAt: new Date(Date.now() - 1000),
      },
    })
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        eventId: `angelpay-${f.fixture}-propio-${A}`,
        type: 'send_transaction',
        payload: f.eventoAngelPay(A, { amount: '000000012000' }) as never,
        status: 'PENDING',
        errorReason: 'AMOUNT_MISMATCH',
        attemptId: A,
        venueId: f.venueId,
      },
    })
    expect((await consultar(A))!.attempt).toMatchObject({ processorEvidence: 'APPROVED', evidenceContradiction: true })
  })
})

describe('Codex R3 · P2: la evidencia se recorre por PÁGINAS hasta encontrar la propia', () => {
  it('un approved PROPIO antiguo detrás de 30 approved de OTRA terminal (contradicciones) y de un declined propio reciente sigue siendo APPROVED, con la contradicción declarada', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const base = { provider: 'PAYMENT_PROCESSOR' as const, type: 'send_transaction', attemptId: A, venueId: f.venueId }
    await prisma.providerEventLog.create({
      data: {
        ...base,
        eventId: `angelpay-${f.fixture}-propio-viejo-${A}`,
        status: 'PENDING',
        errorReason: 'AMOUNT_MISMATCH',
        payload: f.eventoAngelPay(A, { amount: '000000012000' }) as never,
        createdAt: new Date(Date.now() - 180_000),
      },
    })
    for (let i = 0; i < 30; i++) {
      await prisma.providerEventLog.create({
        data: {
          ...base,
          eventId: `angelpay-${f.fixture}-ajeno-${i}-${A}`,
          status: 'ERROR',
          errorReason: 'LINK_TERMINAL_MISMATCH',
          payload: f.eventoAngelPay(A, { terminalSerial: 'N86OTRATERMINAL' }) as never,
          createdAt: new Date(Date.now() - 120_000 + i * 1000),
        },
      })
    }
    await prisma.providerEventLog.create({
      data: {
        ...base,
        eventId: `angelpay-${f.fixture}-propio-declined-${A}`,
        status: 'ERROR',
        errorReason: 'NOT_APPROVED',
        payload: f.eventoAngelPay(A, { status: 'declined' }) as never,
      },
    })
    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({ processorEvidence: 'APPROVED', evidenceContradiction: true, outcome: 'NOT_RECORDED' })
    expect(JSON.stringify(estado)).not.toContain('NOT_CHARGED')
  })

  it('sin approved propio, 30 approved de OTRA terminal no ocultan el declined propio: DECLINED (evidencia) con contradicción, nunca «no cobrado»', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const base = { provider: 'PAYMENT_PROCESSOR' as const, type: 'send_transaction', attemptId: A, venueId: f.venueId }
    await prisma.providerEventLog.create({
      data: {
        ...base,
        eventId: `angelpay-${f.fixture}-propio-declined-${A}`,
        status: 'ERROR',
        errorReason: 'NOT_APPROVED',
        payload: f.eventoAngelPay(A, { status: 'declined' }) as never,
        createdAt: new Date(Date.now() - 180_000),
      },
    })
    for (let i = 0; i < 30; i++) {
      await prisma.providerEventLog.create({
        data: {
          ...base,
          eventId: `angelpay-${f.fixture}-ajeno-${i}-${A}`,
          status: 'ERROR',
          errorReason: 'LINK_TERMINAL_MISMATCH',
          payload: f.eventoAngelPay(A, { terminalSerial: 'N86OTRATERMINAL' }) as never,
          createdAt: new Date(Date.now() - 120_000 + i * 1000),
        },
      })
    }
    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({ processorEvidence: 'DECLINED', evidenceContradiction: true, outcome: 'NOT_RECORDED' })
    expect(JSON.stringify(estado)).not.toContain('NOT_CHARGED')
  })

  it('un approved propio RECIENTE con 24 rechazos propios en la primera página y 30 contradicciones de OTRA terminal más antiguas: APPROVED y la contradicción se declara aunque el barrido pare en la primera página', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const base = { provider: 'PAYMENT_PROCESSOR' as const, type: 'send_transaction', attemptId: A, venueId: f.venueId }
    for (let i = 0; i < 30; i++) {
      await prisma.providerEventLog.create({
        data: {
          ...base,
          eventId: `angelpay-${f.fixture}-ajeno-${i}-${A}`,
          status: 'ERROR',
          errorReason: 'LINK_TERMINAL_MISMATCH',
          payload: f.eventoAngelPay(A, { terminalSerial: 'N86OTRATERMINAL' }) as never,
          createdAt: new Date(Date.now() - 300_000 + i * 1000),
        },
      })
    }
    for (let i = 0; i < 24; i++) {
      await prisma.providerEventLog.create({
        data: {
          ...base,
          eventId: `angelpay-${f.fixture}-propio-declined-${i}-${A}`,
          status: 'ERROR',
          errorReason: 'NOT_APPROVED',
          payload: f.eventoAngelPay(A, { status: 'declined' }) as never,
          createdAt: new Date(Date.now() - 120_000 + i * 1000),
        },
      })
    }
    await prisma.providerEventLog.create({
      data: {
        ...base,
        eventId: `angelpay-${f.fixture}-propio-approved-${A}`,
        status: 'PENDING',
        errorReason: 'AMOUNT_MISMATCH',
        payload: f.eventoAngelPay(A, { amount: '000000012000' }) as never,
      },
    })
    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({ processorEvidence: 'APPROVED', evidenceContradiction: true, outcome: 'NOT_RECORDED' })
  })
})

describe('Codex R4 (P2) · S6 resuelve la evidencia EXACTA en una sola consulta, sin presupuesto de páginas', () => {
  it('un approved PROPIO antiguo detrás de 300 approved de OTRA terminal y de 49 rechazos propios más recientes: APPROVED con la contradicción declarada — antes el barrido de 8 × 25 no llegaba', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const base = { provider: 'PAYMENT_PROCESSOR' as const, type: 'send_transaction', attemptId: A, venueId: f.venueId }
    const ahora = Date.now()
    await prisma.providerEventLog.createMany({
      data: [
        {
          ...base,
          eventId: `angelpay-${f.fixture}-propio-viejo-${A}`,
          status: 'PENDING',
          errorReason: 'AMOUNT_MISMATCH',
          payload: f.eventoAngelPay(A, { amount: '000000012000' }) as never,
          createdAt: new Date(ahora - 900_000),
        },
        ...Array.from({ length: 300 }, (_, i) => ({
          ...base,
          eventId: `angelpay-${f.fixture}-ajeno-${i}-${A}`,
          status: 'ERROR' as const,
          errorReason: i % 2 === 0 ? 'LINK_TERMINAL_MISMATCH' : null,
          // La mitad la rechazó S2 (`LINK_TERMINAL_MISMATCH`); la otra mitad sólo delata su serial ajeno en el payload.
          payload: f.eventoAngelPay(A, { terminalSerial: i % 3 === 0 ? 'AVQD-N86OTRATERMINAL' : 'n86otraterminal' }) as never,
          createdAt: new Date(ahora - 600_000 + i * 1000),
        })),
        ...Array.from({ length: 49 }, (_, i) => ({
          ...base,
          eventId: `angelpay-${f.fixture}-propio-declined-${i}-${A}`,
          status: 'ERROR' as const,
          errorReason: 'NOT_APPROVED',
          payload: f.eventoAngelPay(A, { status: 'declined' }) as never,
          createdAt: new Date(ahora - 60_000 + i * 1000),
        })),
      ],
    })
    const consultas = jest.spyOn(prisma, '$queryRaw')
    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({ processorEvidence: 'APPROVED', evidenceContradiction: true, outcome: 'NOT_RECORDED' })
    expect(estado!.attempt.processorEvidenceAt).toBe(new Date(ahora - 900_000).toISOString())
    expect(JSON.stringify(estado)).not.toContain('NOT_CHARGED')
    // Una sola consulta de evidencia (no hay páginas que agotar).
    expect(consultas.mock.calls.filter(([sql]) => Array.isArray(sql) && sql.join('?').includes('"ProviderEventLog"'))).toHaveLength(1)
    consultas.mockRestore()
  })

  it('el serial del payload se normaliza EN SQL con la misma regla que la llave de la terminal: con prefijo AVQD- y otra caja es PROPIO, no contradicción', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        type: 'send_transaction',
        attemptId: A,
        venueId: f.venueId,
        eventId: `angelpay-${f.fixture}-propio-prefijo-${A}`,
        status: 'ERROR',
        errorReason: 'NOT_APPROVED',
        payload: f.eventoAngelPay(A, { status: 'declined', terminalSerial: `  avqd-${f.serialCrudo.toLowerCase()} ` }) as never,
      },
    })
    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({ processorEvidence: 'DECLINED', evidenceContradiction: false })
  })
})

describe('Codex R5 · P3: el serial del payload se recorta EN SQL con la MISMA clase de espacios que `trim` de JS', () => {
  it('tabulador, salto de línea y NBSP alrededor del serial (lo que `String.prototype.trim` quita): PROPIO, no contradicción', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        type: 'send_transaction',
        attemptId: A,
        venueId: f.venueId,
        eventId: `angelpay-${f.fixture}-propio-espacios-${A}`,
        status: 'ERROR',
        errorReason: 'NOT_APPROVED',
        payload: f.eventoAngelPay(A, { status: 'declined', terminalSerial: `\t\n AVQD-${f.serialCrudo}\u00a0\ufeff` }) as never,
      },
    })
    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({ processorEvidence: 'DECLINED', evidenceContradiction: false })
  })
})

describe('Codex R13-7 · la pregunta INVERSA de R12-6: «OTRA solicitud apunta a MI Payment» — una reclamación ajena sólo veta el cierre si está ACREDITADA por el mismo criterio; un alias contaminado se registra y se resuelve, y el cargo auténtico cierra su solicitud (replay y barrido)', () => {
  const MARCA_ALIAS = 'TERMINAL_PAYMENT_CONTAMINATED_ALIAS_RESOLVED'
  const bitacora = (action: string) => (logAction as jest.Mock).mock.calls.filter(([p]) => p?.action === action).map(([p]) => p)
  let otroSerial: string
  beforeAll(async () => {
    otroSerial = `AVQD-N86AJENA${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    await prisma.terminal.create({ data: { venueId: f.venueId, name: 'Otra terminal', serialNumber: otroSerial, type: 'TPV_ANDROID' } })
  })
  afterAll(async () => {
    await prisma.terminal.deleteMany({ where: { serialNumber: otroSerial } })
  })
  const pago = (id: string) => exigir(prisma.payment.findUnique({ where: { id } }))
  /**
   * El escenario histórico de Codex: P es un Payment COMPLETED de $100, ACREDITADO (etiqueta + terminal) para Q-real, que todavía
   * necesita reparar su vínculo (fila UNKNOWN sin puntero — reteniendo la ranura de su terminal); Q-ajena (en OTRA terminal) quedó
   * UNKNOWN con `paymentId = P` por el antiguo productor no-success.
   */
  const escenario = async () => {
    const Qreal = await f.solicitud()
    const A = await vincular(Qreal.requestId)
    const P = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: Qreal.requestId }), f.staffId)
    expect(P.status).toBe('COMPLETED')
    expect(await fila(Qreal.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: P.id })
    expect(await pago(P.id)).toMatchObject({ terminalPaymentRequestId: Qreal.requestId })
    await prisma.terminalPaymentRequest.update({
      where: { requestId: Qreal.requestId },
      data: {
        status: 'UNKNOWN',
        paymentId: null,
        closedVia: null,
        resultJson: { requestId: Qreal.requestId, status: 'timeout' },
        lateResult: false,
      },
    })
    const Qajena = await f.solicitud({
      terminalId: terminalIdentityKey(otroSerial),
      status: 'UNKNOWN',
      paymentId: P.id,
      resultJson: { status: 'timeout', paymentId: P.id },
    })
    return { Qreal, Qajena, P, A }
  }
  const aliasResuelto = async (Qajena: { requestId: string }, Qreal: { requestId: string }, P: { id: string }) => {
    expect(await fila(Qajena.requestId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })
    expect(bitacora(MARCA_ALIAS)).toEqual([
      expect.objectContaining({
        venueId: f.venueId,
        entity: 'TerminalPaymentRequest',
        entityId: Qajena.requestId,
        data: expect.objectContaining({
          requestId: Qajena.requestId,
          paymentId: P.id,
          authenticRequestId: Qreal.requestId,
          reason: expect.any(String),
        }),
      }),
    ])
  }
  const QrealCerradaConP = async (Qreal: { requestId: string }, P: { id: string }, A: string) => {
    expect(await fila(Qreal.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: P.id, lateResult: true })
    expect(await pago(P.id)).toMatchObject({ status: 'COMPLETED', terminalPaymentRequestId: Qreal.requestId })
    // Observación S6 (la consulta durable por intento, la que usan terminal y POS): el intento de Q-real es el ganador y la solicitud está cobrada.
    const estado = await consultar(A)
    expect(estado!.attempt).toMatchObject({
      attemptId: A,
      outcome: 'RECORDED',
      paymentId: P.id,
      isWinner: true,
      paymentContradiction: false,
    })
    expect(estado!.request).toMatchObject({ requestId: Qreal.requestId, status: 'COMPLETED', outcome: 'CHARGED', paymentId: P.id })
  }

  it('REPLAY: el registro repetido de P (misma llave, etiquetado con Q-real) cierra Q-real a pesar del alias de Q-ajena — Q-real COMPLETED y ligada, el alias de Q-ajena retirado con bitácora, S6 lo confirma', async () => {
    const { Qreal, Qajena, P, A } = await escenario()
    const replay = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: Qreal.requestId }), f.staffId)
    expect(replay.id).toBe(P.id)
    await QrealCerradaConP(Qreal, P, A)
    await aliasResuelto(Qajena, Qreal, P)
    expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(1)
  })

  it('BARRIDO: la recuperación (`reconcileUnknownRequests`) cierra Q-real con P a pesar del alias de Q-ajena — COMPLETED tardía, alias retirado con bitácora, S6 lo confirma', async () => {
    const { Qreal, Qajena, P, A } = await escenario()
    const r = await terminalPaymentService.reconcileUnknownRequests()
    expect(r.completed).toBeGreaterThanOrEqual(1)
    await QrealCerradaConP(Qreal, P, A)
    await aliasResuelto(Qajena, Qreal, P)
    expect(bitacora('TERMINAL_PAYMENT_LATE_RECONCILED')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ requestId: Qreal.requestId, paymentId: P.id }) }),
    ])
  })

  it('CONTROL INVERSO (cierre): cuando la otra solicitud ES el dueño acreditado (P etiquetado con ella y cobrado en su terminal), el cierre de otra solicitud con P se sigue rechazando con PAYMENT_BOUND_ELSEWHERE, sin tocar al dueño ni dejar bitácora de alias', async () => {
    const Qduena = await f.solicitud()
    const A = await vincular(Qduena.requestId)
    const P = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: Qduena.requestId }), f.staffId)
    expect(await fila(Qduena.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: P.id })
    const Qotra = await f.solicitud({ status: 'UNKNOWN' })
    const cierre = await prisma.$transaction(tx =>
      terminalPaymentService.closeRowFromPaymentTx(tx, Qotra.requestId, P.id, f.venueId, undefined, 'REST', f.serial),
    )
    expect(cierre).toMatchObject({ bound: false, reason: 'PAYMENT_BOUND_ELSEWHERE' })
    expect(await fila(Qduena.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: P.id })
    expect(await fila(Qotra.requestId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })
    expect(await pago(P.id)).toMatchObject({ terminalPaymentRequestId: Qduena.requestId })
    expect(bitacora(MARCA_ALIAS)).toEqual([])
  })

  it('CONTROL INVERSO (barrido): un candidato cuya COLUMNA de ganador acredita a OTRA solicitud (dueña, cobrado en su terminal) no cierra la fila UNKNOWN aunque su `processorData` la nombre — la reclamación acreditada se conserva y no hay alias que resolver', async () => {
    const Qduena = await f.solicitud()
    const A = await vincular(Qduena.requestId)
    const P = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, requestId: Qduena.requestId }), f.staffId)
    const Qotra = await f.solicitud({ status: 'UNKNOWN' })
    // Inconsistencia histórica: la huella en `processorData` nombra a Q-otra, pero la COLUMNA (la evidencia fuerte) acredita a Q-dueña.
    const datos = (await pago(P.id)).processorData as Record<string, unknown>
    await prisma.payment.update({
      where: { id: P.id },
      data: { processorData: { ...datos, terminalPaymentRequestId: Qotra.requestId } as never, terminalPaymentRequestId: Qduena.requestId },
    })
    await terminalPaymentService.reconcileUnknownRequests()
    expect(await fila(Qotra.requestId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })
    expect(await fila(Qduena.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: P.id })
    expect(bitacora(MARCA_ALIAS)).toEqual([])
  })
})

describe('Codex R14-4 · la limpieza de aliases NO espera a otra solicitud: cada alias ajeno se toma con NOWAIT dentro de un savepoint (55P03 ⇒ diferido con bitácora), se relee bajo el candado y se retira con CAS exacto; el barrido recupera lo diferido', () => {
  const ALIAS_RESUELTO = 'TERMINAL_PAYMENT_CONTAMINATED_ALIAS_RESOLVED'
  const ALIAS_DIFERIDO = 'TERMINAL_PAYMENT_CONTAMINATED_ALIAS_DEFERRED'
  const bitacora = (action: string) => (logAction as jest.Mock).mock.calls.filter(([p]) => p?.action === action).map(([p]) => p)
  const pago = (id: string) => exigir(prisma.payment.findUnique({ where: { id } }))
  type Servicio = {
    reclamacionesAjenas: (...args: unknown[]) => Promise<unknown>
    retirarAliasAjeno: (...args: unknown[]) => Promise<unknown>
  }
  const servicio = terminalPaymentService as unknown as Servicio
  let otroSerial: string
  let tercerSerial: string
  beforeAll(async () => {
    otroSerial = `AVQD-N86CRUZADA${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    tercerSerial = `AVQD-N86TERCERA${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    await prisma.terminal.createMany({
      data: [
        { venueId: f.venueId, name: 'Terminal cruzada', serialNumber: otroSerial, type: 'TPV_ANDROID' },
        { venueId: f.venueId, name: 'Terminal tercera', serialNumber: tercerSerial, type: 'TPV_ANDROID' },
      ],
    })
  })
  afterAll(async () => {
    await prisma.terminal.deleteMany({ where: { serialNumber: { in: [otroSerial, tercerSerial] } } })
  })
  afterEach(() => jest.restoreAllMocks())
  /** Un cobro REAL, acreditado para su solicitud, en la terminal dada; la solicitud vuelve a UNKNOWN (sin puntero) para que el replay la repare. */
  const cobroReal = async (serial: string) => {
    const Q = await f.solicitud({ terminalId: terminalIdentityKey(serial) })
    const A = await vincular(Q.requestId, randomUUID(), serial)
    const registro = {
      ...f.registroDeLaTerminal({ attemptId: A, requestId: Q.requestId, serialAutenticado: serial }),
      deviceSerialNumber: serial,
    }
    const P = await recordFastPayment(f.venueId, registro, f.staffId)
    expect(P.status).toBe('COMPLETED')
    expect(await fila(Q.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: P.id })
    expect(await pago(P.id)).toMatchObject({ terminalPaymentRequestId: Q.requestId })
    await prisma.terminalPaymentRequest.update({
      where: { requestId: Q.requestId },
      data: {
        status: 'UNKNOWN',
        paymentId: null,
        closedVia: null,
        resultJson: { requestId: Q.requestId, status: 'timeout' },
        lateResult: false,
      },
    })
    return { Q, A, P, registro }
  }
  /** El escenario de Codex: P1/P2 reales (terminales distintas), Q1 y Q2 UNKNOWN con los punteros CRUZADOS (Q1→P2, Q2→P1). */
  const cruzado = async () => {
    const uno = await cobroReal(f.serial)
    const dos = await cobroReal(otroSerial)
    await prisma.terminalPaymentRequest.update({ where: { requestId: uno.Q.requestId }, data: { paymentId: dos.P.id } })
    await prisma.terminalPaymentRequest.update({ where: { requestId: dos.Q.requestId }, data: { paymentId: uno.P.id } })
    return { uno, dos }
  }
  /** Una puerta de N llegadas: cada cierre avisa que llegó (con sus candados tomados) y espera a que la prueba la abra. */
  const puerta = (n: number) => {
    let llegados = 0
    let abrir!: () => void
    let todos!: () => void
    const abierta = new Promise<void>(r => (abrir = r))
    const todosLlegaron = new Promise<void>(r => (todos = r))
    const llegadosEn = (ms: number) =>
      Promise.race([
        todosLlegaron.then(() => true),
        new Promise<boolean>(r => {
          const t = setTimeout(() => r(false), ms)
          t.unref?.()
        }),
      ])
    return {
      abrir,
      llegadosEn,
      llegar: async () => {
        if (++llegados === n) todos()
        await abierta
      },
    }
  }
  const cerradaCon = async (Q: { requestId: string }, P: { id: string }, A: string, serial: string) => {
    expect(await fila(Q.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: P.id })
    expect(await pago(P.id)).toMatchObject({ status: 'COMPLETED', terminalPaymentRequestId: Q.requestId })
    const estado = await consultar(A, serial)
    expect(estado!.attempt).toMatchObject({
      attemptId: A,
      outcome: 'RECORDED',
      paymentId: P.id,
      isWinner: true,
      paymentContradiction: false,
    })
    expect(estado!.request).toMatchObject({ requestId: Q.requestId, status: 'COMPLETED', outcome: 'CHARGED', paymentId: P.id })
  }

  it('CARRERA: dos replays simultáneos con aliases cruzados — cada cierre posee su solicitud y su Payment y sólo entonces limpia; ninguno espera al otro (55P03 ⇒ DIFERIDO), los dos terminan, Q1→P1 y Q2→P2, dos ventas y S6 correcto en las dos terminales', async () => {
    const { uno, dos } = await cruzado()
    const A = actores()
    const g = puerta(2)
    const real = servicio.reclamacionesAjenas.bind(terminalPaymentService)
    jest.spyOn(servicio, 'reclamacionesAjenas').mockImplementation(async (...args: unknown[]) => {
      const ctx = args[1] as { origen: string }
      if (ctx.origen === 'cierre') await g.llegar()
      return real(...args)
    })
    const replay1 = A.lanzar('replay Q1/P1', recordFastPayment(f.venueId, uno.registro, f.staffId))
    const replay2 = A.lanzar('replay Q2/P2', recordFastPayment(f.venueId, dos.registro, f.staffId))
    const obs = { ambosDentro: false }
    let fallo: Fallo = null
    try {
      // Los DOS cierres llegan a la limpieza con sus candados tomados (solicitud propia + Payment): la espera circular está armada.
      obs.ambosDentro = await g.llegadosEn(8000)
    } catch (error) {
      fallo = { error }
    } finally {
      await A.liberar({ 'puerta de los dos cierres': () => g.abrir() })
    }
    await A.cerrar(fallo)
    await A.afirmar(async () => {
      // Los actores primero (los dos replays TERMINAN, cada uno con su Payment), la propiedad después.
      await expect(replay1.resultado()).resolves.toMatchObject({ id: uno.P.id })
      await expect(replay2.resultado()).resolves.toMatchObject({ id: dos.P.id })
      expect(obs.ambosDentro).toBe(true)
      await cerradaCon(uno.Q, uno.P, uno.A, f.serial)
      await cerradaCon(dos.Q, dos.P, dos.A, otroSerial)
      expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(2)
      // Cada cierre encontró la fila del otro TOMADA y la difirió (sin esperar); el puntero cruzado de cada fila lo reemplazó su
      // propio cierre. Nadie esperó a nadie: ni deadlock ni ERROR.
      expect(bitacora(ALIAS_DIFERIDO)).toHaveLength(2)
      expect(
        bitacora(ALIAS_DIFERIDO)
          .map(p => p.entityId)
          .sort(),
      ).toEqual([uno.Q.requestId, dos.Q.requestId].sort())
      expect(bitacora(ALIAS_RESUELTO)).toEqual([])
    })
  })

  it('CONTROL del puntero que cambió ANTES del CAS: la fila ajena deja de apuntar a este Payment entre la lista sin candado y el candado — la relectura lo ve, no se retira nada y su puntero nuevo se conserva; el cierre auténtico sigue', async () => {
    const { Q, A, P, registro } = await cobroReal(f.serial)
    const Qajena = await f.solicitud({ terminalId: terminalIdentityKey(otroSerial), status: 'UNKNOWN', paymentId: P.id })
    const otroPago = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID() }), f.staffId)
    const AC = actores()
    let soltar!: () => void
    let pausado!: () => void
    const liberada = new Promise<void>(r => (soltar = r))
    const enPausa = new Promise<void>(r => (pausado = r))
    const real = servicio.retirarAliasAjeno.bind(terminalPaymentService)
    // Se detiene DESPUÉS de listar (sin candado) y ANTES de tomar la fila ajena: ahí el puntero cambia.
    jest.spyOn(servicio, 'retirarAliasAjeno').mockImplementationOnce(async (...args: unknown[]) => {
      pausado()
      await liberada
      return real(...args)
    })
    const replay = AC.lanzar('replay Q/P', recordFastPayment(f.venueId, registro, f.staffId))
    const obs = { pausado: false }
    let fallo: Fallo = null
    try {
      obs.pausado = await Promise.race([enPausa.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 5000))])
      await prisma.terminalPaymentRequest.update({ where: { requestId: Qajena.requestId }, data: { paymentId: otroPago.id } })
    } catch (error) {
      fallo = { error }
    } finally {
      await AC.liberar({ 'sonda del alias': () => soltar() })
    }
    await AC.cerrar(fallo)
    await AC.afirmar(async () => {
      await expect(replay.resultado()).resolves.toMatchObject({ id: P.id })
      expect(obs.pausado).toBe(true)
      await cerradaCon(Q, P, A, f.serial)
      expect(await fila(Qajena.requestId)).toMatchObject({ status: 'UNKNOWN', paymentId: otroPago.id })
      expect(bitacora(ALIAS_RESUELTO)).toEqual([])
      expect(bitacora(ALIAS_DIFERIDO)).toEqual([])
    })
  })

  it('BARRIDO recupera lo DIFERIDO: una fila UNKNOWN que sigue apuntando a un Payment SIN procedencia (el cierre que lo halló tomada ya terminó COMPLETED) suelta ese alias en el barrido, con bitácora; un puntero ACREDITADO no se retira (es el ganador que cierra la fila)', async () => {
    const { Q, A, P, registro } = await cobroReal(f.serial)
    // El alias diferido: Q-ajena (otra terminal) sigue apuntando a P después de que el cierre de Q terminó.
    const Qajena = await f.solicitud({ terminalId: terminalIdentityKey(otroSerial), status: 'UNKNOWN', paymentId: P.id })
    await prisma.terminalPaymentRequest.update({ where: { requestId: Q.requestId }, data: { status: 'COMPLETED', paymentId: P.id } })
    // Y un puntero LEGÍTIMO (en la terminal propia, ya libre: Q cerró): Q-propia UNKNOWN apunta a un cobro ACREDITADO suyo — el
    // barrido lo conserva como ganador (cierra la fila con él), no lo retira.
    const Qpropia = await f.solicitud()
    const Apropia = await vincular(Qpropia.requestId)
    const Ppropia = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: Apropia, requestId: Qpropia.requestId }),
      f.staffId,
    )
    await prisma.terminalPaymentRequest.update({
      where: { requestId: Qpropia.requestId },
      data: { status: 'UNKNOWN', paymentId: Ppropia.id, closedVia: null },
    })
    // Y un ganador REEMBOLSADO (acreditado en fase «ganador», pero ya no elegible para ligar): su puntero también se conserva.
    const Qref = await f.solicitud({ terminalId: terminalIdentityKey(tercerSerial) })
    const Aref = await vincular(Qref.requestId, randomUUID(), tercerSerial)
    const Pref = await recordFastPayment(
      f.venueId,
      {
        ...f.registroDeLaTerminal({ attemptId: Aref, requestId: Qref.requestId, serialAutenticado: tercerSerial }),
        deviceSerialNumber: tercerSerial,
      },
      f.staffId,
    )
    await prisma.terminalPaymentRequest.update({
      where: { requestId: Qref.requestId },
      data: { status: 'UNKNOWN', paymentId: Pref.id, closedVia: null },
    })
    await prisma.payment.update({ where: { id: Pref.id }, data: { status: 'REFUNDED' } })

    const r = await terminalPaymentService.reconcileUnknownRequests()
    expect(r.aliasesRetirados).toBe(1)
    expect(await fila(Qajena.requestId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })
    expect(await fila(Qpropia.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: Ppropia.id })
    expect(await fila(Qref.requestId)).toMatchObject({ status: 'UNKNOWN', paymentId: Pref.id })
    expect(await fila(Q.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: P.id })
    expect(bitacora(ALIAS_RESUELTO)).toEqual([
      expect.objectContaining({
        entityId: Qajena.requestId,
        data: expect.objectContaining({ requestId: Qajena.requestId, paymentId: P.id, origen: 'barrido' }),
      }),
    ])
    // Idempotente: la siguiente pasada no encuentra nada que retirar.
    expect((await terminalPaymentService.reconcileUnknownRequests()).aliasesRetirados).toBe(0)
    expect(A).toBeDefined()
    expect(registro).toBeDefined()
  })
})

/**
 * 🔴 «Ninguna terminal muerta» (founder, 22-sep) — spec
 * `docs/superpowers/specs/2026-09-22-ninguna-terminal-muerta-cobro-local-design.md`, pieza A.
 *
 * Un **Pago rápido** (cobro iniciado EN la terminal, sin solicitud del POS) no tiene
 * `TerminalPaymentAttemptLink` —esa tabla exige `requestId` con FK—, así que S6 devolvía `null` ⇒ 404
 * ⇒ la pantalla se quedaba sin reloj, sin botón y sin reintento, y la fila `INDETERMINADO` sin
 * `orderId` apartaba EL APARATO ENTERO. Medido en la N86: 13 de 27 intentos son de esta clase.
 *
 * La consulta es POR INTENTO: sin vínculo contesta igual con lo que SÍ consta de ESA terminal.
 */
describe('Ninguna terminal muerta · S6 contesta también sin solicitud del POS (cobro LOCAL)', () => {
  it('cobro local YA registrado: RECORDED con su Payment, sin solicitud ni vínculo', async () => {
    const A = randomUUID()
    const pago = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A }), f.staffId)
    expect(pago.terminalPaymentRequestId).toBeNull()

    const visto = await consultar(A)
    expect(visto).not.toBeNull()
    expect(visto!.attempt.outcome).toBe<AttemptOutcome>('RECORDED')
    expect(visto!.attempt.paymentId).toBe(pago.id)
    // No hay solicitud que reportar: el espejo del cliente ya tolera ambos en null.
    expect(visto!.requestId).toBeNull()
    expect(visto!.request).toBeNull()
  })

  it('cobro local SIN evidencia: contesta NOT_RECORDED/NONE en vez de 404 mudo — es lo que abre la ventana', async () => {
    const visto = await consultar(randomUUID())
    expect(visto).not.toBeNull()
    expect(visto!.attempt.outcome).toBe<AttemptOutcome>('NOT_RECORDED')
    expect(visto!.attempt.processorEvidence).toBe<AttemptProcessorEvidence>('NONE')
    expect(visto!.attempt.paymentId).toBeNull()
    expect(visto!.requestId).toBeNull()
  })

  it('AISLAMIENTO: un cobro local con esa llave pero de OTRA terminal nunca se presenta como dinero propio', async () => {
    const A = randomUUID()
    await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A }), f.staffId)

    const otroSerial = `AVQD-N86${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
    await prisma.terminal.create({ data: { venueId: f.venueId, name: 'otra N86', serialNumber: otroSerial, type: 'TPV_ANDROID' } })

    const visto = await consultar(A, otroSerial)
    expect(visto?.attempt.paymentId ?? null).toBeNull()
    expect(visto?.attempt.outcome ?? 'NOT_RECORDED').not.toBe<AttemptOutcome>('RECORDED')
  })
})

/**
 * Codex (22-sep) RECHAZÓ la pieza A con 2 P1. Los dos nacen de lo mismo: al abrir el camino sin vínculo, la
 * PERTENENCIA del dinero dejó de estar acreditada por nadie y quedó decidida por coincidencias permisivas.
 */
describe('Ninguna terminal muerta · Codex P1: sin vínculo, la pertenencia tiene que ser ACREDITADA', () => {
  it('P1-1 · identidades CRUZADAS: un Payment con snapshot de A y relación de B no es de NINGUNA de las dos', async () => {
    // Lo produce el controlador real: `terminalId` se resuelve con el `deviceSerialNumber` del CUERPO, mientras
    // `processorData.deviceSerialNumber` guarda el serial AUTENTICADO del JWT. Con un `OR` entre ambas identidades,
    // A y B reclamaban el mismo cobro — y la que no cobró soltaba su retención al verlo RECORDED.
    const otroSerial = `AVQD-N86${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
    await prisma.terminal.create({ data: { venueId: f.venueId, name: 'la otra', serialNumber: otroSerial, type: 'TPV_ANDROID' } })
    const A = randomUUID()
    // cuerpo → terminal de la fixture (relación); JWT → la otra (snapshot en processorData)
    await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, serialAutenticado: otroSerial }), f.staffId)

    for (const serial of [f.serial, otroSerial]) {
      // Codex r2 (P3-1): SIN `??`. Con el fallback, un regreso al 404 (`null`) dejaba pasar esta prueba.
      const visto = await consultar(A, serial)
      expect(visto).not.toBeNull()
      expect(visto!.attempt.outcome).toBe<AttemptOutcome>('NOT_RECORDED')
      expect(visto!.attempt.paymentId).toBeNull()
    }
  })

  it('P1-2 · evidencia del webhook SIN serial no es de nadie: no se publica como APPROVED propio', async () => {
    // El SQL vuelve NULL un serial ausente ⇒ `contradice = false`. Con vínculo la pertenencia la daba el vínculo;
    // sin él, un `approved` sin serial se presentaba como propio a CUALQUIER terminal del venue, y el recuperador
    // de la TPV lo guarda de forma durable en la fila consultada.
    const A = randomUUID()
    const { result } = await webhook(A, { terminalSerial: '' })
    expect(result).toBeTruthy()

    // Codex r2 (P3-1): estado EXACTO, no «cualquier cosa menos APPROVED» — así un DECLINED falso tampoco pasa.
    const visto = await consultar(A)
    expect(visto).not.toBeNull()
    expect(visto!.attempt.processorEvidence).toBe<AttemptProcessorEvidence>('NONE')
    expect(visto!.attempt.evidenceContradiction).toBe(false)
  })

  it('CONTROL · con serial PROPIO y sin vínculo, la evidencia sí cuenta (el arreglo no apaga el camino bueno)', async () => {
    const A = randomUUID()
    await webhook(A)
    const visto = await consultar(A)
    expect(visto?.attempt.processorEvidence).toBe<AttemptProcessorEvidence>('APPROVED')
  })
})

/**
 * Codex r2 (P3-2): la guarda `identidadesDelPago.length > 0` estaba escrita pero NO protegida. `[].every(...)` es
 * `true`, así que sin ella un Payment SIN NINGUNA identidad se acreditaba como propio a cualquier terminal del venue.
 * Aquí van ese caso, los dos controles de una sola identidad, y el gemelo `declined` del segundo `max()` de `conDueno`.
 */
describe('Ninguna terminal muerta · Codex r2 P3-2: la pertenencia necesita AL MENOS una identidad', () => {
  /** Degrada un Payment real al estado que describe Codex: sin relación a terminal y sin serial en el snapshot. */
  async function sinNingunaIdentidad(attemptId: string) {
    const pago = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId }), f.staffId)
    const datos = (pago.processorData ?? {}) as Record<string, unknown>
    await prisma.payment.update({
      where: { id: pago.id },
      data: { terminalId: null, processorData: { ...datos, deviceSerialNumber: null } },
    })
    return pago
  }

  it('un Payment SIN ninguna identidad no es de nadie (es la guarda que `[].every()` volvería inútil)', async () => {
    const A = randomUUID()
    await sinNingunaIdentidad(A)
    const visto = await consultar(A)
    expect(visto).not.toBeNull()
    expect(visto!.attempt.outcome).toBe<AttemptOutcome>('NOT_RECORDED')
    expect(visto!.attempt.paymentId).toBeNull()
  })

  it('CONTROL · sólo el SNAPSHOT identifica (sin relación a terminal): sí es propio', async () => {
    const A = randomUUID()
    const pago = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A }), f.staffId)
    await prisma.payment.update({ where: { id: pago.id }, data: { terminalId: null } })
    const visto = await consultar(A)
    expect(visto!.attempt.outcome).toBe<AttemptOutcome>('RECORDED')
    expect(visto!.attempt.paymentId).toBe(pago.id)
  })

  it('CONTROL · sólo la RELACIÓN identifica (sin serial en el snapshot): sí es propio', async () => {
    const A = randomUUID()
    const pago = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A }), f.staffId)
    const datos = (pago.processorData ?? {}) as Record<string, unknown>
    await prisma.payment.update({ where: { id: pago.id }, data: { processorData: { ...datos, deviceSerialNumber: null } } })
    const visto = await consultar(A)
    expect(visto!.attempt.outcome).toBe<AttemptOutcome>('RECORDED')
    expect(visto!.attempt.paymentId).toBe(pago.id)
  })

  it('el gemelo DECLINED: un rechazo del banco SIN serial tampoco es de nadie (protege el 2º max() de conDueno)', async () => {
    const A = randomUUID()
    await webhook(A, { terminalSerial: '', status: 'rejected', description: '05 DECLINADA' })
    const visto = await consultar(A)
    expect(visto).not.toBeNull()
    expect(visto!.attempt.processorEvidence).toBe<AttemptProcessorEvidence>('NONE')
  })
})
