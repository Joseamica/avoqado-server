/**
 * Platform CFDI service — issue/list/get/cancel income CFDIs (Avoqado → customer).
 *
 * Reuses the fiscal provider engine: resolveFiscalProvider() decrypts the emisor's
 * live key and returns a FacturapiProvider; createInvoice() stamps a type-I CFDI.
 * Supports PUE and PPD (a PPD income CFDI is a normal type-I with metodoPago=PPD,
 * formaPago="99"). The complemento de pago (REP, type P) is a separate follow-up.
 *
 * Money is integer cents end-to-end (MXN). IVA is ADD-ON (not included), unlike
 * the Stripe subscriptions which are IVA-inclusive.
 */
import { Prisma, type PlatformCfdi } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import type { CfdiItemInput, CreateInvoiceParams, PaymentComplementTax } from '@/services/fiscal/providers/fiscal-provider.interface'
import { getActivePlatformEmisor, PlatformBillingError } from './platformEmisor.service'
import type {
  IssuePlatformCfdiInput,
  ListPlatformCfdisFilters,
  PlatformCfdiLineInput,
  PlatformCfdiTotals,
  RegisterPaymentInput,
} from './types'

const DEFAULT_IVA_RATE = 0.16
const MAX_PAGE_SIZE = 100

/** Compute CFDI money totals from line items. All integer cents, IVA add-on. */
export function computePlatformCfdiTotals(lines: PlatformCfdiLineInput[]): PlatformCfdiTotals {
  let subtotalCents = 0
  let discountCents = 0
  let taxCents = 0
  for (const line of lines) {
    const importe = Math.round(line.quantity * line.unitPriceCents) // cantidad × valorUnitario
    const lineDiscount = Math.round(line.discountCents ?? 0)
    const base = importe - lineDiscount
    const lineTax = line.taxExempt ? 0 : Math.round(base * (line.taxRate ?? DEFAULT_IVA_RATE))
    subtotalCents += importe
    discountCents += lineDiscount
    taxCents += lineTax
  }
  return { subtotalCents, discountCents, taxCents, totalCents: subtotalCents - discountCents + taxCents }
}

/** Map our line input to the provider's CfdiItemInput (IVA add-on). */
function toCfdiItem(line: PlatformCfdiLineInput): CfdiItemInput {
  const taxed = !line.taxExempt
  return {
    satProductKey: line.satProductKey,
    satUnitKey: line.satUnitKey,
    description: line.description,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    discountCents: line.discountCents ?? 0,
    objetoImp: taxed ? '02' : '01', // 02 = sí objeto de impuesto; 01 = no objeto
    taxes: taxed ? [{ type: 'IVA', factor: 'Tasa', rate: line.taxRate ?? DEFAULT_IVA_RATE, withholding: false }] : [],
    taxIncluded: false,
  }
}

/**
 * Issue an income CFDI to a customer. Idempotent by idempotencyKey: a repeated
 * call returns the existing row instead of double-stamping.
 */
