/**
 * IVA por producto, plan 4b — los reportes con el IVA de cada renglón, contra Postgres REAL.
 *
 * FOTO DE DINERO (principio rector v3; Ruling 4b-R14): con TODOS los renglones en IVA_16 y la bandera APAGADA —el estado de
 * producción—, el estado de resultados, el resumen del negocio, el IVA de flujo, el ISR y las cuatro herramientas contables del
 * MCP dan EXACTAMENTE los números de e0d69b49, en CADA campo de dinero (ceros y null incluidos). Se escribió y se puso
 * en verde ANTES de tocar la lógica; las tareas siguientes la corren sin cambiarla. Si una literal no coincide contra
 * e0d69b49, el error es de la cuenta a mano: se corrige la literal, nunca el código.
 */
import { Prisma, type IvaTratamiento, type PaymentMethod, type PaymentType } from '@prisma/client'

import type { McpScope } from '@/mcp/scope'
import { registerAccountingTools } from '@/mcp/tools/accounting'
import { getBusinessSummary, getIncomeStatement } from '@/services/dashboard/accounting.dashboard.service'
import { getIsrProvisional } from '@/services/fiscal/isr.service'
import { getIvaCashflow } from '@/services/fiscal/ivaFlujo.service'
import prisma from '@/utils/prismaClient'
import { conProducto, limpiarNegocios, nuevoNegocio, type Negocio } from './exclusionContable.fixtures'

// Las herramientas del MCP se llaman directo: el guardia y el plan no son lo que se prueba aquí (tienen sus suites).
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: { in: [v] } }), requirePermission: jest.fn() }),
}))

jest.setTimeout(120_000)

const CUANDO = new Date('2026-06-15T18:00:00.000Z') // 12:00 en la Ciudad de México: dentro de junio de 2026
const JUNIO = { from: '2026-06-01', to: '2026-06-30' }
let n = 0

/** Una orden con sus renglones (`null` = sin producto). Devuelve su id y los ids de sus renglones, en orden. */
async function orden(venueId: string, renglones: Array<[productId: string | null, precio: string, cantidad?: number]>) {
  const o = await prisma.order.create({
    data: { venueId, orderNumber: `4B-${++n}-${Date.now()}`, subtotal: 0, taxAmount: 0, total: 0 },
  })
  const items: string[] = []
  for (const [productId, precio, cantidad = 1] of renglones) {
    const it = await prisma.orderItem.create({
      data: {
        orderId: o.id,
        productId: productId ?? undefined,
        productName: productId ? 'Producto' : 'Importe libre',
        quantity: cantidad,
        unitPrice: new Prisma.Decimal(precio),
        taxAmount: 0,
        total: new Prisma.Decimal(precio).times(cantidad),
      },
    })
    items.push(it.id)
  }
  return { id: o.id, items }
}

/** Un cobro COMPLETED en CUANDO (pesos; una devolución va en negativo). */
const pagar = (
  venueId: string,
  orderId: string,
  monto: string,
  p: { metodo?: PaymentMethod; type?: PaymentType; propina?: string; comision?: string; processorData?: Prisma.InputJsonValue } = {},
) =>
  prisma.payment.create({
    data: {
      venueId,
      orderId,
      createdAt: CUANDO,
      amount: new Prisma.Decimal(monto),
      tipAmount: new Prisma.Decimal(p.propina ?? '0'),
      netAmount: new Prisma.Decimal(monto),
      method: p.metodo ?? 'CREDIT_CARD',
      status: 'COMPLETED',
      type: p.type ?? 'REGULAR',
      splitType: 'FULLPAYMENT',
      source: 'TPV',
      feePercentage: 0,
      feeAmount: new Prisma.Decimal(p.comision ?? '0'),
      processorData: p.processorData,
    },
  })

