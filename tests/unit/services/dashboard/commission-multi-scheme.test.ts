import { Decimal } from '@prisma/client/runtime/library'
import {
  createCommissionForPayment,
  createSplitCommissionForPayment,
} from '../../../../src/services/dashboard/commission/commission-calculation.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE_ID = 'venue-mindform'
const STAFF_ID = 'staff-1'

function payment(amount = 500, orderId: string | null = 'order-1') {
  return {
    id: 'pay-1',
    type: 'CARD',
    status: 'COMPLETED',
    venueId: VENUE_ID,
    orderId,
    processedById: STAFF_ID,
    createdAt: new Date('2026-06-03T18:00:00Z'),
    amount: new Decimal(amount),
    tipAmount: new Decimal(0),
    order: {
      id: orderId,
      createdById: STAFF_ID,
      servedById: STAFF_ID,
      subtotal: new Decimal(amount),
      discountAmount: new Decimal(0),
      taxAmount: new Decimal(0),
    },
    shift: { id: 'shift-1' },
    venue: { id: VENUE_ID, timezone: 'America/Mexico_City' },
  }
}

const baseCfg = {
  venueId: VENUE_ID,
  orgId: null,
  recipient: 'SERVER',
  trigger: 'PER_PAYMENT',
  minAmount: null,
  maxAmount: null,
  includeTips: false,
  includeDiscount: false,
  includeTax: false,
  roleRates: null,
  useGoalAsTier: false,
  goalBonusRate: null,
  effectiveFrom: new Date('2026-01-01'),
  effectiveTo: null,
  tiers: [],
}
const HIDROGENO = {
  ...baseCfg,
  id: 'cfg-hid',
  name: 'Hidrógeno',
  priority: 100,
  calcType: 'PERCENTAGE',
  defaultRate: new Decimal(0.04),
  filterByCategories: true,
  categoryIds: ['cat-hid', 'cat-iyashi'],
}
const LAGREE = {
  ...baseCfg,
  id: 'cfg-lag',
  name: 'Lagree',
  priority: 50,
  calcType: 'PERCENTAGE',
  defaultRate: new Decimal(0.03),
  filterByCategories: true,
  categoryIds: ['cat-lagree'],
}
const GENERAL = {
  ...baseCfg,
  id: 'cfg-gen',
  name: 'General',
  priority: 1,
  calcType: 'PERCENTAGE',
  defaultRate: new Decimal(0.02),
  filterByCategories: false,
  categoryIds: [] as string[],
}

const ACTIVE_STAFF = { staffId: STAFF_ID, role: 'WAITER', staff: { id: STAFF_ID, active: true } }

// La base lee la orden COMPLETA de una vez y selecciona en memoria (antes filtraba
// en SQL por `product.categoryId`, lo que borraba los renglones de importe libre).
// El helper conserva su API por conjunto de categorías: cada clave se convierte en
// la categoría de esas líneas; 'leftover' = una categoría que nadie reclama.
function mockOrderItemsByCategory(map: Record<string, Array<{ unitPrice: number }>>) {
  const orderLines = Object.entries(map).flatMap(([key, items]) =>
    items.map(i => ({
      quantity: 1,
      unitPrice: new Decimal(i.unitPrice),
      taxAmount: new Decimal(0),
      discountAmount: new Decimal(0),
      product: { categoryId: key === 'leftover' ? 'cat-no-reclamada' : key.split(',')[0] },
    })),
  )
  prismaMock.orderItem.findMany.mockResolvedValue(orderLines)
}

beforeEach(() => {
  prismaMock.commissionCalculation.findFirst.mockResolvedValue(null) // idempotency: none yet
  prismaMock.commissionCalculation.findMany.mockResolvedValue([]) // no prior calcs on this order
  prismaMock.staffVenue.findFirst.mockResolvedValue(ACTIVE_STAFF)
  prismaMock.commissionOverride.findFirst.mockResolvedValue(null)
  prismaMock.commissionCalculation.create.mockImplementation(async (args: any) => ({ id: 'calc', ...args.data }))
  // Sin descuento de orden en estos escenarios (el prorrateo tiene su propia suite).
  prismaMock.order.findUnique.mockResolvedValue({ discountAmount: new Decimal(0) })
})

