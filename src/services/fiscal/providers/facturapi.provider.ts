import Facturapi from 'facturapi'
import logger from '../../../config/logger'
import {
  CancelInvoiceParams,
  CancelInvoiceResult,
  CreateInvoiceParams,
  CreateOrgParams,
  CreateOrgResult,
  FiscalProvider,
  ReceptorInput,
  ReceptorValidationResult,
  StampedInvoice,
  UpdateOrgLegalParams,
  UploadCsdParams,
  UploadCsdResult,
} from './fiscal-provider.interface'

const toPesos = (cents: number): number => Math.round(cents) / 100
const toCents = (pesos: number): number => Math.round(pesos * 100)

/** facturapi adapter. Instantiate per-emisor with that org's secret key (or the test key in sandbox). */
export class FacturapiProvider implements FiscalProvider {
  readonly name = 'facturapi'
  private client: Facturapi

  constructor(apiKey: string) {
    if (!apiKey) throw new Error('FacturapiProvider requires an API key')
    this.client = new Facturapi(apiKey)
  }

  async createOrganization(params: CreateOrgParams): Promise<CreateOrgResult> {
    // organizations.create() returns Organization (no api keys in the response).
    // Retrieve the keys via separate calls after creation.
    const org = await this.client.organizations.create({ name: params.legalName })
    const [liveKey, testKey] = await Promise.all([
      this.client.organizations.renewLiveApiKey(org.id),
      this.client.organizations.getTestApiKey(org.id),
    ])
    return { providerOrgId: org.id, liveKey, testKey }
  }

  /**
   * Updates the org's legal information in facturapi.
   * SDK method confirmed: organizations.updateLegal(id, data) — see node_modules/facturapi/dist/resources/organizations.d.ts
   */
  async updateOrgLegal(params: UpdateOrgLegalParams): Promise<void> {
    await this.client.organizations.updateLegal(params.providerOrgId, {
      legal_name: params.legalName,
      tax_system: params.taxSystem,
      address: { zip: params.zip },
    })
  }

  async uploadCsd(params: UploadCsdParams): Promise<UploadCsdResult> {
    // organizations.uploadCertificate(id, cerFile, keyFile, password) — 4 positional args.
    // BinaryInput accepts Buffer (Uint8Array) directly.
    const org = await this.client.organizations.uploadCertificate(
      params.providerOrgId,
      Buffer.from(params.cerBase64, 'base64'),
      Buffer.from(params.keyBase64, 'base64'),
      params.csdPassword,
    )
    const expiresAt = org.certificate?.expires_at ?? null
    return { csdExpiresAt: expiresAt ? new Date(expiresAt) : null }
  }

