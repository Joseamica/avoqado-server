/**
 * Base comisionable de una venta — LA ÚNICA aritmética.
 *
 * 🔴 DINERO PAGADO A PERSONAS. Antes de 2026-08-18 había DOS bases distintas y
 * la MISMA venta comisionaba diferente según si alguna configuración filtraba
 * por categoría:
 *
 *   · sin filtro → `payment.amount` (ya neto de descuentos)
 *   · con filtro → `unitPrice × quantity − descuento de RENGLÓN` — precio de
 *     lista: el descuento de ORDEN nunca la bajaba, y un renglón de importe
 *     libre ("Otro importe", sin producto) aportaba CERO.
 *
 * Eso no era una decisión de producto, era una inconsistencia. Aquí vive la base
 * única, con dos modos EXPLÍCITOS:
 *
 * | Modo               | Qué comisiona                                                    |
 * | ------------------ | ---------------------------------------------------------------- |
 * | `LO_COBRADO`       | lo que el negocio cobró: bruto − descuento de renglón − la parte |
 * |  (default)         | prorrateada del descuento de orden                               |
 * | `PRECIO_DE_LISTA`  | `unitPrice × quantity`, sin descuentos                           |
 *
 * **Por qué el default es LO_COBRADO** (decisión del founder, 2026-08-18):
 * Square (`Staff › Settings › Commissions › Calculation`, casilla "Discounts") y
 * Vagaro ("Deduct Discounts") lo dejan configurable en las dos direcciones, así
 * que aquí caben dos respuestas defendibles — una estética con "2x1 los martes"
 * quiere comisionar lo cobrado; una tienda con descuento decidido por la gerencia
 * quiere comisionar lista. Lo que inclina el default es México: el art. 27 de la
 * Ley del Seguro Social integra **las comisiones** al Salario Base de Cotización,
 * así que comisionar sobre un precio que nunca se cobró no sólo paga de más al
 * vendedor — **infla el SBC y con él las cuotas patronales**. El default va
 * conservador; el esquema puede elegir lo contrario a propósito.
 *
 * **La PROPINA nunca entra aquí.** Es dinero POR COBRO, no parte de la venta; el
 * llamador la suma aparte cuando el esquema trae `includeTips`.
 */
import { Prisma } from '@prisma/client'
import { splitIvaByRate } from '../../fiscal/ivaMath'
import { redondearRepartido } from './repartoPorCobro'

// ============================================
// Modos
// ============================================

export const COMMISSION_BASE = {
  /** Lo que el negocio cobró de verdad (neto de descuentos). Default. */
  LO_COBRADO: 'LO_COBRADO',
  /** El precio de catálogo, aunque se haya cobrado menos. */
  PRECIO_DE_LISTA: 'PRECIO_DE_LISTA',
} as const

export type CommissionBaseMode = (typeof COMMISSION_BASE)[keyof typeof COMMISSION_BASE]

/**
 * 🔴 EL ÚNICO sitio donde `CommissionConfig.includeDiscount` se traduce a una base.
 *
 * El campo NO se renombra: hay filas en prod y clientes de API que lo mandan
 * (`avoqado-web-dashboard`), y renombrarlo dejaría a esos venues con un toggle
 * que ya no hace nada. Lo que sí queda fijado —y probado— es su semántica:
 *
 *   `includeDiscount = false` (default de la DB) → **LO_COBRADO**
 *   `includeDiscount = true`                     → **PRECIO_DE_LISTA**
 *
 * Es la lectura que YA tenían los dos caminos tras el fix del 2026-08-17
 * (`false` = neto, `true` = valor pre-descuento), así que ningún venue cambia de
 * base al unificarse: sólo deja de depender de si su configuración filtra o no
 * por categoría. El nombre del campo dice lo contrario de lo que hace —
 * "incluir descuentos" es en realidad "comisiona el precio ANTES del descuento"—
 * y por eso la traducción vive en una función con nombre, no en un `if` suelto
 * repetido en cada sitio de cálculo.
 */
export function resolveCommissionBase(config: { includeDiscount: boolean }): CommissionBaseMode {
  return config.includeDiscount ? COMMISSION_BASE.PRECIO_DE_LISTA : COMMISSION_BASE.LO_COBRADO
}

// ============================================
// La base
// ============================================

