/**
 * IVA por producto, bloque B4b (spec planes 6-7 §4.9, D17, H20; Codex B4b r1, r2) — los reportes con la reconstrucción de la factura y
 * el libro de cada orden, contra Postgres REAL. La foto de dinero «todo al 16 %» vive en `iva4b.reportes.test.ts` y no se toca.
 */
import { Prisma, PaymentMethod, type PaymentType } from '@prisma/client'

import type { McpScope } from '@/mcp/scope'
import { registerAccountingTools } from '@/mcp/tools/accounting'
import { runWithContext, type RequestCancellation } from '@/observability/executionContext'
import * as contabilidad from '@/services/dashboard/accounting.dashboard.service'
import { getBankAndCashSummary, getBusinessSummary, getIncomeStatement } from '@/services/dashboard/accounting.dashboard.service'
import { getIsrProvisional } from '@/services/fiscal/isr.service'
import * as libros from '@/services/fiscal/librosDeOrdenes'
import { leerReparto } from '@/services/shared/repartoDescuento'
import { RequestCancelledError } from '@/utils/requestCancellation'
import prisma from '@/utils/prismaClient'
import { conProducto, limpiarNegocios, nuevoNegocio, type Negocio } from './exclusionContable.fixtures'

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/(avoqado_[a-z0-9]+_test_|av_db_25_iva_test)/.test(database.pathname)) {
  throw new Error(
    'Esta suite escribe negocios de prueba: exige una base local propia (avoqado_<x>_test_… o av_db_25_iva_test), nunca av-db-25.',
  )
}

// Las herramientas del MCP se llaman directo: el guardia y el plan no son lo que se prueba aquí (tienen sus suites). (B4b, Tarea 6)
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: { in: [v] } }), requirePermission: jest.fn() }),
}))

jest.setTimeout(120_000)

const CUANDO = new Date('2026-06-15T18:00:00.000Z') // 12:00 en la Ciudad de México: dentro de junio de 2026
const MAYO = new Date('2026-05-15T18:00:00.000Z')
const minutos = (m: number, desde = CUANDO) => new Date(desde.getTime() + m * 60_000)
const JUNIO = { from: '2026-06-01', to: '2026-06-30' }
let n = 0

type Renglon = { productId: string; precio: string; total?: string; peso?: string; cantidad?: number }

/** Una orden con su cabecera de descuento; cada renglón con su total (por defecto, precio × cantidad). Devuelve su id y los de sus renglones. */
async function orden(venueId: string, renglones: Renglon[], descuentoCabecera = '0') {
  const o = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `B4B-${++n}-${Date.now()}`,
      subtotal: 0,
      taxAmount: 0,
      total: 0,
      discountAmount: new Prisma.Decimal(descuentoCabecera),
    },
  })
  const items: string[] = []
  for (const r of renglones) {
    const cantidad = r.cantidad ?? 1
    const it = await prisma.orderItem.create({
      data: {
        orderId: o.id,
        productId: r.productId,
        productName: 'Producto',
        quantity: cantidad,
        unitPrice: new Prisma.Decimal(r.precio),
        weightQuantity: r.peso ? new Prisma.Decimal(r.peso) : undefined,
        taxAmount: 0,
        total: r.total ? new Prisma.Decimal(r.total) : new Prisma.Decimal(r.precio).times(cantidad),
      },
    })
    items.push(it.id)
  }
  return { id: o.id, items }
}

/** Una fila de descuento de la cuenta; `reparto` null = fila de antes del reparto guardado (D8). */
const descuento = (orderId: string, pesos: string, reparto: Prisma.InputJsonValue | null) =>
  prisma.orderDiscount.create({
    data: {
      orderId,
      type: 'FIXED_AMOUNT',
      name: 'Descuento',
      value: new Prisma.Decimal(pesos),
      amount: new Prisma.Decimal(pesos),
      ...(reparto ? { reparto } : {}),
    },
  })
const dirigido = (renglones: Record<string, number>) => ({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones })

type OpcionesDeCobro = { metodo?: PaymentMethod; type?: PaymentType; processorData?: Prisma.InputJsonValue; cuando?: Date }
/** Los datos de un cobro COMPLETED (pesos; una devolución va en negativo). */
const datosDeCobro = (venueId: string, orderId: string, monto: string, p: OpcionesDeCobro = {}) => ({
  venueId,
  orderId,
  createdAt: p.cuando ?? CUANDO,
  amount: new Prisma.Decimal(monto),
  tipAmount: new Prisma.Decimal('0'),
  netAmount: new Prisma.Decimal(monto),
  method: p.metodo ?? ('CREDIT_CARD' as const),
  status: 'COMPLETED' as const,
  type: p.type ?? ('REGULAR' as const),
  splitType: 'FULLPAYMENT' as const,
  source: 'TPV' as const,
  feePercentage: 0,
  feeAmount: new Prisma.Decimal('0'),
  processorData: p.processorData,
})
const pagar = (venueId: string, orderId: string, monto: string, p: OpcionesDeCobro = {}) =>
  prisma.payment.create({ data: datosDeCobro(venueId, orderId, monto, p) })

/** Un negocio con la bandera encendida, un café al 16 % (`conProducto`) y un grano al 0 %. */
async function negocioMixto(): Promise<{ x: Negocio; cafe: string; grano: string }> {
  const x = await nuevoNegocio({ contabilidad: false })
  const { categoryId, productId: cafe } = await conProducto(x)
  const grano = (
    await prisma.product.create({
      data: { venueId: x.venueId, categoryId, sku: `GRANO-${x.rfc}`, name: 'Grano', price: 100, ivaTratamiento: 'IVA_0' },
    })
  ).id
  return { x, cafe, grano }
}
/** La forma EXACTA que escribe `issueRefund` por artículos (la fija caracterizacionIssueRefund.integration.test.ts). */
const porArticulo = (orderItemId: string, cents: number, productId: string, original: string, quantity = 1) => ({
  provenance: 'MANUAL',
  originalPaymentId: original,
  refundedItems: [{ orderItemId, quantity, amountCents: cents, amount: cents / 100, productName: 'Grano', productId }],
})

