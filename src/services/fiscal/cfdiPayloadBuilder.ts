// src/services/fiscal/cfdiPayloadBuilder.ts
import { PaymentMethod, VenueType } from '@prisma/client'
import {
  CreateInvoiceParams,
  CfdiItemInput,
  CfdiItemTax,
  CreditNoteParams,
  GlobalInvoiceParams,
  ReceptorInput,
} from './providers/fiscal-provider.interface'
import { mapFormaPago, sectorSatDefaults } from './satCatalog'
import { splitIvaIncluded } from './ivaMath'
import type { ClosedPeriod } from './globalPeriod'
import type { IvaTratamiento } from './ivaTratamiento'
import { impuestosSatDe } from './ivaDeRenglon'

export interface AvoqadoSaleItemInput {
  description: string
  quantity: number
  /**
   * Unit price in integer cents. Interpreted per `taxIncluded`:
   *   - taxIncluded=true  → IVA-INCLUDED (gross) — Mexican POS convention (taxAmount=0 sources, e.g. TPV)
   *   - taxIncluded=false → NET (sin IVA) — separated-tax sources (reservations, pos-sync)
   */
  unitPriceCents: number
  /**
   * D9 (IVA por producto): precio unitario en PESOS con hasta 6 decimales, sólo cuando no cae en centavos (venta por peso cuyo
   * cobro redondeó precio × kilos). Si viene, es el precio que se manda al PAC; `unitPriceCents` conserva el redondeo para los
   * lectores de antes. Ausente en todo lo demás: las entradas viejas y su huella no cambian.
   */
  unitPriceDecimal?: string
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
  /**
   * IVA del renglón (plan 3). Con él, ObjetoImp y traslados salen de `impuestosSatDe` (IVA_16 produce el
   * mismo concepto que la tupla vieja). Sin él (egreso, global de importe libre) todo queda como antes.
   */
  tratamiento?: IvaTratamiento
}

export interface AvoqadoSaleInput {
  venueType: VenueType
  receptor: CreateInvoiceParams['receptor']
  paymentMethod: PaymentMethod
  /**
   * Forma SAT declarada por el negocio en su tipo de pago, congelada en el cobro. Gana sobre
   * el mapa por método — ver `mapFormaPago`. Opcional: un cobro clásico no la trae.
   */
  tenderSatFormaPago?: string | null
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
  let objetoImp: string
  let taxes: CfdiItemTax[]
  if (it.tratamiento) {
    const sat = impuestosSatDe(it.tratamiento)
    // Un tratamiento no timbrable ya bloqueó la factura con su motivo; si aun así llegara aquí, nunca al PAC.
    if ('bloqueado' in sat) throw new Error(sat.motivo)
    objetoImp = sat.objetoImp
    taxes = sat.taxes
  } else {
    objetoImp = it.objetoImp ?? (it.taxExempt ? '01' : '02')
    taxes = it.taxExempt ? [] : [{ type: 'IVA', factor: 'Tasa', rate: it.taxRate, withholding: false }]
  }
  return {
    satProductKey,
    satUnitKey,
    description: it.description,
    quantity: it.quantity,
    unitPriceCents: it.unitPriceCents, // gross or net per taxIncluded — straight through
    ...(it.unitPriceDecimal ? { unitPriceDecimal: it.unitPriceDecimal } : {}),
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
    formaPago: mapFormaPago(input.paymentMethod, input.tenderSatFormaPago),
    metodoPago: input.metodoPago,
    serie: input.serie,
    idempotencyKey: input.idempotencyKey,
  }
}

// ─── CFDI de EGRESO (nota de crédito) ─────────────────────────────────────────

/** SAT c_UsoCFDI para una nota de crédito: "Devoluciones, descuentos o bonificaciones". */
export const CREDIT_NOTE_USO_CFDI = 'G02'
/** SAT c_TipoRelacion: "Nota de crédito de los documentos relacionados". */
export const CREDIT_NOTE_RELATIONSHIP = '01' as const
/** ClaveProdServ genérica ("no existe en el catálogo") + ClaveUnidad "Actividad". */
const CREDIT_NOTE_PRODUCT_KEY = '01010101'
const CREDIT_NOTE_UNIT_KEY = 'ACT'

/** Un renglón de la nota de crédito: importe IVA-INCLUIDO (centavos) a una tasa real. */
export interface CreditNoteLine {
  grossCents: number
  rate: number
}

export interface BuildCreditNoteInput {
  receptor: ReceptorInput & { email?: string }
  /** UUID (folio fiscal) del CFDI de ingreso que se acredita. */
  originalUuid: string
  /** Etiqueta legible de la factura original (serie+folio) — va en la descripción del concepto. */
  originalLabel: string
  formaPago: string
  metodoPago: 'PUE' | 'PPD'
  serie?: string
  idempotencyKey: string
  lines: CreditNoteLine[]
}

/**
 * Pure: renglones + factura original → `CreditNoteParams` para el PAC.
 *
 * Decisión de conceptos (documentada a propósito): **una partida por TASA de IVA**, no un
 * prorrateo renglón-por-renglón del ticket. Motivos:
 *   - el caso normal (todo al 16%) sale como UNA sola partida "Devolución sobre factura X",
 *     que es exactamente lo que pide el founder y lo que emite un portal fiscal a mano;
 *   - una devolución PARCIAL no corresponde a renglones concretos (el cliente devolvió "$50",
 *     no "media hamburguesa"), así que inventar renglones sería inventar información;
 *   - pero una cuenta con productos gravados y exentos NO puede colapsarse a una tasa sola sin
 *     declarar un IVA equivocado — de ahí la partida por tasa. Es el mismo criterio que ya usa
 *     `groupOrderIntoGlobalLines` para la factura global.
 *
 * Los importes van IVA-INCLUIDO (`taxIncluded: true`) para que el Total del egreso sea
 * EXACTAMENTE el dinero devuelto al cliente, igual que en el CFDI de ingreso.
 */
