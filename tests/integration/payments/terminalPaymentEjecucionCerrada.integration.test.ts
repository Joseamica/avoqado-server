/**
 * A4b · S2 + S2-bis («ninguna duda de un cobro de la tablet sin salida», decisión del founder del 21-oct-2026) — contra Postgres
 * REAL.
 *
 * S2: cuando la TERMINAL NUEVA acredita «cerré esa solicitud y no tengo ejecución viva» (`executionClosedAt`, A3), la RANURA de
 * la terminal se suelta sola a los 10 s, con el MISMO estado y código del destrabe de 20 min (`TIMED_OUT / AUTO_RELEASED`), sin
 * esperar el latido. La VENTA sigue en duda (UNRESOLVED) hasta que una persona declare «no se cobró» (E2; el mesero con PIN de
 * gerente) o el dinero la concilie por el cierre común. El servidor NUNCA escribe «no se cobró» por el silencio del banco en
 * este camino. La dispara un temporizador en proceso; el watchdog es la red tras un reinicio.
 * S2-bis: una fila RETENIDA por dinero pendiente de conciliar con el cese acreditado suelta la RANURA de inmediato; la VENTA
 * sigue cercada.
 * Flota vieja «B» (founder, 20-oct): sin `executionClosedAt` (TPV 2.12.5) nada cambia: el reloj de 20 min con latido de siempre.
 *
 * El reloj: sólo `Date` se simula (los temporizadores, `nextTick` y las promesas siguen reales — Prisma los usa). El temporizador
 * de 10 s se CAPTURA (no se espera de verdad) y se dispara a mano tras avanzar el reloj.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { _olvidarTodoParaPruebas } from '@/services/tpv/avisosNoGuardados'
import { bloqueaLaRanura, desenlaceCanonico, terminalPaymentService } from '@/services/terminal-payment.service'
import { reconcileUncharged } from '@/services/tpv/uncharged-reconciliation.service'
import { TerminalPaymentWatchdogJob } from '@/jobs/terminal-payment-watchdog.job'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { getContext, runWithContext } from '@/observability/executionContext'
import { terminalIdentityKey } from '@/utils/terminalSerial'
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
/** El asiento de S2: la RANURA se soltó por el cese acreditado; la venta sigue pendiente de confirmar. */
const SOLTADA = 'TERMINAL_PAYMENT_SLOT_RELEASED_EXECUTION_CLOSED'
/** El asiento del S2 financiero que A4b borró («no se cobró» por silencio): no puede volver a aparecer. */
const NEGATIVO_POR_SILENCIO = 'TERMINAL_PAYMENT_RELEASED_NO_BANK_TRACE'
const CERRADA = { disposition: 'ACTIVE', executionAlive: false, closedForExecution: true }
const ESTRICTO_DESDE_SIEMPRE = (venueId: string) => new Map([[venueId, new Date(0)]])
let f: Fixture

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('ejecerr')
})

/** Sólo `Date` simulado (el patrón de `activacion.reloj.test.ts`): Prisma sigue con sus temporizadores reales. */
const relojEn = (ms: number) =>
  jest.useFakeTimers({
    now: ms,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  })

/** Los temporizadores de 10 s capturados: el de verdad se programa a 24 h (nunca dispara en la prueba) para ver su `unref`. */
type Programado = { fn: () => unknown; handle: NodeJS.Timeout }
let programados: Programado[] = []
let espia: jest.SpyInstance
const setTimeoutReal = global.setTimeout

beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
  programados = []
  espia = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: (...a: unknown[]) => unknown, ms?: number, ...args: unknown[]) => {
    if (ms === 10_000) {
      const handle = setTimeoutReal(() => undefined, 86_400_000)
      programados.push({ fn: fn as () => unknown, handle })
      return handle
    }
    return setTimeoutReal(fn, ms, ...args)
  }) as unknown as typeof setTimeout)
})
afterEach(async () => {
  jest.useRealTimers()
  espia.mockRestore()
  await _olvidarTodoParaPruebas()
  for (const p of programados) clearTimeout(p.handle)
  for (const mapa of ['ventanasProgramadas', 'liberacionesTrasCierre'] as const) {
    const m = svc[mapa] as Map<string, NodeJS.Timeout> | undefined
    for (const t of m?.values() ?? []) clearTimeout(t)
    m?.clear()
  }
  svc.cierreCursor = null
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await prisma.terminal.update({ where: { serialNumber: f.serial }, data: { assignedMerchantIds: [], lastHeartbeat: null } })
  await f.limpiar()
})
afterAll(() => f.destruir())

const fila = (requestId: string) => exigir(prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))
const pagos = () => prisma.payment.findMany({ where: { venueId: f.venueId } })
const asientos = (entityId: string, action = SOLTADA) => prisma.activityLog.findMany({ where: { venueId: f.venueId, action, entityId } })
const negativosPorSilencio = () => prisma.activityLog.count({ where: { venueId: f.venueId, action: NEGATIVO_POR_SILENCIO } })
const conCapacidad = () => ({ socketId: 'socket-nuevo', terminalId: f.serial, venueId: f.venueId, terminalPaymentExecutionVersion: 1 })
const sinCapacidad = () => ({ socketId: 'socket-viejo', terminalId: f.serial, venueId: f.venueId })
const ocupada = () => terminalPaymentService.isTerminalBusy(f.llaveTerminal, f.venueId)
const ventaCercada = (orderId: string) => terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, orderId)
const consultar = (requestId: string) => terminalPaymentService.getPaymentStatus(requestId, f.venueId)
const soltar = (requestId: string, now: Date, origen: 'TIMER' | 'WATCHDOG' = 'WATCHDOG') =>
  svc.soltarRanuraTrasCierre({ requestId, venueId: f.venueId }, now, origen) as Promise<string>