/** Las herramientas contables del MCP de un negocio; devuelve una función que llama una y parsea su JSON. (Igual que en `iva4b.reportes.test.ts`.) */
function herramientas(venueId: string, organizationId: string) {
  const mapa = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
  const scope = { staffId: 's1', activeOrg: organizationId, allowedVenueIds: [venueId], perVenueAccess: new Map() } as McpScope
  registerAccountingTools({ tool: (...a: unknown[]) => mapa.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
  return async (nombre: string, args: Record<string, unknown>) =>
    JSON.parse((await mapa.get(nombre)!({ venueId, ...args }, {})).content[0].text)
}

afterAll(() => limpiarNegocios())

describe('B4b · el extra de un artículo al 0 % pesa en su tasa (H12)', () => {
  let x: Negocio
  beforeAll(async () => {
    const m = await negocioMixto()
    x = m.x
    // Café $116 al 16 % + grano de $50 con $50 de extra (leche de almendra) al 0 %: el renglón del grano cobró $100.
    const o = await orden(x.venueId, [
      { productId: m.cafe, precio: '116.00' },
      { productId: m.grano, precio: '50.00', total: '100.00' },
    ])
    await pagar(x.venueId, o.id, '216.00')
  })
  // 16 %: 11600 ⇒ base 10000 + IVA 1600 · 0 %: 10000. Con el peso viejo (precio × cantidad) el IVA salía 2082.
  it('🔴 IVA 1600 y base a tasa 0 % de 10000, en lo gerencial y en lo fiscal', async () => {
    const r = await getIncomeStatement(x.venueId, JUNIO)
    for (const v of [r.revenue, r.fiscalRevenue]) {
      expect(v).toMatchObject({
        grossSalesCents: 21600,
        ivaCents: 1600,
        taxableBaseCents: 20000,
        tasa0BaseCents: 10000,
        ingresosSinIvaCents: 20000,
        movimientosConIvaAproximado: 0,
      })
      expect(v.taxByRate).toEqual({ '0.16': 1600 })
    }
  })
})

describe('B4b · lo guardado se respeta y sólo lo que no consta se aproxima (Codex r1 P1 #3, Review Focus 3)', () => {
  let x: Negocio
  beforeAll(async () => {
    const m = await negocioMixto()
    x = m.x
    const o = await orden(
      x.venueId,
      [
        { productId: m.cafe, precio: '116.00' },
        { productId: m.grano, precio: '100.00' },
      ],
      '30.00',
    )
    await descuento(o.id, '20.00', dirigido({ [o.items[1]]: 2000 }))
    await descuento(o.id, '10.00', null)
    await pagar(x.venueId, o.id, '186.00')
  })
  // Pesos café 11600 · grano 8000 ⇒ 18600 se reparte 11008 / 7592; café base 9490 + IVA 1518. (Sin respetar lo guardado: 1378 / 8611.)
  it('🔴 IVA 1518, base a tasa 0 % 7592 y la venta contada como aproximada', async () => {
    const r = await getIncomeStatement(x.venueId, JUNIO)
    expect(r.revenue).toMatchObject({
      grossSalesCents: 18600,
      ivaCents: 1518,
      taxableBaseCents: 17082,
      tasa0BaseCents: 7592,
      movimientosConIvaAproximado: 1,
    })
  })

  it('🔴 las herramientas del MCP lo dicen: un movimiento con IVA aproximado (estado de resultados, resumen e IVA en flujo)', async () => {
    const mcp = herramientas(x.venueId, x.organizationId)
    const e = await mcp('accounting_income_statement', JUNIO)
    expect(e.ingresos).toMatchObject({ ivaTrasladado: 15.18, baseTasa0: 75.92, movimientosConIvaAproximado: 1 })
    expect(e.ingresoFiscal).toMatchObject({ movimientosConIvaAproximado: 1 })
    expect((await mcp('accounting_business_summary', JUNIO)).ingresos).toMatchObject({ movimientosConIvaAproximado: 1 })
    expect(await mcp('accounting_iva_cashflow', { period: '2026-06' })).toMatchObject({ movimientosConIvaAproximado: 1, baseTasa0: 75.92 })
  })
})

describe('B4b · la venta por peso pesa su total (H12)', () => {
  let x: Negocio
  beforeAll(async () => {
    const m = await negocioMixto()
    x = m.x
    // Café $116 + 0.5 kg de grano a $400/kg (cantidad 1, total $200, como lo guarda el POS).
    const o = await orden(x.venueId, [
      { productId: m.cafe, precio: '116.00' },
      { productId: m.grano, precio: '400.00', peso: '0.500', total: '200.00' },
    ])
    await pagar(x.venueId, o.id, '316.00')
  })
  it('🔴 IVA 1600 y base a tasa 0 % de 20000', async () => {
    const r = await getIncomeStatement(x.venueId, JUNIO)
    expect(r.revenue).toMatchObject({ grossSalesCents: 31600, ivaCents: 1600, taxableBaseCents: 30000, tasa0BaseCents: 20000 })
  })
})

describe('B4b · tres cobros de $72 dan el IVA de $216 (Codex r1 P1 #4, Review Focus 1)', () => {
  let x: Negocio
  beforeAll(async () => {
    const m = await negocioMixto()
    x = m.x
    const o = await orden(x.venueId, [
      { productId: m.cafe, precio: '116.00' },
      { productId: m.grano, precio: '100.00' },
    ])
    for (const k of [1, 2, 3]) await pagar(x.venueId, o.id, '72.00', { cuando: minutos(k) })
  })
  it('🔴 IVA 1600 y base a tasa 0 % 10000 (por cobro daban 1599 y 9999)', async () => {
    const r = await getIncomeStatement(x.venueId, JUNIO)
    expect(r.revenue).toMatchObject({ grossSalesCents: 21600, ivaCents: 1600, taxableBaseCents: 20000, tasa0BaseCents: 10000 })
  })
})

describe('B4b · H20, respuesta 3 y las cantidades: artículos, luego importe; un artículo devuelto de más; una de dos unidades (Codex r2 N2)', () => {
  let x: Negocio
  let y: Negocio
  let z: Negocio
  beforeAll(async () => {
    const m = await negocioMixto()
    x = m.x
    // X · venta $216; devuelve el grano por artículo ($100) y luego $50 por importe.
    const o = await orden(x.venueId, [
      { productId: m.cafe, precio: '116.00' },
      { productId: m.grano, precio: '100.00' },
    ])
    const venta = await pagar(x.venueId, o.id, '216.00')
    await pagar(x.venueId, o.id, '-100.00', {
      type: 'REFUND',
      cuando: minutos(1),
      processorData: porArticulo(o.items[1], 10000, m.grano, venta.id),
    })
    await pagar(x.venueId, o.id, '-50.00', {
      type: 'REFUND',
      cuando: minutos(2),
      processorData: { provenance: 'MANUAL', originalPaymentId: venta.id },
    })
    // Y · descuento de $20 guardado sobre el grano (cobró $80); el escritor devuelve $100 por él (refund.dashboard.service.ts:861).
    const n2 = await negocioMixto()
    y = n2.x
    const o2 = await orden(
      y.venueId,
      [
        { productId: n2.cafe, precio: '116.00' },
        { productId: n2.grano, precio: '100.00' },
      ],
      '20.00',
    )
    await descuento(o2.id, '20.00', dirigido({ [o2.items[1]]: 2000 }))
    const venta2 = await pagar(y.venueId, o2.id, '196.00')
    await pagar(y.venueId, o2.id, '-100.00', {
      type: 'REFUND',
      cuando: minutos(1),
      processorData: porArticulo(o2.items[1], 10000, n2.grano, venta2.id),
    })
    // Z · dos granos de $100 con $40 de descuento guardado (cada uno cobró $80); se devuelve UNO, y el escritor devuelve $100.
    const n3 = await negocioMixto()
    z = n3.x
    const o3 = await orden(
      z.venueId,
      [
        { productId: n3.cafe, precio: '116.00' },
        { productId: n3.grano, precio: '100.00', cantidad: 2 },
      ],
      '40.00',
    )
    await descuento(o3.id, '40.00', dirigido({ [o3.items[1]]: 4000 }))
    const venta3 = await pagar(z.venueId, o3.id, '276.00')
    await pagar(z.venueId, o3.id, '-100.00', {
      type: 'REFUND',
      cuando: minutos(1),
      processorData: porArticulo(o3.items[1], 10000, n3.grano, venta3.id),
    })
  })

  // Queda del café $66 (base 5690 + IVA 910); del grano, nada. Antes: base al 0 % −2315 e IVA 1230.
  it('🔴 artículos y luego importe: el importe sale del 16 %; la base al 0 % queda en 0, nunca negativa', async () => {
    const r = await getIncomeStatement(x.venueId, JUNIO)
    expect(r.revenue).toMatchObject({
      grossSalesCents: 21600,
      refundsCents: 15000,
      ivaCents: 910,
      taxableBaseCents: 5690,
      tasa0BaseCents: 0,
    })
    expect(r.revenue.ingresosSinIvaCents! + r.revenue.ivaCents).toBe(r.revenue.netRevenueCents)
  })

  // $80 del grano y $20 del café (queda 9600: base 8276 + IVA 1324). Antes: base al 0 % −2000.
  it('🔴 Review Focus 2 · el artículo devuelto de más: su tasa hasta lo que cobró, lo demás de lo que queda, y se cuenta', async () => {
    const r = await getIncomeStatement(y.venueId, JUNIO)
    expect(r.revenue).toMatchObject({
      grossSalesCents: 19600,
      refundsCents: 10000,
      ivaCents: 1324,
      taxableBaseCents: 8276,
      tasa0BaseCents: 0,
      movimientosConIvaAproximado: 1,
    })
  })

  // $80 del 0 % (lo que cobró esa unidad) y $20 de lo que queda: 1184 del café y 816 del grano ⇒ café 8979 + 1437, grano 7184.
  // La v2 sacaba los $100 del 0 % y dejaba el IVA en 1600.
  it('🔴 Codex r2 N2 · una de dos unidades: tope en lo que cobró esa unidad, y se cuenta', async () => {
    const r = await getIncomeStatement(z.venueId, JUNIO)
    expect(r.revenue).toMatchObject({
      grossSalesCents: 27600,
      refundsCents: 10000,
      ivaCents: 1437,
      taxableBaseCents: 16163,
      tasa0BaseCents: 7184,
      movimientosConIvaAproximado: 1,
    })
  })
})

describe('B4b · la incertidumbre de mayo llega a la devolución de junio (Codex r2 N8)', () => {
  let x: Negocio
  beforeAll(async () => {
    const m = await negocioMixto()
    x = m.x
    const o = await orden(x.venueId, [
      { productId: m.cafe, precio: '116.00' },
      { productId: m.grano, precio: '100.00' },
    ])
    const venta = await pagar(x.venueId, o.id, '216.00', { cuando: MAYO })
    // Mayo: una devolución por un artículo que no es de la orden (va por importe, aproximada). Junio: $50 por importe.
    await pagar(x.venueId, o.id, '-100.00', {
      type: 'REFUND',
      cuando: minutos(1, MAYO),
      processorData: porArticulo('oi-que-no-existe', 10000, m.grano, venta.id),
    })
    await pagar(x.venueId, o.id, '-50.00', { type: 'REFUND', processorData: { provenance: 'MANUAL', originalPaymentId: venta.id } })
  })
  // r2: 16 % −2315 − 370 · 0 % −2315. Un mes con flujo negativo legítimo, y la devolución contada como aproximada.
  it('🔴 junio sólo lleva su devolución, con el saldo que dejó mayo, y la cuenta como aproximada', async () => {
    const r = await getIncomeStatement(x.venueId, JUNIO)
    expect(r.revenue).toMatchObject({
      grossSalesCents: 0,
      refundsCents: 5000,
      ivaCents: -370,
      taxableBaseCents: -4630,
      tasa0BaseCents: -2315,
      movimientosConIvaAproximado: 1,
    })
    // Codex r5 R5-10: un mes sólo con devoluciones NO es «sin movimientos»: lo distinguen salesCount y refundCount (Tareas 6 y 7).
    expect(r.metrics).toMatchObject({ salesCount: 0, refundCount: 1 })
  })
})

describe('B4b · 502 órdenes a la misma hora en dos páginas, una con dos cobros: cada orden una sola vez (Codex r1 P2 #7; r2 N6; r3 R3-2; Review Focus 4)', () => {
  let x: Negocio
  let y: Negocio
  beforeAll(async () => {
    const m = await negocioMixto()
    x = m.x
    // 501 órdenes de un cobro de $1.16 y una de dos cobros de $116 (renglón de $232): 502 órdenes ⇒ páginas de 500 y de 2.
    const ordenes = await prisma.order.createManyAndReturn({
      data: Array.from({ length: 501 }, (_, i) => ({
        venueId: x.venueId,
        orderNumber: `B4B-P-${i}-${Date.now()}`,
        subtotal: 0,
        taxAmount: 0,
        total: 0,
      })),
      select: { id: true },
    })
    await prisma.payment.createMany({ data: ordenes.map(o => datosDeCobro(x.venueId, o.id, '1.16')) })
    const doble = await orden(x.venueId, [{ productId: m.cafe, precio: '116.00', cantidad: 2 }])
    await pagar(x.venueId, doble.id, '116.00', { cuando: minutos(1) })
    await pagar(x.venueId, doble.id, '116.00', { cuando: minutos(2) })
    const otro = await negocioMixto()
    y = otro.x
    const deY = await orden(y.venueId, [{ productId: otro.cafe, precio: '1.16' }])
    await prisma.payment.createMany({ data: Array.from({ length: 10 }, () => datosDeCobro(y.venueId, deY.id, '1.16')) })
  })
  // Sabotaje: quitar el GROUP BY de la enumeración ⇒ la orden de dos cobros se suma dos veces. Las 501 de importe libre: 116 ⇒ IVA 16 cada una (8016);
  // la doble: 23200 ⇒ IVA 3200. Total 81316 de venta y 11216 de IVA.
  it('las 503 ventas con su IVA exacto, y nada del otro negocio', async () => {
    const r = await getIncomeStatement(x.venueId, JUNIO)
    expect(r.metrics.salesCount).toBe(503)
    expect(r.revenue).toMatchObject({ grossSalesCents: 81316, ivaCents: 11216 })
    expect((await getIncomeStatement(y.venueId, JUNIO)).metrics.salesCount).toBe(10)
  })
})

describe('B4b · un cobro de otro negocio ligado a una orden de éste no entra a ningún reporte (Codex r2 N7, r3 R3-5; respuesta 9)', () => {
  let x: Negocio
  let y: Negocio
  beforeAll(async () => {
    const m = await negocioMixto()
    x = m.x
    y = (await negocioMixto()).x
    const o = await orden(x.venueId, [{ productId: m.cafe, precio: '116.00' }])
    await pagar(x.venueId, o.id, '116.00')
    await pagar(y.venueId, o.id, '116.00', { cuando: minutos(1) }) // dato inconsistente: el cobro dice Y, la orden es de X
  })
  it('🔴 X sólo ve su cobro; Y no suma el cobro de una orden que no es suya', async () => {
    const rx = await getIncomeStatement(x.venueId, JUNIO)
    expect(rx.revenue).toMatchObject({ grossSalesCents: 11600, ivaCents: 1600 })
    expect(rx.metrics.salesCount).toBe(1)
    expect((await getIncomeStatement(y.venueId, JUNIO)).metrics.salesCount).toBe(0)
  })
  it('🔴 Codex r3 R3-5 · tampoco entra al Resumen ni a Bancos de Y; los de X sólo ven su cobro', async () => {
    const [sy, by] = [await getBusinessSummary(y.venueId, JUNIO), await getBankAndCashSummary(y.venueId, JUNIO)]
    expect(sy.revenue.grossSalesCents).toBe(0)
    expect(sy.collection.electronicCents).toBe(0)
    expect(by.totals.electronicInflowCents).toBe(0)
    const [sx, bx] = [await getBusinessSummary(x.venueId, JUNIO), await getBankAndCashSummary(x.venueId, JUNIO)]
    expect(sx.collection.electronicCents).toBe(11600)
    expect(bx.totals.electronicInflowCents).toBe(11600)
  })
})

/** Como el freno del MCP la arma (patrón de `freno-transacciones.integration.test.ts`): una unidad cancelable, con su cupo. */
function unidad() {
  const controller = new AbortController()
  const u: RequestCancellation = {
    signal: controller.signal,
    hasWritten: false,
    refused: false,
    activeWork: 0,
    onIdle: jest.fn(),
    cancel: reason => controller.abort(reason),
  }
  return u
}
const enUnidad = <T>(u: RequestCancellation, fn: () => Promise<T>) =>
  runWithContext({ correlationId: 'b4b-freno', source: 'http', entrypoint: 'POST /mcp prueba', cancellation: u }, fn)
/** Ninguna transacción del reporte quedó abierta (se revirtió y la conexión volvió al pool). Espera hasta 2 s. */
async function sinTransaccionesAbiertas() {
  for (let i = 0; i < 20; i++) {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`
    if (n === 0) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('quedó una transacción abierta')
}
/** 501 órdenes de importe libre de $1.16: dos lotes (500 + 1). */
async function negocioDeDosLotes(): Promise<Negocio> {
  const { x } = await negocioMixto()
  const ordenes = await prisma.order.createManyAndReturn({
    data: Array.from({ length: 501 }, (_, i) => ({
      venueId: x.venueId,
      orderNumber: `B4B-L-${i}-${Date.now()}`,
      subtotal: 0,
      taxAmount: 0,
      total: 0,
    })),
    select: { id: true },
  })
  await prisma.payment.createMany({ data: ordenes.map(o => datosDeCobro(x.venueId, o.id, '1.16')) })
  return x
}

describe('B4b · los dos extremos del periodo, en sesión UTC y en America/Mexico_City (Codex r5 R5-2)', () => {
  let x: Negocio
  const INICIO = new Date('2026-06-01T06:00:00.000Z') // 1-jun 00:00:00.000 en la Ciudad de México
  const FIN = new Date('2026-07-01T05:59:59.999Z') // 30-jun 23:59:59.999
  const NOCHE = new Date('2026-07-01T03:00:00.000Z') // 30-jun 21:00: la que se perdía sin utcTs en una sesión de CDMX
  const todas: string[] = [] // las cinco órdenes, también las de afuera
  beforeAll(async () => {
    const m = await negocioMixto()
    x = m.x
    for (const [cuando, monto] of [
      [new Date('2026-06-01T05:59:59.999Z'), '1.00'], // 31-may: fuera
      [INICIO, '1.16'],
      [NOCHE, '2.32'],
      [FIN, '3.48'],
      [new Date('2026-07-01T06:00:00.000Z'), '1.00'], // 1-jul: fuera
    ] as const) {
      const o = await orden(x.venueId, [{ productId: m.cafe, precio: monto }])
      todas.push(o.id)
      await pagar(x.venueId, o.id, monto, { cuando })
    }
  })

  it('🔴 fallo 2 de la ronda 8 (Codex r7 R7-2) · el ORM y el SQL explicado ven los MISMOS cobros y órdenes en los dos extremos, en las dos sesiones', async () => {
    // El ORM manda el cierre como `timestamp` (el tipo de la columna); el SQL propio lo pasa por utcTs. Si los tipos de enlace
    // cambiaran, en la sesión de CDMX se movería seis horas uno de los dos.
    for (const zona of ['UTC', 'America/Mexico_City']) {
      const { movimientosOrm, movimientosSql, ordenesOrm, ordenesSql } = await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zona}'`)
        const vistos: Array<{ id: string; orderId: string }> = []
        await libros.recorrerLibros(tx, { venueId: x.venueId, orderIds: todas, hasta: FIN }, m => {
          if (m.createdAt >= INICIO) vistos.push({ id: m.id, orderId: m.orderId }) // lo que el reporte sumaría del periodo
        })
        const enSql = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT p.id FROM "Payment" p
          WHERE p."venueId" = ${x.venueId} AND p.status = 'COMPLETED'
            AND p."createdAt" >= (${INICIO} AT TIME ZONE 'UTC') AND p."createdAt" <= (${FIN} AT TIME ZONE 'UTC')
          ORDER BY p.id`
        const enumeradas = await tx.$queryRaw<Array<{ orderId: string }>>(libros.sqlDeOrdenesDelPeriodo(x.venueId, INICIO, FIN, 10))
        return {
          movimientosOrm: vistos.map(v => v.id).sort(),
          movimientosSql: enSql.map(r => r.id).sort(), // el mismo orden en JS: la intercalación de la base no entra
          ordenesOrm: [...new Set(vistos.map(v => v.orderId))].sort(),
          ordenesSql: enumeradas.map(r => r.orderId).sort(),
        }
      })
      expect(movimientosOrm).toEqual(movimientosSql)
      expect(ordenesOrm).toEqual(ordenesSql)
      expect(ordenesSql).toHaveLength(3) // INICIO, NOCHE y FIN; nunca el 31-may ni el 1-jul
    }
  })

  it('🔴 la enumeración EXACTA del reporte da las mismas tres órdenes en las dos sesiones', async () => {
    const enSesion = (zona: string) =>
      prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zona}'`)
        return (await tx.$queryRaw<Array<{ orderId: string }>>(libros.sqlDeOrdenesDelPeriodo(x.venueId, INICIO, FIN, 10))).length
      })
    expect(await enSesion('UTC')).toBe(3)
    expect(await enSesion('America/Mexico_City')).toBe(3)
  })

  it('🔴 y el reporte de junio suma las tres, con los dos extremos dentro', async () => {
    const r = await getIncomeStatement(x.venueId, JUNIO)
    expect(r.metrics.salesCount).toBe(3)
    expect(r.revenue.grossSalesCents).toBe(116 + 232 + 348)
  })
})

