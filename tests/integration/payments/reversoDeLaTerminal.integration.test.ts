/**
 * SDK propio, fase 1 (Tarea 7): la LÁPIDA del reverso. Una fila de `ProviderEventLog` por intento que anota que la terminal va
 * a reversar (`reversing`) o ya reversó (`reversed`) el cobro. Mientras dice eso, ningún cobro de BLUMON del intento nace:
 * ni por el REST de la terminal ni por el aviso del banco (que queda retenido o sellado sin dinero). Un cobro de AngelPay la
 * ignora. Pasada la ventana del reverso, la red de 30 s la vence (`reverse_unconfirmed`) y el aviso retenido crea el cobro
 * con la marca `reversoIncierto` y una alarma.
 * Las lápidas se siembran directo en la base con la forma que escriben las Tareas 9 y 10.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { processBlumonPaymentWebhook } from '@/services/tpv/blumon-webhook.service'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import * as registrador from '@/services/tpv/payment.tpv.service'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { blumonWebhookReconciliationJob as red } from '@/jobs/blumon-webhook-reconciliation.job'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import {
  EVENTO_REVERSO,
  IntentoConReverso,
  TIPO_REVERSO,
  VENTANA_DEL_REVERSO_MS,
  type EstadoDelReverso,
} from '@/services/tpv/reversoDeLaTerminal.service'
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

jest.setTimeout(60_000)

let f: Fixture
let terminalDelFixture: string

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('rv7')
  terminalDelFixture = (await exigir(prisma.terminal.findUnique({ where: { serialNumber: f.serial }, select: { id: true } }))).id
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(() => f.limpiar())
afterAll(() => f.destruir())

const MIN = 60_000
const pagos = () => prisma.payment.findMany({ where: { venueId: f.venueId } })
const eventoDe = (id: string | undefined) => exigir(prisma.providerEventLog.findUnique({ where: { id: id ?? '' } }))
const lapidaDe = (attemptId: string) =>
  exigir(
    prisma.providerEventLog.findUnique({
      where: { provider_eventId: { provider: 'PAYMENT_PROCESSOR', eventId: EVENTO_REVERSO(attemptId) } },
    }),
  )
const estadoDe = async (attemptId: string) => ((await lapidaDe(attemptId)).payload as Record<string, unknown>).estado
const alarmas = () =>
  (logger.error as jest.Mock).mock.calls.filter(c =>
    String(c[0]).includes('[Blumon reverso] El banco aprobó y el reverso nunca se confirmó'),
  )

/** La lápida con la forma de las Tareas 9 y 10 (H12: `terminalId` = `Terminal.id`; la identidad va en `terminalKey`). */
async function sembrarLapida(attemptId: string, estado: EstadoDelReverso, haceMs = 0) {
  const creada = new Date(Date.now() - haceMs)
  return prisma.providerEventLog.create({
    data: {
      provider: 'PAYMENT_PROCESSOR',
      eventId: EVENTO_REVERSO(attemptId),
      type: TIPO_REVERSO,
      attemptId,
      venueId: f.venueId,
      terminalId: terminalDelFixture,
      status: 'PROCESSED',
      processedAt: creada,
      createdAt: creada,
      payload: { estado, status: estado, terminalKey: f.llaveTerminal, permisoEn: creada.toISOString() },
    },
  })
}

async function intentoVinculado() {
  const solicitud = await f.solicitud()
  const attemptId = randomUUID()
  const ack = await terminalPaymentService.handleAttemptOpenedFromSocket(
    { requestId: solicitud.requestId, attemptId },
    { socketId: 's', terminalId: f.serial, venueId: f.venueId },
  )
  expect(ack.success).toBe(true)
  return { requestId: solicitud.requestId, attemptId }
}

/** El REST de la terminal Blumon (afiliación de Blumon + número de operación) o de la Nexgo (afiliación AngelPay). */
const restBlumon = (merchantAccountId: string, attemptId: string) => ({
  ...f.registroDeLaTerminal({ attemptId }),
  merchantAccountId,
  blumonOperationNumber: Number(`${f.semillaBlumon}${Math.floor(Math.random() * 9000) + 1000}`),
})
const registradores = {
  recordFastPayment: (datos: any) => registrador.recordFastPayment(f.venueId, datos, f.staffId),
  recordOrderPayment: async (datos: any) => registrador.recordOrderPayment(f.venueId, (await f.nuevaVenta(100)).id, datos, f.staffId),
}
const avisoBlumon = (attemptId: string) =>
  processBlumonPaymentWebhook(f.eventoBlumon(attemptId) as Parameters<typeof processBlumonPaymentWebhook>[0])
const pase = () => (red as unknown as { run: () => Promise<void> }).run()

beforeEach(() => {
  jest.spyOn(logger, 'error')
})
afterEach(() => {
  ;(logger.error as jest.Mock).mockRestore?.()
})

