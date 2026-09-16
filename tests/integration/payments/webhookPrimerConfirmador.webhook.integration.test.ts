/**
 * S2 + S7 del checkpoint 1: el webhook `approved` de AngelPay como PRIMER confirmador — por el MISMO registrador.
 *
 *  · Sólo con correlación EXACTA: vínculo S1 (`attemptId → requestId`), venue del merchant del secreto = venue del
 *    vínculo, `status === 'approved'` explícito y `webhook.amount == base + propina` de la solicitud. Sin vínculo, el
 *    evento se queda PENDING/AWAITING_PAYMENT como hoy (S-LEGACY) y lo retoma el worker (S4) o el REST.
 *  · Entra por `recordOrderPayment` / `recordFastPayment` con `registradoVia: 'webhook'`: mismo arbitraje que el REST
 *    (ganador · reintento · segunda captura), la fila cierra con `closedVia: 'webhook'`.
 *  · El Payment nacido del webhook lleva método PROVISIONAL y costo PENDIENTE durable (`PaymentEffect TRANSACTION_COST`);
 *    el REST posterior con la misma llave enriquece (S3) y destraba el costo.
 *  · S7: `declined` es evidencia (`ERROR/NOT_APPROVED` con `attemptId`), nunca libera ni toca la fila.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { processAngelPayWebhook, reconcileAngelPayWebhookForPayment } from '@/services/tpv/angelpay-webhook.service'
import { recordFastPayment, recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import * as registrador from '@/services/tpv/payment.tpv.service'
import { claimPendingAngelPayEvents, runClaimedAngelPayEvent } from '@/services/tpv/angelpayEventWorker.service'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { crearFixture, exigirBaseDesechable, type Fixture, exigir } from './webhookCheckpoint.fixture'
import { actores, type Fallo } from './actores'
import { NS_CANDADO_INTENTO } from '@/services/tpv/candadoDeIntento'

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
  f = await crearFixture('s2')
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(() => f.limpiar())
afterAll(() => f.destruir())

const fila = (requestId: string) => exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))
/** Espera acotada para lo que corre fuera de la petición (el backfill del REST es fire-and-forget). */
async function esperar(condicion: () => Promise<boolean>, ms = 4000): Promise<boolean> {
  const hasta = Date.now() + ms
  while (Date.now() < hasta) {
    if (await condicion()) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return condicion()
}
/**
 * Codex R12-13 (l): una ACCIÓN que crea un Payment por el registrador —el registro REST de la terminal, o un webhook que crea el
 * Payment— lanza un backfill fire-and-forget que hay que DRENAR antes de seguir. El backfill se registra como MONTAJE (de un
 * conjunto propio) en el mismo instante en que el registrador lo lanza, se espera hasta que termine y el espía se restaura
 * SIEMPRE — también si la acción o la espera caen: un backfill lanzado antes de un fallo ya no queda huérfano ni deja el espía
 * puesto para la siguiente prueba. Si el backfill rechaza o no termina, la prueba es INCONCLUSA con su causa.
 * Certificación R16: también el webhook que CREA el Payment lanza ese backfill (vuelve a sellar su propio evento por el parche
 * atómico); una lectura inmediata del Payment corría contra él y N1 detectaba el mutante R13-C4 sólo cuando el backfill ganaba
 * la carrera — drenado, la lectura es determinista en las dos direcciones.
 */
async function conBackfillDrenado<T>(accion: () => Promise<T>): Promise<T> {
  const webhookService = await import('@/services/tpv/angelpay-webhook.service')
  const real = webhookService.reconcileAngelPayWebhookForPayment
  const B = actores()
  let backfill: ReturnType<typeof B.montaje<void>> | null = null
  const espia = jest.spyOn(webhookService, 'reconcileAngelPayWebhookForPayment').mockImplementationOnce(pago => {
    const promesa = real(pago)
    backfill = B.montaje('backfill del registrador', promesa)
    return promesa
  })
  // Codex R14-5: el cierre común se alcanza SIEMPRE — también cuando la acción o la primera espera caen. Antes `B.cerrar()`
  // vivía sólo en el camino normal: un fallo posterior a lanzar el backfill lo dejaba huérfano (y su rechazo, escondido detrás
  // del fallo original). Ahora el fallo se captura, `cerrar(fallo)` drena el montaje conservando AMBAS causas (INCONCLUSO si
  // el backfill rechazó o no se asentó; el fallo original tal cual si el backfill terminó bien) y el espía se restaura después.
  let resultado: T | undefined
  let fallo: Fallo = null
  try {
    resultado = await accion()
    if (!(await esperar(async () => backfill !== null, 5000))) throw new Error('INCONCLUSO — el backfill del registrador nunca se lanzó')
  } catch (error) {
    fallo = { error }
  } finally {
    try {
      await B.cerrar(fallo)
    } finally {
      espia.mockRestore()
    }
  }
  await backfill!.resultado()
  return resultado!
}
/** El registro REST de la terminal con su backfill drenado (el consumidor original de `conBackfillDrenado`). */
const registroConBackfillDrenado = (registro: ReturnType<typeof f.registroDeLaTerminal>) =>
  conBackfillDrenado(() => recordFastPayment(f.venueId, registro, f.staffId))

/** Codex R3: el backfill del REST es fire-and-forget; se ejecuta AQUÍ, acreditado y hasta terminar, antes de medir. */
const backfillAcreditado = async (paymentId: string) =>
  reconcileAngelPayWebhookForPayment(await exigir(prisma.payment.findUnique({ where: { id: paymentId } })))

const evento = (eventId: string) =>
  exigir(prisma.providerEventLog.findFirst({ where: { provider: 'PAYMENT_PROCESSOR', eventId: `angelpay-${eventId}` } }))
const pagos = () => prisma.payment.findMany({ where: { venueId: f.venueId } })
const bitacora = (action: string) => (logAction as jest.Mock).mock.calls.filter(([p]) => p?.action === action).map(([p]) => p)

/** La terminal anuncia el intento (S1) por su socket autenticado. */
async function vincular(requestId: string, attemptId = randomUUID()) {
  const ack = await terminalPaymentService.handleAttemptOpenedFromSocket(
    { requestId, attemptId },
    { socketId: 's', terminalId: f.serial, venueId: f.venueId },
  )
  expect(ack.success).toBe(true)
  return attemptId
}

async function webhook(
  attemptId: string | undefined,
  over: Record<string, unknown> = {},
  merchant?: { id: string; externalMerchantId: string },
) {
  const eventId = f.nuevoEventId()
  const result = await processAngelPayWebhook({
    payload: f.eventoAngelPay(attemptId, over),
    eventId,
    merchantAccount: merchant ?? { id: f.merchantId, externalMerchantId: f.merchantExternalId },
    retryDelaysMs: [0],
  })
  return { result, eventId }
}

describe('S2 · el webhook approved crea el dinero por el registrador, sólo con correlación exacta', () => {
  it('con vínculo, importe exacto y orden: crea el Payment, cierra la solicitud como webhook y deja el costo pendiente', async () => {
    const turno = await prisma.shift.create({
      data: { venueId: f.venueId, staffId: f.staffId, startTime: new Date(), status: 'OPEN', startingCash: 0 },
    })
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id, processedByStaffId: f.staffId })
    const attemptId = await vincular(solicitud.requestId)

    const { result, eventId } = await webhook(attemptId)

    expect(result).toMatchObject({ action: 'CONFIRMED' })
    const [pago] = await pagos()
    expect(pago).toMatchObject({
      status: 'COMPLETED',
      idempotencyKey: attemptId,
      merchantAccountId: f.merchantId,
      terminalPaymentRequestId: solicitud.requestId,
      orderId: venta.id,
      source: 'TPV',
      method: 'CREDIT_CARD',
      processedById: f.staffId,
    })
    expect(Number(pago.amount)).toBe(100)
    const meta = pago.processorData as Record<string, any>
    expect(meta).toMatchObject({
      registradoVia: 'webhook',
      methodProvisional: true,
      costPending: true,
      terminalPaymentRequestId: solicitud.requestId,
    })
    expect(meta.angelpayWebhook?.integratorReference).toBe(attemptId)
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id, closedVia: 'webhook' })
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pago.id, attemptId })
    expect((await exigir(prisma.order.findUnique({ where: { id: venta.id } }))).paymentStatus).toBe('PAID')
    expect(Number((await exigir(prisma.shift.findUnique({ where: { id: turno.id } }))).totalSales)).toBe(100)
    // Costo PENDIENTE durable (Codex P2): nada de costo normal hasta acreditar la marca o vencer el plazo.
    expect(await prisma.transactionCost.count({ where: { paymentId: pago.id } })).toBe(0)
    expect(await prisma.paymentEffect.findMany({ where: { paymentId: pago.id, kind: 'TRANSACTION_COST' } })).toEqual([
      expect.objectContaining({ status: 'PENDING', payload: expect.objectContaining({ reason: 'AWAITING_ACCREDITED_CARD_DATA' }) }),
    ])
  })

  it('sin orden (venta rápida): nace la venta materializada y su Payment', async () => {
    const solicitud = await f.solicitud({ orderId: null })
    const attemptId = await vincular(solicitud.requestId)

    const { result } = await webhook(attemptId)

    expect(result.action).toBe('CONFIRMED')
    const [pago] = await pagos()
    expect(pago.orderId).toEqual(expect.any(String))
    expect(await prisma.order.count({ where: { venueId: f.venueId } })).toBe(1)
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id, closedVia: 'webhook' })
  })

  it('la propina viaja en el total: webhook == base + propina crea con el desglose de la solicitud', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id, tipCents: 500 })
    const attemptId = await vincular(solicitud.requestId)

    const { result } = await webhook(attemptId, { amount: '000000010500' })

    expect(result.action).toBe('CONFIRMED')
    const [pago] = await pagos()
    expect(Number(pago.amount)).toBe(100)
    expect(Number(pago.tipAmount)).toBe(5)
  })

  it('un importe distinto de base + propina NO crea dinero ni inventa propina: PENDING/AMOUNT_MISMATCH, la solicitud sigue en vuelo', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id, tipCents: 500 })
    const attemptId = await vincular(solicitud.requestId)

    const { result, eventId } = await webhook(attemptId, { amount: '000000010000' })

    expect(result).toMatchObject({ action: 'ORPHANED', errorReason: 'AMOUNT_MISMATCH' })
    expect(await pagos()).toHaveLength(0)
    expect(await evento(eventId)).toMatchObject({ status: 'PENDING', errorReason: 'AMOUNT_MISMATCH', paymentId: null })
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'SENT', paymentId: null })
  })

  it('sin `status` explícito no se crea dinero aunque haya vínculo (la tolerancia es sólo para conciliar)', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = await vincular(solicitud.requestId)

    const { result, eventId } = await webhook(attemptId, { status: undefined })

    expect(result).toMatchObject({ action: 'ORPHANED', errorReason: 'AWAITING_PAYMENT' })
    expect(await pagos()).toHaveLength(0)
    expect((await evento(eventId)).status).toBe('PENDING')
  })

  it('sin vínculo sigue como hoy: PENDING/AWAITING_PAYMENT y cero dinero', async () => {
    const venta = await f.nuevaVenta()
    await f.solicitud({ orderId: venta.id })
    const { result } = await webhook(randomUUID())
    expect(result).toMatchObject({ action: 'ORPHANED', errorReason: 'AWAITING_PAYMENT' })
    expect(await pagos()).toHaveLength(0)
  })

  it('el vínculo de OTRO venue no crea dinero: ERROR/LINK_VENUE_MISMATCH', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = await vincular(solicitud.requestId)
    // Un merchant cuyo login pertenece a otro venue (el webhook llegó por el endpoint de OTRA afiliación).
    const otroOrg = `${f.fixture}-otro`
    await prisma.organization.create({ data: { id: otroOrg, name: otroOrg, email: `${otroOrg}@example.test`, phone: '5500000002' } })
    await prisma.venue.create({ data: { id: otroOrg, organizationId: otroOrg, name: otroOrg, slug: otroOrg } })
    const provider = await exigir(prisma.paymentProvider.findUnique({ where: { code: 'ANGELPAY' } }))
    const login = await prisma.angelPayUserAccount.create({
      data: { venueId: otroOrg, email: `${otroOrg}@angelpay.test`, environment: 'QA', status: 'ACTIVE' },
    })
    const merchant = await prisma.merchantAccount.create({
      data: { providerId: provider.id, externalMerchantId: `${otroOrg}-m`, credentialsEncrypted: {}, angelpayUserAccountId: login.id },
    })
    try {
      const { result, eventId } = await webhook(attemptId, {}, { id: merchant.id, externalMerchantId: merchant.externalMerchantId })

      expect(result).toMatchObject({ action: 'ERROR', errorReason: 'LINK_VENUE_MISMATCH' })
      expect(await pagos()).toHaveLength(0)
      expect((await evento(eventId)).status).toBe('ERROR')
      expect(await fila(solicitud.requestId)).toMatchObject({ status: 'SENT', paymentId: null })
    } finally {
      await prisma.providerEventLog.deleteMany({ where: { venueId: otroOrg } })
      await prisma.merchantAccount.deleteMany({ where: { id: merchant.id } })
      await prisma.angelPayUserAccount.deleteMany({ where: { id: login.id } })
      await prisma.venue.deleteMany({ where: { id: otroOrg } })
      await prisma.organization.deleteMany({ where: { id: otroOrg } })
    }
  })

  it('A ganó por REST; el approved de B (vinculado a la misma solicitud) es segunda captura, no otro cobro', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const A = await vincular(solicitud.requestId)
    const B = await vincular(solicitud.requestId)
    const ganador = await recordOrderPayment(
      f.venueId,
      venta.id,
      f.registroDeLaTerminal({ attemptId: A, requestId: solicitud.requestId }),
      f.staffId,
    )

    const { result, eventId } = await webhook(B)

    expect(result).toMatchObject({ action: 'SECOND_CAPTURE' })
    const evidencia = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: B } }))
    expect(evidencia.status).toBe('PENDING')
    expect((evidencia.processorData as any).reconciliation).toMatchObject({
      kind: 'POSSIBLE_SECOND_CAPTURE',
      winnerPaymentId: ganador.id,
      via: 'webhook',
    })
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: evidencia.id, errorReason: 'POSSIBLE_SECOND_CAPTURE' })
    expect((await fila(solicitud.requestId)).paymentId).toBe(ganador.id)
  })

  it('la reentrega del MISMO evento después de crear es DUPLICATE: un solo Payment', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = await vincular(solicitud.requestId)
    const eventId = f.nuevoEventId()
    const args = {
      payload: f.eventoAngelPay(attemptId),
      eventId,
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    }

    expect((await processAngelPayWebhook(args)).action).toBe('CONFIRMED')
    expect((await processAngelPayWebhook(args)).action).toBe('DUPLICATE')
    expect(await pagos()).toHaveLength(1)
  })
})