describe('B4b · la orden más grande que se permite se compone entera; una de más detiene el reporte (fallo 1 de la ronda 6; Codex r5 R5-1)', () => {
  let x: Negocio
  let y: Negocio
  beforeAll(async () => {
    const m = await negocioMixto()
    x = m.x
    // Café $116 + grano $100 con $100 de descuento DIRIGIDO al grano + renglones de $0 hasta el tope de 2,000. Cobro $116.
    const o = await orden(
      x.venueId,
      [
        { productId: m.cafe, precio: '116.00' },
        { productId: m.grano, precio: '100.00' },
      ],
      '100.00',
    )
    await prisma.orderItem.createMany({
      data: Array.from({ length: libros.TOPES_POR_ORDEN.renglones - 2 }, () => ({
        orderId: o.id,
        productId: m.cafe,
        productName: 'Cero',
        quantity: 1,
        unitPrice: 0,
        taxAmount: 0,
        total: 0,
      })),
    })
    await descuento(o.id, '100.00', dirigido({ [o.items[1]]: 10000 }))
    await pagar(x.venueId, o.id, '116.00')
    const n = await negocioMixto()
    y = n.x
    const o2 = await orden(y.venueId, [{ productId: n.cafe, precio: '116.00' }])
    await prisma.orderItem.createMany({
      data: Array.from({ length: libros.TOPES_POR_ORDEN.renglones }, () => ({
        orderId: o2.id,
        productId: n.cafe,
        productName: 'Cero',
        quantity: 1,
        unitPrice: 0,
        taxAmount: 0,
        total: 0,
      })),
    })
    await pagar(y.venueId, o2.id, '116.00')
  })

  it('🔴 en el tope: IVA $16.00 exacto (en la v5, modo resumen: $8.59), sin aproximar', async () => {
    const r = await getIncomeStatement(x.venueId, JUNIO)
    expect(r.revenue).toMatchObject({
      grossSalesCents: 11600,
      ivaCents: 1600,
      taxableBaseCents: 10000,
      tasa0BaseCents: 0,
      movimientosConIvaAproximado: 0,
    })
  })

  it('🔴 un renglón de más: REPORT_TOO_LARGE con el folio de la venta; ninguna cifra', async () => {
    const e = await getIncomeStatement(y.venueId, JUNIO).catch(x => x)
    expect(e).toMatchObject({ statusCode: 422, code: 'REPORT_TOO_LARGE', details: { motivo: 'ORDEN', excede: ['renglones'] } })
    expect(e.message).toMatch(/^La venta B4B-/)
  })
})