const vigia = () => new TerminalPaymentWatchdogJob().run()
const declarar = (requestId: string, actorStaffId: string, extra: Record<string, unknown> = {}) =>
  reconcileUncharged(
    { venueId: f.venueId, requestId, actorStaffId, source: 'MOBILE' },
    { requestId, resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1, ...extra },
  )

/** Las cuentas de la terminal (`assignedMerchantIds`) y cuáles tienen el aviso del banco comprobado. */
async function cuentas(ids: string[] = [f.merchantId], comprobadas: string[] = ids) {
  await prisma.terminal.update({ where: { serialNumber: f.serial }, data: { assignedMerchantIds: ids } })
  for (const id of new Set([...ids, ...comprobadas])) {
    await prisma.merchantAccount.update({
      where: { id },
      data: { angelpayWebhookLastReceivedAt: comprobadas.includes(id) ? new Date(Date.now() - 60_000) : null, active: true },
    })
  }
}

/** Una entrega DURABLE tal como la graba el servidor. */
const entrega = () => ({
  protocol: 'DURABLE',
  ackVersion: 1,
  cancelDispositionVersion: 1,
  probeVersion: 1,
  socketId: 'socket-viejo',
  at: new Date().toISOString(),
  replay: false,
})

/** Una solicitud del POS entregada (DURABLE) y en duda, con su orden y su intento vinculado. */
async function enDuda(over: Record<string, unknown> = {}) {
  const venta = await f.nuevaVenta(100)
  const solicitud = await f.solicitud({
    orderId: venta.id,
    status: 'UNKNOWN',
    failureCode: 'ACK_TIMEOUT',
    acknowledgedAt: new Date(),
    expiresAt: new Date(Date.now() - 60_000),
    deliveryProvenance: { deliveries: [entrega()] },
    ...over,
  })
  const attemptId = randomUUID()
  await prisma.terminalPaymentAttemptLink.create({
    data: { attemptId, requestId: solicitud.requestId, venueId: f.venueId, terminalId: (over.terminalId as string) ?? f.llaveTerminal },
  })
  return { solicitud, venta, attemptId }
}

/** La TPV nueva contesta la sonda: «cerré esa solicitud y no tengo ejecución viva» (A3). Devuelve el instante del sello. */
async function cerrarEjecucion(requestId: string): Promise<number> {
  expect(await svc.handleProbeResultFromSocket({ requestId, ...CERRADA }, conCapacidad())).toBe(true)
  const sellada = await fila(requestId)
  expect(sellada.executionClosedAt).not.toBeNull()
  return sellada.executionClosedAt!.getTime()
}

/**
 * Lo que S2 tiene que dejar SIEMPRE: la ranura libre (en los dos regímenes), la venta en duda y cercada, ningún «no se cobró»
 * (ni el código del negativo por silencio ni su texto), y UN asiento de la ranura soltada.
 */
async function ranuraSoltadaConLaVentaEnDuda(requestId: string, orderId: string) {
  const r = await fila(requestId)
  expect(r).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', paymentId: null })
  expect(r.executionClosedAt).not.toBeNull()
  expect(bloqueaLaRanura(r, new Map())).toBe(false)
  expect(bloqueaLaRanura(r, ESTRICTO_DESDE_SIEMPRE(f.venueId))).toBe(false)
  expect(desenlaceCanonico(r).outcome).toBe('UNRESOLVED')
  expect(await ocupada()).toBe(false)
  expect(await ventaCercada(orderId)).toBe(true)
  const estado = await consultar(requestId)
  expect(estado).toMatchObject({ status: 'TIMED_OUT', outcome: 'UNRESOLVED' })
  expect(JSON.stringify({ estado, resultJson: r.resultJson })).not.toMatch(/NO_BANK_TRACE|no se cobr|volver a cobrar/i)
  expect(await asientos(r.id)).toHaveLength(1)
  expect(await negativosPorSilencio()).toBe(0)
  return r
}

/** Soltada por S2 (sin dinero de por medio): la RANURA libre y la venta en duda. */
async function soltadaTrasCierre(over: Record<string, unknown> = {}) {
  const r = await enDuda(over)
  const cerradaEn = await cerrarEjecucion(r.solicitud.requestId)
  expect(await soltar(r.solicitud.requestId, new Date(cerradaEn + 10_000))).toBe('RELEASED')
  await ranuraSoltadaConLaVentaEnDuda(r.solicitud.requestId, r.venta.id)
  return r
}

/** El aviso de AngelPay tal como lo guarda el receptor, del serial de la terminal del fixture. */
const avisoDelSerial = (attemptId: string | null, over: Record<string, unknown> = {}) =>
  prisma.providerEventLog.create({
    data: {
      provider: 'PAYMENT_PROCESSOR',
      eventId: `angelpay-${f.nuevoEventId()}`,
      type: 'send_transaction',
      venueId: f.venueId,
      attemptId,
      payload: f.eventoAngelPay(attemptId ?? undefined),
      status: 'PROCESSED',
      ...over,
    },
  })

/** El Payment PENDING de conciliación que el registrador guarda con la LLAVE del intento y sin puntero a la solicitud (F1). */
const dineroPorLaLlave = (orderId: string, attemptId: string) =>
  prisma.payment.create({
    data: {
      venueId: f.venueId,
      orderId,
      amount: 100,
      method: 'CREDIT_CARD',
      status: 'PENDING',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: 100,
      idempotencyKey: attemptId,
      processorData: { reconciliation: { kind: 'POSSIBLE_REFERENCE_COLLISION' } },
    },
  })