describe('S3 · el REST posterior enriquece lo que el webhook no sabía', () => {
  it('misma llave: un solo Payment; llegan marca y método real; el método provisional se cierra y el costo pendiente se destraba', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = await vincular(solicitud.requestId)
    // La terminal guarda como referencia el `transactionId` de AngelPay (verificado en prod): el REST trae la MISMA.
    const payload = f.eventoAngelPay(attemptId)
    const result = await processAngelPayWebhook({
      payload,
      eventId: f.nuevoEventId(),
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    })
    expect(result.action).toBe('CONFIRMED')
    const efectoAntes = await exigir(prisma.paymentEffect.findFirst({ where: { paymentId: result.paymentId!, kind: 'TRANSACTION_COST' } }))
    await prisma.paymentEffect.update({ where: { id: efectoAntes.id }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } })

    const rest = await recordOrderPayment(
      f.venueId,
      venta.id,
      {
        ...f.registroDeLaTerminal({
          attemptId,
          requestId: solicitud.requestId,
          ref: String(payload.payload.transactionId),
          tarjeta: { cardBrand: 'VISA', maskedPan: '411111******1111', entryMode: 'CHIP' },
        }),
        method: 'DEBIT_CARD',
      },
      f.staffId,
    )
    expect(bitacora('TERMINAL_PAYMENT_ENRICHMENT_CONTRADICTION')).toEqual([])

    expect(rest.id).toBe(result.paymentId)
    expect(await pagos()).toHaveLength(1)
    const pago = await exigir(prisma.payment.findUnique({ where: { id: rest.id } }))
    expect(pago).toMatchObject({
      status: 'COMPLETED',
      cardBrand: 'VISA',
      maskedPan: '411111******1111',
      entryMode: 'CHIP',
      method: 'DEBIT_CARD',
    })
    expect((pago.processorData as any).methodProvisional).toBe(false)
    const efecto = await exigir(prisma.paymentEffect.findUnique({ where: { id: efectoAntes.id } }))
    expect(efecto.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now())
  })
})

describe('S7 · declined es evidencia, nunca una liberación', () => {
  it('declined con vínculo: ERROR/NOT_APPROVED con attemptId; la solicitud sigue en vuelo y sin ganador', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = await vincular(solicitud.requestId)

    const { result, eventId } = await webhook(attemptId, { status: 'declined', description: 'DECLINADA' })

    expect(result).toMatchObject({ action: 'NOT_APPROVED' })
    expect(await evento(eventId)).toMatchObject({ status: 'ERROR', errorReason: 'NOT_APPROVED', attemptId, paymentId: null })
    expect(await pagos()).toHaveLength(0)
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'SENT', paymentId: null })
    // Y una aprobación POSTERIOR del mismo intento sí crea: el rechazo no lo volvió inelegible ni lo liberó.
    expect((await webhook(attemptId)).result.action).toBe('CONFIRMED')
  })

  it('Codex R13-4 · RECEPTOR: un estado bancario PRESENTE pero ilegible (`status: 123`) con vínculo e importe exacto NO crea dinero ni cierra la fila — el evento queda PENDING con motivo INVALID_STATUS (evidencia conservada), sin captura de tarifa al ingreso', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = await vincular(solicitud.requestId)

    const { result, eventId } = await webhook(attemptId, { status: 123 })

    expect(result).toMatchObject({ action: 'INVALID_STATUS', errorReason: 'INVALID_STATUS' })
    const ev = await evento(eventId)
    expect(ev).toMatchObject({ status: 'PENDING', errorReason: 'INVALID_STATUS', attemptId, paymentId: null })
    expect(((ev.payload as Record<string, unknown>)._avoqado as Record<string, unknown>).tarifaCongeladaAlIngreso).toBeUndefined()
    expect(await pagos()).toHaveLength(0)
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'SENT', paymentId: null })
    // Una aprobación LEGIBLE posterior del mismo intento sí crea: el evento ilegible no lo volvió inelegible.
    expect((await webhook(attemptId)).result.action).toBe('CONFIRMED')
  })

  it('Codex R14-3 · RECEPTOR: `{"status": null}` CONTIENE el campo y no demuestra aprobación — NO es la excepción de ausencia: INVALID_STATUS, PENDING, sin dinero, sin captura al ingreso', async () => {
    const venta = await f.nuevaVenta()
    const solicitud = await f.solicitud({ orderId: venta.id })
    const attemptId = await vincular(solicitud.requestId)

    const { result, eventId } = await webhook(attemptId, { status: null })

    expect(result).toMatchObject({ action: 'INVALID_STATUS', errorReason: 'INVALID_STATUS' })
    const ev = await evento(eventId)
    expect(ev).toMatchObject({ status: 'PENDING', errorReason: 'INVALID_STATUS', attemptId, paymentId: null })
    expect((ev.payload as { payload: Record<string, unknown> }).payload).toHaveProperty('status', null)
    expect(((ev.payload as Record<string, unknown>)._avoqado as Record<string, unknown>).tarifaCongeladaAlIngreso).toBeUndefined()
    expect(await pagos()).toHaveLength(0)
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'SENT', paymentId: null })
    expect((await webhook(attemptId)).result.action).toBe('CONFIRMED')
  })

  it.each([
    ['«  Approved  » (mayúsculas y espacios ASCII)', '  Approved  '],
    ['«\\tapproved\\u00a0» (tabulador y NBSP, los que quita trim())', '\tapproved\u00a0'],
  ])(
    'Codex R14-3 · RECEPTOR: una aprobación NORMALIZADA — %s — recibe el MISMO trato que «approved»: se captura la tarifa AL INGRESO y el Payment nace del webhook con esa captura (con vínculo, sin REST)',
    async (_n, status) => {
      const venta = await f.nuevaVenta()
      const solicitud = await f.solicitud({ orderId: venta.id })
      const attemptId = await vincular(solicitud.requestId)

      const { result, eventId } = await webhook(attemptId, { status })

      expect(result.action).toBe('CONFIRMED')
      const ev = await evento(eventId)
      const captura = ((ev.payload as Record<string, unknown>)._avoqado as Record<string, unknown>).tarifaCongeladaAlIngreso as {
        pricing: { venue: unknown; frozenAt: unknown } | null
      }
      expect(captura?.pricing).toBeTruthy()
      const [pago] = await pagos()
      expect(pago).toMatchObject({ status: 'COMPLETED', idempotencyKey: attemptId })
      expect(ev).toMatchObject({ status: 'PROCESSED', paymentId: pago.id })
      // El snapshot del Payment ES la captura del ingreso (mismo instante de congelación), nunca una lectura posterior. Por
      // ASERCIÓN también cuando el snapshot falta (un `pricing` perdido cae como aserción, no como TypeError).
      expect(pago.processorData).toMatchObject({ pricing: { frozenAt: captura.pricing!.frozenAt } })
    },
  )
})

describe('S8 · bitácora TERMINAL_PAYMENT_CONFIRMED_BY_WEBHOOK con EXACTAMENTE la condición de alarma (reopened || CANCEL_REQUESTED)', () => {
  it('dinero por webhook sobre una solicitud ya CANCELADA: se registra, la fila reabre como tardía y queda en la bitácora con el estado previo', async () => {
    const solicitud = await f.solicitud({ status: 'CANCELLED', cancelDisposition: 'ACCEPTED' })
    const A = await vincular(solicitud.requestId)

    expect((await webhook(A)).result.action).toBe('CONFIRMED')

    const despues = await fila(solicitud.requestId)
    expect(despues).toMatchObject({ status: 'COMPLETED', closedVia: 'webhook', lateResult: true })
    expect(despues.paymentId).not.toBeNull()
    const asientos = bitacora('TERMINAL_PAYMENT_CONFIRMED_BY_WEBHOOK')
    expect(asientos).toHaveLength(1)
    expect(asientos[0]).toMatchObject({
      entity: 'TerminalPaymentRequest',
      venueId: f.venueId,
      data: { requestId: solicitud.requestId, paymentId: despues.paymentId, attemptId: A, previousStatus: 'CANCELLED', reopened: true },
    })
  })

  it('el cancel que perdió la carrera (CANCEL_REQUESTED): también queda en la bitácora, con ese estado previo', async () => {
    const solicitud = await f.solicitud({ status: 'CANCEL_REQUESTED' })
    const A = await vincular(solicitud.requestId)

    expect((await webhook(A)).result.action).toBe('CONFIRMED')

    const asientos = bitacora('TERMINAL_PAYMENT_CONFIRMED_BY_WEBHOOK')
    expect(asientos).toHaveLength(1)
    expect(asientos[0].data).toMatchObject({ requestId: solicitud.requestId, previousStatus: 'CANCEL_REQUESTED' })
  })

  it('la confirmación NORMAL (solicitud en vuelo) NO escribe bitácora: es tráfico de cada cobro, no una anomalía', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    expect((await webhook(A)).result.action).toBe('CONFIRMED')
    expect((await fila(solicitud.requestId)).status).toBe('COMPLETED')
    expect(bitacora('TERMINAL_PAYMENT_CONFIRMED_BY_WEBHOOK')).toHaveLength(0)
  })

  it('el cierre tardío por REST no usa la acción del webhook (conserva su 🚨 de siempre)', async () => {
    const solicitud = await f.solicitud({ status: 'CANCELLED', cancelDisposition: 'ACCEPTED' })
    const A = await vincular(solicitud.requestId)
    await recordOrderPayment(
      f.venueId,
      (await f.nuevaVenta()).id,
      f.registroDeLaTerminal({ attemptId: A, requestId: solicitud.requestId }),
      f.staffId,
    )
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', closedVia: 'terminal' })
    expect(bitacora('TERMINAL_PAYMENT_CONFIRMED_BY_WEBHOOK')).toHaveLength(0)
  })
})