describe('multi-scheme commission engine', () => {
  it('pays BOTH schemes on a mixed ticket (Hidrógeno 4% + Lagree 3%)', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment())
    prismaMock.commissionConfig.findMany.mockResolvedValue([HIDROGENO, LAGREE])
    mockOrderItemsByCategory({ 'cat-hid,cat-iyashi': [{ unitPrice: 1000 }], 'cat-lagree': [{ unitPrice: 500 }] })

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(2)
    const hid = results.find(r => r.netCommission === 40) // 4% of 1000
    const lag = results.find(r => r.netCommission === 15) // 3% of 500
    expect(hid).toBeTruthy()
    expect(lag).toBeTruthy()
  })

  it('pays Lagree 3% on a Lagree-only ticket even though Hidrógeno has higher priority', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment())
    prismaMock.commissionConfig.findMany.mockResolvedValue([HIDROGENO, LAGREE])
    mockOrderItemsByCategory({ 'cat-hid,cat-iyashi': [], 'cat-lagree': [{ unitPrice: 500 }] })

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(1)
    expect(results[0].netCommission).toBe(15)
    expect(results[0].effectiveRate).toBe(0.03)
  })

  it("REGRESSION: single catch-all config bills the whole payment (today's behavior)", async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(500))
    prismaMock.commissionConfig.findMany.mockResolvedValue([GENERAL])

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(1)
    expect(results[0].netCommission).toBe(10) // 2% of 500
    // orderItem.findMany NOT used for a catch-all-only venue
    expect(prismaMock.orderItem.findMany).not.toHaveBeenCalled()
  })

  it('catch-all bills only the leftover when a category-scoped config also exists', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(500))
    prismaMock.commissionConfig.findMany.mockResolvedValue([LAGREE, GENERAL])
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 300 }], leftover: [{ unitPrice: 200 }] })

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(2)
    expect(results.find(r => r.netCommission === 9)).toBeTruthy() // Lagree 3% of 300
    expect(results.find(r => r.netCommission === 4)).toBeTruthy() // General 2% of 200 (leftover)
  })

  it('idempotency: a config that already has a calc for this payment+staff is skipped', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment())
    prismaMock.commissionConfig.findMany.mockResolvedValue([LAGREE])
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 500 }] })
    prismaMock.commissionCalculation.findFirst.mockResolvedValue({ id: 'already' })

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(0)
    expect(prismaMock.commissionCalculation.create).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 MONEY — bug real en prod (Mindform, orden cmqnz0gkb0bc9o12a0fuc6deg, 2026-06-21/22).
 *
 * La base de un config category-scoped se deriva de los ITEMS DE LA ORDEN, pero
 * createCommissionForPayment se dispara POR COBRO. Una orden con 3 cobros recalculó la
 * MISMA base de $380 tres veces → $34.20 comisionados sobre una venta de $380 (tocaban
 * $11.40). El guard de idempotencia existente es por PAGO, así que no lo detiene.
 *
 * La defensa es la misma del fix de descuentos apilados (268c5fc6): cobrar contra lo que
 * QUEDA por comisionar, no contra el total completo.
 */