describe('B4b · una devolución voluminosa: sólo se leen los cuatro campos; con un artículo de más, se detiene (Codex r5 R5-5)', () => {
  let x: Negocio
  let y: Negocio
  beforeAll(async () => {
    const m = await negocioMixto()
    x = m.x
    const o = await orden(x.venueId, [
      { productId: m.cafe, precio: '116.00' },
      { productId: m.grano, precio: '100.00' },
    ])
    const venta = await pagar(x.venueId, o.id, '216.00')
    // 500 artículos (el tope): el grano por $100 y 499 del café por $0; y un texto de 1 MB que el reporte nunca debe leer.
    const refundedItems = [
      { orderItemId: o.items[1], quantity: 1, amountCents: 10000 },
      ...Array.from({ length: libros.TOPES_POR_ORDEN.articulosPorDevolucion - 1 }, () => ({
        orderItemId: o.items[0],
        quantity: 1,
        amountCents: 0,
      })),
    ]
    await pagar(x.venueId, o.id, '-100.00', {
      type: 'REFUND',
      cuando: minutos(1),
      processorData: { provenance: 'MANUAL', originalPaymentId: venta.id, recibo: 'x'.repeat(1_000_000), refundedItems },
    })
    const n = await negocioMixto()
    y = n.x
    const o2 = await orden(y.venueId, [{ productId: n.cafe, precio: '116.00' }])
    const venta2 = await pagar(y.venueId, o2.id, '116.00')
    await pagar(y.venueId, o2.id, '-1.00', {
      type: 'REFUND',
      cuando: minutos(1),
      processorData: {
        provenance: 'MANUAL',
        originalPaymentId: venta2.id,
        refundedItems: Array.from({ length: libros.TOPES_POR_ORDEN.articulosPorDevolucion + 1 }, () => ({
          orderItemId: o2.items[0],
          quantity: 1,
          amountCents: 0,
        })),
      },
    })
  })

  it('🔴 en el tope de artículos: H20 sigue exacto (baja sólo el 0 %)', async () => {
    const r = await getIncomeStatement(x.venueId, JUNIO)
    expect(r.revenue).toMatchObject({ refundsCents: 10000, ivaCents: 1600, tasa0BaseCents: 0, movimientosConIvaAproximado: 0 })
  })

  it('🔴 un artículo de más en una devolución: REPORT_TOO_LARGE con su folio', async () => {
    await expect(getIncomeStatement(y.venueId, JUNIO)).rejects.toMatchObject({
      code: 'REPORT_TOO_LARGE',
      details: { excede: ['articulosPorDevolucion'] },
    })
  })
})

