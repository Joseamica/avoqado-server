// src/services/fiscal/cfdiPayloadBuilder.ts
import { PaymentMethod, VenueType } from '@prisma/client'
import { CreateInvoiceParams, CfdiItemInput, CfdiItemTax, GlobalInvoiceParams } from './providers/fiscal-provider.interface'
import { mapFormaPago, sectorSatDefaults } from './satCatalog'
import { splitIvaIncluded } from './ivaMath'
import type { ClosedPeriod } from './globalPeriod'

export interface AvoqadoSaleItemInput {
  description: string
  quantity: number
  /**
   * Unit price in integer cents. Interpreted per `taxIncluded`:
   *   - taxIncluded=true  → IVA-INCLUDED (gross) — Mexican POS convention (taxAmount=0 sources, e.g. TPV)
   *   - taxIncluded=false → NET (sin IVA) — separated-tax sources (reservations, pos-sync)
   */
  unitPriceCents: number
  discountCents: number
  taxRate: number // 0.16 / 0.08 / 0
  taxExempt: boolean
  /** True when unitPriceCents already includes the IVA (gross). Defaults to false (NET) when omitted. */
  taxIncluded?: boolean
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
    unitPriceCents: it.unitPriceCents, // gross or net per taxIncluded — straight through
    discountCents: it.discountCents,
    objetoImp,
    taxes,
    taxIncluded: it.taxIncluded === true,
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

/** One line per (order, tax-rate group) in the global invoice. */
export interface GlobalInvoiceLine {
  orderId: string
  orderNumber?: string | null
  /** Group total = what the customer paid for these items (IVA-included) in integer cents. */
  totalCents: number
  /** Net base in integer cents. Gross: totalCents/(1+rate) rounded. Net: the items' base. */
  subtotalCents: number
  /** Tax amount in integer cents (totalCents - subtotalCents). */
  taxCents: number
  /** c_FormaPago code for this order (used to pick the global payment_form). */
  formaPago: string
  /**
   * True when the order's prices are IVA-included (gross, taxAmount=0 — e.g. TPV). The line is then
   * sent to the PAC as the gross total with tax_included=true so the stamped total equals what was
   * paid. False/omitted → NET (send the base, PAC adds IVA) — preserves separated-tax sources.
   */
  priceIncludesIva?: boolean
  /** IVA rate for this group (0.16 / 0.08 / 0). Defaults to 0.16 when omitted (legacy lines). */
  taxRate?: number
  /** SAT ObjetoImp for this group ('02' gravado, '01' no objeto/exento). Defaults to '02'. */
  objetoImp?: string
}

/** A single order line reduced to cents, used to group an order into per-rate global lines. */
export interface GlobalLineItemInput {
  /** IVA-included amount the customer paid for this line, in integer cents. */
  grossCents: number
  /** IVA rate for the product (0.16 / 0.08 / 0). */
  taxRate: number
  /** SAT ObjetoImp ('02' gravado, '01' no objeto/exento). */
  objetoImp: string
}

/**
 * Pure. Collapses an order's items into one global line per distinct (taxRate, objetoImp) group, so
 * the factura global declares the REAL IVA of each product instead of assuming 16%. A uniform 16%
 * order → one 16% line; an exempt order → one exento line; a mixed cart → one line per rate. The
 * group's net/tax is derived from its gross so the stamped total stays equal to what was paid.
 */
export function groupOrderIntoGlobalLines(
  items: GlobalLineItemInput[],
  meta: { orderId: string; orderNumber?: string | null; formaPago: string; priceIncludesIva: boolean },
): GlobalInvoiceLine[] {
  const groups = new Map<string, { rate: number; objetoImp: string; grossCents: number }>()
  for (const it of items) {
    const key = `${it.taxRate}|${it.objetoImp}`
    const g = groups.get(key) ?? { rate: it.taxRate, objetoImp: it.objetoImp, grossCents: 0 }
    g.grossCents += it.grossCents
    groups.set(key, g)
  }
  return [...groups.values()].map(g => {
    const { netCents, taxCents } = splitIvaIncluded(g.grossCents, g.rate)
    return {
      orderId: meta.orderId,
      orderNumber: meta.orderNumber,
      totalCents: g.grossCents,
      subtotalCents: netCents,
      taxCents,
      formaPago: meta.formaPago,
      priceIncludesIva: meta.priceIncludesIva,
      taxRate: g.rate,
      objetoImp: g.objetoImp,
    }
  })
}

/**
 * Pure. Builds the GlobalInvoiceParams for the PAC call.
 *
 * One item per (order, tax-rate group) — see groupOrderIntoGlobalLines — with:
 *   - product_key 01010101  (ClaveProdServ "sin catálogo" — mandatory for factura global SAT rule)
 *   - unit_key ACT          (Actividad — generic service unit for global invoices)
 *   - price = IVA-included total (tax_included:true) for gross orders, or the NET base
 *             (tax_included:false) for separated-tax orders
 *   - tax  = the group's REAL rate (16/8/0); exento groups carry objetoImp 01 and no traslado
 *   - quantity = 1
 *
 * payment_form: if all orders share the same formaPago code, use it; otherwise use '99' (por definir).
 *
 * Money: integer-cents end-to-end (the provider adapter converts to pesos for the PAC payload).
 */
export function buildGlobalInvoiceParams(
  emisor: { lugarExpedicion: string; serie?: string | null },
  lines: GlobalInvoiceLine[],
  period: ClosedPeriod,
): GlobalInvoiceParams {
  if (lines.length === 0) throw new Error('buildGlobalInvoiceParams requires at least one line')

  const items: CfdiItemInput[] = lines.map(line => {
    const taxIncluded = line.priceIncludesIva === true
    const rate = line.taxRate ?? 0.16 // legacy lines (no rate) default to 16%
    const exempt = rate <= 0 || line.objetoImp === '01'
    return {
      satProductKey: '01010101', // ClaveProdServ genérico — SAT requires this for factura global
      satUnitKey: 'ACT', // Actividad — ClaveUnidad genérico para global
      description: 'Venta',
      quantity: 1,
      // Gross order → send the IVA-included total (PAC extracts IVA). Net order → send the base (PAC adds IVA).
      unitPriceCents: taxIncluded ? line.totalCents : line.subtotalCents,
      discountCents: 0,
      // ObjetoImp + traslado come from the products' real tax treatment, not an assumed 16%.
      objetoImp: exempt ? '01' : '02',
      taxes: exempt ? [] : [{ type: 'IVA', factor: 'Tasa', rate, withholding: false }],
      taxIncluded,
    }
  })

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
