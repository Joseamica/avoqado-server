/**
 * VENTANA DE CONFIRMACIÓN (plan 16-sep): un negativo de la terminal SIN evidencia del procesador (U100/U101/«Cancelled»/
 * G505…) ya no queda UNKNOWN para siempre: `closeRow` lo escribe `TIMED_OUT` conservando el sobre de la terminal en
 * `resultJson.terminalResult`, y a los 30 s (temporizador en proceso + respaldo del watchdog) se libera como
 * `FAILED/NO_EVIDENCE_AFTER_WINDOW` — salvo que el pago EXACTO ya exista (se concilia) o que un webhook APROBADO de un
 * intento vinculado ya se haya persistido sin Payment (se RETIENE con `BANK_APPROVED_AWAITING_PAYMENT`).
 *
 * Contra Postgres REAL y sólo en la base desechable: el veto bancario, el CAS con `updatedAt` y la espera al candado del
 * intento son intercalaciones que ningún mock puede probar. Arnés calcado de `terminalPaymentRecovery.integration.test.ts`.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { UNPROVEN_NEGATIVE_WINDOW_MS, terminalPaymentService } from '@/services/terminal-payment.service'
import { candadoDeIntento, candadoDeSolicitud } from '@/services/tpv/candadoDeIntento'
import { utcTs } from '@/utils/sqlDates'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { logAction } from '@/services/dashboard/activity-log.service'
import { invalidarVenuesEstrictos } from '@/services/terminal-payment-strictness'
import { sendOpsAlert } from '@/services/alerts/opsAlert.service'
import logger from '@/config/logger'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

const fixture = `ventana-${randomUUID().slice(0, 8)}`
const venueId = fixture
let orderId: string
const nextRequest = () => randomUUID()
let directEmit: jest.Mock

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
  // Los barridos son globales. Nunca apuntar esta prueba a una base compartida de desarrollo.
  expect(url.pathname).toMatch(/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/)
  await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: fixture, name: fixture, slug: fixture } })
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: fixture,
      subtotal: new Prisma.Decimal(100),
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(100),
    },
  })
  orderId = order.id
})

beforeEach(() => {
  jest.clearAllMocks()
  directEmit = jest.fn()
  const socket = { emit: directEmit, timeout: () => ({ emit: directEmit }) }
  ;(socketManager.getServer as jest.Mock).mockReturnValue({
    sockets: { sockets: new Map([['fixture-socket', socket]]) },
    to: () => ({ emit: jest.fn() }),
  })
  ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({
    terminalId,
    venueId,
    socketId: 'fixture-socket',
    terminalPaymentAckVersion: 1,
  }))
})

afterEach(async () => {
  // 🔴 El barrido de la ventana es GLOBAL: una fila que sobreviva a una prueba la liberaría otra corrida. La limpieza va
  // PRIMERO, antes de cualquier cosa que pueda fallar.
  await prisma.providerEventLog.deleteMany({ where: { venueId } })
  await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
  // Los temporizadores que `closeRow` programó en ESTE proceso no deben disparar sobre filas de otra prueba.
  const programadas = (terminalPaymentService as any).ventanasProgramadas as Map<string, NodeJS.Timeout> | undefined
  for (const t of programadas?.values() ?? []) clearTimeout(t)
  programadas?.clear()
})

afterAll(async () => {
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.terminal.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: fixture } })
})

/**
 * Prisma no deja fijar `updatedAt` (`@updatedAt`) en `create`: se ajusta con SQL crudo después. 🔴 `utcTs`, nunca el
 * `Date` pelón: la sesión local es `America/Mexico_City` y un bind crudo aterrizaría 6 h corrido (regla del repo).
 */
async function conUpdatedAt<T extends { id: string }>(row: T, fecha: Date) {
  await prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "updatedAt" = ${utcTs(fecha)} WHERE "id" = ${row.id}`
  return prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
}

async function auditRequest(overrides: Record<string, unknown> = {}) {
  const { updatedAt, ...data } = overrides
  const row = await prisma.terminalPaymentRequest.create({
    data: {
      requestId: nextRequest(),
      venueId,
      terminalId: fixture,
      orderId,
      amountCents: 10000,
      expiresAt: new Date(0),
      ...data,
    } as Prisma.TerminalPaymentRequestUncheckedCreateInput,
  })
  return updatedAt instanceof Date ? conUpdatedAt(row, updatedAt) : row
}
/**
 * 🔴 Un Payment de una TERMINAL trae SIEMPRE su procedencia: `source: 'TPV'` y el aparato en que se cobró. La
 * conciliación exige esa atribución FÍSICA antes de cerrar una solicitud con él.
 */
async function terminalDelFixture(serial: string = fixture) {
  return prisma.terminal.upsert({
    where: { serialNumber: serial },
    update: {},
    create: { venueId, name: 'fixture terminal', serialNumber: serial, type: 'TPV_ANDROID' },
  })
}

async function auditPayment(overrides: Record<string, unknown> = {}, serial: string = fixture) {
  const terminal = await terminalDelFixture(serial)
  return prisma.payment.create({
    data: {
      venueId,
      orderId,
      source: 'TPV',
      terminalId: terminal.id,
      amount: new Prisma.Decimal(100),
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      feePercentage: new Prisma.Decimal(0),
      feeAmount: new Prisma.Decimal(0),
      netAmount: new Prisma.Decimal(100),
      ...overrides,
    } as Prisma.PaymentUncheckedCreateInput,
  })
}

// Los usan las Tasks 3 y 4 (aviso de aprobación tardía y contrato con el POS); aquí quedan para no reescribir el arnés.
const terminalDe = (sufijo: string) => `${fixture}-${sufijo}`
const nuevaOrden = (extra: Record<string, unknown> = {}) =>
  prisma.order.create({
    data: {
      venueId,
      orderNumber: `${fixture}-${randomUUID().slice(0, 8)}`,
      subtotal: new Prisma.Decimal(100),
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(100),
      ...extra,
    } as Prisma.OrderUncheckedCreateInput,
  })
/** El resultado o el error: un rechazo no puede tumbar la prueba antes de revisar TODO lo que pasó. */
const enviar = (envio: Parameters<typeof terminalPaymentService.sendPaymentToTerminal>[0]): Promise<unknown> =>
  terminalPaymentService.sendPaymentToTerminal(envio).then(
    v => v,
    (e: unknown) => e,
  )
const filasDe = (requestId: string) => prisma.terminalPaymentRequest.findMany({ where: { venueId, requestId } })
void terminalDe
void enviar
void filasDe

// A nivel de archivo: lo usan los describes de la Task 2, la Task 3 y la Task 4.
const negativoSinEvidencia = () => ({
  status: 'TIMED_OUT',
  failureCode: null,
  resultJson: {
    requestId: 'x',
    status: 'timeout',
    errorMessage: 'El resultado del cobro sigue pendiente de confirmar',
    terminalResult: {
      status: 'failed',
      errorMessage: 'User cancelled\n\nSDK U100: Operacion cancelada por el usuario',
      outcomeEvidence: null,
    },
  },
})

const eventoAprobado = (attemptId: string, transactionId: string) => ({
  provider: 'PAYMENT_PROCESSOR' as const,
  venueId,
  attemptId,
  type: 'send_transaction',
  status: 'PENDING' as const,
  payload: { event: 'send_transaction', payload: { status: 'approved', amount: '10000', integratorReference: attemptId, transactionId } },
})

/** Sesiones de ESTA base esperando un candado consultivo de dos llaves (`hashtext`): mide que alguien ESPERA, no que decidió a ciegas. */
const esperandoCandado = async () =>
  (
    await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory' AND query ILIKE '%hashtext%'`,
    )
  )[0].n
const esperar = async (cond: () => Promise<boolean>, ms = 5000) => {
  const hasta = Date.now() + ms
  while (Date.now() < hasta) {
    if (await cond()) return true
    await new Promise(r => setTimeout(r, 40))
  }
  return cond()
}
/** Una puerta: la transacción que la recibe se queda dentro hasta que la prueba la suelta. */
const puerta = () => {
  let soltar!: () => void
  let tomado!: () => void
  const abierta = new Promise<void>(r => {
    soltar = r
  })
  const tomada = new Promise<void>(r => {
    tomado = r
  })
  return { abierta, tomada, soltar, tomado }
}
/**
 * Intercepta la SIGUIENTE `prisma.$transaction`: cada `tx.$queryRaw` cuyo SQL contenga `marcador` corre de verdad y, ANTES de
 * devolver su resultado, ejecuta `entre` (por fuera, autocommit) — el hueco exacto «entre el veto y el CAS» de un escritor sin
 * candado. El cliente de la transacción es otro objeto que `prisma`, así que un espía sobre `prisma.$queryRaw` no lo alcanza.
 */
const interceptarSiguienteTx = (marcador: string, entre: () => Promise<void>) => {
  const original = prisma.$transaction.bind(prisma)
  const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: any, opts: any) =>
    original(async (tx: any) => {
      const envuelto = new Proxy(tx, {
        get(target, prop) {
          const v = (target as any)[prop]
          if (prop !== '$queryRaw') return typeof v === 'function' ? v.bind(target) : v
          return async (strings: TemplateStringsArray | { sql?: string }, ...values: unknown[]) => {
            const r = await target.$queryRaw(strings as TemplateStringsArray, ...values)
            const sql = Array.isArray(strings) ? strings.join('?') : String((strings as { sql?: string }).sql ?? '')
            if (sql.includes(marcador)) await entre()
            return r
          }
        },
      })
      return fn(envuelto)
    }, opts)) as any)
  return spy
}

