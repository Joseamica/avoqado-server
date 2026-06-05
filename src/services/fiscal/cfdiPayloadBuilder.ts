// src/services/fiscal/cfdiPayloadBuilder.ts
import { PaymentMethod, VenueType } from '@prisma/client'
import { CreateInvoiceParams, CfdiItemInput, CfdiItemTax, GlobalInvoiceParams } from './providers/fiscal-provider.interface'
import { mapFormaPago, sectorSatDefaults } from './satCatalog'
import type { ClosedPeriod } from './globalPeriod'

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

/** One line per order in the global invoice. */
export interface GlobalInvoiceLine {
  orderId: string
  orderNumber?: string | null
  /** Order total (subtotal + tax) in integer cents. POS prices are NET → IVA is traslado. */
  totalCents: number
  /** Net amount in integer cents (totalCents / 1.16 rounded). */
  subtotalCents: number
  /** Tax amount in integer cents (totalCents - subtotalCents). */
  taxCents: number
  /** c_FormaPago code for this order (used to pick the global payment_form). */
  formaPago: string
}

/**
 * Pure. Builds the GlobalInvoiceParams for the PAC call.
 *
 * One item per order (ticket) with:
 *   - product_key 01010101  (ClaveProdServ "sin catálogo" — mandatory for factura global SAT rule)
 *   - unit_key ACT          (Actividad — generic service unit for global invoices)
 *   - price = order subtotal in PESOS (NET, tax_included:false), tax = IVA 16% traslado
 *   - quantity = 1
 *
 * payment_form: if all orders share the same formaPago code, use it; otherwise use '99' (por definir).
 *
 * Money: integer-cents end-to-end. toPesos() for the facturapi payload only.
 */
export function buildGlobalInvoiceParams(
  emisor: { lugarExpedicion: string; serie?: string | null },
  lines: GlobalInvoiceLine[],
  period: ClosedPeriod,
): GlobalInvoiceParams {
  if (lines.length === 0) throw new Error('buildGlobalInvoiceParams requires at least one line')

  const toPesos = (cents: number): number => Math.round(cents) / 100

  const items: CfdiItemInput[] = lines.map(line => ({
    satProductKey: '01010101', // ClaveProdServ genérico — SAT requires this for factura global
    satUnitKey: 'ACT', // Actividad — ClaveUnidad genérico para global
    description: 'Venta',
    quantity: 1,
    unitPriceCents: line.subtotalCents, // NET (sin IVA) — tax_included:false in the PAC call
    discountCents: 0,
    objetoImp: '02', // sí objeto de impuesto (IVA 16%)
    taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
  }))

  // Pick a single payment_form: unanimous → that code; mixed → '99' (por definir)
  const formaCodes = [...new Set(lines.map(l => l.formaPago))]
  const payment_form = formaCodes.length === 1 ? formaCodes[0] : '99'

  return {
    receptor: {
      legal_name: 'PÚBLICO EN GENERAL',
      tax_id: 'XAXX010101000',
      tax_system: '616',
      address: { zip: emisor.lugarExpedicion },
    },
    items,
    payment_form,
    use: 'S01',
    ...(emisor.serie ? { serie: emisor.serie } : {}),
    global: {
      periodicity: period.facturaPeriodicity,
      months: period.meses,
      year: period.anio,
    },
  }
}

/**
 * Verifies that the integer-cent sum across global lines cuadra al centavo.
 * subtotalCents + taxCents must equal totalCents for each line.
 * Returns the aggregated totals.
 */
export function reconcileGlobalLines(lines: GlobalInvoiceLine[]): {
  subtotalCents: number
  taxCents: number
  totalCents: number
} {
  let subtotalCents = 0
  let taxCents = 0
  let totalCents = 0
  for (const line of lines) {
    if (line.subtotalCents + line.taxCents !== line.totalCents) {
      throw new Error(
        `Global line orderId=${line.orderId}: subtotal(${line.subtotalCents}) + tax(${line.taxCents}) ≠ total(${line.totalCents})`,
      )
    }
    subtotalCents += line.subtotalCents
    taxCents += line.taxCents
    totalCents += line.totalCents
  }
  return { subtotalCents, taxCents, totalCents }
}
