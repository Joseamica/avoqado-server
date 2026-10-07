/**
 * Unit tests (mock-first) for los read-models de Capa A (gerencial, NO fiscal):
 *  - getIncomeStatement (estado de resultados): IVA-incluido split, refunds, TEST, propinas aparte.
 *  - getBusinessSummary (resumen del negocio): revenue, propinas, colección, comisiones, facturación %.
 *  - getBankAndCashSummary (bancos y cajas): bucketing caja/banco + net-to-bank (venta + propina − comisión).
 *
 * Prisma mockeado: filas fijas in, matemática determinista out (cuadró al centavo en /full-testing).
 */
import { OrderStatus, PaymentMethod, PaymentType, Prisma, TransactionStatus } from '@prisma/client'

jest.mock('../../../../src/utils/prismaClient', () => {
  const p = {
    venue: { findUnique: jest.fn() },
    payment: { findMany: jest.fn(), groupBy: jest.fn() },
    fiscalEmisor: { findFirst: jest.fn() },
    cfdi: { aggregate: jest.fn(), groupBy: jest.fn() },
    bankStatement: { count: jest.fn(), aggregate: jest.fn() },
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  }
  p.$transaction.mockImplementation(async (fn: (tx: typeof p) => unknown) => fn(p))
  return { __esModule: true, default: p }
})
jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))
// COGS se prueba en cogs.service.test; aquí lo mockeamos para no pegar a prisma de inventario.
jest.mock('../../../../src/services/fiscal/cogs.service', () => ({ computePeriodCogsCents: jest.fn() }))
// B4b: las lecturas del libro se prueban en librosDeOrdenes.test.ts. Aquí el doble corre el libro REAL sobre lo que la prueba siembra
// en `base` (orden ⇒ renglones, cuenta y movimientos), como lo entregaría `recorrerLibros`: sólo las órdenes pedidas, sin los de prueba.
// Los SQL son los de verdad (`requireActual`): la prueba compara la enumeración con `sqlDeOrdenesDelPeriodo`.
jest.mock('../../../../src/services/fiscal/librosDeOrdenes', () => ({
  ...jest.requireActual('../../../../src/services/fiscal/librosDeOrdenes'),
  recorrerLibros: jest.fn(),
}))

import prisma from '../../../../src/utils/prismaClient'
import { computePeriodCogsCents } from '../../../../src/services/fiscal/cogs.service'
import {
  LOTE_DE_ORDENES,
  MENSAJE_MES_NO_CALCULADO,
  TIEMPO_MAXIMO_DEL_REPORTE_MS,
  conFotoDeReporte,
  getBankAndCashSummary,
  getBusinessSummary,
  getIncomeStatement,
} from '../../../../src/services/dashboard/accounting.dashboard.service'
import {
  MAX_ORDENES_POR_REPORTE,
  recorrerLibros,
  sqlDeOrdenesDelPeriodo,
  type MovimientoLeido,
} from '../../../../src/services/fiscal/librosDeOrdenes'
import { abrirLibro } from '../../../../src/services/fiscal/libroDeLaOrden'
import { mezclaDeLaOrden, type CuentaDeMezcla, type RenglonDeMezcla } from '../../../../src/services/fiscal/mezclaDeOrden'
import { ServiceUnavailableError, ValidationError } from '../../../../src/errors/AppError'
import { RequestCancelledError, isReadOperation } from '../../../../src/utils/requestCancellation'
import logger from '../../../../src/config/logger'
import { TIEMPO_MAXIMO_DEL_ISR_MS } from '../../../../src/services/fiscal/isr.service'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  payment: { findMany: jest.Mock; groupBy: jest.Mock }
  fiscalEmisor: { findFirst: jest.Mock }
  cfdi: { aggregate: jest.Mock; groupBy: jest.Mock }
  bankStatement: { count: jest.Mock; aggregate: jest.Mock }
  $transaction: jest.Mock
  $queryRaw: jest.Mock
  $executeRaw: jest.Mock
}
const mCogs = computePeriodCogsCents as jest.Mock

const VENUE = 'venue_1'
const FILTERS = { from: '2026-06-01', to: '2026-06-16' }

/** Fila de Payment simple (montos en pesos; refunds negativos). Para los tests de getIncomeStatement. */
const row = (amount: number, type: string | null = 'REGULAR', tipAmount = 0) => ({ amount, tipAmount, type })

// 3 ventas (2 tarjeta, 1 efectivo) + 1 devolución (tarjeta) + 1 TEST (debe excluirse). Con propina de
// tarjeta (10 + 5). Alimenta getBusinessSummary y getBankAndCashSummary vía el beforeEach.
const ROWS = [
  { amount: 100, tipAmount: 10, type: PaymentType.REGULAR, method: PaymentMethod.CREDIT_CARD, feeAmount: 3 },
  { amount: 50, tipAmount: 5, type: PaymentType.REGULAR, method: PaymentMethod.DEBIT_CARD, feeAmount: 1.5 },
  { amount: 200, tipAmount: 0, type: PaymentType.REGULAR, method: PaymentMethod.CASH, feeAmount: 0 },
  { amount: -30, tipAmount: 0, type: PaymentType.REFUND, method: PaymentMethod.CREDIT_CARD, feeAmount: 0 },
  { amount: 999, tipAmount: 99, type: PaymentType.TEST, method: PaymentMethod.CASH, feeAmount: 0 },
]

/**
 * Lo que `groupBy(['method', 'type'])` devolvería para estas filas: sumas por método y tipo.
 * (B4b Tarea 5) Recibe también las filas de `sembrar`, que pueden no traer propina ni comisión: valen 0.
 */
const agrupar = (rows: Array<Record<string, any>>) => {
  const m = new Map<
    string,
    { method: string; type: string; _sum: { amount: number; tipAmount: number; feeAmount: number }; _count: { _all: number } }
  >()
  for (const r of rows) {
    const k = `${r.method}|${r.type}`
    const g = m.get(k) ?? { method: r.method, type: r.type, _sum: { amount: 0, tipAmount: 0, feeAmount: 0 }, _count: { _all: 0 } }
    g._sum.amount += r.amount
    g._sum.tipAmount += r.tipAmount ?? 0
    g._sum.feeAmount += r.feeAmount ?? 0
    g._count._all += 1
    m.set(k, g)
  }
  return [...m.values()]
}