describe('Codex R1 · P1-1: la identidad EXACTA (llave) manda sobre la referencia débil', () => {
  it('con orden: A y B con la MISMA referencia e importe — B registrada por REST; el approved de A (vínculo) crea el Payment de A y deja a B intacta', async () => {
    const R = `${Date.now()}`
    const ventaB = await f.nuevaVenta()
    const solicitudB = await f.solicitud({ orderId: ventaB.id, amountCents: 10000 })
    const B = await vincular(solicitudB.requestId)
    const pagoB = await recordOrderPayment(
      f.venueId,
      ventaB.id,
      f.registroDeLaTerminal({ attemptId: B, requestId: solicitudB.requestId, ref: R }),
      f.staffId,
    )
    expect((await fila(solicitudB.requestId)).status).toBe('COMPLETED')

    const ventaA = await f.nuevaVenta()
    const solicitudA = await f.solicitud({ orderId: ventaA.id, amountCents: 10000 })
    const A = await vincular(solicitudA.requestId)
    const { result, eventId } = await webhook(A, { transactionId: R })

    expect(result.action).toBe('CONFIRMED')
    const despuesA = await fila(solicitudA.requestId)
    expect(despuesA).toMatchObject({ status: 'COMPLETED', closedVia: 'webhook' })
    expect(despuesA.paymentId).not.toBeNull()
    expect(despuesA.paymentId).not.toBe(pagoB.id)
    const pagoA = await exigir(prisma.payment.findUnique({ where: { id: despuesA.paymentId! } }))
    expect(pagoA.idempotencyKey).toBe(A)
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pagoA.id })
    const pagoBDespues = await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))
    expect((pagoBDespues.processorData as Record<string, any>)?.angelpayWebhook?.integratorReference ?? null).not.toBe(A)
    expect(await pagos()).toHaveLength(2)
  })

  it('sin orden: misma referencia e importe, B por REST y el approved de A crea el Payment de A', async () => {
    const R = `${Date.now()}`
    const solicitudB = await f.solicitud({ amountCents: 10000 })
    const B = await vincular(solicitudB.requestId)
    const pagoB = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: B, requestId: solicitudB.requestId, ref: R }),
      f.staffId,
    )
    expect((await fila(solicitudB.requestId)).status).toBe('COMPLETED')

    const solicitudA = await f.solicitud({ amountCents: 10000 })
    const A = await vincular(solicitudA.requestId)
    const { result, eventId } = await webhook(A, { transactionId: R })

    expect(result.action).toBe('CONFIRMED')
    const despuesA = await fila(solicitudA.requestId)
    expect(despuesA.paymentId).not.toBeNull()
    expect(despuesA.paymentId).not.toBe(pagoB.id)
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: despuesA.paymentId })
    expect(await pagos()).toHaveLength(2)
  })

  it('un Payment LEGACY sin llave (APK viejo) con la misma referencia: el approved de A con vínculo crea el Payment de A por el VÍNCULO y no se cuelga del legacy', async () => {
    // El matcher débil acepta un Payment SIN llave (es la única forma de casar un webhook legacy). Con vínculo S1 la
    // identidad exacta manda ANTES: si el débil corriera primero, el approved de A «casaría» con el cobro viejo del
    // mismo segundo y el intento A quedaría sin dinero.
    const R = `${Date.now()}`
    const legacy = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }),
      f.staffId,
    )
    expect(legacy.idempotencyKey).toBeNull()

    const solicitudA = await f.solicitud({ amountCents: 10000 })
    const A = await vincular(solicitudA.requestId)
    const { result, eventId } = await webhook(A, { transactionId: R })

    expect(result.action).toBe('CONFIRMED')
    const despuesA = await fila(solicitudA.requestId)
    expect(despuesA).toMatchObject({ status: 'COMPLETED', closedVia: 'webhook' })
    expect(despuesA.paymentId).not.toBeNull()
    expect(despuesA.paymentId).not.toBe(legacy.id)
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: despuesA.paymentId })
    const legacyDespues = await exigir(prisma.payment.findUnique({ where: { id: legacy.id } }))
    expect((legacyDespues.processorData as Record<string, unknown> | null)?.angelpayWebhook ?? null).toBeNull()
    expect(await pagos()).toHaveLength(2)
  })

  it('backfill y registrador: un evento PENDING de A (misma referencia) NO se cierra con el REST de B (llave distinta), y el REST de A NO se deduplica contra B', async () => {
    const R = `${Date.now()}`
    const A = randomUUID()
    const { eventId } = await webhook(A, { transactionId: R })
    expect(await evento(eventId)).toMatchObject({ status: 'PENDING', errorReason: 'AWAITING_PAYMENT' })

    const pagoB = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), ref: R }), f.staffId)
    await backfillAcreditado(pagoB.id)
    expect(await evento(eventId)).toMatchObject({ status: 'PENDING', paymentId: null })

    const pagoA = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: A, ref: R }), f.staffId)
    expect(pagoA.id).not.toBe(pagoB.id)
    expect(await esperar(async () => (await evento(eventId)).status === 'PROCESSED')).toBe(true)
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pagoA.id })
  })
})

describe('Codex R1 · P1-2: el serial del webhook se compara con la terminal del vínculo', () => {
  it('un serial que CONTRADICE la terminal del vínculo: evidencia + alarma, sin dinero y sin cerrar la solicitud', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const { result, eventId } = await webhook(A, { terminalSerial: 'N86OTRA00001' })
    expect(result.action).toBe('ERROR')
    expect(await evento(eventId)).toMatchObject({ status: 'ERROR', errorReason: 'LINK_TERMINAL_MISMATCH', attemptId: A, paymentId: null })
    expect(await pagos()).toHaveLength(0)
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'SENT', paymentId: null })
  })

  it('el mismo serial con prefijo AVQD- y otra caja SÍ coincide: se confirma', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    expect((await webhook(A, { terminalSerial: f.serial.toLowerCase() })).result.action).toBe('CONFIRMED')
  })
})

describe('Codex R1 · P1-3: la afiliación acreditada por el webhook se conserva aunque esté desactivada', () => {
  it('merchant desactivado antes del webhook tardío: el Payment nace con ESA afiliación, no sin afiliación', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    await prisma.merchantAccount.update({ where: { id: f.merchantId }, data: { active: false } })
    try {
      expect((await webhook(A)).result.action).toBe('CONFIRMED')
      const despues = await fila(solicitud.requestId)
      const pago = await exigir(prisma.payment.findUnique({ where: { id: despues.paymentId! } }))
      expect(pago.merchantAccountId).toBe(f.merchantId)
    } finally {
      await prisma.merchantAccount.update({ where: { id: f.merchantId }, data: { active: true } })
    }
  })
})

describe('Codex R1 · P1-4: S3 no pierde lo que el REST acredita', () => {
  it('el webhook NO inventa internacionalidad; el REST posterior acredita isInternational:true y queda', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    // La terminal guarda como referencia el `transactionId` de AngelPay (verificado en prod): el REST trae la MISMA.
    const R = `${Date.now()}77`
    expect((await webhook(A, { transactionId: R })).result.action).toBe('CONFIRMED')
    const antes = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect((antes.processorData as Record<string, unknown>).isInternational ?? null).toBeNull()

    const rest = await recordFastPayment(
      f.venueId,
      {
        ...f.registroDeLaTerminal({
          attemptId: A,
          requestId: solicitud.requestId,
          ref: R,
          tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CONTACTLESS' },
        }),
        isInternational: true,
      },
      f.staffId,
    )
    expect(rest.id).toBe(antes.id)
    const despues = await exigir(prisma.payment.findUnique({ where: { id: antes.id } }))
    expect((despues.processorData as Record<string, unknown>).isInternational).toBe(true)
    expect(despues.cardBrand).toBe('VISA')
  })

  it('REST que pierde la carrera bajo el candado contra el webhook: devuelve el ganador CONSOLIDADO (marca, PAN, débito e internacionalidad reales)', async () => {
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    let soltar!: () => void
    const suelto = new Promise<void>(r => (soltar = r))
    // T1 toma el candado de la solicitud, «gana» como lo haría el webhook (Payment provisional + cierre) y sólo suelta al final.
    // Codex R12-13 (l): T1 se registra como MONTAJE del conjunto de actores EN EL MISMO INSTANTE en que se lanza — no había
    // manejador durante la ventana hasta incorporarlo, y un rechazo temprano suyo se perdía.
    const A2 = actores()
    let pidT1 = 0
    const t1 = prisma.$transaction(
      async tx => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        pidT1 = pid
        await tx.$queryRaw`SELECT 1 FROM "TerminalPaymentRequest" WHERE "requestId" = ${solicitud.requestId} FOR UPDATE`
        const venta = await tx.order.create({
          data: {
            venueId: f.venueId,
            orderNumber: `${f.fixture}-carrera-${randomUUID().slice(0, 6)}`,
            type: 'TAKEOUT',
            source: 'TPV',
            status: 'COMPLETED',
            paymentStatus: 'PAID',
            subtotal: 100,
            taxAmount: 0,
            total: 100,
            createdById: f.staffId,
          },
        })
        const ganador = await tx.payment.create({
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
            merchantAccountId: f.merchantId,
            processedById: f.staffId,
            processorData: { registradoVia: 'webhook', methodProvisional: true, costPending: true, deviceSerialNumber: f.serial },
          },
        })
        const cierre = await terminalPaymentService.closeRowFromPaymentTx(
          tx,
          solicitud.requestId,
          ganador.id,
          f.venueId,
          { amountCents: 10000, tipCents: 0 },
          'REST',
          f.serial,
          'webhook',
        )
        expect(cierre.bound).toBe(true)
        await suelto
        return ganador.id
      },
      { timeout: 20_000 },
    )
    const tx1 = A2.montaje('T1 (webhook)', t1)
    // Barrera OBSERVABLE (Codex R2): no se suelta por reloj sino cuando Postgres muestra al REST ESPERANDO el candado de la
    // solicitud — así se acredita que pasó el pre-chequeo (nada visible todavía) y llegó al `FOR UPDATE` del arbitraje.
    await new Promise(r => setTimeout(r, 150))
    const rest = A2.lanzar(
      'REST de A',
      recordFastPayment(
        f.venueId,
        {
          ...f.registroDeLaTerminal({
            attemptId: A,
            requestId: solicitud.requestId,
            tarjeta: { cardBrand: 'VISA', maskedPan: '****4321', entryMode: 'CHIP' },
          }),
          method: 'DEBIT_CARD',
          isInternational: true,
        },
        f.staffId,
      ),
    )
    // Codex R3: la barrera IDENTIFICA su conexión y su bloqueador — el REST espera en el `FOR UPDATE` marcado del arbitraje
    // (`/* arbitraje */`), bloqueado exactamente por el pid de T1, no por cualquier candado de la tabla. Pase lo que pase
    // con la observación, T1 se suelta: un candado huérfano dejaría colgada la limpieza de la suite entera. Codex R8/R9 (l):
    // lo observado se RECOGE y se afirma después de asentar a los dos actores (T1 y el REST).
    let enEspera: Awaited<ReturnType<typeof f.esperarBloqueados>> = []
    let fallo: Fallo = null
    try {
      enEspera = await f.esperarBloqueados('arbitraje', 1)
    } catch (error) {
      fallo = { error }
    } finally {
      await A2.liberar({ 'candado de T1': () => soltar() })
    }
    await A2.cerrar(fallo)
    // Codex R10 (l): la fase de aserciones va dentro de `afirmar` — si una aserción cae, los actores que quedaban por examinar
    // se examinan igual (un rechazo ⇒ INCONCLUSO con el fallo original) y, si termina bien, todos tienen que haber sido examinados.
    await A2.afirmar(async () => {
      await expect(tx1.resultado()).resolves.toEqual(expect.any(String))
      await expect(rest.resultado()).resolves.toMatchObject({ id: expect.any(String) })
      expect(enEspera).toHaveLength(1)
      expect(enEspera[0].bloqueadoPor).toContain(pidT1)
      const ganadorId = await tx1.resultado()
      const resultado = await rest.resultado()
      expect(resultado.id).toBe(ganadorId)
      const despues = await exigir(prisma.payment.findUnique({ where: { id: ganadorId } }))
      expect(despues.cardBrand).toBe('VISA')
      expect(despues.maskedPan).toBe('****4321')
      expect(despues.method).toBe('DEBIT_CARD')
      const datos = despues.processorData as Record<string, unknown>
      expect(datos.methodProvisional).toBe(false)
      expect(datos.isInternational).toBe(true)
      expect(await pagos()).toHaveLength(1)
    })
  })
})

