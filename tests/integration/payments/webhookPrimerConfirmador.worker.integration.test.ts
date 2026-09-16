/**
 * S4 del checkpoint 1: WORKER PROPIO para los eventos PENDING de AngelPay (no el vigía de 30 s con `isRunning` en
 * memoria). Lo que Codex exigió: selección y claim ATÓMICOS (`FOR UPDATE SKIP LOCKED`), lease recuperable y token de
 * dueño (las escrituras finales sólo valen con el token vigente), lotes acotados y orden estable, reintentos espaciados
 * (backoff), exclusión frente al receptor inmediato (un evento recién insertado nace con `nextAttemptAt` 60 s en el
 * futuro), fallos agotados VISIBLES y recuperables (`ERROR/RETRIES_EXHAUSTED`, nunca «no cobrado»). Y lo que el lease
 * NO sustituye: la idempotencia financiera la garantiza el registrador (S0).
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { processAngelPayWebhook, reconciliarEventoPendiente } from '@/services/tpv/angelpay-webhook.service'
import {
  ANGELPAY_EVENT_MAX_ATTEMPTS,
  claimPendingAngelPayEvents,
  runClaimedAngelPayEvent,
} from '@/services/tpv/angelpayEventWorker.service'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { recordFastPayment } from '@/services/tpv/payment.tpv.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { crearFixture, exigirBaseDesechable, type Fixture, exigir } from './webhookCheckpoint.fixture'
import { actores } from './actores'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

let f: Fixture
beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('s4')
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(() => f.limpiar())
afterAll(() => f.destruir())

const hace = (ms: number) => new Date(Date.now() - ms)
const fila = (requestId: string) => exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))
const evento = (id: string) => exigir(prisma.providerEventLog.findUnique({ where: { id } }))
const pagos = () => prisma.payment.count({ where: { venueId: f.venueId } })

async function vincular(requestId: string, attemptId = randomUUID()) {
  const ack = await terminalPaymentService.handleAttemptOpenedFromSocket(
    { requestId, attemptId },
    { socketId: 's', terminalId: f.serial, venueId: f.venueId },
  )
  expect(ack.success).toBe(true)
  return attemptId
}

/** Como si el receptor hubiera muerto justo después del insert: PENDING, con el payload estampado, listo para el worker. */
async function eventoHuerfano(attemptId: string | undefined, over: Record<string, unknown> = {}, fila: Record<string, unknown> = {}) {
  return prisma.providerEventLog.create({
    data: {
      provider: 'PAYMENT_PROCESSOR',
      eventId: `angelpay-${f.nuevoEventId()}`,
      type: 'send_transaction',
      payload: {
        ...f.eventoAngelPay(attemptId, over),
        _avoqado: { receivedByMerchantAccountId: f.merchantId },
      } as unknown as Prisma.InputJsonValue,
      venueId: f.venueId,
      status: 'PENDING',
      attemptId: attemptId ?? null,
      nextAttemptAt: hace(1_000),
      ...fila,
    } as Prisma.ProviderEventLogUncheckedCreateInput,
  })
}

async function correrWorker(limit = 25) {
  const claims = await claimPendingAngelPayEvents({ now: new Date(), limit })
  const desenlaces: string[] = []
  for (const claim of claims) desenlaces.push(await runClaimedAngelPayEvent(claim))
  return { claims, desenlaces }
}

