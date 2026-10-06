/**
 * 🔴 EL guardrail de la comisión frente a los descuentos.
 *
 * Dos defectos, encontrados con un mes de diferencia, en la misma aritmética:
 *
 * **(1) 2026-08-17 — el descuento de RENGLÓN no restaba.** `calculateBaseAmount`
 * (comisión general) parte de `payment.amount` — lo PAGADO, ya neto — y
 * `includeDiscount=true` lo suma de vuelta. Pero `calculateCategoryFilteredAmount`
 * y `calculateLeftoverAmount` partían de `unitPrice × quantity` — el BRUTO — así
 * que con el default (`includeDiscount=false`) comisionaban dinero que el negocio
 * nunca recibió, y con `includeDiscount=true` sumaban el descuento ENCIMA del
 * bruto: lo contaban dos veces. Era invisible mientras `OrderItem.discountAmount`
 * llegaba siempre en 0 desde el POS (el payload tiraba el `discountId`).
 *
 * **(2) 2026-08-18 — el descuento de ORDEN seguía sin restar, y el importe libre
 * aportaba CERO.** Aun neta de renglón, la base por categoría ignoraba el
 * descuento aplicado a toda la cuenta, y la consulta filtraba por
 * `product.categoryId`, así que un renglón de "Otro importe" (sin producto) no
 * caía ni en el `in` ni en el `notIn`: desaparecía de las dos bases.
 *
 * Hoy las tres bases salen de UNA sola función pura (`commission-base.ts`) con
 * dos modos explícitos:
 *
 *   LO_COBRADO (`includeDiscount=false`, default) → bruto − descuento de renglón
 *                                                   − parte prorrateada del de orden
 *   PRECIO_DE_LISTA (`includeDiscount=true`)      → `unitPrice × quantity`
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../../../src/utils/prismaClient'
import {
  calculateBaseAmount,
  calculateCategoryFilteredAmount,
  calculateLeftoverAmount,
  ivaDelCobro,
  listaDeLaOrden,
  type OrdenParaReparto,
} from '../../../../../src/services/dashboard/commission/commission-utils'
import { repartir } from '../../../../../src/services/dashboard/commission/repartoPorCobro'

const CONFIG_DEFAULT = { includeTax: false, includeDiscount: false }
const CONFIG_PRE_DESCUENTO = { includeTax: false, includeDiscount: true }

/** Un renglón como lo devuelve la consulta: `categoryId = null` ⇒ "Otro importe". */
function linea(unitPrice: number, quantity: number, discountAmount: number, taxAmount = 0, categoryId: string | null = 'cat-1') {
  return { quantity, unitPrice, taxAmount, discountAmount, product: categoryId ? { categoryId } : null }
}

/** `Order.discountAmount` guarda el TOTAL: descuentos de renglón + el de orden. */
function orden(discountAmount: number) {
  ;(prisma.order.findUnique as jest.Mock).mockResolvedValue({ discountAmount })
}

beforeEach(() => {
  orden(0)
})

describe('comisión por categoría — el descuento por línea SÍ resta', () => {
  it('🔴 default: la base es lo COBRADO, no el precio de lista', async () => {
    // $100 de línea con −$20: el negocio recibió $80. Comisionar sobre $100 le
    // paga al mesero por dinero que nunca entró.
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(100, 1, 20)])
    orden(20)

    const base = await calculateCategoryFilteredAmount('order-1', ['cat-1'], CONFIG_DEFAULT)

    expect(base).toBe(80)
  })

  it('🔴 includeDiscount=true: pre-descuento, NUNCA bruto + descuento', async () => {
    // La opción significa "comisiona sobre el valor antes del descuento" ($100),
    // igual que en calculateBaseAmount. Antes daba $120: descuento contado dos veces.
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(100, 1, 20)])
    orden(20)

    const base = await calculateCategoryFilteredAmount('order-1', ['cat-1'], CONFIG_PRE_DESCUENTO)

    expect(base).toBe(100)
  })

  it('un descuento mayor que la línea no deja la base negativa', async () => {
    // El descuento se calcula sobre producto+modificadores, pero esta base usa
    // unitPrice×quantity (sin modificadores): puede quedar por debajo del
    // descuento. Una línea así aporta 0, jamás resta a las demás.
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(10, 1, 30), linea(100, 1, 0)])
    orden(30)

    const base = await calculateCategoryFilteredAmount('order-1', ['cat-1'], CONFIG_DEFAULT)

    expect(base).toBe(100)
  })

  it('regresión: sin descuento nada cambia, y el impuesto sigue componiendo igual', async () => {
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(100, 2, 0, 16)])

    expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], CONFIG_DEFAULT)).toBe(200)
    expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], { includeTax: true, includeDiscount: false })).toBe(216)
  })

  it('sólo suma las líneas de SUS categorías', async () => {
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([
      linea(300, 1, 0, 0, 'cat-servicios'),
      linea(100, 1, 0, 0, 'cat-productos'),
    ])

    expect(await calculateCategoryFilteredAmount('order-1', ['cat-servicios'], CONFIG_DEFAULT)).toBe(300)
  })
})

