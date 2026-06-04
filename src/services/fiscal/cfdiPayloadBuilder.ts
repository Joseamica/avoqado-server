// src/services/fiscal/cfdiPayloadBuilder.ts
import { PaymentMethod, VenueType } from '@prisma/client'
import { CreateInvoiceParams, CfdiItemInput, CfdiItemTax } from './providers/fiscal-provider.interface'
import { mapFormaPago, sectorSatDefaults } from './satCatalog'

export interface AvoqadoSaleItemInput {
  description: string
  quantity: number
  unitPriceCents: number // NET (sin IVA) — POS convention
  discountCents: number
  taxRate: number // 0.16 / 0.08 / 0
  taxExempt: boolean
  satProductKey: string | null // product override
  satUnitKey: string | null
  categoryDefaultProductKey: string | null
  categoryDefaultUnitKey: string | null
  objetoImp: string | null
}

export interface AvoqadoSaleInput {
  venueType: VenueType
  receptor: CreateInvoiceParams['receptor']
  paymentMethod: PaymentMethod
  metodoPago: 'PUE' | 'PPD'
  tipCents?: number // EXCLUDED from the CFDI (D2) — present only so callers can pass the full sale
  serie?: string
  idempotencyKey: string
  items: AvoqadoSaleItemInput[]
}

function resolveItem(it: AvoqadoSaleItemInput, venueType: VenueType): CfdiItemInput {
  const sector = sectorSatDefaults(venueType)
  const satProductKey = it.satProductKey ?? it.categoryDefaultProductKey ?? sector.productKey
  const satUnitKey = it.satUnitKey ?? it.categoryDefaultUnitKey ?? sector.unitKey
  const objetoImp = it.objetoImp ?? (it.taxExempt ? '01' : '02')
  const taxes: CfdiItemTax[] = it.taxExempt ? [] : [{ type: 'IVA', factor: 'Tasa', rate: it.taxRate, withholding: false }]
  return {
    satProductKey,
    satUnitKey,
    description: it.description,
    quantity: it.quantity,
    unitPriceCents: it.unitPriceCents, // NET — straight through
    discountCents: it.discountCents,
    objetoImp,
    taxes,
  }
}

/** Pure: Avoqado sale → connector CreateInvoiceParams. Tip is intentionally dropped (D2). */
export function buildCreateInvoiceParams(input: AvoqadoSaleInput): CreateInvoiceParams {
  return {
    receptor: input.receptor,
    items: input.items.map(it => resolveItem(it, input.venueType)),
    formaPago: mapFormaPago(input.paymentMethod),
    metodoPago: input.metodoPago,
    serie: input.serie,
    idempotencyKey: input.idempotencyKey,
  }
}
