// Provider-agnostic CFDI contract. facturapi is the first adapter (spec §7.4).
// Money is integer cents end-to-end (cuadra al centavo).

export interface CreateOrgParams {
  legalName: string // razón social
  email: string
}

export interface CreateOrgResult {
  providerOrgId: string
  liveKey: string // per-org sk_live_ — caller encrypts before persisting
  testKey: string // per-org sk_test_
}

export interface UpdateOrgLegalParams {
  providerOrgId: string
  legalName: string
  taxSystem: string // c_RegimenFiscal
  zip: string // lugar de expedición
}

export interface UploadCsdParams {
  providerOrgId: string
  cerBase64: string
  keyBase64: string
  csdPassword: string
}

export interface UploadCsdResult {
  csdExpiresAt: Date | null
}

export interface ReceptorInput {
  rfc: string
  razonSocial: string
  regimenFiscal: string // c_RegimenFiscal
  codigoPostal: string
}

export interface ReceptorValidationResult {
  valid: boolean
  reasons: string[] // human-readable, Spanish (shown to staff/customer on failure)
}

export interface CfdiItemTax {
  type: 'IVA' | 'IEPS' | 'ISR'
  factor: 'Tasa' | 'Cuota' | 'Exento'
  rate: number // e.g. 0.16
  withholding: boolean // true = retención, false = traslado
}

export interface CfdiItemInput {
  satProductKey: string // ClaveProdServ
  satUnitKey: string // ClaveUnidad
  description: string
  quantity: number
  /**
   * Unit price in integer cents. Interpreted per `taxIncluded`:
   *   - taxIncluded=true  → IVA-INCLUDED (gross) — the PAC extracts the IVA so the stamped
   *                          total equals what the customer paid (Mexican POS convention).
   *   - taxIncluded=false → NET (sin IVA) — the PAC adds the IVA on top (separated-tax sources).
   */
  unitPriceCents: number
  discountCents: number
  objetoImp: string // 01/02/03
  taxes: CfdiItemTax[]
  /** When true, `unitPriceCents` is IVA-included and the PAC must back-compute the base (tax_included). Default false. */
  taxIncluded?: boolean
}

export interface CreateInvoiceParams {
  receptor: ReceptorInput & { usoCfdi: string; email?: string }
  items: CfdiItemInput[]
  formaPago: string // c_FormaPago
  metodoPago: 'PUE' | 'PPD'
  serie?: string
  idempotencyKey: string
  /** Stamped as `external_id` on the PAC document — enables deterministic orphan lookup in reconcile. */
  externalId?: string
}

/** SAT c_Periodicidad: 01=Diario, 02=Semanal, 03=Quincenal, 04=Mensual, 05=Bimestral */
export type SatPeriodicidadCode = '01' | '02' | '03' | '04' | '05'

/** facturapi InvoicingPeriod enum values (verified against SDK enums.d.ts GlobalInvoicePeriodicity). */
export type FacturapiPeriodicity = 'day' | 'week' | 'fortnight' | 'month' | 'two_months'

export interface GlobalInvoiceParams {
  /** XAXX010101000 público-en-general receptor */
  receptor: {
    legal_name: 'PÚBLICO EN GENERAL'
    tax_id: 'XAXX010101000'
    tax_system: '616'
    address: { zip: string }
  }
  /** Factura global items — one per order/ticket */
  items: CfdiItemInput[]
  /** c_FormaPago — typically '01' (efectivo) for mixed-method global; '99' if ambiguous */
  payment_form: string
  /** Use S01 (Sin efectos fiscales) — mandatory for público en general */
  use: 'S01'
  serie?: string
  /** facturapi global period object */
  global: {
    periodicity: FacturapiPeriodicity
    months: string // SAT c_Meses code string (e.g. '05' for May, '13' for Jan+Feb bimestral)
    year: number
  }
  /** Stamped as `external_id` on the PAC document — enables deterministic orphan lookup in reconcile. */
  externalId?: string
}

export interface StampedInvoice {
  providerInvoiceId: string
  uuid: string // folio fiscal
  serie: string | null
  folio: string | null
  totalCents: number
  stampedAt: Date
  status: 'valid' | 'canceled'
}

/**
 * Lightweight projection of a PAC invoice used by the reconcile job to detect an
 * orphaned stamp (a document that exists at the PAC but was never persisted on our side).
 * Carries the few fields needed to match a stuck `Cfdi` row: total, receptor, global flag,
 * plus the identifiers required to complete the row if a match is found.
 */
export interface ProviderInvoiceSummary {
  providerInvoiceId: string
  uuid: string | null
  serie: string | null
  folio: string | null
  totalCents: number
  status: 'valid' | 'canceled'
  /** receptor RFC (tax_id) — used to match individual CFDIs by RFC, globals by XAXX010101000 */
  customerTaxId: string | null
  /** true when the PAC document is a factura global (has a global period block) */
  isGlobal: boolean
  stampedAt: Date | null
}

export interface SearchInvoicesParams {
  /** lower bound on the PAC invoice date (inclusive) */
  since: Date
  /** upper bound on the PAC invoice date (inclusive) */
  until: Date
  /** free-text search (PAC matches against receptor RFC / legal name / folio) */
  q?: string
}