/** B4b · lo que «la base» tiene por orden, y qué órdenes tienen cobros del periodo (lo que contesta la enumeración). */
const base = new Map<string, { items: RenglonDeMezcla[]; cuenta: CuentaDeMezcla; movimientos: MovimientoLeido[] }>()
let ordenesDelPeriodo: string[] = []
const EN_JUNIO = new Date('2026-06-10T18:00:00.000Z')
/** Un movimiento como lo entrega `recorrerLibros` (pesos ⇒ centavos). */
const movimiento = (f: Record<string, any>): MovimientoLeido => ({
  id: f.id,
  orderId: f.orderId,
  createdAt: f.createdAt ?? EN_JUNIO,
  type: f.type ?? null,
  amountCents: Math.round(Number(f.amount) * 100),
  tipCents: Math.round(Number(f.tipAmount ?? 0) * 100),
  method: f.method ?? null,
  processorData: f.processorData,
  incluirEnContabilidad: f.merchantAccount?.fiscalConfig?.includeInAccounting ?? f.ecommerceMerchant?.fiscalConfig?.includeInAccounting,
})
const enumeracion = () => p.$queryRaw.mock.calls[0][0] as Prisma.Sql
/**
 * Las pruebas de antes de B4b: cada fila es un cobro de SU propia orden sin renglones (importe libre ⇒ 16 %). La enumeración devuelve
 * sus órdenes y el libro real hace la cuenta. Las literales de esas pruebas no cambian.
 */
const sembrar = (filas: Array<Record<string, any>>) => {
  // El tipo explícito: esparcir un `Record<string, any>` pierde su índice y `f.type` dejaría de compilar (TS2339).
  const conIds: Array<Record<string, any>> = filas.map((f, i) => ({ id: `p${i}`, orderId: `o${i}`, createdAt: EN_JUNIO, ...f }))
  // B4b Tarea 5: `aggregatePeriodPayments` (Resumen y Bancos) ya no lee filas (`findMany`): suma en la base con `groupBy`.
  p.payment.groupBy.mockResolvedValue(agrupar(conIds))
  base.clear()
  ordenesDelPeriodo = conIds.map(f => f.orderId)
  for (const f of conIds) {
    if (f.type === PaymentType.TEST) continue // el cargador no entrega los de prueba
    base.set(f.orderId, { items: [], cuenta: {}, movimientos: [movimiento(f)] })
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  p.venue.findUnique.mockResolvedValue({ name: 'Test', timezone: 'America/Mexico_City' })
  p.fiscalEmisor.findFirst.mockResolvedValue(null) // sin emisor → includeCashInAccounting=false (default)
  ;(recorrerLibros as jest.Mock).mockImplementation(
    async (_tx: unknown, { orderIds }: { orderIds: string[] }, alMovimiento: (m: MovimientoLeido, parte: unknown) => void) => {
      for (const id of orderIds) {
        const o = base.get(id)
        if (!o) continue
        const libro = abrirLibro(mezclaDeLaOrden(o.items, o.cuenta))
        for (const m of o.movimientos) alMovimiento(m, libro.registrar(m))
      }
      return { consultas: 0, filas: 0 }
    },
  )
  p.$transaction.mockImplementation(async (fn: (tx: typeof p) => unknown) => fn(p))
  // La enumeración: los ids del periodo, sin repetir y ordenados, hasta el `LIMIT` (el último valor del SQL).
  p.$queryRaw.mockImplementation(async (s: Prisma.Sql) => {
    const limite = s.values.at(-1) as number
    return [...new Set(ordenesDelPeriodo)]
      .sort()
      .slice(0, limite)
      .map(orderId => ({ orderId }))
  })
  sembrar(ROWS)
  p.cfdi.aggregate.mockResolvedValue({ _sum: { totalCents: 10000 }, _count: { _all: 1 } })
  p.cfdi.groupBy.mockResolvedValue([{ isGlobal: false, _count: { _all: 1 } }])
  p.bankStatement.count.mockResolvedValue(2)
  p.bankStatement.aggregate.mockResolvedValue({ _sum: { lineCount: 10, matchedCount: 4 } })
  mCogs.mockResolvedValue(0) // sin costo de ventas por default
})

