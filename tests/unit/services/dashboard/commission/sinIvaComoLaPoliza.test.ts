/**
 * Fase 3 de Pago al personal, final-fix I1 (revisión final, `task-final-review-report.md`): la comisión «sin IVA» es EXACTAMENTE
 * la venta neta de la póliza contable (spec §9-1, ruling del Bloque A). Develop cambió la regla de la póliza
 * (`ivaDeOrden.grossByRateFromOrder`, `fdf1dfd0`): la mezcla de tasas de la cuenta lleva los descuentos B2 dirigidos, las
 * cortesías, los cargos por servicio no gravables, el importe real del renglón (peso y extras) y el tratamiento SELLADO del
 * renglón. La comisión de la rama repartía sólo con `unitPrice × quantity − descuento` y la tasa del producto: con un B2 de
 * $100 dirigido a un renglón exento, la póliza asentaba $100 de venta neta y la comisión comisionaba sobre $107.41.
 *
 * Hermanos: «precio de lista» sin IVA (`listaDeLaOrden`) y las categorías (`calculateCategoryFilteredAmount`) leen la tasa de
 * cada renglón con la MISMA regla (sello > tratamiento del producto > 16 %), y la lista reparte su IVA por el importe real de
 * cada renglón y por el cargo gravable o no.
 */
import { Prisma, type IvaTratamiento } from '@prisma/client'
import prisma from '../../../../../src/utils/prismaClient'
import { buildSaleLines } from '../../../../../src/services/fiscal/autoPosting.service'
import {
  calculateBaseAmount,
  calculateCategoryFilteredAmount,
  ivaDelCobro,
  listaDeLaOrden,
  type OrdenParaReparto,
} from '../../../../../src/services/dashboard/commission/commission-utils'

const D = (n: number) => new Prisma.Decimal(n)
/** Como los triggers del producto: la tasa sale del tratamiento. */
const TASA: Record<string, number> = { IVA_16: 0.16, IVA_8: 0.08, IVA_0: 0, EXENTO: 0, NO_OBJETO: 0 }

interface Renglon {
  tratamiento?: IvaTratamiento
  /** `OrderItem.ivaTratamiento`: el renglón ya se facturó con este tratamiento. */
  sellado?: IvaTratamiento
  /** Cortesía del POS móvil: total 0 y la marca. */
  cortesia?: boolean
  kilos?: number
  extras?: number[]
  descuento?: number
}

/** Un renglón como lo trae `ORDEN_PARA_REPARTO_SELECT`: lo que lee la póliza (`ordenParaIvaSelect`) más sus kilos y extras. */
function renglon(id: string, precio: number, o: Renglon = {}) {
  const tratamiento = o.tratamiento ?? 'IVA_16'
  const extras = o.extras ?? []
  const importe = o.kilos != null ? Math.round(precio * o.kilos * 100) / 100 : precio + extras.reduce((s, x) => s + x, 0)
  return {
    id,
    quantity: 1,
    unitPrice: D(precio),
    total: D(o.cortesia ? 0 : importe),
    weightQuantity: o.kilos == null ? null : D(o.kilos),
    discountAmount: D(o.descuento ?? 0),
    isCortesia: o.cortesia ?? false,
    orderPromotionId: null,
    ivaTratamiento: o.sellado ?? null,
    modifiers: extras.map(price => ({ price: D(price), quantity: 1 })),
    product: { taxRate: D(TASA[tratamiento]), ivaTratamiento: tratamiento },
  }
}

/** Un descuento B2 DIRIGIDO entero a un renglón (sin espejo: el renglón no lo trae en su `discountAmount`). */
const dirigido = (monto: number, renglonId: string) => ({
  amount: D(monto),
  reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones: { [renglonId]: Math.round(monto * 100) } },
})

function ordenDe(
  items: ReturnType<typeof renglon>[],
  o: { subtotal: number; descuento?: number; cargos?: Array<{ monto: number; gravable: boolean }>; b2?: ReturnType<typeof dirigido>[] },
): OrdenParaReparto {
  const cargo = (o.cargos ?? []).reduce((s, c) => s + c.monto, 0)
  return {
    id: 'order-1',
    createdById: null,
    servedById: null,
    subtotal: D(o.subtotal),
    discountAmount: D(o.descuento ?? 0),
    taxAmount: D(0),
    serviceChargeAmount: D(cargo),
    contratoDePrecio: 'IVA_INCLUIDO',
    status: 'COMPLETED',
    total: D(o.subtotal - (o.descuento ?? 0) + cargo),
    items,
    orderDiscounts: o.b2 ?? [],
    serviceCharges: (o.cargos ?? []).map(c => ({ amount: D(c.monto), taxable: c.gravable })),
  } as unknown as OrdenParaReparto
}

/** «Lo cobrado», un solo cobro, sin categorías ni propina, «sin IVA»: la base de la comisión. */
const baseSinIva = (order: OrdenParaReparto, cobro: number) =>
  calculateBaseAmount(
    { amount: D(cobro), tipAmount: D(0), taxAmount: ivaDelCobro({ amount: D(cobro), order }), discountAmount: D(0) },
    { includeTax: false, includeDiscount: false, includeTips: false },
  ).baseAmount

