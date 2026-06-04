// src/services/fiscal/cfdi.service.ts
import { CsdStatus, FiscalProviderType, PaymentMethod, VenueType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { buildStoragePath, uploadFileToStorage } from '../storage.service'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import { buildCreateInvoiceParams } from './cfdiPayloadBuilder'
import { validateBeforeStamp } from './cfdiValidation'
import { assembleSaleInput, LoadedOrderForCfdi } from './assembleSaleInput'

export interface IssueReceptor {
  rfc: string
  razonSocial: string
  regimenFiscal: string
  codigoPostal: string
  usoCfdi: string
  email?: string
}

export interface LoadedOrderBundle {
  venueId: string
  venueSlug: string
  venueType: VenueType
  emisor: { id: string; provider: FiscalProviderType; providerKeyEnc: string | null; csdStatus: CsdStatus; serie: string | null }
  paymentMethod: PaymentMethod
  metodoPago: 'PUE' | 'PPD'
  subtotalCents: number
  taxCents: number
  totalCents: number
  order: LoadedOrderForCfdi
}

export interface IssueCfdiDeps {
  findExistingCfdi: (idempotencyKey: string) => Promise<any | null>
  loadOrderForCfdi: (orderId: string) => Promise<LoadedOrderBundle | null>
  resolveProvider: typeof resolveFiscalProvider
  storeArtifact: (buffer: Buffer, path: string, contentType: string) => Promise<string>
  persistCfdi: (data: Record<string, any>) => Promise<any>
}

export interface IssueCfdiResult {
  status: 'STAMPED' | 'VALIDATION_FAILED' | 'STAMP_FAILED'
  cfdi: any
  reasons?: string[]
}

export async function issueCfdiForOrder(
  params: { orderId: string; receptor: IssueReceptor; sandbox: boolean; flow?: 'STAFF_B' | 'AUTOFACTURA_A' },
  deps: IssueCfdiDeps = defaultDeps,
): Promise<IssueCfdiResult> {
  const idempotencyKey = `cfdi-order-${params.orderId}`

  // 1. Idempotency — never double-stamp (facturapi has no idempotency; we own it)
  const existing = await deps.findExistingCfdi(idempotencyKey)
  if (existing && existing.status === 'STAMPED') return { status: 'STAMPED', cfdi: existing }

  // 2. Load
  const bundle = await deps.loadOrderForCfdi(params.orderId)
  if (!bundle) throw new Error(`Order ${params.orderId} not found or has no fiscal emisor configured`)

  // 3. Assemble + build
  const saleInput = assembleSaleInput(bundle.order, {
    receptor: params.receptor,
    paymentMethod: bundle.paymentMethod,
    metodoPago: bundle.metodoPago,
    serie: bundle.emisor.serie ?? undefined,
    idempotencyKey,
  })
  const invoiceParams = buildCreateInvoiceParams(saleInput)

  // 4. Validate (D1) — never send garbage to the PAC
  const validation = validateBeforeStamp({
    csdStatus: bundle.emisor.csdStatus,
    formaPago: invoiceParams.formaPago,
    receptor: { ...params.receptor },
    items: invoiceParams.items,
    expectedSubtotalCents: bundle.subtotalCents,
    expectedTaxCents: bundle.taxCents,
    expectedTotalCents: bundle.totalCents,
  })
  if (!validation.valid) {
    const cfdi = await deps.persistCfdi(
      baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'VALIDATION_FAILED', { lastError: validation.reasons.join(' | ') }),
    )
    return { status: 'VALIDATION_FAILED', cfdi, reasons: validation.reasons }
  }

  // 5. Stamp via the connector
  const provider = deps.resolveProvider(bundle.emisor as any, { sandbox: params.sandbox })
  let stamped
  try {
    stamped = await provider.createInvoice(invoiceParams)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi] stamp failed for order ${params.orderId}: ${message}`)
    const cfdi = await deps.persistCfdi(baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'STAMP_FAILED', { lastError: message }))
    return { status: 'STAMP_FAILED', cfdi }
  }

  // 6. Store XML + PDF
  const [xmlBuf, pdfBuf] = await Promise.all([
    provider.downloadXml(stamped.providerInvoiceId),
    provider.downloadPdf(stamped.providerInvoiceId),
  ])
  const base = `venues/${bundle.venueSlug}/cfdi/${stamped.uuid}`
  const [xmlUrl, pdfUrl] = await Promise.all([
    deps.storeArtifact(xmlBuf, buildStoragePath(`${base}.xml`), 'application/xml'),
    deps.storeArtifact(pdfBuf, buildStoragePath(`${base}.pdf`), 'application/pdf'),
  ])

  // 7. Persist STAMPED
  const cfdi = await deps.persistCfdi(
    baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'STAMPED', {
      facturapiId: stamped.providerInvoiceId,
      uuid: stamped.uuid,
      serie: stamped.serie,
      folio: stamped.folio,
      stampedAt: stamped.stampedAt,
      xmlUrl,
      pdfUrl,
    }),
  )
  return { status: 'STAMPED', cfdi }
}

function baseCfdiData(
  params: { orderId: string; receptor: IssueReceptor; flow?: string },
  bundle: LoadedOrderBundle,
  idempotencyKey: string,
  invoiceParams: ReturnType<typeof buildCreateInvoiceParams>,
  status: string,
  extra: Record<string, any>,
) {
  return {
    venueId: bundle.venueId,
    fiscalEmisorId: bundle.emisor.id,
    orderId: params.orderId,
    flow: params.flow ?? 'STAFF_B',
    status,
    idempotencyKey,
    receptorRfc: params.receptor.rfc,
    receptorNombre: params.receptor.razonSocial,
    receptorRegimen: params.receptor.regimenFiscal,
    receptorCp: params.receptor.codigoPostal,
    usoCfdi: params.receptor.usoCfdi,
    formaPago: invoiceParams.formaPago,
    metodoPago: invoiceParams.metodoPago,
    subtotalCents: bundle.subtotalCents,
    taxCents: bundle.taxCents,
    totalCents: bundle.totalCents,
    ...extra,
  }
}

// ─── real default deps (DB + storage). Tests inject their own. ───
const defaultDeps: IssueCfdiDeps = {
  findExistingCfdi: idempotencyKey => prisma.cfdi.findUnique({ where: { idempotencyKey } }),
  storeArtifact: (buffer, path, contentType) => uploadFileToStorage(buffer, path, contentType),
  resolveProvider: resolveFiscalProvider,
  persistCfdi: data =>
    prisma.cfdi.upsert({
      where: { idempotencyKey: data.idempotencyKey },
      create: data as any,
      update: { status: data.status, lastError: data.lastError ?? null, attempts: { increment: 1 }, ...stampedFields(data) },
    }),
  loadOrderForCfdi: async orderId => {
    // Tenant-safe load: order + items + product(+category) + venue + the emisor for this venue.
    // Schema-verified field names:
    //   Order → venue (slug, type, fiscalEmisors), payments (method), items, subtotal, taxAmount, total, tipAmount
    //   OrderItem → productName, quantity, unitPrice, discountAmount, product → { satProductKey, satUnitKey, objetoImp, taxRate, category }
    //   MenuCategory → defaultSatProductKey, defaultSatUnitKey
    //   Payment → method  (NOT paymentMethod — schema field is "method")
    //   Venue → fiscalEmisors (relation name at schema line 455)
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        venueId: true,
        subtotal: true,
        taxAmount: true,
        total: true,
        tipAmount: true,
        venue: {
          select: {
            slug: true,
            type: true,
            fiscalEmisors: {
              take: 1,
              select: { id: true, provider: true, providerKeyEnc: true, csdStatus: true, serie: true },
            },
          },
        },
        payments: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: { method: true },
        },
        items: {
          select: {
            productName: true,
            quantity: true,
            unitPrice: true,
            discountAmount: true,
            product: {
              select: {
                satProductKey: true,
                satUnitKey: true,
                objetoImp: true,
                taxRate: true,
                category: {
                  select: { defaultSatProductKey: true, defaultSatUnitKey: true },
                },
              },
            },
          },
        },
      },
    })
    if (!order || !order.venue.fiscalEmisors[0]) return null
    const peso = (d: any) => Math.round(Number(d) * 100)
    return {
      venueId: order.venueId,
      venueSlug: order.venue.slug,
      venueType: order.venue.type,
      emisor: order.venue.fiscalEmisors[0],
      paymentMethod: order.payments[0]?.method ?? 'CASH',
      metodoPago: 'PUE', // POS = PUE (PPD/REP deferred)
      subtotalCents: peso(order.subtotal),
      taxCents: peso(order.taxAmount),
      totalCents: peso(order.total),
      order: { venueType: order.venue.type, tipAmount: order.tipAmount, items: order.items as any },
    }
  },
}

function stampedFields(data: Record<string, any>) {
  const keys = ['facturapiId', 'uuid', 'serie', 'folio', 'stampedAt', 'xmlUrl', 'pdfUrl'] as const
  const out: Record<string, any> = {}
  for (const k of keys) if (data[k] !== undefined) out[k] = data[k]
  return out
}
