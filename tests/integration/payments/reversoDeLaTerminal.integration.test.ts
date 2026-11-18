/**
 * SDK propio, fase 1 (Tarea 7): la LÁPIDA del reverso. Una fila de `ProviderEventLog` por intento que anota que la terminal va
 * a reversar (`reversing`) o ya reversó (`reversed`) el cobro. Mientras dice eso, ningún cobro de BLUMON del intento nace:
 * ni por el REST de la terminal ni por el aviso del banco (que queda retenido o sellado sin dinero). Un cobro de AngelPay la
 * ignora. Pasada la ventana del reverso, la red de 30 s la vence (`reverse_unconfirmed`) y el aviso retenido crea el cobro
 * con la marca `reversoIncierto` y una alarma.
 * Las lápidas se siembran directo en la base con la forma que escriben las Tareas 9 y 10.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import * as avisoDeBlumon from '@/services/tpv/blumon-webhook.service'
import { processBlumonPaymentWebhook } from '@/services/tpv/blumon-webhook.service'
import { ingresarEventoDelIntento, processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { claimPendingAngelPayEvents, runClaimedAngelPayEvent } from '@/services/tpv/angelpayEventWorker.service'
import * as registrador from '@/services/tpv/payment.tpv.service'
import * as reverso from '@/services/tpv/reversoDeLaTerminal.service'
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
  vencerReversoSinRespuesta,
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

  it('F2: el aviso lee reversing antes del candado, la red la vence en medio y luego registra ⇒ el cobro lleva reversoIncierto y sale 🚨 una vez', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()
    const lapida = await sembrarLapida(attemptId, 'reversing')
    const real = reverso.vencerReversoSinRespuesta
    // Barrera: la lectura previa del aviso ve `reversing` (dentro de la ventana) y, antes de que registre, la red la vence.
    const espia = jest.spyOn(reverso, 'vencerReversoSinRespuesta').mockImplementationOnce(async (id, ahora) => {
      const leido = await real(id, ahora)
      await prisma.providerEventLog.update({ where: { id: lapida.id }, data: { createdAt: new Date(Date.now() - 6 * MIN) } })
      expect(await reverso.vencerLapidasSinRespuesta()).toBeGreaterThanOrEqual(1)
      return leido
    })

    const r = await avisoBlumon(attemptId).finally(() => espia.mockRestore())

    expect(r).toMatchObject({ action: 'CONFIRMED', paymentId: expect.any(String) })
    expect(await estadoDe(attemptId)).toBe('reverse_unconfirmed')
    const [pago] = await pagos()
    expect(pago.processorData).toMatchObject({ reversoIncierto: true })
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

/** Lo común de los endpoints del reverso (Tareas 9 y 10): la ruta real con el token de la terminal, y las barreras. */
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