describe('🔴 el descuento de ORDEN también baja la base (2026-08-18)', () => {
  it('se prorratea entre las líneas y sólo la parte de esta categoría resta', async () => {
    // Cuenta de $400 ($300 servicios + $100 productos) con −$40 sobre el total.
    // A servicios le toca 300/400 × 40 = $30 → base $270. Antes: $300.
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([
      linea(300, 1, 0, 0, 'cat-servicios'),
      linea(100, 1, 0, 0, 'cat-productos'),
    ])
    orden(40)

    expect(await calculateCategoryFilteredAmount('order-1', ['cat-servicios'], CONFIG_DEFAULT)).toBe(270)
  })

  it('no cuenta dos veces el descuento de renglón (Order.discountAmount los incluye)', async () => {
    // Renglón −$20 y NADA de descuento de orden: `Order.discountAmount` = 20.
    // La parte de ORDEN es 20 − 20 = 0, así que la base queda en $80, no en $60.
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(100, 1, 20)])
    orden(20)

    expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], CONFIG_DEFAULT)).toBe(80)
  })

  it('PRECIO_DE_LISTA lo ignora: se comisiona el catálogo completo', async () => {
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([
      linea(300, 1, 0, 0, 'cat-servicios'),
      linea(100, 1, 0, 0, 'cat-productos'),
    ])
    orden(40)

    expect(await calculateCategoryFilteredAmount('order-1', ['cat-servicios'], CONFIG_PRE_DESCUENTO)).toBe(300)
  })
})

describe('comisión del sobrante (catch-all) — misma aritmética', () => {
  it('🔴 default neto, includeDiscount pre-descuento', async () => {
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(100, 1, 20, 0, 'cat-libre')])
    orden(20)

    expect(await calculateLeftoverAmount('order-1', ['cat-reclamada'], CONFIG_DEFAULT)).toBe(80)
    expect(await calculateLeftoverAmount('order-1', ['cat-reclamada'], CONFIG_PRE_DESCUENTO)).toBe(100)
  })

  it('🔴 un renglón de "Otro importe" SÍ entra en el sobrante (2026-08-18)', async () => {
    // Bug real: `product: { categoryId: { notIn: [...] } }` descarta las líneas
    // SIN producto, así que una venta de importe libre no generaba ninguna
    // comisión en cuanto existía UNA configuración por categoría.
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(300, 1, 0, 0, 'cat-reclamada'), linea(150, 1, 0, 0, null)])

    expect(await calculateLeftoverAmount('order-1', ['cat-reclamada'], CONFIG_DEFAULT)).toBe(150)
  })

  it('el importe libre NO se cuela en una base por categoría', async () => {
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(300, 1, 0, 0, 'cat-reclamada'), linea(150, 1, 0, 0, null)])

    expect(await calculateCategoryFilteredAmount('order-1', ['cat-reclamada'], CONFIG_DEFAULT)).toBe(300)
  })

  it('las dos bases juntas suman la orden completa (nada se cae por el hueco)', async () => {
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([
      linea(300, 1, 0, 0, 'cat-reclamada'),
      linea(100, 1, 0, 0, 'cat-otra'),
      linea(100, 1, 0, 0, null),
    ])
    orden(50)

    const porCategoria = await calculateCategoryFilteredAmount('order-1', ['cat-reclamada'], CONFIG_DEFAULT)
    const sobrante = await calculateLeftoverAmount('order-1', ['cat-reclamada'], CONFIG_DEFAULT)

    expect(porCategoria + sobrante).toBe(450) // 500 − 50 de descuento de orden
  })
})