describe('getIncomeStatement (Capa A — estado de resultados)', () => {
  // ---------- NEW FEATURE ----------
  it('splits IVA-included revenue: gross 116.00 → base 100.00 + IVA 16.00', async () => {
    sembrar([row(116)])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(11600)
    expect(r.revenue.netRevenueCents).toBe(11600)
    expect(r.revenue.taxableBaseCents).toBe(10000)
    expect(r.revenue.ivaCents).toBe(1600)
    expect(r.taxRateAssumed).toBe(0.16)
    expect(r.metrics.salesCount).toBe(1)
  })

  it('subtracts refunds (type=REFUND, negative amount) and counts them', async () => {
    sembrar([row(100, 'REGULAR'), row(-50, 'REFUND')])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(10000)
    expect(r.revenue.refundsCents).toBe(5000)
    expect(r.revenue.netRevenueCents).toBe(5000)
    expect(r.metrics.salesCount).toBe(1)
    expect(r.metrics.refundCount).toBe(1)
  })

  it('excludes TEST payments entirely', async () => {
    sembrar([row(100, 'REGULAR'), row(999, 'TEST')])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(10000)
    expect(r.metrics.salesCount).toBe(1)
  })

  it('counts legacy null-type payments as sales (notIn would have dropped them)', async () => {
    sembrar([row(100, null)])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(10000)
    expect(r.metrics.salesCount).toBe(1)
  })

  it('returns zeros (no divide-by-zero) for an empty period', async () => {
    sembrar([])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(0)
    expect(r.revenue.ivaCents).toBe(0)
    expect(r.metrics.averageTicketCents).toBe(0)
  })

  // ---------- ALCANCE FISCAL CONFIGURABLE ----------
  it('fiscalRevenue EXCLUYE el efectivo por default; revenue (gerencial) lo incluye', async () => {
    sembrar([
      { amount: 116, tipAmount: 0, type: 'REGULAR', method: PaymentMethod.CREDIT_CARD },
      { amount: 200, tipAmount: 0, type: 'REGULAR', method: PaymentMethod.CASH },
    ])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(31600) // gerencial: todo
    expect(r.fiscalRevenue.grossSalesCents).toBe(11600) // fiscal: solo la tarjeta
  })

  it('fiscalRevenue INCLUYE el efectivo cuando el emisor optó (includeCashInAccounting=true)', async () => {
    p.fiscalEmisor.findFirst.mockResolvedValue({ includeCashInAccounting: true })
    sembrar([
      { amount: 116, tipAmount: 0, type: 'REGULAR', method: PaymentMethod.CREDIT_CARD },
      { amount: 200, tipAmount: 0, type: 'REGULAR', method: PaymentMethod.CASH },
    ])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.fiscalRevenue.grossSalesCents).toBe(31600)
  })

  it('fiscalRevenue EXCLUYE un merchant con includeInAccounting=false; revenue lo incluye', async () => {
    sembrar([
      { amount: 116, tipAmount: 0, type: 'REGULAR', method: PaymentMethod.CREDIT_CARD },
      {
        amount: 232,
        tipAmount: 0,
        type: 'REGULAR',
        method: PaymentMethod.CREDIT_CARD,
        merchantAccount: { fiscalConfig: { includeInAccounting: false } },
      },
    ])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(34800) // gerencial: ambos
    expect(r.fiscalRevenue.grossSalesCents).toBe(11600) // fiscal: solo el merchant incluido
  })

  it('🔴 venta en EFECTIVO devuelta por transferencia: con el efectivo fuera de lo fiscal, la devolución tampoco resta', async () => {
    sembrar([
      { id: 'v1', amount: 200, tipAmount: 0, type: 'REGULAR', method: PaymentMethod.CASH },
      {
        id: 'r1',
        amount: -200,
        tipAmount: 0,
        type: PaymentType.REFUND,
        method: PaymentMethod.BANK_TRANSFER,
        processorData: { originalMethod: 'CASH' },
      },
    ])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.fiscalRevenue.grossSalesCents).toBe(0)
    expect(r.fiscalRevenue.refundsCents).toBe(0)
    expect(r.revenue.refundsCents).toBe(20000) // el gerencial la cuenta siempre
  })

  // ---------- REGRESSION / INVARIANTS ----------
  it('never includes tips in revenue (reported separately)', async () => {
    sembrar([row(100, 'REGULAR', 20)])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(10000) // NOT 12000
    expect(r.tips.totalCents).toBe(2000)
  })

  it('always isolates by venueId + COMPLETED + non-cancelled orders OF THIS VENUE, with utcTs dates (B4b: la enumeración)', async () => {
    sembrar([])
    await getIncomeStatement(VENUE, FILTERS)
    const s = enumeracion()
    expect(s.sql).toContain('p."venueId" = ?')
    expect(s.sql).toContain(`p.status = 'COMPLETED'`)
    expect(s.sql).toContain('o."venueId" = ?')
    expect(s.sql).toContain(`o.status <> 'CANCELLED'`)
    expect(s.sql.match(/AT TIME ZONE 'UTC'/g)).toHaveLength(2) // Codex r5 R5-2: los dos extremos del periodo
    expect(s.values.filter(v => v === VENUE)).toHaveLength(2)
  })
})

describe('getBusinessSummary (Resumen del negocio)', () => {
  it('computes revenue with IVA-incluido split, refunds excluded from gross', async () => {
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.revenue.grossSalesCents).toBe(35000) // 100+50+200 (TEST excluido)
    expect(r.revenue.refundsCents).toBe(3000)
    expect(r.revenue.netRevenueCents).toBe(32000)
    // splitIvaIncluded(32000, 0.16): net=round(32000/1.16)=27586, iva=4414
    expect(r.revenue.taxableBaseCents).toBe(27586)
    expect(r.revenue.ivaCents).toBe(4414)
    expect(r.revenue.taxableBaseCents + r.revenue.ivaCents).toBe(r.revenue.netRevenueCents)
  })

  it('tips exclude TEST + refunds; metrics count only real sales', async () => {
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.tips.totalCents).toBe(1500) // 10+5 (cash 0, refund 0, TEST excluido)
    expect(r.metrics.salesCount).toBe(3)
    expect(r.metrics.refundCount).toBe(1)
    expect(r.metrics.averageTicketCents).toBe(11667) // round(35000/3)
  })

  it('splits collection cash vs electrónico (refund reduces the card bucket)', async () => {
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.collection.cashCents).toBe(20000)
    expect(r.collection.electronicCents).toBe(12000) // 100+50-30
    expect(r.collection.cashPct).toBe(63) // round(20000/32000*100)
  })

  it('sums processing fees (non-refund) and net-after-fees', async () => {
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.costs.processingFeesCents).toBe(450) // 300+150
    expect(r.result.netAfterFeesCents).toBe(31550) // 32000-450
  })

  it('computes gross profit = net revenue − COGS (utilidad bruta)', async () => {
    mCogs.mockResolvedValue(12000) // costo de ventas $120.00
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.result.cogsCents).toBe(12000)
    expect(r.result.grossProfitCents).toBe(20000) // 32000 net − 12000 COGS
  })

  it('reports invoicing from stamped CFDIs (approx capped at net revenue)', async () => {
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.invoicing.stampedCount).toBe(1)
    expect(r.invoicing.nominativeCount).toBe(1)
    expect(r.invoicing.globalCount).toBe(0)
    expect(r.invoicing.invoicedApproxCents).toBe(10000)
    expect(r.invoicing.uninvoicedApproxCents).toBe(22000) // 32000-10000
    expect(r.invoicing.invoicedPct).toBe(31) // round(10000/32000*100)
  })

  it('passes through reconciliation status', async () => {
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.reconciliation).toEqual({ statements: 2, lineCount: 10, matchedCount: 4 })
  })

  it('invoicedPct is 0 when there is no net revenue (no division by zero)', async () => {
    sembrar([])
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.revenue.netRevenueCents).toBe(0)
    expect(r.invoicing.invoicedPct).toBe(0)
    expect(r.collection.cashPct).toBe(0)
  })
})