describe('Codex R2 · la identidad acreditada por el vínculo manda en los DOS caminos y el webhook no acredita lo que no sabe', () => {
  it('N2 · REST de A (con vínculo) ANTES del webhook, con un Payment LEGACY sin llave de la misma referencia: A crea SU Payment y el webhook lo confirma', async () => {
    const R = `${Date.now()}`
    const legacy = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }),
      f.staffId,
    )
    const solicitudA = await f.solicitud({ amountCents: 10000 })
    const A = await vincular(solicitudA.requestId)

    const pagoA = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: A, requestId: solicitudA.requestId, ref: R }),
      f.staffId,
    )
    expect(pagoA.id).not.toBe(legacy.id)
    expect((await fila(solicitudA.requestId)).paymentId).toBe(pagoA.id)

    // El REST ya cerró la solicitud: el webhook sólo confirma (por vínculo o por su llave exacta), nunca crea otro Payment.
    const { result, eventId } = await webhook(A, { transactionId: R })
    expect(['CONFIRMED', 'MATCHED']).toContain(result.action)
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pagoA.id })
    expect((await fila(solicitudA.requestId)).paymentId).toBe(pagoA.id)
    expect(await pagos()).toHaveLength(2)
  })

  it('P1-1 backfill · un evento PENDING de A (con vínculo, receptor muerto) NO se cierra con el REST LEGACY sin llave de la misma referencia', async () => {
    const R = `${Date.now()}`
    const solicitudA = await f.solicitud({ amountCents: 10000 })
    const A = await vincular(solicitudA.requestId)
    const eventId = `${f.fixture}-${randomUUID()}`
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        eventId: `angelpay-${eventId}`,
        type: 'send_transaction',
        payload: f.eventoAngelPay(A, { transactionId: R }) as never,
        status: 'PENDING',
        errorReason: 'AWAITING_PAYMENT',
        attemptId: A,
        venueId: f.venueId,
        nextAttemptAt: new Date(Date.now() + 60_000),
        claimToken: 'receptor-muerto',
      },
    })

    const legacy = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }),
      f.staffId,
    )
    await backfillAcreditado(legacy.id)
    expect(await evento(eventId)).toMatchObject({ status: 'PENDING', paymentId: null })
    expect(
      ((await exigir(prisma.payment.findUnique({ where: { id: legacy.id } }))).processorData as Record<string, unknown>).angelpayWebhook ??
        null,
    ).toBeNull()
  })

  it('N1 · un webhook REPETIDO (otro eventId) no acredita el método provisional; el REST posterior con débito internacional queda sin contradicción', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    // El webhook que CREA el Payment lanza el backfill del registrador (vuelve a sellar su propio evento): drenado antes de leer.
    expect((await conBackfillDrenado(() => webhook(A, { transactionId: R }))).result.action).toBe('CONFIRMED')
    const antes = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect((antes.processorData as Record<string, unknown>).methodProvisional).toBe(true)

    const repetido = await webhook(A, { transactionId: R })
    expect(['CONFIRMED', 'MATCHED']).toContain(repetido.result.action)
    const tras = await exigir(prisma.payment.findUnique({ where: { id: antes.id } }))
    expect(tras.method).toBe('CREDIT_CARD')
    expect((tras.processorData as Record<string, unknown>).methodProvisional).toBe(true)
    expect((tras.processorData as Record<string, unknown>).costPending).toBe(true)

    const rest = await recordFastPayment(
      f.venueId,
      {
        ...f.registroDeLaTerminal({
          attemptId: A,
          requestId: solicitud.requestId,
          ref: R,
          tarjeta: { cardBrand: 'VISA', maskedPan: '****1234', entryMode: 'CHIP' },
        }),
        method: 'DEBIT_CARD',
        isInternational: true,
      },
      f.staffId,
    )
    expect(rest.id).toBe(antes.id)
    const despues = await exigir(prisma.payment.findUnique({ where: { id: antes.id } }))
    expect(despues.method).toBe('DEBIT_CARD')
    expect(despues.cardBrand).toBe('VISA')
    expect((despues.processorData as Record<string, unknown>).methodProvisional).toBe(false)
    expect((despues.processorData as Record<string, unknown>).isInternational).toBe(true)
    // Codex R3: la bitácora está MOCKEADA en integración (`integration-setup.ts`); un `count` sobre la tabla daría cero por el
    // motivo equivocado. Se comprueban las llamadas al escritor — y que el mock sí registra cuando hay contradicción lo fija
    // la prueba P2-2 de la suite del registrador.
    expect(bitacora('TERMINAL_PAYMENT_ENRICHMENT_CONTRADICTION').filter(p => p.entityId === antes.id)).toHaveLength(0)
    // El costo diferido ya puede calcularse con el método REAL: el efecto queda reprogramado a «ahora».
    const efecto = await prisma.paymentEffect.findFirst({ where: { paymentId: antes.id, kind: 'TRANSACTION_COST' } })
    expect(efecto).not.toBeNull()
    expect(efecto!.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('P2 · el REPLAY de una segunda captura (otro eventId) conserva su clasificación: sigue siendo evidencia, no un cobro confirmado', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud({ amountCents: 10000 })
    const A1 = await vincular(solicitud.requestId)
    const ganador = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: A1, requestId: solicitud.requestId, ref: `${R}1` }),
      f.staffId,
    )
    expect((await fila(solicitud.requestId)).paymentId).toBe(ganador.id)

    const A2 = await vincular(solicitud.requestId, randomUUID())
    const primera = await webhook(A2, { transactionId: `${R}2` })
    expect(await evento(primera.eventId)).toMatchObject({ errorReason: 'POSSIBLE_SECOND_CAPTURE' })
    const evidencia = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A2 } }))
    expect(evidencia.status).toBe('PENDING')

    const replay = await webhook(A2, { transactionId: `${R}2` })
    expect(await evento(replay.eventId)).toMatchObject({
      status: 'PROCESSED',
      paymentId: evidencia.id,
      errorReason: 'POSSIBLE_SECOND_CAPTURE',
    })
    expect((await fila(solicitud.requestId)).paymentId).toBe(ganador.id)
    expect((await exigir(prisma.payment.findUnique({ where: { id: evidencia.id } }))).status).toBe('PENDING')
    expect(await pagos()).toHaveLength(2)
  })
})

describe('Codex R3 · P2: la segunda captura nacida del webhook conserva su origen y la provisionalidad del método', () => {
  it('A ganó por REST; el approved de B (misma solicitud) nace PENDING con registradoVia webhook + methodProvisional; el REST de B con DÉBITO enriquece sin contradicción, sigue PENDING y sin costo', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud({ amountCents: 10000 })
    const A = await vincular(solicitud.requestId)
    const ganador = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: A, requestId: solicitud.requestId, ref: `${R}1` }),
      f.staffId,
    )
    expect((await fila(solicitud.requestId)).paymentId).toBe(ganador.id)

    const B = await vincular(solicitud.requestId, randomUUID())
    const { eventId } = await webhook(B, { transactionId: `${R}2` })
    expect(await evento(eventId)).toMatchObject({ errorReason: 'POSSIBLE_SECOND_CAPTURE' })
    const evidencia = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: B } }))
    expect(evidencia.status).toBe('PENDING')
    expect(evidencia.processorData).toMatchObject({
      registradoVia: 'webhook',
      methodProvisional: true,
      reconciliation: { kind: 'POSSIBLE_SECOND_CAPTURE' },
    })

    const rest = await recordFastPayment(
      f.venueId,
      {
        ...f.registroDeLaTerminal({
          attemptId: B,
          requestId: solicitud.requestId,
          ref: `${R}2`,
          tarjeta: { cardBrand: 'VISA', maskedPan: '****9999', entryMode: 'CHIP' },
        }),
        method: 'DEBIT_CARD',
      },
      f.staffId,
    )
    expect(rest.id).toBe(evidencia.id)
    const despues = await exigir(prisma.payment.findUnique({ where: { id: evidencia.id } }))
    expect(despues.status).toBe('PENDING')
    expect(despues.method).toBe('DEBIT_CARD')
    expect(despues.cardBrand).toBe('VISA')
    expect(despues.processorData).toMatchObject({ methodProvisional: false, reconciliation: { kind: 'POSSIBLE_SECOND_CAPTURE' } })
    expect(bitacora('TERMINAL_PAYMENT_ENRICHMENT_CONTRADICTION').filter(p => p.entityId === evidencia.id)).toHaveLength(0)
    expect(await prisma.transactionCost.count({ where: { paymentId: evidencia.id } })).toBe(0)
    expect((await fila(solicitud.requestId)).paymentId).toBe(ganador.id)
    expect(await pagos()).toHaveLength(2)
  })
})

describe('Codex R4-5 · un vínculo que llega DESPUÉS de que el matcher débil selló sobre OTRO Payment no deja al intento sin confirmación', () => {
  afterEach(() => jest.restoreAllMocks())

  it('approved de A antes del vínculo, con B legacy (misma referencia e importe, sin llave) ya registrado: el débil sella sobre B; al vincular A el evento se REABRE, B queda con la huella REVOCADA y el worker confirma A por el vínculo', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = randomUUID()
    const pagoB = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId)

    const { result, eventId } = await webhook(A, { transactionId: R })
    expect(result.action).toBe('MATCHED')
    const ev = await evento(eventId)
    expect(ev).toMatchObject({ status: 'PROCESSED', paymentId: pagoB.id })
    expect((await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))).processorData).toMatchObject({
      angelpayWebhook: { integratorReference: A },
    })

    await vincular(solicitud.requestId, A)

    const reabierto = await evento(eventId)
    expect(reabierto).toMatchObject({
      status: 'PENDING',
      errorReason: 'LINK_ARRIVED_AFTER_WEAK_MATCH',
      paymentId: null,
      claimToken: null,
      leaseUntil: null,
    })
    expect(reabierto.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now())
    const b = await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))
    expect(b.processorData).not.toHaveProperty('angelpayWebhook')
    expect(b.processorData).toMatchObject({
      angelpayWebhookRevoked: {
        reason: 'LINK_ARRIVED_AFTER_WEAK_MATCH',
        attemptId: A,
        requestId: solicitud.requestId,
        previous: { integratorReference: A },
      },
    })
    expect(b.status).toBe('COMPLETED')

    const claims = await claimPendingAngelPayEvents({ now: new Date(), limit: 25 })
    expect(claims.map(c => c.id)).toContain(ev.id)
    for (const c of claims) await runClaimedAngelPayEvent(c)

    const pagoA = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(pagoA.id).not.toBe(pagoB.id)
    expect(pagoA.status).toBe('COMPLETED')
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pagoA.id })
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pagoA.id, closedVia: 'webhook' })
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(2)
  })

  it('carrera: el vínculo se vuelve durable ENTRE la comprobación previa y el sello — bajo el candado se ve, se confirma por el vínculo y B queda intacta', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = randomUUID()
    const pagoB = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId)
    await vincular(solicitud.requestId, A)
    // La comprobación previa (antes del matcher) «no ve» el vínculo: es la ventana de la carrera.
    jest.spyOn(terminalPaymentService, 'findAttemptLink').mockResolvedValueOnce(null)

    const { result, eventId } = await webhook(A, { transactionId: R })

    expect(result.action).toBe('CONFIRMED')
    expect((await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))).processorData).not.toHaveProperty('angelpayWebhook')
    const pagoA = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pagoA.id })
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pagoA.id, closedVia: 'webhook' })
  })

  it('un evento sellado sobre el Payment CORRECTO (misma llave) no se reabre al repetir el vínculo; un vínculo repetido (ALREADY_LINKED) no toca nada', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    const { eventId } = await webhook(A, { transactionId: R })
    const pagoA = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pagoA.id })

    const ack = await terminalPaymentService.handleAttemptOpenedFromSocket(
      { requestId: solicitud.requestId, attemptId: A },
      { socketId: 's', terminalId: f.serial, venueId: f.venueId },
    )
    expect(ack).toMatchObject({ success: true, outcome: 'ALREADY_LINKED' })
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pagoA.id })
    expect((await exigir(prisma.payment.findUnique({ where: { id: pagoA.id } }))).processorData).not.toHaveProperty(
      'angelpayWebhookRevoked',
    )
  })

  it('P2 · el fallo del registrador escrito por un dueño que ya perdió la propiedad contesta el desenlace DURABLE, no PROCESSING_ERROR', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = await vincular(solicitud.requestId)
    // Otro dueño (el worker) ya terminó el evento por debajo con SU Payment: simulado marcando la fila PROCESSED antes de
    // la escritura del receptor, que llega tarde porque su registrador cayó.
    const delOtroDueno = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), ref: `${R}-otro` }),
      f.staffId,
    )
    const espia = jest.spyOn(registrador, 'recordFastPayment').mockRejectedValueOnce(new Error('registrador caído'))
    const eventId = f.nuevoEventId()
    const original = prisma.providerEventLog.updateMany.bind(prisma.providerEventLog)
    let interceptado = false
    jest.spyOn(prisma.providerEventLog, 'updateMany').mockImplementation((async (args: Parameters<typeof original>[0]) => {
      const data = args.data as { errorReason?: string }
      if (!interceptado && data?.errorReason === 'PROCESSING_ERROR') {
        interceptado = true
        await prisma.providerEventLog.update({
          where: { id: (args.where as { id: string }).id },
          data: { status: 'PROCESSED', paymentId: delOtroDueno.id, claimToken: 'otro-dueno' },
        })
        return { count: 0 }
      }
      return original(args)
    }) as never)

    const result = await processAngelPayWebhook({
      payload: f.eventoAngelPay(A, { transactionId: R }),
      eventId,
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    })
    expect(espia).toHaveBeenCalled()
    expect(interceptado).toBe(true)
    expect(result).toMatchObject({ action: 'MATCHED', paymentId: delOtroDueno.id, message: 'RESOLVED_BY_ANOTHER_OWNER' })
    expect(result.errorReason).not.toBe('PROCESSING_ERROR')
  })
})