/**
 * Medición del §11 del spec de pago por servicio (H4, 5-oct-2026), con la regla de la fase 3: el camino general recibe la
 * PARTE de este cobro del descuento (`repartir`), no el de toda la orden. Orden de lista $500 con $50 de descuento.
 */
describe('H4 · la misma venta, por los dos caminos', () => {
  const D = (n: number) => new Prisma.Decimal(n)
  const SIN_PROPINA = { includeTips: false }
  /** Un cobro con SU parte del descuento de la orden, como lo arma `createCommissionForPayment`. */
  const cobro = (amount: number, descuento: Prisma.Decimal) => ({
    amount: D(amount),
    tipAmount: D(0),
    taxAmount: D(0),
    discountAmount: descuento,
  })

  beforeEach(() => {
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(300, 1, 0), linea(200, 1, 0)])
    orden(50)
  })

  it('un solo cobro: los dos caminos dan la misma base en los dos modos', async () => {
    const unico = { totalOrden: D(450), cobro: D(450) }
    expect(calculateBaseAmount(cobro(450, repartir(unico, D(50))), { ...CONFIG_DEFAULT, ...SIN_PROPINA }).baseAmount).toBe(
      await calculateCategoryFilteredAmount('order-1', ['cat-1'], CONFIG_DEFAULT),
    )
    expect(calculateBaseAmount(cobro(450, repartir(unico, D(50))), { ...CONFIG_PRE_DESCUENTO, ...SIN_PROPINA }).baseAmount).toBe(
      await calculateCategoryFilteredAmount('order-1', ['cat-1'], CONFIG_PRE_DESCUENTO),
    )
  })

  it('🔴 dos cobros de la misma orden en «precio de lista» suman el precio de lista ($500), no $550', () => {
    const c = { totalOrden: D(450), cobro: D(225) }
    const parteDelPrimero = repartir(c, D(50))
    // El segundo ve al primero confirmado, con la parte del descuento que quedó registrada en su comisión.
    const otro = { monto: D(225), base: null, descuento: parteDelPrimero }
    const total =
      calculateBaseAmount(cobro(225, parteDelPrimero), { ...CONFIG_PRE_DESCUENTO, ...SIN_PROPINA }).baseAmount +
      calculateBaseAmount(cobro(225, repartir(c, D(50), [otro], 'descuento')), { ...CONFIG_PRE_DESCUENTO, ...SIN_PROPINA }).baseAmount
    expect(total).toBe(500)
  })
})

describe('🔴 D5 — renglones con el IVA incluido en el precio', () => {
  it('«sin IVA» le separa el IVA al renglón con la tasa de su producto (16 %); «con IVA» deja el precio', async () => {
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(116, 1, 0, 16)])
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue({ discountAmount: 0, contratoDePrecio: 'IVA_INCLUIDO' })
    expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], { includeTax: false, includeDiscount: false })).toBe(100)
    expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], { includeTax: true, includeDiscount: false })).toBe(116)
  })

  it('IVA aparte: lo de siempre (con IVA lo suma, sin IVA no)', async () => {
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(100, 1, 0, 16)])
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue({ discountAmount: 0, contratoDePrecio: 'IVA_APARTE' })
    expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], { includeTax: false, includeDiscount: false })).toBe(100)
    expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], { includeTax: true, includeDiscount: false })).toBe(116)
  })
})