export interface InvoiceSearchResult {
  invoices: ProviderInvoiceSummary[]
  /**
   * true when the PAC reported MORE results than were returned (pagination). The reconcile
   * job must NOT treat a "no match" as definitive when results were truncated — otherwise it
   * could reset a row that actually has an orphaned stamp on a later page and double-stamp it.
   */
  truncated: boolean
}

export interface CancelInvoiceParams {
  providerInvoiceId: string
  motivo: '01' | '02' | '03' | '04'
  substituteUuid?: string // required when motivo = 01
}

export interface CancelInvoiceResult {
  status: 'pending' | 'accepted' | 'canceled' | 'rejected'
  cancelledAt: Date | null
}

/**
 * A CFDI provider (PAC integration layer). facturapi is the first adapter.
 */
export interface FiscalProvider {
  readonly name: string
  createOrganization(params: CreateOrgParams): Promise<CreateOrgResult>
  updateOrgLegal(params: UpdateOrgLegalParams): Promise<void>
  uploadCsd(params: UploadCsdParams): Promise<UploadCsdResult>
  validateReceptor(params: ReceptorInput): Promise<ReceptorValidationResult>
  createInvoice(params: CreateInvoiceParams): Promise<StampedInvoice>
  /** Issues a factura global to "Público en General" (RFC XAXX010101000). */
  createGlobalInvoice(params: GlobalInvoiceParams): Promise<StampedInvoice>
  getInvoice(providerInvoiceId: string): Promise<StampedInvoice>
  /**
   * Looks up a PAC invoice by the `external_id` we stamped on it at creation time
   * (= our `idempotencyKey`). Returns the matching summary, or null when none is found.
   *
   * Contract:
   *   - A result with status 'valid' → the document is a valid stamp.
   *   - A result with status 'canceled' → a stamp happened but was later canceled; caller treats as INCONCLUSIVE.
   *   - null → no document found with that external_id (deterministic NONE for reconcile).
   *   - If the PAC returns >1 match (shouldn't happen), returns the first 'valid' one, else the first result.
   */
  findByExternalId(externalId: string): Promise<ProviderInvoiceSummary | null>
  /**
   * Searches the PAC's invoices (read-only). Used by the reconcile job to find an orphaned
   * stamp when we hold no providerInvoiceId for a stuck row. Returns lightweight summaries
   * plus a `truncated` flag so the caller can avoid resetting a row when results were paginated.
   */
  searchInvoices(params: SearchInvoicesParams): Promise<InvoiceSearchResult>
  downloadXml(providerInvoiceId: string): Promise<Buffer>
  downloadPdf(providerInvoiceId: string): Promise<Buffer>
  cancelInvoice(params: CancelInvoiceParams): Promise<CancelInvoiceResult>
  /** Timbra un recibo de NÓMINA (CFDI 4.0 tipo "N" + complemento Nómina 1.2). Opcional por proveedor. */
  createPayrollReceipt?(params: PayrollReceiptParams): Promise<StampedInvoice>
}

/** Una percepción del recibo de nómina (c_TipoPercepcion). Importes en centavos. */
export interface PayrollPercepcion {
  clave: string // c_TipoPercepcion, p.ej. '001' (sueldos)
  concepto: string
  gravadoCents: number
  exentoCents: number
}

/** Una deducción del recibo de nómina (c_TipoDeduccion). Importe en centavos. */
export interface PayrollDeduccion {
  clave: string // c_TipoDeduccion, p.ej. '002' (ISR), '001' (IMSS), '004' (otros)
  concepto: string
  importeCents: number
}

/** Un "otro pago" del recibo (c_TipoOtroPago). El subsidio para el empleo va aquí (clave '002'). */
export interface PayrollOtroPago {
  clave: string // c_TipoOtroPago, p.ej. '002' (subsidio para el empleo)
  concepto: string
  importeCents: number
  /** Si es subsidio (clave 002): el subsidio CAUSADO (SAT lo exige en el nodo SubsidioAlEmpleo). */
  subsidioCausadoCents?: number
}

export interface PayrollReceiptReceptor {
  rfc: string
  nombre: string
  curp?: string | null
  numSeguridadSocial?: string | null
  fechaInicioRelLaboral?: string | null // YYYY-MM-DD
  tipoContrato: string // c_TipoContrato
  tipoRegimen: string // c_TipoRegimenContratacion
  numEmpleado: string
  periodicidadPago: string // c_PeriodicidadPago (02 semanal, 03 quincenal, 04 mensual)
  claveEntFed: string // c_Estado
  salarioBaseCotAporCents?: number | null
  salarioDiarioIntegradoCents?: number | null
  puesto?: string | null
  codigoPostal: string // CP del receptor (lo exige el PAC para el customer)
}

export interface PayrollReceiptParams {
  receptor: PayrollReceiptReceptor
  registroPatronal?: string | null
  tipoNomina: 'O' | 'E' // ordinaria / extraordinaria
  fechaPago: string // YYYY-MM-DD
  fechaInicialPago: string
  fechaFinalPago: string
  numDiasPagados: number
  percepciones: PayrollPercepcion[]
  deducciones: PayrollDeduccion[]
  otrosPagos: PayrollOtroPago[]
  idempotencyKey: string
}