/** La venta neta (HABER ventas) de la póliza del mismo cobro, con el `buildSaleLines` de develop sobre la MISMA orden. */
function ventaNetaDeLaPoliza(order: OrdenParaReparto, cobro: number): number {
  const poliza = buildSaleLines(
    {
      id: 'pago-1',
      amount: D(cobro),
      tipAmount: D(0),
      feeAmount: D(0),
      method: 'CASH',
      type: 'REGULAR',
      createdAt: new Date('2026-10-08T18:00:00Z'),
      merchantAccount: null,
      ecommerceMerchant: null,
      order: { ...(order as unknown as Parameters<typeof buildSaleLines>[0]['order'] & object), status: 'COMPLETED', orderNumber: null },
    },
    cuenta => cuenta,
  )
  return (poliza?.lines.find(l => l.ledgerAccountId === 'SALES_REVENUE')?.creditCents ?? 0) / 100
}

describe('final-fix I1 · «Lo cobrado» sin IVA es la venta neta de la póliza de develop', () => {
  it.each<[string, () => OrdenParaReparto, number, number]>([
    [
      '🔴 B2 de $100 dirigido al renglón exento: $116 al 16 % + $100 exento, paga $116 (la rama daba $107.41)',
      () =>
        ordenDe([renglon('a', 116), renglon('b', 100, { tratamiento: 'EXENTO' })], {
          subtotal: 216,
          descuento: 100,
          b2: [dirigido(100, 'b')],
        }),
      116,
      100,
    ],
    [
      '🔴 cortesía del POS móvil (total 0) de $116 al 16 % + $100 exento, paga $100 (la rama daba $92.59)',
      () => ordenDe([renglon('a', 116, { cortesia: true }), renglon('b', 100, { tratamiento: 'EXENTO' })], { subtotal: 100 }),
      100,
      100,
    ],
    [
      '🔴 cargo por servicio NO gravable de $10 sobre $116 al 16 %, paga $126 (la rama daba $108.62)',
      () => ordenDe([renglon('a', 116)], { subtotal: 116, cargos: [{ monto: 10, gravable: false }] }),
      126,
      110,
    ],
    [
      '🔴 venta por peso: $116/kg × 0.5 kg al 16 % + $100 exento, paga $158 (la rama daba $146.30)',
      () => ordenDe([renglon('a', 116, { kilos: 0.5 }), renglon('b', 100, { tratamiento: 'EXENTO' })], { subtotal: 158 }),
      158,
      150,
    ],
    [
      '🔴 extras con precio: $116 + $58 al 16 % + $100 exento, paga $274 (la rama daba $253.70)',
      () => ordenDe([renglon('a', 116, { extras: [58] }), renglon('b', 100, { tratamiento: 'EXENTO' })], { subtotal: 274 }),
      274,
      250,
    ],
    [
      '🔴 renglón SELLADO exento aunque su producto hoy es 16 %, paga $116 (la rama daba $100)',
      () => ordenDe([renglon('a', 116, { sellado: 'EXENTO' })], { subtotal: 116 }),
      116,
      116,
    ],
    // Regresión: lo que ya cuadraba sigue cuadrando.
    ['un paquete al 16 %', () => ordenDe([renglon('a', 116)], { subtotal: 116 }), 116, 100],
    ['frontera al 8 %', () => ordenDe([renglon('a', 108, { tratamiento: 'IVA_8' })], { subtotal: 108 }), 108, 100],
    [
      'mixta 16 % y 0 % en un cobro de $100: su parte de cada tasa',
      () => ordenDe([renglon('a', 116), renglon('b', 100, { tratamiento: 'IVA_0' })], { subtotal: 216 }),
      100,
      92.59,
    ],
    [
      'cargo GRAVABLE de $11.60 sobre $116 al 16 %',
      () => ordenDe([renglon('a', 116)], { subtotal: 116, cargos: [{ monto: 11.6, gravable: true }] }),
      127.6,
      110,
    ],
  ])('%s', (_n, orden, cobro, esperado) => {
    const order = orden()
    expect(baseSinIva(order, cobro)).toBe(esperado)
    expect(baseSinIva(order, cobro)).toBe(ventaNetaDeLaPoliza(order, cobro))
  })

  it('sin orden (cobro suelto) y sin renglones, al 16 %, como la póliza', () => {
    expect(ivaDelCobro({ amount: D(116), order: null }).toFixed(2)).toBe('16.00')
    const vacia = ordenDe([], { subtotal: 116 })
    expect(ivaDelCobro({ amount: D(116), order: vacia }).toFixed(2)).toBe('16.00')
    expect(baseSinIva(vacia, 116)).toBe(ventaNetaDeLaPoliza(vacia, 116))
  })

  it('una orden de más de 1000 renglones no se comisiona con datos parciales: lo rechaza como la póliza', () => {
    const muchos = ordenDe(
      Array.from({ length: 1001 }, (_, i) => renglon(String(i).padStart(4, '0'), 1)),
      { subtotal: 1001 },
    )
    expect(() => ivaDelCobro({ amount: D(1001), order: muchos })).toThrow(/datos parciales/)
  })
})

