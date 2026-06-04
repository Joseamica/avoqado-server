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
  unitPriceCents: number // NET (sin IVA)
  discountCents: number
  objetoImp: string // 01/02/03
  taxes: CfdiItemTax[]
}

export interface CreateInvoiceParams {
  receptor: ReceptorInput & { usoCfdi: string; email?: string }
  items: CfdiItemInput[]
  formaPago: string // c_FormaPago
  metodoPago: 'PUE' | 'PPD'
  serie?: string
  idempotencyKey: string
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
 * Receipts + global-invoice methods are intentionally NOT in this contract yet —
 * they arrive with the A/C issuance phases.
 */
export interface FiscalProvider {
  readonly name: string
  createOrganization(params: CreateOrgParams): Promise<CreateOrgResult>
  uploadCsd(params: UploadCsdParams): Promise<UploadCsdResult>
  validateReceptor(params: ReceptorInput): Promise<ReceptorValidationResult>
  createInvoice(params: CreateInvoiceParams): Promise<StampedInvoice>
  getInvoice(providerInvoiceId: string): Promise<StampedInvoice>
  downloadXml(providerInvoiceId: string): Promise<Buffer>
  downloadPdf(providerInvoiceId: string): Promise<Buffer>
  cancelInvoice(params: CancelInvoiceParams): Promise<CancelInvoiceResult>
}