describe('el REST del intento con lápida', () => {
  it.each(Object.keys(registradores) as (keyof typeof registradores)[])(
    'lápida reversing ⇒ el REST de Blumon (%s) da IntentoConReverso ATTEMPT_REVERSAL_IN_PROGRESS y no crea Payment',
    async nombre => {
      const { merchantAccountId } = await f.conAfiliacionBlumon()
      const attemptId = randomUUID()
      await sembrarLapida(attemptId, 'reversing')

      const intento = registradores[nombre](restBlumon(merchantAccountId, attemptId))

      await expect(intento).rejects.toBeInstanceOf(IntentoConReverso)
      await expect(intento).rejects.toMatchObject({ statusCode: 409, code: 'ATTEMPT_REVERSAL_IN_PROGRESS', estado: 'reversing' })
      expect(await pagos()).toHaveLength(0)
    },
  )

  it.each(Object.keys(registradores) as (keyof typeof registradores)[])(
    'lápida reversed ⇒ el REST de Blumon (%s) da ATTEMPT_REVERSED y no crea Payment',
    async nombre => {
      const { merchantAccountId } = await f.conAfiliacionBlumon()
      const attemptId = randomUUID()
      await sembrarLapida(attemptId, 'reversed')

      await expect(registradores[nombre](restBlumon(merchantAccountId, attemptId))).rejects.toMatchObject({
        statusCode: 409,
        code: 'ATTEMPT_REVERSED',
      })
      expect(await pagos()).toHaveLength(0)
    },
  )

  it('sólo el número de operación de Blumon (sin afiliación resoluble) también la respeta', async () => {
    const attemptId = randomUUID()
    await sembrarLapida(attemptId, 'reversing')
    const datos = { ...f.registroDeLaTerminal({ attemptId, sinMerchant: true }), blumonOperationNumber: 4242 }

    await expect(registradores.recordFastPayment(datos)).rejects.toMatchObject({ code: 'ATTEMPT_REVERSAL_IN_PROGRESS' })
    expect(await pagos()).toHaveLength(0)
  })

  it.each(Object.keys(registradores) as (keyof typeof registradores)[])(
    'lápida reversing ⇒ un REST de AngelPay (%s, afiliación AngelPay) del mismo intento registra como siempre',
    async nombre => {
      await f.conAfiliacionBlumon()
      const attemptId = randomUUID()
      await sembrarLapida(attemptId, 'reversing')

      const pago = await registradores[nombre](f.registroDeLaTerminal({ attemptId }))

      expect(pago).toMatchObject({ idempotencyKey: attemptId, merchantAccountId: f.merchantId })
      expect(await pagos()).toHaveLength(1)
    },
  )

  it.each(['reverse_failed', 'reverse_unconfirmed', 'contradiction'] as EstadoDelReverso[])(
    'lápida %s ⇒ el REST de Blumon registra como siempre',
    async estado => {
      const { merchantAccountId } = await f.conAfiliacionBlumon()
      const attemptId = randomUUID()
      await sembrarLapida(attemptId, estado)

      const pago = await registradores.recordFastPayment(restBlumon(merchantAccountId, attemptId))

      expect(pago).toMatchObject({ idempotencyKey: attemptId, merchantAccountId })
      expect(await pagos()).toHaveLength(1)
    },
  )

  it('H13: el reintento idempotente de un cobro ya registrado devuelve su Payment aunque después aparezca una lápida', async () => {
    const { merchantAccountId } = await f.conAfiliacionBlumon()
    const attemptId = randomUUID()
    const datos = restBlumon(merchantAccountId, attemptId)
    const primero = await registradores.recordFastPayment(datos)
    await sembrarLapida(attemptId, 'reversing')

    const repetido = await registradores.recordFastPayment({ ...datos })

    expect(repetido.id).toBe(primero.id)
    expect(await pagos()).toHaveLength(1)
  })
})