describe('final-fix I1, hermano · «precio de lista» sin IVA con la misma regla de tasas', () => {
  const LISTA_SIN_IVA = { includeTax: false }
  it.each<[string, () => OrdenParaReparto, number]>([
    [
      '🔴 renglón SELLADO exento con su producto al 16 %: lista $116 sin IVA = $116 (la rama daba $100)',
      () => ordenDe([renglon('a', 116, { sellado: 'EXENTO' })], { subtotal: 116 }),
      116,
    ],
    [
      '🔴 cargo NO gravable de $10: lista $126 sin IVA = $110 (la rama daba $108.62)',
      () => ordenDe([renglon('a', 116)], { subtotal: 116, cargos: [{ monto: 10, gravable: false }] }),
      110,
    ],
    [
      '🔴 peso al 16 % + exento: lista $158 sin IVA = $150 (la rama daba $146.30)',
      () => ordenDe([renglon('a', 116, { kilos: 0.5 }), renglon('b', 100, { tratamiento: 'EXENTO' })], { subtotal: 158 }),
      150,
    ],
    [
      '🔴 extras al 16 % + exento: lista $274 sin IVA = $250 (la rama daba $253.70)',
      () => ordenDe([renglon('a', 116, { extras: [58] }), renglon('b', 100, { tratamiento: 'EXENTO' })], { subtotal: 274 }),
      250,
    ],
    // Regresión: la lista es ANTES de descuentos (también del B2 y de la cortesía), y su importe no cambia.
    [
      'B2 dirigido al exento: la lista no lo resta, $216 sin IVA = $200',
      () =>
        ordenDe([renglon('a', 116), renglon('b', 100, { tratamiento: 'EXENTO' })], {
          subtotal: 216,
          descuento: 100,
          b2: [dirigido(100, 'b')],
        }),
      200,
    ],
    [
      'cortesía del POS móvil: la lista conserva la mercancía, $216 sin IVA = $200',
      () => ordenDe([renglon('a', 116, { cortesia: true }), renglon('b', 100, { tratamiento: 'EXENTO' })], { subtotal: 100 }),
      200,
    ],
    [
      'cargo GRAVABLE de $11.60: $127.60 sin IVA = $110',
      () => ordenDe([renglon('a', 116)], { subtotal: 116, cargos: [{ monto: 11.6, gravable: true }] }),
      110,
    ],
    ['sin renglones, la cabecera al 16 %', () => ordenDe([], { subtotal: 116 }), 100],
  ])('%s', (_n, orden, esperado) => {
    expect(listaDeLaOrden(orden(), LISTA_SIN_IVA)).toBe(esperado)
  })

  it('con IVA, la lista no cambia: renglones antes de descuentos más el cargo', () => {
    const order = ordenDe([renglon('a', 116, { sellado: 'EXENTO' }), renglon('b', 100, { tratamiento: 'EXENTO' })], {
      subtotal: 216,
      cargos: [{ monto: 10, gravable: false }],
    })
    expect(listaDeLaOrden(order, { includeTax: true })).toBe(226)
  })
})

describe('final-fix I1, hermano · por categoría, la tasa del renglón es la de la póliza (sello > producto)', () => {
  const linea = (precio: number, tratamiento: IvaTratamiento, sellado: IvaTratamiento | null = null) => ({
    quantity: 1,
    unitPrice: precio,
    weightQuantity: null,
    taxAmount: 0,
    discountAmount: 0,
    ivaTratamiento: sellado,
    modifiers: [],
    product: { categoryId: 'cat-1', taxRate: TASA[tratamiento], ivaTratamiento: tratamiento },
  })
  const contrato = () =>
    (prisma.order.findUnique as jest.Mock).mockResolvedValue({ discountAmount: 0, contratoDePrecio: 'IVA_INCLUIDO', taxAmount: 0 })

  it('🔴 un renglón SELLADO exento con su producto al 16 %: $116 sin IVA = $116 (la rama daba $100)', async () => {
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(116, 'IVA_16', 'EXENTO')])
    contrato()
    expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], { includeTax: false, includeDiscount: false })).toBe(116)
  })

  it('sin sello, la tasa del tratamiento del producto: $116 al 16 % + $100 exento = $200', async () => {
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(116, 'IVA_16'), linea(100, 'EXENTO')])
    contrato()
    expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], { includeTax: false, includeDiscount: false })).toBe(200)
  })

  it('la consulta pide el sello del renglón y el tratamiento del producto', async () => {
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([])
    contrato()
    await calculateCategoryFilteredAmount('order-1', ['cat-1'], { includeTax: false, includeDiscount: false })
    const { select } = (prisma.orderItem.findMany as jest.Mock).mock.calls.at(-1)[0]
    expect(select).toMatchObject({ ivaTratamiento: true, product: { select: { ivaTratamiento: true } } })
  })
})
