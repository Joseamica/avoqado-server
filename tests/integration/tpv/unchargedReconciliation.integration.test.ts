/**
 * Integration: la declaración del cajero contra POSTGRES REAL (plan 18-sep, Task 5).
 *
 * 🔴 POR QUÉ EL UNIT NO BASTA, y es la mitad del incidente: que la terminal quede LIBRE no lo decide ninguna
 * comparación en JavaScript — lo decide el ÍNDICE ÚNICO PARCIAL de la base
 * (`UNIQUE(terminalId) WHERE status IN ('PENDING','SENT','CANCEL_REQUESTED','UNKNOWN')`). Con `prismaMock` se
 * puede afirmar que el UPDATE se llamó, pero no que la ranura se soltó: eso sólo lo prueba intentar crear otra
 * solicitud en la MISMA terminal y ver que Postgres la acepta.
 *
 * Lo mismo con el veto: `sinEvidenciaPositivaSql` y `hayEvidenciaDeConciliacionSql` son SQL que el mock nunca
 * evalúa. Aquí sí corren.
 *
 * El escenario es el de Testarudo del 18-sep: $65.00 + $9.75 de propina, fila UNKNOWN, terminal de vuelta.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { reconcileUncharged, UnchargedReconciliationError } from '@/services/tpv/uncharged-reconciliation.service'
import { randomUUID } from 'crypto'

jest.setTimeout(120000)

describe('la declaración del cajero libera la venta Y la ranura, contra Postgres real', () => {
  let venueId: string
  let staffCajeroId: string
  let staffMeseroId: string
  const sufijo = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const terminalId = `t-uncharged-${sufijo}`.toLowerCase().slice(0, 40)

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Uncharged Org ${sufijo}`, email: `unch-${sufijo}@test.com`, phone: '5550000000' },
    })
    const venue = await prisma.venue.create({
      data: {
        name: `Uncharged Venue ${sufijo}`,
        slug: `uncharged-${sufijo}`,
        organizationId: org.id,
        address: 'Test',
        city: 'Test',
        state: 'Test',
        country: 'MX',
        zipCode: '12345',
        timezone: 'America/Mexico_City',
      },
    })
    venueId = venue.id

    const cajero = await prisma.staff.create({
      data: {
        email: `unch-cajero-${sufijo}@test.com`,
        firstName: 'Viridiana',
        lastName: 'Cajera',
        phone: '5551110000',
        organizations: { create: { organizationId: org.id, role: 'MEMBER', isPrimary: true, isActive: true } },
        venues: { create: { venueId: venue.id, role: 'CASHIER', active: true } },
      },
    })
    staffCajeroId = cajero.id

    const mesero = await prisma.staff.create({
      data: {
        email: `unch-mesero-${sufijo}@test.com`,
        firstName: 'Mesero',
        lastName: 'Sin Permiso',
        phone: '5551110001',
        organizations: { create: { organizationId: org.id, role: 'MEMBER', isPrimary: true, isActive: true } },
        venues: { create: { venueId: venue.id, role: 'WAITER', active: true } },
      },
    })
    staffMeseroId = mesero.id
  })

  /** Una fila como la del incidente: UNKNOWN, la terminal ya volvió, sin pago. */
  async function sembrarFilaAtorada(over: Record<string, unknown> = {}) {
    const requestId = randomUUID()
    const ahora = new Date()
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId,
        venueId,
        terminalId,
        status: 'UNKNOWN',
        amountCents: 6500,
        tipCents: 975,
        terminalReturnedAt: ahora,
        expiresAt: new Date(ahora.getTime() - 30 * 60 * 1000),
        ...over,
      },
    })
    return requestId
  }

  afterEach(async () => {
    // 🔴 También el rastro: sin esto los asientos de una prueba se cuentan en la siguiente y el conteo
    // acusa en falso al candado de concurrencia (pasó al escribir esta suite).
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } })
  })

  it('🔴 la declaración escribe el desenlace y LIBERA LA RANURA: otra solicitud en la MISMA terminal entra', async () => {
    const requestId = await sembrarFilaAtorada()

    // Antes: la ranura está tomada — el índice único parcial rechaza otra solicitud viva en esa terminal.
    await expect(
      prisma.terminalPaymentRequest.create({
        data: {
          requestId: randomUUID(),
          venueId,
          terminalId,
          status: 'PENDING',
          amountCents: 100,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        },
      }),
    ).rejects.toThrow()

    const r = await reconcileUncharged(
      { venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' },
      { requestId, resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
    )
    expect(r.kind).toBe('UNCHARGED_VERIFIED')

    const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
    expect(fila).toMatchObject({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE', cancelDisposition: null })
    expect(fila?.operatorReconciliation).toMatchObject({ kind: 'UNCHARGED_VERIFIED', staffId: staffCajeroId })

    // 🔴 DESPUÉS: la ranura quedó libre de verdad. Esto es lo que el cajero no podía conseguir el 18-sep.
    const nueva = await prisma.terminalPaymentRequest.create({
      data: {
        requestId: randomUUID(),
        venueId,
        terminalId,
        status: 'PENDING',
        amountCents: 100,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    })
    expect(nueva.id).toBeTruthy()

    const asientos = await prisma.activityLog.findMany({
      where: { action: 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED', venueId, entityId: fila!.id },
    })
    expect(asientos).toHaveLength(1)
    expect(asientos[0].staffId).toBe(staffCajeroId)
  })

  it('🔴 con un Payment ligado NO declara: el SQL del veto corre de verdad', async () => {
    const requestId = await sembrarFilaAtorada()
    const orden = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `UNCH-${sufijo}-${Math.random().toString(36).slice(2, 6)}`,
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
        tipAmount: 9.75,
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 65,
        terminalPaymentRequestId: requestId,
      },
    })

    await expect(
      reconcileUncharged(
        { venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' },
        { requestId, resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
      ),
    ).rejects.toThrow(UnchargedReconciliationError)

    const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
    expect(fila?.failureCode).not.toBe('OPERATOR_RECONCILED_NO_CHARGE')
    expect(fila?.operatorReconciliation).toBeNull()
  })

  it('🔴 un WAITER no puede declarar, aunque la fila sea elegible', async () => {
    const requestId = await sembrarFilaAtorada()
    await expect(
      reconcileUncharged(
        { venueId, requestId, actorStaffId: staffMeseroId, source: 'MOBILE' },
        { requestId, resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
      ),
    ).rejects.toMatchObject({ statusCode: 403 })

    const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
    expect(fila?.status).toBe('UNKNOWN')
  })

  it('🔴 dos declaraciones CONCURRENTES: una gana, la otra no corrompe nada', async () => {
    const requestId = await sembrarFilaAtorada()
    const unaDeclaracion = () =>
      reconcileUncharged(
        { venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' },
        { requestId, resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
      )

    const resultados = await Promise.allSettled([unaDeclaracion(), unaDeclaracion()])
    const cumplidas = resultados.filter(r => r.status === 'fulfilled')
    expect(cumplidas.length).toBeGreaterThanOrEqual(1)

    const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
    expect(fila?.status).toBe('FAILED')
    // Una sola declaración guardada y UN solo asiento PARA ESTA SOLICITUD: el candado serializó de verdad.
    const asientos = await prisma.activityLog.findMany({
      where: { action: 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED', venueId, entityId: fila!.id },
    })
    expect(asientos).toHaveLength(1)
    // Y la declaración guardada es UNA: la segunda no la pisó con otro resolutionId.
    expect((fila?.operatorReconciliation as any)?.kind).toBe('UNCHARGED_VERIFIED')
  })

  it('🔴 una fila TIMED_OUT legacy SIN la marca de retorno se declara si la terminal está viva', async () => {
    const requestId = await sembrarFilaAtorada({ status: 'TIMED_OUT', terminalReturnedAt: null })
    await prisma.terminal.create({
      data: {
        venueId,
        name: `Term ${sufijo}`,
        serialNumber: terminalId,
        type: 'TPV_ANDROID',
        status: 'ACTIVE',
        lastHeartbeat: new Date(),
      },
    })
    const r = await reconcileUncharged(
      { venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' },
      { requestId, resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
    )
    expect(r.kind).toBe('UNCHARGED_VERIFIED')
    await prisma.terminal.deleteMany({ where: { venueId } })
  })
})
