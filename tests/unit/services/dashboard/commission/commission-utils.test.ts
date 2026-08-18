/**
 * 🔴 EL guardrail de la comisión frente al descuento por línea.
 *
 * El defecto que este archivo existe para impedir (encontrado 2026-08-17, al
 * preguntar el founder "¿la comisión se calcula con el descuento aplicado?"):
 *
 * `calculateBaseAmount` (comisión general) parte de `payment.amount` — lo
 * PAGADO, ya neto de descuentos — y `includeDiscount=true` lo suma de vuelta.
 * Pero `calculateCategoryFilteredAmount` y `calculateLeftoverAmount` parten de
 * `unitPrice × quantity` — el BRUTO — así que con el default
 * (`includeDiscount=false`) comisionaban sobre dinero que el negocio nunca
 * recibió, y con `includeDiscount=true` sumaban el descuento ENCIMA del bruto:
 * lo contaban dos veces.
 *
 * Era invisible porque `OrderItem.discountAmount` llegaba siempre en 0 desde el
 * POS (el payload tiraba el `discountId`). Arreglado eso, el dato es real y la
 * asimetría se volvió dinero: venta de $100 con −$20 → comisión sobre $80 en el
 * camino general y sobre $100 en el de categorías.
 *
 * La semántica correcta, ESPEJO de `calculateBaseAmount`:
 *   default                → NETO (bruto − descuento)
 *   includeDiscount=true   → se SUMA DE VUELTA el descuento (pre-descuento)
 */
import prisma from '../../../../../src/utils/prismaClient'
import { calculateCategoryFilteredAmount, calculateLeftoverAmount } from '../../../../../src/services/dashboard/commission/commission-utils'

const CONFIG_DEFAULT = { includeTax: false, includeDiscount: false }
const CONFIG_PRE_DESCUENTO = { includeTax: false, includeDiscount: true }

function linea(unitPrice: number, quantity: number, discountAmount: number, taxAmount = 0) {
  return { quantity, unitPrice, taxAmount, discountAmount }
}

describe('comisión por categoría — el descuento por línea SÍ resta', () => {
  it('🔴 default: la base es lo COBRADO, no el precio de lista', async () => {
    // $100 de línea con −$20: el negocio recibió $80. Comisionar sobre $100 le
    // paga al mesero por dinero que nunca entró.
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(100, 1, 20)])

    const base = await calculateCategoryFilteredAmount('order-1', ['cat-1'], CONFIG_DEFAULT)

    expect(base).toBe(80)
  })

  it('🔴 includeDiscount=true: pre-descuento, NUNCA bruto + descuento', async () => {
    // La opción significa "comisiona sobre el valor antes del descuento" ($100),
    // igual que en calculateBaseAmount. Antes daba $120: descuento contado dos veces.
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(100, 1, 20)])

    const base = await calculateCategoryFilteredAmount('order-1', ['cat-1'], CONFIG_PRE_DESCUENTO)

    expect(base).toBe(100)
  })

  it('un descuento mayor que la línea no deja la base negativa', async () => {
    // El descuento se calcula sobre producto+modificadores, pero esta base usa
    // unitPrice×quantity (sin modificadores): puede quedar por debajo del
    // descuento. Una línea así aporta 0, jamás resta a las demás.
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(10, 1, 30), linea(100, 1, 0)])

    const base = await calculateCategoryFilteredAmount('order-1', ['cat-1'], CONFIG_DEFAULT)

    expect(base).toBe(100)
  })

  it('regresión: sin descuento nada cambia, y el impuesto sigue componiendo igual', async () => {
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(100, 2, 0, 16)])

    expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], CONFIG_DEFAULT)).toBe(200)
    expect(await calculateCategoryFilteredAmount('order-1', ['cat-1'], { includeTax: true, includeDiscount: false })).toBe(216)
  })
})

describe('comisión del sobrante (catch-all) — misma aritmética', () => {
  it('🔴 default neto, includeDiscount pre-descuento', async () => {
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([linea(100, 1, 20)])

    expect(await calculateLeftoverAmount('order-1', ['cat-reclamada'], CONFIG_DEFAULT)).toBe(80)
    expect(await calculateLeftoverAmount('order-1', ['cat-reclamada'], CONFIG_PRE_DESCUENTO)).toBe(100)
  })
})
