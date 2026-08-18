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
import prisma from '../../../../../src/utils/prismaClient'
import { calculateCategoryFilteredAmount, calculateLeftoverAmount } from '../../../../../src/services/dashboard/commission/commission-utils'

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