export function buildCreditNoteParams(input: BuildCreditNoteInput): CreditNoteParams {
  if (input.lines.length === 0) throw new Error('buildCreditNoteParams requiere al menos un renglón')
  const items: CfdiItemInput[] = input.lines.map(line => {
    const exempt = !Number.isFinite(line.rate) || line.rate <= 0
    return {
      satProductKey: CREDIT_NOTE_PRODUCT_KEY,
      satUnitKey: CREDIT_NOTE_UNIT_KEY,
      description: `Devolución sobre factura ${input.originalLabel}`,
      quantity: 1,
      unitPriceCents: line.grossCents,
      discountCents: 0,
      objetoImp: exempt ? '01' : '02',
      taxes: exempt ? [] : [{ type: 'IVA', factor: 'Tasa', rate: line.rate, withholding: false }],
      taxIncluded: true,
    }
  })
  return {
    receptor: { ...input.receptor, usoCfdi: CREDIT_NOTE_USO_CFDI },
    items,
    formaPago: input.formaPago,
    metodoPago: input.metodoPago,
    serie: input.serie,
    idempotencyKey: input.idempotencyKey,
    externalId: input.idempotencyKey,
    relationship: CREDIT_NOTE_RELATIONSHIP,
    relatedUuids: [input.originalUuid],
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
 * C1 (H3): el concepto de UNA línea de la global (la de hoy, sin cambiar dinero ni impuestos) con el folio del ticket en `sku`
 * (NoIdentificacion); sin folio, el id de la orden.
 */
export function itemDeLineaGlobal(line: GlobalInvoiceLine): CfdiItemInput {
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
    sku: line.orderNumber ?? line.orderId,
  }
}

/**
 * H4 (Guía de llenado del CFDI global, FormaPago: «la forma de pago con la que se liquida la mayor cantidad del pago»; empate «cuando se reciban
 * dos o más formas de pago con el mismo importe»). Ronda 1 de la T6 (I3): se suma `paidCents` de los tickets POR FORMA y gana la de mayor suma;
 * a igual suma, la forma con el ticket mayor; si también empata, la forma del ticket mayor de menor `orderId` (la guía deja elegir). Antes era la
 * forma del ticket de mayor monto: con dos tickets de $300 con tarjeta y uno de $500 en efectivo daba 01; ahora 04. '99' SÓLO con la lista vacía.
 */
export function formaPagoDeLaGlobal(tickets: Array<{ orderId: string; paidCents: number; formaPago: string }>): string {
  // C1 (Tarea 7; re-revisión de la T6): un ticket «por definir» ('99') no es una forma de pago, así que nunca decide la global si hay otra
  // forma: se deja fuera de la suma (su dinero sigue en la global). Con TODOS en '99' sale '99' y la validación previa la detiene («La forma
  // de pago no está definida»). La captura v2 ya no deja entrar esos tickets (`ticketParaGlobal`); esto es la segunda capa.
  const conForma = tickets.filter(t => t.formaPago !== '99')
  const grupos = new Map<string, { sumaCents: number; mayorCents: number; idDelMayor: string }>()
  for (const t of conForma.length ? conForma : tickets) {
    const g = grupos.get(t.formaPago)
    if (!g) grupos.set(t.formaPago, { sumaCents: t.paidCents, mayorCents: t.paidCents, idDelMayor: t.orderId })
    else {
      const mayor = t.paidCents > g.mayorCents || (t.paidCents === g.mayorCents && t.orderId < g.idDelMayor)
      grupos.set(t.formaPago, {
        sumaCents: g.sumaCents + t.paidCents,
        mayorCents: mayor ? t.paidCents : g.mayorCents,
        idDelMayor: mayor ? t.orderId : g.idDelMayor,
      })
    }
  }
  const [ganadora] = [...grupos].sort(
    ([, a], [, b]) =>
      b.sumaCents - a.sumaCents || b.mayorCents - a.mayorCents || (a.idDelMayor < b.idDelMayor ? -1 : a.idDelMayor > b.idDelMayor ? 1 : 0),
  )
  return ganadora?.[0] ?? '99'
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
 * payment_form (C1, H4; round 1 of T6, I3): the formaPago whose tickets add up to the most (see `formaPagoDeLaGlobal`), never '99'
 * just because the tickets used different methods. Each item carries its ticket folio in `sku` (H3, NoIdentificacion).
 *
 * Money: integer-cents end-to-end (the provider adapter converts to pesos for the PAC payload).
 */
export function buildGlobalInvoiceParams(
  emisor: { lugarExpedicion: string; serie?: string | null },
  lines: GlobalInvoiceLine[],
  period: ClosedPeriod,
): GlobalInvoiceParams {
  if (lines.length === 0) throw new Error('buildGlobalInvoiceParams requires at least one line')

  const items: CfdiItemInput[] = lines.map(itemDeLineaGlobal)

  // H4 (ronda 1 de la T6, I3): la forma que suma más entre los tickets (sus líneas sumadas por orden), nunca «99» por tener formas distintas.
  const porOrden = new Map<string, { orderId: string; paidCents: number; formaPago: string }>()
  for (const l of lines) {
    const t = porOrden.get(l.orderId) ?? { orderId: l.orderId, paidCents: 0, formaPago: l.formaPago }
    porOrden.set(l.orderId, { ...t, paidCents: t.paidCents + l.totalCents })
  }
  const payment_form = formaPagoDeLaGlobal([...porOrden.values()])

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