/** Sesiones de esta base esperando un candado consultivo (o, con `['transactionid', 'tuple']`, una fila bloqueada). */
const enEspera = async (eventos: string[] = ['advisory']) =>
  (
    await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = ANY($1::text[])`,
      eventos,
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
    // Si nadie se forma, suelta antes de fallar: así la prueba no deja el candado tomado ni promesas colgando.
    enFila: async (n: number) => {
      const formados = await f.esperar(async () => (await enEspera()) >= base + n, 7000)
      if (!formados) soltar()
      expect(formados).toBe(true)
    },
    soltar: async () => {
      soltar()
      await tx
    },
  }
}

/**
 * Tarea 9: la terminal pide PERMISO antes de reversar (`POST …/attempts/:attemptId/reverso/intencion`), por la ruta real (app +
 * token de terminal). Sólo se da si el cobro del intento no está registrado ni hay dinero con su llave; entonces nace la lápida
 * `reversing`. Pertenencia primero: un intento sin vínculo, de otro negocio o de otra terminal es 404; uno con aviso de AngelPay,
 * 409 ATTEMPT_NOT_BLUMON.
 */
describe('el permiso para reversar (Tarea 9)', () => {
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

  it('F9: S6 corre con la conexión del permiso — si pidiera otra y el pool estuviera agotado (P2024), igual contesta 200', async () => {
    const { attemptId } = await intentoVinculado()
    const real = terminalPaymentService.consultarIntentoDeTerminal.bind(terminalPaymentService) as (...a: unknown[]) => Promise<unknown>
    const espia = jest.spyOn(terminalPaymentService, 'consultarIntentoDeTerminal').mockImplementation((async (
      input: unknown,
      db?: unknown,
    ) => {
      if (!db) {
        throw new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', {
          code: 'P2024',
          clientVersion: 'prueba',
        })
      }
      return real(input, db)
    }) as never)

    const res = await intencion(attemptId).finally(() => espia.mockRestore())

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ estado: 'reversing' })
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

/**
 * Tarea 10: la terminal reporta cómo le fue al reverso (`POST …/attempts/:attemptId/reverso/resultado`), por la ruta real. Con
 * REVERSADA (o TX_014/TX_013) y sin dinero del intento, la lápida queda `reversed` y los avisos de Blumon retenidos se sellan sin
 * dinero; con el reverso rechazado, `reverse_failed` y el aviso retenido crea el cobro ya; con REVERSADA y dinero, `contradiction`
 * (el dinero no se toca: alerta para una persona). Un desenlace final no se reescribe (H16). AngelPay nunca se toca desde aquí.
 */
describe('el resultado del reverso (Tarea 10)', () => {
  const resultado = (attemptId: string, cuerpo: object, serial: string = f.serial) =>
    request(app)
      .post(ruta(attemptId, 'reverso/resultado'))
      .set('Authorization', `Bearer ${tokenDe(serial)}`)
      .send(cuerpo)
      .then(r => r)
  const reversada = (over: Record<string, unknown> = {}) => ({
    descripcion: 'REVERSADA',
    operationNumber: 4321,
    reversadoEn: new Date().toISOString(),
    ...over,
  })
  const rechazado = (codigo: string) => ({ descripcion: 'RECHAZADA', codigo, reversadoEn: new Date().toISOString() })
  const cuerpoDe = (que: string) => (que === 'REVERSADA' ? reversada() : rechazado(que))
  /** El ActivityLog del intento (el de contradicción apunta al Payment, así que se busca por `data.attemptId`). */
  const bitacora = (attemptId: string) =>
    prisma.activityLog.findMany({ where: { venueId: f.venueId, data: { path: ['attemptId'], equals: attemptId } } })
  const contradicciones = () => (logger.error as jest.Mock).mock.calls.filter(c => String(c[0]).startsWith('🚨 [Reverso]'))

  /** Terminal de Blumon con permiso (`reversing`) y su aviso aprobado retenido. */
  async function permisoConAvisoRetenido() {
    const { merchantAccountId } = await f.conAfiliacionBlumon()
    const { attemptId, requestId } = await intentoVinculado()
    expect((await intencion(attemptId)).body).toMatchObject({ estado: 'reversing' })
    const aviso = await avisoBlumon(attemptId)
    expect(aviso.action).toBe('HELD_BY_REVERSAL')
    return { attemptId, requestId, merchantAccountId, eventoId: aviso.eventLogId! }
  }
  /** Pasan 6 min desde el permiso: la lápida queda fuera de la ventana y el turno del aviso retenido ya llegó. */
  async function pasaLaVentana(attemptId: string, eventoId?: string) {
    const hace = new Date(Date.now() - 6 * MIN)
    await prisma.providerEventLog.update({ where: { id: (await lapidaDe(attemptId)).id }, data: { createdAt: hace } })
    if (eventoId) {
      await prisma.providerEventLog.update({
        where: { id: eventoId },
        data: { nextAttemptAt: new Date(hace.getTime() + VENTANA_DEL_REVERSO_MS) },
      })
    }
  }
  /**
   * Barrera DENTRO del candado: la prueba bloquea la FILA de la lápida; el primer resultado toma el candado del intento, lee y
   * se queda esperando esa fila al escribir; el segundo se forma en el candado del intento. Prueba que el candado cubre hasta
   * la escritura (si no, el segundo leería `reversing` y escribiría encima).
   */
  async function retenerLaEscrituraDeLaLapida(attemptId: string) {
    const fila = ['transactionid', 'tuple']
    let soltar!: () => void
    let tomado!: () => void
    const suelto = new Promise<void>(r => (soltar = r))
    const listo = new Promise<void>(r => (tomado = r))
    const id = (await lapidaDe(attemptId)).id
    const tx = prisma.$transaction(
      async t => {
        await t.$queryRaw`SELECT "id" FROM "ProviderEventLog" WHERE "id" = ${id} FOR UPDATE`
        tomado()
        await suelto
      },
      { timeout: 30_000 },
    )
    await listo
    const [baseFila, baseCandado] = [await enEspera(fila), await enEspera()]
    const hasta = async (condicion: () => Promise<boolean>) => {
      const ok = await f.esperar(condicion, 7000)
      if (!ok) soltar()
      expect(ok).toBe(true)
    }
    return {
      escribiendo: () => hasta(async () => (await enEspera(fila)) >= baseFila + 1),
      enFila: () => hasta(async () => (await enEspera()) >= baseCandado + 1),
      soltar: async () => {
        soltar()
        await tx
      },
    }
  }

  it('reversing + REVERSADA ⇒ reversed; el aviso retenido queda REVERSED_BY_TERMINAL; ActivityLog; luego ni aviso ni REST crean', async () => {
    const { attemptId, merchantAccountId, eventoId } = await permisoConAvisoRetenido()
    const lapida = await lapidaDe(attemptId)
    const cuerpo = reversada()

    const res = await resultado(attemptId, cuerpo)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, attemptId, estado: 'reversed', eventLogId: lapida.id })
    expect(await eventoDe(eventoId)).toMatchObject({ status: 'PROCESSED', errorReason: 'REVERSED_BY_TERMINAL', paymentId: null })
    expect((await lapidaDe(attemptId)).payload).toEqual({
      estado: 'reversed',
      status: 'reversed',
      terminalKey: f.llaveTerminal,
      permisoEn: (lapida.payload as Record<string, unknown>).permisoEn,
      resultado: { descripcion: 'REVERSADA', operationNumber: 4321, reversadoEn: cuerpo.reversadoEn },
      staffId: f.staffId,
      resultadoEn: expect.any(String),
    })
    expect(await bitacora(attemptId)).toEqual([
      expect.objectContaining({
        action: 'PAYMENT_REVERSED_BY_TERMINAL',
        entity: 'PaymentAttempt',
        entityId: attemptId,
        staffId: f.staffId,
      }),
    ])
    // Lo que llegue después: un aviso aprobado nuevo del intento y el REST de la terminal.
    expect((await avisoBlumon(attemptId)).action).toBe('REVERSED_BY_TERMINAL')
    await expect(registradores.recordFastPayment(restBlumon(merchantAccountId, attemptId))).rejects.toMatchObject({
      code: 'ATTEMPT_REVERSED',
    })
    expect(await pagos()).toHaveLength(0)
    expect(alarmas()).toHaveLength(0)
  })

  it.each(['TX_014', 'TX_013'])('reversing + %s ⇒ reversed', async codigo => {
    const { attemptId, eventoId } = await permisoConAvisoRetenido()

    const res = await resultado(attemptId, { codigo, reversadoEn: new Date().toISOString() })

    expect(res.status).toBe(200)
    expect(res.body.estado).toBe('reversed')
    expect(await eventoDe(eventoId)).toMatchObject({ status: 'PROCESSED', errorReason: 'REVERSED_BY_TERMINAL' })
    expect(await pagos()).toHaveLength(0)
  })

  it.each([' tx_014', 'tx_013 ', ' Tx_014 '])('F1: reversing + %p (con espacios o minúsculas) ⇒ reversed, sin Payment', async codigo => {
    const { attemptId, eventoId } = await permisoConAvisoRetenido()

    const res = await resultado(attemptId, { codigo, reversadoEn: new Date().toISOString() })

    expect(res.status).toBe(200)
    expect(res.body.estado).toBe('reversed')
    expect(await eventoDe(eventoId)).toMatchObject({ status: 'PROCESSED', errorReason: 'REVERSED_BY_TERMINAL' })
    expect(await pagos()).toHaveLength(0)
  })

  it.each(['TX_007', 'TX_008', ' tx_008 '])('reversing + %p ⇒ reverse_failed y el aviso retenido crea el cobro ya', async codigo => {
    const { attemptId, requestId, eventoId } = await permisoConAvisoRetenido()

    const res = await resultado(attemptId, rechazado(codigo))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, attemptId, estado: 'reverse_failed', eventLogId: (await lapidaDe(attemptId)).id })
    const todos = await pagos()
    expect(todos).toHaveLength(1)
    expect(todos[0]).toMatchObject({ status: 'COMPLETED', idempotencyKey: attemptId, terminalPaymentRequestId: requestId })
    expect(todos[0].processorData).not.toHaveProperty('reversoIncierto')
    expect(await eventoDe(eventoId)).toMatchObject({ status: 'PROCESSED', paymentId: todos[0].id })
    expect((await lapidaDe(attemptId)).payload).toMatchObject({ estado: 'reverse_failed', resultado: { codigo } })
    expect(await bitacora(attemptId)).toHaveLength(0)
    expect(alarmas()).toHaveLength(0)
  })

  it.each([
    ['RQ_006', 'HOST NO DISPONIBLE'],
    ['68', 'TIMEOUT'],
    ['6', 'REINTENTE'],
    ['N0', 'REINTENTE'],
    ['TX_009', 'ORIGEN NO APROBADO'],
    [undefined, 'RECHAZADA'],
  ])(
    'F1: reversing + %p (no concluyente) ⇒ 200 reversing; la lápida no fija desenlace, el aviso sigue retenido y no nace dinero',
    async (codigo, descripcion) => {
      const { attemptId, eventoId } = await permisoConAvisoRetenido()
      const retenido = await eventoDe(eventoId)
      const lapida = await lapidaDe(attemptId)

      const res = await resultado(attemptId, { ...(codigo ? { codigo } : {}), descripcion, reversadoEn: new Date().toISOString() })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true, attemptId, estado: 'reversing', eventLogId: lapida.id })
      const despues = await lapidaDe(attemptId)
      expect(despues.payload).toMatchObject({ estado: 'reversing', status: 'reversing', ultimoNoConcluyente: { descripcion } })
      expect(despues.payload).not.toHaveProperty('resultado')
      expect(await eventoDe(eventoId)).toEqual(retenido)
      expect(await pagos()).toHaveLength(0)
      expect(await bitacora(attemptId)).toHaveLength(0)
    },
  )

  it('F1: RQ_006 y luego REVERSADA ⇒ reversed, el aviso queda sellado y no nace dinero', async () => {
    const { attemptId, eventoId } = await permisoConAvisoRetenido()

    expect((await resultado(attemptId, rechazado('RQ_006'))).body.estado).toBe('reversing')
    const res = await resultado(attemptId, reversada())

    expect(res.status).toBe(200)
    expect(res.body.estado).toBe('reversed')
    expect(await eventoDe(eventoId)).toMatchObject({ status: 'PROCESSED', errorReason: 'REVERSED_BY_TERMINAL', paymentId: null })
    expect(await pagos()).toHaveLength(0)
  })

  it('F1: RQ_006 y luego vence la ventana ⇒ reverse_unconfirmed y el cobro nace con reversoIncierto y 🚨', async () => {
    const { attemptId, eventoId } = await permisoConAvisoRetenido()
    expect((await resultado(attemptId, rechazado('RQ_006'))).body.estado).toBe('reversing')

    await pasaLaVentana(attemptId, eventoId)
    await pase()

    expect(await estadoDe(attemptId)).toBe('reverse_unconfirmed')
    const todos = await pagos()
    expect(todos).toHaveLength(1)
    expect(todos[0].processorData).toMatchObject({ reversoIncierto: true })
    expect(await eventoDe(eventoId)).toMatchObject({ status: 'PROCESSED', paymentId: todos[0].id })
    expect(alarmas()).toHaveLength(1)
  })

  it.each(['REVERSADA', 'TX_007'])(
    'F1: un no concluyente sobre una lápida ya final (%s) ⇒ 200 con el estado final, sin escribir',
    async primero => {
      const { attemptId } = await intentoVinculado()
      expect((await intencion(attemptId)).status).toBe(200)
      const final = await resultado(attemptId, cuerpoDe(primero))
      const guardada = await lapidaDe(attemptId)

      const res = await resultado(attemptId, rechazado('RQ_006'))

      expect(res.status).toBe(200)
      expect(res.body).toEqual(final.body)
      expect(await lapidaDe(attemptId)).toEqual(guardada)
    },
  )

  it('reverse_failed y la llamada al aviso falla ⇒ la red de 30 s lo crea en su siguiente pase', async () => {
    const { attemptId, eventoId } = await permisoConAvisoRetenido()
    const espia = jest.spyOn(avisoDeBlumon, 'reconcileBlumonEvent').mockRejectedValueOnce(new Error('se cayó la conexión'))
    let llamadas: unknown[][] = []
    const res = await resultado(attemptId, rechazado('TX_007')).finally(() => {
      llamadas = [...espia.mock.calls]
      espia.mockRestore()
    })

    expect(res.status).toBe(200)
    expect(res.body.estado).toBe('reverse_failed')
    expect(llamadas).toEqual([[eventoId, expect.anything()]])
    expect(await pagos()).toHaveLength(0)
    const retenido = await eventoDe(eventoId)
    expect(retenido.status).toBe('PENDING')
    expect(retenido.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now())

    await pase()

    const todos = await pagos()
    expect(todos).toHaveLength(1)
    expect(await eventoDe(eventoId)).toMatchObject({ status: 'PROCESSED', paymentId: todos[0].id })
  })

  it('F8: el barrido de lápidas falla (P1001) ⇒ el pase sigue y el aviso pendiente igual crea su cobro', async () => {
    const { attemptId, eventoId } = await permisoConAvisoRetenido()
    const espia = jest.spyOn(avisoDeBlumon, 'reconcileBlumonEvent').mockRejectedValueOnce(new Error('se cayó la conexión'))
    expect((await resultado(attemptId, rechazado('TX_007')).finally(() => espia.mockRestore())).body.estado).toBe('reverse_failed')
    expect(await pagos()).toHaveLength(0)
    const barrido = jest
      .spyOn(reverso, 'vencerLapidasSinRespuesta')
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 'prueba' }),
      )
    let llamadas = 0

    await pase().finally(() => {
      llamadas = barrido.mock.calls.length
      barrido.mockRestore()
    })

    expect(llamadas).toBe(1)
    const todos = await pagos()
    expect(todos).toHaveLength(1)
    expect(await eventoDe(eventoId)).toMatchObject({ status: 'PROCESSED', paymentId: todos[0].id })
    const falla = (logger.error as jest.Mock).mock.calls.find(c => String(c[0]).includes('[Blumon recon]'))
    expect(falla?.[1]).toMatchObject({ stack: expect.any(String) })
  })

  /**
   * F3: el receptor ya chocó con la lápida `reversing` (el registrador soltó el candado) y, justo antes de escribir la retención,
   * entra el resultado del reverso. La barrera es la re-retención de la solicitud, que el receptor pide antes de esa escritura.
   */
  async function resultadoAntesDeLaRetencion(attemptId: string, cuerpo: object) {
    const real = terminalPaymentService.retenerSolicitudLiberadaPorAprobacion.bind(terminalPaymentService)
    let res: Awaited<ReturnType<typeof resultado>> | undefined
    const espia = jest.spyOn(terminalPaymentService, 'retenerSolicitudLiberadaPorAprobacion').mockImplementationOnce(async entrada => {
      res = await resultado(attemptId, cuerpo)
      return real(entrada)
    })
    const r = await avisoBlumon(attemptId).finally(() => espia.mockRestore())
    return { r, res: exigirRespuesta(res) }
  }
  const exigirRespuesta = <T>(res: T | undefined): T => {
    expect(res).toBeDefined()
    return res as T
  }

  it('F3: REVERSADA sella el aviso PROCESSED antes de que el receptor atrasado lo retenga ⇒ el aviso sigue PROCESSED, sin dinero', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()
    expect((await intencion(attemptId)).body).toMatchObject({ estado: 'reversing' })

    const { r, res } = await resultadoAntesDeLaRetencion(attemptId, reversada())

    expect(res.body.estado).toBe('reversed')
    expect(r).toMatchObject({ action: 'REVERSED_BY_TERMINAL' })
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'PROCESSED', errorReason: 'REVERSED_BY_TERMINAL', paymentId: null })
    await pase()
    expect(await pagos()).toHaveLength(0)
  })

  it('F3: TX_007 llega antes de que el receptor atrasado retenga ⇒ la retención toma turno ya (no lápida + 5 min) y la red crea el cobro', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()
    expect((await intencion(attemptId)).body).toMatchObject({ estado: 'reversing' })

    const { r, res } = await resultadoAntesDeLaRetencion(attemptId, rechazado('TX_007'))

    expect(res.body.estado).toBe('reverse_failed')
    expect(r).toMatchObject({ action: 'HELD_BY_REVERSAL' })
    const retenido = await eventoDe(r.eventLogId)
    expect(retenido).toMatchObject({ status: 'PENDING', errorReason: 'HELD_BY_REVERSAL' })
    expect(retenido.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now())

    await pase()

    const todos = await pagos()
    expect(todos).toHaveLength(1)
    expect(todos[0].processorData).not.toHaveProperty('reversoIncierto')
    expect(await eventoDe(r.eventLogId)).toMatchObject({ status: 'PROCESSED', paymentId: todos[0].id })
  })

  it('F4: aviso retenido ⇒ la ventana retiene la solicitud (BANK_APPROVED_AWAITING_PAYMENT) ⇒ REVERSADA ⇒ la marca se quita y el cajero ya puede declarar', async () => {
    duena ??= await crearBackOffice(f)
    const { attemptId, requestId } = await permisoConAvisoRetenido()
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId, status: 'timeout', errorMessage: 'La terminal no pudo confirmar el resultado del cobro.' } as any,
      { socketId: 's', terminalId: f.serial, venueId: f.venueId },
    )
    expect(
      await terminalPaymentService.releaseUnprovenNegative(
        requestId,
        f.venueId,
        'WATCHDOG',
        new Date(Date.now() + UNPROVEN_NEGATIVE_WINDOW_MS + 1_000),
      ),
    ).toBe('HELD_BY_BANK_EVIDENCE')
    const fila = () => prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId } })
    expect(await fila()).toMatchObject({ status: 'TIMED_OUT', failureCode: 'BANK_APPROVED_AWAITING_PAYMENT', paymentId: null })

    const res = await resultado(attemptId, reversada())

    expect(res.body.estado).toBe('reversed')
    const suelta = await fila()
    expect(suelta).toMatchObject({ status: 'TIMED_OUT', failureCode: null, paymentId: null })
    expect(
      await prisma.activityLog.findMany({
        where: { entity: 'TerminalPaymentRequest', entityId: suelta.id, action: 'TERMINAL_PAYMENT_HOLD_RELEASED_BY_REVERSAL' },
      }),
    ).toHaveLength(1)
    const declaracion = await request(app)
      .post(ruta(attemptId, 'no-instrument-resolution'))
      .set('Authorization', `Bearer ${tokenDe(f.serial, duena)}`)
      .send({ requestId, resolutionId: randomUUID(), statement: 'NO_INSTRUMENT_PRESENTED', statementVersion: 1 })
    expect({ status: declaracion.status, code: declaracion.body.code }).toEqual({ status: 200, code: undefined })
    expect(await pagos()).toHaveLength(0)
  })

  it('sin lápida (la terminal no pudo pedir permiso) y el aviso ya creó el cobro + REVERSADA ⇒ contradiction, dinero intacto, 🚨 y ActivityLog', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()
    expect((await avisoBlumon(attemptId)).action).toBe('CONFIRMED')
    const [cobro] = await pagos()

    const res = await resultado(attemptId, reversada())

    expect(res.status).toBe(200)
    const lapida = await lapidaDe(attemptId)
    expect(res.body).toEqual({ success: true, attemptId, estado: 'contradiction', eventLogId: lapida.id, paymentId: cobro.id })
    // Nace en el estado final, con la forma de la Tarea 9 (H12).
    expect(lapida).toMatchObject({ type: TIPO_REVERSO, status: 'PROCESSED', attemptId, venueId: f.venueId, terminalId: terminalDelFixture })
    expect(lapida.payload).toMatchObject({ estado: 'contradiction', terminalKey: f.llaveTerminal, paymentId: cobro.id })
    const despues = await pagos()
    expect(despues).toHaveLength(1)
    expect(despues[0]).toMatchObject({ id: cobro.id, status: 'COMPLETED', amount: cobro.amount, tipAmount: cobro.tipAmount })
    expect(contradicciones()).toHaveLength(1)
    // F10: la alarma y la bitácora dicen en qué estado está el Payment (PENDING/FAILED no es «ya registrado»).
    expect(contradicciones()[0][1]).toMatchObject({ attemptId, paymentId: cobro.id, paymentStatus: 'COMPLETED' })
    expect(await bitacora(attemptId)).toEqual([
      expect.objectContaining({
        action: 'TERMINAL_REVERSAL_CONTRADICTION',
        entity: 'Payment',
        entityId: cobro.id,
        data: expect.objectContaining({ paymentStatus: 'COMPLETED' }),
      }),
    ])
    // Repetirlo contesta lo mismo y no escribe otra vez.
    expect((await resultado(attemptId, reversada())).body).toEqual(res.body)
    expect(await bitacora(attemptId)).toHaveLength(1)
  })

  it('dinero con la llave del intento guardado en OTRO negocio + REVERSADA ⇒ contradiction, pero la respuesta (y su reenvío) no publica ese paymentId', async () => {
    const ajeno = await crearFixture('rv10ajeno')
    try {
      const attemptId = randomUUID()
      // El pago de otro negocio con la misma llave nace ANTES del vínculo de este intento (la regla de la llave lo ve igual).
      const pagoAjeno = await registrador.recordFastPayment(ajeno.venueId, ajeno.registroDeLaTerminal({ attemptId }), ajeno.staffId)
      const solicitud = await f.solicitud()
      await vincular(solicitud.requestId, attemptId)

      const res = await resultado(attemptId, reversada())
      const reenvio = await resultado(attemptId, reversada())

      expect(res.status).toBe(200)
      const lapida = await lapidaDe(attemptId)
      expect(res.body).toEqual({ success: true, attemptId, estado: 'contradiction', eventLogId: lapida.id })
      expect(reenvio.status).toBe(200)
      expect(reenvio.body).toEqual(res.body)
      // Adentro sí queda: la lápida y la alarma lo llevan para que una persona lo encuentre.
      expect(lapida.payload).toMatchObject({ estado: 'contradiction', paymentId: pagoAjeno.id })
      expect(contradicciones()).toHaveLength(1)
      expect(contradicciones()[0][1]).toMatchObject({ attemptId, paymentId: pagoAjeno.id })
      // La bitácora de ESTE negocio no se liga al pago del otro.
      const [asiento] = await bitacora(attemptId)
      expect(asiento).toMatchObject({ action: 'TERMINAL_REVERSAL_CONTRADICTION', entity: 'ProviderEventLog', entityId: lapida.id })
      expect(JSON.stringify(asiento.data)).not.toContain(pagoAjeno.id)
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: pagoAjeno.id } })).toMatchObject({ status: 'COMPLETED' })
    } finally {
      await ajeno.destruir()
    }
  })

  it('sin lápida y sin Payment + REVERSADA ⇒ reversed (bloquea lo que llegue)', async () => {
    const { merchantAccountId } = await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()

    const res = await resultado(attemptId, reversada())

    expect(res.status).toBe(200)
    expect(res.body.estado).toBe('reversed')
    expect(await lapidaDe(attemptId)).toMatchObject({ id: res.body.eventLogId, terminalId: terminalDelFixture })
    expect((await avisoBlumon(attemptId)).action).toBe('REVERSED_BY_TERMINAL')
    await expect(registradores.recordFastPayment(restBlumon(merchantAccountId, attemptId))).rejects.toMatchObject({
      code: 'ATTEMPT_REVERSED',
    })
    expect(await pagos()).toHaveLength(0)
  })

  it('reverse_unconfirmed con el cobro incierto ya creado + REVERSADA ⇒ contradiction, dinero intacto', async () => {
    await f.conAfiliacionBlumon()
    const { attemptId } = await intentoVinculado()
    await sembrarLapida(attemptId, 'reversing', 6 * MIN)
    expect((await avisoBlumon(attemptId)).action).toBe('CONFIRMED')
    expect(await estadoDe(attemptId)).toBe('reverse_unconfirmed')
    const [cobro] = await pagos()
    expect(cobro.processorData).toMatchObject({ reversoIncierto: true })

    const res = await resultado(attemptId, reversada())

    expect(res.body).toMatchObject({ estado: 'contradiction', paymentId: cobro.id })
    expect(await pagos()).toEqual([expect.objectContaining({ id: cobro.id, status: 'COMPLETED', amount: cobro.amount })])
    expect(contradicciones()).toHaveLength(1)
  })

  it.each([
    ['REVERSADA', 'TX_007', 'reversed'],
    ['TX_007', 'REVERSADA', 'reverse_failed'],
  ])(
    'el mismo resultado dos veces ⇒ 200 igual; un resultado final distinto ⇒ 409 sin cambios (primero %s, luego %s)',
    async (primero, distinto, estado) => {
      const { attemptId } = await intentoVinculado()
      expect((await intencion(attemptId)).status).toBe(200)

      const uno = await resultado(attemptId, cuerpoDe(primero))
      const dos = await resultado(attemptId, cuerpoDe(primero))
      const guardada = await lapidaDe(attemptId)
      const choque = await resultado(attemptId, cuerpoDe(distinto))

      expect(uno.status).toBe(200)
      expect(uno.body.estado).toBe(estado)
      expect(dos.status).toBe(200)
      expect(dos.body).toEqual(uno.body)
      expect(choque.status).toBe(409)
      expect(choque.body).toMatchObject({ success: false, code: 'REVERSAL_RESULT_CONFLICT', estado })
      expect(await lapidaDe(attemptId)).toEqual(guardada)
      expect(await bitacora(attemptId)).toHaveLength(estado === 'reversed' ? 1 : 0)
    },
  )

  it('dos resultados iguales a la vez (barrera: el primero retenido dentro del candado) ⇒ los dos 200 con el mismo estado', async () => {
    const { attemptId } = await intentoVinculado()
    expect((await intencion(attemptId)).status).toBe(200)
    const barrera = await retenerLaEscrituraDeLaLapida(attemptId)
    const uno = resultado(attemptId, reversada())
    await barrera.escribiendo()
    const otro = resultado(attemptId, reversada())
    await barrera.enFila()
    await barrera.soltar()

    const [a, b] = await Promise.all([uno, otro])

    expect([a.status, b.status]).toEqual([200, 200])
    expect(a.body).toEqual(b.body)
    expect(a.body.estado).toBe('reversed')
    expect(await lapidasDel(attemptId)).toBe(1)
    expect(await bitacora(attemptId)).toHaveLength(1)
  })

  it('dos resultados distintos a la vez (REVERSADA y TX_007, con barrera) ⇒ uno 200 y el otro 409 REVERSAL_RESULT_CONFLICT; la lápida queda con el del primero', async () => {
    const { attemptId } = await intentoVinculado()
    expect((await intencion(attemptId)).status).toBe(200)
    const barrera = await retenerLaEscrituraDeLaLapida(attemptId)
    const uno = resultado(attemptId, reversada())
    await barrera.escribiendo()
    const otro = resultado(attemptId, rechazado('TX_007'))
    await barrera.enFila()
    await barrera.soltar()

    const [a, b] = await Promise.all([uno, otro])

    expect(a.status).toBe(200)
    expect(a.body.estado).toBe('reversed')
    expect(b.status).toBe(409)
    expect(b.body).toMatchObject({ code: 'REVERSAL_RESULT_CONFLICT', estado: 'reversed' })
    expect((await lapidaDe(attemptId)).payload).toMatchObject({ estado: 'reversed', resultado: { descripcion: 'REVERSADA' } })
    expect((await lapidaDe(attemptId)).payload).not.toHaveProperty('resultado.codigo')
  })

  it('permiso ⇒ se desasigna la afiliación de la terminal ⇒ resultado REVERSADA entra y queda reversed', async () => {
    const { attemptId } = await permisoConAvisoRetenido()
    await prisma.terminal.update({ where: { serialNumber: f.serial }, data: { assignedMerchantIds: [] } })
    await prisma.venuePaymentConfig.update({ where: { venueId: f.venueId }, data: { secondaryAccountId: null } })

    const res = await resultado(attemptId, reversada())

    expect(res.status).toBe(200)
    expect(res.body.estado).toBe('reversed')
    expect(await pagos()).toHaveLength(0)
  })

  it('resultado con el token de otra terminal ⇒ 404 aunque exista la lápida', async () => {
    const otra = await f.otraTerminal()
    const { attemptId } = await intentoVinculado()
    expect((await intencion(attemptId)).status).toBe(200)

    const res = await resultado(attemptId, reversada(), otra.serial)

    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ success: false, code: 'ATTEMPT_NOT_FOUND' })
    expect(res.body).not.toHaveProperty('estado')
    expect(await estadoDe(attemptId)).toBe('reversing')
  })

  it('sin lápida: intento con aviso de AngelPay ⇒ 409 ATTEMPT_NOT_BLUMON', async () => {
    const { attemptId } = await intentoVinculado()
    const r = await processAngelPayWebhook({
      payload: f.eventoAngelPay(attemptId),
      eventId: f.nuevoEventId(),
      merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
      retryDelaysMs: [0],
    })
    expect(r.action).toBe('CONFIRMED')

    const res = await resultado(attemptId, reversada())

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, code: 'ATTEMPT_NOT_BLUMON' })
    expect(await lapidaOpcional(attemptId)).toBeNull()
  })

  it('permiso (Nexgo) ⇒ ingreso durable del aviso de AngelPay ⇒ el receptor cae ⇒ resultado REVERSADA ⇒ el evento de AngelPay sigue PENDING y su worker (claimPendingAngelPayEvents + runClaimedAngelPayEvent) crea UN cobro', async () => {
    const { attemptId } = await intentoVinculado()
    expect((await intencion(attemptId)).body).toMatchObject({ estado: 'reversing' })
    // El receptor guarda el aviso bajo el candado del intento y muere antes de confirmarlo.
    const eventoId = await ingresarEventoDelIntento(attemptId, tx =>
      tx.providerEventLog.create({
        data: {
          provider: 'PAYMENT_PROCESSOR',
          eventId: `angelpay-${f.nuevoEventId()}`,
          type: 'send_transaction',
          payload: { ...f.eventoAngelPay(attemptId), _avoqado: { receivedByMerchantAccountId: f.merchantId } },
          venueId: f.venueId,
          status: 'PENDING',
          attemptId,
          nextAttemptAt: new Date(Date.now() - 1_000),
        },
        select: { id: true },
      }),
    )
    const antes = await eventoDe(eventoId)

    const res = await resultado(attemptId, reversada())

    expect(res.status).toBe(200)
    expect(res.body.estado).toBe('reversed')
    expect(await eventoDe(eventoId)).toEqual(antes)
    const claims = (await claimPendingAngelPayEvents({ now: new Date(), limit: 25 })).filter(c => c.id === eventoId)
    expect(claims).toHaveLength(1)
    expect(await runClaimedAngelPayEvent(claims[0])).toBe('PROCESSED')
    const todos = await pagos()
    expect(todos).toHaveLength(1)
    expect(todos[0]).toMatchObject({ idempotencyKey: attemptId, merchantAccountId: f.merchantId, status: 'COMPLETED' })
  })

  it.each([
    ['sin descripción ni código', { reversadoEn: new Date().toISOString() }],
    ['sin reversadoEn', { descripcion: 'REVERSADA' }],
    ['reversadoEn que no es fecha', { descripcion: 'REVERSADA', reversadoEn: 'ayer' }],
    ['una llave de más', { descripcion: 'REVERSADA', reversadoEn: new Date().toISOString(), terminalSerial: 'otra' }],
  ])('cuerpo %s ⇒ 400, sin lápida', async (_, cuerpo) => {
    const { attemptId } = await intentoVinculado()

    const res = await resultado(attemptId, cuerpo)

    expect(res.status).toBe(400)
    expect(await lapidaOpcional(attemptId)).toBeNull()
  })

  describe('carreras entre el vencimiento de la lápida (la red), el resultado y el registro del aviso', () => {
    it('vence ⇒ el aviso retenido registra (cobro incierto) ⇒ llega REVERSADA ⇒ contradiction, dinero intacto', async () => {
      const { attemptId, eventoId } = await permisoConAvisoRetenido()
      await pasaLaVentana(attemptId, eventoId)
      await pase()
      const [cobro] = await pagos()
      expect(cobro.processorData).toMatchObject({ reversoIncierto: true })
      expect(alarmas()).toHaveLength(1)

      const res = await resultado(attemptId, reversada())

      expect(res.body).toMatchObject({ estado: 'contradiction', paymentId: cobro.id })
      expect(await pagos()).toEqual([expect.objectContaining({ id: cobro.id, status: 'COMPLETED', amount: cobro.amount })])
      expect(contradicciones()).toHaveLength(1)
    })

    it('vence ⇒ llega REVERSADA antes del registro ⇒ reversed ⇒ el registro del aviso choca con la guarda: REVERSED_BY_TERMINAL, sin Payment', async () => {
      const { attemptId, eventoId } = await permisoConAvisoRetenido()
      await pasaLaVentana(attemptId, eventoId)
      const payload = (await eventoDe(eventoId)).payload as unknown as Parameters<typeof avisoDeBlumon.reconcileBlumonEvent>[1]
      // FIFO en el candado del intento: el aviso vence la lápida (1.º), el resultado entra (2.º) y el registro del aviso, que pide
      // el candado DESPUÉS de vencer, queda detrás del resultado.
      const candado = await retenerCandado(attemptId)
      const registro = avisoDeBlumon.reconcileBlumonEvent(eventoId, payload).catch((e: Error) => e)
      await candado.enFila(1)
      const res = resultado(attemptId, reversada())
      await candado.enFila(2)
      await candado.soltar()

      const [r, rr] = await Promise.all([registro, res])

      expect(rr.body.estado).toBe('reversed')
      expect(r).toMatchObject({ action: 'REVERSED_BY_TERMINAL' })
      expect(await pagos()).toHaveLength(0)
      expect(await eventoDe(eventoId)).toMatchObject({ status: 'PROCESSED', errorReason: 'REVERSED_BY_TERMINAL', paymentId: null })
      // H15: la alarma «se registra el cobro» no sale por un cobro que nunca nació.
      expect(alarmas()).toHaveLength(0)
    })

    it('REVERSADA gana al vencimiento ⇒ reversed; la red ya no vence nada y el aviso queda sellado', async () => {
      const { attemptId, eventoId } = await permisoConAvisoRetenido()
      await pasaLaVentana(attemptId, eventoId)
      const candado = await retenerCandado(attemptId)
      const res = resultado(attemptId, reversada())
      await candado.enFila(1)
      const red = vencerLapidasSinRespuesta(new Date()).catch((e: Error) => e)
      await candado.enFila(2)
      await candado.soltar()

      const [rr] = await Promise.all([res, red])
      await pase()

      expect(rr.body.estado).toBe('reversed')
      expect(await estadoDe(attemptId)).toBe('reversed')
      expect(await eventoDe(eventoId)).toMatchObject({ status: 'PROCESSED', errorReason: 'REVERSED_BY_TERMINAL', paymentId: null })
      expect(await pagos()).toHaveLength(0)
      expect(alarmas()).toHaveLength(0)
    })

    it('el vencimiento gana a TX_007 ⇒ reverse_unconfirmed y luego reverse_failed; un solo Payment', async () => {
      const { attemptId, eventoId } = await permisoConAvisoRetenido()
      await pasaLaVentana(attemptId)
      const candado = await retenerCandado(attemptId)
      const vence = vencerReversoSinRespuesta(attemptId, new Date()).catch((e: Error) => e)
      await candado.enFila(1)
      const res = resultado(attemptId, rechazado('TX_007'))
      await candado.enFila(2)
      await candado.soltar()

      const [vencio, rr] = await Promise.all([vence, res])
      await pase()

      expect(vencio).toBe(true)
      expect(rr.body.estado).toBe('reverse_failed')
      const todos = await pagos()
      expect(todos).toHaveLength(1)
      expect(await eventoDe(eventoId)).toMatchObject({ status: 'PROCESSED', paymentId: todos[0].id })
      expect(todos[0].processorData).not.toHaveProperty('reversoIncierto')
      expect(alarmas()).toHaveLength(0)
    })
  })
})