describe('B4b · el freno del MCP corta después del primer lote: sin respuesta, transacción revertida y cupo libre (Codex r5 R5-3)', () => {
  let x: Negocio
  beforeAll(async () => {
    x = await negocioDeDosLotes()
  })
  afterEach(() => jest.restoreAllMocks())

  it('🔴 una corrida completa dentro de una unidad del MCP no marca escritura: cada consulta del reporte es lectura para el freno real', async () => {
    const u = unidad()
    const r = await enUnidad(u, () => getIncomeStatement(x.venueId, JUNIO))
    expect(r.metrics.salesCount).toBe(501)
    expect(u.hasWritten).toBe(false)
    expect(u.activeWork).toBe(0)
  })

  it.each([
    ['vence el plazo', () => new RequestCancelledError('timeout', 25_000)],
    ['el cliente se fue', () => new RequestCancelledError('client-closed')],
  ])('🔴 %s después del primer lote', async (_caso, motivo) => {
    const u = unidad()
    const real = libros.recorrerLibros
    const espia = jest.spyOn(libros, 'recorrerLibros').mockImplementationOnce(async (...a) => {
      const r = await real(...a)
      u.cancel!(motivo())
      return r
    })
    const e = await enUnidad(u, () => getIncomeStatement(x.venueId, JUNIO)).catch(err => err)
    expect(e).toBeInstanceOf(RequestCancelledError)
    // El segundo lote se negó en su PRIMERA lectura: no leyó ni sumó nada.
    expect(espia).toHaveBeenCalledTimes(2)
    await expect(espia.mock.results[1].value).rejects.toBeInstanceOf(RequestCancelledError)
    expect(u.hasWritten).toBe(false)
    expect(u.activeWork).toBe(0) // la transacción terminó y el cupo de la persona quedó libre
    expect(u.onIdle).toHaveBeenCalled()
    await sinTransaccionesAbiertas()
    expect((await getIncomeStatement(x.venueId, JUNIO)).metrics.salesCount).toBe(501) // la conexión volvió al pool
  })
})

