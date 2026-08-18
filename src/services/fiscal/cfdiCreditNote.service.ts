// src/services/fiscal/cfdiCreditNote.service.ts
//
// CFDI de EGRESO (nota de crédito) por un REEMBOLSO — emisión MANUAL, nunca automática.
//
// 🔴 Decisión del founder (2026-08-18), alineada con el mercado y con el SAT:
//   - Tras un reembolso la VENTA ORIGINAL NO SE MODIFICA (Toast documenta que `totalAmount`
//     no lo afectan los reembolsos; Square crea una orden de devolución aparte; Clip emite
//     una transacción nueva).
//   - El CFDI de ingreso original NO SE CANCELA. Una factura ya timbrada y pagada no se
//     "corrige" borrándola: el comprobante de la devolución es un documento NUEVO, tipo
//     EGRESO, RELACIONADO al original (TipoRelacion 01 "Nota de crédito de los documentos
//     relacionados", uso G02 "Devoluciones, descuentos o bonificaciones").
//   - Se emite con un BOTÓN. Nunca en automático: timbrar es irreversible (una nota de
//     crédito equivocada sólo se arregla cancelándola ante el SAT) y hay reembolsos que el
//     negocio NO quiere amparar fiscalmente todavía.
//
// Idempotencia: por `refundPaymentId`, vía el único `Cfdi.idempotencyKey`. Dos clics del
// mismo botón NO producen dos notas de crédito.

