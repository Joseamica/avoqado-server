/**
 * S9 del checkpoint 1 (webhook como primer confirmador): las garantías de concurrencia viven en la BASE,
 * no sólo en el servicio. Estas pruebas no tocan ningún servicio: escriben filas y esperan que Postgres diga que no.
 *
 *  · `TerminalPaymentAttemptLink.attemptId` es único GLOBAL: un intento pertenece a UNA solicitud para siempre
 *    (dueño inmutable, S1). Repetir el mismo vínculo también choca aquí; la idempotencia «misma solicitud ⇒ ok,
 *    otra solicitud ⇒ 🚨» la resuelve S1 leyendo al dueño existente.
 *  · FK a `TerminalPaymentRequest.requestId` con cascade: sin solicitud no hay vínculo, y borrar la solicitud se
 *    lleva sus vínculos.
 *  · UN ganador financiero por solicitud, garantizado por índice único PARCIAL sobre
 *    `Payment.terminalPaymentRequestId` (sólo `COMPLETED` y no `REFUND`): la segunda captura cabe como PENDING,
 *    un reembolso cabe, y las filas sin solicitud no se restringen entre sí.
 *  · Columnas aditivas que consumen S4/S7/S8: `TerminalPaymentRequest.closedVia` y el lease de `ProviderEventLog`.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'

const fixture = `s9-${randomUUID()}`
const venueId = fixture
let orderId: string

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
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

afterEach(async () => {
  await prisma.providerEventLog.deleteMany({ where: { eventId: { startsWith: `s9-${fixture}` } } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: fixture } })
})

// Una terminal distinta por solicitud: la base ya impone UNA solicitud en vuelo por terminal
// (índice único parcial sobre `terminalId`), y aquí se prueban vínculos, no la ranura.
const solicitud = () =>
  prisma.terminalPaymentRequest.create({
    data: {
      requestId: randomUUID(),
      venueId,
      terminalId: `n86s9-${randomUUID().slice(0, 8)}`,
      amountCents: 10000,
      status: 'SENT',
      expiresAt: new Date(Date.now() + 60_000),
    },
  })

const vinculo = (requestId: string, attemptId: string) =>
  prisma.terminalPaymentAttemptLink.create({ data: { requestId, attemptId, venueId, terminalId: 'n86s9' } })

const pago = (overrides: Record<string, unknown> = {}) =>
  prisma.payment.create({
    data: {
      venueId,
      orderId,
      amount: new Prisma.Decimal(100),
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      feePercentage: new Prisma.Decimal(0),
      feeAmount: new Prisma.Decimal(0),
      netAmount: new Prisma.Decimal(100),
      ...overrides,
    } as Prisma.PaymentUncheckedCreateInput,
  })

const P2002 = expect.objectContaining({ code: 'P2002' })
const P2003 = expect.objectContaining({ code: 'P2003' })

describe('S9 · el vínculo intento → solicitud', () => {
  it('un attemptId pertenece a UNA solicitud para siempre: el mismo intento no puede colgar de otra solicitud', async () => {
    const [r1, r2] = [await solicitud(), await solicitud()]
    const attemptId = randomUUID()
    await vinculo(r1.requestId, attemptId)

    await expect(vinculo(r2.requestId, attemptId)).rejects.toEqual(P2002)
    expect(await prisma.terminalPaymentAttemptLink.count({ where: { attemptId } })).toBe(1)
  })

  it('repetir el MISMO vínculo también choca en la base (S1 lo vuelve idempotente leyendo al dueño)', async () => {
    const r1 = await solicitud()
    const attemptId = randomUUID()
    await vinculo(r1.requestId, attemptId)

    await expect(vinculo(r1.requestId, attemptId)).rejects.toEqual(P2002)
  })

  it('varios intentos por solicitud sí caben (el reintento tras un rechazo abre uno nuevo)', async () => {
    const r1 = await solicitud()
    await vinculo(r1.requestId, randomUUID())
    await vinculo(r1.requestId, randomUUID())

    expect(await prisma.terminalPaymentAttemptLink.count({ where: { requestId: r1.requestId } })).toBe(2)
  })

  it('sin solicitud no hay vínculo (FK), y borrar la solicitud borra sus vínculos (cascade)', async () => {
    await expect(vinculo(randomUUID(), randomUUID())).rejects.toEqual(P2003)

    const r1 = await solicitud()
    await vinculo(r1.requestId, randomUUID())
    await prisma.terminalPaymentRequest.delete({ where: { id: r1.id } })
    expect(await prisma.terminalPaymentAttemptLink.count({ where: { requestId: r1.requestId } })).toBe(0)
  })
})

describe('S9 · UN ganador financiero por solicitud, en la base', () => {
  it('dos Payments COMPLETED con la misma solicitud: el segundo NO entra', async () => {
    const r1 = await solicitud()
    await pago({ terminalPaymentRequestId: r1.requestId })

    await expect(pago({ terminalPaymentRequestId: r1.requestId })).rejects.toEqual(P2002)
    expect(await prisma.payment.count({ where: { terminalPaymentRequestId: r1.requestId } })).toBe(1)
  })

  it('la segunda captura cabe como PENDING (evidencia para conciliar) y un REFUND también cabe', async () => {
    const r1 = await solicitud()
    const ganador = await pago({ terminalPaymentRequestId: r1.requestId })
    await pago({ terminalPaymentRequestId: r1.requestId, status: 'PENDING' })
    await pago({
      terminalPaymentRequestId: r1.requestId,
      type: 'REFUND',
      amount: new Prisma.Decimal(-100),
      netAmount: new Prisma.Decimal(-100),
    })

    const filas = await prisma.payment.findMany({ where: { terminalPaymentRequestId: r1.requestId } })
    expect(filas).toHaveLength(3)
    expect(filas.filter(p => p.status === 'COMPLETED' && p.type !== 'REFUND').map(p => p.id)).toEqual([ganador.id])
  })

  it('un Payment con `type` NULL también cuenta como ganador: el segundo COMPLETED no entra (Codex P2, IS DISTINCT FROM)', async () => {
    const r1 = await solicitud()
    await pago({ terminalPaymentRequestId: r1.requestId, type: null })

    await expect(pago({ terminalPaymentRequestId: r1.requestId, type: null })).rejects.toEqual(P2002)
    await expect(pago({ terminalPaymentRequestId: r1.requestId })).rejects.toEqual(P2002)
  })

  it('los Payments sin solicitud (cobros locales, Blumon, efectivo) no se restringen entre sí', async () => {
    await pago()
    await pago()
    expect(await prisma.payment.count({ where: { venueId, terminalPaymentRequestId: null } })).toBe(2)
  })
})

describe('S9 · columnas aditivas que consumen los pasos siguientes', () => {
  it('TerminalPaymentRequest.closedVia nace nulo y admite terminal/webhook', async () => {
    const r1 = await solicitud()
    expect(r1.closedVia).toBeNull()
    const cerrada = await prisma.terminalPaymentRequest.update({ where: { id: r1.id }, data: { closedVia: 'webhook' } })
    expect(cerrada.closedVia).toBe('webhook')
  })

  it('ProviderEventLog lleva attemptId y el lease del worker (attempts, nextAttemptAt, leaseUntil, claimToken, lastError)', async () => {
    const eventId = `s9-${fixture}-${randomUUID()}`
    const creado = await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        eventId,
        type: 'send_transaction',
        payload: { ok: true },
        status: 'PENDING',
        attemptId: randomUUID(),
      },
    })
    expect(creado).toMatchObject({ attempts: 0, nextAttemptAt: null, leaseUntil: null, claimToken: null, lastError: null })
    const reclamado = await prisma.providerEventLog.update({
      where: { id: creado.id },
      data: {
        attempts: { increment: 1 },
        leaseUntil: new Date(Date.now() + 60_000),
        claimToken: 'w1',
        nextAttemptAt: new Date(),
        lastError: null,
      },
    })
    expect(reclamado.attempts).toBe(1)
    expect(reclamado.claimToken).toBe('w1')
  })
})