describe('B4b · el tiempo máximo de verdad: REPORT_TIMEOUT, transacción cerrada y nada a medias (respuesta 14; Codex r5 R5-8)', () => {
  let x: Negocio
  beforeAll(async () => {
    x = await negocioDeDosLotes()
  })
  afterEach(() => jest.restoreAllMocks())

  it('🔴 Codex r6 R6-4 · el primer lote CORRE (y termina antes de vencer), luego se tarda: REPORT_TIMEOUT con el mensaje y la conexión libre', async () => {
    const real = libros.recorrerLibros
    let primerLote: { consultas: number; filas: number } | null = null
    jest.spyOn(libros, 'recorrerLibros').mockImplementationOnce(async (...a) => {
      const r = await real(...a)
      primerLote = r // terminó con la transacción viva: el vencimiento llega DESPUÉS, no en la adquisición
      await new Promise(resolve => setTimeout(resolve, 2_000))
      return r
    })
    const e = await getIncomeStatement(x.venueId, JUNIO, { tiempoMaximoMs: 1_000, maxOrdenes: libros.MAX_ORDENES_POR_REPORTE }).catch(
      err => err,
    )
    expect(primerLote).not.toBeNull()
    expect(primerLote!.consultas).toBeGreaterThan(0)
    expect(e).toMatchObject({
      statusCode: 503,
      code: 'REPORT_TIMEOUT',
      message: 'El periodo es muy grande para calcularlo de una vez; elige un rango más corto.',
    })
    await sinTransaccionesAbiertas()
    expect((await getIncomeStatement(x.venueId, JUNIO)).metrics.salesCount).toBe(501)
  })

  it('🔴 Codex r6 R6-4 · control de adquisición: con el pool lleno, el P2028 de «Unable to start» pasa tal cual aunque el límite de ejecución sea corto', async () => {
    // Justo cuando el reporte pide SU transacción (ya leyó el negocio y el emisor), 40 transacciones dormidas ocupan el pool (más que
    // el `connection_limit` de la prueba, 18; si fuera mayor, se sube a ese número + 2). Espera su `maxWait` (2 s, el de Prisma) y no
    // consigue conexión: su callback nunca corre. El P2028 es el de Prisma, no un doble.
    let bloqueadores: Array<Promise<unknown>> = []
    const original = prisma.$transaction.bind(prisma)
    jest.spyOn(prisma, '$transaction').mockImplementationOnce((async (...args: Parameters<typeof prisma.$transaction>) => {
      // `pg_sleep` devuelve `void`, que Prisma no sabe leer: cada bloqueador duerme dentro de un SELECT con una columna entera.
      bloqueadores = Array.from({ length: 40 }, () =>
        original(async tx => tx.$queryRaw`SELECT 1 AS n FROM pg_sleep(6)`, { timeout: 20_000, maxWait: 60_000 }),
      )
      await new Promise(resolve => setTimeout(resolve, 500))
      return original(...args)
    }) as typeof prisma.$transaction)
    const espia = jest.spyOn(libros, 'recorrerLibros')
    try {
      const e = await getIncomeStatement(x.venueId, JUNIO, { tiempoMaximoMs: 1, maxOrdenes: libros.MAX_ORDENES_POR_REPORTE }).catch(
        err => err,
      )
      expect(e).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
      expect(e).toMatchObject({ code: 'P2028' })
      expect(e.message).toMatch(/Unable to start a transaction/)
      expect(espia).not.toHaveBeenCalled()
    } finally {
      // Los bloqueadores sólo llenan el pool: los que pasan del `connection_limit` esperan más que el `pool_timeout` (10 s) y fallan
      // al pedir conexión. Su desenlace no es lo que se prueba; se espera a que terminen todos —también si una aserción falló, para
      // que sus errores no caigan en otra prueba— y se comprueba que nada quedó abierto.
      await Promise.allSettled(bloqueadores)
    }
    await sinTransaccionesAbiertas()
  })
  // (Si el cliente extendido no deja espiar `$transaction`, el control de adquisición se queda en la unitaria del Paso 3, que usa el
  // mensaje real de Prisma; se dice en el reporte de la tarea.)
})