/** Las herramientas contables del MCP de un negocio; devuelve una función que llama una y parsea su JSON. */
function herramientas(venueId: string, organizationId: string) {
  const mapa = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
  const scope = { staffId: 's1', activeOrg: organizationId, allowedVenueIds: [venueId], perVenueAccess: new Map() } as McpScope
  registerAccountingTools({ tool: (...a: unknown[]) => mapa.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
  return async (nombre: string, args: Record<string, unknown>) =>
    JSON.parse((await mapa.get(nombre)!({ venueId, ...args }, {})).content[0].text)
}

afterAll(() => limpiarNegocios())

describe('foto de dinero: todo al 16 % y la bandera apagada dan los números de e0d69b49', () => {
  let x: Negocio
  let mcp: ReturnType<typeof herramientas>

  beforeAll(async () => {
    x = await nuevoNegocio({ contabilidad: false })
    const categoryId = (
      await prisma.menuCategory.create({ data: { venueId: x.venueId, name: 'Foto', slug: `foto-${x.rfc}`.toLowerCase() } })
    ).id
    const cafe = (await prisma.product.create({ data: { venueId: x.venueId, categoryId, sku: `F-${x.rfc}`, name: 'Café', price: 116 } })).id

    // 1 · tarjeta: café + un renglón sin producto (todo 16 %: 17400 ⇒ base 15000, IVA 2400), propina 10, comisión 3; y una
    //     devolución MANUAL de 58 (mezcla de la orden: base 5000, IVA 800).
    const o1 = await orden(x.venueId, [
      [cafe, '116.00'],
      [null, '58.00'],
    ])
    const p1 = await pagar(x.venueId, o1.id, '174.00', { propina: '10.00', comision: '3.00' })
    await pagar(x.venueId, o1.id, '-58.00', { type: 'REFUND', processorData: { provenance: 'MANUAL', originalPaymentId: p1.id } })
    // 2 · efectivo 232 (base 20000, IVA 3200): fuera de lo fiscal (sin emisor no hay opt-in del efectivo).
    const o2 = await orden(x.venueId, [[cafe, '116.00', 2]])
    await pagar(x.venueId, o2.id, '232.00', { metodo: 'CASH' })
    // 3 · débito de importe libre 99.99 (sin renglones ⇒ 16 %: base 8620, IVA 1379), comisión 1.50; y un cobro de PRUEBA.
    const o3 = await orden(x.venueId, [])
    await pagar(x.venueId, o3.id, '99.99', { metodo: 'DEBIT_CARD', comision: '1.50' })
    await pagar(x.venueId, o3.id, '5.00', { metodo: 'CASH', type: 'TEST' })
    // 4 · reparto: venta 232 (base 20000, IVA 3200) y un ajuste del proveedor de 116 en la forma VIEJA del mapa (IVA 1600).
    const o4 = await orden(x.venueId, [[cafe, '116.00', 2]])
    const p4 = await pagar(x.venueId, o4.id, '232.00', { metodo: 'OTHER' })
    await pagar(x.venueId, o4.id, '-116.00', {
      metodo: 'OTHER',
      type: 'REFUND',
      processorData: { provenance: 'PROVIDER_ADJUSTMENT', originalPaymentId: p4.id, generation: 1, fiscalByRateCents: { '0.16': 1600 } },
    })
    mcp = herramientas(x.venueId, x.organizationId)
  })

  // Gerencial: bruto 73799 · devoluciones 17400 · base 63620 − 15000 = 48620 · IVA 10179 − 2400 = 7779.
  // Fiscal (sin el efectivo): bruto 50599 · base 28620 · IVA 4579.
  it('estado de resultados, gerencial y fiscal', async () => {
    const r = await getIncomeStatement(x.venueId, JUNIO)
    expect(r.revenue).toMatchObject({
      grossSalesCents: 73799,
      refundsCents: 17400,
      netRevenueCents: 56399,
      taxableBaseCents: 48620,
      ivaCents: 7779,
    })
    expect(r.revenue.taxByRate).toEqual({ '0.16': 7779 })
    expect(r.fiscalRevenue).toMatchObject({
      grossSalesCents: 50599,
      refundsCents: 17400,
      netRevenueCents: 33199,
      taxableBaseCents: 28620,
      ivaCents: 4579,
    })
    expect(r.fiscalRevenue.taxByRate).toEqual({ '0.16': 4579 })
    expect(r.tips).toEqual({ totalCents: 1000 })
    expect(r.metrics).toEqual({ salesCount: 4, refundCount: 2, averageTicketCents: 18450 })
    expect(r.taxRateAssumed).toBe(0.16)
  })

  // Cobro: tarjeta 17400 + 9999 − 5800 = 21599; otro 23200 − 11600 = 11600; efectivo 23200 (41 %). Comisiones 450.
  it('resumen del negocio', async () => {
    const r = await getBusinessSummary(x.venueId, JUNIO)
    expect(r.revenue).toMatchObject({
      grossSalesCents: 73799,
      refundsCents: 17400,
      netRevenueCents: 56399,
      taxableBaseCents: 48620,
      ivaCents: 7779,
    })
    expect(r.invoicing).toEqual({
      stampedCount: 0,
      stampedTotalCents: 0,
      nominativeCount: 0,
      globalCount: 0,
      invoicedApproxCents: 0,
      uninvoicedApproxCents: 56399,
      invoicedPct: 0,
    })
    expect(r.revenue.taxByRate).toEqual({ '0.16': 7779 })
    expect(r.collection).toEqual({ cashCents: 23200, electronicCents: 33199, cashPct: 41 })
    expect(r.costs).toEqual({ processingFeesCents: 450 })
    expect(r.result).toEqual({ netAfterFeesCents: 55949, cogsCents: 0, grossProfitCents: 56399 })
    expect(r.tips).toEqual({ totalCents: 1000 })
    expect(r.metrics).toEqual({ salesCount: 4, refundCount: 2, averageTicketCents: 18450 })
    expect(r.reconciliation).toEqual({ statements: 0, lineCount: 0, matchedCount: 0 })
  })

  it('IVA de flujo del RFC', async () => {
    const r = await getIvaCashflow(x.venueId, '2026-06')
    // Sin captura del contador: la retención de ventas y el saldo aplicado son null (no cero); lo retenido a terceros, 0.
    expect(r).toMatchObject({
      baseGravableCents: 28620,
      ivaTrasladadoCobradoCents: 4579,
      ivaAmparadoPorCfdiCents: 0,
      cfdiCount: 0,
      acreditablePagadoCents: 0,
      retencionesCents: null,
      ivaRetenidoTercerosCents: 0,
      saldoAFavorAplicadoCents: null,
      ivaAPagarPreliminarCents: 4579,
      saldoAFavorDelPeriodoCents: 0,
      zeroActivity: false,
    })
    expect(r.ivaTrasladadoPorTasaCents).toEqual({ '0.16': 4579 })
  })

  // RESICO: 28620 × 1 % = 286; las deducciones, el costo de ventas, la depreciación y las pérdidas no aplican (0).
  // GENERAL: sin gastos, inventario, activos ni pérdidas ⇒ utilidad = ingreso; tarifa art. 96 acumulada a 6 meses,
  // renglón 1: (28620 − 6) × 1.92 % = 549; los meses previos no tienen ingreso ⇒ pagos previos 0. Sin retención capturada: 0.
  it('ISR provisional, RESICO y GENERAL', async () => {
    const ceros = { deduccionesAcumCents: 0, costoVentasAcumCents: 0, deduccionInversionesAcumCents: 0, perdidasFiscalesAplicadaCents: 0 }
    expect(await getIsrProvisional(x.venueId, '2026-06', 'RESICO')).toMatchObject({
      ingresosMesCents: 28620,
      ingresosAcumCents: 28620,
      ...ceros,
      utilidadFiscalCents: 0,
      tasaResico: 0.01,
      isrCausadoCents: 286,
      pagosProvisionalesPreviosCents: 0,
      retencionesIsrCents: 0,
      isrAPagarCents: 286,
      excedeTopeResico: false,
      zeroActivity: false,
    })
    expect(await getIsrProvisional(x.venueId, '2026-06', 'GENERAL')).toMatchObject({
      ingresosMesCents: 28620,
      ingresosAcumCents: 28620,
      ...ceros,
      utilidadFiscalCents: 28620,
      tasaResico: null,
      isrCausadoCents: 549,
      pagosProvisionalesPreviosCents: 0,
      retencionesIsrCents: 0,
      isrAPagarCents: 549,
      zeroActivity: false,
    })
  })

  it('las cuatro herramientas contables del MCP, en pesos', async () => {
    const ingresos = { ventasBrutas: 737.99, devoluciones: 174, ingresoNeto: 563.99, baseGravable: 486.2, ivaTrasladado: 77.79 }
    const e = await mcp('accounting_income_statement', JUNIO)
    expect(e.ingresos).toMatchObject(ingresos)
    expect(e.ingresos.ivaPorTasa).toEqual({ '16%': 77.79 })
    expect(e.ingresoFiscal).toMatchObject({ ingresoNeto: 331.99, baseGravable: 286.2, ivaTrasladado: 45.79 })
    expect(e.ingresoFiscal.ivaPorTasa).toEqual({ '16%': 45.79 })
    expect(e).toMatchObject({ ivaRateAssumed: 0.16, propinas: 10, metricas: { ventas: 4, devoluciones: 2, ticketPromedio: 184.5 } })

    const s = await mcp('accounting_business_summary', JUNIO)
    expect(s.ingresos).toMatchObject(ingresos)
    expect(s.ingresos.ivaPorTasa).toEqual({ '16%': 77.79 })
    expect(s).toMatchObject({
      facturacion: { cfdisTimbrados: 0, nominativos: 0, globales: 0, totalFacturado: 0, sinFacturar: 563.99, porcentajeFacturado: 0 },
      cobro: { efectivo: 232, electronico: 331.99, porcentajeEfectivo: 41 },
      comisiones: 4.5,
      ingresoMenosComisiones: 559.49,
      costoDeVentas: 0,
      utilidadBruta: 563.99,
      propinas: 10,
      conciliacionBancaria: { estadosDeCuenta: 0, movimientos: 0, conciliados: 0 },
      metricas: { ventas: 4, devoluciones: 2, ticketPromedio: 184.5 },
    })

    const f = await mcp('accounting_iva_cashflow', { period: '2026-06' })
    expect(f).toMatchObject({
      ok: true,
      localesIncluidos: 1,
      ivaTrasladadoCobrado: 45.79,
      baseGravable: 286.2,
      ivaAmparadoPorCfdiContraste: 0,
      ivaAcreditablePagado: 0,
      ivaRetenidoAProveedores: 0,
      ivaAPagarPreliminar: 45.79,
      saldoAFavorDelPeriodo: 0,
      sinVentasRecuerdaDeclararEnCeros: false,
    })
    expect(f.ivaTrasladadoPorTasa).toEqual({ '16%': 45.79 })

    expect(await mcp('isr_provisional', { period: '2026-06' })).toMatchObject({
      ok: true,
      regimen: 'RESICO',
      ingresosDelMes: 286.2,
      ingresosAcumulados: 286.2,
      tasaResico: 0.01,
      excedeTopeResico: false,
      isrCausado: 2.86,
      retencionesIsrVentas: 0,
      isrAPagarEstimado: 2.86,
      sinVentas: false,
    })
    // GENERAL completo: cada campo de dinero de la respuesta, ceros incluidos.
    expect(await mcp('isr_provisional', { period: '2026-06', regime: 'GENERAL' })).toMatchObject({
      ok: true,
      regimen: 'GENERAL',
      ingresosDelMes: 286.2,
      ingresosAcumulados: 286.2,
      deduccionesAcumuladas: 0,
      costoDeVentasAcumulado: 0,
      deduccionInversionesAcumulada: 0,
      perdidasEjerciciosAnteriores: 0,
      utilidadFiscal: 286.2,
      pagosProvisionalesPrevios: 0,
      isrCausado: 5.49,
      retencionesIsrVentas: 0,
      isrAPagarEstimado: 5.49,
      sinVentas: false,
    })
  })

  it('plan 4b · con todo al 16 % los campos nuevos: tasa 0, exento y no objeto en cero; el ingreso sin IVA es la base gravable', async () => {
    const r = await getIncomeStatement(x.venueId, JUNIO)
    for (const v of [r.revenue, r.fiscalRevenue])
      expect(v).toMatchObject({ tasa0BaseCents: 0, exentoBaseCents: 0, noObjetoBaseCents: 0, ingresosSinIvaCents: v.taxableBaseCents })
  })
})

describe('reportes por tratamiento: 16 %, 0 %, exento, no objeto y un renglón sellado', () => {
  let x: Negocio

  beforeAll(async () => {
    x = await nuevoNegocio({ contabilidad: false })
    const { categoryId, productId: cafe16 } = await conProducto(x) // bandera ENCENDIDA, 'Café' IVA_16
    const producto = async (name: string, ivaTratamiento: IvaTratamiento) =>
      (await prisma.product.create({ data: { venueId: x.venueId, categoryId, sku: `${name}-${x.rfc}`, name, price: 100, ivaTratamiento } }))
        .id
    const grano0 = await producto('Grano', 'IVA_0')
    const libro = await producto('Libro', 'EXENTO')
    const donativo = await producto('Donativo', 'NO_OBJETO')
    const galleta = await producto('Galleta', 'IVA_16')

    // X · tarjeta 216 (16 %: 116 · 0 %: 50 · exento: 30 · no objeto: 20) y una devolución MANUAL de 21.60 (10 %, mezcla actual).
    const ox = await orden(x.venueId, [
      [cafe16, '116.00'],
      [grano0, '50.00'],
      [libro, '30.00'],
      [donativo, '20.00'],
    ])
    const px = await pagar(x.venueId, ox.id, '216.00')
    await pagar(x.venueId, ox.id, '-21.60', { type: 'REFUND', processorData: { provenance: 'MANUAL', originalPaymentId: px.id } })
    // Y · tarjeta 116 de una galleta cuyo renglón quedó SELLADO al 16 % por una factura; después el producto pasa a 0 %.
    const oy = await orden(x.venueId, [[galleta, '116.00']])
    await prisma.orderItem.update({ where: { id: oy.items[0] }, data: { ivaTratamiento: 'IVA_16' } })
    await prisma.product.update({ where: { id: galleta }, data: { ivaTratamiento: 'IVA_0' } })
    await pagar(x.venueId, oy.id, '116.00')
  })

  // Venta X: 16 % 10000 + 1600 · 0 % 5000 · exento 3000 · no objeto 2000. Devolución: 16 % 1000 + 160 · 0 % 500 · exento 300 ·
  // no objeto 200. Venta Y (sellada 16 %): 10000 + 1600. Base por tratamiento: 16 % 19000 · 0 % 4500 · exento 2700 ·
  // no objeto 1800 (sin IVA en total: 28000). Gravable 16 + 0 = 23500. IVA 3040. Hoy: la galleta cuenta al 0 % y todo es gravable.
  it('Review Focus 1 y 2 · el sellado cuenta al 16 %; la devolución exenta sale de la base exenta; exento y no objeto fuera de la gravable', async () => {
    const r = await getIncomeStatement(x.venueId, JUNIO)
    for (const v of [r.revenue, r.fiscalRevenue]) {
      expect(v).toMatchObject({
        grossSalesCents: 33200,
        refundsCents: 2160,
        netRevenueCents: 31040,
        ivaCents: 3040,
        taxableBaseCents: 23500,
        tasa0BaseCents: 4500,
        exentoBaseCents: 2700,
        noObjetoBaseCents: 1800,
        ingresosSinIvaCents: 28000,
      })
      expect(v.taxByRate).toEqual({ '0.16': 3040 })
    }
  })
})