describe('Codex R5 · R5-4: TODA escritura por identidad DÉBIL (discrepancia, cruce de comercio, backfill) se decide bajo el candado del evento y relee el vínculo S1', () => {
  afterEach(() => jest.restoreAllMocks())

  it('discrepancia: el vínculo se vuelve durable ENTRE la comprobación previa y la escritura — bajo el candado se ve: NO se estampa angelpayDiscrepancy sobre B ni se cierra el evento como ERROR; se decide por el vínculo', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = randomUUID()
    const pagoB = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId)
    await vincular(solicitud.requestId, A)
    jest.spyOn(terminalPaymentService, 'findAttemptLink').mockResolvedValueOnce(null)

    // $105.50: contra B ($100) sería DISCREPANCIA; contra el contrato de la solicitud ($100) es AMOUNT_MISMATCH por vínculo.
    const { result, eventId } = await webhook(A, { transactionId: R, amount: '000000010550' })

    expect(result.action).not.toBe('DISCREPANCY')
    expect((await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))).processorData).not.toHaveProperty('angelpayDiscrepancy')
    const ev = await evento(eventId)
    expect(ev.paymentId).not.toBe(pagoB.id)
    expect(ev).toMatchObject({ status: 'PENDING', errorReason: 'AMOUNT_MISMATCH' })
  })

  it('cruce de comercio: el vínculo llegó entre la comprobación previa y la escritura — bajo el candado se ve: B (registrada por el comercio hermano) NO se estampa como MERCHANT_MISMATCH y el approved se confirma por el VÍNCULO', async () => {
    const R = `${Date.now()}`
    const hermana = await f.afiliacionSecundaria()
    const pagoB = await recordFastPayment(
      f.venueId,
      { ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), merchantAccountId: hermana.id },
      f.staffId,
    )
    expect(pagoB.merchantAccountId).toBe(hermana.id)
    const solicitud = await f.solicitud()
    const A = randomUUID()
    await vincular(solicitud.requestId, A)
    jest.spyOn(terminalPaymentService, 'findAttemptLink').mockResolvedValueOnce(null)

    const { result, eventId } = await webhook(A, { transactionId: R })

    expect(result.action).toBe('CONFIRMED')
    expect((await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))).processorData).not.toHaveProperty('angelpayWebhook')
    const pagoA = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(pagoA.id).not.toBe(pagoB.id)
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pagoA.id, errorReason: null })
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pagoA.id, closedVia: 'webhook' })
  })

  it('backfill: el approved de A quedó PENDING sin vínculo; el vínculo de A se escribe y llega el REST LEGACY de B (misma referencia, sin llave) cuyo backfill no ve el vínculo en la comprobación previa — bajo el candado lo ve y deja el evento al worker: B no se estampa y el evento sigue PENDING', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = randomUUID()
    const { result, eventId } = await webhook(A, { transactionId: R })
    expect(result).toMatchObject({ action: 'ORPHANED', errorReason: 'AWAITING_PAYMENT' })
    await vincular(solicitud.requestId, A)
    // Codex R6 (P2): el backfill fire-and-forget del REST se CAPTURA y se espera hasta que termine (nada de dormir 200 ms):
    // así el espía de abajo sólo lo consume la llamada explícita, que es la carrera bajo prueba. Codex R12-13: drenado y
    // restauración del espía garantizados aunque algo caiga en medio.
    const pagoB = await registroConBackfillDrenado(f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }))
    // Ese backfill vio el vínculo y lo respetó; la carrera es la llamada explícita, que NO lo ve en la comprobación previa.
    expect(await evento(eventId)).toMatchObject({ status: 'PENDING', errorReason: 'AWAITING_PAYMENT', paymentId: null })
    const espiaS1 = jest.spyOn(terminalPaymentService, 'findAttemptLink').mockResolvedValueOnce(null)

    await backfillAcreditado(pagoB.id)

    // Codex R6 (k): se ACREDITA que la llamada explícita consumió el `null` (una salida anticipada dejaría las mismas
    // aserciones finales): el espía se llamó exactamente una vez, con la llave de A, y devolvió `null`.
    expect(espiaS1).toHaveBeenCalledTimes(1)
    expect(espiaS1.mock.calls[0][0]).toBe(A)
    await expect(espiaS1.mock.results[0].value).resolves.toBeNull()
    expect((await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))).processorData).not.toHaveProperty('angelpayWebhook')
    expect(await evento(eventId)).toMatchObject({ status: 'PENDING', errorReason: 'AWAITING_PAYMENT', paymentId: null })
  })
})

describe('Codex R5 · R5-5: el vínculo y la reapertura de los eventos débiles son UNA transacción', () => {
  afterEach(() => jest.restoreAllMocks())

  it('si la reapertura revienta, el vínculo NO queda escrito (la terminal reintenta el anuncio) y el evento sigue PROCESSED sobre B; al reintentar con la reapertura sana, el vínculo se escribe y el evento se reabre', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = randomUUID()
    const pagoB = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId)
    const { eventId } = await webhook(A, { transactionId: R })
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pagoB.id })

    const webhookService = await import('@/services/tpv/angelpay-webhook.service')
    const espia = jest.spyOn(webhookService, 'recuperarEventosDebilesPorVinculo').mockRejectedValueOnce(new Error('reapertura caída'))
    await expect(
      terminalPaymentService.handleAttemptOpenedFromSocket(
        { requestId: solicitud.requestId, attemptId: A },
        { socketId: 's', terminalId: f.serial, venueId: f.venueId },
      ),
    ).rejects.toThrow('reapertura caída')
    expect(await prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId: A } })).toBeNull()
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pagoB.id })
    espia.mockRestore()

    await vincular(solicitud.requestId, A)
    expect(await evento(eventId)).toMatchObject({ status: 'PENDING', errorReason: 'LINK_ARRIVED_AFTER_WEAK_MATCH', paymentId: null })
    expect((await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))).processorData).toHaveProperty('angelpayWebhookRevoked')
  })
})

describe('Codex R5 · P2: la revocación de la huella al reabrir un evento débil es POR IDENTIDAD del evento y conserva historial', () => {
  it('la huella vigente del Payment equivocado es de OTRO evento (el webhook legacy del propio B, llegado después): al vincular A el evento débil se reabre, pero esa huella NO se revoca', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = randomUUID()
    const pagoB = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId)
    const { result: rA, eventId: eA } = await webhook(A, { transactionId: R })
    expect(rA.action).toBe('MATCHED')
    const { result: rB, eventId: eB } = await webhook(undefined, { transactionId: R })
    expect(rB.action).toBe('MATCHED')
    expect((await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))).processorData).toMatchObject({
      angelpayWebhook: { eventId: eB },
    })

    await vincular(solicitud.requestId, A)

    expect(await evento(eA)).toMatchObject({ status: 'PENDING', errorReason: 'LINK_ARRIVED_AFTER_WEAK_MATCH', paymentId: null })
    expect(await evento(eB)).toMatchObject({ status: 'PROCESSED', paymentId: pagoB.id })
    const b = await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))
    expect(b.processorData).toMatchObject({ angelpayWebhook: { eventId: eB } })
    expect(b.processorData).not.toHaveProperty('angelpayWebhookRevoked')
  })

  it('dos reaperturas sobre el MISMO Payment (dos intentos de la misma solicitud sellados sobre B) dejan DOS revocaciones en el historial, y la última también en angelpayWebhookRevoked', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const pagoB = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId)
    const A1 = randomUUID()
    const { eventId: e1 } = await webhook(A1, { transactionId: R })
    await vincular(solicitud.requestId, A1)
    expect(await evento(e1)).toMatchObject({ status: 'PENDING', errorReason: 'LINK_ARRIVED_AFTER_WEAK_MATCH' })
    const A2 = randomUUID()
    const { result: r2, eventId: e2 } = await webhook(A2, { transactionId: R })
    expect(r2.action).toBe('MATCHED')
    await vincular(solicitud.requestId, A2)
    expect(await evento(e2)).toMatchObject({ status: 'PENDING', errorReason: 'LINK_ARRIVED_AFTER_WEAK_MATCH' })

    const b = await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))
    const datos = b.processorData as Record<string, any>
    expect(datos.angelpayWebhookRevocations).toHaveLength(2)
    expect(datos.angelpayWebhookRevocations.map((r: { attemptId: string }) => r.attemptId)).toEqual([A1, A2])
    expect(datos.angelpayWebhookRevocations.map((r: { eventId: string }) => r.eventId)).toEqual([e1, e2])
    expect(datos.angelpayWebhookRevoked).toMatchObject({ attemptId: A2, eventId: e2, previous: { integratorReference: A2 } })
    expect(datos).not.toHaveProperty('angelpayWebhook')
  })

  it('Codex R13 (cobertura) · la revocación conserva las LLAVES MONETARIAS del Payment equivocado byte a byte (snapshot de tarifa, marca de costo, etiqueta de solicitud, procedencia): sólo retira la huella de SU evento y apila la revocación', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const pagoB = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId)
    const A = randomUUID()
    const { result, eventId } = await webhook(A, { transactionId: R })
    expect(result.action).toBe('MATCHED')
    const antes = (await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))).processorData as Record<string, unknown>
    expect(antes).toHaveProperty('angelpayWebhook')
    expect(antes).toHaveProperty('pricing')
    expect(antes).toHaveProperty('costPending')
    const monetariasAntes = Object.fromEntries(Object.entries(antes).filter(([k]) => k !== 'angelpayWebhook'))
    await vincular(solicitud.requestId, A)
    expect(await evento(eventId)).toMatchObject({ status: 'PENDING', errorReason: 'LINK_ARRIVED_AFTER_WEAK_MATCH' })
    const despues = (await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))).processorData as Record<string, unknown>
    const { angelpayWebhookRevoked, angelpayWebhookRevocations, ...monetariasDespues } = despues
    expect(despues).not.toHaveProperty('angelpayWebhook')
    expect(angelpayWebhookRevoked).toMatchObject({ attemptId: A, eventId, previous: { integratorReference: A } })
    expect(angelpayWebhookRevocations).toHaveLength(1)
    // Todo lo demás —pricing, costPending, deviceSerialNumber, pricingSlot, blumon…— exactamente igual que antes de revocar.
    expect(monetariasDespues).toEqual(monetariasAntes)
  })
})

describe('Codex R5 · P2: la evidencia de COLISIÓN de referencia se reconoce como evidencia en el webhook (confirmarPorVinculo) y en S6', () => {
  it('K1 (con llave, SIN vínculo aún) contradice a un legacy B de la misma referencia ⇒ evidencia PENDING con la llave K1; después llegan el vínculo y el approved de K1: el evento queda PROCESSED/POSSIBLE_REFERENCE_COLLISION sobre la evidencia (acción REFERENCE_COLLISION), no nace dinero, la solicitud sigue sin ganador y S6 dice REFERENCE_COLLISION_EVIDENCE', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const K1 = randomUUID()
    const pagoB = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R, auth: 'AUTH-B' }),
      f.staffId,
    )
    const evidencia = await recordFastPayment(
      f.venueId,
      f.registroDeLaTerminal({ attemptId: K1, ref: R, auth: 'AUTH-K1', requestId: solicitud.requestId }),
      f.staffId,
    )
    expect(evidencia.status).toBe('PENDING')
    expect(evidencia.idempotencyKey).toBe(K1)
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'SENT', paymentId: null })

    await vincular(solicitud.requestId, K1)
    const { result, eventId } = await webhook(K1, { transactionId: R })

    expect(result).toMatchObject({ action: 'REFERENCE_COLLISION', paymentId: evidencia.id })
    expect(await evento(eventId)).toMatchObject({
      status: 'PROCESSED',
      paymentId: evidencia.id,
      errorReason: 'POSSIBLE_REFERENCE_COLLISION',
    })
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'SENT', paymentId: null })
    expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(2)
    expect(await prisma.payment.count({ where: { venueId: f.venueId, status: 'COMPLETED' } })).toBe(1)
    expect((await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))).status).toBe('COMPLETED')
    const s6 = await terminalPaymentService.consultarIntentoDeTerminal({ attemptId: K1, venueId: f.venueId, terminalSerial: f.serial })
    expect(s6!.attempt).toMatchObject({
      outcome: 'REFERENCE_COLLISION_EVIDENCE',
      paymentId: evidencia.id,
      paymentStatus: 'PENDING',
      isWinner: false,
    })
    expect(s6!.request).toMatchObject({ status: 'SENT', paymentId: null })
  })
})

