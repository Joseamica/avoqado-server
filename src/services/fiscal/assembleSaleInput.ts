// src/services/fiscal/assembleSaleInput.ts
import { Prisma, PaymentMethod, VenueType } from '@prisma/client'
import { AvoqadoSaleInput, AvoqadoSaleItemInput } from './cfdiPayloadBuilder'

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
}

export interface AssembleOptions {
  receptor: AvoqadoSaleInput['receptor']
  paymentMethod: PaymentMethod
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
    }
  })
  return {
    venueType: order.venueType,
    receptor: opts.receptor,
    paymentMethod: opts.paymentMethod,
    metodoPago: opts.metodoPago,
    tipCents: centsOf(order.tipAmount),
    serie: opts.serie,
    idempotencyKey: opts.idempotencyKey,
    items,
  }
}
