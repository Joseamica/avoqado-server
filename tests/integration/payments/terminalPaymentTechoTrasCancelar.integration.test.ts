/**
 * D26 · el techo a «sigo cobrando» tras el cancel del POS (Testarudo, 22-nov-2026) — contra Postgres REAL.
 *
 * El incidente: la tablet canceló un cobro mandado a la terminal y la terminal (TPV 2.16.0 PAX y 2.20.0 Nexgo) contestó a CADA
 * sonda «sigo cobrando» (`ACTIVE`, `executionAlive: true`) durante 25 y 8 minutos: la pantalla del cobro había muerto con la app
 * viva y la propiedad quedó en memoria (el «residuo aceptado» de `RemotePaymentInbox.respuestaEnProceso`). El SERVIDOR retuvo la
 * RANURA todo ese tiempo (17 cobros nuevos rebotaron con `REJECTED_TERMINAL_BUSY`) y vetó el «no se cobró» de la cajera (409).
 *
 * La promesa (`docs/audit/2026-11-22-terminal-sigue-cobrando/promesa-servidor.md` del workspace), con la prioridad del founder
 * («que no se congele la terminal»): DOS relojes desde el PRIMER cancel.
 *  · RANURA, 30 s: con la terminal todavía contestando ACTIVE, sin intento abierto en 150 s y sin señal de dinero, el vigía la suelta
 *    (`TIMED_OUT/AUTO_RELEASED`, asiento propio). La terminal es el juez de su lector (su admisión rechaza la venta nueva si cobra).
 *  · VENTA, 150 s: el veto de la declaración de una persona se levanta. Nunca «no se cobró» por tiempo; un `Payment` tardío
 *    concilia la soltada con 🚨.
 *
 * El reloj: la base sella `cancelRequestedAt` y `probeActiveAt` con su `NOW()`. Para simular el paso del tiempo se corre el sello
 * del cancel hacia atrás (`cancelHace`) y la terminal vuelve a contestar ACTIVE (fresca), como hace en la calle cada 30 s.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { bloqueaLaRanura, desenlaceCanonico, terminalPaymentService } from '@/services/terminal-payment.service'
import { invalidarVenuesEstrictos } from '@/services/terminal-payment-strictness'
import { reconcileUncharged } from '@/services/tpv/uncharged-reconciliation.service'
import { TerminalPaymentWatchdogJob } from '@/jobs/terminal-payment-watchdog.job'
import { TerminalBusyError } from '@/errors/AppError'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { _olvidarTodoParaPruebas, registrarAvisoNoGuardado } from '@/services/tpv/avisosNoGuardados'
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
/** La RANURA: 30 s desde el primer cancel. La VENTA (el veto de la persona) y la ventana de un intento: 150 s. */
const TECHO_MS = 30_000
const VENTA_MS = 150_000
/** El asiento de este techo: la RANURA se soltó; la venta sigue pendiente de confirmar. */
const SOLTADA_POR_EL_TECHO = 'TERMINAL_PAYMENT_SLOT_RELEASED_CANCEL_CEILING'
/** Lo que contestaron la PAX 2.16.0 y la Nexgo 2.20.0 del incidente: «sigo cobrando», sin cerrar. */
const VIVA = { disposition: 'ACTIVE', executionAlive: true, closedForExecution: false }
const SOCKET = 'socket-tpv'
let f: Fixture
let directEmit: jest.Mock

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('techo')
})