describe('commission base: order-level base with per-payment trigger', () => {
  /** Prior non-voided calcs on the same order+config. baseAmount INCLUDES tip, so the
   *  item portion is baseAmount − tipAmount (that is what the service must discount). */
  function mockPriorCalcs(prior: Array<{ base: number; tip?: number }>) {
    prismaMock.commissionCalculation.findMany.mockResolvedValue(
      prior.map(p => ({ baseAmount: new Decimal(p.base), tipAmount: new Decimal(p.tip ?? 0) })),
    )
  }

  it('MONEY: a second payment on the SAME order does not re-bill items already commissioned', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(122))
    prismaMock.commissionConfig.findMany.mockResolvedValue([LAGREE])
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 380 }] })
    mockPriorCalcs([{ base: 380 }]) // the first payment already billed the whole $380

    const results = await createCommissionForPayment('pay-2')

    expect(results).toHaveLength(0)
    expect(prismaMock.commissionCalculation.create).not.toHaveBeenCalled()
  })

  it('MONEY: reproduces the exact prod case — 3 payments on a $380 order pay $11.40 total, not $34.20', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(232))
    prismaMock.commissionConfig.findMany.mockResolvedValue([LAGREE])
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 380 }] })
    mockPriorCalcs([{ base: 380 }]) // payment 1 billed it; payment 2 correctly billed nothing

    const results = await createCommissionForPayment('pay-3')

    expect(results).toHaveLength(0)
  })

  it('bills only the remainder when the first payment covered part of the base', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(200))
    prismaMock.commissionConfig.findMany.mockResolvedValue([LAGREE])
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 500 }] })
    mockPriorCalcs([{ base: 300 }]) // $300 of the $500 already billed

    const results = await createCommissionForPayment('pay-2')

    expect(results).toHaveLength(1)
    expect(results[0].netCommission).toBe(6) // 3% of the remaining $200
  })

  it('a prior calc that only billed a TIP does not consume the item base', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(500))
    prismaMock.commissionConfig.findMany.mockResolvedValue([LAGREE])
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 500 }] })
    mockPriorCalcs([{ base: 50, tip: 50 }]) // pure tip: item portion is 0

    const results = await createCommissionForPayment('pay-2')

    expect(results).toHaveLength(1)
    expect(results[0].netCommission).toBe(15) // full 3% of $500 still owed
  })

  it('catch-all leftover is capped the same way across payments', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(200))
    prismaMock.commissionConfig.findMany.mockResolvedValue([LAGREE, GENERAL])
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 300 }], leftover: [{ unitPrice: 200 }] })
    prismaMock.commissionCalculation.findMany.mockImplementation(
      async (args: any) =>
        args?.where?.configId === 'cfg-gen'
          ? [{ baseAmount: new Decimal(200), tipAmount: new Decimal(0) }] // leftover already billed
          : [{ baseAmount: new Decimal(300), tipAmount: new Decimal(0) }], // lagree already billed
    )

    const results = await createCommissionForPayment('pay-2')

    expect(results).toHaveLength(0)
  })

  // ── REGRESSION: the single-payment path must not change ──────────────────────
  it('REGRESSION: first payment on an order still bills the full base', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(500))
    prismaMock.commissionConfig.findMany.mockResolvedValue([LAGREE])
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 500 }] })

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(1)
    expect(results[0].netCommission).toBe(15) // 3% of 500 — unchanged
  })

  it('REGRESSION: catch-all-only venue never looks at prior order calcs', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(500))
    prismaMock.commissionConfig.findMany.mockResolvedValue([GENERAL])

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(1)
    expect(results[0].netCommission).toBe(10) // 2% of the PAYMENT, per-payment by design
  })

  /**
   * Separar/dividir/fusionar cuentas crea ÓRDENES NUEVAS y está prohibido sobre una cuenta
   * con pagos (`splitOrderItems` / `splitOrderBySeat` / `mergeOrders` lanzan si paymentStatus
   * es PAID o PARTIAL). Como el tope es por (orderId, configId), cada cuenta separada comisiona
   * íntegra. Este test clava esa frontera para que nadie la afloje sin darse cuenta.
   */
  it('SPLIT BILL: el tope es por ORDEN — una cuenta separada no hereda lo comisionado de la otra', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(300, 'order-separada'))
    prismaMock.commissionConfig.findMany.mockResolvedValue([LAGREE])
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 300 }] })
    // La cuenta hermana (order-1) ya comisionó lo suyo; ésta no debe verse afectada.
    prismaMock.commissionCalculation.findMany.mockImplementation(async (args: any) =>
      args?.where?.orderId === 'order-1' ? [{ baseAmount: new Decimal(300), tipAmount: new Decimal(0) }] : [],
    )

    const results = await createCommissionForPayment('pay-separada')

    expect(results).toHaveLength(1)
    expect(results[0].netCommission).toBe(9) // 3% de $300, íntegro
    expect(prismaMock.commissionCalculation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orderId: 'order-separada' }) }),
    )
  })
})