  async validateReceptor(params: ReceptorInput): Promise<ReceptorValidationResult> {
    const reasons: string[] = []
    if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i.test(params.rfc)) reasons.push('El RFC no tiene un formato válido.')
    if (!/^\d{5}$/.test(params.codigoPostal)) reasons.push('El código postal debe tener 5 dígitos.')
    if (!params.razonSocial?.trim()) reasons.push('La razón social es obligatoria.')
    if (!params.regimenFiscal?.trim()) reasons.push('El régimen fiscal es obligatorio.')
    // Format-level validation only here; the SDK will reject at createInvoice() time if SAT
    // rejects the receptor data (e.g. RFC not found in registry, mismatched regimenFiscal).
    return { valid: reasons.length === 0, reasons }
  }

  async createInvoice(params: CreateInvoiceParams): Promise<StampedInvoice> {
    const payload = {
      customer: {
        legal_name: params.receptor.razonSocial,
        tax_id: params.receptor.rfc,
        tax_system: params.receptor.regimenFiscal,
        address: { zip: params.receptor.codigoPostal },
        email: params.receptor.email,
      },
      use: params.receptor.usoCfdi,
      payment_form: params.formaPago,
      payment_method: params.metodoPago,
      series: params.serie,
      // NOTE: facturapi rejects idempotency fields on invoices.create (neither query `idempotency_key`
      // nor body `i_key` are accepted inputs — verified live in sandbox). Idempotency is enforced at
      // our service layer via the unique `Cfdi.idempotencyKey` (pre-check before calling the PAC).
      // `params.idempotencyKey` stays in the interface for that orchestration use; not forwarded here.
      items: params.items.map(it => ({
        quantity: it.quantity,
        discount: toPesos(it.discountCents),
        product: {
          description: it.description,
          product_key: it.satProductKey,
          unit_key: it.satUnitKey,
          price: toPesos(it.unitPriceCents), // NET pesos (tax_included: false)
          tax_included: false,
          taxes: it.taxes.map(t => ({
            type: t.type,
            rate: t.rate,
            factor: t.factor,
            withholding: t.withholding,
          })),
        },
      })),
    }
    try {
      const inv = await this.client.invoices.create(payload)
      return this.toStamped(inv)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`[facturapi] createInvoice failed: ${message}`)
      throw err
    }
  }

  async getInvoice(providerInvoiceId: string): Promise<StampedInvoice> {
    const inv = await this.client.invoices.retrieve(providerInvoiceId)
    return this.toStamped(inv)
  }

  async downloadXml(providerInvoiceId: string): Promise<Buffer> {
    const stream = await this.client.invoices.downloadXml(providerInvoiceId)
    return this.binaryDownloadToBuffer(stream)
  }

  async downloadPdf(providerInvoiceId: string): Promise<Buffer> {
    const stream = await this.client.invoices.downloadPdf(providerInvoiceId)
    return this.binaryDownloadToBuffer(stream)
  }

  async cancelInvoice(params: CancelInvoiceParams): Promise<CancelInvoiceResult> {
    // invoices.cancel returns the full Invoice object (not a custom cancel result).
    // cancellation_status is a CancellationStatus enum on the Invoice.
    const opts: { motive: string; substitution?: string } = { motive: params.motivo }
    if (params.substituteUuid) opts.substitution = params.substituteUuid
    const inv = await this.client.invoices.cancel(params.providerInvoiceId, opts as Parameters<typeof this.client.invoices.cancel>[1])
    const rawStatus = inv.cancellation_status as string
    const status = this.mapCancellationStatus(rawStatus)
    return {
      status,
      cancelledAt: status === 'canceled' || status === 'accepted' ? new Date() : null,
    }
  }

  private mapCancellationStatus(raw: string): CancelInvoiceResult['status'] {
    switch (raw) {
      case 'accepted':
        return 'accepted'
      case 'rejected':
        return 'rejected'
      case 'pending':
      case 'verifying':
        return 'pending'
      case 'canceled':
      case 'none':
      default:
        // If the invoice status itself is canceled, treat as canceled
        return 'canceled'
    }
  }

  private toStamped(inv: Awaited<ReturnType<typeof this.client.invoices.retrieve>>): StampedInvoice {
    return {
      providerInvoiceId: inv.id,
      uuid: inv.uuid,
      serie: inv.series ?? null,
      folio: inv.folio_number != null ? String(inv.folio_number) : null,
      totalCents: toCents(Number(inv.total ?? 0)),
      stampedAt: inv.stamp?.date ? new Date(inv.stamp.date) : new Date(),
      status: inv.status === 'canceled' ? 'canceled' : 'valid',
    }
  }

  private async binaryDownloadToBuffer(download: Awaited<ReturnType<typeof this.client.invoices.downloadXml>>): Promise<Buffer> {
    // BinaryDownload = Blob | NodeLikeReadableStream
    if (Buffer.isBuffer(download)) return download
    // Handle Blob (browser or Node 18+)
    if (typeof (download as Blob).arrayBuffer === 'function') {
      const ab = await (download as Blob).arrayBuffer()
      return Buffer.from(ab)
    }
    // Handle Node.js readable stream
    const chunks: Buffer[] = []
    const stream = download as NodeJS.ReadableStream
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    return Buffer.concat(chunks)
  }
}
