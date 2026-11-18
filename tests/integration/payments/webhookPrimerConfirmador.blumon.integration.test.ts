/**
 * SDK propio, fase 1 (Tarea 5): el aviso APROBADO de Blumon crea el cobro por el vínculo S1, con la MISMA regla que AngelPay
 * (`confirmarAvisoPorVinculo`). Sólo con todo a la vez: `VENTA`, `codeResponse === '00'`, `reference` = un intento con vínculo,
 * UNA afiliación con ese serial y configurada en el venue del vínculo, serial que no contradice la terminal del vínculo e
 * importe = base + propina exacto. Lo demás sigue por el emparejamiento de hoy.
 * Tarea 6: la red de 30 s respeta el turno del receptor (`nextAttemptAt`) y recupera con el contexto guardado AL INGRESO.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  confirmarBlumonPorVinculo,
  contextoGuardado,
  processBlumonPaymentWebhook,
  reconcileBlumonEvent,
} from '@/services/tpv/blumon-webhook.service'
import * as registrador from '@/services/tpv/payment.tpv.service'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { blumonPaymentAuditJob } from '@/jobs/blumon-payment-audit.job'
import { blumonWebhookReconciliationJob as red } from '@/jobs/blumon-webhook-reconciliation.job'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { NS_CANDADO_INTENTO } from '@/services/tpv/candadoDeIntento'
import { crearFixture, exigir, exigirBaseDesechable, type Fixture } from './webhookCheckpoint.fixture'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

// Sin vínculo, el emparejamiento de hoy reintenta en línea ~5 s antes de dejar el evento PENDING.
jest.setTimeout(60_000)

let f: Fixture

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('bl5')
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(() => f.limpiar())
afterAll(() => f.destruir())

type Aviso = ReturnType<Fixture['eventoBlumon']>
const aviso = (payload: Aviso) => processBlumonPaymentWebhook(payload as Parameters<typeof processBlumonPaymentWebhook>[0])
const pagos = () => prisma.payment.findMany({ where: { venueId: f.venueId } })
const fila = (requestId: string) => exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))
const eventoDe = (id: string | undefined) => exigir(prisma.providerEventLog.findUnique({ where: { id: id ?? '' } }))
const avoqadoDe = (ev: { payload: unknown }) => (ev.payload as Record<string, any>)._avoqado as Record<string, any> | undefined
const bitacora = (action: string) => (logAction as jest.Mock).mock.calls.filter(([p]) => p?.action === action)

/** La terminal (la del fixture, salvo otra) anuncia el intento (S1) por su socket autenticado. */
async function vincular(requestId: string, attemptId = randomUUID()) {
  const ack = await terminalPaymentService.handleAttemptOpenedFromSocket(
    { requestId, attemptId },
    { socketId: 's', terminalId: f.serial, venueId: f.venueId },
  )
  expect(ack.success).toBe(true)
  return attemptId
}
/** Solicitud en vuelo de la terminal del fixture + su intento vinculado. */
async function intentoVinculado(over: Record<string, unknown> = {}) {
  const solicitud = await f.solicitud(over)
  return { requestId: solicitud.requestId, attemptId: await vincular(solicitud.requestId) }
}
/** El REST de la terminal Blumon (importes en centavos), por la afiliación dada. */
const restBlumon = (
  merchantAccountId: string,
  intento: Parameters<Fixture['registroDeLaTerminal']>[0],
  extra: Record<string, unknown> = {},
) => registrador.recordFastPayment(f.venueId, { ...f.registroDeLaTerminal(intento), merchantAccountId, ...extra }, f.staffId)

