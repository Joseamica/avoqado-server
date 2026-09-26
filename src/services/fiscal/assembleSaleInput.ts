// src/services/fiscal/assembleSaleInput.ts
import { Prisma, PaymentMethod, VenueType } from '@prisma/client'
import { AvoqadoSaleInput, AvoqadoSaleItemInput } from './cfdiPayloadBuilder'
import type { IvaTratamiento } from './ivaTratamiento'

const centsOf = (d: Prisma.Decimal): number => Math.round(Number(d) * 100)

export interface LoadedOrderItemForCfdi {
  productName: string | null
  quantity: number
  unitPrice: Prisma.Decimal // pesos — gross (IVA-included) or net per order.pricesIncludeIva
  discountAmount: Prisma.Decimal
  product: {
    satProductKey: string | null
    satUnitKey: string | null
    objetoImp: string
    taxRate: Prisma.Decimal
    category: { defaultSatProductKey: string | null; defaultSatUnitKey: string | null } | null
  } | null
  /** IVA del renglón (plan 3). Con él, el concepto toma ObjetoImp y traslados de `impuestosSatDe`. */
  tratamiento?: IvaTratamiento
}

export interface LoadedOrderForCfdi {
  venueType: VenueType
  tipAmount: Prisma.Decimal
  items: LoadedOrderItemForCfdi[]
  /**
   * True when this order's item prices are IVA-included (gross — the Mexican POS convention used by
   * TPV, where taxAmount=0). Each concepto is then stamped tax_included so the CFDI total equals what
   * the customer paid. Omitted/false → NET prices (separated-tax sources: reservations, pos-sync).
   */
  pricesIncludeIva?: boolean
  /** Rama de la factura (plan 3): todos los renglones en IVA_16, o alguno distinto. Aditivo. */
  clasificacion?: 'TODO_16' | 'MIXTA'
  /**
   * Renglones originales de la orden con su tratamiento resuelto (plan 3, Tarea 4): lo que SELLA la
   * entrada documental (`entradaDocumental.ts`). `loadOrderForCfdiFromDb` SIEMPRE lo pone (venta sin
   * renglones ⇒ `[]`); ausente sólo en bundles construidos a mano por pruebas anteriores a la Tarea 4.
   */
  renglonesOrigen?: Array<{ orderItemId: string; tratamiento: IvaTratamiento }>
  /** Contrato de precio de la orden AL MOMENTO de cargar el bundle (plan 3, Tarea 4: foto congelada). */
  contratoDePrecio?: string | null
  /** Estado de pago de la orden AL MOMENTO de cargar el bundle (plan 3, Tarea 4: foto congelada). */
  paymentStatus?: string | null
}

/**
 * El bundle REAL que arma `loadOrderForCfdiFromDb` (Tarea 4): `clasificacion` y `renglonesOrigen`
 * SIEMPRE vienen resueltos — la entrada documental nunca se sella a ciegas (`capturarEntrada` falla
 * cerrado si le falta cualquiera). Los bundles construidos a mano en pruebas anteriores a la Tarea 4
 * siguen usando `LoadedOrderForCfdi` con estos campos opcionales.
 */
export interface LoadedOrderForCfdiResuelto extends LoadedOrderForCfdi {
  clasificacion: 'TODO_16' | 'MIXTA'
  renglonesOrigen: Array<{ orderItemId: string; tratamiento: IvaTratamiento }>
}

export interface AssembleOptions {
  receptor: AvoqadoSaleInput['receptor']
  paymentMethod: PaymentMethod
  /** Forma SAT declarada por el negocio en su tipo de pago, congelada en el cobro. */
  tenderSatFormaPago?: string | null
  metodoPago: 'PUE' | 'PPD'
  serie?: string
  idempotencyKey: string
}

const DEFAULT_IVA = 0.16

/** PURE: loaded Prisma order → the 0c builder input. Decimal pesos → integer cents. */
export function assembleSaleInput(order: LoadedOrderForCfdi, opts: AssembleOptions): AvoqadoSaleInput {
  const pricesIncludeIva = order.pricesIncludeIva === true
  const items: AvoqadoSaleItemInput[] = order.items.map(it => {
    const taxRate = it.product ? Number(it.product.taxRate) : DEFAULT_IVA
    return {
      description: it.productName ?? 'Producto',
      quantity: it.quantity,
      unitPriceCents: centsOf(it.unitPrice),
      discountCents: centsOf(it.discountAmount),
      taxRate,
      taxExempt: taxRate === 0,
      // IVA-included prices (gross) → the PAC extracts the IVA so the stamped total == what was paid.
      taxIncluded: pricesIncludeIva,
      satProductKey: it.product?.satProductKey ?? null,
      satUnitKey: it.product?.satUnitKey ?? null,
      categoryDefaultProductKey: it.product?.category?.defaultSatProductKey ?? null,
      categoryDefaultUnitKey: it.product?.category?.defaultSatUnitKey ?? null,
      objetoImp: it.product?.objetoImp ?? null,
      ...(it.tratamiento ? { tratamiento: it.tratamiento } : {}),
    }
  })
  return {
    venueType: order.venueType,
    receptor: opts.receptor,
    paymentMethod: opts.paymentMethod,
    tenderSatFormaPago: opts.tenderSatFormaPago ?? null,
    metodoPago: opts.metodoPago,
    tipCents: centsOf(order.tipAmount),
    serie: opts.serie,
    idempotencyKey: opts.idempotencyKey,
    items,
  }
}