/**
 * 🔴 MONEY — el MISMO defecto vive en la ruta de comisión DIVIDIDA.
 *
 * `createSplitCommissionForPayment` también deriva la base de los ITEMS DE LA ORDEN cuando
 * el config es category-scoped, y también se dispara POR COBRO. Su guard de idempotencia es
 * `(paymentId, staffId)`, así que un segundo cobro sobre la misma orden vuelve a repartir la
 * venta COMPLETA entre todos los participantes.
 *
 * Ojo con la aritmética: cada fila guarda `splitBase` (= base/N), así que la suma de las N
 * filas de un cobro ES la base completa — que es justo lo que `alreadyCommissionedItemBase`
 * necesita ver para no volver a cobrarla.
 */
describe('split commission: order-level base with per-payment trigger', () => {
  const TWO_STAFF = ['staff-1', 'staff-2']

  /** Prior rows of a previous split. N filas de `base/N` que suman la base completa. */
  function mockPriorSplitRows(totalBase: number, rows: number, tipTotal = 0) {
    prismaMock.commissionCalculation.findMany.mockResolvedValue(
      Array.from({ length: rows }, () => ({
        baseAmount: new Decimal(totalBase / rows),
        tipAmount: new Decimal(tipTotal / rows),
      })),
    )
  }

  beforeEach(() => {
    // La ruta dividida resuelve el config con findFirst (singular), no findMany.
    prismaMock.commissionConfig.findFirst.mockResolvedValue(LAGREE)
  })

  it('MONEY: un segundo cobro sobre la MISMA orden no vuelve a repartir la venta completa', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(122))
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 600 }] })
    mockPriorSplitRows(600, 2) // el primer cobro ya repartió los $600 entre 2 personas

    const results = await createSplitCommissionForPayment('pay-2', TWO_STAFF)

    expect(results).toHaveLength(0)
    expect(prismaMock.commissionCalculation.create).not.toHaveBeenCalled()
  })

  it('reparte SÓLO el remanente cuando el primer cobro cubrió una parte', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(200))
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 600 }] })
    mockPriorSplitRows(200, 2) // ya se comisionaron $200 de los $600

    const results = await createSplitCommissionForPayment('pay-2', TWO_STAFF)

    // Remanente $400 / 2 personas = $200 c/u → 3% = $6 c/u
    expect(results).toHaveLength(2)
    expect(results.every(r => r.netCommission === 6)).toBe(true)
    expect(results.reduce((s, r) => s + r.netCommission, 0)).toBe(12) // 3% de $400
  })

  it('una fila previa de PURA propina no consume la base de items', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(600))
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 600 }] })
    mockPriorSplitRows(80, 2, 80) // base == propina → porción de items = 0

    const results = await createSplitCommissionForPayment('pay-2', TWO_STAFF)

    expect(results).toHaveLength(2)
    expect(results.every(r => r.netCommission === 9)).toBe(true) // 3% de $300 c/u, íntegro
  })

  // ── REGRESSION: el reparto de un solo cobro NO debe cambiar ──────────────────
  it('REGRESSION: el primer cobro reparte la base completa entre los participantes', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(600))
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 600 }] })

    const results = await createSplitCommissionForPayment('pay-1', TWO_STAFF)

    expect(results).toHaveLength(2)
    expect(results.every(r => r.baseAmount === 300)).toBe(true) // 600 / 2
    expect(results.reduce((s, r) => s + r.netCommission, 0)).toBe(18) // 3% de $600
  })

  it('REGRESSION: un config catch-all reparte el COBRO y no consulta cálculos previos de la orden', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(500))
    prismaMock.commissionConfig.findFirst.mockResolvedValue(GENERAL)

    const results = await createSplitCommissionForPayment('pay-1', TWO_STAFF)

    expect(results).toHaveLength(2)
    expect(results.every(r => r.netCommission === 5)).toBe(true) // 2% de $250 c/u
    expect(prismaMock.commissionCalculation.findMany).not.toHaveBeenCalled()
  })

  it('REGRESSION: con un solo participante delega en createCommissionForPayment', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(500))
    prismaMock.commissionConfig.findMany.mockResolvedValue([LAGREE])
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 500 }] })

    const results = await createSplitCommissionForPayment('pay-1', ['staff-1'])

    expect(results).toHaveLength(1)
    expect(results[0].netCommission).toBe(15) // 3% de $500 completo, sin dividir
  })
})
