/**
 * Cobro simple · S1 — las rutas VIEJAS de declaración (siguen vivas hasta S3) contra Postgres REAL (Codex S1 r2, R2-8).
 *
 * Al quitar las suites de la ventana de 30 s y de la declaración se perdieron tres pruebas de dinero sobre caminos que S1 todavía
 * sirve. Se portan de `origin/develop` adaptadas al régimen de S1 (la fila en duda es `UNKNOWN`, con o sin su reloj de 10 s):
 *  (i)   `terminalPaymentWindow.integration.test.ts` «(P1-C · 4)»: un aviso APROBADO que entra entre el veto y el CAS de la
 *        declaración por intento (`no-instrument-resolution`) ⇒ la declaración pierde y la solicitud queda intacta.
 *  (ii)  `unchargedReconciliation.integration.test.ts` «Codex r4» y «P1 Codex (20-sep)»: repetir una declaración ya contestada
 *        «liberada» con el dinero apareciendo después (Payment PENDING de segunda captura, o el aprobado del mismo intento en OTRO
 *        venue) ⇒ la segunda respuesta ya no dice `released: true`.
 *  (iii) el mismo archivo, «P1 E3: carrera lápida contra admisión»: la declaración de una llave del POS todavía sin fila contra el
 *        POST original ⇒ sólo una escritura gana; y si gana la declaración (la lápida), esa llave nunca emite un cobro.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { reconcileUncharged, UnchargedReconciliationError } from '@/services/tpv/uncharged-reconciliation.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

jest.setTimeout(120_000)

const fixture = `rviejas-${randomUUID().slice(0, 8)}`
const venueId = fixture
const terminalId = fixture
const serialDelFixture = `AVQD-${fixture.toUpperCase()}`
let staffDuenoId: string
let staffCajeroId: string
let directEmit: jest.Mock

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
  await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
  await prisma.venue.create({
    data: { id: venueId, organizationId: fixture, name: fixture, slug: fixture, timezone: 'America/Mexico_City' },
  })
  const persona = (rol: 'OWNER' | 'CASHIER', nombre: string) =>
    prisma.staff.create({
      data: {
        email: `${fixture}-${nombre}@example.test`,
        firstName: nombre,
        lastName: 'Fixture',
        organizations: { create: { organizationId: fixture, role: rol === 'OWNER' ? 'OWNER' : 'MEMBER', isPrimary: true, isActive: true } },
        venues: { create: { venueId, role: rol, active: true } },
      },
      select: { id: true },
    })
  staffDuenoId = (await persona('OWNER', 'duena')).id
  staffCajeroId = (await persona('CASHIER', 'cajera')).id
})

beforeEach(() => {
  jest.clearAllMocks()
  directEmit = jest.fn()
  const socket = { emit: directEmit, timeout: () => ({ emit: directEmit }) }
  ;(socketManager.getServer as jest.Mock).mockReturnValue({
    sockets: { sockets: new Map([['fixture-socket', socket]]) },
    to: () => ({ emit: jest.fn() }),
  })
  ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((id: string) => ({
    terminalId: id,
    venueId,
    socketId: 'fixture-socket',
    identityVerified: true,
    terminalPaymentAckVersion: 1,
  }))
})

afterEach(async () => {
  const vinculos = await prisma.terminalPaymentAttemptLink.findMany({ where: { venueId }, select: { attemptId: true } })
  if (vinculos.length > 0) await prisma.providerEventLog.deleteMany({ where: { attemptId: { in: vinculos.map(v => v.attemptId) } } })
  await prisma.providerEventLog.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } })
  const svc = terminalPaymentService as any
  for (const mapa of [svc.cierresSinRespuesta] as Map<string, NodeJS.Timeout>[]) {
    for (const t of mapa.values()) clearTimeout(t)
    mapa.clear()
  }
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { venueId } })
  for (const id of [staffDuenoId, staffCajeroId]) {
    if (!id) continue
    await prisma.staffVenue.deleteMany({ where: { staffId: id } })
    await prisma.staffOrganization.deleteMany({ where: { staffId: id } })
    await prisma.staff.deleteMany({ where: { id } })
  }
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: fixture } })
})

/** Una fila en duda de S1 con su vínculo: UNKNOWN (con o sin su reloj de 10 s), la terminal acusó y volvió, sin pago. */
async function filaEnDuda(over: Record<string, unknown> = {}) {
  const requestId = randomUUID()
  const ahora = new Date()
  const row = await prisma.terminalPaymentRequest.create({
    data: {
      requestId,
      venueId,
      terminalId,
      status: 'UNKNOWN',
      amountCents: 6500,
      tipCents: 975,
      terminalReturnedAt: ahora,
      acknowledgedAt: ahora,
      expiresAt: new Date(ahora.getTime() - 30 * 60_000),
      ...over,
    } as Prisma.TerminalPaymentRequestUncheckedCreateInput,
  })
  const attemptId = `att-${requestId}`
  await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId, venueId, terminalId } })
  return { row, requestId, attemptId }
}