describe('B4b · un descuento dirigido a 10,000 productos sobre una orden de un renglón: exacto, y su ámbito nunca llega a Node (fallo 1 de la ronda 7; Codex r6 R6-1)', () => {
  let x: Negocio
  let ordenId: string
  beforeAll(async () => {
    const m = await negocioMixto()
    x = m.x
    // Café $116 con 10 % dirigido ($11.60), escrito como lo escribe el motor: con TODOS los productos del descuento en su ámbito.
    const o = await orden(x.venueId, [{ productId: m.cafe, precio: '116.00' }], '11.60')
    ordenId = o.id
    await descuento(o.id, '11.60', {
      v: 1,
      alcance: 'DIRIGIDO',
      conPromociones: null,
      espejo: false,
      renglones: { [o.items[0]]: 1160 },
      ambito: { productos: Array.from({ length: 10_000 }, (_, i) => `producto-${i}`), categorias: [] },
    })
    await pagar(x.venueId, o.id, '104.40')
  })

  it('🔴 el descuento conocido se respeta (ni truncado ni aproximado): IVA 14.40 sobre $104.40', async () => {
    const r = await getIncomeStatement(x.venueId, JUNIO)
    expect(r.revenue).toMatchObject({ grossSalesCents: 10440, ivaCents: 1440, taxableBaseCents: 9000, movimientosConIvaAproximado: 0 })
  })

  it('🔴 guardado pesa más de 100 KB; proyectado, menos de 1 KB, y eso es lo que cuenta el tope', async () => {
    const [{ guardado }] = await prisma.$queryRaw<Array<{ guardado: number }>>`
      SELECT octet_length(reparto::text)::int AS guardado FROM "OrderDiscount" WHERE "orderId" = ${ordenId}`
    expect(guardado).toBeGreaterThan(100_000)
    const [c] = await prisma.$queryRaw<Array<{ bytesDeRepartos: number }>>(
      libros.sqlDelConteo(x.venueId, [ordenId], new Date('2026-07-01T05:59:59.999Z')),
    )
    expect(c.bytesDeRepartos).toBeLessThan(1_000)
    const [d] = await prisma.$queryRaw<Array<{ reparto: Record<string, unknown> }>>(libros.sqlDeLosDescuentos([ordenId]))
    expect(d.reparto.ambito).toEqual({ productos: [], categorias: [] })
  })
})

describe('B4b · la proyección del reparto decide lo mismo que el reparto completo (fallo 1 de la ronda 7)', () => {
  it('🔴 leerReparto: misma validez, mismos renglones y mismo espejo en 33 formas (con escalares donde va una lista: R7-3)', async () => {
    const { x, cafe } = await negocioMixto()
    const o = await orden(x.venueId, [{ productId: cafe, precio: '116.00' }])
    const dir = (r: Record<string, unknown> = {}) => ({
      v: 1,
      alcance: 'DIRIGIDO',
      conPromociones: null,
      espejo: false,
      renglones: { [o.items[0]]: 1160 },
      ...r,
    })
    const cuenta = (r: Record<string, unknown> = {}) => ({
      v: 1,
      alcance: 'CUENTA',
      conPromociones: false,
      espejo: false,
      renglones: { [o.items[0]]: 500 },
      ...r,
    })
    const sin = (r: Record<string, unknown>, llave: string) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== llave))
    const formas: unknown[] = [
      dir(),
      dir({ ambito: { productos: Array.from({ length: 10_000 }, (_, i) => `p${i}`), categorias: [] } }),
      dir({ ambito: { productos: ['a', 3], categorias: [] } }),
      dir({ ambito: [] }),
      dir({ ambito: { productos: [] } }),
      dir({ ambito: { productos: 3, categorias: [] } }),
      dir({ ambito: null }),
      sin(dir(), 'conPromociones'),
      dir({ base: [] }),
      dir({ base: null }),
      cuenta(),
      cuenta({ base: ['a', 'b'] }),
      cuenta({ base: ['a', 2] }),
      cuenta({ base: 'a' }),
      cuenta({ base: 7 }),
      cuenta({ ambito: { productos: [], categorias: [] } }),
      cuenta({ espejo: true }),
      dir({ tope: null }),
      dir({ tope: 50 }),
      dir({ tope: -1 }),
      dir({ reduceImpuesto: 'sí' }),
      dir({ reduceImpuesto: true }),
      dir({ basura: 'x'.repeat(200_000) }),
      dir({ renglones: { r: -1 } }),
      dir({ renglones: [1] }),
      sin(dir(), 'renglones'),
      dir({ v: 2 }),
      dir({ espejo: 'no' }),
      dir({ alcance: 'OTRO' }),
      [1, 2],
      'x',
      null,
    ]
    for (const forma of formas) {
      const fila = await prisma.orderDiscount.create({
        data: {
          orderId: o.id,
          type: 'FIXED_AMOUNT',
          name: 'Forma',
          value: 1,
          amount: 1,
          reparto: forma === null ? Prisma.JsonNull : (forma as Prisma.InputJsonValue),
        },
      })
      const [d] = await prisma.$queryRaw<Array<{ reparto: unknown }>>(libros.sqlDeLosDescuentos([o.id])) // es la única fila de la orden
      const completo = leerReparto(forma)
      const proyectado = leerReparto(d.reparto)
      expect(proyectado === null).toBe(completo === null)
      if (completo)
        expect({ renglones: proyectado!.renglones, espejo: proyectado!.espejo }).toEqual({
          renglones: completo.renglones,
          espejo: completo.espejo,
        })
      await prisma.orderDiscount.delete({ where: { id: fila.id } })
    }
    // Y la fila sin reparto (columna NULL): las dos lecturas dicen «sin reparto».
    const vacia = await prisma.orderDiscount.create({ data: { orderId: o.id, type: 'FIXED_AMOUNT', name: 'Sin', value: 1, amount: 1 } })
    const [d] = await prisma.$queryRaw<Array<{ reparto: unknown }>>(libros.sqlDeLosDescuentos([o.id]))
    expect(leerReparto(d.reparto)).toBeNull()
    await prisma.orderDiscount.delete({ where: { id: vacia.id } })
  })
})