/** Un COMPLETED de la terminal (atribuido a ESTA terminal, por la llave del intento) cuyo propio cierre de la fila no llegó. */
async function pagoYaRegistrado(orderId: string, attemptId: string) {
  const terminal = await prisma.terminal.findUniqueOrThrow({ where: { serialNumber: f.serial }, select: { id: true } })
  return prisma.payment.create({
    data: {
      venueId: f.venueId,
      orderId,
      amount: 100,
      tipAmount: 0,
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      source: 'TPV',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: 100,
      idempotencyKey: attemptId,
      terminalId: terminal.id,
      processorData: { deviceSerialNumber: f.serial },
    },
  })
}

/** El webhook APROBADO de AngelPay de ese intento, por el receptor real. */
async function webhook(attemptId: string) {
  return processAngelPayWebhook({
    payload: f.eventoAngelPay(attemptId),
    eventId: f.nuevoEventId(),
    merchantAccount: { id: f.merchantId, externalMerchantId: f.merchantExternalId },
    retryDelaysMs: [0],
  })
}

/** Las 🚨 del log que contienen ese texto. */
const alarmas = (texto: string) =>
  (logger.error as jest.Mock).mock.calls.filter(([m]) => String(m).includes('🚨') && String(m).includes(texto))
/** La alarma de «revisa que la orden no quede pagada dos veces» (barrido de las soltadas) o la de «ya estaba soltada». */
const alarmasDeDobleCobro = () => [...alarmas('check the order for a double charge'), ...alarmas('already-TIMED_OUT')]