const eventoAprobado = (attemptId: string, transactionId: string) => ({
  provider: 'PAYMENT_PROCESSOR' as const,
  venueId,
  attemptId,
  type: 'send_transaction',
  status: 'PENDING' as const,
  payload: { event: 'send_transaction', payload: { status: 'approved', amount: '10000', integratorReference: attemptId, transactionId } },
})

/**
 * Intercepta la SIGUIENTE `prisma.$transaction`: cada `tx.$queryRaw` cuyo SQL contenga `marcador` corre de verdad y, ANTES de
 * devolver su resultado, ejecuta `entre` (por fuera, autocommit): el hueco exacto «entre el veto y el CAS». Copia del arnés de
 * develop (`terminalPaymentWindow.integration.test.ts`).
 */
const interceptarSiguienteTx = (marcador: string, entre: () => Promise<void>) => {
  const original = prisma.$transaction.bind(prisma)
  return jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: any, opts: any) =>
    original(async (tx: any) => {
      const envuelto = new Proxy(tx, {
        get(target, prop) {
          const v = (target as any)[prop]
          if (prop !== '$queryRaw') return typeof v === 'function' ? v.bind(target) : v
          return async (strings: TemplateStringsArray | { sql?: string }, ...values: unknown[]) => {
            const r = await target.$queryRaw(strings as TemplateStringsArray, ...values)
            const sql = [
              Array.isArray(strings) ? strings.join('?') : String((strings as { sql?: string }).sql ?? ''),
              ...values.map(v => (v as { sql?: string } | null)?.sql ?? ''),
            ].join(' ')
            if (sql.includes(marcador)) await entre()
            return r
          }
        },
      })
      return fn(envuelto)
    }, opts)) as any)
}

const declaracion = (requestId: string, extra: Record<string, unknown> = {}) => ({
  requestId,
  resolutionId: randomUUID(),
  statementVersion: 1,
  ...extra,
})