beforeEach(() => {
  jest.clearAllMocks()
  directEmit = jest.fn((_evento: string, _payload: unknown, ack?: (err: Error | null) => void) => ack?.(new Error('lost ACK')))
  const socket = { emit: directEmit, timeout: () => ({ emit: directEmit }) }
  ;(socketManager.getServer as jest.Mock).mockReturnValue({
    sockets: { sockets: new Map([[SOCKET, socket]]) },
    to: () => ({ emit: jest.fn() }),
  })
  // La terminal del incidente: en línea, identificada y con las capacidades de la 2.16.0 / 2.20.0.
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
  await prisma.venue.update({ where: { id: f.venueId }, data: { terminalPaymentStrictEnabled: false, terminalPaymentStrictSince: null } })
  await invalidarVenuesEstrictos()
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
const asientos = (entityId: string) =>
  prisma.activityLog.findMany({ where: { venueId: f.venueId, action: SOLTADA_POR_EL_TECHO, entityId } })
const declarar = (requestId: string) =>
  reconcileUncharged(
    { venueId: f.venueId, requestId, actorStaffId: f.staffId, source: 'MOBILE' },
    { requestId, resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
  )
/** Corre hacia atrás el sello del cancel: «la tablet canceló hace `ms`». */
const cancelHace = (requestId: string, ms: number) =>
  prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "cancelRequestedAt" = (NOW() AT TIME ZONE 'UTC') - (${Math.round(ms / 1000)}::int * interval '1 second') WHERE "requestId" = ${requestId}`
/** Corre hacia atrás el último «sigo cobrando»: «la terminal dejó de contestar hace `ms`». */
const activaHace = (requestId: string, ms: number) =>
  prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "probeActiveAt" = (NOW() AT TIME ZONE 'UTC') - (${Math.round(ms / 1000)}::int * interval '1 second') WHERE "requestId" = ${requestId}`
/** Un intento que la terminal abrió (Nexgo: lo anuncia ≤ 4 s antes de tocar el SDK) hace `ms`. */
const intentoHace = async (requestId: string, ms: number) => {
  const attemptId = randomUUID()
  await prisma.terminalPaymentAttemptLink.create({
    data: { attemptId, requestId, venueId: f.venueId, terminalId: f.llaveTerminal, createdAt: new Date(Date.now() - ms) },
  })
  return attemptId
}
/**
 * La entrega DURABLE de una TPV 2.16.0 / 2.20.0: anuncia la capacidad de ejecución v1 (la que veta la declaración hoy). Con
 * `executionVersion: null`, la de una TPV 2.12.5 / 2.13.x (sin la capacidad).
 */
const entrega = (executionVersion: number | null = 1) => ({
  protocol: 'DURABLE',
  ackVersion: 1,
  cancelDispositionVersion: 2,
  probeVersion: 1,
  ...(executionVersion === null ? {} : { executionVersion }),
  socketId: SOCKET,
  at: new Date().toISOString(),
  replay: false,
})
/** El POST del POS por la admisión real; devuelve el resultado o el error sin tumbar la prueba. */
const enviar = (orderId: string) => {
  const requestId = randomUUID()
  const resultado = terminalPaymentService
    .sendPaymentToTerminal({ requestId, venueId: f.venueId, terminalId: f.serial, orderId, amountCents: 10000, requestedBy: f.staffId })
    .then(
      v => v as unknown,
      (e: unknown) => e,
    )
  return { requestId, resultado }
}
const seEntrego = (requestId: string) =>
  directEmit.mock.calls.some(([evento, payload]) => evento === 'terminal:payment_request' && (payload as any)?.requestId === requestId)

/**
 * El incidente hasta la duda, por las rutas reales: la solicitud llegó a la terminal, la tablet cancela, la terminal contesta
 * «sigo» a la disposición del cancel, el vigía la deja UNKNOWN a los 30 s y la sonda sigue diciendo «sigo».
 */
async function incidente(over: { acknowledgedAt?: Date | null; executionVersion?: number | null } = {}) {
  const venta = await f.nuevaVenta(100)
  const solicitud = await f.solicitud({
    orderId: venta.id,
    status: 'SENT',
    acknowledgedAt: 'acknowledgedAt' in over ? over.acknowledgedAt : new Date(),
    lastDeliveredAt: new Date(),
    deliveryProvenance: { deliveries: [entrega(over.executionVersion === undefined ? 1 : over.executionVersion)] },
  })
  const { requestId } = solicitud
  const cancel = await terminalPaymentService.cancelPayment(f.serial, requestId, 'Cancelado desde el POS', f.venueId)
  expect(cancel.cancelIntent).toBe('RECORDED')
  expect(await svc.handleCancelDispositionFromSocket({ requestId, ...VIVA }, tpv())).toBe(true)
  await terminalPaymentService.reconcileStaleRequests(new Date(Date.now() + 31_000))
  expect(await fila(requestId)).toMatchObject({ status: 'UNKNOWN', cancelDisposition: 'ACTIVE' })
  await sigoCobrando(requestId)
  return { requestId, venta }
}

/** Ya pasó el techo de la RANURA (o el de la VENTA): el cancel fue hace 31 s (o 151 s) y la terminal acaba de volver a decir «sigo». */
async function pasaElTecho(requestId: string, ms = TECHO_MS + 1_000) {
  await cancelHace(requestId, ms)
  await sigoCobrando(requestId)
}
const pasaElTechoDeLaVenta = (requestId: string) => pasaElTecho(requestId, VENTA_MS + 1_000)

describe('D26 · RANURA: 30 s después del cancel del POS, «sigo cobrando» sin intento reciente ni dinero no la retiene', () => {
  it.each(['heredado', 'estricto'] as const)(
    '%s: el incidente — a los 30 s la ranura se suelta (TIMED_OUT/AUTO_RELEASED, un asiento), la OTRA venta entra y la MISMA rebota',
    async regimen => {
      if (regimen === 'estricto') {
        await prisma.venue.update({
          where: { id: f.venueId },
          data: { terminalPaymentStrictEnabled: true, terminalPaymentStrictSince: new Date(0) },
        })
        await invalidarVenuesEstrictos()
      }
      const { requestId, venta } = await incidente()
      const sellado = (await fila(requestId)).cancelRequestedAt
      expect(sellado).not.toBeNull()
      // El cancel repetido (la tablet lo mandó 6 y 15 veces) no mueve el origen del reloj.
      await terminalPaymentService.cancelPayment(f.serial, requestId, 'otra vez', f.venueId)
      expect((await fila(requestId)).cancelRequestedAt).toEqual(sellado)

      await pasaElTecho(requestId)
      expect(await ocupada()).toBe(true)
      await vigia()

      const r = await fila(requestId)
      expect(r).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', paymentId: null })
      expect(desenlaceCanonico(r).outcome).toBe('UNRESOLVED')
      expect(bloqueaLaRanura(r, new Map())).toBe(false)
      expect(bloqueaLaRanura(r, new Map([[f.venueId, new Date(0)]]))).toBe(false)
      expect(await ocupada()).toBe(false)
      expect(await ventaCercada(venta.id)).toBe(true)
      // El POS que consulta ve «terminal libre, venta en duda»: nunca «no se cobró».
      const estado = await terminalPaymentService.getPaymentStatus(requestId, f.venueId)
      expect(estado).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', outcome: 'UNRESOLVED', cancelDisposition: null })
      expect(JSON.stringify(r.resultJson ?? null)).not.toMatch(/no se cobr|volver a cobrar/i)
      // Un asiento, aunque el vigía vuelva a pasar.
      await vigia()
      const [asiento] = await asientos(r.id)
      expect(await asientos(r.id)).toHaveLength(1)
      expect(asiento.data).toMatchObject({ requestId, orderId: venta.id, techoMs: TECHO_MS, ventanaDeEjecucionMs: VENTA_MS })

      // El cobro del siguiente cliente (otra venta) se ENTREGA a la terminal: la admisión ya no la ve ocupada.
      const otra = await f.nuevaVenta(100)
      const siguiente = enviar(otra.id)
      expect(await siguiente.resultado).not.toBeInstanceOf(TerminalBusyError)
      expect(seEntrego(siguiente.requestId)).toBe(true)

      // La MISMA venta no se puede volver a cobrar con tarjeta (en ninguna terminal): sigue cercada.
      const misma = enviar(venta.id)
      expect(await misma.resultado).toBeInstanceOf(TerminalBusyError)
      expect(seEntrego(misma.requestId)).toBe(false)
    },
  )

  it('antes de los 30 s no se suelta nada', async () => {
    const { requestId } = await incidente()
    await cancelHace(requestId, TECHO_MS - 10_000)
    await sigoCobrando(requestId)
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'UNKNOWN' })
    expect(await ocupada()).toBe(true)
    expect(await asientos((await fila(requestId)).id)).toHaveLength(0)
  })

  it('sin cancel del POS el techo no aplica, aunque la terminal diga «sigo» mucho tiempo', async () => {
    const venta = await f.nuevaVenta(100)
    const { requestId } = await f.solicitud({
      orderId: venta.id,
      status: 'SENT',
      acknowledgedAt: new Date(),
      lastDeliveredAt: new Date(),
      expiresAt: new Date(Date.now() - 60 * 60_000),
      deliveryProvenance: { deliveries: [entrega()] },
    })
    await terminalPaymentService.reconcileStaleRequests(new Date())
    await sigoCobrando(requestId)
    await vigia()
    const r = await fila(requestId)
    expect(r).toMatchObject({ status: 'UNKNOWN', cancelRequestedAt: null })
    expect(await ocupada()).toBe(true)
  })

  it('una terminal que dejó de contestar (último «sigo» hace más de 2 min) no entra: le queda el reloj de 20 min', async () => {
    const { requestId } = await incidente()
    await cancelHace(requestId, VENTA_MS + 60_000)
    await activaHace(requestId, 3 * 60_000)
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'UNKNOWN' })
    expect(await ocupada()).toBe(true)
  })

  it('un intento abierto en los últimos 150 s es ejecución real: retiene la ranura y el veto; pasado eso, se suelta', async () => {
    const { requestId } = await incidente()
    await cancelHace(requestId, VENTA_MS + 60_000)
    await intentoHace(requestId, 60_000) // la Nexgo abrió un intento hace 1 min
    await sigoCobrando(requestId)
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'UNKNOWN' })
    expect(await ocupada()).toBe(true)

    await prisma.terminalPaymentAttemptLink.updateMany({
      where: { requestId },
      data: { createdAt: new Date(Date.now() - VENTA_MS - 1_000) },
    })
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
  })

  it('el aviso APROBADO del banco de un intento ligado retiene: el techo no suelta con dinero a la vista', async () => {
    const { requestId } = await incidente()
    const attemptId = await intentoHace(requestId, 10 * 60_000) // abierto ANTES del cancel
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        eventId: `angelpay-${f.nuevoEventId()}`,
        type: 'send_transaction',
        venueId: f.venueId,
        attemptId,
        payload: f.eventoAngelPay(attemptId),
        status: 'PROCESSED',
      },
    })
    await pasaElTecho(requestId)
    await vigia()
    const r = await fila(requestId)
    expect(r.status).not.toBe('TIMED_OUT')
    expect(await asientos(r.id)).toHaveLength(0)
  })

  it('Codex r1 #4: un APROBADO firmado que el receptor no pudo guardar (sólo en memoria) retiene la ranura y el veto', async () => {
    const { requestId } = await incidente()
    const attemptId = await intentoHace(requestId, 10 * 60_000)
    registrarAvisoNoGuardado({ merchantAccountId: f.merchantId, attemptId, posibleDinero: true })
    await pasaElTechoDeLaVenta(requestId)
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'UNKNOWN' })
    expect(await ocupada()).toBe(true)
  })

  it('un Payment ya registrado se concilia en vez de soltar', async () => {
    const { requestId, venta } = await incidente()
    await pasaElTecho(requestId)
    const pago = await pagoDeLaSolicitud(requestId, venta.id)
    expect(await svc.soltarRanuraPorTechoTrasCancelar({ requestId, venueId: f.venueId }, new Date())).toBe('RECONCILED')
    expect(await fila(requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id })
    expect(await asientos((await fila(requestId)).id)).toHaveLength(0)
  })

  it('un Payment que llega DESPUÉS de soltar concilia la venta a COMPLETED y grita 🚨 — también pasados los 30 min del barrido', async () => {
    const { requestId, venta } = await incidente()
    await pasaElTecho(requestId)
    await vigia()
    const soltada = await fila(requestId)
    expect(soltada).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })

    // Codex r1 #3: la cola de la terminal registra 40 min después; el barrido de las soltadas sigue 3 h desde el cancel.
    await prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "updatedAt" = (NOW() AT TIME ZONE 'UTC') - interval '40 minutes',
      "cancelRequestedAt" = (NOW() AT TIME ZONE 'UTC') - interval '41 minutes' WHERE "id" = ${soltada.id}`
    const pago = await pagoDeLaSolicitud(requestId, venta.id)
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id })
    const alarmas = (logger.error as jest.Mock).mock.calls.filter(
      ([m]) => String(m).includes('🚨') && String(m).includes('check the order for a double charge'),
    )
    expect(alarmas.length).toBeGreaterThan(0)
  })
})

describe('D26 · VENTA: la persona puede declarar «no se cobró» 150 s después del cancel, con la ranura ya suelta', () => {
  it('a los 30 s la ranura se suelta pero el veto sigue; a los 150 s la persona ya declara (FAILED/OPERATOR_RECONCILED_NO_CHARGE)', async () => {
    const { requestId, venta } = await incidente()
    // Hoy (el incidente): con la ranura apartada, la declaración rebota.
    await expect(declarar(requestId)).rejects.toMatchObject({ code: 'EXECUTION_STILL_ACTIVE' })

    await pasaElTecho(requestId)
    await vigia()
    expect(await ocupada()).toBe(false)
    // Ranura suelta a los 30 s, pero la VENTA conserva su veto hasta los 150 s.
    await expect(declarar(requestId)).rejects.toMatchObject({ code: 'EXECUTION_STILL_ACTIVE' })

    await pasaElTechoDeLaVenta(requestId) // la terminal sigue diciendo «sigo» después de soltar: no cambia nada
    await expect(declarar(requestId)).resolves.toMatchObject({ kind: 'UNCHARGED_VERIFIED' })
    expect(await fila(requestId)).toMatchObject({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' })
    expect(await ventaCercada(venta.id)).toBe(false)
  })

  it('un intento abierto en los últimos 150 s conserva el veto de la persona aunque la ranura ya esté suelta', async () => {
    const { requestId } = await incidente()
    const attemptId = await intentoHace(requestId, VENTA_MS + 30_000)
    await pasaElTechoDeLaVenta(requestId)
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
    await prisma.terminalPaymentAttemptLink.updateMany({ where: { attemptId }, data: { createdAt: new Date(Date.now() - 60_000) } })
    await expect(declarar(requestId)).rejects.toMatchObject({ code: 'EXECUTION_STILL_ACTIVE' })
  })

  it('una ranura soltada SIN cancel del POS (el reloj de 20 min) conserva el veto de la TPV v1, como hoy', async () => {
    const venta = await f.nuevaVenta(100)
    const { requestId } = await f.solicitud({
      orderId: venta.id,
      status: 'TIMED_OUT',
      failureCode: 'AUTO_RELEASED',
      acknowledgedAt: new Date(),
      lastDeliveredAt: new Date(),
      expiresAt: new Date(Date.now() - 60 * 60_000),
      deliveryProvenance: { deliveries: [entrega()] },
    })
    await sigoCobrando(requestId)
    await expect(declarar(requestId)).rejects.toMatchObject({ code: 'EXECUTION_STILL_ACTIVE' })
  })

  it('Codex r2 #2: una TPV sin `executionVersion` (2.12.5 / 2.13.x) que dijo «sigo» tras el cancel también espera los 150 s de la VENTA', async () => {
    const { requestId, venta } = await incidente({ executionVersion: null })
    await pasaElTecho(requestId)
    await vigia()
    // La RANURA sí se suelta a los 30 s (la terminal no se congela)…
    expect(await fila(requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
    expect(await ocupada()).toBe(false)
    // …pero la VENTA no se abre a los ~40 s: el SDK todavía puede aprobar ese cobro.
    await expect(declarar(requestId)).rejects.toMatchObject({ code: 'EXECUTION_STILL_ACTIVE' })
    expect(await ventaCercada(venta.id)).toBe(true)

    await pasaElTechoDeLaVenta(requestId)
    await expect(declarar(requestId)).resolves.toMatchObject({ kind: 'UNCHARGED_VERIFIED' })
    expect(await fila(requestId)).toMatchObject({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' })
    expect(await ventaCercada(venta.id)).toBe(false)
  })

  it('control · la excepción del 3-nov sigue: SIN cancel del POS, una TPV sin `executionVersion` con la ranura ya suelta no veta a la persona', async () => {
    const venta = await f.nuevaVenta(100)
    const { requestId } = await f.solicitud({
      orderId: venta.id,
      status: 'TIMED_OUT',
      failureCode: 'AUTO_RELEASED',
      acknowledgedAt: new Date(),
      lastDeliveredAt: new Date(),
      expiresAt: new Date(Date.now() - 60 * 60_000),
      deliveryProvenance: { deliveries: [entrega(null)] },
    })
    await sigoCobrando(requestId)
    await expect(declarar(requestId)).resolves.toMatchObject({ kind: 'UNCHARGED_VERIFIED' })
  })
})

/** El COMPLETED de la terminal etiquetado con la solicitud y atribuido a ESTA terminal (el registro de la TPV). */
async function pagoDeLaSolicitud(requestId: string, orderId: string) {
  const terminal = await prisma.terminal.findUniqueOrThrow({ where: { serialNumber: f.serial }, select: { id: true } })
  return prisma.payment.create({
    data: {
      venueId: f.venueId,
      orderId,
      amount: new Prisma.Decimal(100),
      tipAmount: new Prisma.Decimal(0),
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      source: 'TPV',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: 100,
      terminalId: terminal.id,
      processorData: { terminalPaymentRequestId: requestId, deviceSerialNumber: f.serial },
    },
  })
}