export async function issuePlatformCfdi(input: IssuePlatformCfdiInput): Promise<PlatformCfdi> {
  if (!input.lines.length) throw new PlatformBillingError('La factura requiere al menos un concepto', 'VALIDATION')

  // Idempotency short-circuit.
  const prior = await prisma.platformCfdi.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
  if (prior) return prior

  const emisor = await getActivePlatformEmisor()
  if (!emisor) throw new PlatformBillingError('No hay emisor de plataforma configurado', 'NO_EMISOR')

  const sandbox = input.sandbox ?? false
  if (!sandbox && emisor.csdStatus !== 'ACTIVE') {
    throw new PlatformBillingError('El emisor no tiene un CSD activo; sube el sello digital antes de timbrar', 'CSD_INACTIVE')
  }

  const profile = await prisma.billingTaxProfile.findUnique({ where: { id: input.billingTaxProfileId } })
  if (!profile) throw new PlatformBillingError('Perfil fiscal del receptor no encontrado', 'NO_PROFILE')

  const totals = computePlatformCfdiTotals(input.lines)
  const usoCfdi = input.usoCfdi ?? profile.defaultUsoCfdi
  const serie = input.serie ?? emisor.serie

  // Reserve the row first (unique idempotencyKey) so concurrent retries don't double-stamp.
  let row: PlatformCfdi
  try {
    row = await prisma.platformCfdi.create({
      data: {
        platformEmisorId: emisor.id,
        billingTaxProfileId: profile.id,
        type: 'INGRESO',
        organizationId: profile.organizationId,
        venueId: profile.venueId,
        receptorRfc: profile.rfc,
        receptorNombre: profile.razonSocial,
        receptorRegimen: profile.regimenFiscal,
        receptorCp: profile.codigoPostal,
        usoCfdi,
        lines: input.lines as unknown as Prisma.InputJsonValue,
        formaPago: input.formaPago,
        metodoPago: input.metodoPago,
        subtotalCents: totals.subtotalCents,
        discountCents: totals.discountCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        status: 'STAMPING',
        serie,
        idempotencyKey: input.idempotencyKey,
        createdById: input.performedById,
      },
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const dup = await prisma.platformCfdi.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
      if (dup) return dup
    }
    throw e
  }

  // Stamp with the PAC.
  try {
    const provider = resolveFiscalProvider({ provider: emisor.provider, providerKeyEnc: emisor.providerKeyEnc }, { sandbox })
    const params: CreateInvoiceParams = {
      receptor: {
        rfc: profile.rfc,
        razonSocial: profile.razonSocial,
        regimenFiscal: profile.regimenFiscal,
        codigoPostal: profile.codigoPostal,
        usoCfdi,
        email: profile.email ?? undefined,
      },
      items: input.lines.map(toCfdiItem),
      formaPago: input.formaPago,
      metodoPago: input.metodoPago,
      serie,
      idempotencyKey: input.idempotencyKey,
      externalId: input.idempotencyKey, // deterministic orphan recovery
    }
    const stamped = await provider.createInvoice(params)
    const updated = await prisma.platformCfdi.update({
      where: { id: row.id },
      data: {
        status: 'STAMPED',
        facturapiId: stamped.providerInvoiceId,
        uuid: stamped.uuid,
        serie: stamped.serie ?? serie,
        folio: stamped.folio,
        stampedAt: stamped.stampedAt,
      },
    })
    // Best-effort: entregar el CFDI por correo al timbrar. No bloquea ni hace fallar la emisión.
    if (profile.email) void sendPlatformCfdiEmail(updated.id, profile.email, sandbox).catch(() => undefined)
    return updated
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await prisma.platformCfdi.update({
      where: { id: row.id },
      data: { status: 'STAMP_FAILED', lastError: message, attempts: { increment: 1 } },
    })
    throw new PlatformBillingError(`Error al timbrar el CFDI: ${message}`, 'PROVIDER')
  }
}

export async function listPlatformCfdis(
  filters: ListPlatformCfdisFilters,
): Promise<{ rows: PlatformCfdi[]; total: number; page: number; pageSize: number }> {
  const where: Prisma.PlatformCfdiWhereInput = {}
  if (filters.status) where.status = filters.status as Prisma.PlatformCfdiWhereInput['status']
  if (filters.type) where.type = filters.type as Prisma.PlatformCfdiWhereInput['type']
  if (filters.organizationId) where.organizationId = filters.organizationId
  if (filters.venueId) where.venueId = filters.venueId

  const page = Math.max(filters.page ?? 1, 1)
  const pageSize = Math.min(Math.max(filters.pageSize ?? 20, 1), MAX_PAGE_SIZE)

  const [rows, total] = await Promise.all([
    prisma.platformCfdi.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.platformCfdi.count({ where }),
  ])
  return { rows, total, page, pageSize }
}

export async function getPlatformCfdi(id: string): Promise<PlatformCfdi | null> {
  return prisma.platformCfdi.findUnique({ where: { id } })
}

/** Cancel a stamped CFDI. Motivo 01 (substitution) requires the substitute UUID. */
export async function cancelPlatformCfdi(
  id: string,
  motivo: '01' | '02' | '03' | '04',
  substituteUuid?: string,
  sandbox = false,
): Promise<PlatformCfdi> {
  const row = await prisma.platformCfdi.findUnique({ where: { id } })
  if (!row) throw new PlatformBillingError('CFDI no encontrado', 'NO_CFDI')
  if (row.status !== 'STAMPED') throw new PlatformBillingError('Solo se puede cancelar un CFDI timbrado', 'VALIDATION')
  if (motivo === '01' && !substituteUuid) throw new PlatformBillingError('El motivo 01 requiere el UUID que sustituye', 'VALIDATION')
  if (!row.facturapiId) throw new PlatformBillingError('El CFDI no tiene folio del proveedor', 'VALIDATION')

  const emisor = await prisma.platformEmisor.findUnique({ where: { id: row.platformEmisorId } })
  if (!emisor) throw new PlatformBillingError('Emisor no encontrado', 'NO_EMISOR')

  const provider = resolveFiscalProvider({ provider: emisor.provider, providerKeyEnc: emisor.providerKeyEnc }, { sandbox })
  const res = await provider.cancelInvoice({ providerInvoiceId: row.facturapiId, motivo, substituteUuid })

  return prisma.platformCfdi.update({
    where: { id: row.id },
    data: {
      status: 'CANCELLED',
      cancelMotivo: motivo,
      cancelSubstituteUuid: substituteUuid ?? null,
      cancelStatus: res.status,
      cancelledAt: res.cancelledAt ?? new Date(),
    },
  })
}

/** Build the FULL related-document tax breakdown (Pago 2.0), grouping lines by rate (+ exempt). */
function buildRelatedDocTaxes(lines: PlatformCfdiLineInput[]): PaymentComplementTax[] {
  const byRate = new Map<number, number>()
  let exemptBaseCents = 0
  for (const line of lines) {
    const importe = Math.round(line.quantity * line.unitPriceCents)
    const baseCents = importe - Math.round(line.discountCents ?? 0)
    if (line.taxExempt) {
      exemptBaseCents += baseCents
    } else {
      const rate = line.taxRate ?? DEFAULT_IVA_RATE
      byRate.set(rate, (byRate.get(rate) ?? 0) + baseCents)
    }
  }
  const taxes: PaymentComplementTax[] = []
  for (const [rate, baseCents] of byRate) taxes.push({ baseCents, rate, type: 'IVA', factor: 'Tasa', withholding: false })
  if (exemptBaseCents > 0) taxes.push({ baseCents: exemptBaseCents, rate: 0, type: 'IVA', factor: 'Exento', withholding: false })
  return taxes
}

/** If every line is taxed at exactly one IVA rate (no exempt), return that rate; else null. */
function singleIvaRate(lines: PlatformCfdiLineInput[]): number | null {
  const rates = new Set<number>()
  for (const line of lines) {
    if (line.taxExempt) return null
    rates.add(line.taxRate ?? DEFAULT_IVA_RATE)
  }
  return rates.size === 1 ? [...rates][0] : null
}

/**
 * Pago 2.0 DR tax breakdown for a (possibly partial) payment of `amountCents` (gross) on a
 * single-rate invoice: BaseDR = amount / (1 + rate); ImporteDR = BaseDR * rate (computed by the
 * provider). BaseDR + ImporteDR === amount, so installments always sum to the invoice total.
 */
function partialRepTaxes(amountCents: number, rate: number): PaymentComplementTax[] {
  return [{ baseCents: Math.round(amountCents / (1 + rate)), rate, type: 'IVA', factor: 'Tasa', withholding: false }]
}

/**
 * Register a payment against a PPD income CFDI by stamping a Complemento de Pago (REP, type P).
 * Supports PARCIALIDADES: pass `amountCents` for a partial payment (defaults to the full remaining
 * balance). Each payment is one REP carrying NumParcialidad / ImpSaldoAnt / ImpSaldoInsoluto and IVA
 * proportional to the amount; the parent's amountPaidCents is bumped atomically. Idempotent by
 * idempotencyKey. Partial payments require a single IVA rate; mixed/exempt invoices must be paid in full.
 */
export async function registerPlatformPayment(input: RegisterPaymentInput): Promise<PlatformCfdi> {
  const prior = await prisma.platformCfdi.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
  if (prior) return prior

  const parent = await prisma.platformCfdi.findUnique({ where: { id: input.platformCfdiId } })
  if (!parent) throw new PlatformBillingError('CFDI no encontrado', 'NO_CFDI')
  if (parent.type !== 'INGRESO') throw new PlatformBillingError('Solo las facturas de ingreso reciben complemento de pago', 'VALIDATION')
  if (parent.metodoPago !== 'PPD') throw new PlatformBillingError('Solo las facturas PPD requieren complemento de pago', 'VALIDATION')
  if (parent.status !== 'STAMPED') throw new PlatformBillingError('La factura debe estar timbrada', 'VALIDATION')
  if (!parent.uuid) throw new PlatformBillingError('La factura no tiene folio fiscal (UUID)', 'VALIDATION')

  const saldoAnteriorCents = parent.totalCents - parent.amountPaidCents
  if (saldoAnteriorCents <= 0) throw new PlatformBillingError('La factura ya está saldada', 'VALIDATION')

  const amountCents = input.amountCents ?? saldoAnteriorCents
  if (amountCents <= 0) throw new PlatformBillingError('El monto del pago debe ser mayor a 0', 'VALIDATION')
  if (amountCents > saldoAnteriorCents) throw new PlatformBillingError('El monto excede el saldo pendiente de la factura', 'VALIDATION')

  const lines = (parent.lines as unknown as PlatformCfdiLineInput[] | null) ?? []
  const rate = singleIvaRate(lines)
  const isFullSinglePayment = parent.amountPaidCents === 0 && amountCents === parent.totalCents
  let taxes: PaymentComplementTax[]
  if (rate != null) {
    taxes = partialRepTaxes(amountCents, rate)
  } else if (isFullSinglePayment) {
    taxes = buildRelatedDocTaxes(lines) // factura con IVA mixto/exento, pagada de una sola vez
  } else {
    throw new PlatformBillingError(
      'Las parcialidades solo están soportadas para facturas con una sola tasa de IVA; registra el pago total',
      'VALIDATION',
    )
  }

  const priorStampedReps = await prisma.platformCfdi.count({ where: { parentPlatformCfdiId: parent.id, type: 'PAGO', status: 'STAMPED' } })
  const installment = priorStampedReps + 1
  const saldoInsolutoCents = saldoAnteriorCents - amountCents

  const emisor = await getActivePlatformEmisor()
  if (!emisor) throw new PlatformBillingError('No hay emisor de plataforma configurado', 'NO_EMISOR')
  const sandbox = input.sandbox ?? false

  // Reserve the REP row (unique idempotencyKey) before calling the PAC.
  let row: PlatformCfdi
  try {
    row = await prisma.platformCfdi.create({
      data: {
        platformEmisorId: emisor.id,
        billingTaxProfileId: parent.billingTaxProfileId,
        type: 'PAGO',
        parentPlatformCfdiId: parent.id,
        organizationId: parent.organizationId,
        venueId: parent.venueId,
        receptorRfc: parent.receptorRfc,
        receptorNombre: parent.receptorNombre,
        receptorRegimen: parent.receptorRegimen,
        receptorCp: parent.receptorCp,
        usoCfdi: 'CP01', // CFDI tipo P → uso "Pagos"
        formaPago: input.formaPago,
        subtotalCents: 0,
        taxCents: 0,
        totalCents: 0, // CFDI tipo P lleva Total 0; el importe vive en el complemento
        status: 'STAMPING',
        serie: parent.serie,
        idempotencyKey: input.idempotencyKey,
        createdById: input.performedById,
        paymentInfo: {
          fechaPago: input.paymentDate,
          formaPago: input.formaPago,
          montoCents: amountCents,
          parcialidad: installment,
          saldoAnteriorCents,
          saldoInsolutoCents,
        } as unknown as Prisma.InputJsonValue,
      },
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const dup = await prisma.platformCfdi.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
      if (dup) return dup
    }
    throw e
  }

  try {
    const provider = resolveFiscalProvider({ provider: emisor.provider, providerKeyEnc: emisor.providerKeyEnc }, { sandbox })
    if (!provider.createPaymentComplement) throw new PlatformBillingError('El proveedor fiscal no soporta complemento de pago', 'PROVIDER')

    const stamped = await provider.createPaymentComplement({
      receptor: {
        rfc: parent.receptorRfc,
        razonSocial: parent.receptorNombre,
        regimenFiscal: parent.receptorRegimen,
        codigoPostal: parent.receptorCp,
      },
      paymentDate: new Date(input.paymentDate),
      paymentForm: input.formaPago,
      serie: parent.serie ?? undefined,
      externalId: input.idempotencyKey,
      relatedDocuments: [{ uuid: parent.uuid, amountCents, installment, lastBalanceCents: saldoAnteriorCents, taxes }],
    })

    const updated = await prisma.$transaction(async tx => {
      const rep = await tx.platformCfdi.update({
        where: { id: row.id },
        data: {
          status: 'STAMPED',
          facturapiId: stamped.providerInvoiceId,
          uuid: stamped.uuid,
          serie: stamped.serie ?? parent.serie,
          folio: stamped.folio,
          stampedAt: stamped.stampedAt,
        },
      })
      await tx.platformCfdi.update({ where: { id: parent.id }, data: { amountPaidCents: { increment: amountCents } } })
      return rep
    })
    return updated
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await prisma.platformCfdi.update({
      where: { id: row.id },
      data: { status: 'STAMP_FAILED', lastError: message, attempts: { increment: 1 } },
    })
    if (err instanceof PlatformBillingError) throw err
    throw new PlatformBillingError(`Error al timbrar el complemento de pago: ${message}`, 'PROVIDER')
  }
}

/** List the payment complements (REPs) registered against a parent income CFDI. */
export async function listPlatformCfdiPayments(parentId: string): Promise<PlatformCfdi[]> {
  return prisma.platformCfdi.findMany({ where: { parentPlatformCfdiId: parentId, type: 'PAGO' }, orderBy: { createdAt: 'asc' } })
}

/**
 * Send a stamped CFDI (PDF + XML) to the receptor by email via the PAC. Uses the
 * override email, else the receptor profile's email. Stamps emailSentAt on success.
 */
export async function sendPlatformCfdiEmail(id: string, emailOverride?: string, sandbox = false): Promise<PlatformCfdi> {
  const row = await prisma.platformCfdi.findUnique({ where: { id } })
  if (!row) throw new PlatformBillingError('CFDI no encontrado', 'NO_CFDI')
  if (row.status !== 'STAMPED' || !row.facturapiId) throw new PlatformBillingError('Solo se puede enviar un CFDI timbrado', 'VALIDATION')

  let email = emailOverride
  if (!email && row.billingTaxProfileId) {
    const profile = await prisma.billingTaxProfile.findUnique({ where: { id: row.billingTaxProfileId } })
    email = profile?.email ?? undefined
  }
  if (!email) throw new PlatformBillingError('El receptor no tiene correo registrado; captura uno o envíalo manualmente', 'VALIDATION')

  const emisor = await prisma.platformEmisor.findUnique({ where: { id: row.platformEmisorId } })
  if (!emisor) throw new PlatformBillingError('Emisor no encontrado', 'NO_EMISOR')

  const provider = resolveFiscalProvider({ provider: emisor.provider, providerKeyEnc: emisor.providerKeyEnc }, { sandbox })
  if (!provider.sendInvoiceByEmail) throw new PlatformBillingError('El proveedor fiscal no soporta envío por correo', 'PROVIDER')

  await provider.sendInvoiceByEmail(row.facturapiId, email)
  return prisma.platformCfdi.update({ where: { id: row.id }, data: { emailSentAt: new Date() } })
}

/** Fetch the stamped XML/PDF bytes from the PAC for download. */
export async function fetchPlatformCfdiArtifact(
  id: string,
  kind: 'pdf' | 'xml',
  sandbox = false,
): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  const row = await prisma.platformCfdi.findUnique({ where: { id } })
  if (!row) throw new PlatformBillingError('CFDI no encontrado', 'NO_CFDI')
  if (!row.facturapiId) throw new PlatformBillingError('El CFDI aún no está timbrado', 'VALIDATION')

  const emisor = await prisma.platformEmisor.findUnique({ where: { id: row.platformEmisorId } })
  if (!emisor) throw new PlatformBillingError('Emisor no encontrado', 'NO_EMISOR')

  const provider = resolveFiscalProvider({ provider: emisor.provider, providerKeyEnc: emisor.providerKeyEnc }, { sandbox })
  const buffer = kind === 'pdf' ? await provider.downloadPdf(row.facturapiId) : await provider.downloadXml(row.facturapiId)
  const filename = `${row.serie ?? ''}${row.folio ?? row.id}.${kind}`
  return { buffer, filename, contentType: kind === 'pdf' ? 'application/pdf' : 'application/xml' }
}