describe('(i) la declaración por intento pierde frente a un aprobado que entra entre su veto y su CAS', () => {
  const declarar = async (attemptId: string, body: Record<string, unknown>) => {
    const { resolveNoInstrument } = await import('@/services/tpv/no-instrument-resolution.service')
    return resolveNoInstrument({ venueId, terminalSerial: serialDelFixture, attemptId, actorStaffId: staffDuenoId }, body)
  }

  it('en sus 10 s de «sin respuesta»: 409 ATTEMPT_NOT_ELIGIBLE, nada escrito; la siguiente declaración dice POSITIVE_EVIDENCE_EXISTS', async () => {
    const { row, requestId, attemptId } = await filaEnDuda({
      noResponseAt: new Date(),
      resultJson: {
        requestId: 'x',
        status: 'timeout',
        noChargeCause: 'NO_RESPONSE',
        terminalResult: { status: 'failed', outcomeEvidence: null },
      },
    })
    const spy = interceptarSiguienteTx('"ProviderEventLog"', async () => {
      await prisma.providerEventLog.create({ data: eventoAprobado(attemptId, `tx-${randomUUID().slice(0, 8)}`) })
    })
    try {
      await expect(declarar(attemptId, declaracion(requestId, { statement: 'NO_INSTRUMENT_PRESENTED' }))).rejects.toMatchObject({
        code: 'ATTEMPT_NOT_ELIGIBLE',
        statusCode: 409,
      })
    } finally {
      spy.mockRestore()
    }
    const intacta = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(intacta).toMatchObject({ status: 'UNKNOWN', failureCode: null, paymentId: null })
    expect((await prisma.terminalPaymentAttemptLink.findUniqueOrThrow({ where: { attemptId } })).operatorResolution).toBeNull()
    expect(
      await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED', entityId: row.id } }),
    ).toBe(0)
    await expect(declarar(attemptId, declaracion(requestId, { statement: 'NO_INSTRUMENT_PRESENTED' }))).rejects.toMatchObject({
      code: 'POSITIVE_EVIDENCE_EXISTS',
    })
  })

  it('CONTROL: sin el aprobado en medio, la misma declaración sí cierra la fila (la prueba de arriba no pasa por no ser elegible)', async () => {
    const { row, requestId, attemptId } = await filaEnDuda({
      noResponseAt: new Date(),
      resultJson: {
        requestId: 'x',
        status: 'timeout',
        noChargeCause: 'NO_RESPONSE',
        terminalResult: { status: 'failed', outcomeEvidence: null },
      },
    })
    await declarar(attemptId, declaracion(requestId, { statement: 'NO_INSTRUMENT_PRESENTED' }))
    expect(await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'FAILED' })
  })
})

describe('(ii) el replay de una declaración ya «liberada» no lo repite si después apareció el dinero', () => {
  const resolucionFija = randomUUID()
  const declarar = (requestId: string) =>
    reconcileUncharged(
      { venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' },
      { requestId, resolutionId: resolucionFija, statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
    )
  const replay = (requestId: string) =>
    terminalPaymentService.releaseUnknownRequest({
      requestId,
      venueId,
      actor: { staffId: staffCajeroId, source: 'MOBILE' },
      reason: 'replay',
      declaration: { requestId, resolutionId: resolucionFija, statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
    })

  it('CONTROL: sin dinero después, el replay sí repite `released: true`', async () => {
    const { requestId } = await filaEnDuda()
    await declarar(requestId)
    expect((await replay(requestId)).released).toBe(true)
  })

  it('con un Payment PENDING de segunda captura ligado después ⇒ la segunda respuesta ya no dice `released: true`', async () => {
    const { requestId } = await filaEnDuda()
    await declarar(requestId)
    const orden = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `${fixture}-${randomUUID().slice(0, 6)}`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
        subtotal: 65,
        taxAmount: 0,
        total: 65,
        createdById: staffCajeroId,
      },
    })
    await prisma.payment.create({
      data: {
        venueId,
        orderId: orden.id,
        amount: 65,
        tipAmount: 0,
        method: 'CREDIT_CARD',
        status: 'PENDING',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 65,
        terminalPaymentRequestId: requestId,
        processorData: { reconciliation: { kind: 'POSSIBLE_SECOND_CAPTURE' } },
      },
    })
    expect(await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })).toMatchObject({
      status: 'FAILED',
      failureCode: 'OPERATOR_RECONCILED_NO_CHARGE',
      paymentId: null,
    })
    expect((await replay(requestId)).released).toBe(false)
  })

  it('con el aprobado del MISMO intento recibido por OTRO venue ⇒ la segunda respuesta ya no dice `released: true`', async () => {
    const { requestId, attemptId } = await filaEnDuda()
    await declarar(requestId)
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        venueId: null,
        type: 'send_transaction',
        attemptId,
        errorReason: 'LINK_VENUE_MISMATCH',
        payload: { payload: { status: 'APROBADO' } },
      },
    })
    expect((await replay(requestId)).released).toBe(false)
  })
})