describe('el aviso de Blumon crea el cobro por vínculo', () => {
  it('aprobado + vínculo + importe exacto ⇒ CONFIRMED: un Payment registradoVia webhook, provisional y con costo pendiente', async () => {
    const { merchantAccountId } = await f.conAfiliacionBlumon()
    const { requestId, attemptId } = await intentoVinculado()
    const payload = f.eventoBlumon(attemptId)

    const r = await aviso(payload)

    expect(r).toMatchObject({ action: 'CONFIRMED', paymentId: expect.any(String), eventLogId: expect.any(String) })
    const todos = await pagos()
    expect(todos).toHaveLength(1)
    const [pago] = todos
    expect(pago).toMatchObject({
      id: r.paymentId,
      status: 'COMPLETED',
      idempotencyKey: attemptId,
      merchantAccountId,
      terminalPaymentRequestId: requestId,
      referenceNumber: attemptId,
      authorizationNumber: payload.authorizationCode,
      cardBrand: 'VISA',
    })
    const pd = pago.processorData as Record<string, any>
    expect(pd).toMatchObject({
      registradoVia: 'webhook',
      methodProvisional: true,
      costPending: true,
      blumonOperationNumber: payload.operationNumber,
      blumonWebhookReceived: true,
    })
    expect(pd.blumonWebhook).toMatchObject({
      firstConfirmer: true,
      receivedAt: expect.any(String),
      eventId: `blumon-tpv-${payload.operationNumber}-${attemptId}`,
      operationNumber: payload.operationNumber,
      reference: attemptId,
      serialNumber: f.serialCrudo,
    })
    expect(await fila(requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id, closedVia: 'webhook' })
    const ev = await eventoDe(r.eventLogId)
    expect(ev).toMatchObject({ status: 'PROCESSED', attemptId, paymentId: pago.id, venueId: f.venueId })
    expect(ev.payload).not.toHaveProperty('cardHolder')
    expect(avoqadoDe(ev)).toMatchObject({
      receivedByMerchantAccountId: merchantAccountId,
      contextoDelIngreso: {
        attemptId,
        requestId,
        linkVenueId: f.venueId,
        linkTerminalId: f.llaveTerminal,
        merchantAccountId,
        receiverVenueId: f.venueId,
        terminalSerialEfectivo: f.serialCrudo,
      },
      tarifaCongeladaAlIngreso: expect.any(Object),
    })
  })

  it('el auditor de cobros sin aviso no denuncia un cobro nacido del aviso (Codex r5); un cobro real sin aviso sí', async () => {
    const { merchantAccountId } = await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()
    const r = await aviso(f.eventoBlumon(attemptId))
    expect(r.action).toBe('CONFIRMED')
    const sinAviso = await restBlumon(merchantAccountId, { attemptId: randomUUID() })
    // H9: los relojes falsos no mueven el `now()` de SQL — se retrasa el cobro en la base para que entre en la ventana.
    await prisma.$executeRaw`UPDATE "Payment" SET "createdAt" = "createdAt" - interval '35 minutes' WHERE "venueId" = ${f.venueId}`

    await blumonPaymentAuditJob.runOnce()

    const delAviso = await exigir(prisma.payment.findUnique({ where: { id: r.paymentId! } }))
    expect((delAviso.processorData as Record<string, unknown>).blumonWebhookReceived).toBe(true)
    expect(delAviso.processorData).not.toHaveProperty('webhookAuditAlertedAt')
    const denunciado = await exigir(prisma.payment.findUnique({ where: { id: sinAviso.id } }))
    expect(denunciado.processorData).toHaveProperty('webhookAuditAlertedAt')
  })

  it('la tarifa del cobro nacido del aviso es la congelada al ingreso', async () => {
    const { merchantAccountId } = await f.conAfiliacionBlumon()
    await f.conTarifas({ secundaria: { merchantAccountId } })
    // La tarifa cambia ENTRE el ingreso y el registro: el cobro conserva la del ingreso (2.5 %), nunca la de «ahora» (8 %).
    const real = registrador.recordFastPayment
    const espia = jest.spyOn(registrador, 'recordFastPayment').mockImplementationOnce(async (...args) => {
      await prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId, accountType: 'SECONDARY' }, data: { creditRate: 0.08 } })
      return real(...args)
    })
    try {
      const { attemptId } = await intentoVinculado()

      const r = await aviso(f.eventoBlumon(attemptId))

      expect(r.action).toBe('CONFIRMED')
      const pago = await exigir(prisma.payment.findUnique({ where: { id: r.paymentId! } }))
      const pricing = (pago.processorData as Record<string, any>).pricing
      expect(pricing).toMatchObject({ merchantAccountId, slot: 'SECONDARY', venue: { creditRate: '0.025' } })
      expect(pricing.capturaFallida).toBeUndefined()
      expect(JSON.stringify(pricing)).not.toContain('EVIDENCIA_DE_INGRESO_NO_VISIBLE')
      expect(avoqadoDe(await eventoDe(r.eventLogId))?.tarifaCongeladaAlIngreso?.pricing).toMatchObject({ venue: { creditRate: '0.025' } })
    } finally {
      espia.mockRestore()
      await f.sinTarifas()
    }
  })

  it('ingreso sin candado (55P03) conserva la marca y la tarifa queda sin acreditar', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()
    // OTRA transacción retiene el candado del intento: el ingreso vence (300 ms) y entra por el fallback, MARCADO.
    let liberar!: () => void
    let tomado!: () => void
    const liberada = new Promise<void>(res => (liberar = res))
    const yaTomado = new Promise<void>(res => (tomado = res))
    const ajena = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(${NS_CANDADO_INTENTO}::int, hashtext(${attemptId}))::text`
        tomado()
        await liberada
      },
      { timeout: 20_000 },
    )
    const previa = process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS
    process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS = '300'
    let r: Awaited<ReturnType<typeof aviso>>
    try {
      await yaTomado
      r = await aviso(f.eventoBlumon(attemptId))
    } finally {
      liberar()
      await ajena
      if (previa === undefined) delete process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS
      else process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS = previa
    }

    // El registrador también esperó ese candado: sin Payment, el evento queda PENDING para la recuperación.
    expect(r).toMatchObject({ action: 'ERROR', errorReason: 'PROCESSING_ERROR' })
    expect(await pagos()).toHaveLength(0)
    const ev = await eventoDe(r.eventLogId)
    expect(ev).toMatchObject({ status: 'PENDING', paymentId: null, attemptId })
    expect(avoqadoDe(ev)?.ingresoSinCandado).toEqual({ en: expect.any(String) })

    // Ya sin el candado ajeno, la recuperación con el contexto GUARDADO crea el cobro, sin acreditar la tarifa.
    const ctx = contextoGuardado(ev.payload)
    expect(ctx).toMatchObject({ attemptId })
    const r2 = await confirmarBlumonPorVinculo({ payload: ev.payload as any, eventLogId: ev.id, ctx: ctx! })
    expect(r2).toMatchObject({ action: 'CONFIRMED' })
    const pago = await exigir(prisma.payment.findUnique({ where: { id: r2!.paymentId! } }))
    expect((pago.processorData as Record<string, any>).pricing).toMatchObject({
      capturaFallida: { total: expect.stringMatching(/EVIDENCIA_DE_INGRESO_SIN_ORDEN/) },
    })
  })

  it('el REST de la terminal completa el mismo Payment: método real, sin provisional, AMEX vs AMERICAN_EXPRESS sin contradicción', async () => {
    const { merchantAccountId } = await f.conAfiliacionBlumon()
    const { requestId, attemptId } = await intentoVinculado()
    const payload = f.eventoBlumon(attemptId, { brand: 'AMEX', cardType: 'AMEX' })
    const r = await aviso(payload)
    expect(r.action).toBe('CONFIRMED')
    expect((await exigir(prisma.payment.findUnique({ where: { id: r.paymentId! } }))).cardBrand).toBe('AMERICAN_EXPRESS')

    const rest = await restBlumon(
      merchantAccountId,
      {
        attemptId,
        requestId,
        ref: attemptId,
        auth: payload.authorizationCode,
        tarjeta: { cardBrand: 'AMERICAN_EXPRESS', maskedPan: '371449******8431', entryMode: 'CHIP' },
      },
      { method: 'DEBIT_CARD' },
    )

    expect(rest.id).toBe(r.paymentId)
    expect(bitacora('TERMINAL_PAYMENT_ENRICHMENT_CONTRADICTION')).toEqual([])
    expect(await pagos()).toHaveLength(1)
    const pago = await exigir(prisma.payment.findUnique({ where: { id: rest.id } }))
    expect(pago).toMatchObject({ status: 'COMPLETED', method: 'DEBIT_CARD', cardBrand: 'AMERICAN_EXPRESS', maskedPan: '371449******8431' })
    expect((pago.processorData as Record<string, unknown>).methodProvisional).toBe(false)
  })

  it('aviso + reenvío del mismo aviso + REST en paralelo ⇒ un solo Payment', async () => {
    const { merchantAccountId } = await f.conAfiliacionBlumon()
    const { requestId, attemptId } = await intentoVinculado()
    const payload = f.eventoBlumon(attemptId)

    const [a, b] = await Promise.all([
      aviso(payload),
      aviso(payload),
      restBlumon(merchantAccountId, { attemptId, requestId, ref: attemptId, auth: payload.authorizationCode }),
    ])

    expect(await prisma.payment.count({ where: { venueId: f.venueId, idempotencyKey: attemptId } })).toBe(1)
    expect([a.action, b.action]).toContain('DUPLICATE')
    expect(['CONFIRMED', 'MATCHED', 'DUPLICATE']).toEqual(expect.arrayContaining([a.action, b.action]))
    expect(await prisma.providerEventLog.count({ where: { attemptId } })).toBe(1)
  })

  it('importe distinto (base + propina) ⇒ PENDING/AMOUNT_MISMATCH sin Payment', async () => {
    await f.conAfiliacionBlumon()
    const { requestId, attemptId } = await intentoVinculado({ tipCents: 500 })

    const r = await aviso(f.eventoBlumon(attemptId))

    expect(r).toMatchObject({ action: 'PENDING', errorReason: 'AMOUNT_MISMATCH' })
    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'PENDING', errorReason: 'AMOUNT_MISMATCH', attemptId, paymentId: null })
    expect(await fila(requestId)).toMatchObject({ status: 'SENT', paymentId: null })
  })

  it.each(['100.5x', '1,000.00', '100.505', 100])('importe ilegible %p ⇒ AMOUNT_MISMATCH sin Payment', async amount => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()

    const r = await aviso(f.eventoBlumon(attemptId, { amount }))

    expect(r).toMatchObject({ action: 'PENDING', errorReason: 'AMOUNT_MISMATCH' })
    expect(await pagos()).toHaveLength(0)
  })

  it.each([
    ['codeResponse ausente', { codeResponse: undefined }],
    ['operationType ausente', { operationType: undefined }],
  ])('%s ⇒ no crea (emparejamiento de hoy) y el evento no lleva attemptId', async (_caso, over) => {
    await f.conAfiliacionBlumon()
    const { requestId, attemptId } = await intentoVinculado()

    const r = await aviso(f.eventoBlumon(attemptId, over))

    expect(r.action).toBe('NOT_FOUND')
    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'PENDING', attemptId: null })
    expect(await fila(requestId)).toMatchObject({ status: 'SENT', paymentId: null })
  })

  it('reference sin vínculo (timestamp de la TPV de hoy) ⇒ no crea; evento con attemptId null', async () => {
    await f.conAfiliacionBlumon()
    await intentoVinculado()

    const r = await aviso(f.eventoBlumon(undefined))

    expect(r.action).toBe('NOT_FOUND')
    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'PENDING', attemptId: null })
  })

  it('reference recortada a 20 caracteres ⇒ no crea', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()

    const r = await aviso(f.eventoBlumon(attemptId, { reference: attemptId.slice(0, 20) }))

    expect(r.action).toBe('NOT_FOUND')
    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(r.eventLogId)).toMatchObject({ attemptId: null })
  })

  it('serial virtual (sin Terminal) asignado a la terminal del vínculo ⇒ CONFIRMED con la afiliación virtual', async () => {
    const virtual = `${f.serialCrudo}2`
    const { merchantAccountId } = await f.conAfiliacionBlumon({ serial: virtual })
    const { attemptId } = await intentoVinculado()

    const r = await aviso(f.eventoBlumon(attemptId, { serialNumber: virtual }))

    expect(r.action).toBe('CONFIRMED')
    expect(await exigir(prisma.payment.findUnique({ where: { id: r.paymentId! } }))).toMatchObject({ merchantAccountId })
    expect(avoqadoDe(await eventoDe(r.eventLogId))?.contextoDelIngreso).toMatchObject({ terminalSerialEfectivo: f.llaveTerminal })
  })

  it('serial físico de OTRA terminal con la misma afiliación asignada a las dos ⇒ LINK_TERMINAL_MISMATCH sin Payment', async () => {
    const otra = await f.otraTerminal()
    await f.conAfiliacionBlumon({ serial: otra.serialCrudo, asignadaA: [f.serial, otra.serial] })
    const { requestId, attemptId } = await intentoVinculado()

    const r = await aviso(f.eventoBlumon(attemptId, { serialNumber: otra.serialCrudo }))

    expect(r).toMatchObject({ action: 'ERROR', errorReason: 'LINK_TERMINAL_MISMATCH' })
    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'ERROR', errorReason: 'LINK_TERMINAL_MISMATCH', attemptId })
    expect(await fila(requestId)).toMatchObject({ status: 'SENT', paymentId: null })
  })

  it('F12: serial físico de OTRA terminal escrito en minúsculas (y así su afiliación) ⇒ la reconoce igual: LINK_TERMINAL_MISMATCH sin Payment', async () => {
    const otra = await f.otraTerminal()
    const minusculas = otra.serialCrudo.toLowerCase()
    await f.conAfiliacionBlumon({ serial: minusculas, asignadaA: [f.serial, otra.serial] })
    const { requestId, attemptId } = await intentoVinculado()

    const r = await aviso(f.eventoBlumon(attemptId, { serialNumber: minusculas }))

    expect(r).toMatchObject({ action: 'ERROR', errorReason: 'LINK_TERMINAL_MISMATCH' })
    expect(await pagos()).toHaveLength(0)
    expect(await fila(requestId)).toMatchObject({ status: 'SENT', paymentId: null })
  })

  it('F7: marca que el servidor no conoce (CARNET) ⇒ el aviso crea el cobro igual, con marca OTHER', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()

    const r = await aviso(f.eventoBlumon(attemptId, { brand: 'CARNET' }))

    expect(r).toMatchObject({ action: 'CONFIRMED', paymentId: expect.any(String) })
    expect(await pagos()).toEqual([expect.objectContaining({ id: r.paymentId, cardBrand: 'OTHER', status: 'COMPLETED' })])
  })

  it.each([
    ['105.00', 10000, 500],
    ['100.5', 10050, 0],
  ])('F11: importe %p con base %p y propina %p ⇒ CONFIRMED con ese importe exacto', async (amount, amountCents, tipCents) => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado({ amountCents, tipCents })

    const r = await aviso(f.eventoBlumon(attemptId, { amount }))

    expect(r).toMatchObject({ action: 'CONFIRMED', paymentId: expect.any(String) })
    const [pago] = await pagos()
    expect({ amount: Number(pago.amount), tip: Number(pago.tipAmount) }).toEqual({ amount: amountCents / 100, tip: tipCents / 100 })
  })

  it('serial virtual (sin Terminal) asignado sólo a OTRA terminal del venue ⇒ LINK_TERMINAL_MISMATCH sin Payment', async () => {
    const otra = await f.otraTerminal()
    const virtual = `${otra.serialCrudo}2`
    await f.conAfiliacionBlumon({ serial: virtual, asignadaA: [otra.serial] })
    const { requestId, attemptId } = await intentoVinculado()

    const r = await aviso(f.eventoBlumon(attemptId, { serialNumber: virtual }))

    expect(r).toMatchObject({ action: 'ERROR', errorReason: 'LINK_TERMINAL_MISMATCH' })
    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'ERROR', errorReason: 'LINK_TERMINAL_MISMATCH', attemptId })
    expect(await fila(requestId)).toMatchObject({ status: 'SENT', paymentId: null })
  })

  it('afiliación fuera de la configuración del venue del vínculo ⇒ LINK_VENUE_MISMATCH sin Payment', async () => {
    await f.conAfiliacionBlumon({ enConfiguracion: false })
    const { attemptId } = await intentoVinculado()

    const r = await aviso(f.eventoBlumon(attemptId))

    expect(r).toMatchObject({ action: 'ERROR', errorReason: 'LINK_VENUE_MISMATCH' })
    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'ERROR', errorReason: 'LINK_VENUE_MISMATCH' })
  })

  it('dos MerchantAccount con el mismo serial ⇒ no crea (emparejamiento de hoy)', async () => {
    await f.conAfiliacionBlumon()
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()

    const r = await aviso(f.eventoBlumon(attemptId))

    expect(r.action).toBe('NOT_FOUND')
    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'PENDING', attemptId: null })
  })

  it('cobro LOCAL (sin solicitud ni vínculo) ⇒ no crea; queda PENDING hasta el REST', async () => {
    await f.conAfiliacionBlumon()

    const r = await aviso(f.eventoBlumon(randomUUID()))

    expect(r.action).toBe('NOT_FOUND')
    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'PENDING', attemptId: null })
  })

  // ─── regresión: lo de hoy no se mueve ───
  it('sin vínculo, un REST previo con operationNumber sigue emparejando como hoy (MATCHED)', async () => {
    const { merchantAccountId } = await f.conAfiliacionBlumon()
    const payload = f.eventoBlumon(undefined)
    const rest = await restBlumon(merchantAccountId, { attemptId: randomUUID() }, { blumonOperationNumber: payload.operationNumber })

    const r = await aviso(payload)

    expect(r).toMatchObject({ action: 'MATCHED', paymentId: rest.id })
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'PROCESSED', paymentId: rest.id, attemptId: null })
  })

  it('DEVOLUCION sigue en PROCESSED/REVERSAL_UNMATCHED', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()

    const r = await aviso(f.eventoBlumon(attemptId, { operationType: 'DEVOLUCION' }))

    expect(r.action).toBe('REVERSAL_RECEIVED')
    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'PROCESSED', errorReason: 'REVERSAL_UNMATCHED', attemptId: null })
  })
})

// ─── Tarea 6: la red de 30 s respeta la exclusiva y recupera con la identidad del INGRESO ───
describe('la red de 30 s (hallazgo 7)', () => {
  /** Mueve el turno del evento al pasado: ya le toca a la red. */
  const tocaYa = (id: string) => prisma.providerEventLog.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
  /**
   * El aviso entra con su contexto y el registrador se cae UNA vez (como si el proceso muriera tras el ingreso durable): el
   * evento queda PENDING con su contexto, su tarifa congelada y su turno (`nextAttemptAt`) 60 s adelante.
   */
  async function ingresoYCaida(payload: Aviso) {
    const espia = jest.spyOn(registrador, 'recordFastPayment').mockRejectedValueOnce(new Error('caída simulada'))
    try {
      const r = await aviso(payload)
      expect(r.action).toBe('ERROR')
      expect(await pagos()).toHaveLength(0)
      const ev = await eventoDe(r.eventLogId)
      expect(ev).toMatchObject({ status: 'PENDING', paymentId: null })
      expect(contextoGuardado(ev.payload)).not.toBeNull()
      return ev
    } finally {
      espia.mockRestore()
    }
  }

  it('la red no toca un evento PENDING antes de su nextAttemptAt; ya en su turno, lo recupera por el vínculo', async () => {
    await f.conAfiliacionBlumon()
    const { requestId, attemptId } = await intentoVinculado()
    const ev = await ingresoYCaida(f.eventoBlumon(attemptId))
    expect(ev.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now())

    await red.reconcilePending()

    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(ev.id)).toMatchObject({ status: 'PENDING', paymentId: null, errorReason: 'PROCESSING_ERROR' })

    await tocaYa(ev.id)
    await red.reconcilePending()

    const todos = await pagos()
    expect(todos).toHaveLength(1)
    expect(todos[0]).toMatchObject({ idempotencyKey: attemptId, terminalPaymentRequestId: requestId })
    expect(await eventoDe(ev.id)).toMatchObject({ status: 'PROCESSED', paymentId: todos[0].id })
  })

  it('ingreso → caída → cambio de configuración → recuperación: CONFIRMED con la afiliación y la tarifa del ingreso', async () => {
    // Serial virtual: al ingreso vale por la terminal del vínculo porque ESA terminal tiene la afiliación. Recalcularlo después
    // (sin la asignación ni la configuración) daría LINK_TERMINAL_MISMATCH / LINK_VENUE_MISMATCH.
    const virtual = `${f.serialCrudo}2`
    const { merchantAccountId } = await f.conAfiliacionBlumon({ serial: virtual })
    await f.conTarifas({ secundaria: { merchantAccountId } })
    try {
      const { requestId, attemptId } = await intentoVinculado()
      const ev = await ingresoYCaida(f.eventoBlumon(attemptId, { serialNumber: virtual }))
      expect(avoqadoDe(ev)?.contextoDelIngreso).toMatchObject({
        merchantAccountId,
        receiverVenueId: f.venueId,
        terminalSerialEfectivo: f.llaveTerminal,
      })

      // Después de la caída: la afiliación sale de la configuración y de la terminal, y las tarifas cambian.
      await f.quitarDeLaConfiguracion(merchantAccountId)
      const terminal = await exigir(prisma.terminal.findUnique({ where: { serialNumber: f.serial } }))
      await prisma.terminal.update({
        where: { serialNumber: f.serial },
        data: { assignedMerchantIds: { set: terminal.assignedMerchantIds.filter(id => id !== merchantAccountId) } },
      })
      await prisma.venuePricingStructure.updateMany({ where: { venueId: f.venueId }, data: { creditRate: 0.08 } })
      await tocaYa(ev.id)

      await red.reconcilePending()

      const todos = await pagos()
      expect(todos).toHaveLength(1)
      const [pago] = todos
      expect(pago).toMatchObject({ merchantAccountId, idempotencyKey: attemptId, terminalPaymentRequestId: requestId, status: 'COMPLETED' })
      expect((pago.processorData as Record<string, any>).pricing).toMatchObject({
        merchantAccountId,
        slot: 'SECONDARY',
        venue: { creditRate: '0.025' },
      })
      expect(await eventoDe(ev.id)).toMatchObject({ status: 'PROCESSED', paymentId: pago.id })

      // Un segundo pase no duplica.
      await red.reconcilePending()
      expect(await pagos()).toHaveLength(1)
    } finally {
      await f.sinTarifas()
    }
  })

  it('al ingreso la afiliación NO estaba en la configuración: aunque se agregue después, la recuperación sigue en LINK_VENUE_MISMATCH', async () => {
    const { merchantAccountId } = await f.conAfiliacionBlumon({ enConfiguracion: false })
    const { requestId, attemptId } = await intentoVinculado()
    const r = await aviso(f.eventoBlumon(attemptId))
    expect(r).toMatchObject({ action: 'ERROR', errorReason: 'LINK_VENUE_MISMATCH' })
    expect(contextoGuardado((await eventoDe(r.eventLogId)).payload)).toMatchObject({ receiverVenueId: null })
    // Como si el proceso hubiera muerto ANTES de sellar el evento; después el negocio agrega la afiliación.
    await prisma.providerEventLog.update({
      where: { id: r.eventLogId! },
      data: { status: 'PENDING', errorReason: null, processedAt: null, nextAttemptAt: new Date(Date.now() - 1000) },
    })
    await prisma.venuePaymentConfig.upsert({
      where: { venueId: f.venueId },
      update: { secondaryAccountId: merchantAccountId },
      create: { venueId: f.venueId, primaryAccountId: f.merchantId, secondaryAccountId: merchantAccountId },
    })

    await red.reconcilePending()

    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'ERROR', errorReason: 'LINK_VENUE_MISMATCH', paymentId: null })
    expect(await fila(requestId)).toMatchObject({ status: 'SENT', paymentId: null })
  })

  it('un evento sin contexto guardado nunca crea aunque hoy exista el vínculo (el vínculo llegó después del aviso)', async () => {
    await f.conAfiliacionBlumon()
    const { requestId } = await f.solicitud()
    const attemptId = randomUUID()
    const r = await aviso(f.eventoBlumon(attemptId)) // todavía sin vínculo ⇒ sin contexto
    expect(r.action).toBe('NOT_FOUND')
    const ev = await eventoDe(r.eventLogId)
    expect(ev).toMatchObject({ status: 'PENDING', attemptId: null, nextAttemptAt: null })
    expect(contextoGuardado(ev.payload)).toBeNull()
    await vincular(requestId, attemptId)

    await red.reconcilePending()

    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(ev.id)).toMatchObject({ status: 'PENDING', paymentId: null })
    expect(await fila(requestId)).toMatchObject({ status: 'SENT', paymentId: null })
  })

  it('un contexto guardado malformado no crea: sigue el emparejamiento de hoy', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()
    const ev = await ingresoYCaida(f.eventoBlumon(attemptId))
    const p = ev.payload as Record<string, any>
    await prisma.providerEventLog.update({
      where: { id: ev.id },
      data: {
        nextAttemptAt: new Date(Date.now() - 1000),
        payload: { ...p, _avoqado: { ...p._avoqado, contextoDelIngreso: { ...p._avoqado.contextoDelIngreso, merchantAccountId: '' } } },
      },
    })

    await red.reconcilePending()

    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(ev.id)).toMatchObject({ status: 'PENDING', paymentId: null })
  })

  it('un PENDING con contexto no cae en el emparejamiento débil: un REST ajeno con el mismo operationNumber no lo sella', async () => {
    const { merchantAccountId } = await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado({ tipCents: 500 })
    const payload = f.eventoBlumon(attemptId)
    const r = await aviso(payload)
    expect(r).toMatchObject({ action: 'PENDING', errorReason: 'AMOUNT_MISMATCH' })
    await restBlumon(merchantAccountId, { attemptId: randomUUID() }, { blumonOperationNumber: payload.operationNumber })
    await tocaYa(r.eventLogId!)

    await red.reconcilePending()

    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'PENDING', errorReason: 'AMOUNT_MISMATCH', paymentId: null })
    expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(1)
  })

  it('receptor y red a la vez sobre el mismo evento ⇒ un solo Payment (H22: los dos registradores se cruzan en el candado del intento)', async () => {
    await f.conAfiliacionBlumon()
    const { requestId, attemptId } = await intentoVinculado()
    const payload = f.eventoBlumon(attemptId)
    const esperanElCandado = async () => {
      const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid::text::bigint = ${NS_CANDADO_INTENTO}::bigint
          AND objid::text::bigint = (hashtext(${attemptId})::bigint & 4294967295)`
      return n
    }
    const real = registrador.recordFastPayment
    let deLaRed: ReturnType<typeof reconcileBlumonEvent> | undefined
    let cruzaron = false
    const espia = jest.spyOn(registrador, 'recordFastPayment').mockImplementationOnce(async (...args) => {
      // El receptor llegó al registrador con su evento PENDING ya guardado: la red arranca sobre ESE evento, y una
      // transacción ajena retiene el candado del intento hasta que los DOS registradores lo están esperando.
      const ev = await exigir(prisma.providerEventLog.findFirst({ where: { attemptId } }))
      let liberar!: () => void
      let tomado!: () => void
      const liberada = new Promise<void>(res => (liberar = res))
      const yaTomado = new Promise<void>(res => (tomado = res))
      const ajena = prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(${NS_CANDADO_INTENTO}::int, hashtext(${attemptId}))::text`
          tomado()
          await liberada
        },
        { timeout: 20_000 },
      )
      await yaTomado
      deLaRed = reconcileBlumonEvent(ev.id, ev.payload as unknown as Parameters<typeof reconcileBlumonEvent>[1])
      const delReceptor = real(...args)
      try {
        cruzaron = await f.esperar(async () => (await esperanElCandado()) >= 2, 6000)
      } finally {
        liberar()
        await ajena
      }
      return delReceptor
    })
    let r: Awaited<ReturnType<typeof aviso>>
    try {
      r = await aviso(payload)
    } finally {
      espia.mockRestore()
    }
    const rRed = await deLaRed!

    expect(cruzaron).toBe(true)
    const todos = await prisma.payment.findMany({ where: { venueId: f.venueId, idempotencyKey: attemptId } })
    expect(todos).toHaveLength(1)
    expect([r.action, rRed.action]).toContain('CONFIRMED')
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'PROCESSED', paymentId: todos[0].id })
    expect(await fila(requestId)).toMatchObject({ status: 'COMPLETED', paymentId: todos[0].id })
    expect(await prisma.providerEventLog.count({ where: { attemptId } })).toBe(1)
  })

  // ─── Arreglo ronda 1: lo que el SERVIDOR escribe en el evento nunca puede venir del aviso entrante ───
  /** Un `_avoqado` armado por quien manda el aviso: contexto con ids reales y una tarifa inventada. */
  const selloFalso = (args: { attemptId: string; requestId: string; merchantAccountId: string }) => ({
    receivedByMerchantAccountId: args.merchantAccountId,
    contextoDelIngreso: {
      attemptId: args.attemptId,
      requestId: args.requestId,
      linkVenueId: f.venueId,
      linkTerminalId: f.llaveTerminal,
      merchantAccountId: args.merchantAccountId,
      receiverVenueId: f.venueId,
      terminalSerialEfectivo: f.serialCrudo,
    },
    tarifaCongeladaAlIngreso: { pricing: { merchantAccountId: args.merchantAccountId, slot: 'SECONDARY', venue: { creditRate: '0.5' } } },
    ingresoSinCandado: { en: new Date().toISOString() },
  })

  it('un aviso con codeResponse ausente y un _avoqado.contextoDelIngreso falso entra sin él, y la red no crea dinero', async () => {
    const { merchantAccountId } = await f.conAfiliacionBlumon()
    const { requestId, attemptId } = await intentoVinculado()

    const r = await aviso(
      f.eventoBlumon(attemptId, { codeResponse: undefined, _avoqado: selloFalso({ attemptId, requestId, merchantAccountId }) }),
    )

    expect(r.action).toBe('NOT_FOUND')
    const ev = await eventoDe(r.eventLogId)
    expect(ev).toMatchObject({ status: 'PENDING', attemptId: null })
    expect(ev.payload).not.toHaveProperty('_avoqado')

    await red.reconcilePending()

    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(ev.id)).toMatchObject({ status: 'PENDING', paymentId: null })
    expect(await fila(requestId)).toMatchObject({ status: 'SENT', paymentId: null })
  })

  it('un aviso entrante con tarifaCongeladaAlIngreso falsa: sin contexto no se guarda; con contexto manda la del ingreso', async () => {
    const { merchantAccountId } = await f.conAfiliacionBlumon()
    await f.conTarifas({ secundaria: { merchantAccountId } })
    try {
      // Sin vínculo (referencia de hoy): el evento se guarda SIN el sello que trajo el aviso.
      const sinVinculo = await aviso(
        f.eventoBlumon(undefined, {
          _avoqado: {
            tarifaCongeladaAlIngreso: selloFalso({ attemptId: 'x', requestId: 'x', merchantAccountId }).tarifaCongeladaAlIngreso,
          },
        }),
      )
      expect(sinVinculo.action).toBe('NOT_FOUND')
      expect((await eventoDe(sinVinculo.eventLogId)).payload).not.toHaveProperty('_avoqado')

      // Con vínculo: el sello es sólo el del receptor; el cobro lleva la tarifa real del ingreso (2.5 %), nunca la inventada.
      const { requestId, attemptId } = await intentoVinculado()
      const conVinculo = await aviso(f.eventoBlumon(attemptId, { _avoqado: selloFalso({ attemptId, requestId, merchantAccountId }) }))
      expect(conVinculo.action).toBe('CONFIRMED')
      const sello = avoqadoDe(await eventoDe(conVinculo.eventLogId))
      expect(sello?.tarifaCongeladaAlIngreso?.pricing).toMatchObject({ venue: { creditRate: '0.025' } })
      expect(sello).not.toHaveProperty('ingresoSinCandado')
      const pago = await exigir(prisma.payment.findUnique({ where: { id: conVinculo.paymentId! } }))
      expect((pago.processorData as Record<string, any>).pricing).toMatchObject({ venue: { creditRate: '0.025' } })
    } finally {
      await f.sinTarifas()
    }
  })

  it.each([
    ['la fila no lleva attemptId', { attemptId: null }],
    ['la referencia del aviso no es la del contexto', 'referencia'],
  ] as const)('contexto guardado que no corresponde a su fila (%s) ⇒ la red no crea', async (_caso, alteracion) => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()
    const ev = await ingresoYCaida(f.eventoBlumon(attemptId))
    const p = ev.payload as Record<string, any>
    await prisma.providerEventLog.update({
      where: { id: ev.id },
      data: {
        nextAttemptAt: new Date(Date.now() - 1000),
        ...(alteracion === 'referencia' ? { payload: { ...p, reference: randomUUID() } } : alteracion),
      },
    })

    await red.reconcilePending()

    expect(await pagos()).toHaveLength(0)
  })

  // ─── regresión ───
  it('los PENDING viejos (nextAttemptAt null) siguen en la red y a las 24 h pasan a ORPHANED', async () => {
    const { merchantAccountId } = await f.conAfiliacionBlumon()
    const reciente = f.eventoBlumon(undefined)
    const r1 = await aviso(reciente)
    expect(await eventoDe(r1.eventLogId)).toMatchObject({ status: 'PENDING', nextAttemptAt: null })
    const rest = await restBlumon(merchantAccountId, { attemptId: randomUUID() }, { blumonOperationNumber: reciente.operationNumber })

    await red.reconcilePending()

    expect(await eventoDe(r1.eventLogId)).toMatchObject({ status: 'PROCESSED', paymentId: rest.id })

    const r2 = await aviso(f.eventoBlumon(undefined))
    await prisma.$executeRaw`UPDATE "ProviderEventLog" SET "createdAt" = now() - interval '25 hours' WHERE id = ${r2.eventLogId}`

    await red.markOrphaned()

    expect(await eventoDe(r2.eventLogId)).toMatchObject({ status: 'ERROR', errorReason: 'ORPHANED' })
  })

  it('un PENDING con contexto no se vence antes de su turno, y pasadas las 24 h recibe su recuperación antes del ORPHANED', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()
    const ev = await ingresoYCaida(f.eventoBlumon(attemptId))
    await prisma.$executeRaw`
      UPDATE "ProviderEventLog" SET "createdAt" = now() - interval '25 hours', "nextAttemptAt" = now() + interval '5 minutes'
      WHERE id = ${ev.id}`

    await red.markOrphaned()

    expect(await eventoDe(ev.id)).toMatchObject({ status: 'PENDING' })

    await tocaYa(ev.id)
    // El orden de `run`: primero la recuperación, después el vencimiento.
    await red.reconcilePending()
    await red.markOrphaned()

    const todos = await pagos()
    expect(todos).toHaveLength(1)
    expect(await eventoDe(ev.id)).toMatchObject({ status: 'PROCESSED', paymentId: todos[0].id })
  })

  it('F5: más avisos vencidos con contexto que el lote ⇒ el que quedó fuera NO pasa a ORPHANED sin intentarlo; el pase siguiente lo recupera', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()
    // El más viejo se intenta y sigue PENDING (importe distinto); el segundo quedaría fuera de un lote de 1.
    const primero = await aviso(f.eventoBlumon(attemptId, { amount: '99.00' }))
    expect(await eventoDe(primero.eventLogId)).toMatchObject({ status: 'PENDING', errorReason: 'AMOUNT_MISMATCH' })
    const segundo = await ingresoYCaida(f.eventoBlumon(attemptId))
    await prisma.$executeRaw`
      UPDATE "ProviderEventLog" SET "createdAt" = now() - interval '25 hours 1 minute', "nextAttemptAt" = now() - interval '1 second'
      WHERE id = ${primero.eventLogId}`
    await prisma.$executeRaw`
      UPDATE "ProviderEventLog" SET "createdAt" = now() - interval '25 hours', "nextAttemptAt" = now() - interval '1 second'
      WHERE id = ${segundo.id}`
    const lote = red as unknown as { BATCH_SIZE: number; run: () => Promise<void> }
    const original = lote.BATCH_SIZE
    lote.BATCH_SIZE = 1
    try {
      await lote.run()

      expect(await eventoDe(primero.eventLogId)).toMatchObject({ status: 'ERROR', errorReason: 'ORPHANED' })
      expect(await eventoDe(segundo.id)).toMatchObject({ status: 'PENDING' })
      expect(await pagos()).toHaveLength(0)

      await lote.run()
    } finally {
      lote.BATCH_SIZE = original
    }

    const todos = await pagos()
    expect(todos).toHaveLength(1)
    expect(await eventoDe(segundo.id)).toMatchObject({ status: 'PROCESSED', paymentId: todos[0].id })
  })
})