describe('S4 · el worker retoma lo que el receptor dejó pendiente', () => {
  it('caída tras guardar el webhook: el worker confirma por el vínculo, crea el dinero y suelta el lease', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = await vincular(solicitud.requestId)
    const ev = await eventoHuerfano(attemptId)

    const { claims, desenlaces } = await correrWorker()

    expect(claims.map(c => c.id)).toEqual([ev.id])
    expect(desenlaces).toEqual(['PROCESSED'])
    expect(await pagos()).toBe(1)
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', closedVia: 'webhook' })
    expect(await evento(ev.id)).toMatchObject({ status: 'PROCESSED', claimToken: null, leaseUntil: null, attempts: 1 })
  })

  it('sin vínculo todavía: queda PENDING con backoff y sin monopolizar; cuando el vínculo llega, confirma', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = randomUUID()
    const ev = await eventoHuerfano(attemptId)

    expect((await correrWorker()).desenlaces).toEqual(['PENDING'])
    const esperando = await evento(ev.id)
    expect(esperando).toMatchObject({ status: 'PENDING', errorReason: 'AWAITING_PAYMENT', attempts: 1, claimToken: null })
    expect(esperando.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 60_000)
    // Mientras está en backoff, otro barrido NO lo vuelve a tomar.
    expect((await correrWorker()).claims).toEqual([])

    await vincular(solicitud.requestId, attemptId)
    await prisma.providerEventLog.update({ where: { id: ev.id }, data: { nextAttemptAt: hace(1) } })
    expect((await correrWorker()).desenlaces).toEqual(['PROCESSED'])
    expect(await pagos()).toBe(1)
  })

  it('dos workers a la vez: cada evento se reclama UNA sola vez (SKIP LOCKED)', async () => {
    const ids = [] as string[]
    for (let i = 0; i < 3; i++) ids.push((await eventoHuerfano(randomUUID())).id)

    // Codex R12-13 (l): los dos reclamos son ACTORES — un rechazo de uno no devuelve antes de que el otro termine: los dos se
    // asientan (`cerrar`) y se examinan por separado.
    const A = actores()
    const wa = A.lanzar('worker A', claimPendingAngelPayEvents({ now: new Date(), limit: 25 }))
    const wb = A.lanzar('worker B', claimPendingAngelPayEvents({ now: new Date(), limit: 25 }))
    await A.cerrar()
    await A.afirmar(async () => {
      const a = await wa.resultado()
      const b = await wb.resultado()
      const reclamados = [...a, ...b].map(c => c.id)
      expect(reclamados.sort()).toEqual(ids.sort())
      expect(new Set(reclamados).size).toBe(3)
      for (const claim of [...a, ...b]) await runClaimedAngelPayEvent(claim)
    })
  })

  it('un lease VENCIDO se retoma con token nuevo; uno vigente se respeta', async () => {
    const vencido = await eventoHuerfano(randomUUID(), {}, { claimToken: 'zombie', leaseUntil: hace(1_000), attempts: 2 })
    const vigente = await eventoHuerfano(randomUUID(), {}, { claimToken: 'vivo', leaseUntil: new Date(Date.now() + 60_000) })

    const { claims } = await correrWorker()

    expect(claims.map(c => c.id)).toEqual([vencido.id])
    expect(claims[0].claimToken).not.toBe('zombie')
    expect((await evento(vigente.id)).claimToken).toBe('vivo')
  })

  it('intentos agotados: ERROR/RETRIES_EXHAUSTED visible y recuperable, sin tocar la solicitud ni inventar «no cobrado»', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const ev = await eventoHuerfano(randomUUID(), {}, { attempts: ANGELPAY_EVENT_MAX_ATTEMPTS })

    const { claims } = await correrWorker()

    expect(claims).toEqual([])
    expect(await evento(ev.id)).toMatchObject({ status: 'ERROR', errorReason: 'RETRIES_EXHAUSTED', claimToken: null })
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'SENT', paymentId: null })
    expect(await pagos()).toBe(0)
    // Recuperable: volver a PENDING con intentos en cero lo reencola.
    await prisma.providerEventLog.update({ where: { id: ev.id }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: hace(1) } })
    expect((await correrWorker()).claims.map(c => c.id)).toEqual([ev.id])
  })

  it('caída DENTRO de la transacción del registrador (tras crear el Payment): se revierte todo, PROCESSING_ERROR con rastro, y al reintentar confirma', async () => {
    const solicitud = await f.solicitud({ orderId: null })
    const attemptId = await vincular(solicitud.requestId)
    const ev = await eventoHuerfano(attemptId)
    // Codex R1 (P2): el corte ocurre DESPUÉS de `payment.create`, dentro de la transacción — lo que se prueba es el rollback
    // financiero real, no un rechazo previo a abrirla.
    const corte = jest.spyOn(terminalPaymentService, 'closeRowFromPaymentTx').mockImplementationOnce(async () => {
      throw new Error('corte simulado dentro de la transacción del registrador')
    })
    try {
      expect((await correrWorker()).desenlaces).toEqual(['PENDING'])
      const fallido = await evento(ev.id)
      expect(fallido).toMatchObject({ status: 'PENDING', errorReason: 'PROCESSING_ERROR' })
      expect(fallido.lastError).toEqual(expect.stringContaining('corte simulado'))
      expect(corte).toHaveBeenCalledTimes(1)
      expect(await pagos()).toBe(0)
      expect(await fila(solicitud.requestId)).toMatchObject({ status: 'SENT', paymentId: null })
    } finally {
      corte.mockRestore()
    }
    await prisma.providerEventLog.update({ where: { id: ev.id }, data: { nextAttemptAt: hace(1) } })
    expect((await correrWorker()).desenlaces).toEqual(['PROCESSED'])
    expect(await pagos()).toBe(1)
  })

  it('caída tras el commit y antes de marcar el evento: el reintento no duplica (registrador idempotente)', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = await vincular(solicitud.requestId)
    const eventId = f.nuevoEventId()
    const confirmado = await processAngelPayWebhook({
      payload: f.eventoAngelPay(attemptId),
      eventId,
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    })
    expect(confirmado.action).toBe('CONFIRMED')
    // El proceso murió entre el commit del Payment y la escritura PROCESSED: el evento se ve PENDING otra vez.
    const ev = await exigir(prisma.providerEventLog.findFirst({ where: { eventId: `angelpay-${eventId}` } }))
    await prisma.providerEventLog.update({ where: { id: ev.id }, data: { status: 'PENDING', paymentId: null, nextAttemptAt: hace(1) } })

    expect((await correrWorker()).desenlaces).toEqual(['PROCESSED'])
    expect(await pagos()).toBe(1)
    expect((await evento(ev.id)).paymentId).toBe(confirmado.paymentId)
  })

  it('reentrega DUPLICATE con el trabajo pendiente: el receptor la rechaza y el worker lo termina igual', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = randomUUID()
    const eventId = f.nuevoEventId()
    const args = {
      payload: f.eventoAngelPay(attemptId),
      eventId,
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    }
    expect((await processAngelPayWebhook(args)).action).toBe('ORPHANED')
    expect((await processAngelPayWebhook(args)).action).toBe('DUPLICATE')
    const ev = await exigir(prisma.providerEventLog.findFirst({ where: { eventId: `angelpay-${eventId}` } }))
    // El receptor deja el evento fuera del alcance del worker durante ~60 s: no se pisan.
    expect(ev.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 30_000)

    await vincular(solicitud.requestId, attemptId)
    await prisma.providerEventLog.update({ where: { id: ev.id }, data: { nextAttemptAt: hace(1) } })
    expect((await correrWorker()).desenlaces).toEqual(['PROCESSED'])
    expect(await pagos()).toBe(1)
  })

  it('un worker con lease VENCIDO no puede escribir sobre el reclamo de otro; y el dinero no se duplica (el lease no sustituye la idempotencia)', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = await vincular(solicitud.requestId)
    // Reclamado por B con lease vigente; A tuvo el lease antes y lo perdió.
    const ev = await eventoHuerfano(attemptId, {}, { claimToken: 'B', leaseUntil: new Date(Date.now() + 60_000), attempts: 2 })
    const payload = (await evento(ev.id)).payload as any

    const tardio = await reconciliarEventoPendiente({
      payload,
      eventLogId: ev.id,
      rawEventId: ev.eventId!.replace(/^angelpay-/, ''),
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      receiverVenueId: f.venueId,
      correlationId: 'stale-A',
      retryDelaysMs: [0],
      claimToken: 'A',
    })

    // A llegó a crear el dinero (es real y el registrador es idempotente), pero NO pudo marcar el evento: sigue de B.
    expect(tardio.action).toBe('CONFIRMED')
    expect(await evento(ev.id)).toMatchObject({ status: 'PENDING', claimToken: 'B' })
    // B termina el trabajo: el registrador devuelve al ganador (misma llave) y el evento cierra sin segundo Payment.
    const desenlace = await runClaimedAngelPayEvent({
      id: ev.id,
      eventId: ev.eventId!,
      payload,
      venueId: f.venueId,
      attempts: 2,
      claimToken: 'B',
      leaseUntil: new Date(Date.now() + 60_000),
    })
    expect(desenlace).toBe('PROCESSED')
    expect(await pagos()).toBe(1)
    expect(await evento(ev.id)).toMatchObject({ status: 'PROCESSED', paymentId: tardio.paymentId, claimToken: null })
  })

  it('orden estable (lo más antiguo primero) y lote acotado', async () => {
    const viejo = await eventoHuerfano(randomUUID(), {}, { nextAttemptAt: hace(30_000) })
    const medio = await eventoHuerfano(randomUUID(), {}, { nextAttemptAt: hace(20_000) })
    const nuevo = await eventoHuerfano(randomUUID(), {}, { nextAttemptAt: hace(10_000) })

    const { claims } = await correrWorker(2)

    expect(claims.map(c => c.id)).toEqual([viejo.id, medio.id])
    expect((await evento(nuevo.id)).claimToken).toBeNull()
  })

  it('los eventos legacy (sin nextAttemptAt, anteriores al worker) no se tocan: siguen siendo del backfill', async () => {
    const legacy = await eventoHuerfano(randomUUID(), {}, { nextAttemptAt: null })
    expect((await correrWorker()).claims).toEqual([])
    expect((await evento(legacy.id)).status).toBe('PENDING')
  })
})