describe('S2 · con el cese acreditado se suelta la RANURA a los 10 s; la VENTA sigue en duda', () => {
  it('P1 cese certificado + 10 s ⇒ ranura libre y desenlace UNRESOLVED: TIMED_OUT/AUTO_RELEASED, nunca FAILED ni NO_BANK_TRACE, un asiento', async () => {
    const { solicitud, venta } = await enDuda()
    const { requestId } = solicitud
    expect(await ocupada()).toBe(true)
    expect(await ventaCercada(venta.id)).toBe(true)
    // El POS sigue esperando en memoria (long-poll, hasta 5 min): al soltar la ranura recibe lo que el servidor sabe — la terminal
    // está libre y la venta necesita confirmación (`timeout` = sin desenlace) —, nunca «no se cobró».
    const espera = {
      resolve: jest.fn(),
      reject: jest.fn(),
      timeout: setTimeoutReal(() => undefined, 1),
      requestId,
      terminalId: f.llaveTerminal,
      venueId: f.venueId,
    }
    svc.pendingPayments.set(requestId, espera)

    // La respuesta de la sonda llega en el contexto del socket de la terminal (regla 8: el destrabe lo continúa).
    const cerradaEn = await runWithContext(
      { correlationId: 'sonda-a4b', source: 'socket', entrypoint: 'socket:terminal:payment_probe_result', venueId: f.venueId },
      () => cerrarEjecucion(requestId),
    )
    // UN temporizador de 10 s, que no retiene el proceso, y uno solo aunque se pida otra vez para la misma solicitud.
    expect(programados).toHaveLength(1)
    expect(programados[0].handle.hasRef()).toBe(false)
    svc.programarLiberacionTrasCierre(requestId, f.venueId)
    expect(programados).toHaveLength(1)

    // Antes de los 10 s nadie suelta, lo llame quien lo llame.
    expect(await soltar(requestId, new Date(cerradaEn + 9_999))).toBe('NOT_ELIGIBLE')
    expect(await fila(requestId)).toMatchObject({ status: 'UNKNOWN', failureCode: 'ACK_TIMEOUT' })
    expect(await ocupada()).toBe(true)

    // A los 10 s dispara el temporizador: sólo avanzó el reloj.
    relojEn(cerradaEn + 10_000)
    const real = svc.soltarRanuraTrasCierre.bind(svc)
    const contextos: (string | undefined)[] = []
    const enElDestrabe = jest.spyOn(svc, 'soltarRanuraTrasCierre').mockImplementation((...a: unknown[]) => {
      contextos.push(getContext()?.correlationId)
      return real(...a)
    })
    await programados[0].fn() // se dispara desde FUERA de todo contexto, como un temporizador real
    enElDestrabe.mockRestore()
    expect(contextos).toEqual(['sonda-a4b'])

    const soltada = await ranuraSoltadaConLaVentaEnDuda(requestId, venta.id)
    expect(soltada.status).not.toBe('FAILED')
    expect(espera.resolve).toHaveBeenCalledTimes(1)
    const [respuesta] = espera.resolve.mock.calls[0] as [{ status: string; errorMessage: string }]
    expect(respuesta).toEqual({
      requestId,
      status: 'timeout',
      errorMessage: expect.stringMatching(/terminal ya quedó libre.*necesita confirmación/),
    })
    expect(respuesta.errorMessage).not.toMatch(/no se cobr|volver a cobrar/i)
    expect(svc.pendingPayments.has(requestId)).toBe(false)
    const [asiento] = await asientos(soltada.id)
    expect(asiento.data).toMatchObject({
      requestId,
      terminalId: f.llaveTerminal,
      orderId: venta.id,
      priorStatus: 'UNKNOWN',
      priorFailureCode: 'ACK_TIMEOUT',
      executionClosedAt: new Date(cerradaEn).toISOString(),
      origen: 'TIMER',
    })

    // El watchdog pasa después: ya no hay nada que soltar (ni otro asiento).
    expect(await soltar(requestId, new Date(cerradaEn + 60_000))).toBe('NOT_ELIGIBLE')
    await vigia()
    expect(await asientos(soltada.id)).toHaveLength(1)
    expect(await fila(requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
    expect(espera.resolve).toHaveBeenCalledTimes(1)
  })

  it('P1 lo mismo CON el aviso del banco comprobado y CON avisos por serial: ya no se mide el silencio, el resultado es igual', async () => {
    // 1) Sin ninguna cuenta comprobada (una PAX/Blumon, un comercio sin aviso): igual que con todas.
    await soltadaTrasCierre()
    await f.limpiar()

    // 2) Aviso comprobado + avisos del serial: uno de un cobro sin vínculo (Pago rápido) y uno de OTRA solicitud abierta.
    await cuentas()
    const { solicitud, venta } = await enDuda()
    await avisoDelSerial(randomUUID())
    const otra = await f.solicitud({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
    const suyo = randomUUID()
    await prisma.terminalPaymentAttemptLink.create({
      data: { attemptId: suyo, requestId: otra.requestId, venueId: f.venueId, terminalId: f.llaveTerminal },
    })
    await avisoDelSerial(suyo)
    const cerradaEn = await cerrarEjecucion(solicitud.requestId)
    expect(await soltar(solicitud.requestId, new Date(cerradaEn + 10_000))).toBe('RELEASED')
    await ranuraSoltadaConLaVentaEnDuda(solicitud.requestId, venta.id)
  })

  it('P1 con un Payment o un aprobado ligado igual se suelta la ranura y la venta queda cercada; el dinero lo concilia el cierre común', async () => {
    // A) El aprobado del banco de SU intento (guardado, sin Payment) y una conciliación PENDING por la llave del intento.
    const a = await enDuda()
    await avisoDelSerial(a.attemptId)
    await dineroPorLaLlave(a.venta.id, a.attemptId)
    const cerradaA = await cerrarEjecucion(a.solicitud.requestId)
    expect(await soltar(a.solicitud.requestId, new Date(cerradaA + 10_000))).toBe('RELEASED')
    const filaA = await fila(a.solicitud.requestId)
    expect(filaA).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', paymentId: null })
    expect(desenlaceCanonico(filaA).outcome).toBe('UNRESOLVED')
    expect(await ocupada()).toBe(false)
    expect(await ventaCercada(a.venta.id)).toBe(true)
    expect(await asientos(filaA.id)).toHaveLength(1)

    // B) Llega el registro REST de la terminal DESPUÉS de soltar la ranura: el cierre común la deja cobrada, sin dobles.
    const b = await soltadaTrasCierre()
    const pago = await recordOrderPayment(
      f.venueId,
      b.venta.id,
      f.registroDeLaTerminal({ attemptId: b.attemptId, requestId: b.solicitud.requestId }),
      f.staffId,
    )
    const filaB = await fila(b.solicitud.requestId)
    expect(filaB).toMatchObject({ status: 'COMPLETED', paymentId: pago.id, lateResult: true })
    expect(desenlaceCanonico(filaB).outcome).toBe('CHARGED')
    expect((await pagos()).filter(p => p.status === 'COMPLETED').map(p => p.id)).toEqual([pago.id])
    // La promesa: «si el banco avisa tarde que sí se cobró, se marca cobrado y salta la alerta».
    expect(alarmas('already-TIMED_OUT')).toEqual([[expect.any(String), expect.objectContaining({ requestId: b.solicitud.requestId })]])

    // C) El aviso APROBADO del banco llega DESPUÉS de soltar la ranura: queda COBRADA, con un solo Payment, y salta la alerta.
    ;(logger.error as jest.Mock).mockClear()
    const c = await soltadaTrasCierre()
    expect(await webhook(c.attemptId)).toMatchObject({ action: 'CONFIRMED' })
    const filaC = await fila(c.solicitud.requestId)
    expect(filaC).toMatchObject({ status: 'COMPLETED', lateResult: true })
    expect(desenlaceCanonico(filaC).outcome).toBe('CHARGED')
    expect((await pagos()).filter(p => p.status === 'COMPLETED' && p.orderId === c.venta.id).map(p => p.id)).toEqual([filaC.paymentId])
    expect(await ventaCercada(c.venta.id)).toBe(false)
    expect(alarmas('already-TIMED_OUT')).toEqual([[expect.any(String), expect.objectContaining({ requestId: c.solicitud.requestId })]])
  })

  it('P1 con el Payment YA registrado antes de soltar (su cierre no llegó), el temporizador lo concilia y no suelta: sin alarma de doble cobro', async () => {
    const { solicitud, venta, attemptId } = await enDuda()
    const { requestId } = solicitud
    // El POS sigue esperando: recibe el cobro, no un «necesita confirmación».
    const espera = {
      resolve: jest.fn(),
      reject: jest.fn(),
      timeout: setTimeoutReal(() => undefined, 1),
      requestId,
      terminalId: f.llaveTerminal,
      venueId: f.venueId,
    }
    svc.pendingPayments.set(requestId, espera)
    const cerradaEn = await cerrarEjecucion(requestId)
    const pago = await pagoYaRegistrado(venta.id, attemptId) // el cierre de la fila tronó (lock_timeout): la fila sigue UNKNOWN
    expect(await fila(requestId)).toMatchObject({ status: 'UNKNOWN', paymentId: null })

    relojEn(cerradaEn + 10_000)
    await programados[0].fn()
    const r = await fila(requestId)
    expect(r).toMatchObject({ status: 'COMPLETED', paymentId: pago.id })
    expect(desenlaceCanonico(r).outcome).toBe('CHARGED')
    expect(await asientos(r.id)).toHaveLength(0) // nunca se soltó la ranura: se concilió
    expect(espera.resolve).toHaveBeenCalledWith(expect.objectContaining({ requestId, status: 'success', paymentId: pago.id }))

    // El watchdog después: nada más que hacer, y ninguna alarma de «revisa el doble cobro» por dinero que llegó ANTES.
    jest.setSystemTime(cerradaEn + 40_000)
    await vigia()
    jest.useRealTimers()
    expect(await fila(requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id })
    expect(alarmasDeDobleCobro()).toEqual([])
    expect((await pagos()).map(p => p.id)).toEqual([pago.id])
    svc.pendingPayments.delete(requestId)
  })

  it('P1 Codex r4: el BARRIDO del watchdog (no el temporizador) también concilia antes de soltar un Payment ya registrado', async () => {
    // El barrido de S2 no puede confiar en que S4 ya pasó por la fila en la misma pasada (una fila que truena le corta el bucle a
    // S4; los cursores son distintos con más de 200 UNKNOWN). Se llama al barrido SOLO, sin S4.
    const { solicitud, venta, attemptId } = await enDuda()
    const { requestId } = solicitud
    const gancho = jest.spyOn(svc, 'programarLiberacionTrasCierre').mockImplementation(() => undefined)
    const cerradaEn = await cerrarEjecucion(requestId)
    gancho.mockRestore()
    const pago = await pagoYaRegistrado(venta.id, attemptId)

    await expect(svc.liberarTrasCierreDeEjecucion(new Date(cerradaEn + 10_000))).resolves.toMatchObject({ released: 0, reconciled: 1 })
    const r = await fila(requestId)
    expect(r).toMatchObject({ status: 'COMPLETED', paymentId: pago.id })
    expect(desenlaceCanonico(r).outcome).toBe('CHARGED')
    expect(await asientos(r.id)).toHaveLength(0)

    relojEn(cerradaEn + 40_000)
    await vigia()
    jest.useRealTimers()
    expect(await fila(requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id })
    expect(alarmasDeDobleCobro()).toEqual([])
    expect((await pagos()).map(p => p.id)).toEqual([pago.id])
  })

  it('P1 sin executionClosedAt (TPV 2.12.5) nada antes de los 20 min; a los 20 min con latido la suelta el reloj de siempre', async () => {
    const { solicitud, venta } = await enDuda()
    const { requestId } = solicitud
    // TPV 2.12.5: sin la capacidad, los dos campos no son evidencia…
    expect(await svc.handleProbeResultFromSocket({ requestId, ...CERRADA }, sinCapacidad())).toBe(true)
    // …y su NOT_FOUND de una solicitud ya entregada tampoco acredita nada (decisión «B»: ninguna liberación nueva).
    expect(await svc.handleProbeResultFromSocket({ requestId, disposition: 'NOT_FOUND' }, sinCapacidad())).toBe(true)
    expect((await fila(requestId)).executionClosedAt).toBeNull()
    expect(programados).toHaveLength(0)
    expect(await soltar(requestId, new Date(Date.now() + 3_600_000))).toBe('NOT_ELIGIBLE')

    // El reloj de siempre (S4): la terminal vuelve y late; a los 19 min nada, a los 21 sí — con SU asiento, no el de S2.
    const t0 = Date.now()
    relojEn(t0)
    await prisma.terminal.update({ where: { serialNumber: f.serial }, data: { lastHeartbeat: new Date(t0) } })
    await vigia()
    expect((await fila(requestId)).terminalReturnedAt?.getTime()).toBe(t0)
    jest.setSystemTime(t0 + 19 * 60_000)
    await prisma.terminal.update({ where: { serialNumber: f.serial }, data: { lastHeartbeat: new Date(t0 + 19 * 60_000) } })
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'UNKNOWN', failureCode: 'ACK_TIMEOUT' })
    expect(await ocupada()).toBe(true)

    jest.setSystemTime(t0 + 21 * 60_000)
    await prisma.terminal.update({ where: { serialNumber: f.serial }, data: { lastHeartbeat: new Date(t0 + 21 * 60_000) } })
    await vigia()
    jest.useRealTimers()
    const r = await fila(requestId)
    expect(r).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', executionClosedAt: null })
    expect(await ventaCercada(venta.id)).toBe(true)
    expect(await asientos(r.id)).toHaveLength(0)
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'TERMINAL_PAYMENT_AUTO_RELEASED', entityId: r.id }))
  })

  it('P1 E2: una TPV vieja que contesta NOT_FOUND tras la entrega habilita la declaración pero NO el destrabe por el cese', async () => {
    // A5 (S3-a, Codex plan-r1-2). El ACK perdido de Testarudo con la flota de hoy: entregada DURABLE, sin acuse, y la terminal
    // 2.12.5 contesta la sonda con su payload VIEJO (sin `executionAlive` ni `closedForExecution`, socket sin la capacidad).
    const { solicitud, venta } = await enDuda({ acknowledgedAt: null })
    const { requestId } = solicitud
    await expect(declarar(requestId, f.staffId)).rejects.toMatchObject({ code: 'TERMINAL_NEVER_ANSWERED' })

    // La auditoría de la sonda va por `logAction`, que la integración simula: aquí escribe de verdad (es lo que lee la declaración).
    ;(logAction as jest.Mock).mockImplementation(jest.requireActual('@/services/dashboard/activity-log.service').logAction)
    try {
      expect(await svc.handleProbeResultFromSocket({ requestId, disposition: 'NOT_FOUND' }, sinCapacidad())).toBe(true)
      for (let i = 0; i < 100 && (await asientos(solicitud.id, 'TERMINAL_PAYMENT_PROBE_UNACCREDITED')).length === 0; i++)
        await new Promise(r => setTimeout(r, 50))
    } finally {
      ;(logAction as jest.Mock).mockImplementation(() => undefined)
    }
    expect(await asientos(solicitud.id, 'TERMINAL_PAYMENT_PROBE_UNACCREDITED')).toHaveLength(1)
    const tras = await fila(requestId)

    // NO es el certificado nuevo: ni sello, ni temporizador, ni destrabe, ni el watchdog una hora después (sin latido).
    expect(tras.executionClosedAt).toBeNull()
    expect(programados).toHaveLength(0)
    expect(await soltar(requestId, new Date(Date.now() + 3_600_000))).toBe('NOT_ELIGIBLE')
    relojEn(Date.now() + 60 * 60_000)
    await vigia()
    jest.useRealTimers()
    expect(await fila(requestId)).toMatchObject({ status: 'UNKNOWN', failureCode: 'ACK_TIMEOUT', executionClosedAt: null })
    expect(await ventaCercada(venta.id)).toBe(true)
    expect(await asientos(tras.id)).toHaveLength(0)

    // Sí habilita la DECLARACIÓN humana: el cajero mira la pantalla y libera la venta.
    await expect(declarar(requestId, f.staffId)).resolves.toMatchObject({ kind: 'UNCHARGED_VERIFIED' })
    expect(await fila(requestId)).toMatchObject({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE', executionClosedAt: null })
    expect(await ventaCercada(venta.id)).toBe(false)
  })

  it('P1 tras soltar la ranura el cajero declara «no se cobró» (E2) y se acepta; con PIN de gerente también; con dinero por la llave del intento, rechazada', async () => {
    const sufijo = randomUUID().slice(0, 8)
    const pinGerente = String(100_000 + Math.floor(Math.random() * 899_999))
    const persona = (rol: 'WAITER' | 'MANAGER', pin?: string) =>
      prisma.staff.create({
        data: {
          email: `ejecerr-${rol.toLowerCase()}-${sufijo}@example.test`,
          firstName: rol === 'WAITER' ? 'Mesero' : 'Gerente',
          lastName: 'A4b',
          phone: '5550000009',
          organizations: { create: { organizationId: f.fixture, role: 'MEMBER', isPrimary: true, isActive: true } },
          venues: { create: { venueId: f.venueId, role: rol, active: true, ...(pin ? { pin } : {}) } },
        },
      })
    const mesero = await persona('WAITER')
    const gerente = await persona('MANAGER', pinGerente)
    try {
      // 1) El cajero (con el permiso) declara sobre la venta en duda de la ranura ya soltada: se acepta y la venta se libera.
      const uno = await soltadaTrasCierre()
      await expect(declarar(uno.solicitud.requestId, f.staffId)).resolves.toMatchObject({ kind: 'UNCHARGED_VERIFIED' })
      expect(await fila(uno.solicitud.requestId)).toMatchObject({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' })
      expect(await ventaCercada(uno.venta.id)).toBe(false)

      // 2) El mesero sin el permiso necesita el PIN de un gerente.
      const dos = await soltadaTrasCierre()
      await expect(declarar(dos.solicitud.requestId, mesero.id)).rejects.toMatchObject({ code: 'SUPERVISOR_AUTHORIZATION_REQUIRED' })
      await expect(declarar(dos.solicitud.requestId, mesero.id, { supervisorPin: pinGerente })).resolves.toMatchObject({
        kind: 'UNCHARGED_VERIFIED',
        staffId: gerente.id,
        by: 'SUPERVISOR_PIN',
      })
      expect(await ventaCercada(dos.venta.id)).toBe(false)

      // 3) Con dinero por la llave del intento: la ranura se suelta igual, pero la declaración se rechaza y la venta sigue cercada.
      const tres = await enDuda()
      await dineroPorLaLlave(tres.venta.id, tres.attemptId)
      const cerradaEn = await cerrarEjecucion(tres.solicitud.requestId)
      expect(await soltar(tres.solicitud.requestId, new Date(cerradaEn + 10_000))).toBe('RELEASED')
      expect(await ocupada()).toBe(false)
      await expect(declarar(tres.solicitud.requestId, f.staffId)).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
      expect(await fila(tres.solicitud.requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', paymentId: null })
      expect(await ventaCercada(tres.venta.id)).toBe(true)
    } finally {
      const ids = [mesero.id, gerente.id]
      await prisma.staffVenue.deleteMany({ where: { staffId: { in: ids } } })
      await prisma.staffOrganization.deleteMany({ where: { staffId: { in: ids } } })
      await prisma.staff.deleteMany({ where: { id: { in: ids } } })
    }
  })

  it('P1 vale para SENT y CANCEL_REQUESTED que A3 pasa a UNKNOWN/EXECUTION_CLOSED', async () => {
    // SENT: la app de la terminal murió con el cobro en vuelo y volvió con un socket nuevo; la sonda trae el cese.
    const venta = await f.nuevaVenta(100)
    const enviada = await f.solicitud({
      orderId: venta.id,
      status: 'SENT',
      acknowledgedAt: new Date(),
      deliveryProvenance: { deliveries: [entrega()] },
    })
    const selloSent = await cerrarEjecucion(enviada.requestId)
    expect(await fila(enviada.requestId)).toMatchObject({ status: 'UNKNOWN', failureCode: 'EXECUTION_CLOSED' })
    expect(programados).toHaveLength(1)
    relojEn(selloSent + 10_000)
    await programados[0].fn()
    jest.useRealTimers()
    const filaSent = await ranuraSoltadaConLaVentaEnDuda(enviada.requestId, venta.id)
    expect((await asientos(filaSent.id))[0].data).toMatchObject({ priorStatus: 'UNKNOWN', priorFailureCode: 'EXECUTION_CLOSED' })

    // CANCEL_REQUESTED: el cajero pidió cancelar y la terminal contesta la disposición con el cese.
    const otraVenta = await f.nuevaVenta(100)
    const cancelando = await f.solicitud({
      orderId: otraVenta.id,
      status: 'CANCEL_REQUESTED',
      acknowledgedAt: new Date(),
      deliveryProvenance: { deliveries: [entrega()] },
    })
    expect(await svc.handleCancelDispositionFromSocket({ requestId: cancelando.requestId, ...CERRADA }, conCapacidad())).toBe(true)
    const sellada = await fila(cancelando.requestId)
    expect(sellada).toMatchObject({ status: 'UNKNOWN', failureCode: 'EXECUTION_CLOSED' })
    expect(programados).toHaveLength(2)
    relojEn(sellada.executionClosedAt!.getTime() + 10_000)
    await programados[1].fn()
    jest.useRealTimers()
    await ranuraSoltadaConLaVentaEnDuda(cancelando.requestId, otraVenta.id)
  })

  it('P1 un ACTIVE posterior sin desmentir contradice el certificado: no se suelta por el cese (queda el reloj de siempre)', async () => {
    const { solicitud } = await enDuda()
    const cerradaEn = await cerrarEjecucion(solicitud.requestId)
    expect(await svc.handleProbeResultFromSocket({ requestId: solicitud.requestId, disposition: 'ACTIVE' }, sinCapacidad())).toBe(true)
    expect(await soltar(solicitud.requestId, new Date(cerradaEn + 60_000))).toBe('NOT_ELIGIBLE')
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'UNKNOWN' })
    expect(await ocupada()).toBe(true)
  })

  it('P1 el JOB completo: sin temporizador (reinicio, o el gancho nunca se llamó) el watchdog suelta la ranura en el siguiente tick, nunca antes de 10 s', async () => {
    const { solicitud, venta } = await enDuda()
    const gancho = jest.spyOn(svc, 'programarLiberacionTrasCierre').mockImplementation(() => undefined)
    const cerradaEn = await cerrarEjecucion(solicitud.requestId)
    gancho.mockRestore()
    expect(programados).toHaveLength(0)

    relojEn(cerradaEn + 5_000)
    await vigia()
    expect(await fila(solicitud.requestId)).toMatchObject({ status: 'UNKNOWN', failureCode: 'ACK_TIMEOUT' })

    jest.setSystemTime(cerradaEn + 35_000) // el siguiente tick de 30 s
    await vigia()
    jest.useRealTimers()
    const r = await ranuraSoltadaConLaVentaEnDuda(solicitud.requestId, venta.id)
    expect((await asientos(r.id))[0].data).toMatchObject({ requestId: solicitud.requestId, priorStatus: 'UNKNOWN', origen: 'WATCHDOG' })
  })

  it('P2 el temporizador y el watchdog a la vez: un solo ganador y un solo asiento', async () => {
    const { solicitud, venta } = await enDuda()
    const cerradaEn = await cerrarEjecucion(solicitud.requestId)
    expect(programados).toHaveLength(1)
    relojEn(cerradaEn + 10_000)
    await Promise.all([programados[0].fn(), svc.liberarTrasCierreDeEjecucion()])
    jest.useRealTimers()
    await ranuraSoltadaConLaVentaEnDuda(solicitud.requestId, venta.id)
  })

  it('P2 el temporizador y el watchdog a la vez sobre una fila con su Payment YA registrado: un solo cierre, ningún destrabe, sin alarma de doble cobro', async () => {
    // Re-revisión Codex r4 (M3): los DOS disparos concilian antes de soltar; el cierre común los forma en fila (FOR UPDATE) y el
    // segundo ve ALREADY_BOUND.
    const { solicitud, venta, attemptId } = await enDuda()
    const { requestId } = solicitud
    const cerradaEn = await cerrarEjecucion(requestId)
    expect(programados).toHaveLength(1)
    const pago = await pagoYaRegistrado(venta.id, attemptId)
    relojEn(cerradaEn + 10_000)
    const [, barrido] = await Promise.all([programados[0].fn(), svc.liberarTrasCierreDeEjecucion()])
    jest.useRealTimers()
    const r = await fila(requestId)
    expect(r).toMatchObject({ status: 'COMPLETED', paymentId: pago.id })
    expect(desenlaceCanonico(r).outcome).toBe('CHARGED')
    expect(barrido).toMatchObject({ released: 0 })
    expect(await asientos(r.id)).toHaveLength(0)
    const cierres = (logAction as jest.Mock).mock.calls
      .map(([p]) => p as { action: string; entityId?: string })
      .filter(p => p.action === 'TERMINAL_PAYMENT_LATE_RECONCILED' && p.entityId === r.id)
    expect(cierres).toHaveLength(1)
    expect(alarmasDeDobleCobro()).toEqual([])
    expect((await pagos()).map(p => p.id)).toEqual([pago.id])
  })

  it('P1 una fila cuyo destrabe lanza no corta el barrido: la siguiente se suelta y el error queda con su requestId', async () => {
    // Dos filas en duda de DOS terminales (la ranura es una por terminal), las dos con el cese acreditado.
    const serial2 = `AVQD-N86${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
    const llave2 = terminalIdentityKey(serial2)
    await prisma.terminal.create({ data: { venueId: f.venueId, name: 'N86 dos', serialNumber: serial2, type: 'TPV_ANDROID' } })
    try {
      const primera = await enDuda({ terminalId: llave2, createdAt: new Date(Date.now() - 60_000) })
      const segunda = await enDuda()
      expect(
        await svc.handleProbeResultFromSocket(
          { requestId: primera.solicitud.requestId, ...CERRADA },
          { ...conCapacidad(), terminalId: serial2 },
        ),
      ).toBe(true)
      const b = await cerrarEjecucion(segunda.solicitud.requestId)
      svc.liberacionesTrasCierre?.clear()
      const real = svc.soltarRanuraTrasCierre.bind(svc)
      const destrabe = jest
        .spyOn(svc, 'soltarRanuraTrasCierre')
        .mockImplementation((fila: unknown, ...resto: unknown[]) =>
          (fila as { requestId: string }).requestId === primera.solicitud.requestId
            ? Promise.reject(new Error('lock_timeout'))
            : real(fila, ...resto),
        )
      await expect(svc.liberarTrasCierreDeEjecucion(new Date(b + 10_000))).resolves.toMatchObject({ released: 1 })
      destrabe.mockRestore()
      await ranuraSoltadaConLaVentaEnDuda(segunda.solicitud.requestId, segunda.venta.id)
      expect(await fila(primera.solicitud.requestId)).toMatchObject({ status: 'UNKNOWN' })
      expect(
        (logger.error as jest.Mock).mock.calls.some(
          ([, meta]) => (meta as { requestId?: string } | undefined)?.requestId === primera.solicitud.requestId,
        ),
      ).toBe(true)
    } finally {
      await prisma.terminalPaymentRequest.deleteMany({ where: { terminalId: llave2 } })
      await prisma.terminal.deleteMany({ where: { serialNumber: serial2 } })
    }
  })

  it('P1 un success tardío de la terminal sobre la ranura soltada y su registro REST la dejan cobrada, sin dobles', async () => {
    const { solicitud, venta, attemptId } = await soltadaTrasCierre()
    const { requestId } = solicitud
    const socket = { socketId: 'socket-nuevo', terminalId: f.serial, venueId: f.venueId }
    // 1) La terminal afirma «cobré» antes de que exista el Payment: la venta sigue en duda y cercada.
    await svc.handlePaymentResultFromSocket({ requestId, status: 'success', transactionId: 'tx-tardio', authorizationCode: 'A-1' }, socket)
    expect(await consultar(requestId)).toMatchObject({ outcome: 'UNRESOLVED' })
    expect(await ventaCercada(venta.id)).toBe(true)

    // 2) Llega su registro REST: el cierre común la deja cobrada.
    const pago = await recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId, requestId }), f.staffId)
    expect(await fila(requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id })

    // 3) La terminal repite su success con el Payment: nada se duplica.
    await svc.handlePaymentResultFromSocket({ requestId, status: 'success', paymentId: pago.id }, socket)
    expect(await fila(requestId)).toMatchObject({ status: 'COMPLETED', paymentId: pago.id })
    expect((await pagos()).map(p => p.id)).toEqual([pago.id])
    expect(desenlaceCanonico(await fila(requestId)).outcome).toBe('CHARGED')
  })
})

describe('S2-bis · retenida por dinero con el cese acreditado: suelta el aparato, no la venta', () => {
  it('P1 una retenida con el cese de hace 40 min suelta la ranura igual', async () => {
    const { solicitud, venta } = await enDuda({ status: 'TIMED_OUT', failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW' })
    const { requestId } = solicitud
    await prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "executionClosedAt" = (NOW() AT TIME ZONE 'UTC') - interval '40 minutes' WHERE "id" = ${solicitud.id}`
    expect(await ocupada()).toBe(true)
    await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())
    expect(await fila(requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
    expect(await ocupada()).toBe(false)
    expect(await ventaCercada(venta.id)).toBe(true)
  })

  it('P2 retenida por aprobado del banco con la ejecución cerrada: suelta la ranura y la venta sigue cercada', async () => {
    await cuentas()
    const { solicitud, venta, attemptId } = await enDuda({
      status: 'TIMED_OUT',
      failureCode: 'BANK_APPROVED_AWAITING_PAYMENT',
      resultJson: {
        requestId: 'x',
        status: 'timeout',
        terminalResult: { status: 'failed', errorMessage: 'SDK U100', outcomeEvidence: null },
      },
    })
    const { requestId } = solicitud
    await avisoDelSerial(attemptId) // el aprobado del banco que la retuvo
    expect(await ocupada()).toBe(true)

    // Control: sin el cese, a los pocos minutos sigue retenida (el destrabe normal es a los 20 min).
    await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())
    expect(await fila(requestId)).toMatchObject({ failureCode: 'BANK_APPROVED_AWAITING_PAYMENT' })
    expect(await ocupada()).toBe(true)

    const cerradaEn = await cerrarEjecucion(requestId)
    await vigia()
    expect(await fila(requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', paymentId: null })
    expect(await ocupada()).toBe(false)
    expect(await ventaCercada(venta.id)).toBe(true)
    expect(await consultar(requestId)).toMatchObject({ outcome: 'UNRESOLVED' })
    const soltadas = (logAction as jest.Mock).mock.calls
      .map(([p]) => p as { action: string; entityId?: string; data?: Record<string, unknown> })
      .filter(p => p.action === 'TERMINAL_PAYMENT_AUTO_RELEASED' && p.entityId === solicitud.id)
    expect(soltadas).toEqual([expect.objectContaining({ data: expect.objectContaining({ requestId, reason: 'EXECUTION_CLOSED' }) })])

    // Y nada la declara «no se cobró» después: el watchdog vuelve a pasar y la venta sigue en duda.
    relojEn(cerradaEn + 60_000)
    await vigia()
    jest.useRealTimers()
    expect(await fila(requestId)).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
    expect(await ventaCercada(venta.id)).toBe(true)
    expect(await negativosPorSilencio()).toBe(0)
  })
})