/** Una línea ya seleccionada para este esquema, con su descuento de orden ya prorrateado. */
export interface CommissionableLine {
  /** Precio de LISTA de la línea: `unitPrice × quantity`, sin descuentos. */
  gross: number
  /** Descuento propio de la línea (cortesía / descuento de renglón). */
  lineDiscount?: number
  /** La parte del descuento de ORDEN que le toca a esta línea. */
  orderDiscountShare?: number
  /** IVA de la línea. «Con IVA» lo suma si se cobró aparte; «sin el IVA registrado» lo resta si el precio ya lo traía. */
  tax?: number
  /** Tasa del producto de la línea, como la lee la póliza (`product.taxRate`); `null` o ausente = 16 % (A1e). */
  taxRate?: number | null
}

function roundPesos(amount: number): number {
  return Math.round(amount * 100) / 100
}

/**
 * Importe comisionable de un conjunto de líneas para un esquema.
 *
 * El IVA (D5, fase 3 de pago por servicio): `includeTax` = «con IVA» = lo que pagó el cliente; sin él, «sin el IVA
 * registrado» = eso menos su IVA. Qué sumar o restar depende de si el precio de la línea YA traía el IVA
 * (`ivaIncluidoEnPrecio`, el contrato de precio de la orden) o si se cobró aparte (ausente = aparte, lo de siempre):
 *
 * | precio       | con IVA     | sin el IVA registrado |
 * | ------------ | ----------- | --------------------- |
 * | IVA aparte   | neto + IVA  | neto                  |
 * | IVA incluido | neto        | neto − IVA            |
 *
 * El clamp a 0 es POR LÍNEA, nunca sobre el total: el descuento se calcula sobre
 * producto + modificadores y este bruto es `unitPrice × quantity` (sin
 * modificadores), así que una cortesía con modificadores caros puede traer un
 * descuento mayor que su propio bruto. Esa línea aporta 0 — jamás le resta a las
 * demás. Restar el IVA tampoco deja una línea en negativo.
 */
export function commissionableAmount(
  lines: CommissionableLine[],
  options: { base: CommissionBaseMode; includeTax?: boolean; ivaIncluidoEnPrecio?: boolean },
): number {
  const listPrice = options.base === COMMISSION_BASE.PRECIO_DE_LISTA

  const total = lines.reduce((sum, line) => {
    const gross = line.gross
    const net = listPrice ? gross : Math.max(0, gross - (line.lineDiscount ?? 0) - (line.orderDiscountShare ?? 0))
    const tax = line.tax ?? 0
    const ajusteIva = options.ivaIncluidoEnPrecio ? (options.includeTax ? 0 : -tax) : options.includeTax ? tax : 0
    return sum + Math.max(0, net + ajusteIva)
  }, 0)

  return roundPesos(total)
}

/** La tasa de una línea sin producto o sin tasa: 16 %, como la póliza (`grossByRateForOrder`) y la factura. */
const TASA_POR_DEFECTO = 0.16

/**
 * ¿Los renglones de la orden ya traen el IVA? (A1e, D5 enmendada). `IVA_INCLUIDO`, sí. `DESCONOCIDO`, sólo si no registró IVA:
 * es la regla del saldo (P12, `impuestoQueSeCobraAparte`): un IVA escrito en una venta sin contrato se cobró aparte, y las
 * ventas nativas de antes del contrato nacieron con 0 y con el precio con IVA. `IVA_APARTE`, nunca. La columna nunca es nula;
 * un objeto sin contrato (sólo los dobles de prueba) se lee como aparte, lo de siempre. Lo usan las categorías, el sobrante y
 * la lista del esquema general; «Lo cobrado» toma el IVA de la póliza, que trata cada cobro como un monto con IVA incluido.
 */
export function precioTraeIva(o: { contratoDePrecio?: string | null; taxAmount?: Prisma.Decimal | number | string | null }): boolean {
  if (o.contratoDePrecio === 'IVA_INCLUIDO') return true
  return o.contratoDePrecio === 'DESCONOCIDO' && !new Prisma.Decimal(o.taxAmount ?? 0).gt(0)
}

/**
 * La base SIN IVA de unas líneas con el IVA incluido (A1e, D5 enmendada), con la regla de tasas de la póliza contable: el neto
 * de cada línea —los mismos descuentos, clamp por línea y «precio de lista» que `commissionableAmount`— pasa a centavos
 * CONSERVANDO el total (`redondearRepartido`, A1a), se agrupa por la tasa de su producto (sin tasa, 16 %) y se separa con
 * `splitIvaByRate`, la división de la póliza. Redondear cada línea (Codex r1-2: tres renglones de $1 al 0 % menos $1 daban
 * $2.01) o cada tasa por su lado (Codex r3-1: $0.01 al 16 % + $0.01 al 8 % menos $0.01 daban $0.02) inventaba centavos.
 */