describe('getBankAndCashSummary (Bancos y cajas)', () => {
  it('buckets methods into caja (cash) vs banco (electrónico), sorted by inflow', async () => {
    const r = await getBankAndCashSummary('venue-1', FILTERS)
    expect(r.accounts.map(a => a.key)).toEqual(['cash', 'card']) // cash 20000 > card 12000
    const cash = r.accounts.find(a => a.key === 'cash')!
    const card = r.accounts.find(a => a.key === 'card')!
    expect(cash.kind).toBe('cash')
    expect(cash.inflowCents).toBe(20000)
    expect(cash.count).toBe(1)
    expect(card.kind).toBe('bank')
    expect(card.inflowCents).toBe(12000) // 100+50-30 (venta, SIN propina)
    expect(card.count).toBe(2) // refund no cuenta
    expect(card.methods.sort()).toEqual(['CREDIT_CARD', 'DEBIT_CARD'])
  })

  it('totals: net-to-bank = electrónico + propina − comisiones', async () => {
    const r = await getBankAndCashSummary('venue-1', FILTERS)
    expect(r.totals.cashInflowCents).toBe(20000)
    expect(r.totals.electronicInflowCents).toBe(12000)
    expect(r.totals.electronicTipsCents).toBe(1500) // propina de tarjeta (10+5); la de efectivo/refund no
    expect(r.totals.feesCents).toBe(450)
    expect(r.totals.netToBankCents).toBe(13050) // 12000 + 1500 − 450 (la propina de tarjeta SÍ se deposita)
  })

  it('matches getBusinessSummary collection (single source of truth)', async () => {
    const summary = await getBusinessSummary('venue-1', FILTERS)
    const banks = await getBankAndCashSummary('venue-1', FILTERS)
    expect(summary.collection.cashCents).toBe(banks.totals.cashInflowCents)
    expect(summary.collection.electronicCents).toBe(banks.totals.electronicInflowCents)
  })
})