describe('A1e · «sin IVA» con la regla de la póliza contable (D5 enmendada, ruling r2)', () => {
  const D = (n: number) => new Prisma.Decimal(n)
  const SIN_IVA = { includeTax: false, includeDiscount: false }
  const LISTA_SIN_IVA = { includeTax: false, includeDiscount: true }
  /** Un renglón como lo lee el reparto (`ORDEN_PARA_REPARTO_SELECT`): la forma de la póliza más sus extras. `null` = sin producto. */
  const item = (precio: number, taxRate: number | null = 0.16, o: { descuento?: number; extras?: number[]; kilos?: number } = {}) => ({
    quantity: 1,
    unitPrice: D(precio),
    // Venta por peso: `quantity` se queda en 1 y los kilos van aquí (como los guarda el POS).
    weightQuantity: o.kilos == null ? null : D(o.kilos),
    discountAmount: D(o.descuento ?? 0),
    modifiers: (o.extras ?? []).map(price => ({ price: D(price), quantity: 1 })),
    product: taxRate === null ? null : { taxRate: D(taxRate) },
  })
  /** Una orden con el precio con IVA incluido, como la trae `ORDEN_PARA_REPARTO_SELECT`. */
  const ordenDe = (items: ReturnType<typeof item>[], o: { subtotal: number; descuento?: number; cargo?: number }): OrdenParaReparto =>
    ({
      id: 'order-1',
      createdById: null,
      servedById: null,
      subtotal: D(o.subtotal),
      discountAmount: D(o.descuento ?? 0),
      taxAmount: D(0),
      serviceChargeAmount: D(o.cargo ?? 0),
      contratoDePrecio: 'IVA_INCLUIDO',
      status: 'COMPLETED',
      items,
    }) as unknown as OrdenParaReparto

  it('🔴 el IVA de un cobro es el de su póliza: mixta $116 al 16 % + $100 al 0 %', () => {
    const order = { items: [item(116), item(100, 0)] }
    expect(ivaDelCobro({ amount: D(216), order }).toFixed(2)).toBe('16.00')
    // Un cobro de $100 de esa orden lleva su parte de cada tasa: 7.41 de IVA (base $92.59).
    expect(ivaDelCobro({ amount: D(100), order }).toFixed(2)).toBe('7.41')
  })

  it('sin renglones, al 16 %, como la póliza', () => {
    expect(ivaDelCobro({ amount: D(116), order: { items: [] } }).toFixed(2)).toBe('16.00')
  })

  it('🔴 Codex r3-3: «precio de lista» sale de los renglones con y sin IVA, también con la cortesía del POS ($216 / $200)', () => {
    // $116 al 16 % regalado entero (el POS móvil deja la cabecera en subtotal $100 y descuento $0) + $100 exentos.
    const cortesia = ordenDe([item(116, 0.16, { descuento: 116 }), item(100, 0)], { subtotal: 100 })
    expect([listaDeLaOrden(cortesia, { includeTax: true }), listaDeLaOrden(cortesia, { includeTax: false })]).toEqual([216, 200])
  })

  it('🔴 Codex r3-2: «precio de lista» lleva el cargo por servicio y le saca su IVA ($116 + $11.60 ⇒ $127.60 / $110)', () => {
    const conCargo = ordenDe([item(116)], { subtotal: 116, cargo: 11.6 })
    expect([listaDeLaOrden(conCargo, { includeTax: true }), listaDeLaOrden(conCargo, { includeTax: false })]).toEqual([127.6, 110])
  })

  it('los extras son parte de la lista; sin renglones, la cabecera (subtotal + cargo) al 16 %', () => {
    expect(listaDeLaOrden(ordenDe([item(116, 0.16, { extras: [58] })], { subtotal: 174 }), { includeTax: false })).toBe(150)
    expect(listaDeLaOrden(ordenDe([], { subtotal: 116, descuento: 16 }), { includeTax: false })).toBe(100)
  })

  it('🔴 Codex r4-1: venta por peso: precio/kg × kilos al centavo, como el POS ($116/kg: 0.5 kg ⇒ $58 / $50; 2 kg ⇒ $232 / $200)', () => {
    const peso = (kilos: number) => ordenDe([item(116, 0.16, { kilos })], { subtotal: 116 * kilos })
    const ambas = (kilos: number) => [listaDeLaOrden(peso(kilos), { includeTax: true }), listaDeLaOrden(peso(kilos), { includeTax: false })]
    expect([ambas(0.5), ambas(2)]).toEqual([
      [58, 50],
      [232, 200],
    ])
    // El redondeo es por renglón, el del POS: 116 × 0.333 = 38.628 ⇒ $38.63.
    expect(listaDeLaOrden(peso(0.333), { includeTax: true })).toBe(38.63)
  })

  it('IVA cobrado aparte: los renglones ya vienen sin IVA; «sin IVA» es la lista y «con IVA» le suma el registrado', () => {
    const aparte = { ...ordenDe([item(100)], { subtotal: 100 }), contratoDePrecio: 'IVA_APARTE', taxAmount: D(16) } as OrdenParaReparto
    expect([listaDeLaOrden(aparte, { includeTax: true }), listaDeLaOrden(aparte, { includeTax: false })]).toEqual([116, 100])
  })

  describe('por categoría: la parte gravable de ESOS renglones, con las tasas de sus productos', () => {
    /** Un renglón como lo devuelve la consulta de comisiones: con extras y la tasa de su producto. */
    const renglon = (precio: number, taxRate: number, o: { descuento?: number; extras?: number[]; kilos?: number } = {}) => ({
      quantity: 1,
      unitPrice: precio,
      weightQuantity: o.kilos ?? null,
      taxAmount: 0,
      discountAmount: o.descuento ?? 0,
      modifiers: (o.extras ?? []).map(price => ({ price, quantity: 1 })),
      product: { categoryId: 'cat-1', taxRate },
    })
    const contrato = (contratoDePrecio: string, discountAmount = 0, taxAmount = 0) =>
      (prisma.order.findUnique as jest.Mock).mockResolvedValue({ discountAmount, contratoDePrecio, taxAmount })

    it('🔴 con el IVA incluido, «sin IVA» separa cada tasa: $116 al 16 % + $100 al 0 % = $200', async () => {
      ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([renglon(116, 0.16), renglon(100, 0)])
      contrato('IVA_INCLUIDO')
      expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], SIN_IVA)).toBe(200)
      expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], { includeTax: true, includeDiscount: false })).toBe(216)
    })

    it('«precio de lista» sin IVA: los renglones antes de descuentos (Codex r1-1)', async () => {
      ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([renglon(116, 0.16, { descuento: 58 }), renglon(100, 0)])
      contrato('IVA_INCLUIDO', 58)
      expect(await calculateLeftoverAmount('order-1', [], LISTA_SIN_IVA)).toBe(200)
    })

    it('🔴 no inventa centavos: 3 × $1 al 0 % con $1 de descuento de orden = $2.00 (Codex r1-2)', async () => {
      ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([renglon(1, 0), renglon(1, 0), renglon(1, 0)])
      contrato('IVA_INCLUIDO', 1)
      expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], SIN_IVA)).toBe(2)
    })

    it('los extras con precio son parte del renglón: $116 + $58 al 16 % = $150 sin IVA', async () => {
      ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([renglon(116, 0.16, { extras: [58] })])
      contrato('IVA_INCLUIDO')
      expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], SIN_IVA)).toBe(150)
    })

    it('🔴 un renglón por peso cuenta sus kilos, como el POS: $116/kg × 0.5 kg = $50 sin IVA (Codex r4-1)', async () => {
      ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([renglon(116, 0.16, { kilos: 0.5 })])
      contrato('IVA_INCLUIDO')
      expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], SIN_IVA)).toBe(50)
    })

    it('una venta DESCONOCIDO sin IVA registrado (anterior al contrato) se lee con el IVA incluido', async () => {
      ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([renglon(116, 0.16)])
      contrato('DESCONOCIDO')
      expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], SIN_IVA)).toBe(100)
    })

    it('IVA cobrado aparte: los renglones ya vienen sin IVA; «sin IVA» deja el neto y «con IVA» suma el registrado', async () => {
      ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([{ ...renglon(100, 0.16), taxAmount: 16 }])
      contrato('IVA_APARTE', 0, 16)
      expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], SIN_IVA)).toBe(100)
      expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], { includeTax: true, includeDiscount: false })).toBe(116)
    })
  })

  it('el camino general «sin IVA» resta exactamente el IVA de la póliza', () => {
    const order = { items: [item(116), item(100, 0)] }
    const r = calculateBaseAmount(
      { amount: D(216), tipAmount: D(0), taxAmount: ivaDelCobro({ amount: D(216), order }), discountAmount: D(0) },
      { ...SIN_IVA, includeTips: false },
    )
    expect(r.baseAmount).toBe(200)
  })
})
