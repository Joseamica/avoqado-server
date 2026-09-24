/**
 * 🔴 DINERO — el núcleo de reembolso `writeRefundInTx`, contra Postgres REAL.
 *
 * Lo usará el reconciliador de reparto (spec KDS Uber §3.1) para escribir un reembolso
 * PARCIAL compensatorio cuando Uber retira un renglón. Lo que protege cada prueba:
 *   - la comisión se revierte en PESOS (`computeTenderCommission` recibe Decimal en pesos): con
 *     los centavos crudos, $50 al 30 % revertirían $1,500 en vez de $15;
 *   - `INHERIT_ORIGINAL` no toca ningún turno: la venta de reparto nació fuera de turno;
 *   - el replay por `idempotencyKey` gana ANTES de validar saldo (un replay de algo ya devuelto
 *     no puede morir en la validación);
 *   - el contrato no admite componentes negativos.
 */
import prisma from '@/utils/prismaClient'
import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { writeRefundInTx, type WriteRefundInput } from '@/services/shared/writeRefundInTx'
import { abrirTurno, limpiarVenue, sembrarCobro } from './sembrarCobroParaReembolso'

jest.setTimeout(60000)

describe('writeRefundInTx — núcleo del reembolso', () => {
  let venueId: string
  let staffId: string

  beforeAll(async () => {
    const testData = await setupTestData()
    venueId = testData.venue.id
    staffId = testData.staff[0].id
  })

  afterAll(async () => {
    await limpiarVenue(venueId)
    await teardownTestData().catch(() => undefined)
  })

  // `as`: estas pruebas arman a propósito ajustes incompletos (sin generación/reparto) para el camino defensivo.
  const ajusteDeReparto = (originalPaymentId: string, extra: Partial<WriteRefundInput> = {}): WriteRefundInput =>
    ({
      originalPaymentId,
      venueId,
      salesRefundCents: 5000,
      tipRefundCents: 0,
      refundedItems: [],
      reason: 'DELIVERY_ITEM_REMOVED',
      tenderCommission: 'REVERSE_PROPORTIONAL',
      shift: 'INHERIT_ORIGINAL',
      provenance: 'PROVIDER_ADJUSTMENT',
      ...extra,
    }) as WriteRefundInput

  it('REVERSE_PROPORTIONAL revierte la comision con el % del original, en PESOS', async () => {
    const { pago } = await sembrarCobro({ venueId, staffId, saleCents: 20000, commissionPercent: 30 })
    const { refundPaymentId, replay } = await prisma.$transaction(tx =>
      writeRefundInTx(tx, ajusteDeReparto(pago.id, { fiscalByRateCents: { '0.16': 690 }, generation: 1 })),
    )
    expect(replay).toBe(false)
    const fila = await prisma.payment.findUniqueOrThrow({ where: { id: refundPaymentId } })
    expect(fila.tenderCommissionAmount!.toString()).toBe('-15') // 🔴 $15.00, NO $1,500
    expect(fila.tenderCommissionPercent!.toString()).toBe('30')
    expect(fila.amount.toString()).toBe('-50')
    expect(fila.tipAmount.toString()).toBe('0')
    expect(fila.processedById).toBeNull()
    expect(fila.processorData).toMatchObject({
      originalPaymentId: pago.id,
      refundReason: 'DELIVERY_ITEM_REMOVED',
      amountCents: 5000,
      // El ajuste del proveedor SIEMPRE lleva la lista (spec [N-24]), aunque venga vacía: sólo
      // bajó la propina, o el retiro sigue sin acreditar.
      refundedItems: [],
      provenance: 'PROVIDER_ADJUSTMENT',
      providerAdjustment: true,
      generation: 1,
      fiscalByRateCents: { '0.16': 690 },
    })
  })

  it('INHERIT_ORIGINAL NO reclama ni descuenta el turno vivo', async () => {
    const turno = await abrirTurno(venueId, staffId)
    const { pago: sinTurno } = await sembrarCobro({ venueId, staffId, saleCents: 20000, commissionPercent: 30 })
    const { pago: conTurno } = await sembrarCobro({ venueId, staffId, saleCents: 20000, commissionPercent: 30, shiftId: turno.id })

    const a = await prisma.$transaction(tx => writeRefundInTx(tx, ajusteDeReparto(sinTurno.id)))
    const b = await prisma.$transaction(tx => writeRefundInTx(tx, ajusteDeReparto(conTurno.id)))

    expect((await prisma.payment.findUniqueOrThrow({ where: { id: a.refundPaymentId } })).shiftId).toBeNull()
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: b.refundPaymentId } })).shiftId).toBe(turno.id)
    const t = await prisma.shift.findUniqueOrThrow({ where: { id: turno.id } })
    expect(t.totalSales.toString()).toBe('0')
    expect(t.totalTips.toString()).toBe('0')
    expect(
      await prisma.activityLog.count({
        where: { venueId, entityId: { in: [a.refundPaymentId, b.refundPaymentId] }, action: 'PAYMENT_WITHOUT_SHIFT' },
      }),
    ).toBe(0)
  })

  it('el replay por idempotencyKey devuelve el mismo REFUND ANTES de validar cantidades', async () => {
    const { pago, order } = await sembrarCobro({ venueId, staffId, saleCents: 3000, commissionPercent: 30 })
    const input = ajusteDeReparto(pago.id, { salesRefundCents: 3000, idempotencyKey: `dlr:${order.id}:1` })
    const uno = await prisma.$transaction(tx => writeRefundInTx(tx, input))
    // Sin el replay, esto moriría: ya no queda nada que devolver de ese cobro.
    const dos = await prisma.$transaction(tx => writeRefundInTx(tx, input))
    expect(dos.refundPaymentId).toBe(uno.refundPaymentId)
    expect(dos.replay).toBe(true)
    expect(await prisma.payment.count({ where: { type: 'REFUND', orderId: order.id } })).toBe(1)
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: uno.refundPaymentId } })).idempotencyKey).toBe(`dlr:${order.id}:1`)
  })

  it('la llave ya usada por el reembolso de OTRO cobro no se devuelve como replay', async () => {
    const { pago: a } = await sembrarCobro({ venueId, staffId, saleCents: 3000, commissionPercent: 30 })
    const { pago: b } = await sembrarCobro({ venueId, staffId, saleCents: 3000, commissionPercent: 30 })
    const llave = `dlr:cruce:${a.id}`
    await prisma.$transaction(tx => writeRefundInTx(tx, ajusteDeReparto(a.id, { salesRefundCents: 1000, idempotencyKey: llave })))
    // Devolverle a B el reembolso de A le diría al reconciliador «ya quedó» sobre un cobro intacto.
    await expect(
      prisma.$transaction(tx => writeRefundInTx(tx, ajusteDeReparto(b.id, { salesRefundCents: 1000, idempotencyKey: llave }))),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(await prisma.payment.count({ where: { type: 'REFUND', orderId: b.orderId } })).toBe(0)
  })

  it('rechaza componentes negativos', async () => {
    const { pago } = await sembrarCobro({ venueId, staffId, saleCents: 20000, commissionPercent: 30 })
    await expect(prisma.$transaction(tx => writeRefundInTx(tx, ajusteDeReparto(pago.id, { salesRefundCents: -1 })))).rejects.toThrow(
      /no negativos/i,
    )
    await expect(prisma.$transaction(tx => writeRefundInTx(tx, ajusteDeReparto(pago.id, { tipRefundCents: -1 })))).rejects.toThrow(
      /no negativos/i,
    )
    expect(await prisma.payment.count({ where: { type: 'REFUND', orderId: pago.orderId } })).toBe(0)
  })

  it('el reembolso del dashboard queda como MANUAL, sin marcas de ajuste del proveedor', async () => {
    const { pago } = await sembrarCobro({ venueId, staffId, saleCents: 20000, commissionPercent: 30 })
    const r = await issueRefund({ venueId, paymentId: pago.id, amount: 5000, reason: 'OTHER', staffId })
    const pd = (await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })).processorData as Record<string, unknown>
    expect(pd.provenance).toBe('MANUAL')
    expect(pd).not.toHaveProperty('providerAdjustment')
    expect(pd).not.toHaveProperty('fiscalByRateCents')
    expect(pd).not.toHaveProperty('generation')
  })
})
