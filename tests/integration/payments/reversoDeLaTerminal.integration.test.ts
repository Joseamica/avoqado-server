/**
 * SDK propio, fase 1 (Tarea 7): la LÁPIDA del reverso. Una fila de `ProviderEventLog` por intento que anota que la terminal va
 * a reversar (`reversing`) o ya reversó (`reversed`) el cobro. Mientras dice eso, ningún cobro de BLUMON del intento nace:
 * ni por el REST de la terminal ni por el aviso del banco (que queda retenido o sellado sin dinero). Un cobro de AngelPay la
 * ignora. Pasada la ventana del reverso, la red de 30 s la vence (`reverse_unconfirmed`) y el aviso retenido crea el cobro
 * con la marca `reversoIncierto` y una alarma.
 * Las lápidas se siembran directo en la base con la forma que escriben las Tareas 9 y 10.
 */
import { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { processBlumonPaymentWebhook } from '@/services/tpv/blumon-webhook.service'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import * as registrador from '@/services/tpv/payment.tpv.service'
import { UNPROVEN_NEGATIVE_WINDOW_MS, terminalPaymentService } from '@/services/terminal-payment.service'
import { candadoDeIntento } from '@/services/tpv/candadoDeIntento'
import { blumonWebhookReconciliationJob as red } from '@/jobs/blumon-webhook-reconciliation.job'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import {
  EVENTO_REVERSO,
  IntentoConReverso,
  TIPO_REVERSO,
  VENTANA_DEL_REVERSO_MS,
  vencerLapidasSinRespuesta,
  type EstadoDelReverso,
} from '@/services/tpv/reversoDeLaTerminal.service'
import { evidenciaDurableDelIngreso } from '@/services/tpv/evidenciaDeIngreso'
import { contradiccionDeProcedenciaSql, hayAprobadoVinculadoSql, sinEventoQueVetaSql } from '@/services/tpv/evidenciaPositivaSql'
import { resolveNoInstrument } from '@/services/tpv/no-instrument-resolution.service'
import { crearBackOffice, crearFixture, exigir, exigirBaseDesechable, type Fixture } from './webhookCheckpoint.fixture'

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
let duena: string | undefined
afterAll(async () => {
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await f.destruir()
  if (duena) await prisma.staff.deleteMany({ where: { id: duena } })
})

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

/**
 * Tarea 8: los cinco lectores de evidencia (`eventoAprobadoSql`) no cuentan un aviso aprobado de Blumon cuya lápida del MISMO
 * intento está `reversed` —en los dos órdenes—; con `reversing` (aviso retenido), `reverse_failed` o `reverse_unconfirmed`
 * sigue contando como hoy. AngelPay no cambia.
 */
describe('los lectores de evidencia con lápida (Tarea 8)', () => {
  /** El aviso aprobado de Blumon tal como lo guarda el receptor, sembrado ANTES de la lápida. */
  const avisoGuardado = (attemptId: string, merchantAccountId: string) => {
    const evento = f.eventoBlumon(attemptId)
    return prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        eventId: `blumon-tpv-${evento.operationNumber}-${attemptId}`,
        type: 'VENTA',
        attemptId,
        venueId: f.venueId,
        status: 'PENDING',
        payload: { ...evento, cardHolder: undefined, _avoqado: { receivedByMerchantAccountId: merchantAccountId } },
      },
    })
  }
  /** Lo que ve cada lector del intento: `true` = cuenta como aprobado. */
  async function loQueVen(attemptId: string, requestId: string, merchantAccountId: string) {
    const [sql] = await prisma.$queryRaw<{ vinculado: boolean; sinVeto: boolean; contradice: boolean }[]>`
      SELECT ${hayAprobadoVinculadoSql(requestId, f.venueId)} AS vinculado,
             ${sinEventoQueVetaSql(attemptId, f.venueId, f.llaveTerminal, true)} AS "sinVeto",
             ${contradiccionDeProcedenciaSql([attemptId], f.venueId, f.llaveTerminal)} AS contradice`
    return {
      evidenciaDurableDelIngreso: (await evidenciaDurableDelIngreso(prisma, f.venueId, merchantAccountId, attemptId)) !== null,
      hayAprobadoVinculadoSql: sql.vinculado,
      sinEventoQueVetaSql: !sql.sinVeto,
      contradiccionDeProcedenciaSql: sql.contradice,
      aprobacionBancariaConocida:
        (await (terminalPaymentService as any).aprobacionBancariaConocida(prisma, f.venueId, [attemptId])) !== null,
    }
  }
  const todos = (v: boolean) => ({
    evidenciaDurableDelIngreso: v,
    hayAprobadoVinculadoSql: v,
    sinEventoQueVetaSql: v,
    contradiccionDeProcedenciaSql: v,
    aprobacionBancariaConocida: v,
  })

  it.each([
    ['aviso primero, lápida reversed después', 'aviso', 'reversed', false],
    ['lápida reversed primero, aviso después (sellado REVERSED_BY_TERMINAL)', 'lapida', 'reversed', false],
    ['lápida reversing (aviso retenido)', 'lapida', 'reversing', true],
    ['lápida reverse_failed', 'aviso', 'reverse_failed', true],
    ['lápida reverse_unconfirmed', 'aviso', 'reverse_unconfirmed', true],
  ] as [string, 'aviso' | 'lapida', EstadoDelReverso, boolean][])('%s ⇒ ¿cuenta como aprobado? %s', async (_, primero, estado, cuenta) => {
    const { merchantAccountId } = await f.conAfiliacionBlumon()
    const { requestId, attemptId } = await intentoVinculado()
    if (primero === 'aviso') {
      await avisoGuardado(attemptId, merchantAccountId)
      await sembrarLapida(attemptId, estado)
    } else {
      await sembrarLapida(attemptId, estado)
      const r = await avisoBlumon(attemptId)
      expect(r.action).toBe(estado === 'reversed' ? 'REVERSED_BY_TERMINAL' : 'HELD_BY_REVERSAL')
    }

    expect(await loQueVen(attemptId, requestId, merchantAccountId)).toEqual(todos(cuenta))
    expect(await pagos()).toHaveLength(0)
  })

  /** Una solicitud que el cajero puede declarar (sin cobro, sin desenlace) con su intento vinculado. */
  async function declarable() {
    const solicitud = await f.solicitud({
      status: 'TIMED_OUT',
      failureCode: null,
      expiresAt: new Date(Date.now() - 60_000),
      resultJson: {
        requestId: 'x',
        status: 'timeout',
        errorMessage: 'El resultado del cobro sigue pendiente de confirmar',
        terminalResult: { status: 'failed', errorMessage: 'SDK U100: Operacion cancelada por el usuario', outcomeEvidence: null },
      },
    })
    const attemptId = randomUUID()
    await prisma.terminalPaymentAttemptLink.create({
      data: { attemptId, requestId: solicitud.requestId, venueId: f.venueId, terminalId: f.llaveTerminal },
    })
    duena ??= await crearBackOffice(f)
    const declarar = () =>
      resolveNoInstrument(
        { venueId: f.venueId, terminalSerial: f.serial, attemptId, actorStaffId: duena! },
        { requestId: solicitud.requestId, resolutionId: randomUUID(), statement: 'NO_INSTRUMENT_PRESENTED', statementVersion: 1 },
      )
    return { requestId: solicitud.requestId, attemptId, declarar }
  }

  it('lápida reversing con aviso retenido ⇒ la declaración «no se presentó tarjeta» da POSITIVE_EVIDENCE_EXISTS, como cualquier aprobado sin Payment', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId, declarar } = await declarable()
    await sembrarLapida(attemptId, 'reversing')
    expect((await avisoBlumon(attemptId)).action).toBe('HELD_BY_REVERSAL')

    await expect(declarar()).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
    expect(await pagos()).toHaveLength(0)
  })

  it('lápida reversed sin aviso ⇒ la declaración pasa', async () => {
    const { requestId, attemptId, declarar } = await declarable()
    await sembrarLapida(attemptId, 'reversed')

    expect((await declarar()).resolution).toMatchObject({ by: 'SESSION' })
    expect(await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })).toMatchObject({
      status: 'FAILED',
      failureCode: 'OPERATOR_RECONCILED_NO_CHARGE',
    })
  })

  it('aprobado de AngelPay con lápida reversed del mismo intento ⇒ sigue contando como aprobado', async () => {
    const { requestId, attemptId } = await intentoVinculado()
    await sembrarLapida(attemptId, 'reversed')
    const r = await processAngelPayWebhook({
      payload: f.eventoAngelPay(attemptId),
      eventId: f.nuevoEventId(),
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    })
    expect(r).toMatchObject({ action: 'CONFIRMED' })

    expect(await loQueVen(attemptId, requestId, f.merchantId)).toEqual(todos(true))
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

/**
 * Tarea 9: la terminal pide PERMISO antes de reversar (`POST …/attempts/:attemptId/reverso/intencion`), por la ruta real (app +
 * token de terminal). Sólo se da si el cobro del intento no está registrado ni hay dinero con su llave; entonces nace la lápida
 * `reversing`. Pertenencia primero: un intento sin vínculo, de otro negocio o de otra terminal es 404; uno con aviso de AngelPay,
 * 409 ATTEMPT_NOT_BLUMON.
 */
describe('el permiso para reversar (Tarea 9)', () => {
  const tokenDe = (serial: string | null, staffId = f.staffId) =>
    jwt.sign(
      { sub: staffId, orgId: f.fixture, venueId: f.venueId, role: 'CASHIER', ...(serial ? { terminalSerialNumber: serial } : {}) },
      process.env.ACCESS_TOKEN_SECRET as string,
      { expiresIn: '15m' },
    )
  const ruta = (attemptId: string, final: string) =>
    `/api/v1/tpv/venues/${f.venueId}/terminal-payment/attempts/${encodeURIComponent(attemptId)}/${final}`
  /** El POST del permiso; `.then` lo dispara en el momento (las carreras lo necesitan así). */
  const intencion = (attemptId: string, serial: string | null = f.serial, cuerpo: object = {}) =>
    request(app)
      .post(ruta(attemptId, 'reverso/intencion'))
      .set('Authorization', `Bearer ${tokenDe(serial)}`)
      .send(cuerpo)
      .then(r => r)
  const vincular = async (requestId: string, attemptId: string, serial = f.serial) => {
    const ack = await terminalPaymentService.handleAttemptOpenedFromSocket(
      { requestId, attemptId },
      { socketId: 's', terminalId: serial, venueId: f.venueId },
    )
    expect(ack.success).toBe(true)
  }
  const lapidaOpcional = (attemptId: string) =>
    prisma.providerEventLog.findUnique({
      where: { provider_eventId: { provider: 'PAYMENT_PROCESSOR', eventId: EVENTO_REVERSO(attemptId) } },
    })
  const lapidasDel = (attemptId: string) => prisma.providerEventLog.count({ where: { attemptId, type: TIPO_REVERSO } })

  /** Sesiones de esta base esperando un candado consultivo. */
  const enEspera = async () =>
    (
      await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
      )
    )[0].n
  /** La barrera: la prueba toma el candado del intento y lo suelta cuando los dos competidores ya están formados detrás. */
  async function retenerCandado(attemptId: string) {
    let soltar!: () => void
    let tomado!: () => void
    const suelto = new Promise<void>(r => (soltar = r))
    const listo = new Promise<void>(r => (tomado = r))
    const tx = prisma.$transaction(
      async t => {
        await candadoDeIntento(t, attemptId)
        tomado()
        await suelto
      },
      { timeout: 30_000 },
    )
    await listo
    const base = await enEspera()
    return {
      enFila: async (n: number) => expect(await f.esperar(async () => (await enEspera()) >= base + n, 7000)).toBe(true),
      soltar: async () => {
        soltar()
        await tx
      },
    }
  }

  it('sin Payment ⇒ 200 reversing y una lápida', async () => {
    const { attemptId } = await intentoVinculado()

    const res = await intencion(attemptId)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, attemptId, estado: 'reversing', eventLogId: expect.any(String) })
    const lapida = await lapidaDe(attemptId)
    // H12: `terminalId` es el `Terminal.id` de la terminal del token; la identidad va en `payload.terminalKey`.
    expect(lapida).toMatchObject({
      id: res.body.eventLogId,
      type: TIPO_REVERSO,
      status: 'PROCESSED',
      attemptId,
      venueId: f.venueId,
      terminalId: terminalDelFixture,
    })
    expect(lapida.payload).toEqual({
      estado: 'reversing',
      status: 'reversing',
      terminalKey: f.llaveTerminal,
      permisoEn: expect.any(String),
    })
    expect(await pagos()).toHaveLength(0)
  })

  it('el mismo permiso otra vez ⇒ 200 con la misma lápida (una sola fila)', async () => {
    const { attemptId } = await intentoVinculado()
    const primero = await intencion(attemptId)

    const segundo = await intencion(attemptId)

    expect(segundo.status).toBe(200)
    expect(segundo.body).toEqual(primero.body)
    expect(await lapidasDel(attemptId)).toBe(1)
  })

  it.each(['reversed', 'reverse_failed', 'reverse_unconfirmed', 'contradiction'] as EstadoDelReverso[])(
    'H21: el permiso sobre una lápida %s ⇒ 200 con ese estado, sin reescribirla',
    async estado => {
      const { attemptId } = await intentoVinculado()
      const lapida = await sembrarLapida(attemptId, estado)

      const res = await intencion(attemptId)

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true, attemptId, estado, eventLogId: lapida.id })
      expect(await estadoDe(attemptId)).toBe(estado)
    },
  )

  it('dos permisos a la vez (barrera: el primero retenido dentro del candado) ⇒ los dos 200 con la misma lápida, una sola fila', async () => {
    const { attemptId } = await intentoVinculado()
    const candado = await retenerCandado(attemptId)
    const uno = intencion(attemptId)
    await candado.enFila(1)
    const otro = intencion(attemptId)
    await candado.enFila(2)
    await candado.soltar()

    const [a, b] = await Promise.all([uno, otro])

    expect([a.status, b.status]).toEqual([200, 200])
    expect(a.body).toEqual(b.body)
    expect(a.body.estado).toBe('reversing')
    expect(await lapidasDel(attemptId)).toBe(1)
  })

  it.each(['aviso', 'REST'])(
    'con Payment COMPLETED del intento, de este venue y terminal (%s) ⇒ 409 ATTEMPT_ALREADY_RECORDED con el resumen y sin lápida',
    async camino => {
      const { merchantAccountId } = await f.conAfiliacionBlumon()
      const { attemptId, requestId } = await intentoVinculado()
      if (camino === 'aviso') expect((await avisoBlumon(attemptId)).action).toBe('CONFIRMED')
      else await registradores.recordFastPayment({ ...restBlumon(merchantAccountId, attemptId), terminalPaymentRequestId: requestId })
      const [pago] = await pagos()
      expect(pago).toMatchObject({ status: 'COMPLETED', idempotencyKey: attemptId, terminalPaymentRequestId: requestId })

      const res = await intencion(attemptId)

      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({
        success: false,
        code: 'ATTEMPT_ALREADY_RECORDED',
        payment: { paymentId: pago.id, amountCents: 10000, tipCents: 0, authorizationNumber: pago.authorizationNumber },
      })
      expect(pago.authorizationNumber).toBeTruthy()
      expect(await lapidaOpcional(attemptId)).toBeNull()
    },
  )

  it('con evidencia PENDING de segunda captura (producida por recordFastPayment sobre una solicitud ya ganada) ⇒ 409 ATTEMPT_HAS_PENDING_EVIDENCE tipo POSSIBLE_SECOND_CAPTURE, sin lápida', async () => {
    const solicitud = await f.solicitud()
    const [ganador, segundo] = [randomUUID(), randomUUID()]
    await vincular(solicitud.requestId, ganador)
    await vincular(solicitud.requestId, segundo)
    await registradores.recordFastPayment(f.registroDeLaTerminal({ attemptId: ganador, requestId: solicitud.requestId }))
    const captura = await registradores.recordFastPayment(f.registroDeLaTerminal({ attemptId: segundo, requestId: solicitud.requestId }))
    expect(captura).toMatchObject({ status: 'PENDING', idempotencyKey: segundo })

    const res = await intencion(segundo)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      success: false,
      code: 'ATTEMPT_HAS_PENDING_EVIDENCE',
      evidencia: { paymentStatus: 'PENDING', tipo: 'POSSIBLE_SECOND_CAPTURE' },
    })
    expect(await lapidaOpcional(segundo)).toBeNull()
  })

  it('con evidencia PENDING de colisión de referencia (producida por el registrador) ⇒ 409 ATTEMPT_HAS_PENDING_EVIDENCE tipo POSSIBLE_REFERENCE_COLLISION, sin lápida', async () => {
    const referencia = `${f.semillaBlumon}${Date.now()}`
    // Un cobro viejo (APK sin llave) con la misma referencia e importe y OTRA autorización.
    await registradores.recordFastPayment(
      f.registroDeLaTerminal({ attemptId: randomUUID(), sinLlave: true, ref: referencia, auth: 'AUTH-VIEJO' }),
    )
    const solicitud = await f.solicitud()
    const attemptId = randomUUID()
    const colision = await registradores.recordFastPayment(
      f.registroDeLaTerminal({ attemptId, ref: referencia, auth: 'AUTH-NUEVO', requestId: solicitud.requestId }),
    )
    expect(colision).toMatchObject({ status: 'PENDING', idempotencyKey: attemptId })
    await vincular(solicitud.requestId, attemptId)

    const res = await intencion(attemptId)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      success: false,
      code: 'ATTEMPT_HAS_PENDING_EVIDENCE',
      evidencia: { paymentStatus: 'PENDING', tipo: 'POSSIBLE_REFERENCE_COLLISION' },
    })
    expect(await lapidaOpcional(attemptId)).toBeNull()
  })

  it.each([
    ['recordFastPayment', 'permiso'],
    ['recordFastPayment', 'REST'],
    ['recordOrderPayment', 'permiso'],
    ['recordOrderPayment', 'REST'],
  ] as const)(
    'permiso contra REST por %s (llega primero: %s), con barrera ⇒ o 409 con el Payment, o lápida reversing y el REST da 409 ATTEMPT_REVERSAL_IN_PROGRESS; nunca los dos',
    async (nombre, primero) => {
      const { merchantAccountId } = await f.conAfiliacionBlumon()
      const venta = nombre === 'recordOrderPayment' ? await f.nuevaVenta(100) : null
      const solicitud = await f.solicitud(venta ? { orderId: venta.id } : {})
      const attemptId = randomUUID()
      await vincular(solicitud.requestId, attemptId)
      const datos = { ...restBlumon(merchantAccountId, attemptId), terminalPaymentRequestId: solicitud.requestId }
      const rest = () =>
        (venta
          ? registrador.recordOrderPayment(f.venueId, venta.id, datos, f.staffId)
          : registrador.recordFastPayment(f.venueId, datos, f.staffId)
        ).then(
          pago => ({ pago, error: null as any }),
          error => ({ pago: null, error }),
        )
      const candado = await retenerCandado(attemptId)
      const p1 = primero === 'permiso' ? intencion(attemptId) : rest()
      await candado.enFila(1)
      const p2 = primero === 'permiso' ? rest() : intencion(attemptId)
      await candado.enFila(2)
      await candado.soltar()
      const [r1, r2] = await Promise.all([p1, p2])
      const permiso = (primero === 'permiso' ? r1 : r2) as Awaited<ReturnType<typeof intencion>>
      const registro = (primero === 'permiso' ? r2 : r1) as Awaited<ReturnType<typeof rest>>

      const todos = await pagos()
      if (permiso.status === 200) {
        expect(permiso.body.estado).toBe('reversing')
        expect(registro.error).toMatchObject({ code: 'ATTEMPT_REVERSAL_IN_PROGRESS' })
        expect(todos).toHaveLength(0)
      } else {
        expect(permiso.status).toBe(409)
        expect(permiso.body).toMatchObject({ code: 'ATTEMPT_ALREADY_RECORDED', payment: { paymentId: registro.pago?.id } })
        expect(todos).toHaveLength(1)
        expect(await lapidaOpcional(attemptId)).toBeNull()
      }
      // La fila de espera es FIFO y el registrador toma el candado del intento una sola vez: gana el que llegó primero.
      expect(permiso.status).toBe(primero === 'permiso' ? 200 : 409)
    },
  )

  it.each(['permiso', 'aviso'])(
    'permiso y aviso aprobado a la vez (barrera; se forma primero: %s) ⇒ o 409 con el Payment, o lápida reversing y aviso HELD; nunca los dos',
    async primero => {
      await f.conAfiliacionBlumon()
      const { attemptId } = await intentoVinculado()
      const aviso = () => avisoBlumon(attemptId)
      const candado = await retenerCandado(attemptId)
      const p1 = primero === 'permiso' ? intencion(attemptId) : aviso()
      await candado.enFila(1)
      const p2 = primero === 'permiso' ? aviso() : intencion(attemptId)
      await candado.enFila(2)
      await candado.soltar()
      const [r1, r2] = await Promise.all([p1, p2])
      const permiso = (primero === 'permiso' ? r1 : r2) as Awaited<ReturnType<typeof intencion>>
      const resultado = (primero === 'permiso' ? r2 : r1) as Awaited<ReturnType<typeof aviso>>

      const todos = await pagos()
      if (permiso.status === 200) {
        expect(permiso.body.estado).toBe('reversing')
        expect(resultado.action).toBe('HELD_BY_REVERSAL')
        expect(todos).toHaveLength(0)
        expect(await estadoDe(attemptId)).toBe('reversing')
      } else {
        expect(permiso.status).toBe(409)
        expect(resultado.action).toBe('CONFIRMED')
        expect(permiso.body).toMatchObject({ code: 'ATTEMPT_ALREADY_RECORDED', payment: { paymentId: resultado.paymentId } })
        expect(todos).toHaveLength(1)
        expect(await lapidaOpcional(attemptId)).toBeNull()
      }
    },
  )

  it('REST anterior al vínculo, de OTRA solicitud, con la misma llave ⇒ 409 ATTEMPT_HAS_PENDING_EVIDENCE, no «Aprobado»', async () => {
    const vieja = await f.solicitud()
    const attemptId = randomUUID()
    const pago = await registradores.recordFastPayment(f.registroDeLaTerminal({ attemptId, requestId: vieja.requestId }))
    expect(pago).toMatchObject({ status: 'COMPLETED', terminalPaymentRequestId: vieja.requestId })
    const nueva = await f.solicitud()
    await vincular(nueva.requestId, attemptId)

    const res = await intencion(attemptId)

    expect(res.status).toBe(409)
    // De otra solicitud: la terminal sólo sabe que hay dinero que no puede reclamar como suyo (nada de ese pago se publica).
    expect(res.body).toMatchObject({ code: 'ATTEMPT_HAS_PENDING_EVIDENCE', evidencia: { paymentStatus: null, tipo: null } })
    expect(res.body).not.toHaveProperty('payment')
    expect(await lapidaOpcional(attemptId)).toBeNull()
  })

  it('Nexgo con un intento de AngelPay todavía sin aviso ⇒ 200 con lápida; el aviso firmado de AngelPay que llega después crea su cobro igual y la lápida no lo toca', async () => {
    const { attemptId } = await intentoVinculado()
    expect((await intencion(attemptId)).body).toMatchObject({ estado: 'reversing' })

    const r = await processAngelPayWebhook({
      payload: f.eventoAngelPay(attemptId),
      eventId: f.nuevoEventId(),
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    })

    expect(r).toMatchObject({ action: 'CONFIRMED', paymentId: expect.any(String) })
    expect(await pagos()).toHaveLength(1)
    expect(await estadoDe(attemptId)).toBe('reversing')
  })

  it('intento con aviso de AngelPay ya guardado ⇒ 409 ATTEMPT_NOT_BLUMON, sin lápida', async () => {
    const { attemptId } = await intentoVinculado()
    const r = await processAngelPayWebhook({
      payload: f.eventoAngelPay(attemptId),
      eventId: f.nuevoEventId(),
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    })
    expect(r.action).toBe('CONFIRMED')

    const res = await intencion(attemptId)

    // Va ANTES que la pregunta por el dinero: el cobro de AngelPay ya registrado no la cambia a «Aprobado».
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, code: 'ATTEMPT_NOT_BLUMON' })
    expect(await lapidaOpcional(attemptId)).toBeNull()
  })

  it('PAX con brand null y afiliación Blumon heredada (assignedMerchantIds vacío) ⇒ 200; su aviso de Blumon queda HELD_BY_REVERSAL', async () => {
    const pax = await f.otraTerminal({ brand: null })
    await f.conAfiliacionBlumon({ serial: pax.serialCrudo, asignadaA: [] })
    const solicitud = await f.solicitud({ terminalId: pax.llave })
    const attemptId = randomUUID()
    await vincular(solicitud.requestId, attemptId, pax.serial)

    const res = await intencion(attemptId, pax.serial)

    expect(res.status).toBe(200)
    expect(res.body.estado).toBe('reversing')
    const terminalPax = await exigir(prisma.terminal.findUnique({ where: { serialNumber: pax.serial }, select: { id: true } }))
    expect(await lapidaDe(attemptId)).toMatchObject({
      terminalId: terminalPax.id,
      payload: expect.objectContaining({ terminalKey: pax.llave }),
    })
    const aviso = await processBlumonPaymentWebhook(
      f.eventoBlumon(attemptId, { serialNumber: pax.serialCrudo }) as Parameters<typeof processBlumonPaymentWebhook>[0],
    )
    expect(aviso.action).toBe('HELD_BY_REVERSAL')
    expect(await pagos()).toHaveLength(0)
  })

  it('intento vinculado a otra terminal ⇒ 404, también si ya existe una lápida', async () => {
    const otra = await f.otraTerminal()
    const solicitud = await f.solicitud({ terminalId: otra.llave })
    const attemptId = randomUUID()
    await vincular(solicitud.requestId, attemptId, otra.serial)

    const sinLapida = await intencion(attemptId)
    expect(sinLapida.status).toBe(404)
    expect(sinLapida.body).toMatchObject({ success: false, code: 'ATTEMPT_NOT_FOUND' })

    expect((await intencion(attemptId, otra.serial)).status).toBe(200)
    const conLapida = await intencion(attemptId)
    expect(conLapida.status).toBe(404)
    expect(conLapida.body).toMatchObject({ success: false, code: 'ATTEMPT_NOT_FOUND' })
    expect(conLapida.body).not.toHaveProperty('estado')
  })

  it('cobro local sin vínculo ⇒ 404 ATTEMPT_NOT_FOUND', async () => {
    const attemptId = randomUUID()
    await registradores.recordFastPayment(f.registroDeLaTerminal({ attemptId }))

    const res = await intencion(attemptId)

    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ success: false, code: 'ATTEMPT_NOT_FOUND' })
    expect(await lapidaOpcional(attemptId)).toBeNull()
  })

  it('token sin terminal ⇒ 403 TERMINAL_IDENTITY_REQUIRED', async () => {
    const { attemptId } = await intentoVinculado()

    const res = await intencion(attemptId, null)

    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ success: false, code: 'TERMINAL_IDENTITY_REQUIRED' })
    expect(await lapidaOpcional(attemptId)).toBeNull()
  })

  it('llave extra en el cuerpo ⇒ 400', async () => {
    const { attemptId } = await intentoVinculado()

    const res = await intencion(attemptId, f.serial, { terminalSerial: 'otra' })

    expect(res.status).toBe(400)
    expect(await lapidaOpcional(attemptId)).toBeNull()
  })

  it('permiso ⇒ ni aviso ni resultado ⇒ timeout de la terminal y ventana de confirmación ⇒ la declaración del cajero pasa (la lápida no la bloquea ni deja marca)', async () => {
    duena ??= await crearBackOffice(f)
    // La terminal cobra con Blumon: su aviso no está «comprobado» (A8), así que la ventana suelta sólo la ranura y la venta queda
    // en duda hasta que una persona declare — el camino que importa aquí. (Sin esto el resultado dependía de los avisos de
    // AngelPay que dejaron las pruebas anteriores.)
    await f.conAfiliacionBlumon()
    const { attemptId, requestId } = await intentoVinculado()
    expect((await intencion(attemptId)).body).toMatchObject({ estado: 'reversing' })
    // La terminal reporta timeout (el reverso nunca contestó) y pasa la ventana de confirmación.
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId, status: 'timeout', errorMessage: 'La terminal no pudo confirmar el resultado del cobro.' } as any,
      { socketId: 's', terminalId: f.serial, venueId: f.venueId },
    )
    expect(await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId } })).toMatchObject({
      status: 'TIMED_OUT',
      failureCode: null,
    })
    const liberacion = await terminalPaymentService.releaseUnprovenNegative(
      requestId,
      f.venueId,
      'WATCHDOG',
      new Date(Date.now() + UNPROVEN_NEGATIVE_WINDOW_MS + 1_000),
    )
    // La lápida no es un Payment sin ligar ni una aprobación: la ventana no retiene (`PAYMENT_UNBOUND_AWAITING_REVIEW`).
    expect(liberacion).toBe('SLOT_RELEASED_UNPROVEN_WEBHOOK')
    expect(await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId } })).toMatchObject({
      status: 'TIMED_OUT',
      failureCode: 'AUTO_RELEASED',
    })

    const res = await request(app)
      .post(ruta(attemptId, 'no-instrument-resolution'))
      .set('Authorization', `Bearer ${tokenDe(f.serial, duena)}`)
      .send({ requestId, resolutionId: randomUUID(), statement: 'NO_INSTRUMENT_PRESENTED', statementVersion: 1 })

    expect({ status: res.status, code: res.body.code }).toEqual({ status: 200, code: undefined })
    expect(res.body.resolution).toMatchObject({ by: 'SESSION' })
    expect(await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId } })).toMatchObject({
      status: 'FAILED',
      failureCode: 'OPERATOR_RECONCILED_NO_CHARGE',
    })
    expect(await estadoDe(attemptId)).toBe('reversing')
    expect(await pagos()).toHaveLength(0)
  })

  it('permiso ⇒ sin resultado ⇒ pasa la ventana del reverso ⇒ corre la red ⇒ lápida reverse_unconfirmed', async () => {
    const { attemptId } = await intentoVinculado()
    expect((await intencion(attemptId)).body).toMatchObject({ estado: 'reversing' })

    // El primer paso de la red de 30 s, con su «ahora» ya pasada la ventana (sin mover el reloj global).
    expect(await vencerLapidasSinRespuesta(new Date(Date.now() + VENTANA_DEL_REVERSO_MS + MIN))).toBeGreaterThanOrEqual(1)

    expect(await estadoDe(attemptId)).toBe('reverse_unconfirmed')
    expect(await pagos()).toHaveLength(0)
  })
})