describe('(iii) la declaración de una llave del POS todavía sin fila contra el POST original', () => {
  const cuerpo = (requestId: string) => ({
    requestId,
    resolutionId: randomUUID(),
    statement: 'UNCHARGED_VERIFIED' as const,
    statementVersion: 1,
  })
  const comoCajera = (requestId: string) => ({ venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' as const })

  it('si la admisión confirma primero, la lápida no entra y la declaración relee la fila viva: una sola fila, sin lápida', async () => {
    const requestId = randomUUID()
    const terminalDeLaCarrera = `${terminalId}-r`
    let soltar!: () => void
    const retenida = new Promise<void>(r => (soltar = r))
    let avisar!: (pid: number) => void
    const insertada = new Promise<number>(r => (avisar = r))
    const admision = prisma.$transaction(
      async tx => {
        await tx.terminalPaymentRequest.create({
          data: {
            requestId,
            venueId,
            terminalId: terminalDeLaCarrera,
            status: 'PENDING',
            amountCents: 6500,
            tipCents: 975,
            expiresAt: new Date(Date.now() + 5 * 60_000),
            deliveryProvenance: { deliveries: [] },
          },
        })
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        avisar(Number(pid))
        await retenida
      },
      { timeout: 30_000 },
    )
    const pidDeLaAdmision = await insertada
    const declaracionEnCarrera = reconcileUncharged(comoCajera(requestId), cuerpo(requestId)).then(
      () => 'DECLARADA',
      (e: UnchargedReconciliationError) => e.code,
    )
    const espera = await esperarBloqueado(prisma, {
      bloqueadoPor: [pidDeLaAdmision],
      consulta: /INSERT INTO "public"\."TerminalPaymentRequest"/,
    })
    soltar()
    expect(espera).not.toBeNull()
    await admision
    expect(await declaracionEnCarrera).toBe('TERMINAL_NEVER_ANSWERED')
    const filas = await prisma.terminalPaymentRequest.findMany({ where: { requestId } })
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ status: 'PENDING', amountCents: 6500, operatorReconciliation: null })
  })

  it('si gana la declaración (lápida), el POST con esa llave nunca emite un cobro a la terminal', async () => {
    const requestId = randomUUID()
    await reconcileUncharged(comoCajera(requestId), cuerpo(requestId))
    const lapida = await prisma.terminalPaymentRequest.findMany({ where: { requestId } })
    expect(lapida).toHaveLength(1)
    expect(lapida[0]).toMatchObject({ status: 'FAILED' })
    await terminalPaymentService
      .sendPaymentToTerminal({
        terminalId: serialDelFixture,
        venueId,
        amountCents: 6500,
        tipCents: 975,
        requestedBy: staffCajeroId,
        requestId,
      })
      .catch(() => undefined)
    expect(directEmit.mock.calls.filter(([evento]) => evento === 'terminal:payment_request')).toHaveLength(0)
    expect(await prisma.terminalPaymentRequest.findMany({ where: { requestId } })).toHaveLength(1)
    // CONTROL: con una llave nueva el mismo POST sí emite (la prueba no pasa porque el arnés no pueda emitir).
    directEmit.mockImplementation((_e: string, p: { requestId?: string }, ack?: (err: Error | null, r?: unknown) => void) =>
      ack?.(null, { accepted: true, requestId: p?.requestId }),
    )
    const otra = randomUUID()
    void terminalPaymentService
      .sendPaymentToTerminal({
        terminalId: serialDelFixture,
        venueId,
        amountCents: 6500,
        tipCents: 975,
        requestedBy: staffCajeroId,
        requestId: otra,
      })
      .catch(() => undefined)
    for (let i = 0; i < 100 && !directEmit.mock.calls.some(([e]) => e === 'terminal:payment_request'); i++)
      await new Promise(r => setTimeout(r, 20))
    expect(directEmit.mock.calls.filter(([evento]) => evento === 'terminal:payment_request')).toHaveLength(1)
    const pendiente = (terminalPaymentService as any).pendingPayments.get(otra)
    if (pendiente) {
      clearTimeout(pendiente.timeout)
      ;(terminalPaymentService as any).pendingPayments.delete(otra)
      pendiente.resolve({ requestId: otra, status: 'timeout' })
    }
  })
})