describe('Codex R6 · R6-3: una discrepancia DÉBIL (contra el Payment de OTRO cobro) se reabre al llegar el vínculo; un rechazo bancario no', () => {
  it('B legacy $100 ref R; el approved de A por $105.50 llega ANTES del vínculo ⇒ DISCREPANCY sobre B; al vincular A a Q ($105.50) el evento se REABRE, la discrepancia de B queda REVOCADA con historial, y el worker confirma A por $105.50', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud({ amountCents: 10550 })
    const A = randomUUID()
    const pagoB = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }), f.staffId)

    const { result, eventId } = await webhook(A, { transactionId: R, amount: '000000010550' })
    expect(result).toMatchObject({ action: 'DISCREPANCY', paymentId: pagoB.id })
    expect(await evento(eventId)).toMatchObject({ status: 'ERROR', errorReason: 'AMOUNT_MISMATCH', paymentId: pagoB.id })
    expect((await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))).processorData).toMatchObject({
      angelpayDiscrepancy: { eventId, webhookAmount: 105.5, recordedAmount: 100 },
    })

    await vincular(solicitud.requestId, A)

    expect(await evento(eventId)).toMatchObject({
      status: 'PENDING',
      errorReason: 'LINK_ARRIVED_AFTER_WEAK_MATCH',
      paymentId: null,
      claimToken: null,
    })
    const b = await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))
    expect(b.processorData).not.toHaveProperty('angelpayDiscrepancy')
    expect(b.processorData).toMatchObject({
      angelpayDiscrepancyRevoked: { reason: 'LINK_ARRIVED_AFTER_WEAK_MATCH', attemptId: A, eventId, previous: { webhookAmount: 105.5 } },
    })
    expect((b.processorData as Record<string, any>).angelpayDiscrepancyRevocations).toHaveLength(1)
    expect(Number(b.amount)).toBe(100)

    const claims = await claimPendingAngelPayEvents({ now: new Date(), limit: 25 })
    expect(claims.map(c => c.id)).toContain((await evento(eventId)).id)
    for (const c of claims) await runClaimedAngelPayEvent(c)

    const pagoA = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(pagoA.status).toBe('COMPLETED')
    expect(Number(pagoA.amount)).toBe(105.5)
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pagoA.id })
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pagoA.id, closedVia: 'webhook' })
  })

  it('un declined de A (ERROR/NOT_APPROVED) y una discrepancia por identidad FUERTE (PENDING) NO se tocan al vincular: sólo se reabre la discrepancia débil', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud({ amountCents: 10000 })
    const A = randomUUID()
    const { eventId: rechazo } = await webhook(A, { transactionId: R, status: 'declined' })
    expect(await evento(rechazo)).toMatchObject({ status: 'ERROR', errorReason: 'NOT_APPROVED' })

    await vincular(solicitud.requestId, A)

    expect(await evento(rechazo)).toMatchObject({ status: 'ERROR', errorReason: 'NOT_APPROVED' })
    const { result, eventId: fuerte } = await webhook(A, { transactionId: `${R}9`, amount: '000000010550' })
    expect(result).toMatchObject({ action: 'ORPHANED', errorReason: 'AMOUNT_MISMATCH' })
    const ack = await terminalPaymentService.handleAttemptOpenedFromSocket(
      { requestId: solicitud.requestId, attemptId: A },
      { socketId: 's', terminalId: f.serial, venueId: f.venueId },
    )
    expect(ack).toMatchObject({ success: true, outcome: 'ALREADY_LINKED' })
    expect(await evento(fuerte)).toMatchObject({ status: 'PENDING', errorReason: 'AMOUNT_MISMATCH' })
    expect(await evento(rechazo)).toMatchObject({ status: 'ERROR', errorReason: 'NOT_APPROVED' })
  })
})