import { CsdStatus, PaymentMethod, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { buildStoragePath, uploadFileToStorage } from '../storage.service'
import { logAction as defaultLogAction } from '../dashboard/activity-log.service'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import { buildCreditNoteParams, CREDIT_NOTE_USO_CFDI, CreditNoteLine } from './cfdiPayloadBuilder'
import { validateBeforeStamp } from './cfdiValidation'
import { allocateByWeights, splitIvaByRate } from './ivaMath'
import { mapFormaPago } from './satCatalog'
import { STAMPING_TTL_MS } from './cfdi.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

/** El CFDI de ingreso que se va a acreditar (snapshot de la fila `Cfdi`). */
export interface OriginalCfdiForCreditNote {
  id: string
  uuid: string
  serie: string | null
  folio: string | null
  status: string
  cancelStatus: string | null
  subtotalCents: number
  taxCents: number
  totalCents: number
  formaPago: string
  metodoPago: string
  receptorRfc: string
  receptorNombre: string
  receptorRegimen: string
  receptorCp: string
  receptorEmail?: string | null
  fiscalEmisor: { id: string; provider: string; providerKeyEnc: string | null; csdStatus: CsdStatus; serie: string | null }
}

export interface LoadedRefundForCreditNote {
  venueId: string
  venueSlug: string
  refund: {
    id: string
    orderId: string
    type: string | null
    status: string
    /**
     * Parte de MERCANCÍA del reembolso, en centavos POSITIVOS.
     * 🔴 La propina va aparte a propósito: NUNCA formó parte del CFDI (`assembleSaleInput`
     * la excluye), así que acreditarla inventaría un importe que el SAT nunca vio.
     */
    salesRefundCents: number
    tipRefundCents: number
    method: PaymentMethod
    tenderSatFormaPago: string | null
  }
  /** `null` cuando la venta no tiene un CFDI de ingreso timbrado y vigente. */
  original: OriginalCfdiForCreditNote | null
  /** Gross IVA-incluido de la orden agrupado por TASA real — para repartir el IVA del egreso. */
  grossByRate: { rate: number; grossCents: number }[]
  /** Σ totalCents de las notas de crédito ya timbradas contra esa misma venta. */
  alreadyCreditedCents: number
}

export interface EmitRefundCreditNoteParams {
  venueId: string
  refundPaymentId: string
  sandbox: boolean
  requestedByStaffId?: string | null
}

export interface EmitRefundCreditNoteDeps {
  findExistingCfdi: (idempotencyKey: string) => Promise<any | null>
  loadRefundForCreditNote: (venueId: string, refundPaymentId: string) => Promise<LoadedRefundForCreditNote | null>
  resolveProvider: typeof resolveFiscalProvider
  storeArtifact: (buffer: Buffer, path: string, contentType: string) => Promise<string>
  /** Reserva la llave de idempotencia ANTES del PAC (INSERT; lanza P2002 si ya existe). */
  reserveCfdi: (data: Record<string, any>) => Promise<any>
  persistCfdi: (data: Record<string, any>) => Promise<any>
  logAction: (params: Record<string, any>) => void
}

export interface EmitRefundCreditNoteResult {
  status: 'STAMPED' | 'VALIDATION_FAILED' | 'STAMP_FAILED'
  cfdi: any
  reasons?: string[]
}

/** Llave de idempotencia de la nota de crédito de UN reembolso. */
export function creditNoteIdempotencyKey(refundPaymentId: string): string {
  return `cfdi-refund-${refundPaymentId}`
}

// ─── Precondiciones (una sola definición, compartida por el botón y por el timbrado) ──

export type CreditNoteBlockReason =
  | 'NOT_A_REFUND'
  | 'REFUND_NOT_COMPLETED'
  | 'NO_ORIGINAL_CFDI'
  | 'ORIGINAL_CANCELLED'
  | 'TIP_ONLY'
  | 'EXCEEDS_REMAINING'

export interface CreditNoteEligibility {
  eligible: boolean
  reason: CreditNoteBlockReason | null
  /** Texto en español, listo para pintarse en la UI o devolverse como error. */
  message: string | null
}

const OK: CreditNoteEligibility = { eligible: true, reason: null, message: null }

/**
 * PURA. ¿Se puede emitir la nota de crédito de este reembolso?
 *
 * 🔴 Una sola definición a propósito: el botón del dashboard y el timbrado real leen ESTO.
 * Si la UI y el servicio evaluaran por su cuenta, el botón se vería habilitado y el clic
 * fallaría — o peor, al revés: escondido cuando sí procedía.
 */
export function checkCreditNoteEligibility(loaded: LoadedRefundForCreditNote): CreditNoteEligibility {
  const { refund, original } = loaded
  if (refund.type !== 'REFUND') {
    return {
      eligible: false,
      reason: 'NOT_A_REFUND',
      message: 'El pago indicado no es un reembolso; una nota de crédito sólo ampara devoluciones.',
    }
  }
  if (refund.status !== 'COMPLETED') {
    return {
      eligible: false,
      reason: 'REFUND_NOT_COMPLETED',
      message: 'El reembolso no está completado; no se puede facturar una devolución que aún no salió.',
    }
  }
  if (!original) {
    return {
      eligible: false,
      reason: 'NO_ORIGINAL_CFDI',
      message:
        'La venta no tiene una factura (CFDI de ingreso) timbrada, así que no hay nada que acreditar. Si el cliente necesita comprobante de la devolución, primero se factura la venta.',
    }
  }
  if (original.cancelStatus === 'CANCELLED' || original.cancelStatus === 'ACCEPTED' || original.status === 'CANCELLED') {
    return {
      eligible: false,
      reason: 'ORIGINAL_CANCELLED',
      message: 'La factura original fue cancelada; una nota de crédito no aplica sobre un CFDI cancelado.',
    }
  }
  if (refund.salesRefundCents <= 0) {
    return {
      eligible: false,
      reason: 'TIP_ONLY',
      message: 'Este reembolso sólo devolvió propina, y la propina nunca formó parte del CFDI. No hay importe que acreditar fiscalmente.',
    }
  }
  const remainingCents = original.totalCents - loaded.alreadyCreditedCents
  if (refund.salesRefundCents > remainingCents) {
    return {
      eligible: false,
      reason: 'EXCEEDS_REMAINING',
      message: `El importe a acreditar ($${(refund.salesRefundCents / 100).toFixed(2)}) excede el saldo de la factura original ($${(
        remainingCents / 100
      ).toFixed(2)}).`,
    }
  }
  return OK
}

// ─── Reparto puro del importe acreditado entre las tasas reales ───────────────

/**
 * PURA. Reparte `salesRefundCents` (IVA-incluido) entre las TASAS reales de la venta, en
 * proporción a lo que cada tasa pesaba en la orden.
 *
 * Por qué proporcional y no "primero lo gravado": una devolución parcial no se refiere a
 * renglones concretos ("devuélveme $50"), así que el único reparto defendible es el que
 * conserva la mezcla fiscal de la venta. Con `allocateByWeights` la suma de las partes es
 * EXACTAMENTE el importe devuelto (el residuo lo absorbe el bucket más grande), así que la
 * nota de crédito cuadra al centavo con el dinero que salió de la caja.
 *
 * Sin desglose (venta de importe libre, sin renglones) → una sola partida a `fallbackRate`.
 */
export function buildCreditNoteLines(
  salesRefundCents: number,
  grossByRate: { rate: number; grossCents: number }[],
  fallbackRate: number,
): CreditNoteLine[] {
  const meaningful = grossByRate.filter(r => r.grossCents > 0)
  if (meaningful.length === 0) return [{ grossCents: salesRefundCents, rate: fallbackRate }]
  const alloc = allocateByWeights(
    salesRefundCents,
    meaningful.map(r => r.grossCents),
  )
  return meaningful.map((r, i) => ({ grossCents: alloc[i], rate: r.rate })).filter(l => l.grossCents > 0)
}

// ─── Servicio ─────────────────────────────────────────────────────────────────

export async function emitRefundCreditNote(
  params: EmitRefundCreditNoteParams,
  deps: EmitRefundCreditNoteDeps = defaultDeps,
): Promise<EmitRefundCreditNoteResult> {
  const idempotencyKey = creditNoteIdempotencyKey(params.refundPaymentId)

  // 1. Idempotencia — una nota de crédito ya timbrada es un éxito, no un error.
  const existing = await deps.findExistingCfdi(idempotencyKey)
  if (existing && existing.status === 'STAMPED') return { status: 'STAMPED', cfdi: existing }

  // 2. Carga + aislamiento por tenant (el loader filtra por venueId).
  const loaded = await deps.loadRefundForCreditNote(params.venueId, params.refundPaymentId)
  if (!loaded) throw new Error('Reembolso no encontrado')

  const { refund } = loaded

  // 3. Precondiciones de NEGOCIO — la MISMA función que decide si el botón se ve.
  const eligibility = checkCreditNoteEligibility(loaded)
  if (!eligibility.eligible) throw new Error(eligibility.message!)
  // A partir de aquí `original` está garantizado por `checkCreditNoteEligibility`.
  const original = loaded.original!

  // 4. Proveedor. Se resuelve ANTES de reservar para no dejar una reserva huérfana si el PAC
  //    configurado no sabe emitir egresos.
  const provider = deps.resolveProvider(loaded.original!.fiscalEmisor as any, { sandbox: params.sandbox })
  if (typeof provider.createCreditNote !== 'function') {
    throw new Error(`El proveedor fiscal (${provider.name}) no soporta notas de crédito (CFDI de egreso).`)
  }

  // 5. Payload (puro, sin llamadas al PAC).
  //    Tasa de respaldo: la IMPLÍCITA de la factura original. Si el ingreso no llevó IVA
  //    (venta exenta), el egreso tampoco puede llevarlo — por eso NO se usa un 16% fijo.
  const fallbackRate = original.taxCents === 0 ? 0 : 0.16
  const lines = buildCreditNoteLines(refund.salesRefundCents, loaded.grossByRate, fallbackRate)
  const breakdown = splitIvaByRate(lines.map(l => ({ grossCents: l.grossCents, rate: l.rate })))
  // La forma de pago la manda el REEMBOLSO (así se devolvió el dinero). Un '99' "por definir"
  // no es aceptable en un CFDI, así que cae a la del ingreso original — que sí está definida.
  const refundForma = mapFormaPago(refund.method, refund.tenderSatFormaPago)
  const formaPago = refundForma === '99' ? original.formaPago : refundForma
  const originalLabel = `${original.serie ?? ''}${original.folio ?? ''}` || original.uuid

  const creditNoteParams = buildCreditNoteParams({
    receptor: {
      rfc: original.receptorRfc,
      razonSocial: original.receptorNombre,
      regimenFiscal: original.receptorRegimen,
      codigoPostal: original.receptorCp,
      ...(original.receptorEmail ? { email: original.receptorEmail } : {}),
    },
    originalUuid: original.uuid,
    originalLabel,
    formaPago,
    metodoPago: original.metodoPago === 'PPD' ? 'PPD' : 'PUE',
    serie: original.fiscalEmisor.serie ?? undefined,
    idempotencyKey,
    lines,
  })

  const baseData = (status: string, extra: Record<string, any> = {}) => ({
    venueId: loaded.venueId,
    fiscalEmisorId: original.fiscalEmisor.id,
    orderId: refund.orderId,
    type: 'EGRESO',
    flow: 'STAFF_B', // emisión manual por staff desde el dashboard (mismo flujo que el ingreso B)
    status,
    idempotencyKey,
    receptorRfc: original.receptorRfc,
    receptorNombre: original.receptorNombre,
    receptorRegimen: original.receptorRegimen,
    receptorCp: original.receptorCp,
    usoCfdi: CREDIT_NOTE_USO_CFDI,
    formaPago,
    metodoPago: creditNoteParams.metodoPago,
    subtotalCents: breakdown.netCents,
    taxCents: breakdown.taxCents,
    totalCents: refund.salesRefundCents,
    ...extra,
  })

  // 6. Reserva de la llave ANTES del PAC — es lo único que impide dos documentos fiscales
  //    reales si dos peticiones entran a la vez.
  try {
    await deps.reserveCfdi(baseData('STAMPING'))
  } catch (err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const current = await deps.findExistingCfdi(idempotencyKey)
      if (current?.status === 'STAMPED') return { status: 'STAMPED', cfdi: current }
      if (current?.status === 'STAMPING') {
        const ageMs = Date.now() - new Date(current.updatedAt ?? current.createdAt).getTime()
        if (ageMs < STAMPING_TTL_MS) throw new Error('Nota de crédito en proceso para este reembolso')
        logger.warn(`[cfdi-egreso] reclaiming stale STAMPING reservation for refund ${params.refundPaymentId}`)
      }
      // Fallo terminal previo (VALIDATION_FAILED / STAMP_FAILED) → se reintenta; el upsert lo pisa.
    } else {
      throw err
    }
  }

  // 7. Validación previa — nunca se manda basura al PAC.
  const validation = validateBeforeStamp({
    csdStatus: original.fiscalEmisor.csdStatus,
    formaPago,
    receptor: {
      rfc: original.receptorRfc,
      razonSocial: original.receptorNombre,
      regimenFiscal: original.receptorRegimen,
      codigoPostal: original.receptorCp,
      usoCfdi: CREDIT_NOTE_USO_CFDI,
    },
    items: creditNoteParams.items,
    expectedSubtotalCents: breakdown.netCents,
    expectedTaxCents: breakdown.taxCents,
    expectedTotalCents: refund.salesRefundCents,
    isGlobal: false,
  })
  if (!validation.valid) {
    const cfdi = await deps.persistCfdi(baseData('VALIDATION_FAILED', { lastError: validation.reasons.join(' | ') }))
    return { status: 'VALIDATION_FAILED', cfdi, reasons: validation.reasons }
  }

  // 8. Timbrado.
  let stamped
  try {
    stamped = await provider.createCreditNote(creditNoteParams)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi-egreso] stamp failed for refund ${params.refundPaymentId}: ${message}`)
    const cfdi = await deps.persistCfdi(baseData('STAMP_FAILED', { lastError: message }))
    return { status: 'STAMP_FAILED', cfdi }
  }

  // 9. Artefactos (XML + PDF).
  const [xmlBuf, pdfBuf] = await Promise.all([
    provider.downloadXml(stamped.providerInvoiceId),
    provider.downloadPdf(stamped.providerInvoiceId),
  ])
  const base = `venues/${loaded.venueSlug}/cfdi/${stamped.uuid}`
  const [xmlUrl, pdfUrl] = await Promise.all([
    deps.storeArtifact(xmlBuf, buildStoragePath(`${base}.xml`), 'application/xml'),
    deps.storeArtifact(pdfBuf, buildStoragePath(`${base}.pdf`), 'application/pdf'),
  ])

  const cfdi = await deps.persistCfdi(
    baseData('STAMPED', {
      facturapiId: stamped.providerInvoiceId,
      uuid: stamped.uuid,
      serie: stamped.serie,
      folio: stamped.folio,
      stampedAt: stamped.stampedAt,
      xmlUrl,
      pdfUrl,
    }),
  )

  // 10. Auditoría — mutación FISCAL e irreversible: va en el mismo cambio, nunca "después".
  //     Fire-and-forget: un fallo de auditoría no puede tumbar un timbrado ya hecho.
  deps.logAction({
    staffId: params.requestedByStaffId ?? null,
    venueId: loaded.venueId,
    action: 'CFDI_CREDIT_NOTE_ISSUED',
    entity: 'Cfdi',
    entityId: cfdi.id,
    data: {
      refundPaymentId: refund.id,
      orderId: refund.orderId,
      relatedUuid: original.uuid,
      relatedCfdiId: original.id,
      uuid: stamped.uuid,
      serie: stamped.serie,
      folio: stamped.folio,
      // pesos (unidades mayores) — regla de critical-warnings, nunca centavos en la salida
      amount: refund.salesRefundCents / 100,
      tipoRelacion: creditNoteParams.relationship,
      usoCfdi: CREDIT_NOTE_USO_CFDI,
    },
  })

  return { status: 'STAMPED', cfdi }
}

// ─── Lectura: ¿este reembolso ya tiene nota de crédito? ───────────────────────

/** Devuelve la nota de crédito de un reembolso (cualquier estado), o `null`. */
export async function getRefundCreditNote(venueId: string, refundPaymentId: string): Promise<any | null> {
  const cfdi = await prisma.cfdi.findUnique({
    where: { idempotencyKey: creditNoteIdempotencyKey(refundPaymentId) },
    select: {
      id: true,
      type: true,
      status: true,
      uuid: true,
      serie: true,
      folio: true,
      totalCents: true,
      subtotalCents: true,
      taxCents: true,
      receptorRfc: true,
      receptorNombre: true,
      stampedAt: true,
      xmlUrl: true,
      pdfUrl: true,
      lastError: true,
      venueId: true,
    },
  })
  // Aislamiento por tenant: el idempotencyKey es global, la respuesta NO puede serlo.
  if (!cfdi || cfdi.venueId !== venueId) return null
  return cfdi
}

export interface RefundCreditNoteStatus {
  /** La nota de crédito ya emitida (cualquier estado), o `null`. */
  creditNote: any | null
  /** ¿Se puede emitir? Cuando no, `message` dice por qué — en español y para pintarse tal cual. */
  eligibility: CreditNoteEligibility
  /** Vista previa de lo que se timbraría (null si el reembolso no existe o no procede). */
  preview: {
    facturaOriginal: { folio: string; uuid: string; totalCents: number } | null
    receptor: { rfc: string; nombre: string } | null
    amountToCreditCents: number
    tipRefundCents: number
  } | null
}

/**
 * Todo lo que la UI necesita para decidir si pinta el botón, ya emitido, o el porqué del "no".
 *
 * Regla del workspace: **apagado se VE y se EXPLICA** — por eso esto nunca devuelve un
 * booleano pelón: siempre trae el texto que el usuario debe leer.
 */
export async function getRefundCreditNoteStatus(venueId: string, refundPaymentId: string): Promise<RefundCreditNoteStatus | null> {
  const [creditNote, loaded] = await Promise.all([
    getRefundCreditNote(venueId, refundPaymentId),
    loadRefundForCreditNoteFromDb(venueId, refundPaymentId),
  ])
  if (!loaded) return null
  const eligibility = checkCreditNoteEligibility(loaded)
  const original = loaded.original
  return {
    creditNote,
    eligibility,
    preview: {
      facturaOriginal: original
        ? { folio: `${original.serie ?? ''}${original.folio ?? ''}` || original.uuid, uuid: original.uuid, totalCents: original.totalCents }
        : null,
      receptor: original ? { rfc: original.receptorRfc, nombre: original.receptorNombre } : null,
      amountToCreditCents: loaded.refund.salesRefundCents,
      tipRefundCents: loaded.refund.tipRefundCents,
    },
  }
}

// ─── deps reales (DB + storage). Los tests inyectan las suyas. ───────────────

const CFDI_EMISOR_SELECT = { id: true, provider: true, providerKeyEnc: true, csdStatus: true, serie: true } as const

/**
 * Carga el reembolso + su CFDI de ingreso + el desglose de tasas de la orden.
 * Extraída de `defaultDeps` para que el guard de tenant sea legible (y auditable) aparte.
 */
export async function loadRefundForCreditNoteFromDb(venueId: string, refundPaymentId: string): Promise<LoadedRefundForCreditNote | null> {
  const payment = await prisma.payment.findUnique({
    where: { id: refundPaymentId },
    select: {
      id: true,
      venueId: true,
      orderId: true,
      type: true,
      status: true,
      amount: true,
      tipAmount: true,
      method: true,
      tenderSatFormaPago: true,
    },
  })
  // Aislamiento por tenant: un pago de otro venue es "no encontrado", nunca un 403 informativo.
  if (!payment || payment.venueId !== venueId) return null

  const [order, original, credited] = await Promise.all([
    prisma.order.findUnique({
      where: { id: payment.orderId },
      select: {
        venue: { select: { slug: true } },
        items: {
          select: {
            quantity: true,
            unitPrice: true,
            discountAmount: true,
            product: { select: { taxRate: true } },
          },
        },
      },
    }),
    prisma.cfdi.findFirst({
      where: {
        venueId,
        orderId: payment.orderId,
        type: 'INGRESO',
        status: 'STAMPED',
        isGlobal: false,
        uuid: { not: null },
      },
      orderBy: { stampedAt: 'desc' },
      select: {
        id: true,
        uuid: true,
        serie: true,
        folio: true,
        status: true,
        cancelStatus: true,
        subtotalCents: true,
        taxCents: true,
        totalCents: true,
        formaPago: true,
        metodoPago: true,
        receptorRfc: true,
        receptorNombre: true,
        receptorRegimen: true,
        receptorCp: true,
        fiscalEmisor: { select: CFDI_EMISOR_SELECT },
      },
    }),
    prisma.cfdi.aggregate({
      where: { venueId, orderId: payment.orderId, type: 'EGRESO', status: 'STAMPED' },
      _sum: { totalCents: true },
    }),
  ])
  if (!order) return null

  // El email del receptor no vive en `Cfdi` (sólo el snapshot fiscal), así que se busca en el
  // perfil fiscal del cliente para que el PAC pueda mandarle la nota de crédito.
  let receptorEmail: string | null = null
  if (original) {
    const profile = await prisma.customerTaxProfile.findFirst({
      where: { venueId, rfc: original.receptorRfc },
      select: { email: true },
      orderBy: { updatedAt: 'desc' },
    })
    receptorEmail = profile?.email ?? null
  }

  const toCents = (d: Prisma.Decimal | number | null | undefined): number => Math.round(Number(d ?? 0) * 100)
  // Los REFUND se guardan NEGATIVOS (importe y propina): se entregan en positivo y SEPARADOS.
  const salesRefundCents = Math.abs(toCents(payment.amount))
  const tipRefundCents = Math.abs(toCents(payment.tipAmount))

  const byRate = new Map<number, number>()
  for (const it of order.items) {
    const rate = it.product?.taxRate != null ? Number(it.product.taxRate) : 0.16
    const grossCents = toCents(it.unitPrice) * it.quantity - toCents(it.discountAmount)
    if (grossCents <= 0) continue
    byRate.set(rate, (byRate.get(rate) ?? 0) + grossCents)
  }

  return {
    venueId,
    venueSlug: order.venue.slug,
    refund: {
      id: payment.id,
      orderId: payment.orderId,
      type: payment.type,
      status: payment.status,
      salesRefundCents,
      tipRefundCents,
      method: payment.method,
      tenderSatFormaPago: payment.tenderSatFormaPago ?? null,
    },
    original: original ? ({ ...original, receptorEmail } as OriginalCfdiForCreditNote) : null,
    grossByRate: [...byRate.entries()].map(([rate, grossCents]) => ({ rate, grossCents })),
    alreadyCreditedCents: credited._sum.totalCents ?? 0,
  }
}

const defaultDeps: EmitRefundCreditNoteDeps = {
  findExistingCfdi: idempotencyKey => prisma.cfdi.findUnique({ where: { idempotencyKey } }),
  loadRefundForCreditNote: loadRefundForCreditNoteFromDb,
  resolveProvider: resolveFiscalProvider,
  storeArtifact: (buffer, path, contentType) => uploadFileToStorage(buffer, path, contentType),
  reserveCfdi: data => prisma.cfdi.create({ data: data as any }),
  persistCfdi: data =>
    prisma.cfdi.upsert({
      where: { idempotencyKey: data.idempotencyKey },
      create: data as any,
      update: {
        status: data.status,
        lastError: data.lastError ?? null,
        attempts: { increment: 1 },
        ...stampedFields(data),
      },
    }),
  logAction: params => void defaultLogAction(params as any),
}

function stampedFields(data: Record<string, any>) {
  const keys = ['facturapiId', 'uuid', 'serie', 'folio', 'stampedAt', 'xmlUrl', 'pdfUrl'] as const
  const out: Record<string, any> = {}
  for (const k of keys) if (data[k] !== undefined) out[k] = data[k]
  return out
}
