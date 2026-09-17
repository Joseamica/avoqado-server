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
import { candadoDeIntento } from '@/services/tpv/candadoDeIntento'
import { utcTs } from '@/utils/sqlDates'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'

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
void nuevaOrden
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
    const unknown = await auditRequest({ status: 'UNKNOWN', updatedAt: vencida })
    const soltada = await auditRequest({
      status: 'TIMED_OUT',
      failureCode: 'AUTO_RELEASED',
      updatedAt: vencida,
      terminalId: `${fixture}-b`,
    })
    const resumen = await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())
    expect(resumen).toEqual({ released: 0, reconciled: 0, held: 0 })
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
    expect(await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())).toEqual({ released: 0, reconciled: 0, held: 0 })
    expect(await terminalPaymentService.releaseUnprovenNegative(historica.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: historica.id } })).status).toBe('TIMED_OUT')
  })

  it('el barrido libera sólo las vencidas y es idempotente', async () => {
    const vencida = new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000)
    await auditRequest({ ...negativoSinEvidencia(), updatedAt: vencida })
    await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(), terminalId: `${fixture}-c` })
    expect(await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())).toEqual({ released: 1, reconciled: 0, held: 0 })
    expect(await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())).toEqual({ released: 0, reconciled: 0, held: 0 })
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
    const reciente = await auditRequest({
      ...negativoSinEvidencia(),
      failureCode: 'BANK_APPROVED_AWAITING_PAYMENT',
      updatedAt: new Date(Date.now() - 5 * 60_000),
      terminalId: `${fixture}-d`,
    })
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())
    const soltada = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: retenida.id } })
    expect(soltada).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', paymentId: null })
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(false)
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
    const intacta = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: reciente.id } })
    expect(intacta.failureCode).toBe('BANK_APPROVED_AWAITING_PAYMENT')
    expect(await terminalPaymentService.isTerminalBusy(`${fixture}-d`, venueId)).toBe(true)
  })
})