describe('Ventana de confirmación: un negativo sin evidencia dura 30 s y se libera solo', () => {
  it('antes de los 30 s NO se libera: la orden y la ranura siguen bloqueadas', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - 5_000) })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    const fresca = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fresca.status).toBe('TIMED_OUT')
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
    // La RANURA también: en el régimen relajado (el de producción) la fila de la ventana retiene el aparato.
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
  })

  it('a los 30 s se libera: FAILED/NO_EVIDENCE_AFTER_WINDOW, orden y ranura libres, bitácora escrita', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RELEASED')
    const liberada = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(liberada).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW', paymentId: null })
    expect((liberada.resultJson as any).releasedAfterWindow).toMatchObject({ windowMs: UNPROVEN_NEGATIVE_WINDOW_MS, origen: 'WATCHDOG' })
    expect((liberada.resultJson as any).terminalResult.errorMessage).toContain('SDK U100') // el sobre original no se pierde
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(false)
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(false)
    const estado = await terminalPaymentService.getPaymentStatus(row.requestId, venueId)
    expect(estado).toMatchObject({
      status: 'FAILED',
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW',
      evidenceClass: 'SERVER',
    })
    const bitacora = await prisma.activityLog.findFirst({
      where: { venueId, action: 'TERMINAL_PAYMENT_RELEASED_AFTER_WINDOW', entityId: row.id },
    })
    expect(bitacora).not.toBeNull()
    expect(bitacora?.data).toMatchObject({ requestId: row.requestId, origen: 'WATCHDOG', windowMs: UNPROVEN_NEGATIVE_WINDOW_MS })
  })

  it('si el pago EXACTO ya existe al vencer la ventana, se concilia a COMPLETED en vez de liberar', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    await auditPayment({ processorData: { terminalPaymentRequestId: row.requestId, deviceSerialNumber: fixture } })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RECONCILED')
    const cerrada = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(cerrada.status).toBe('COMPLETED')
    expect(cerrada.paymentId).not.toBeNull()
    expect(cerrada.lateResult).toBe(true)
    // Nada se liberó: ni bitácora de liberación ni código de la ventana.
    expect(cerrada.failureCode).not.toBe('NO_EVIDENCE_AFTER_WINDOW')
    expect(await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_RELEASED_AFTER_WINDOW', entityId: row.id } })).toBe(
      0,
    )
  })

  it('UNKNOWN (la terminal nunca contestó) y TIMED_OUT/AUTO_RELEASED NO entran en la ventana', async () => {
    const vencida = new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000)
    // CON sobre de la terminal las dos: la exclusión tiene que ser por status / failureCode, no por la falta de sobre.
    const unknown = await auditRequest({ ...negativoSinEvidencia(), status: 'UNKNOWN', updatedAt: vencida })
    const soltada = await auditRequest({
      ...negativoSinEvidencia(),
      failureCode: 'AUTO_RELEASED',
      updatedAt: vencida,
      terminalId: `${fixture}-b`,
    })
    const resumen = await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())
    expect(resumen).toEqual({ released: 0, reconciled: 0, held: 0, heldUnbound: 0 })
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: unknown.id } })).status).toBe('UNKNOWN')
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: soltada.id } })).failureCode).toBe('AUTO_RELEASED')
    // Y por el camino directo tampoco: ninguna de las dos es «negativo de la terminal sin evidencia».
    expect(await terminalPaymentService.releaseUnprovenNegative(unknown.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    expect(await terminalPaymentService.releaseUnprovenNegative(soltada.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
  })

  it('una TIMED_OUT histórica SIN sobre de la terminal (anterior a este cambio) tampoco entra en la ventana', async () => {
    const vencida = new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000)
    const historica = await auditRequest({
      status: 'TIMED_OUT',
      failureCode: null,
      resultJson: { requestId: 'x', status: 'timeout' },
      updatedAt: vencida,
    })
    expect(await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())).toEqual({
      released: 0,
      reconciled: 0,
      held: 0,
      heldUnbound: 0,
    })
    expect(await terminalPaymentService.releaseUnprovenNegative(historica.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: historica.id } })).status).toBe('TIMED_OUT')
  })

  it('el barrido libera sólo las vencidas y es idempotente', async () => {
    const vencida = new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000)
    await auditRequest({ ...negativoSinEvidencia(), updatedAt: vencida })
    await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(), terminalId: `${fixture}-c` })
    expect(await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())).toEqual({
      released: 1,
      reconciled: 0,
      held: 0,
      heldUnbound: 0,
    })
    expect(await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())).toEqual({
      released: 0,
      reconciled: 0,
      held: 0,
      heldUnbound: 0,
    })
    // La reciente sigue intacta y bloqueando su terminal.
    expect(await terminalPaymentService.isTerminalBusy(`${fixture}-c`, venueId)).toBe(true)
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(false)
  })

  it('un `timeout` que manda la propia TPV también entra en la ventana (TIMED_OUT con terminalResult.status = timeout)', async () => {
    const row = await auditRequest({ status: 'SENT' })
    await terminalPaymentService.handlePaymentResultFromSocket(
      {
        requestId: row.requestId,
        status: 'timeout',
        errorMessage: 'La terminal no pudo confirmar el resultado del cobro. Confirmando con el banco.',
      },
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: null })
    expect((fila.resultJson as any).terminalResult).toMatchObject({ status: 'timeout' })
    await conUpdatedAt(fila, new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000))
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RELEASED')
  })

  it('un `success` cuyo Payment no se puede acreditar se degrada a UNKNOWN (hubo una afirmación positiva) y NUNCA entra en la ventana', async () => {
    const row = await auditRequest({ status: 'SENT' })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: row.requestId, status: 'success', paymentId: 'pay-inexistente', authorizationCode: 'A1' } as any,
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila.status).toBe('UNKNOWN')
    expect((fila.resultJson as any).terminalResult).toBeUndefined()
    await conUpdatedAt(fila, new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000))
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
  })

  it('un `success` cuya verificación REVIENTA sobre una fila TIMED_OUT elegible la deja UNKNOWN (fuera de la ventana): nunca se libera lo que alguien afirmó cobrar', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    const spy = jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('db caída'))
    try {
      await terminalPaymentService.handlePaymentResultFromSocket(
        { requestId: row.requestId, status: 'success', paymentId: 'pay-x' } as any,
        { socketId: 'fixture-socket', terminalId: fixture, venueId },
      )
    } finally {
      spy.mockRestore()
    }
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila.status).toBe('UNKNOWN')
    expect(fila.lateResult).toBe(true)
    expect((fila.resultJson as any).terminalResult).toBeUndefined()
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
  })

  it('con un webhook APROBADO del intento ya guardado (sin Payment) la ventana NO libera: marca BANK_APPROVED_AWAITING_PAYMENT y sigue bloqueando', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    await prisma.providerEventLog.create({ data: eventoAprobado(attemptId, 'tx-1') })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('HELD_BY_BANK_EVIDENCE')
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: 'BANK_APPROVED_AWAITING_PAYMENT', paymentId: null })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    // El GET sigue diciendo «pendiente»: BANK_APPROVED_AWAITING_PAYMENT no está en la lista blanca.
    expect(await terminalPaymentService.getPaymentStatus(row.requestId, venueId)).toMatchObject({
      status: 'TIMED_OUT',
      outcome: 'UNRESOLVED',
    })
    // Segunda pasada: ya no es elegible (failureCode puesto) y no vuelve a escribir bitácora.
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    expect(
      await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_WINDOW_HELD_BY_BANK_EVIDENCE', entityId: row.id } }),
    ).toBe(1)
  })

  it('un webhook RECHAZADO del intento no veta: la ventana libera igual (un rechazo no es evidencia de cobro)', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    const rechazado = eventoAprobado(attemptId, 'tx-declined')
    rechazado.payload.payload.status = 'declined'
    await prisma.providerEventLog.create({ data: rechazado })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RELEASED')
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).failureCode).toBe('NO_EVIDENCE_AFTER_WINDOW')
  })

  it('la decisión de la ventana espera al candado del intento: un webhook APROBADO que se persiste mientras la ventana decide la RETIENE (no la libera)', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    const esperar = async (cond: () => Promise<boolean>, ms = 5000) => {
      const hasta = Date.now() + ms
      while (Date.now() < hasta) {
        if (await cond()) return true
        await new Promise(r => setTimeout(r, 40))
      }
      return cond()
    }
    const esperandoCandado = async () =>
      (
        await prisma.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory' AND query ILIKE '%hashtext%'`,
        )
      )[0].n
    const base = await esperandoCandado()
    let soltar!: () => void
    const puerta = new Promise<void>(r => {
      soltar = r
    })
    let candadoTomado!: () => void
    const tomado = new Promise<void>(r => {
      candadoTomado = r
    })
    // El «ingreso del webhook»: toma el candado del intento, persiste el APROBADO (todavía invisible: sin commit) y se queda
    // dentro hasta que la prueba lo suelta.
    const ingreso = prisma.$transaction(
      async tx => {
        await candadoDeIntento(tx, attemptId)
        await tx.providerEventLog.create({ data: eventoAprobado(attemptId, 'tx-race') })
        candadoTomado()
        await puerta
      },
      { timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    )
    await tomado
    const liberacion = terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')
    expect(await esperar(async () => (await esperandoCandado()) > base)).toBe(true) // la ventana ESPERA el candado, no decide a ciegas
    soltar()
    await ingreso
    expect(await liberacion).toBe('HELD_BY_BANK_EVIDENCE')
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: 'BANK_APPROVED_AWAITING_PAYMENT' })
  })

  it('el CAS de liberación exige el updatedAt leído: un resultado que renovó el reloj entre la lectura y la escritura anula la liberación', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    // Se simula la carrera renovando `updatedAt` (autocommit, como lo haría un resultado tardío de la terminal) DENTRO de la
    // transacción de la ventana, entre la consulta del veto y el CAS — el único hueco real: el CAS corre sobre el cliente de la
    // transacción (`tx`), así que un espía sobre `prisma.terminalPaymentRequest.updateMany` no lo alcanzaría.
    const svc = terminalPaymentService as any
    const original = svc.aprobacionBancariaConocida.bind(svc)
    const spy = jest.spyOn(svc, 'aprobacionBancariaConocida').mockImplementationOnce(async (...args: unknown[]) => {
      const r = await original(...args)
      await prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "updatedAt" = (NOW() AT TIME ZONE 'UTC') WHERE "id" = ${row.id}`
      return r
    })
    try {
      expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    } finally {
      spy.mockRestore()
    }
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: null })
    expect(fila.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime()) // el reloj sí se renovó: el CAS lo vio
    expect(await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_RELEASED_AFTER_WINDOW', entityId: row.id } })).toBe(
      0,
    )
  })

  it('un APROBADO que entra por el fallback SIN candado entre el veto y el CAS anula la liberación (NUNCA RELEASED) y la siguiente pasada la retiene', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    // Simula EXACTAMENTE lo que hace el fallback (evento + toque de la solicitud, fuera del candado) en el hueco entre la
    // consulta del veto y el CAS: el espía deja pasar la consulta real y, antes de contestar «sin aprobación», comete el fallback.
    const svc = terminalPaymentService as any
    const original = svc.aprobacionBancariaConocida.bind(svc)
    const spy = jest.spyOn(svc, 'aprobacionBancariaConocida').mockImplementationOnce(async (...args: unknown[]) => {
      const r = await original(...args)
      await prisma.$transaction(async tx => {
        await tx.providerEventLog.create({
          data: {
            ...eventoAprobado(attemptId, 'tx-fb'),
            payload: { ...eventoAprobado(attemptId, 'tx-fb').payload, _avoqado: { ingresoSinCandado: { en: new Date().toISOString() } } },
          },
        })
        await tx.$executeRaw`UPDATE "TerminalPaymentRequest" SET "updatedAt" = (NOW() AT TIME ZONE 'UTC') WHERE "requestId" = ${row.requestId} AND "venueId" = ${venueId}`
      })
      return r // «sin aprobación», como lo vio la consulta
    })
    try {
      expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    } finally {
      spy.mockRestore()
    }
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: null })
    await conUpdatedAt(fila, new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000))
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('HELD_BY_BANK_EVIDENCE')
  })

  it('closeRow conserva el sobre original al degradar un failed sin evidencia, escribe TIMED_OUT y programa la ventana', async () => {
    // Sin fake timers aquí: Prisma/pg usan temporizadores internos. El temporizador en sí se prueba en la unitaria.
    const row = await auditRequest({ status: 'SENT' })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: row.requestId, status: 'failed', errorMessage: 'User cancelled\n\nSDK U100: Operacion cancelada por el usuario' },
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
    const degradada = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(degradada).toMatchObject({ status: 'TIMED_OUT', failureCode: null, paymentId: null })
    expect((degradada.resultJson as any).status).toBe('timeout')
    expect((degradada.resultJson as any).terminalResult).toMatchObject({ status: 'failed', outcomeEvidence: null })
    expect((degradada.resultJson as any).terminalResult.errorMessage).toContain('SDK U100')
    // Mientras la ventana decide, orden y ranura siguen bloqueadas (régimen relajado incluido).
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    const programadas = (terminalPaymentService as any).ventanasProgramadas as Map<string, NodeJS.Timeout>
    expect(programadas.has(row.requestId)).toBe(true)
    clearTimeout(programadas.get(row.requestId)!)
    programadas.delete(row.requestId)
  })

  it('un `cancelled` sin evidencia también entra en la ventana con su sobre (terminalResult.status = cancelled)', async () => {
    const row = await auditRequest({ status: 'SENT' })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: row.requestId, status: 'cancelled', errorMessage: 'Pago cancelado en la terminal' },
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: null, cancelDisposition: null })
    expect((fila.resultJson as any).terminalResult).toMatchObject({ status: 'cancelled', errorMessage: 'Pago cancelado en la terminal' })
  })

  it('una fila RETENIDA por evidencia bancaria suelta LA RANURA a los 20 min como AUTO_RELEASED — la VENTA sigue bloqueada; una reciente sigue intacta', async () => {
    const retenida = await auditRequest({
      ...negativoSinEvidencia(),
      failureCode: 'BANK_APPROVED_AWAITING_PAYMENT',
      updatedAt: new Date(Date.now() - 21 * 60_000),
    })
    // Orden PROPIA para la reciente: así «la orden de la soltada sigue bloqueada» lo prueba la soltada sola.
    const otraOrden = await nuevaOrden()
    const reciente = await auditRequest({
      ...negativoSinEvidencia(),
      failureCode: 'BANK_APPROVED_AWAITING_PAYMENT',
      updatedAt: new Date(Date.now() - 5 * 60_000),
      terminalId: `${fixture}-d`,
      orderId: otraOrden.id,
    })
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())
    const soltada = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: retenida.id } })
    expect(soltada).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', paymentId: null })
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(false)
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
    // Asiento y correo: UNA vez, y de la soltada (`logAction` está mockeado globalmente en integración: se afirma sobre la llamada).
    const asientos = (logAction as jest.Mock).mock.calls
      .map(([p]) => p as { action: string; entityId?: string; data?: Record<string, unknown> })
      .filter(p => p.action === 'TERMINAL_PAYMENT_AUTO_RELEASED')
    expect(asientos).toHaveLength(1)
    expect(asientos[0]).toMatchObject({
      entityId: retenida.id,
      data: { requestId: retenida.requestId, reason: 'BANK_APPROVED_AWAITING_PAYMENT_20MIN' },
    })
    expect(sendOpsAlert).toHaveBeenCalledTimes(1)
    expect(sendOpsAlert).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining(fixture) }))
    const intacta = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: reciente.id } })
    expect(intacta.failureCode).toBe('BANK_APPROVED_AWAITING_PAYMENT')
    expect(await terminalPaymentService.isTerminalBusy(`${fixture}-d`, venueId)).toBe(true)
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, otraOrden.id)).toBe(true)
  })

  // ── Fix round 1 · IMPORTANT 1: el camino `late` de `closeRow` no es una puerta lateral a la ventana ──
  it('un negativo tardío SIN evidencia sobre una fila RETENIDA (BANK_APPROVED_AWAITING_PAYMENT) es un no-op: sigue retenida y el asiento de retención es UNO', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    await prisma.providerEventLog.create({ data: eventoAprobado(attemptId, 'tx-held') })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('HELD_BY_BANK_EVIDENCE')
    const retenida = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    ;(logger.info as jest.Mock).mockClear()
    // La terminal contesta tarde «failed» sin evidencia para la MISMA solicitud (llega por `closeRow`).
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: row.requestId, status: 'failed', errorMessage: 'SDK U100 tardío' },
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
    const despues = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(despues).toMatchObject({ status: 'TIMED_OUT', failureCode: 'BANK_APPROVED_AWAITING_PAYMENT', lateResult: false })
    expect(despues.updatedAt.getTime()).toBe(retenida.updatedAt.getTime())
    expect((despues.resultJson as any).terminalResult.errorMessage).not.toContain('tardío')
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('closeRow no-op'),
      expect.objectContaining({ requestId: row.requestId }),
    )
    // El barrido no la vuelve a retener ni a liberar: sigue con su único asiento.
    await conUpdatedAt(despues, new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000))
    expect(await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())).toEqual({
      released: 0,
      reconciled: 0,
      held: 0,
      heldUnbound: 0,
    })
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).failureCode).toBe(
      'BANK_APPROVED_AWAITING_PAYMENT',
    )
    expect(
      await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_WINDOW_HELD_BY_BANK_EVIDENCE', entityId: row.id } }),
    ).toBe(1)
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
  })

  it('un negativo tardío SIN evidencia sobre una fila SOLTADA por política (AUTO_RELEASED) tampoco la devuelve a la ventana: la ranura sigue libre', async () => {
    const soltada = await auditRequest({
      ...negativoSinEvidencia(),
      failureCode: 'AUTO_RELEASED',
      updatedAt: new Date(Date.now() - 60_000),
    })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: soltada.requestId, status: 'cancelled', errorMessage: 'tardío' },
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
    const despues = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: soltada.id } })
    expect(despues).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', lateResult: false })
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(false)
    expect(await terminalPaymentService.releaseUnprovenNegative(soltada.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
  })

  it('un negativo tardío SIN evidencia sobre una UNKNOWN con código de entrega (ACK_TIMEOUT) SÍ entra en la ventana: la terminal contestó', async () => {
    // Los UNKNOWN de entrega incierta llevan código (`ACK_TIMEOUT`/`ACK_REJECTED`/`SOCKET_NOT_FOUND`/`DELIVERY_NOT_RECORDED`):
    // la terminal que después contesta demuestra que sí recibió el cobro, y su negativo sin veredicto es exactamente lo que
    // la ventana decide. Sólo un TIMED_OUT con código (retenido o soltado por política) queda fuera del camino tardío.
    const unknown = await auditRequest({ status: 'UNKNOWN', failureCode: 'ACK_TIMEOUT' })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: unknown.requestId, status: 'failed', errorMessage: 'SDK U100' },
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
    const despues = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: unknown.id } })
    expect(despues).toMatchObject({ status: 'TIMED_OUT', failureCode: null, lateResult: true })
    expect((despues.resultJson as any).terminalResult).toMatchObject({ status: 'failed', errorMessage: 'SDK U100' })
  })

  // ── Fix round 1 · IMPORTANT 2: un Payment etiquetado que no se pudo ligar RETIENE, nunca libera ──
  it('si el pago exacto existe pero no se pudo ligar (motivo ≠ ALREADY_BOUND), la ventana NO libera: 🚨, la marca UNA vez PAYMENT_UNBOUND_AWAITING_REVIEW (Codex r2, P2-N1) y devuelve HELD_BY_UNBOUND_PAYMENT', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    const payment = await auditPayment({ processorData: { terminalPaymentRequestId: row.requestId, deviceSerialNumber: fixture } })
    ;(logger.error as jest.Mock).mockClear()
    const spy = jest
      .spyOn(terminalPaymentService, 'closeRowFromPaymentTx')
      .mockResolvedValueOnce({ bound: false, reason: 'TERMINAL_MISMATCH' })
    try {
      expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('HELD_BY_UNBOUND_PAYMENT')
    } finally {
      spy.mockRestore()
    }
    const retenida = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(retenida).toMatchObject({ status: 'TIMED_OUT', failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW', paymentId: null })
    expect(await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_RELEASED_AFTER_WINDOW', entityId: row.id } })).toBe(
      0,
    )
    const asientos = await prisma.activityLog.findMany({
      where: { venueId, action: 'TERMINAL_PAYMENT_WINDOW_HELD_BY_UNBOUND_PAYMENT', entityId: row.id },
    })
    expect(asientos).toHaveLength(1)
    expect(asientos[0].data).toMatchObject({
      requestId: row.requestId,
      terminalId: fixture,
      orderId,
      amountCents: 10000,
      paymentId: payment.id,
      reason: 'TERMINAL_MISMATCH',
    })
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('🚨 [TerminalPayment] window found a payment it could not bind'),
      expect.objectContaining({ requestId: row.requestId, venueId, paymentId: payment.id, reason: 'TERMINAL_MISMATCH' }),
    )
    // Y sigue bloqueando orden y ranura hasta que una persona lo revise.
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    // Segunda pasada: ya no es elegible (marcada) y no escribe un segundo asiento.
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    expect(
      await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_WINDOW_HELD_BY_UNBOUND_PAYMENT', entityId: row.id } }),
    ).toBe(1)
  })
})

// ── Task 3: la aprobación del banco que llega DESPUÉS de que la ventana liberó ──
describe('Aprobación tardía tras la ventana', () => {
  it('el webhook que llega después de liberar reabre la fila a COMPLETED, deja bitácora y grita si hay otro cobro con tarjeta en la misma orden', async () => {
    const vencida = new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000)
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: vencida })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RELEASED')
    // El cajero ya recobró la misma orden en otro intento (el caso de Testarudo del 16-sep 11:09):
    await auditPayment({ processorData: { terminalPaymentRequestId: 'otra-solicitud' } })
    // …y ahora llega la aprobación del PRIMER intento (misma llave/referencia que la solicitud liberada):
    const tardio = await auditPayment({ processorData: { terminalPaymentRequestId: row.requestId, deviceSerialNumber: fixture } })
    const cierre = await prisma.$transaction(tx =>
      terminalPaymentService.closeRowFromPaymentTx(tx, row.requestId, tardio.id, venueId, undefined, 'REST', undefined, 'webhook'),
    )
    expect(cierre).toMatchObject({
      bound: true,
      reopened: true,
      alarmed: true,
      previousStatus: 'FAILED',
      lateAfterWindow: { otherCardPaymentsOnOrderAfterRelease: 1 },
    })
    const reabierta = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(reabierta).toMatchObject({ status: 'COMPLETED', paymentId: tardio.id, lateResult: true, closedVia: 'webhook' })
    const bitacora = await prisma.activityLog.findMany({
      where: { venueId, action: 'TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW', entityId: row.id },
    })
    expect(bitacora).toHaveLength(1)
    expect((bitacora[0].data as any).otherCardPaymentsOnOrderAfterRelease).toBe(1)
    // Replay del mismo Payment sobre la fila ya reabierta: no gana, no escribe otro asiento.
    const replay = await prisma.$transaction(tx =>
      terminalPaymentService.closeRowFromPaymentTx(tx, row.requestId, tardio.id, venueId, undefined, 'REST', undefined, 'webhook'),
    )
    expect(replay.bound).toBe(false)
    expect(
      await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW', entityId: row.id } }),
    ).toBe(1)
  })

  it('un reembolso posterior en la orden NO cuenta como «otro cobro con tarjeta» (predicado NULL-seguro sobre Payment.type)', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RELEASED')
    await auditPayment({ type: 'REFUND', processorData: { terminalPaymentRequestId: 'otra-solicitud' } })
    await auditPayment({ type: null, processorData: { terminalPaymentRequestId: 'otra-mas' } }) // legacy sin tipo: SÍ cuenta
    const tardio = await auditPayment({ processorData: { terminalPaymentRequestId: row.requestId, deviceSerialNumber: fixture } })
    const cierre = await prisma.$transaction(tx =>
      terminalPaymentService.closeRowFromPaymentTx(tx, row.requestId, tardio.id, venueId, undefined, 'REST'),
    )
    expect(cierre).toMatchObject({ bound: true, lateAfterWindow: { otherCardPaymentsOnOrderAfterRelease: 1 } })
  })

  it('el correo sale DESPUÉS del commit y sólo cuando el cierre ganó: sendOpsAlert se llama una vez con el conteo', async () => {
    const opsAlert = await import('@/services/alerts/opsAlert.service')
    const spy = jest.spyOn(opsAlert, 'sendOpsAlert').mockResolvedValue(true)
    try {
      const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
      expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RELEASED')
      await auditPayment({ processorData: { terminalPaymentRequestId: row.requestId, deviceSerialNumber: fixture } })
      // El barrido de 30 min encuentra el Payment de la fila liberada y concilia por el cierre común.
      await terminalPaymentService.reconcileUnknownRequests(new Date())
      expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('COMPLETED')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0].subject).toContain('Cobro aprobado tarde tras la ventana')
      await terminalPaymentService.reconcileUnknownRequests(new Date())
      expect(spy).toHaveBeenCalledTimes(1) // ya está COMPLETED: no se repite
    } finally {
      spy.mockRestore()
    }
  })

  it('tras liberar por ventana, la MISMA orden vuelve a ser cobrable (la admisión acepta un cobro nuevo)', async () => {
    const orden = await nuevaOrden({})
    const row = await auditRequest({
      ...negativoSinEvidencia(),
      orderId: orden.id,
      updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000),
    })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RELEASED')
    // El ACK se pierde a propósito (como en `terminalPaymentRecovery`): la admisión ya decidió, y así el long-poll no cuelga 5 min.
    directEmit.mockImplementation((_event: string, _payload: unknown, callback?: (error: Error) => void) =>
      callback?.(new Error('lost ACK')),
    )
    const requestId = nextRequest()
    const b = await enviar({ requestId, venueId, terminalId: terminalDe('b'), orderId: orden.id, amountCents: 10000, requestedBy: fixture })
    expect(b).not.toBeInstanceOf(Error)
    expect(directEmit).toHaveBeenCalledTimes(1)
    // Admitida y entregada (no una lápida `REJECTED_*`): con el ACK perdido queda protegida como incierta.
    expect(await filasDe(requestId)).toEqual([
      expect.objectContaining({ status: 'UNKNOWN', failureCode: 'ACK_TIMEOUT', orderId: orden.id }),
    ])
  })

  // Fix round 1 · IMPORTANT 1: el camino del SOCKET también reabre («cola vieja»: el registro llega etiquetado sólo en
  // `processorData`, el registrador no liga, y luego la terminal manda su `success` tardío con el paymentId).
  it('un `success` tardío por SOCKET sobre una fila liberada por la ventana la reabre por el mismo cierre: un asiento y UN correo ops', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RELEASED')
    const tardio = await auditPayment({ processorData: { terminalPaymentRequestId: row.requestId, deviceSerialNumber: fixture } })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: row.requestId, status: 'success', paymentId: tardio.id },
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
    const reabierta = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(reabierta).toMatchObject({ status: 'COMPLETED', paymentId: tardio.id, lateResult: true, closedVia: 'terminal' })
    expect(
      await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW', entityId: row.id } }),
    ).toBe(1)
    expect(sendOpsAlert).toHaveBeenCalledTimes(1)
    expect(sendOpsAlert).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining(fixture) }))
  })
})

// ── Guardas extra (re-revisión de la Task 2, misma dirección del dinero) ──
describe('G1 · la ventana NUNCA libera mientras exista un Payment etiquetado con la solicitud, aunque no lo pueda atribuir', () => {
  it('un pago etiquetado pero cobrado en OTRA terminal (filtrado-antes-de-encontrado) retiene: 🚨 una vez, marca PAYMENT_UNBOUND_AWAITING_REVIEW (Codex r2, P2-N1) y devuelve HELD_BY_UNBOUND_PAYMENT', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    // Etiquetado con ESTA solicitud, pero la FK `terminal` y el serial persistido apuntan a otro aparato: `findReconcilablePayment`
    // lo filtra («attributed to another terminal») y la ventana se quedaba sin nada que conciliar… y liberaba con dinero de por medio.
    const ajeno = await auditPayment(
      { processorData: { terminalPaymentRequestId: row.requestId, deviceSerialNumber: terminalDe('otra') } },
      terminalDe('otra'),
    )
    ;(logger.error as jest.Mock).mockClear()
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('HELD_BY_UNBOUND_PAYMENT')
    const retenida = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(retenida).toMatchObject({ status: 'TIMED_OUT', failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW', paymentId: null })
    expect(await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_RELEASED_AFTER_WINDOW', entityId: row.id } })).toBe(
      0,
    )
    const asientos = await prisma.activityLog.findMany({
      where: { venueId, action: 'TERMINAL_PAYMENT_WINDOW_HELD_BY_UNBOUND_PAYMENT', entityId: row.id },
    })
    expect(asientos).toHaveLength(1)
    expect(asientos[0].data).toMatchObject({ requestId: row.requestId, paymentId: ajeno.id, reason: 'PAYMENT_NOT_ATTRIBUTABLE' })
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('🚨 [TerminalPayment] window found a tagged payment it could not attribute'),
      expect.objectContaining({ requestId: row.requestId, venueId, count: 1 }),
    )
    // Sigue bloqueando orden y ranura hasta que una persona lo revise.
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
  })
})

describe('G2 · la evidencia bancaria conocida gana a un negativo ACREDITADO tardío de la terminal', () => {
  const declinadaTardia = (requestId: string) =>
    terminalPaymentService.handlePaymentResultFromSocket(
      { requestId, status: 'failed', outcomeEvidence: 'PROCESSOR_DECLINED', errorMessage: 'Declinada por el banco (tardía)' },
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )

  it('una fila RETENIDA (BANK_APPROVED_AWAITING_PAYMENT) NO se vuelve FAILED por un failed/PROCESSOR_DECLINED tardío: sigue retenida y bloqueando la orden', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), failureCode: 'BANK_APPROVED_AWAITING_PAYMENT' })
    ;(logger.info as jest.Mock).mockClear()
    await declinadaTardia(row.requestId)
    const despues = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(despues).toMatchObject({
      status: 'TIMED_OUT',
      failureCode: 'BANK_APPROVED_AWAITING_PAYMENT',
      lateResult: false,
      paymentId: null,
    })
    expect(despues.updatedAt.getTime()).toBe(row.updatedAt.getTime())
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('closeRow no-op'),
      expect.objectContaining({ requestId: row.requestId }),
    )
  })

  it('…pero un negativo ACREDITADO tardío SÍ sigue cerrando una fila SOLTADA por política (AUTO_RELEASED / MANUAL_RELEASE) y una de la ventana (failureCode NULL)', async () => {
    const soltada = await auditRequest({
      ...negativoSinEvidencia(),
      failureCode: 'AUTO_RELEASED',
      updatedAt: new Date(Date.now() - 60_000),
    })
    const manual = await auditRequest({
      ...negativoSinEvidencia(),
      failureCode: 'MANUAL_RELEASE',
      updatedAt: new Date(Date.now() - 60_000),
    })
    await declinadaTardia(soltada.requestId)
    await declinadaTardia(manual.requestId)
    for (const id of [soltada.id, manual.id]) {
      expect(await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'FAILED',
        failureCode: 'TPV_CONFIRMED_NO_CHARGE',
        lateResult: true,
      })
    }
    // La fila de la VENTANA (TIMED_OUT sin código): la exclusión de G2 tiene que ser NULL-segura, o un `NOT {…}` la dejaría fuera
    // y la declinación acreditada —justo la evidencia que la ventana espera— se ignoraría hasta liberarla sin evidencia a los 30 s.
    const otraOrden = await nuevaOrden()
    const enVentana = await auditRequest({ ...negativoSinEvidencia(), terminalId: terminalDe('v'), orderId: otraOrden.id })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: enVentana.requestId, status: 'failed', outcomeEvidence: 'PROCESSOR_DECLINED', errorMessage: 'Declinada' },
      { socketId: 'fixture-socket', terminalId: terminalDe('v'), venueId },
    )
    expect(await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: enVentana.id } })).toMatchObject({
      status: 'FAILED',
      failureCode: 'TPV_CONFIRMED_NO_CHARGE',
      lateResult: true,
    })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, otraOrden.id)).toBe(false)
  })
})

// ── Codex r1 · P1-A: un APROBADO conocido retiene también al negativo ACREDITADO (G2 sólo miraba el marcador) ──
describe('P1-A · un webhook APROBADO conocido (sin Payment todavía) retiene a un negativo ACREDITADO de la terminal', () => {
  const declinada = (requestId: string, terminalId: string = fixture) =>
    terminalPaymentService.handlePaymentResultFromSocket(
      { requestId, status: 'failed', outcomeEvidence: 'PROCESSOR_DECLINED', errorMessage: 'Declinada por el banco' },
      { socketId: 'fixture-socket', terminalId, venueId },
    )

  it('(1) en vuelo: fila SENT + vínculo + APROBADO persistido y llega failed/PROCESSOR_DECLINED ⇒ TIMED_OUT/null con el sobre (evidencia dentro), ranura y orden bloqueadas, y a los 30 s la ventana la RETIENE', async () => {
    const row = await auditRequest({ status: 'SENT' })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    const evento = await prisma.providerEventLog.create({ data: eventoAprobado(attemptId, 'tx-known') })
    ;(logger.warn as jest.Mock).mockClear()
    await declinada(row.requestId)
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: null, paymentId: null })
    expect((fila.resultJson as any).status).toBe('timeout')
    expect((fila.resultJson as any).outcomeEvidence).toBeUndefined() // el sobre degradado NO acredita nada por sí mismo
    expect((fila.resultJson as any).terminalResult).toMatchObject({ status: 'failed', outcomeEvidence: 'PROCESSOR_DECLINED' })
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('bank approval'),
      expect.objectContaining({ requestId: row.requestId, eventLogId: evento.id }),
    )
    await conUpdatedAt(fila, new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000))
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('HELD_BY_BANK_EVIDENCE')
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).failureCode).toBe(
      'BANK_APPROVED_AWAITING_PAYMENT',
    )
    const programadas = (terminalPaymentService as any).ventanasProgramadas as Map<string, NodeJS.Timeout>
    clearTimeout(programadas.get(row.requestId)!)
    programadas.delete(row.requestId)
  })

  it('(2) tardío sobre TIMED_OUT/AUTO_RELEASED con APROBADO conocido ⇒ NO pasa a FAILED: sigue AUTO_RELEASED (el camino tardío de una TIMED_OUT con código no entra)', async () => {
    const soltada = await auditRequest({
      ...negativoSinEvidencia(),
      failureCode: 'AUTO_RELEASED',
      updatedAt: new Date(Date.now() - 60_000),
    })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: soltada.requestId, venueId, terminalId: fixture } })
    await prisma.providerEventLog.create({ data: eventoAprobado(attemptId, 'tx-known-late') })
    await declinada(soltada.requestId)
    const despues = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: soltada.id } })
    expect(despues).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', lateResult: false, paymentId: null })
    expect(despues.updatedAt.getTime()).toBe(soltada.updatedAt.getTime())
    // La VENTA sigue bloqueada (el banco aprobó y el Payment aún no existe): el barrido de 30 min la concilia cuando aparezca.
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
  })

  it('(3) regresión: el MISMO negativo acreditado SIN evento aprobado (vínculo con un RECHAZADO) sigue cerrando FAILED/TPV_CONFIRMED_NO_CHARGE', async () => {
    const row = await auditRequest({ status: 'SENT' })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    const rechazado = eventoAprobado(attemptId, 'tx-declined')
    rechazado.payload.payload.status = 'declined'
    await prisma.providerEventLog.create({ data: rechazado })
    await declinada(row.requestId)
    expect(await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'FAILED',
      failureCode: 'TPV_CONFIRMED_NO_CHARGE',
    })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(false)
  })
})

// ── Codex r1 · P1-C: el veto y el CAS cubren a los escritores concurrentes (candado por SOLICITUD + NOT EXISTS en la escritura) ──
describe('P1-C · la liberación se revalida EN la escritura: candado por solicitud y NOT EXISTS en el CAS', () => {
  const vencida = () => new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000)
  const conVinculo = async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: vencida() })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    return { row, attemptId }
  }

  it('(1) carrera con el fallback: un APROBADO que se persiste por fuera (sin candado y SIN tocar el reloj) entre el veto y el CAS ⇒ NOT_ELIGIBLE, fila TIMED_OUT/null, y la siguiente pasada la RETIENE', async () => {
    const { row, attemptId } = await conVinculo()
    const svc = terminalPaymentService as any
    const original = svc.aprobacionBancariaConocida.bind(svc)
    const spy = jest.spyOn(svc, 'aprobacionBancariaConocida').mockImplementationOnce(async (...args: unknown[]) => {
      const r = await original(...args)
      // El fallback cuyo toque venció por lock_timeout: el evento queda, la solicitud no se toca.
      await prisma.providerEventLog.create({ data: eventoAprobado(attemptId, 'tx-fb-sin-toque') })
      return r
    })
    try {
      expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    } finally {
      spy.mockRestore()
    }
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: null, paymentId: null })
    expect(fila.updatedAt.getTime()).toBe(row.updatedAt.getTime()) // nadie tocó el reloj: sólo el NOT EXISTS pudo frenar el CAS
    expect(await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_RELEASED_AFTER_WINDOW', entityId: row.id } })).toBe(
      0,
    )
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('HELD_BY_BANK_EVIDENCE')
  })

  it('(2) un Payment etiquetado SÓLO en processorData que entra entre el veto y el CAS ⇒ NOT_ELIGIBLE (el CAS lo ve aunque G1 ya hubiera pasado)', async () => {
    const { row } = await conVinculo()
    const svc = terminalPaymentService as any
    const original = svc.aprobacionBancariaConocida.bind(svc)
    const spy = jest.spyOn(svc, 'aprobacionBancariaConocida').mockImplementationOnce(async (...args: unknown[]) => {
      const r = await original(...args)
      await auditPayment({ processorData: { terminalPaymentRequestId: row.requestId } })
      return r
    })
    try {
      expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    } finally {
      spy.mockRestore()
    }
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: null, paymentId: null })
    expect(await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_RELEASED_AFTER_WINDOW', entityId: row.id } })).toBe(
      0,
    )
  })

  it('(3a) la ventana ESPERA al candado de la solicitud: un vínculo + APROBADO que se publican mientras la ventana decide la RETIENEN (los vínculos se enumeran dentro de la transacción)', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: vencida() })
    const attemptId = `att-${randomUUID()}`
    const base = await esperandoCandado()
    const p = puerta()
    // «La publicación del vínculo»: toma el candado de la SOLICITUD, publica vínculo + APROBADO (invisibles: sin commit) y espera.
    const publicacion = prisma.$transaction(
      async tx => {
        await candadoDeSolicitud(tx, row.requestId)
        await tx.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
        await tx.providerEventLog.create({ data: eventoAprobado(attemptId, 'tx-race-solicitud') })
        p.tomado()
        await p.abierta
      },
      { timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    )
    await Promise.race([p.tomada, publicacion]) // si la transacción revienta antes de tomar el candado, la prueba cae aquí y no a los 60 s
    const liberacion = terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')
    try {
      expect(await esperar(async () => (await esperandoCandado()) > base)).toBe(true) // la ventana ESPERA, no decide a ciegas
    } finally {
      p.soltar()
      await publicacion
    }
    expect(await liberacion).toBe('HELD_BY_BANK_EVIDENCE')
    expect(await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'TIMED_OUT',
      failureCode: 'BANK_APPROVED_AWAITING_PAYMENT',
    })
  })

  it('(3b) y al revés: la publicación del vínculo ESPERA a la ventana (candado de solicitud → candado de intento)', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: vencida() })
    const attemptId = `att-${randomUUID()}`
    const base = await esperandoCandado()
    const p = puerta()
    // «La ventana»: sostiene el candado de la SOLICITUD.
    const ventana = prisma.$transaction(
      async tx => {
        await candadoDeSolicitud(tx, row.requestId)
        p.tomado()
        await p.abierta
      },
      { timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    )
    await Promise.race([p.tomada, ventana])
    const publicacion = terminalPaymentService.handleAttemptOpenedFromSocket(
      { requestId: row.requestId, attemptId },
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
    try {
      expect(await esperar(async () => (await esperandoCandado()) > base)).toBe(true) // la publicación ESPERA
      expect(await prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId } })).toBeNull() // …y no ha escrito nada
    } finally {
      p.soltar()
      await ventana
    }
    expect(await publicacion).toMatchObject({ success: true })
    expect(await prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId } })).toMatchObject({ requestId: row.requestId })
  })
})

// ── Codex r2 · P1-A: el negativo se decide y se ESCRIBE bajo los candados, con el veto revalidado en la escritura ──
describe('P1-A (r2) · el negativo de la terminal se escribe bajo candado de solicitud → intentos, con NOT EXISTS de APROBADO en el UPDATE', () => {
  const declinada = (requestId: string) =>
    terminalPaymentService.handlePaymentResultFromSocket(
      { requestId, status: 'failed', outcomeEvidence: 'PROCESSOR_DECLINED', errorMessage: 'Declinada por el banco' },
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
  const limpiarTemporizador = (requestId: string) => {
    const programadas = (terminalPaymentService as any).ventanasProgramadas as Map<string, NodeJS.Timeout>
    clearTimeout(programadas.get(requestId)!)
    programadas.delete(requestId)
  }

  it('(a) un APROBADO que se persiste ENTRE la consulta y la escritura (el ingreso normal aterrizando) no deja pasar el FAILED: la fila queda TIMED_OUT/null con el sobre y la ventana la RETIENE', async () => {
    const row = await auditRequest({ status: 'SENT' })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    const svc = terminalPaymentService as any
    const original = svc.aprobacionBancariaConocida.bind(svc)
    // La PRIMERA consulta (la de closeRow) contesta «sin aprobación» pero, antes de contestar, el APROBADO ya es durable.
    const spy = jest.spyOn(svc, 'aprobacionBancariaConocida').mockImplementationOnce(async (...args: unknown[]) => {
      const r = await original(...args)
      expect(r).toBeNull()
      await prisma.providerEventLog.create({ data: eventoAprobado(attemptId, 'tx-entre-consulta-y-escritura') })
      return null
    })
    try {
      await declinada(row.requestId)
    } finally {
      spy.mockRestore()
    }
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: null, paymentId: null })
    expect((fila.resultJson as any).status).toBe('timeout')
    expect((fila.resultJson as any).terminalResult).toMatchObject({ status: 'failed', outcomeEvidence: 'PROCESSOR_DECLINED' })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
    limpiarTemporizador(row.requestId)
    await conUpdatedAt(fila, new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000))
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('HELD_BY_BANK_EVIDENCE')
  })

  it('(b) el negativo ESPERA al candado de la solicitud que sostiene la ventana (medido en pg_stat_activity) y sólo escribe cuando lo suelta', async () => {
    const row = await auditRequest({ status: 'SENT' })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    const base = await esperandoCandado()
    const p = puerta()
    const ventana = prisma.$transaction(
      async tx => {
        await candadoDeSolicitud(tx, row.requestId)
        p.tomado()
        await p.abierta
      },
      { timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    )
    await Promise.race([p.tomada, ventana])
    const cierre = declinada(row.requestId)
    try {
      expect(await esperar(async () => (await esperandoCandado()) > base)).toBe(true) // el negativo ESPERA
      expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('SENT') // …sin escribir
    } finally {
      p.soltar()
      await ventana
    }
    await cierre
    expect(await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'FAILED',
      failureCode: 'TPV_CONFIRMED_NO_CHARGE',
    })
  })

  it('(c) regresión: el negativo acreditado SIN aprobación sigue cerrando FAILED/TPV_CONFIRMED_NO_CHARGE en vuelo y tardío (sobre una UNKNOWN), y un cancelled/PRE_AUTHORIZATION cierra CANCELLED/ACCEPTED', async () => {
    const enVuelo = await auditRequest({ status: 'SENT' })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: enVuelo.requestId, venueId, terminalId: fixture } })
    await declinada(enVuelo.requestId)
    expect(await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: enVuelo.id } })).toMatchObject({
      status: 'FAILED',
      failureCode: 'TPV_CONFIRMED_NO_CHARGE',
      lateResult: false,
    })
    const otraOrden = await nuevaOrden()
    const tardia = await auditRequest({ status: 'UNKNOWN', failureCode: 'ACK_TIMEOUT', orderId: otraOrden.id })
    await declinada(tardia.requestId)
    expect(await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: tardia.id } })).toMatchObject({
      status: 'FAILED',
      failureCode: 'TPV_CONFIRMED_NO_CHARGE',
      lateResult: true,
    })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, otraOrden.id)).toBe(false)
    const cancelada = await auditRequest({ status: 'SENT', orderId: otraOrden.id })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: cancelada.requestId, status: 'cancelled', outcomeEvidence: 'PRE_AUTHORIZATION' },
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
    expect(await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: cancelada.id } })).toMatchObject({
      status: 'CANCELLED',
      cancelDisposition: 'ACCEPTED',
      failureCode: null,
    })
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(false)
  })
})

// ── Codex r2 · P2-N1: un Payment ligado SÓLO por la llave del intento se concilia o se retiene con MARCA, nunca en silencio ──
describe('P2-N1 · Payment con idempotencyKey del intento, sin etiqueta y sin webhook', () => {
  const vencida = () => new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000)
  const conVinculo = async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: vencida() })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    return { row, attemptId }
  }
  const regimenEstricto = async (encendido: boolean) => {
    await prisma.venue.update({
      where: { id: venueId },
      data: { terminalPaymentStrictEnabled: encendido, ...(encendido ? { terminalPaymentStrictSince: new Date(0) } : {}) },
    })
    await invalidarVenuesEstrictos()
  }
  afterEach(async () => regimenEstricto(false))

  it('(a) cobrado en ESTA terminal ⇒ la ventana lo concilia por el cierre común: RECONCILED, fila COMPLETED ligada y el Payment etiquetado', async () => {
    const { row, attemptId } = await conVinculo()
    const pago = await auditPayment({ idempotencyKey: attemptId, processorData: { deviceSerialNumber: fixture } })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RECONCILED')
    const cerrada = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(cerrada).toMatchObject({ status: 'COMPLETED', paymentId: pago.id, lateResult: true })
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: pago.id } })).toMatchObject({ terminalPaymentRequestId: row.requestId })
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(false)
  })

  it('(b) cobrado en OTRA terminal ⇒ HELD_BY_UNBOUND_PAYMENT: TIMED_OUT/PAYMENT_UNBOUND_AWAITING_REVIEW, un asiento, ranura ocupada en los DOS regímenes, orden bloqueada; segunda pasada NOT_ELIGIBLE sin segundo asiento', async () => {
    const { row, attemptId } = await conVinculo()
    const ajeno = await auditPayment(
      { idempotencyKey: attemptId, processorData: { deviceSerialNumber: terminalDe('otra') } },
      terminalDe('otra'),
    )
    ;(logger.error as jest.Mock).mockClear()
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('HELD_BY_UNBOUND_PAYMENT')
    const retenida = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(retenida).toMatchObject({ status: 'TIMED_OUT', failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW', paymentId: null })
    const asientos = await prisma.activityLog.findMany({
      where: { venueId, action: 'TERMINAL_PAYMENT_WINDOW_HELD_BY_UNBOUND_PAYMENT', entityId: row.id },
    })
    expect(asientos).toHaveLength(1)
    expect(asientos[0].data).toMatchObject({
      requestId: row.requestId,
      terminalId: fixture,
      orderId,
      amountCents: 10000,
      paymentId: ajeno.id,
    })
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
    // La ranura en los DOS regímenes.
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    await regimenEstricto(true)
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    await regimenEstricto(false)
    // Segunda pasada: ya marcada ⇒ NOT_ELIGIBLE y ningún asiento más.
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    expect(
      await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_WINDOW_HELD_BY_UNBOUND_PAYMENT', entityId: row.id } }),
    ).toBe(1)
    // El GET sigue diciendo «pendiente»: el marcador no está en la lista blanca.
    expect(await terminalPaymentService.getPaymentStatus(row.requestId, venueId)).toMatchObject({
      status: 'TIMED_OUT',
      outcome: 'UNRESOLVED',
    })
  })

  it('(c) a los 21 min el barrido la suelta como AUTO_RELEASED (ranura libre, orden bloqueada) con UN asiento y UN correo que nombra el marcador; y si el Payment se vuelve ligable, el barrido de 30 min la concilia', async () => {
    const { row, attemptId } = await conVinculo()
    const ajeno = await auditPayment(
      { idempotencyKey: attemptId, processorData: { deviceSerialNumber: terminalDe('otra') } },
      terminalDe('otra'),
    )
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('HELD_BY_UNBOUND_PAYMENT')
    const marcada = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    await conUpdatedAt(marcada, new Date(Date.now() - 21 * 60_000))
    ;(logAction as jest.Mock).mockClear()
    ;(sendOpsAlert as jest.Mock).mockClear()
    expect(await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())).toEqual({
      released: 0,
      reconciled: 0,
      held: 0,
      heldUnbound: 0,
    })
    const soltada = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(soltada).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', paymentId: null })
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(false)
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
    const asientos = (logAction as jest.Mock).mock.calls
      .map(([p]) => p as { action: string; entityId?: string; data?: Record<string, unknown> })
      .filter(p => p.action === 'TERMINAL_PAYMENT_AUTO_RELEASED')
    expect(asientos).toHaveLength(1)
    expect(asientos[0]).toMatchObject({
      entityId: row.id,
      data: { requestId: row.requestId, reason: 'PAYMENT_UNBOUND_AWAITING_REVIEW_20MIN' },
    })
    expect(sendOpsAlert).toHaveBeenCalledTimes(1)
    const correo = (sendOpsAlert as jest.Mock).mock.calls[0][0] as { subject: string; lines: string[] }
    expect(`${correo.subject} ${correo.lines.join(' ')}`).toContain('PAYMENT_UNBOUND_AWAITING_REVIEW')
    // Sigue en el barrido de 30 min: mientras el Payment siga siendo AJENO no se liga…
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('TIMED_OUT')
    // …y cuando se vuelve ligable (atribuido a ESTA terminal), el barrido la concilia por el cierre común y etiqueta el Payment.
    const propia = await terminalDelFixture()
    await prisma.payment.update({
      where: { id: ajeno.id },
      data: { terminalId: propia.id, processorData: { deviceSerialNumber: fixture } },
    })
    await terminalPaymentService.reconcileUnknownRequests(new Date())
    expect(await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'COMPLETED',
      paymentId: ajeno.id,
      lateResult: true,
    })
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: ajeno.id } })).toMatchObject({ terminalPaymentRequestId: row.requestId })
  })
})

// ── Task 4: la declaración del cajero «no se presentó tarjeta» ──
describe('Declaración del cajero', () => {
  const serialDelFixture = `AVQD-${fixture.toUpperCase()}`
  const resolutionId = () => randomUUID()
  const declaracion = (requestId: string, extra: Record<string, unknown> = {}) => ({
    requestId,
    resolutionId: resolutionId(),
    statement: 'NO_INSTRUMENT_PRESENTED',
    statementVersion: 1,
    ...extra,
  })
  let owner: { id: string }
  let cajero: { id: string }

  beforeAll(async () => {
    // El OWNER declara con su sesión; el CAJERO sólo con el PIN del OWNER. Los dos son miembros ACTIVOS del venue.
    owner = await prisma.staff.create({
      data: {
        email: `${fixture}-owner@example.test`,
        firstName: 'Dueño',
        lastName: 'Fixture',
        organizations: { create: { organizationId: fixture, role: 'OWNER', isPrimary: true, isActive: true } },
        venues: { create: { venueId, role: 'OWNER', active: true, pin: '4321' } },
      },
      select: { id: true },
    })
    cajero = await prisma.staff.create({
      data: {
        email: `${fixture}-cajero@example.test`,
        firstName: 'Cajero',
        lastName: 'Fixture',
        organizations: { create: { organizationId: fixture, role: 'MEMBER', isPrimary: true, isActive: true } },
        venues: { create: { venueId, role: 'CASHIER', active: true, pin: '8765' } },
      },
      select: { id: true },
    })
  })

  afterAll(async () => {
    for (const s of [owner, cajero]) {
      if (!s) continue
      await prisma.staffVenue.deleteMany({ where: { staffId: s.id } })
      await prisma.staffOrganization.deleteMany({ where: { staffId: s.id } })
      await prisma.staff.deleteMany({ where: { id: s.id } })
    }
  })

  /** Una fila de la ventana (negativo sin evidencia, 10 s: todavía DENTRO de los 30 s) con su vínculo del intento. */
  async function filaConIntento() {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - 10_000) })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    return { row, attemptId }
  }
  const declarar = async (attemptId: string, actorStaffId: string, body: Record<string, unknown>) => {
    const { resolveNoInstrument } = await import('@/services/tpv/no-instrument-resolution.service')
    return resolveNoInstrument({ venueId, terminalSerial: serialDelFixture, attemptId, actorStaffId }, body)
  }

  it('(a) la sesión OWNER declara dentro de la ventana: FAILED/OPERATOR_RECONCILED_NO_CHARGE, orden y ranura libres, el GET dice NOT_CHARGED/OPERATOR, y la ventana ya no la toca', async () => {
    const { row, attemptId } = await filaConIntento()
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    const r = await declarar(attemptId, owner.id, declaracion(row.requestId))
    expect(r.resolution).toMatchObject({ by: 'SESSION' })
    expect(r.request).toMatchObject({
      status: 'FAILED',
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'OPERATOR_RECONCILED',
      evidenceClass: 'OPERATOR',
    })
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE', paymentId: null, cancelDisposition: null })
    expect(fila.resultJson as any).toMatchObject({ status: 'failed', outcomeEvidence: 'OPERATOR_RECONCILED' })
    expect((fila.resultJson as any).terminalResult.errorMessage).toContain('SDK U100') // el sobre original sobrevive
    const link = await prisma.terminalPaymentAttemptLink.findUniqueOrThrow({ where: { attemptId } })
    expect(link.operatorResolution).toMatchObject({
      id: r.resolution.id,
      kind: 'NO_INSTRUMENT_PRESENTED',
      staffId: owner.id,
      by: 'SESSION',
    })
    expect(await terminalPaymentService.getPaymentStatus(row.requestId, venueId)).toMatchObject({
      status: 'FAILED',
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'OPERATOR_RECONCILED',
      evidenceClass: 'OPERATOR',
    })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(false)
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(false)
    // La ventana, después: NOT_ELIGIBLE — no pisa la evidencia del operador, ni aunque ya hayan pasado los 30 s.
    await conUpdatedAt(fila, new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000))
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    expect(await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())).toEqual({
      released: 0,
      reconciled: 0,
      held: 0,
      heldUnbound: 0,
    })
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).failureCode).toBe(
      'OPERATOR_RECONCILED_NO_CHARGE',
    )
    // Bitácora REAL (dentro de la transacción), con quién declaró.
    const asiento = await prisma.activityLog.findFirst({
      where: { venueId, action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED', entityId: row.id },
    })
    expect(asiento).toMatchObject({ staffId: owner.id })
    expect(asiento?.data).toMatchObject({ requestId: row.requestId, attemptId, by: 'SESSION', sessionStaffId: owner.id })
  })

  it('(a-bis) la sesión CASHIER no puede sola (403 real) y con el PIN del OWNER declara por SUPERVISOR_PIN con el staffId del OWNER', async () => {
    const { row, attemptId } = await filaConIntento()
    await expect(declarar(attemptId, cajero.id, declaracion(row.requestId))).rejects.toMatchObject({
      code: 'SUPERVISOR_AUTHORIZATION_REQUIRED',
      statusCode: 403,
    })
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('TIMED_OUT')
    // El PIN de OTRO cajero no eleva.
    await expect(declarar(attemptId, cajero.id, declaracion(row.requestId, { supervisorPin: '8765' }))).rejects.toMatchObject({
      code: 'SUPERVISOR_AUTHORIZATION_REQUIRED',
    })
    const r = await declarar(attemptId, cajero.id, declaracion(row.requestId, { supervisorPin: '4321' }))
    expect(r.resolution).toMatchObject({ by: 'SUPERVISOR_PIN' })
    const link = await prisma.terminalPaymentAttemptLink.findUniqueOrThrow({ where: { attemptId } })
    expect(link.operatorResolution).toMatchObject({ staffId: owner.id, by: 'SUPERVISOR_PIN' })
    expect(JSON.stringify(link.operatorResolution)).not.toContain('4321')
    const asiento = await prisma.activityLog.findFirst({
      where: { venueId, action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED', entityId: row.id },
    })
    expect(asiento).toMatchObject({ staffId: owner.id })
    expect(asiento?.data).toMatchObject({ by: 'SUPERVISOR_PIN', sessionStaffId: cajero.id })
    // Una sesión que NO es miembro del venue no se rescata ni con el PIN del OWNER.
    const { row: otra, attemptId: otroIntento } = await filaConIntento()
    await expect(
      declarar(otroIntento, 'staff-que-no-existe', declaracion(otra.requestId, { supervisorPin: '4321' })),
    ).rejects.toMatchObject({
      code: 'SESSION_NOT_IN_VENUE',
      statusCode: 403,
    })
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: otra.id } })).status).toBe('TIMED_OUT')
  })

  it('(b) carrera declaración/aprobación: el Payment tardío del intento reabre la fila a COMPLETED (reopened + alarmed), la declaración se CONSERVA (trigger) y el replay devuelve lo declarado sin escribir', async () => {
    const { row, attemptId } = await filaConIntento()
    const body = declaracion(row.requestId)
    const primera = await declarar(attemptId, owner.id, body)
    // Llega el dinero del MISMO intento por el cierre común (REST o webhook): el dinero manda sobre la palabra del cajero.
    const tardio = await auditPayment({
      idempotencyKey: attemptId,
      processorData: { terminalPaymentRequestId: row.requestId, deviceSerialNumber: fixture },
    })
    const cierre = await prisma.$transaction(tx =>
      terminalPaymentService.closeRowFromPaymentTx(tx, row.requestId, tardio.id, venueId, undefined, 'REST', undefined, 'webhook'),
    )
    expect(cierre).toMatchObject({ bound: true, reopened: true, alarmed: true, previousStatus: 'FAILED' })
    const reabierta = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(reabierta).toMatchObject({ status: 'COMPLETED', paymentId: tardio.id, lateResult: true })
    // La declaración sobrevive intacta en el vínculo…
    const link = await prisma.terminalPaymentAttemptLink.findUniqueOrThrow({ where: { attemptId } })
    expect(link.operatorResolution).toMatchObject({ id: primera.resolution.id, staffId: owner.id })
    // …y el trigger la vuelve INMUTABLE: ni borrarla ni reescribirla.
    await expect(
      prisma.terminalPaymentAttemptLink.update({ where: { attemptId }, data: { operatorResolution: Prisma.DbNull } }),
    ).rejects.toThrow(/immutable/)
    await expect(
      prisma.terminalPaymentAttemptLink.update({
        where: { attemptId },
        data: { operatorResolution: { ...(link.operatorResolution as object), staffId: cajero.id } },
      }),
    ).rejects.toThrow(/immutable/)
    // El replay con el MISMO resolutionId devuelve lo declarado (200) sin escribir: la fila COMPLETED no se toca y no hay segundo asiento.
    const replay = await declarar(attemptId, owner.id, body)
    expect(replay.resolution).toEqual(primera.resolution)
    expect(replay.request).toMatchObject({ status: 'COMPLETED', outcome: 'CHARGED', paymentId: tardio.id })
    expect(replay.attempt).toMatchObject({ outcome: 'RECORDED', paymentId: tardio.id, isWinner: true })
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('COMPLETED')
    expect(
      await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED', entityId: row.id } }),
    ).toBe(1)
    // Y una declaración NUEVA (otro resolutionId) sobre el intento ya declarado es conflicto, no una segunda verdad.
    await expect(declarar(attemptId, owner.id, declaracion(row.requestId))).rejects.toMatchObject({ code: 'RESOLUTION_CONFLICT' })
  })

  it('(c) con un ProviderEventLog APROBADO del intento y sin Payment → 409 POSITIVE_EVIDENCE_EXISTS y la fila intacta', async () => {
    const { row, attemptId } = await filaConIntento()
    await prisma.providerEventLog.create({ data: eventoAprobado(attemptId, 'tx-veto') })
    await expect(declarar(attemptId, owner.id, declaracion(row.requestId))).rejects.toMatchObject({
      code: 'POSITIVE_EVIDENCE_EXISTS',
      statusCode: 409,
    })
    const intacta = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(intacta).toMatchObject({ status: 'TIMED_OUT', failureCode: null, paymentId: null })
    expect(intacta.updatedAt.getTime()).toBe(row.updatedAt.getTime())
    expect((await prisma.terminalPaymentAttemptLink.findUniqueOrThrow({ where: { attemptId } })).operatorResolution).toBeNull()
    expect(
      await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED', entityId: row.id } }),
    ).toBe(0)
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    // Un webhook RECHAZADO no veta: es la ausencia de cobro que el cajero está declarando.
    const { row: otra, attemptId: otroIntento } = await filaConIntento()
    const rechazado = eventoAprobado(otroIntento, 'tx-declined')
    rechazado.payload.payload.status = 'declined'
    await prisma.providerEventLog.create({ data: rechazado })
    expect((await declarar(otroIntento, owner.id, declaracion(otra.requestId))).resolution).toMatchObject({ by: 'SESSION' })
  })

  it('(c-bis) dos intentos vinculados a la misma solicitud → 409 OTHER_ATTEMPT_UNRESOLVED; una fila RETENIDA por el banco → POSITIVE_EVIDENCE_EXISTS', async () => {
    const { row, attemptId } = await filaConIntento()
    await prisma.terminalPaymentAttemptLink.create({
      data: { attemptId: `att-${randomUUID()}`, requestId: row.requestId, venueId, terminalId: fixture },
    })
    await expect(declarar(attemptId, owner.id, declaracion(row.requestId))).rejects.toMatchObject({ code: 'OTHER_ATTEMPT_UNRESOLVED' })
    const retenida = await auditRequest({
      ...negativoSinEvidencia(),
      failureCode: 'BANK_APPROVED_AWAITING_PAYMENT',
      terminalId: terminalDe('r'),
    })
    const intentoRetenido = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({
      data: { attemptId: intentoRetenido, requestId: retenida.requestId, venueId, terminalId: terminalDe('r') },
    })
    const { resolveNoInstrument } = await import('@/services/tpv/no-instrument-resolution.service')
    await expect(
      resolveNoInstrument(
        { venueId, terminalSerial: `AVQD-${terminalDe('r').toUpperCase()}`, attemptId: intentoRetenido, actorStaffId: owner.id },
        declaracion(retenida.requestId),
      ),
    ).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: retenida.id } })).failureCode).toBe(
      'BANK_APPROVED_AWAITING_PAYMENT',
    )
  })
  // ── Codex r1 · P1-C (4): el CAS de la declaración también revalida el veto en la escritura ──
  it('(P1-C · 4) un APROBADO que entra entre el veto y el CAS de la declaración ⇒ 409 ATTEMPT_NOT_ELIGIBLE, nada escrito (el CAS no distingue «cambió» de «hay evidencia»: el cajero conserva el cobro y consulta; la siguiente declaración sí dice POSITIVE_EVIDENCE_EXISTS)', async () => {
    const { row, attemptId } = await filaConIntento()
    // El veto de la declaración es la consulta sobre "ProviderEventLog": el evento se persiste por fuera JUSTO después de ella.
    const spy = interceptarSiguienteTx('"ProviderEventLog"', async () => {
      await prisma.providerEventLog.create({ data: eventoAprobado(attemptId, 'tx-entre-veto-y-cas') })
    })
    try {
      await expect(declarar(attemptId, owner.id, declaracion(row.requestId))).rejects.toMatchObject({
        code: 'ATTEMPT_NOT_ELIGIBLE',
        statusCode: 409,
      })
    } finally {
      spy.mockRestore()
    }
    const intacta = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(intacta).toMatchObject({ status: 'TIMED_OUT', failureCode: null, paymentId: null })
    expect((await prisma.terminalPaymentAttemptLink.findUniqueOrThrow({ where: { attemptId } })).operatorResolution).toBeNull()
    expect(
      await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED', entityId: row.id } }),
    ).toBe(0)
    await expect(declarar(attemptId, owner.id, declaracion(row.requestId))).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
  })

  // ── Codex r1 · P1-D: el `success` inacreditable degradado conserva su afirmación positiva y el cajero NO puede declarar encima ──
  it('(P1-D) un `success` con paymentId inexistente deja la fila UNKNOWN con claimedSuccess.paymentId (sin terminalResult), y la declaración ⇒ 409 POSITIVE_EVIDENCE_EXISTS con la fila intacta', async () => {
    const row = await auditRequest({ status: 'SENT' })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: row.requestId, status: 'success', paymentId: 'pay-inexistente', authorizationCode: 'A1', reference: 'ref-1' } as any,
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'UNKNOWN', paymentId: null })
    expect((fila.resultJson as any).terminalResult).toBeUndefined()
    expect((fila.resultJson as any).claimedSuccess).toEqual({ paymentId: 'pay-inexistente', authorizationCode: 'A1', reference: 'ref-1' })
    await expect(declarar(attemptId, owner.id, declaracion(row.requestId))).rejects.toMatchObject({
      code: 'POSITIVE_EVIDENCE_EXISTS',
      statusCode: 409,
    })
    const despues = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(despues).toMatchObject({ status: 'UNKNOWN', failureCode: null, paymentId: null })
    expect(despues.updatedAt.getTime()).toBe(fila.updatedAt.getTime())
    expect((await prisma.terminalPaymentAttemptLink.findUniqueOrThrow({ where: { attemptId } })).operatorResolution).toBeNull()
  })

  // ── Codex r1 · P1-E: la declaración también ve la identidad LEGACY del Payment (processorData.terminalPaymentRequestId) ──
  it('(P1-E) un Payment COMPLETED etiquetado SÓLO en processorData, con otra llave y sin puntero ⇒ 409 POSITIVE_EVIDENCE_EXISTS', async () => {
    const { row, attemptId } = await filaConIntento()
    await auditPayment({
      idempotencyKey: `otra-llave-${randomUUID().slice(0, 8)}`,
      processorData: { terminalPaymentRequestId: row.requestId },
    })
    await expect(declarar(attemptId, owner.id, declaracion(row.requestId))).rejects.toMatchObject({
      code: 'POSITIVE_EVIDENCE_EXISTS',
      statusCode: 409,
    })
    const intacta = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(intacta).toMatchObject({ status: 'TIMED_OUT', failureCode: null, paymentId: null })
    expect((await prisma.terminalPaymentAttemptLink.findUniqueOrThrow({ where: { attemptId } })).operatorResolution).toBeNull()
  })
  // ── Codex r2 · P1-D: la sonda pasa TODAS las señales positivas y la degradación FUSIONA claimedSuccess (nunca encoge) ──
  it('(P1-D · r2) un `success` con transactionId y paymentId inexistente ⇒ UNKNOWN con claimedSuccess.transactionId; la SONDA repite el success SIN paymentId/transactionId y el transactionId sigue; la declaración ⇒ 409', async () => {
    const row = await auditRequest({ status: 'SENT' })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: row.requestId, status: 'success', paymentId: 'pay-inexistente', transactionId: 'tx-afirmada' } as any,
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
    const primera = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(primera).toMatchObject({ status: 'UNKNOWN', paymentId: null })
    expect((primera.resultJson as any).claimedSuccess).toEqual({ paymentId: 'pay-inexistente', transactionId: 'tx-afirmada' })
    // La bandeja de la terminal contesta la sonda con el mismo `success` pero sin paymentId ni transactionId.
    expect(
      await (terminalPaymentService as any).handleProbeResultFromSocket(
        {
          requestId: row.requestId,
          disposition: 'RESOLVED',
          finalResult: { requestId: row.requestId, status: 'success', readMode: 'CONTACTLESS' },
        },
        { socketId: 'fixture-socket', terminalId: fixture, venueId },
      ),
    ).toBe(true)
    const segunda = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(segunda).toMatchObject({ status: 'UNKNOWN', paymentId: null })
    expect((segunda.resultJson as any).terminalResult).toBeUndefined()
    expect((segunda.resultJson as any).claimedSuccess).toEqual({
      paymentId: 'pay-inexistente',
      transactionId: 'tx-afirmada',
      readMode: 'CONTACTLESS',
    })
    await expect(declarar(attemptId, owner.id, declaracion(row.requestId))).rejects.toMatchObject({
      code: 'POSITIVE_EVIDENCE_EXISTS',
      statusCode: 409,
    })
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('UNKNOWN')
  })
})