describe('Codex R6 · R6-2: EXCLUSIÓN por intento — el vínculo y todo escritor débil se serializan por `attemptId`, aunque no exista ningún evento', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS
  })

  /**
   * Los dos lados del candado consultivo del intento en `pg_locks` (Codex R6-2 (e)): quién lo tiene, quién lo espera, quién
   * bloquea a quién (`pg_blocking_pids`) y en qué estado está cada sesión (`pg_stat_activity`: la dueña pausada está
   * «idle in transaction»; la que espera, «active» sobre el `pg_advisory_xact_lock`).
   */
  const candados = (A: string) =>
    prisma.$queryRaw<{ pid: number; granted: boolean; bloqueadores: number[]; estado: string | null; consulta: string | null }[]>`
      SELECT l.pid, l.granted, pg_blocking_pids(l.pid) AS bloqueadores, a.state AS estado, a.query AS consulta
      FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.classid = ${NS_CANDADO_INTENTO}::oid AND l.objsubid = 2
        AND l.objid::bigint = ((hashtext(${A})::bigint % 4294967296 + 4294967296) % 4294967296)`
  const barrera = () => {
    let soltar!: () => void
    let pausado!: () => void
    const liberada = new Promise<void>(r => (soltar = r))
    const enPausa = new Promise<void>(r => (pausado = r))
    /**
     * Espera ACOTADA a la pausa: `false` si el actor instrumentado nunca llegó a la barrera (p. ej. porque un mutante le quitó
     * el candado que lo identifica). Así la prueba cae por ASERCIÓN, no por el timeout de Jest — el runner certificado (Codex
     * R7 (l)) sólo cuenta aserciones.
     */
    const pausadaEn = (ms: number) =>
      Promise.race([
        enPausa.then(() => true),
        new Promise<boolean>(r => {
          const t = setTimeout(() => r(false), ms)
          t.unref?.()
        }),
      ])
    return { soltar, pausado, liberada, enPausa, pausadaEn }
  }
  /**
   * Codex R7 (P2): B legacy se registra y se ESPERA a que termine su backfill fire-and-forget (`reconcileAngelPayWebhookForPayment`):
   * sin eso, ese tercero podría tomar el candado del intento durante la intercalación y contaminar la pareja de actores medida.
   */
  const legacyB = (R: string) => registroConBackfillDrenado(f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: R }))
  /**
   * Codex R7 (P2): instrumenta TODAS las transacciones — registra, en orden, el PID de cada una que toma el candado del intento `A`
   * (identificando así a los actores, no «cualquier dueño y cualquier espera de esa llave») y, si se pide, pausa a la PRIMERA que
   * lo tomó justo después de ejecutar su cuerpo (sello hecho, sin commit).
   * Codex R14-1: el INGRESO del evento también toma el candado (una transacción corta, identificada por su marcador SQL
   * `ingreso del intento`) — no es un actor de estas carreras: no se cuenta ni se pausa.
   */
  const instrumentar = (A: string, pausarLaPrimera?: ReturnType<typeof barrera>) => {
    // `pids`: las transacciones que toman el candado del intento A, en orden, SIN contar el INGRESO del evento (Codex R14-1: el
    // ingreso también lo toma, antes que nadie); las del ingreso van aparte en `pids.ingresos`.
    const pids: number[] & { ingresos: number[] } = Object.assign([] as number[], { ingresos: [] as number[] })
    let pausada = false
    const realTx = prisma.$transaction.bind(prisma)
    jest.spyOn(prisma, '$transaction').mockImplementation(((fn: unknown, opts?: unknown) => {
      if (typeof fn !== 'function') return realTx(fn as never, opts as never)
      return realTx(async (tx: any) => {
        let pidDelCandado: number | null = null
        let esIngreso = false
        const proxy = new Proxy(tx, {
          get: (objetivo, prop) =>
            prop === '$queryRaw'
              ? async (...args: any[]) => {
                  const sql = Array.isArray(args[0]) ? args[0].join('?') : ''
                  if (sql.includes('pg_advisory_xact_lock') && args.includes(A)) {
                    const [{ pid }] = await objetivo.$queryRaw`SELECT pg_backend_pid() AS pid`
                    pidDelCandado = pid
                  }
                  if (sql.includes('ingreso del intento')) esIngreso = true
                  return objetivo.$queryRaw(...args)
                }
              : Reflect.get(objetivo, prop),
        })
        const r = await (fn as (t: unknown) => Promise<unknown>)(proxy)
        if (pidDelCandado !== null && esIngreso && !pids.ingresos.includes(pidDelCandado)) pids.ingresos.push(pidDelCandado)
        if (pidDelCandado !== null && !esIngreso) {
          if (!pids.includes(pidDelCandado)) pids.push(pidDelCandado)
          if (pausarLaPrimera && !pausada) {
            pausada = true
            pausarLaPrimera.pausado()
            await pausarLaPrimera.liberada
          }
        }
        return r
      }, opts as never)
    }) as never)
    return pids
  }
  const publicar = (requestId: string, A: string) =>
    terminalPaymentService.handleAttemptOpenedFromSocket(
      { requestId, attemptId: A },
      { socketId: 's', terminalId: f.serial, venueId: f.venueId },
    )

  it('la publicación del vínculo consultó eventos (ninguno) y aún no commiteó; llega el approved de A por identidad DÉBIL: el INGRESO del evento (Codex R14-1, el primero en tomar el candado del intento) ESPERA ese candado (pg_locks: bloqueador = la transacción del vínculo); al commitear, ingresa, y el escritor débil ve el vínculo y confirma A por el VÍNCULO — B intacta, A con su venta y su solicitud, sin otro anuncio', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = randomUUID()
    const pagoB = await legacyB(R)
    const pids = instrumentar(A)
    const webhookService = await import('@/services/tpv/angelpay-webhook.service')
    const real = webhookService.recuperarEventosDebilesPorVinculo
    const b = barrera()
    jest.spyOn(webhookService, 'recuperarEventosDebilesPorVinculo').mockImplementationOnce(async (a, rid, tx) => {
      const r = await real(a, rid, tx) // consultó: ningún evento todavía
      b.pausado()
      await b.liberada // la transacción del vínculo sigue ABIERTA (candado tomado, vínculo sin commit)
      return r
    })
    // Codex R8/R9 (l): el vínculo y el webhook en vuelo se capturan al lanzarlos (`actores`); lo observado bajo el candado
    // se RECOGE y se afirma DESPUÉS de soltar y de asentar a los dos — un desenlace inesperado o sin asentar vuelve la
    // prueba INCONCLUSA conservando el fallo original, nunca una caída «por aserción» con un error escondido detrás.
    const A2 = actores()
    const obs = { vinculoEnLaBarrera: false, webhookEsperando: false, filas: [] as Awaited<ReturnType<typeof candados>> }
    let L: ReturnType<typeof A2.lanzar<Awaited<ReturnType<typeof publicar>>>> | null = null
    let E: ReturnType<typeof A2.lanzar<Awaited<ReturnType<typeof webhook>>>> | null = null
    let fallo: Fallo = null
    try {
      L = A2.lanzar('vínculo A→Q', publicar(solicitud.requestId, A))
      obs.vinculoEnLaBarrera = await b.pausadaEn(10_000) // el actor instrumentado llegó a la barrera
      E = A2.lanzar('webhook de A', webhook(A, { transactionId: R }))
      obs.webhookEsperando = await f.esperar(async () => (await candados(A)).some(c => !c.granted), 5000)
      obs.filas = await candados(A)
    } catch (error) {
      fallo = { error }
    } finally {
      b.soltar()
    }
    await A2.cerrar(fallo)
    // Codex R10 (l): la fase de aserciones va dentro de `afirmar` — si una aserción cae, los actores que quedaban por examinar
    // se examinan igual (un rechazo ⇒ INCONCLUSO con el fallo original) y, si termina bien, todos tienen que haber sido examinados.
    await A2.afirmar(async () => {
      await expect(L!.resultado()).resolves.toMatchObject({ success: true, outcome: 'LINKED' })
      await expect(E!.resultado()).resolves.toMatchObject({ result: { action: 'CONFIRMED' } })
      expect(obs.vinculoEnLaBarrera).toBe(true)
      expect(obs.webhookEsperando).toBe(true)
      const dueno = obs.filas.find(c => c.granted)
      const esperando = obs.filas.find(c => !c.granted)
      expect(dueno).toBeDefined()
      expect(esperando).toBeDefined()
      expect(esperando!.bloqueadores).toContain(dueno!.pid)
      // La dueña es la transacción del vínculo, pausada (idle in transaction); la que espera está activa sobre el advisory.
      expect(dueno!.estado).toBe('idle in transaction')
      expect(esperando!.estado).toBe('active')
      expect(esperando!.consulta).toContain('pg_advisory_xact_lock')
      // Codex R7 (P2): los actores se identifican por PID — la dueña es L (la primera que tomó el candado) y la que espera es el
      // INGRESO de E (Codex R14-1): el escritor débil de E toma el candado DESPUÉS, ya con el vínculo commiteado.
      expect(pids).toHaveLength(2)
      expect(dueno!.pid).toBe(pids[0])
      expect(pids.ingresos).toHaveLength(1)
      expect(esperando!.pid).toBe(pids.ingresos[0])
      const { eventId } = await E!.resultado()
      expect((await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))).processorData).not.toHaveProperty('angelpayWebhook')
      const pagoA = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
      expect(pagoA.status).toBe('COMPLETED')
      expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pagoA.id })
      expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pagoA.id, closedVia: 'webhook' })
      expect(await prisma.payment.count({ where: { venueId: f.venueId, referenceNumber: R } })).toBe(2)
      expect(Number((await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))).amount)).toBe(100)
    })
  })

  it('la inversa: el escritor débil tiene el candado y sella E sobre B sin commitear; la publicación del vínculo ESPERA (pg_locks: bloqueador = el escritor débil); al commitear el sello, el vínculo entra, ve E PROCESSED sobre B y lo REABRE; el worker confirma A', async () => {
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = randomUUID()
    const pagoB = await legacyB(R)
    const b = barrera()
    // Se pausa la transacción IDENTIFICADA (la primera que toma el candado de A: el escritor débil, con el sello hecho y sin
    // commit), no «la primera $transaction que pase».
    const pids = instrumentar(A, b)
    const A2 = actores()
    const obs = { escritorEnLaBarrera: false, vinculoEsperando: false, filas: [] as Awaited<ReturnType<typeof candados>> }
    let E: ReturnType<typeof A2.lanzar<Awaited<ReturnType<typeof webhook>>>> | null = null
    let L: ReturnType<typeof A2.lanzar<Awaited<ReturnType<typeof publicar>>>> | null = null
    let fallo: Fallo = null
    try {
      E = A2.lanzar('webhook de A (escritor débil)', webhook(A, { transactionId: R }))
      obs.escritorEnLaBarrera = await b.pausadaEn(10_000) // el actor instrumentado llegó a la barrera
      L = A2.lanzar('vínculo A→Q', publicar(solicitud.requestId, A))
      obs.vinculoEsperando = await f.esperar(async () => (await candados(A)).some(c => !c.granted), 5000)
      obs.filas = await candados(A)
    } catch (error) {
      fallo = { error }
    } finally {
      b.soltar()
    }
    await A2.cerrar(fallo)
    // Codex R10 (l): la fase de aserciones va dentro de `afirmar` — si una aserción cae, los actores que quedaban por examinar
    // se examinan igual (un rechazo ⇒ INCONCLUSO con el fallo original) y, si termina bien, todos tienen que haber sido examinados.
    await A2.afirmar(async () => {
      await expect(E!.resultado()).resolves.toMatchObject({ result: { action: 'MATCHED', paymentId: pagoB.id } })
      await expect(L!.resultado()).resolves.toMatchObject({ success: true, outcome: 'LINKED' })
      expect(obs.escritorEnLaBarrera).toBe(true)
      expect(obs.vinculoEsperando).toBe(true)
      const dueno = obs.filas.find(c => c.granted)
      const esperando = obs.filas.find(c => !c.granted)
      expect(dueno).toBeDefined()
      expect(esperando).toBeDefined()
      expect(esperando!.bloqueadores).toContain(dueno!.pid)
      // Codex R7 (P2): la dueña es E (la primera que tomó el candado) y la que espera es L.
      expect(pids).toHaveLength(2)
      expect(dueno!.pid).toBe(pids[0])
      expect(esperando!.pid).toBe(pids[1])
      // La dueña es la transacción del escritor débil, pausada con el sello hecho; la que espera es la publicación del vínculo.
      expect(dueno!.estado).toBe('idle in transaction')
      expect(esperando!.estado).toBe('active')
      expect(esperando!.consulta).toContain('pg_advisory_xact_lock')
      const { eventId } = await E!.resultado()
      expect(await evento(eventId)).toMatchObject({ status: 'PENDING', errorReason: 'LINK_ARRIVED_AFTER_WEAK_MATCH', paymentId: null })
      const bDespues = await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))
      expect(bDespues.processorData).not.toHaveProperty('angelpayWebhook')
      expect(bDespues.processorData).toMatchObject({ angelpayWebhookRevoked: { attemptId: A, eventId } })
      const claims = await claimPendingAngelPayEvents({ now: new Date(), limit: 25 })
      for (const c of claims) await runClaimedAngelPayEvent(c)
      const pagoA = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
      expect(pagoA.status).toBe('COMPLETED')
      expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pagoA.id })
      expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pagoA.id, closedVia: 'webhook' })
      expect(Number(bDespues.amount)).toBe(100)
    })
  })

  it('timeout del candado y recuperación: con el candado del intento tomado por OTRA transacción, la publicación del vínculo vence y NO escribe (la terminal reintenta y entra); el escritor débil vence y NO sella — E sigue PENDING para el worker y B intacta', async () => {
    // Codex R15-3: protocolo de actores — el candado ajeno es un MONTAJE registrado al lanzarlo; cada actor se lanza y se compite
    // contra un reloj acotado (`carrera`, nunca el timeout de Jest); las barreras se sueltan en `finally`; `cerrar`/`afirmar` deciden;
    // y la espera acortada del candado se instala y se restaura en una envoltura que comprueba la restauración DESPUÉS del
    // desenrollado, aunque `cerrar` lance (Codex R16-3).
    const R = `${Date.now()}`
    const solicitud = await f.solicitud()
    const A = randomUUID()
    const pagoB = await legacyB(R)
    const webhookService = await import('@/services/tpv/angelpay-webhook.service')
    const vencio = {
      estado: 'ASENTADA',
      ok: false,
      error: expect.objectContaining({ message: expect.stringMatching(/lock timeout|55P03|canceling statement/i) }),
    }
    /** OTRA transacción (ajena) sostiene el candado del intento A hasta que la prueba lo suelta. */
    const sostenerCandado = (Act: ReturnType<typeof actores>) => {
      const b = barrera()
      const ajena = Act.montaje(
        'candado ajeno del intento',
        prisma.$transaction(
          async tx => {
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(${NS_CANDADO_INTENTO}::int, hashtext(${A}))::text`
            b.pausado()
            await b.liberada
          },
          { timeout: 20_000 },
        ),
      )
      return { b, ajena }
    }
    /**
     * Codex R16-3: la espera acortada del candado se instala y se restaura en una ENVOLTURA cuya comprobación corre DESPUÉS del
     * desenrollado excepcional — también cuando `cerrar` lanza (INCONCLUSO): se compara con el valor PREVIO guardado (que no tiene por
     * qué ser `undefined`), y si no quedó restaurado la prueba cae nombrándolo y CONSERVANDO la causa original. Antes la aserción de
     * restauración vivía después del bloque que relanza: era inalcanzable tras un INCONCLUSO y no certificaba nada.
     */
    const conEsperaAcotada = async (ms: number, fase: () => Promise<void>) => {
      const previa = process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS
      const restaurar = () => {
        if (previa === undefined) delete process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS
        else process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS = previa
      }
      process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS = String(ms)
      let causa: { error: unknown } | null = null
      try {
        await fase()
      } catch (error) {
        causa = { error }
      } finally {
        restaurar()
      }
      const vigente = process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS
      if (vigente !== previa) {
        const original = causa ? ` — causa original: ${causa.error instanceof Error ? causa.error.message : String(causa.error)}` : ''
        throw new Error(
          `ENTORNO NO RESTAURADO — TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS quedó en ${JSON.stringify(vigente)} (antes: ${JSON.stringify(previa)})${original}`,
        )
      }
      if (causa) throw causa.error
    }

    // ── Fase 1: con el candado tomado, la publicación del vínculo y el escritor débil VENCEN sin escribir nada a medias.
    const A1 = actores()
    const { b, ajena } = sostenerCandado(A1)
    let fallo: Fallo = null
    let eventId = ''
    await conEsperaAcotada(300, async () => {
      try {
        expect(await b.pausadaEn(10_000)).toBe(true) // el montaje llegó a la barrera (acotado)
        const publicacion = A1.lanzar('publicación del vínculo', publicar(solicitud.requestId, A))
        expect(await A1.carrera(publicacion, 10_000)).toMatchObject(vencio)
        expect(await prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId: A } })).toBeNull()
        eventId = f.nuevoEventId()
        const escritorDebil = A1.lanzar(
          'webhook E (escritor débil)',
          processAngelPayWebhook({
            payload: f.eventoAngelPay(A, { transactionId: R }),
            eventId,
            merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
            retryDelaysMs: [0],
          }),
        )
        expect(await A1.carrera(escritorDebil, 10_000)).toMatchObject(vencio)
        // E conserva su estado durable (PENDING, sin decisión) y B no lleva huella: nada se escribió a medias. Codex R15-1: el
        // ingreso también venció, así que E entró por el fallback y quedó MARCADO (sin orden acreditado).
        expect(await evento(eventId)).toMatchObject({ status: 'PENDING', paymentId: null })
        expect(((await evento(eventId)).payload as Record<string, unknown>)._avoqado).toMatchObject({
          ingresoSinCandado: { en: expect.any(String) },
        })
        expect((await exigir(prisma.payment.findUnique({ where: { id: pagoB.id } }))).processorData).not.toHaveProperty('angelpayWebhook')
      } catch (error) {
        fallo = { error }
      } finally {
        await A1.liberar({ 'candado ajeno': () => b.soltar() })
      }
      await A1.cerrar(fallo)
      await A1.afirmar(async () => {
        await ajena.resultado()
      })
    })

    // Recuperación: la terminal repite el anuncio (entra), y el worker toma E y confirma A por el vínculo — con la incertidumbre
    // del ingreso sin candado conservada en el Payment (Codex R15-1) y E ordenado bajo el candado (`ordenadoEn`).
    expect(await publicar(solicitud.requestId, A)).toMatchObject({ success: true, outcome: 'LINKED' })
    await prisma.providerEventLog.updateMany({
      where: { attemptId: A, status: 'PENDING' },
      data: { nextAttemptAt: new Date(0), claimToken: null },
    })
    const claims = await claimPendingAngelPayEvents({ now: new Date(), limit: 25 })
    for (const c of claims) await runClaimedAngelPayEvent(c)
    const pagoA = await exigir(prisma.payment.findFirst({ where: { venueId: f.venueId, idempotencyKey: A } }))
    expect(pagoA.status).toBe('COMPLETED')
    expect(pagoA.processorData).toMatchObject({
      pricing: { capturaFallida: { total: expect.stringMatching(/EVIDENCIA_DE_INGRESO_SIN_ORDEN/) } },
    })
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pagoA.id, closedVia: 'webhook' })
    expect(((await evento(eventId)).payload as Record<string, unknown>)._avoqado).toMatchObject({
      ingresoSinCandado: { en: expect.any(String), ordenadoEn: expect.any(String) },
    })

    // ── Fase 2: el anuncio REPETIDO (ALREADY_LINKED: reapertura idempotente con transacción propia) también se serializa por el
    // intento: con el candado tomado por otra transacción, vence y no escribe; y la reapertura en sí (transacción propia) toma el
    // candado como PRIMERA sentencia: vence sin escribir. Libre, contesta ALREADY_LINKED / `reabiertos: 0`.
    const A2 = actores()
    const { b: b2, ajena: ajena2 } = sostenerCandado(A2)
    let fallo2: Fallo = null
    await conEsperaAcotada(300, async () => {
      try {
        expect(await b2.pausadaEn(10_000)).toBe(true)
        const repetido = A2.lanzar('anuncio repetido', publicar(solicitud.requestId, A))
        expect(await A2.carrera(repetido, 10_000)).toMatchObject(vencio)
        const reapertura = A2.lanzar('reapertura idempotente', webhookService.recuperarEventosDebilesPorVinculo(A, solicitud.requestId))
        expect(await A2.carrera(reapertura, 10_000)).toMatchObject(vencio)
      } catch (error) {
        fallo2 = { error }
      } finally {
        await A2.liberar({ 'candado ajeno': () => b2.soltar() })
      }
      await A2.cerrar(fallo2)
      await A2.afirmar(async () => {
        await ajena2.resultado()
      })
    })
    // La espera del candado quedó como estaba (lo comprueba la envoltura tras cada fase, también cuando `cerrar` lanza).
    expect(process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS).toBeUndefined()
    expect(await publicar(solicitud.requestId, A)).toMatchObject({ success: true, outcome: 'ALREADY_LINKED' })
    expect(await webhookService.recuperarEventosDebilesPorVinculo(A, solicitud.requestId)).toEqual({ reabiertos: 0 })
  })

  it('dos reaperturas de intentos DISTINTOS con Payments compartidos en orden inverso (A1 sobre B1 y B2; A2 sobre B2 y B1) corren a la vez sin interbloqueo: los cuatro eventos se reabren y cada Payment revoca EXACTAMENTE el sello vigente (R5 P2: por identidad — el otro evento reabre sin tocar una huella que ya no es suya)', async () => {
    const R1 = `${Date.now()}`
    const R2 = `${Date.now() + 1}`
    const B1 = await legacyB(R1)
    const B2 = await legacyB(R2)
    const A1 = randomUUID()
    const A2 = randomUUID()
    const q1 = await f.solicitud()
    const { eventId: e1a } = await webhook(A1, { transactionId: R1 })
    const { eventId: e1b } = await webhook(A1, { transactionId: R2 })
    const { eventId: e2a } = await webhook(A2, { transactionId: R2 })
    const { eventId: e2b } = await webhook(A2, { transactionId: R1 })
    for (const e of [e1a, e1b, e2a, e2b]) expect(await evento(e)).toMatchObject({ status: 'PROCESSED' })
    // Dos solicitudes en vuelo de la misma terminal violan el índice: la segunda va sobre otra terminal del mismo venue.
    const otraTerminal = `AVQD-N86${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
    await prisma.terminal.create({ data: { venueId: f.venueId, name: 'N86 dos', serialNumber: otraTerminal, type: 'TPV_ANDROID' } })
    const q2 = await f.solicitud({ terminalId: jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(otraTerminal) })

    const [ack1, ack2] = await Promise.all([
      publicar(q1.requestId, A1),
      terminalPaymentService.handleAttemptOpenedFromSocket(
        { requestId: q2.requestId, attemptId: A2 },
        { socketId: 's2', terminalId: otraTerminal, venueId: f.venueId },
      ),
    ])
    expect(ack1).toMatchObject({ success: true, outcome: 'LINKED' })
    expect(ack2).toMatchObject({ success: true, outcome: 'LINKED' })
    for (const e of [e1a, e1b, e2a, e2b])
      expect(await evento(e)).toMatchObject({ status: 'PENDING', errorReason: 'LINK_ARRIVED_AFTER_WEAK_MATCH', paymentId: null })
    for (const id of [B1.id, B2.id]) {
      const datos = (await exigir(prisma.payment.findUnique({ where: { id } }))).processorData as Record<string, any>
      // Un Payment lleva UN solo sello vigente (`angelpayWebhook`): el segundo sello débil pisó al primero. Al reabrir, sólo el
      // evento cuyo sello sigue vigente lo revoca; el otro reabre su evento sin tocar una huella que ya no es suya.
      expect(datos).not.toHaveProperty('angelpayWebhook')
      expect(datos.angelpayWebhookRevocations).toHaveLength(1)
      const [revocacion] = datos.angelpayWebhookRevocations
      expect([A1, A2]).toContain(revocacion.attemptId)
      expect(revocacion.previous.eventId).toBe(revocacion.eventId)
      expect(datos.angelpayWebhookRevoked).toMatchObject({ eventId: revocacion.eventId, attemptId: revocacion.attemptId })
    }
    await prisma.terminal.deleteMany({ where: { serialNumber: otraTerminal } })
  })
})

describe('Codex R12 (pasada exhaustiva) · R12-12: el backfill del REST sólo sella un evento approved con importe entero en centavos — nunca certifica un importe ilegible ni un rechazo bancario', () => {
  const huella = async (paymentId: string) =>
    ((await exigir(prisma.payment.findUnique({ where: { id: paymentId } }))).processorData as Record<string, unknown>).angelpayWebhook
  /** Un evento PENDING que el receptor dejó atrás (corte antes de clasificar), correlacionable con el REST por la llave del intento. */
  const pendienteDejadoAtras = async (attemptId: string, over: Record<string, unknown>, fila: Record<string, unknown> = {}) => {
    const eventId = `${f.fixture}-${randomUUID()}`
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        eventId: `angelpay-${eventId}`,
        type: 'send_transaction',
        payload: { ...f.eventoAngelPay(attemptId, over), _avoqado: { receivedByMerchantAccountId: f.merchantId } } as never,
        status: 'PENDING',
        attemptId,
        venueId: f.venueId,
        nextAttemptAt: new Date(Date.now() + 60_000),
        ...fila,
      } as never,
    })
    return eventId
  }
  /** El REST de la terminal registra el cargo de $100 con la llave del intento y corre su backfill hasta el final. */
  const restConBackfill = async (attemptId: string, R: string) => {
    const pago = await recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId, ref: R }), f.staffId)
    expect(pago.status).toBe('COMPLETED')
    await backfillAcreditado(pago.id)
    return pago
  }

  it.each([
    ['ilegible', 'abc'],
    ['no entero en centavos', '100.5'],
    ['vacío', ''],
  ])(
    'importe %s (`amount: %p`): el evento NO se sella (queda PENDING, con motivo INVALID_AMOUNT, sin Payment) y el cargo no lleva la huella',
    async (_n, amount) => {
      const R = `${Date.now()}`
      const A = randomUUID()
      const eventId = await pendienteDejadoAtras(A, { transactionId: R, amount })
      const pago = await restConBackfill(A, R)
      expect(await evento(eventId)).toMatchObject({ status: 'PENDING', errorReason: 'INVALID_AMOUNT', paymentId: null })
      expect(await huella(pago.id)).toBeUndefined()
    },
  )

  it.each([
    ['un número (123)', 123],
    ['un objeto ({})', {}],
    ['una cadena vacía ("")', ''],
    ['sólo espacios ("   ")', '   '],
    // Codex R14-3: `null` PRESENTE no es la excepción de ausencia.
    ['null presente ({"status": null})', null],
  ])(
    'Codex R13-4 · estado bancario PRESENTE pero ILEGIBLE — %s — con importe correcto e identidad coincidente: el evento NO se sella — queda PENDING con motivo INVALID_STATUS, sin Payment asociado y sin huella (no hay aprobación demostrada)',
    async (_n, status) => {
      const R = `${Date.now()}`
      const A = randomUUID()
      const eventId = await pendienteDejadoAtras(A, { transactionId: R, status })
      const pago = await restConBackfill(A, R)
      expect(await evento(eventId)).toMatchObject({ status: 'PENDING', errorReason: 'INVALID_STATUS', paymentId: null })
      expect(await huella(pago.id)).toBeUndefined()
      expect(pago.status).toBe('COMPLETED')
    },
  )

  it('Codex R13-4 · CONTROL legacy: un evento SIN estado (campo ausente, compatibilidad documentada) con importe correcto sí se sella PROCESSED', async () => {
    const R = `${Date.now()}`
    const A = randomUUID()
    const eventId = await pendienteDejadoAtras(A, { transactionId: R, status: undefined })
    const pago = await restConBackfill(A, R)
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pago.id })
    expect(await huella(pago.id)).toMatchObject({ reconciledVia: 'payment-create-backfill', integratorReference: A })
  })

  it('declined que quedó PENDING por un corte antes del filtro: el backfill lo cierra como ERROR/NOT_APPROVED — nunca MATCHED, nunca huella', async () => {
    const R = `${Date.now()}`
    const A = randomUUID()
    const eventId = await pendienteDejadoAtras(A, { transactionId: R, status: 'declined' })
    const pago = await restConBackfill(A, R)
    expect(await evento(eventId)).toMatchObject({ status: 'ERROR', errorReason: 'NOT_APPROVED', paymentId: null })
    expect(await huella(pago.id)).toBeUndefined()
    expect(pago.status).toBe('COMPLETED')
  })

  it('un evento de OTRO tipo (no `send_transaction`) con la misma llave tampoco se sella', async () => {
    const R = `${Date.now()}`
    const A = randomUUID()
    const eventId = `${f.fixture}-${randomUUID()}`
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        eventId: `angelpay-${eventId}`,
        type: 'refund_transaction',
        payload: { ...f.eventoAngelPay(A, { transactionId: R }), event_type: 'refund_transaction' } as never,
        status: 'PENDING',
        attemptId: A,
        venueId: f.venueId,
        nextAttemptAt: new Date(Date.now() + 60_000),
      },
    })
    const pago = await restConBackfill(A, R)
    expect(await evento(eventId)).toMatchObject({ status: 'PENDING', paymentId: null })
    expect(await huella(pago.id)).toBeUndefined()
  })

  it('CONTROL: approved con el importe correcto (10000 centavos) se sella PROCESSED con la huella', async () => {
    const R = `${Date.now()}`
    const A = randomUUID()
    const eventId = await pendienteDejadoAtras(A, { transactionId: R })
    const pago = await restConBackfill(A, R)
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pago.id })
    expect(await huella(pago.id)).toMatchObject({ reconciledVia: 'payment-create-backfill', integratorReference: A })
  })

  it('Codex R13 (cobertura) · el sello del backfill es un PARCHE atómico: con una copia OBSOLETA del Payment en mano (costPending: true, snapshot viejo), otro escritor ya convergió (costPending: false) y cambió el snapshot — el sello añade la huella y NO repone la marca ni pisa el snapshot', async () => {
    const R = `${Date.now()}`
    const A = randomUUID()
    // El evento queda RESERVADO por otro dueño (lease vigente) mientras el REST registra: el backfill fire-and-forget del
    // registrador —que se DRENA aquí— no puede reclamarlo, así que el ÚNICO sello es el explícito de abajo, con la copia obsoleta.
    // (Antes el sello del registrador competía con el explícito y, según quién ganara, la prueba dejaba de observar el parche.)
    const eventId = await pendienteDejadoAtras(
      A,
      { transactionId: R },
      { leaseUntil: new Date(Date.now() + 60_000), claimToken: randomUUID() },
    )
    const pago = await registroConBackfillDrenado(f.registroDeLaTerminal({ attemptId: A, ref: R }))
    expect(await evento(eventId)).toMatchObject({ status: 'PENDING', paymentId: null })
    await prisma.providerEventLog.updateMany({ where: { eventId: `angelpay-${eventId}` }, data: { leaseUntil: null, claimToken: null } })
    // La copia con la que el backfill entra (leída ANTES de que otro escritor toque la columna).
    const copiaObsoleta = await exigir(prisma.payment.findUnique({ where: { id: pago.id } }))
    expect(copiaObsoleta.processorData).toMatchObject({ costPending: true })
    // Otro escritor (la convergencia, una acreditación) cambia la marca y el snapshot por debajo.
    const snapshotNuevo = {
      slot: 'PRIMARY',
      frozenAt: new Date().toISOString(),
      merchantAccountId: f.merchantId,
      venue: null,
      provider: null,
      marca: 'nuevo',
    }
    await prisma.$executeRaw`UPDATE "Payment" SET "processorData" = "processorData" || ${JSON.stringify({ costPending: false, pricing: snapshotNuevo })}::jsonb WHERE "id" = ${pago.id}`
    await reconcileAngelPayWebhookForPayment(copiaObsoleta)
    expect(await evento(eventId)).toMatchObject({ status: 'PROCESSED', paymentId: pago.id })
    const despues = (await exigir(prisma.payment.findUnique({ where: { id: pago.id } }))).processorData as Record<string, unknown>
    expect(despues.angelpayWebhook).toMatchObject({ reconciledVia: 'payment-create-backfill', integratorReference: A })
    expect(despues.costPending).toBe(false)
    expect(despues.pricing).toEqual(snapshotNuevo)
  })
})