describe('el aviso del intento con lápida', () => {
  it('lápida reversing ⇒ el aviso firmado de AngelPay del intento crea su cobro igual', async () => {
    const { attemptId } = await intentoVinculado()
    await sembrarLapida(attemptId, 'reversing')

    const r = await processAngelPayWebhook({
      payload: f.eventoAngelPay(attemptId),
      eventId: f.nuevoEventId(),
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    })

    expect(r).toMatchObject({ action: 'CONFIRMED', paymentId: expect.any(String) })
    expect(await pagos()).toHaveLength(1)
  })

  it('lápida reversing ⇒ el aviso aprobado de Blumon queda PENDING/HELD_BY_REVERSAL con nextAttemptAt = lápida + 5 min, sin Payment', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()
    const lapida = await sembrarLapida(attemptId, 'reversing', MIN)

    const r = await avisoBlumon(attemptId)

    expect(r).toMatchObject({ action: 'HELD_BY_REVERSAL', success: false })
    expect(await pagos()).toHaveLength(0)
    const ev = await eventoDe(r.eventLogId)
    expect(ev).toMatchObject({ status: 'PENDING', errorReason: 'HELD_BY_REVERSAL', paymentId: null })
    expect(ev.nextAttemptAt?.getTime()).toBe(lapida.createdAt.getTime() + VENTANA_DEL_REVERSO_MS)
    expect(await estadoDe(attemptId)).toBe('reversing')
    expect(alarmas()).toHaveLength(0)
  })

  it('lápida reversed ⇒ el aviso aprobado de Blumon queda PROCESSED/REVERSED_BY_TERMINAL, sin Payment', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()
    await sembrarLapida(attemptId, 'reversed')

    const r = await avisoBlumon(attemptId)

    expect(r).toMatchObject({ action: 'REVERSED_BY_TERMINAL', success: false })
    expect(await pagos()).toHaveLength(0)
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'PROCESSED', errorReason: 'REVERSED_BY_TERMINAL', paymentId: null })
    expect(await estadoDe(attemptId)).toBe('reversed')
    expect(alarmas()).toHaveLength(0)
  })

  it('lápida reversing de hace 6 min ⇒ el aviso crea el cobro con processorData.reversoIncierto y la lápida pasa a reverse_unconfirmed', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()
    await sembrarLapida(attemptId, 'reversing', 6 * MIN)

    const r = await avisoBlumon(attemptId)

    expect(r).toMatchObject({ action: 'CONFIRMED', paymentId: expect.any(String) })
    const [pago] = await pagos()
    expect(pago.processorData).toMatchObject({ reversoIncierto: true, blumonWebhookReceived: true })
    const lapida = await lapidaDe(attemptId)
    expect(lapida.payload).toMatchObject({ estado: 'reverse_unconfirmed', status: 'reverse_unconfirmed', terminalKey: f.llaveTerminal })
    expect(lapida.status).toBe('PROCESSED')
    expect(alarmas()).toHaveLength(1)
    expect(alarmas()[0][1]).toMatchObject({ attemptId, paymentId: pago.id })
  })
})

describe('la red de 30 s vence las lápidas sin respuesta', () => {
  it('la red vence una lápida reversing de hace 6 min sin aviso: reverse_unconfirmed y no crea nada', async () => {
    const { attemptId } = await intentoVinculado()
    await sembrarLapida(attemptId, 'reversing', 6 * MIN)

    await pase()

    expect(await estadoDe(attemptId)).toBe('reverse_unconfirmed')
    expect(await pagos()).toHaveLength(0)
  })

  it('la red vence la lápida y en el mismo pase el aviso retenido crea el cobro con reversoIncierto', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId, requestId } = await intentoVinculado()
    const lapida = await sembrarLapida(attemptId, 'reversing', MIN)
    const r = await avisoBlumon(attemptId)
    expect(r.action).toBe('HELD_BY_REVERSAL')
    // Pasan 5 minutos más: la lápida ya es de hace 6 y el turno del aviso retenido (lápida + 5 min) ya llegó.
    const antes = new Date(lapida.createdAt.getTime() - 5 * MIN)
    await prisma.providerEventLog.update({ where: { id: lapida.id }, data: { createdAt: antes } })
    await prisma.providerEventLog.update({
      where: { id: r.eventLogId! },
      data: { nextAttemptAt: new Date(antes.getTime() + VENTANA_DEL_REVERSO_MS) },
    })

    await pase()

    expect(await estadoDe(attemptId)).toBe('reverse_unconfirmed')
    const todos = await pagos()
    expect(todos).toHaveLength(1)
    expect(todos[0]).toMatchObject({ idempotencyKey: attemptId, terminalPaymentRequestId: requestId })
    expect(todos[0].processorData).toMatchObject({ reversoIncierto: true })
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'PROCESSED', paymentId: todos[0].id, errorReason: null })
    expect(alarmas()).toHaveLength(1)
  })

  it('la red no toca una lápida reversing de hace 1 min', async () => {
    const { attemptId } = await intentoVinculado()
    await sembrarLapida(attemptId, 'reversing', MIN)

    await pase()

    expect(await estadoDe(attemptId)).toBe('reversing')
  })
})

describe('regresión', () => {
  it('un intento sin lápida registra por REST y por aviso como siempre', async () => {
    const { merchantAccountId } = await f.conAfiliacionBlumon()
    const porRest = randomUUID()
    expect(await registradores.recordFastPayment(restBlumon(merchantAccountId, porRest))).toMatchObject({ idempotencyKey: porRest })
    const { attemptId } = await intentoVinculado()

    const r = await avisoBlumon(attemptId)

    expect(r).toMatchObject({ action: 'CONFIRMED', paymentId: expect.any(String) })
    const todos = await pagos()
    expect(todos).toHaveLength(2)
    expect(todos.find(p => p.idempotencyKey === attemptId)?.processorData).not.toHaveProperty('reversoIncierto')
    expect(alarmas()).toHaveLength(0)
  })
})