export function baseSinIvaPorTasa(lines: CommissionableLine[], base: CommissionBaseMode): number {
  const listPrice = base === COMMISSION_BASE.PRECIO_DE_LISTA
  const netos = lines.map(line => {
    const gross = new Prisma.Decimal(line.gross)
    return listPrice ? gross : Prisma.Decimal.max(0, gross.minus(line.lineDiscount ?? 0).minus(line.orderDiscountShare ?? 0))
  })
  // El residuo de centavos va a los mayores restos y, en empate, al primero: las líneas llegan en orden de `id`.
  const enCentavos = redondearRepartido(netos)
  const porTasa = new Map<number, number>()
  lines.forEach((line, i) => {
    const tasa = line.taxRate ?? TASA_POR_DEFECTO
    porTasa.set(tasa, (porTasa.get(tasa) ?? 0) + enCentavos[i].mul(100).toNumber())
  })
  const { netCents } = splitIvaByRate([...porTasa].map(([rate, grossCents]) => ({ rate, grossCents })))
  return netCents / 100
}

// ============================================
// Selección de líneas + prorrateo del descuento de orden
// ============================================

/** Una línea de la orden tal como se lee de la DB, antes de seleccionar y prorratear. */
export interface OrderLineForCommission {
  /** `unitPrice × quantity`. */
  gross: number
  /** `OrderItem.discountAmount`. */
  lineDiscount: number
  /** `OrderItem.taxAmount`. */
  tax: number
  /** Categoría del producto. `null` = renglón de importe libre ("Otro importe"). */
  categoryId: string | null
  /** `Product.taxRate`, como lo lee la póliza; `null` = sin producto (16 %). */
  taxRate?: number | null
}

/**
 * Cuánto del descuento de la orden es de ORDEN y no de renglón.
 *
 * 🔴 `Order.discountAmount` guarda el TOTAL —descuentos de renglón MÁS el de
 * orden— (`order.tpv.service.ts`: `discountAmount = itemDiscount + orderDiscount`,
 * y `orderBalance.ts` lo resta contra el `subtotal` bruto). Restar el
 * `Order.discountAmount` completo a unas líneas que ya traen el suyo cobraría el
 * descuento de renglón dos veces.
 *
 * El clamp a 0 protege del caso contrario: un camino que guardara sólo la parte
 * de orden daría negativo aquí, y un descuento negativo SUBIRÍA la comisión.
 */
export function orderLevelDiscountOf(orderDiscountTotal: number, lineDiscounts: number[]): number {
  const lineTotal = lineDiscounts.reduce((sum, d) => sum + d, 0)
  return Math.max(0, roundPesos(orderDiscountTotal - lineTotal))
}

/**
 * Devuelve las líneas que ESTE esquema comisiona, con el descuento de orden ya
 * repartido entre ellas.
 *
 * El prorrateo pesa por el **neto de línea** (bruto − descuento de renglón), no
 * por el bruto: una línea que ya venía descontada absorbe menos del descuento de
 * orden, que es como lo aplica el propio POS (el descuento de orden se calcula
 * sobre `grossSubtotal − itemDiscount`). El denominador es la orden COMPLETA
 * —incluidas las líneas que este esquema no comisiona— para que la suma de las
 * partes sea exactamente el descuento de orden y ningún esquema absorba de más.
 */
export function selectCommissionableLines(input: {
  orderLines: OrderLineForCommission[]
  orderLevelDiscount: number
  include: (line: OrderLineForCommission) => boolean
}): CommissionableLine[] {
  const netOf = (line: OrderLineForCommission) => Math.max(0, line.gross - line.lineDiscount)
  const orderNet = input.orderLines.reduce((sum, line) => sum + netOf(line), 0)

  return input.orderLines.filter(input.include).map(line => ({
    gross: line.gross,
    lineDiscount: line.lineDiscount,
    orderDiscountShare: orderNet > 0 ? (input.orderLevelDiscount * netOf(line)) / orderNet : 0,
    tax: line.tax,
    taxRate: line.taxRate,
  }))
}
