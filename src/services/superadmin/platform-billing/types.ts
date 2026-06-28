/**
 * Platform Billing CFDI — shared types.
 *
 * "Platform billing" = Avoqado (the company) issuing CFDIs to ITS OWN customers
 * (orgs, venues, or external/standalone buyers) for the subscription fee, setup,
 * TPV hardware sales, etc. Distinct from the tenant engine (src/services/fiscal/*)
 * where a venue invoices its own consumers.
 *
 * Money is ALWAYS integer cents, MXN (mirrors the Cfdi model). Never float/pesos.
 */

export type BillingCustomerKind = 'ORGANIZATION' | 'VENUE' | 'STANDALONE'

/** A single line item on an income CFDI. */
export interface PlatformCfdiLineInput {
  description: string
  /** SAT c_ClaveProdServ (e.g. "81161700" software services, terminal hardware for TPV). */
  satProductKey: string
  /** SAT c_ClaveUnidad (e.g. "E48" Servicio, "H87" Pieza). */
  satUnitKey: string
  quantity: number
  /** Unit price in integer cents, BEFORE tax (IVA is added on top). */
  unitPriceCents: number
  /** Line-level discount in integer cents. Default 0. */
  discountCents?: number
  /** IVA rate as a fraction (e.g. 0.16). Defaults to 0.16. Ignored when taxExempt. */
  taxRate?: number
  /** When true, the line is IVA-exempt (objetoImp "01", no taxes). */
  taxExempt?: boolean
}

/** Computed money totals for an income CFDI, all in integer cents. */
export interface PlatformCfdiTotals {
  subtotalCents: number
  discountCents: number
  taxCents: number
  totalCents: number
}

export interface UpsertEmisorInput {
  rfc: string
  legalName: string
  regimenFiscal: string
  lugarExpedicion: string
  serie?: string
  defaultUsoCfdi?: string | null
}

export interface UpsertTaxProfileInput {
  customerType: BillingCustomerKind
  organizationId?: string | null
  venueId?: string | null
  /** Label for STANDALONE receptors not linked to an org/venue (e.g. "Venta TPV - Juan Pérez"). */
  displayName?: string | null
  rfc: string
  razonSocial: string
  regimenFiscal: string
  codigoPostal: string
  defaultUsoCfdi?: string
  email?: string | null
  performedById?: string | null
}

export interface IssuePlatformCfdiInput {
  /** The receptor's tax profile (resolved/created by the controller before issuing). */
  billingTaxProfileId: string
  lines: PlatformCfdiLineInput[]
  /** SAT c_FormaPago (e.g. "01" efectivo, "03" transferencia, "04" tarjeta, "99" PPD). */
  formaPago: string
  metodoPago: 'PUE' | 'PPD'
  /** Overrides the emisor's default serie. */
  serie?: string
  /** Overrides the receptor profile's default usoCfdi. */
  usoCfdi?: string
  /** Caller-supplied idempotency key — prevents double-stamping on retry. */
  idempotencyKey: string
  /** Staff who issued it (authContext.userId). */
  performedById: string
  /** When true, uses FACTURAPI_TEST_KEY (free, non-fiscal test stamp). Default false. */
  sandbox?: boolean
}

export interface ListPlatformCfdisFilters {
  status?: string
  type?: string
  organizationId?: string
  venueId?: string
  page?: number
  pageSize?: number
}