// ─── Bloque B4b (spec §4.9, D17, H20; Codex r2 N4, N6, N8; r3 R3-2; r4 R4-4; r5 R5-1, R5-3, R5-6, R5-8): el libro de cada orden,
//     cada orden una vez, una sola foto, sólo lecturas, errores con código ───
describe('B4b · getIncomeStatement suma lo que da el libro de cada orden', () => {
  const linea = (o: Record<string, unknown> = {}): RenglonDeMezcla => ({
    id: 'oi-cafe',
    quantity: 1,
    unitPrice: 116,
    total: 116,
    discountAmount: 0,
    orderPromotionId: null,
    isCortesia: false,
    ivaTratamiento: null,
    product: { taxRate: 0.16, ivaTratamiento: 'IVA_16' },
    ...o,
  })
  const grano = () => linea({ id: 'oi-grano', unitPrice: 100, total: 100, product: { taxRate: 0, ivaTratamiento: 'IVA_0' } })
  const MAYO = new Date('2026-05-20T18:00:00.000Z')
  /** Siembra una orden con sus movimientos (de tarjeta, salvo que se diga otra cosa) y la pone en la enumeración. */
  const orden = (
    id: string,
    movimientos: Array<Record<string, unknown>>,
    items: RenglonDeMezcla[] = [linea(), grano()],
    cuenta: CuentaDeMezcla = {},
  ) => {
    base.set(id, { items, cuenta, movimientos: movimientos.map(m => movimiento({ orderId: id, method: PaymentMethod.CREDIT_CARD, ...m })) })
    ordenesDelPeriodo.push(id)
  }
  const muchas = (n: number) => {
    for (let i = 0; i < n; i++) orden(`o${String(i).padStart(4, '0')}`, [{ id: `p${i}`, amount: 1.16, type: 'REGULAR' }], [])
  }
  // El mensaje real de Prisma 6.19 (`@prisma/client/runtime/client.js`) para el vencimiento; y otro P2028 que NO lo es (Codex r7 R7-5).
  const P2028 = () =>
    new Prisma.PrismaClientKnownRequestError(
      'Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 120000 ms, however 120013 ms passed since the start of the transaction.',
      { code: 'P2028', clientVersion: 'prueba' },
    )
  const P2028Confirmada = () =>
    new Prisma.PrismaClientKnownRequestError(
      'Transaction API error: Transaction already closed: A query cannot be executed on a committed transaction.',
      {
        code: 'P2028',
        clientVersion: 'prueba',
      },
    )

  beforeEach(() => {
    base.clear()
    ordenesDelPeriodo = []
  })

  it('🔴 Codex r2 N4 · la enumeración sólo trae ids: ventas, base e IVA salen de la lectura del libro', async () => {
    orden('o1', [{ id: 'p1', amount: 232, type: 'REGULAR' }], [linea({ quantity: 2, total: 232 })])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue).toMatchObject({ grossSalesCents: 23200, ivaCents: 3200, taxableBaseCents: 20000 })
    expect(enumeracion().sql).toMatch(/SELECT p\."orderId" AS "orderId"\s+FROM/)
  })

  it('🔴 Codex r5 R5-6 · la enumeración es EXACTAMENTE `sqlDeOrdenesDelPeriodo` (la que mide la Tarea 8), con el tope + 1', async () => {
    orden('o1', [{ id: 'p1', amount: 116, type: 'REGULAR' }], [linea()])
    await getIncomeStatement(VENUE, FILTERS)
    const s = enumeracion()
    const [venue, desde, hasta] = s.values as [string, Date, Date]
    expect(venue).toBe(VENUE)
    expect(s).toEqual(sqlDeOrdenesDelPeriodo(VENUE, desde, hasta, MAX_ORDENES_POR_REPORTE + 1))
  })

  it('🔴 cada orden UNA vez · la enumeración AGRUPA por orden: el tope cuenta órdenes y los cobros de una orden no quedan en dos lotes', async () => {
    // Sin el GROUP BY saldría una fila por cobro: el LIMIT contaría cobros, y una orden cuyos cobros cayeran a caballo de dos lotes se
    // leería (y sumaría) dos veces. El `new Set` del cargador sólo deduplica DENTRO de un lote, así que ninguna otra prueba lo ve.
    orden('o1', [{ id: 'p1', amount: 116, type: 'REGULAR' }], [linea()])
    await getIncomeStatement(VENUE, FILTERS)
    expect(enumeracion().sql).toMatch(/GROUP BY p\."orderId"\s+ORDER BY p\."orderId"/)
  })

  it('🔴 T7-I1 · el tiempo máximo del reporte queda bajo el corte de 100 s del proxy de Cloudflare, para que REPORT_TIMEOUT llegue al navegador (un 524 nunca trae nuestro código)', () => {
    const CORTE_DEL_PROXY_MS = 100_000
    expect(TIEMPO_MAXIMO_DEL_REPORTE_MS).toBeLessThan(CORTE_DEL_PROXY_MS)
  })

  it('🔴 Codex r3 R3-2, r5 R5-3 · todo el reporte en UNA transacción REPEATABLE READ con tiempo máximo; UNA enumeración; sólo lecturas', async () => {
    muchas(LOTE_DE_ORDENES + 2)
    await getIncomeStatement(VENUE, FILTERS)
    expect(p.$transaction).toHaveBeenCalledTimes(1)
    expect(p.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: TIEMPO_MAXIMO_DEL_REPORTE_MS,
    })
    expect(p.$queryRaw).toHaveBeenCalledTimes(1) // una sola enumeración; nada de cursor ni de FETCH
    expect(p.$executeRaw).not.toHaveBeenCalled() // el freno contaría un $executeRaw como escritura y dejaría de cortar
    for (const [s] of p.$queryRaw.mock.calls) expect(isReadOperation('$queryRaw', s)).toBe(true)
    expect((recorrerLibros as jest.Mock).mock.calls.map(c => c[1].orderIds.length)).toEqual([500, 2])
    expect((recorrerLibros as jest.Mock).mock.calls.every(c => c[0] === p)).toBe(true) // con la transacción del reporte
  })

  it('🔴 Review Focus 1 · tres cobros de $72 de una orden mezclada: IVA $16.00 y base al 0 % $100.00; la orden se lee una vez', async () => {
    orden(
      'o1',
      [1, 2, 3].map(k => ({ id: `p${k}`, amount: 72, type: 'REGULAR' })),
    )
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue).toMatchObject({
      grossSalesCents: 21600,
      ivaCents: 1600,
      taxableBaseCents: 20000,
      tasa0BaseCents: 10000,
      movimientosConIvaAproximado: 0,
    })
    expect(recorrerLibros).toHaveBeenCalledTimes(1)
    expect((recorrerLibros as jest.Mock).mock.calls[0][1]).toEqual({ venueId: VENUE, orderIds: ['o1'], hasta: expect.any(Date) })
  })

  it('🔴 Review Focus 1 · un cobro de MAYO construye el libro pero no se suma a junio; entre los tres dan el total exacto', async () => {
    orden('o1', [
      { id: 'p0', amount: 72, type: 'REGULAR', createdAt: MAYO },
      { id: 'p1', amount: 72, type: 'REGULAR' },
      { id: 'p2', amount: 72, type: 'REGULAR' },
    ])
    const r = await getIncomeStatement(VENUE, FILTERS)
    // Partes del libro: p0 533 / 3333 · p1 534 / 3334 · p2 533 / 3333.
    expect(r.revenue).toMatchObject({ grossSalesCents: 14400, ivaCents: 1067, tasa0BaseCents: 6667 })
    expect(r.metrics.salesCount).toBe(2)
  })

  it('🔴 H20 · devolver por artículos sólo el grano no baja el IVA del 16 %', async () => {
    const pd = { provenance: 'MANUAL', refundedItems: [{ orderItemId: 'oi-grano', quantity: 1, amountCents: 10000 }] }
    orden('o1', [
      { id: 'p1', amount: 216, type: 'REGULAR' },
      { id: 'r1', amount: -100, type: 'REFUND', processorData: pd },
    ])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue).toMatchObject({
      grossSalesCents: 21600,
      refundsCents: 10000,
      ivaCents: 1600,
      taxableBaseCents: 10000,
      tasa0BaseCents: 0,
    })
    expect(r.revenue.ingresosSinIvaCents! + r.revenue.ivaCents).toBe(r.revenue.netRevenueCents)
  })

  it('🔴 Codex r2 N8 · la devolución de junio hereda la incertidumbre de una de mayo, y se cuenta en lo gerencial y en lo fiscal', async () => {
    const desconocido = { provenance: 'MANUAL', refundedItems: [{ orderItemId: 'oi-x', quantity: 1, amountCents: 10000 }] }
    orden('o1', [
      { id: 'p0', amount: 216, type: 'REGULAR', createdAt: MAYO },
      { id: 'r0', amount: -100, type: 'REFUND', createdAt: MAYO, processorData: desconocido },
      { id: 'r1', amount: -50, type: 'REFUND', processorData: { provenance: 'MANUAL' } },
    ])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue).toMatchObject({ refundsCents: 5000, ivaCents: -370, movimientosConIvaAproximado: 1 })
    expect(r.fiscalRevenue.movimientosConIvaAproximado).toBe(1)
    expect(r.metrics).toMatchObject({ salesCount: 0, refundCount: 1 }) // R5-10: sólo devoluciones, no «sin movimientos»
  })

  it('🔴 Codex r3 R3-3 · un ajuste de Uber en junio, tras una devolución estimada en mayo, también se cuenta como aproximado', async () => {
    const desconocido = { provenance: 'MANUAL', refundedItems: [{ orderItemId: 'oi-x', quantity: 1, amountCents: 10000 }] }
    const ajuste = {
      provenance: 'PROVIDER_ADJUSTMENT',
      fiscalByRateCents: { v: 2, porTratamiento: { IVA_16: { baseCents: 5369, ivaCents: 861 } } },
    }
    orden('o1', [
      { id: 'p0', amount: 216, type: 'REGULAR', createdAt: MAYO },
      { id: 'r0', amount: -100, type: 'REFUND', createdAt: MAYO, processorData: desconocido },
      { id: 'r1', amount: -62.3, type: 'REFUND', processorData: ajuste },
    ])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue).toMatchObject({ refundsCents: 6230, ivaCents: -859, movimientosConIvaAproximado: 1 })
  })

  it('🔴 Codex r2 N4/N7 · una orden que la foto no trae (de otro negocio, o cancelada entre lecturas) no se suma por su cuenta', async () => {
    ordenesDelPeriodo = ['o-ajena'] // la enumeración la vio; el libro no
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue).toMatchObject({ grossSalesCents: 0, ivaCents: 0 })
    expect(r.metrics.salesCount).toBe(0)
  })

  it('🔴 Codex r3 R3-2 · cada orden sale UNA vez de la enumeración: si el primer cobro de una orden cambia a media corrida, no se cuenta dos veces', async () => {
    const id = (i: number) => `o${String(i).padStart(4, '0')}`
    // 502 órdenes de importe libre, una de ellas (o0000) con dos cobros de $116; las demás, uno de $1.16. Lotes de 500 y de 2. (En
    // producción la transacción REPEATABLE READ ni siquiera deja ver el cambio; aquí el doble lo simula para probar que, aun así, la
    // enumeración no la repite.)
    base.set(id(0), {
      items: [],
      cuenta: {},
      movimientos: [1, 2].map(k =>
        movimiento({ id: `d${k}`, orderId: id(0), amount: 116, type: 'REGULAR', method: PaymentMethod.CREDIT_CARD }),
      ),
    })
    ordenesDelPeriodo.push(id(0))
    for (let i = 1; i < 502; i++) orden(id(i), [{ id: `p${i}`, amount: 1.16, type: 'REGULAR' }], [])
    // Al terminar el primer lote, el primer cobro de o0000 pasa a FAILED: la base ya no lo trae, y o0000 sigue teniendo uno del
    // periodo. Con la v3 (páginas de cobros + «¿ya se sumó?» por el estado de los pagos) se sumaba otra vez: $348.
    const original = (recorrerLibros as jest.Mock).getMockImplementation()!
    ;(recorrerLibros as jest.Mock).mockImplementation(async (tx: unknown, q: { orderIds: string[] }, cb: unknown) => {
      const r = await original(tx, q, cb)
      base.get(id(0))!.movimientos.splice(0, 1)
      return r
    })
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(23200 + 501 * 116)
    expect(r.metrics.salesCount).toBe(503)
    const leidas = (recorrerLibros as jest.Mock).mock.calls.flatMap(c => c[1].orderIds)
    expect(new Set(leidas).size).toBe(leidas.length) // ninguna orden dos veces
    expect(leidas).toHaveLength(502)
  })

  it('🔴 fallo 1 de la ronda 6 · un periodo con más órdenes que el tope: REPORT_TOO_LARGE, sin leer ningún libro, con aviso en el log', async () => {
    muchas(4)
    const e = await getIncomeStatement(VENUE, FILTERS, { tiempoMaximoMs: TIEMPO_MAXIMO_DEL_REPORTE_MS, maxOrdenes: 3 }).catch(x => x)
    expect(e).toBeInstanceOf(ValidationError)
    expect(e).toMatchObject({ statusCode: 422, code: 'REPORT_TOO_LARGE', details: { motivo: 'PERIODO', limite: 3 } })
    expect(e.message).toMatch(/elige un rango más corto/)
    expect(enumeracion().values.at(-1)).toBe(4) // pide el tope + 1 para saber si se pasó
    expect(recorrerLibros).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      'Estado de resultados sin calcular',
      expect.objectContaining({
        code: 'REPORT_TOO_LARGE',
        venueName: expect.any(String),
        from: FILTERS.from,
        to: FILTERS.to,
        ms: expect.any(Number),
      }),
    )
  })

  it('🔴 fallo 1 de la ronda 6 · una venta que pasa un tope detiene el reporte con su folio y su id en el log; no hay cifras', async () => {
    orden('o1', [{ id: 'p1', amount: 116, type: 'REGULAR' }])
    ;(recorrerLibros as jest.Mock).mockRejectedValueOnce(
      new ValidationError('La venta F-1 tiene demasiados renglones…', 'REPORT_TOO_LARGE', { motivo: 'ORDEN', orderId: 'o1', folio: 'F-1' }),
    )
    await expect(getIncomeStatement(VENUE, FILTERS)).rejects.toMatchObject({ code: 'REPORT_TOO_LARGE', details: { folio: 'F-1' } })
    expect(logger.warn).toHaveBeenCalledWith(
      'Estado de resultados sin calcular',
      expect.objectContaining({ details: expect.objectContaining({ orderId: 'o1' }) }),
    )
  })

  it('🔴 Codex r5 R5-8, r6 R6-4 · la transacción EMPEZÓ, corrió su primer lote y Prisma la cerró: REPORT_TIMEOUT con el mensaje de la respuesta 14, sin cifras a medias', async () => {
    muchas(LOTE_DE_ORDENES + 2)
    ;(recorrerLibros as jest.Mock)
      .mockImplementationOnce((recorrerLibros as jest.Mock).getMockImplementation()!) // el primer lote sí corre
      .mockImplementationOnce(async () => {
        throw P2028() // al pedir el segundo, Prisma ya cerró la transacción por tiempo
      })
    const e = await getIncomeStatement(VENUE, FILTERS).catch(x => x)
    expect(e).toBeInstanceOf(ServiceUnavailableError)
    expect(e).toMatchObject({
      statusCode: 503,
      code: 'REPORT_TIMEOUT',
      message: 'El periodo es muy grande para calcularlo de una vez; elige un rango más corto.',
    })
    expect(recorrerLibros).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(
      'Estado de resultados sin calcular',
      expect.objectContaining({ code: 'REPORT_TIMEOUT', msEjecucion: expect.any(Number) }),
    )
  })

  it('🔴 Codex r6 R6-4 · un P2028 de ADQUISICIÓN pasa tal cual aunque haya pasado más que un tiempo máximo corto: el callback nunca empezó', async () => {
    let ahora = 1_000_000
    const reloj = jest.spyOn(Date, 'now').mockImplementation(() => ahora)
    p.$transaction.mockImplementationOnce(async () => {
      ahora += 2_000 // esperó el pool 2 s…
      throw new Prisma.PrismaClientKnownRequestError('Transaction API error: Unable to start a transaction in the given time.', {
        code: 'P2028',
        clientVersion: 'prueba',
      })
    })
    const e = await getIncomeStatement(VENUE, FILTERS, { tiempoMaximoMs: 1_000, maxOrdenes: MAX_ORDENES_POR_REPORTE }).catch(x => x)
    reloj.mockRestore()
    expect(e).toBeInstanceOf(Prisma.PrismaClientKnownRequestError) // …con un límite de 1 s, y aun así no es REPORT_TIMEOUT
    expect(e.code).toBe('P2028')
    expect(recorrerLibros).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('🔴 Codex r7 R7-5 · un P2028 DESPUÉS de empezar que no es vencimiento (transacción ya confirmada) pasa tal cual', async () => {
    muchas(2)
    ;(recorrerLibros as jest.Mock).mockRejectedValueOnce(P2028Confirmada())
    const e = await getIncomeStatement(VENUE, FILTERS).catch(x => x)
    expect(e).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect(e.message).toMatch(/committed transaction/)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  // T8-B (Tarea 8, 7-oct): con consultas concurrentes (el Resumen en el tope), el vencimiento puede llegar como este otro P2028.
  const P2028NoEncontrada = () =>
    new Prisma.PrismaClientKnownRequestError(
      "Transaction API error: Transaction not found. Transaction ID is invalid, refers to an old closed transaction Prisma doesn't have information about anymore, or was obtained before disconnecting.",
      { code: 'P2028', clientVersion: 'prueba' },
    )
  /** Un reloj que sólo avanza cuando la prueba lo dice: `empezo` se toma en el callback y el error llega `ms` después. */
  const relojFijo = () => {
    const r = { ahora: 5_000_000 }
    const espia = jest.spyOn(Date, 'now').mockImplementation(() => r.ahora)
    return { r, restaurar: () => espia.mockRestore() }
  }
  const LIMITE_CORTO = { tiempoMaximoMs: 1_000, maxOrdenes: MAX_ORDENES_POR_REPORTE }

  it('🔴 T8-B · «Transaction not found» cuando la foto EMPEZÓ y ya pasó su tiempo máximo: REPORT_TIMEOUT con el texto del reporte, no un 500', async () => {
    const { r, restaurar } = relojFijo()
    muchas(2)
    ;(recorrerLibros as jest.Mock).mockImplementationOnce(async () => {
      r.ahora += LIMITE_CORTO.tiempoMaximoMs // justo en el límite, medido desde que corrió el callback
      throw P2028NoEncontrada()
    })
    const e = await getIncomeStatement(VENUE, FILTERS, LIMITE_CORTO).catch(x => x)
    restaurar()
    expect(e).toBeInstanceOf(ServiceUnavailableError)
    expect(e).toMatchObject({
      statusCode: 503,
      code: 'REPORT_TIMEOUT',
      message: 'El periodo es muy grande para calcularlo de una vez; elige un rango más corto.',
    })
    expect(logger.warn).toHaveBeenCalledWith(
      'Estado de resultados sin calcular',
      expect.objectContaining({ code: 'REPORT_TIMEOUT', msEjecucion: LIMITE_CORTO.tiempoMaximoMs }),
    )
  })

  it('🔴 T8-B · la foto del ISR que vence con «Transaction not found» da REPORT_TIMEOUT con el texto MENSUAL', async () => {
    const { r, restaurar } = relojFijo()
    const e = await conFotoDeReporte(
      {
        venueName: 'X',
        from: '2026-01-01',
        to: '2026-12-31',
        tiempoMaximoMs: TIEMPO_MAXIMO_DEL_ISR_MS,
        mensajeDeTiempo: MENSAJE_MES_NO_CALCULADO,
      },
      async () => {
        r.ahora += TIEMPO_MAXIMO_DEL_ISR_MS + 250 // los meses corrieron más que el límite del ISR
        throw P2028NoEncontrada()
      },
    ).catch(x => x)
    restaurar()
    expect(e).toMatchObject({ statusCode: 503, code: 'REPORT_TIMEOUT', message: MENSAJE_MES_NO_CALCULADO })
    expect(p.$transaction.mock.calls.at(-1)![1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: TIEMPO_MAXIMO_DEL_ISR_MS,
    })
  })

  it('control · T8-B, R7-5 · «Transaction not found» ANTES del tiempo máximo pasa tal cual (cae si se quita la guarda del reloj: sabotaje)', async () => {
    const { r, restaurar } = relojFijo()
    muchas(2)
    ;(recorrerLibros as jest.Mock).mockImplementationOnce(async () => {
      r.ahora += LIMITE_CORTO.tiempoMaximoMs - 1 // un milisegundo antes del límite
      throw P2028NoEncontrada()
    })
    const e = await getIncomeStatement(VENUE, FILTERS, LIMITE_CORTO).catch(x => x)
    restaurar()
    expect(e).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect(e.message).toMatch(/Transaction not found/)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('control · «Transaction not found» de una transacción que nunca EMPEZÓ pasa tal cual aunque haya pasado más que el límite', async () => {
    const { r, restaurar } = relojFijo()
    p.$transaction.mockImplementationOnce(async () => {
      r.ahora += 2 * LIMITE_CORTO.tiempoMaximoMs
      throw P2028NoEncontrada()
    })
    const e = await getIncomeStatement(VENUE, FILTERS, LIMITE_CORTO).catch(x => x)
    restaurar()
    expect(e).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect(recorrerLibros).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('control · «expired transaction» se traduce como hoy: basta que la foto haya empezado (lo dice Prisma, no el reloj)', async () => {
    const { restaurar } = relojFijo() // el reloj no avanza: 0 ms desde que empezó
    muchas(2)
    ;(recorrerLibros as jest.Mock).mockRejectedValueOnce(P2028())
    const e = await getIncomeStatement(VENUE, FILTERS, LIMITE_CORTO).catch(x => x)
    restaurar()
    expect(e).toMatchObject({ statusCode: 503, code: 'REPORT_TIMEOUT' })
  })

  it('🔴 fallo 1 de la ronda 8 · la foto del ISR vence con el texto MENSUAL (conFotoDeReporte, el mismo camino)', async () => {
    p.$transaction.mockImplementationOnce(async (fn: (tx: typeof p) => unknown) => {
      await fn(p) // el callback corrió…
      throw P2028() // …y la transacción expiró
    })
    const e = await conFotoDeReporte(
      { venueName: 'X', from: '2026-01-01', to: '2026-11-30', tiempoMaximoMs: 300_000, mensajeDeTiempo: MENSAJE_MES_NO_CALCULADO },
      async () => 1,
    ).catch(x => x)
    expect(e).toMatchObject({ statusCode: 503, code: 'REPORT_TIMEOUT', message: MENSAJE_MES_NO_CALCULADO })
    expect(p.$transaction.mock.calls.at(-1)![1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 300_000,
    })
  })

  it('control · la cancelación del freno del MCP pasa tal cual: ni se traduce ni se avisa como reporte grande', async () => {
    muchas(2)
    ;(recorrerLibros as jest.Mock).mockRejectedValueOnce(new RequestCancelledError('client-closed'))
    await expect(getIncomeStatement(VENUE, FILTERS)).rejects.toBeInstanceOf(RequestCancelledError)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  // ─── Ajustes del controlador (6-oct) ───
  it('🔴 ruling M3 (revisión T3) · una devolución de $0 tras una devolución aproximada NO sube el contador: su IVA es 0, no aproximado', async () => {
    const desconocido = { provenance: 'MANUAL', refundedItems: [{ orderItemId: 'oi-x', quantity: 1, amountCents: 10000 }] }
    orden('o1', [
      { id: 'p1', amount: 216, type: 'REGULAR' },
      { id: 'r1', amount: -100, type: 'REFUND', processorData: desconocido }, // aproximada: el artículo no es de la orden
      { id: 'r2', amount: 0, type: 'REFUND', processorData: { provenance: 'MANUAL' } }, // hereda `aproximada`, pero vale $0
    ])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.metrics).toMatchObject({ salesCount: 1, refundCount: 2 })
    expect(r.revenue.movimientosConIvaAproximado).toBe(1)
    expect(r.fiscalRevenue.movimientosConIvaAproximado).toBe(1)
  })

  it('🔴 ruling M3 · tampoco cuenta un cobro de $0 de una orden con composición aproximada', async () => {
    // $30 de cabecera sin reparto con dos IVA ⇒ composición aproximada: el cobro de $186 cuenta; el de $0, no.
    orden(
      'o1',
      [
        { id: 'p1', amount: 186, type: 'REGULAR' },
        { id: 'p2', amount: 0, type: 'REGULAR' },
      ],
      [linea(), grano()],
      { discountAmount: 30, orderDiscounts: [{ amount: 30, reparto: null }] },
    )
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.metrics.salesCount).toBe(2)
    expect(r.revenue.movimientosConIvaAproximado).toBe(1)
    expect(r.fiscalRevenue.movimientosConIvaAproximado).toBe(1)
  })

  it('🔴 rulings T2-I1 y T3-I1 · una orden rota de un solo producto al 0 % (composición vacía y aproximada) va al 0 % y se CUENTA', async () => {
    orden(
      'o1',
      [{ id: 'p1', amount: 30, type: 'REGULAR' }],
      [linea({ id: 'oi-grano', unitPrice: 100, total: 30, discountAmount: 50, product: { taxRate: 0, ivaTratamiento: 'IVA_0' } })],
    )
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue).toMatchObject({ grossSalesCents: 3000, ivaCents: 0, tasa0BaseCents: 3000, movimientosConIvaAproximado: 1 })
  })

  it('la lectura se mide por petición: un logger.debug con órdenes, consultas y filas (la medición de la Tarea 8)', async () => {
    muchas(3)
    ;(recorrerLibros as jest.Mock).mockResolvedValueOnce({ consultas: 7, filas: 40 })
    await getIncomeStatement(VENUE, FILTERS)
    expect(logger.debug).toHaveBeenCalledWith(
      'Estado de resultados calculado',
      expect.objectContaining({
        venueName: expect.any(String),
        from: FILTERS.from,
        to: FILTERS.to,
        ordenes: 3,
        consultas: 8,
        filasLeidas: 43,
        ms: expect.any(Number),
      }),
    )
  })
})

describe('B4b · el Resumen y Bancos suman en la base (Codex r1 P2 #7; r3 R3-5)', () => {
  it('🔴 no leen los cobros del periodo: una sola suma agrupada por método y tipo, con el negocio del cobro Y el de la orden', async () => {
    await getBankAndCashSummary('venue-1', FILTERS)
    expect(p.payment.findMany).not.toHaveBeenCalled()
    expect(p.payment.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['method', 'type'],
        where: expect.objectContaining({
          venueId: 'venue-1',
          status: TransactionStatus.COMPLETED,
          order: { venueId: 'venue-1', status: { not: OrderStatus.CANCELLED } },
        }),
      }),
    )
  })

  // La suma en la base conserva lo de antes (ajustes del controlador): la devolución suma monto y propina, pero no conteo ni comisión;
  // un cobro sin tipo (legado) es venta. Las devoluciones de `ROWS` y de la foto de 4b no traen comisión: éstas sí, para que se vea.
  it('control — una devolución CON comisión no suma comisión ni conteo; sí resta su monto y su propina', async () => {
    sembrar([
      { amount: 100, tipAmount: 10, type: PaymentType.REGULAR, method: PaymentMethod.CREDIT_CARD, feeAmount: 3 },
      { amount: -30, tipAmount: -2, type: PaymentType.REFUND, method: PaymentMethod.CREDIT_CARD, feeAmount: 0.9 },
    ])
    const r = await getBankAndCashSummary('venue-1', FILTERS)
    expect(r.accounts).toEqual([
      { key: 'card', kind: 'bank', methods: ['CREDIT_CARD'], inflowCents: 7000, tipCents: 800, count: 1 }, // 100 − 30 · 10 − 2
    ])
    expect(r.totals.feesCents).toBe(300) // la comisión de la venta; la de la devolución (0.90) no suma
    expect(r.totals.netToBankCents).toBe(7500) // 7000 + 800 − 300
  })

  it('control — un cobro sin tipo (legado, `type = null`) es venta: entra, cuenta y suma su comisión', async () => {
    sembrar([
      { amount: 100, tipAmount: 0, type: PaymentType.REGULAR, method: PaymentMethod.DEBIT_CARD, feeAmount: 3 },
      { amount: 50, tipAmount: 5, type: null, method: PaymentMethod.DEBIT_CARD, feeAmount: 1 },
    ])
    const r = await getBankAndCashSummary('venue-1', FILTERS)
    expect(r.accounts).toEqual([{ key: 'card', kind: 'bank', methods: ['DEBIT_CARD'], inflowCents: 15000, tipCents: 500, count: 2 }])
    expect(r.totals.feesCents).toBe(400) // 3 + 1
  })
})