describe('B4b · el ISR acumulado corre todos sus meses en UNA foto: un cambio de IVA a media consulta no lo descuadra (fallo 1 de la ronda 8; Codex r7 R7-1)', () => {
  let x: Negocio
  let cafe: string
  beforeAll(async () => {
    const m = await negocioMixto()
    x = m.x
    cafe = m.cafe
    // Venta de $116 al 16 % en enero (renglón sin sellar: usa el tratamiento del producto) y su devolución completa en febrero.
    const o = await orden(x.venueId, [{ productId: cafe, precio: '116.00' }])
    const venta = await pagar(x.venueId, o.id, '116.00', { cuando: new Date('2026-01-15T18:00:00.000Z') })
    await pagar(x.venueId, o.id, '-116.00', {
      type: 'REFUND',
      cuando: new Date('2026-02-15T18:00:00.000Z'),
      processorData: { provenance: 'MANUAL', originalPaymentId: venta.id },
    })
  })
  afterEach(() => jest.restoreAllMocks())

  it('🔴 el producto pasa a 0 % ENTRE enero y febrero (otra sesión, ya confirmado): enero +$100, febrero −$100, acumulado $0, nunca −$16', async () => {
    const real = contabilidad.estadoDeResultadosEnFoto
    jest.spyOn(contabilidad, 'estadoDeResultadosEnFoto').mockImplementationOnce(async (...a) => {
      const enero = await real(...a)
      await prisma.product.update({ where: { id: cafe }, data: { ivaTratamiento: 'IVA_0' } }) // fuera de la foto del ISR
      return enero
    })
    const r = await getIsrProvisional(x.venueId, '2026-02', 'RESICO')
    expect(r.ingresosAcumCents).toBe(0) // con una foto por mes (la v7) daba −1600
    expect(r.ingresosMesCents).toBe(-10000) // febrero, con el 16 % que vio la foto
    // Y un ISR pedido DESPUÉS ya lee el 0 % en los dos meses: también $0, también consistente.
    expect((await getIsrProvisional(x.venueId, '2026-02', 'RESICO')).ingresosAcumCents).toBe(0)
  })

  it('🔴 el EMISOR cambia entre enero y febrero (efectivo: de dentro a fuera de la contabilidad, ya confirmado): acumulado $0, nunca +$100 (Codex r8 R8-2)', async () => {
    // Venta y devolución en EFECTIVO de $116: cuentan sólo con `includeCashInAccounting` encendido en la foto.
    // Tarea 6 (desviación medida): `negocioMixto` no crea emisor, y sin emisor el efectivo queda fuera siempre (`?? false`): los dos
    // `updateMany` no tocaban nada y la prueba pasaba también con el sabotaje (l). Se crea el emisor y se exige que cada cambio lo toque.
    await prisma.fiscalEmisor.create({
      data: { venueId: x.venueId, rfc: x.rfc, legalName: 'Negocio de prueba', regimenFiscal: '601', lugarExpedicion: '01000' },
    })
    expect((await prisma.fiscalEmisor.updateMany({ where: { venueId: x.venueId }, data: { includeCashInAccounting: true } })).count).toBe(1)
    const o2 = await orden(x.venueId, [{ productId: cafe, precio: '116.00' }])
    const v2 = await pagar(x.venueId, o2.id, '116.00', { metodo: PaymentMethod.CASH, cuando: new Date('2026-01-16T18:00:00.000Z') })
    await pagar(x.venueId, o2.id, '-116.00', {
      metodo: PaymentMethod.CASH,
      type: 'REFUND',
      cuando: new Date('2026-02-16T18:00:00.000Z'),
      processorData: { provenance: 'MANUAL', originalPaymentId: v2.id },
    })
    const real = contabilidad.estadoDeResultadosEnFoto
    let apagados = 0
    jest.spyOn(contabilidad, 'estadoDeResultadosEnFoto').mockImplementationOnce(async (...a) => {
      const enero = await real(...a)
      apagados = (await prisma.fiscalEmisor.updateMany({ where: { venueId: x.venueId }, data: { includeCashInAccounting: false } })).count // fuera de la foto
      return enero
    })
    const r = await getIsrProvisional(x.venueId, '2026-02', 'RESICO')
    expect(apagados).toBe(1) // el cambio sí ocurrió a media consulta
    // Leer el emisor con `prisma` dejaría la venta de enero y quitaría la devolución: +11600 (el café ya está al 0 % por la prueba
    // anterior; +10000 si esta prueba corre sola).
    expect(r.ingresosAcumCents).toBe(0)
  })
})