describe('Codex R12 (pasada exhaustiva) · R12-11: la llegada del vínculo S1 REARMA la evidencia approved del intento — el worker recupera el cargo sin que nadie adelante `nextAttemptAt` por SQL', () => {
  const rearmado = (ev: { payload: unknown }) =>
    ((ev.payload as { _avoqado?: { rearmadoPorVinculo?: unknown } })._avoqado ?? {}).rearmadoPorVinculo
  const enElFuturo = () => new Date(Date.now() + 30 * 60_000)

  it('PENDING con `nextAttemptAt` en el futuro (backoff): S1 lo adelanta y el worker lo recupera en el siguiente barrido', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = randomUUID()
    const ev = await eventoHuerfano(attemptId, {}, { nextAttemptAt: enElFuturo(), attempts: 3, errorReason: 'AWAITING_PAYMENT' })
    expect((await correrWorker()).claims).toEqual([])

    await vincular(solicitud.requestId, attemptId)

    expect((await evento(ev.id)).nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now())
    expect((await correrWorker()).desenlaces).toEqual(['PROCESSED'])
    expect(await pagos()).toBe(1)
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', closedVia: 'webhook' })
  })

  it('AGOTADO sin Payment (ERROR/RETRIES_EXHAUSTED, attempts=40): S1 lo recupera con el presupuesto en cero y el worker confirma', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = randomUUID()
    const ev = await eventoHuerfano(
      attemptId,
      {},
      {
        status: 'ERROR',
        errorReason: 'RETRIES_EXHAUSTED',
        attempts: ANGELPAY_EVENT_MAX_ATTEMPTS,
        processedAt: hace(60_000),
        nextAttemptAt: hace(60_000),
      },
    )

    await vincular(solicitud.requestId, attemptId)

    const rearmadoEv = await evento(ev.id)
    expect(rearmadoEv).toMatchObject({ status: 'PENDING', attempts: 0, paymentId: null, claimToken: null })
    expect(rearmado(rearmadoEv)).toMatchObject({ requestId: solicitud.requestId, attemptsAntes: ANGELPAY_EVENT_MAX_ATTEMPTS })
    expect((await correrWorker()).desenlaces).toEqual(['PROCESSED'])
    expect(await pagos()).toBe(1)
    expect(await evento(ev.id)).toMatchObject({ status: 'PROCESSED', attempts: 1 })
  })

  it('sellado DÉBIL sobre otro Payment con attempts=40: S1 lo reabre CON el presupuesto en cero — antes volvía a PENDING y el worker lo devolvía a ERROR en el acto', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = randomUUID()
    // El Payment equivocado: otra venta del mismo negocio que el matcher débil eligió y selló con la huella de ESTE evento.
    const pagoAjeno = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID() }), f.staffId)
    expect(pagoAjeno.status).toBe('COMPLETED')
    const ev = await eventoHuerfano(
      attemptId,
      {},
      { status: 'PROCESSED', paymentId: pagoAjeno.id, attempts: ANGELPAY_EVENT_MAX_ATTEMPTS, processedAt: hace(60_000) },
    )
    await prisma.payment.update({
      where: { id: pagoAjeno.id },
      data: {
        processorData: { angelpayWebhook: { eventId: String(ev.eventId).replace(/^angelpay-/, ''), integratorReference: attemptId } },
      },
    })

    await vincular(solicitud.requestId, attemptId)

    expect(await evento(ev.id)).toMatchObject({
      status: 'PENDING',
      errorReason: 'LINK_ARRIVED_AFTER_WEAK_MATCH',
      attempts: 0,
      paymentId: null,
    })
    expect(
      ((await exigir(prisma.payment.findUnique({ where: { id: pagoAjeno.id } }))).processorData as Record<string, unknown>)
        .angelpayWebhookRevoked,
    ).toBeDefined()
    expect((await correrWorker()).desenlaces).toEqual(['PROCESSED'])
    expect(await pagos()).toBe(2)
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', closedVia: 'webhook' })
    expect((await evento(ev.id)).paymentId).not.toBe(pagoAjeno.id)
  })

  it('el rearme es UNA sola vez por evento: repetir el vínculo (ALREADY_LINKED) no reinicia el presupuesto otra vez', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = randomUUID()
    const ev = await eventoHuerfano(
      attemptId,
      {},
      { status: 'ERROR', errorReason: 'RETRIES_EXHAUSTED', attempts: ANGELPAY_EVENT_MAX_ATTEMPTS, processedAt: hace(60_000) },
    )
    await vincular(solicitud.requestId, attemptId)
    expect(await evento(ev.id)).toMatchObject({ status: 'PENDING', attempts: 0 })
    // Se agota OTRA vez (el vínculo no resolvió nada): un segundo ALREADY_LINKED no vuelve a regalar 40 intentos.
    await prisma.providerEventLog.update({
      where: { id: ev.id },
      data: { status: 'ERROR', errorReason: 'RETRIES_EXHAUSTED', attempts: ANGELPAY_EVENT_MAX_ATTEMPTS, processedAt: new Date() },
    })
    for (let i = 0; i < 3; i++) await vincular(solicitud.requestId, attemptId)
    expect(await evento(ev.id)).toMatchObject({ status: 'ERROR', errorReason: 'RETRIES_EXHAUSTED', attempts: ANGELPAY_EVENT_MAX_ATTEMPTS })
    expect((await correrWorker()).claims).toEqual([])
  })

  it('no reactiva rechazos bancarios ni contradicciones firmes: NOT_APPROVED y LINK_TERMINAL_MISMATCH quedan como estaban — y un `declined` en backoff o AGOTADO tampoco se adelanta ni se rearma', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = randomUUID()
    const rechazo = await eventoHuerfano(
      attemptId,
      { status: 'declined' },
      { status: 'ERROR', errorReason: 'NOT_APPROVED', attempts: 1, processedAt: hace(1_000) },
    )
    const contradiccion = await eventoHuerfano(
      attemptId,
      { terminalSerial: 'OTRA-TERMINAL' },
      { status: 'ERROR', errorReason: 'LINK_TERMINAL_MISMATCH', attempts: 1, processedAt: hace(1_000) },
    )
    // Un rechazo bancario que todavía no se procesó (backoff) o que agotó sus intentos: las ramas (a) y (b) sólo aplican a
    // evidencia `approved` — un declined nunca se adelanta ni se rearma por la llegada del vínculo.
    const enBackoff = enElFuturo()
    const rechazoEnBackoff = await eventoHuerfano(
      attemptId,
      { status: 'declined' },
      { status: 'PENDING', errorReason: 'AWAITING_PAYMENT', attempts: 3, nextAttemptAt: enBackoff },
    )
    const rechazoAgotado = await eventoHuerfano(
      attemptId,
      { status: 'declined' },
      {
        status: 'ERROR',
        errorReason: 'RETRIES_EXHAUSTED',
        attempts: ANGELPAY_EVENT_MAX_ATTEMPTS,
        processedAt: hace(60_000),
        nextAttemptAt: hace(60_000),
      },
    )

    await vincular(solicitud.requestId, attemptId)

    expect(await evento(rechazo.id)).toMatchObject({ status: 'ERROR', errorReason: 'NOT_APPROVED', attempts: 1 })
    expect(await evento(contradiccion.id)).toMatchObject({ status: 'ERROR', errorReason: 'LINK_TERMINAL_MISMATCH', attempts: 1 })
    const backoffIntacto = await evento(rechazoEnBackoff.id)
    expect(backoffIntacto).toMatchObject({ status: 'PENDING', attempts: 3 })
    expect(backoffIntacto.nextAttemptAt!.getTime()).toBe(enBackoff.getTime())
    const agotadoIntacto = await evento(rechazoAgotado.id)
    expect(agotadoIntacto).toMatchObject({ status: 'ERROR', errorReason: 'RETRIES_EXHAUSTED', attempts: ANGELPAY_EVENT_MAX_ATTEMPTS })
    expect(rearmado(agotadoIntacto)).toBeUndefined()
    expect((await correrWorker()).claims).toEqual([])
    expect(await pagos()).toBe(0)
  })
})
