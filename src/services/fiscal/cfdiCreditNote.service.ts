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
import { uploadFileToStorage } from '../storage.service'
import { logAction as defaultLogAction } from '../dashboard/activity-log.service'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import { buildCreditNoteParams, CREDIT_NOTE_USO_CFDI, CreditNoteLine } from './cfdiPayloadBuilder'
import { validateBeforeStamp } from './cfdiValidation'
import { allocateByWeights, splitIvaByRate, splitIvaIncluded } from './ivaMath'
import { mapFormaPago } from './satCatalog'
import {
  STAMPING_TTL_MS,
  consultarIntentoCapturado,
  enviarIntentoCapturado,
  finalizarEmision,
  importeConceptoCents,
  IssueCfdiDeps,
} from './cfdi.service'
import { ConflictError } from '../../errors/AppError'
import { bloquearOrdenParaFacturar, tomarAdmisionCompartida } from './admisionIva'
import { huellaDeEntrada, leerEntrada } from './entradaDocumental'
import { CFDI_VIVO } from './exclusionGlobal'
import type { CreditNoteParams } from './providers/fiscal-provider.interface'

const PROCESANDO = 'La factura de esta venta se está procesando; intenta de nuevo en unos minutos.'
const ENTRADA_INVALIDA = 'La entrada fiscal de esta factura requiere revisión de soporte.'
const IVA_MIXTO =
  'La factura original tiene productos con IVA distinto de 16 %; la nota de crédito para esas ventas todavía no está disponible aquí. Emítela desde el portal del SAT o de tu PAC.'
const cents = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0

// ─── Tipos ────────────────────────────────────────────────────────────────────

/** El CFDI de ingreso que se va a acreditar (snapshot de la fila `Cfdi`). */
export interface OriginalCfdiForCreditNote {
  id: string
  orderId: string
  protocoloIva: number | null
  entrada: unknown
  entradaHuella: string | null
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
  /** Compatibilidad de los consumidores previos; el egreso nunca consulta tasas del catálogo. */
  grossByRate: { rate: number; grossCents: number }[]
  /** Saldo reservado por egresos vivos de esta original, incluidos intentos inciertos. */
  alreadyCreditedCents: number
}

export interface EmitRefundCreditNoteParams {
  venueId: string
  refundPaymentId: string
  sandbox: boolean
  requestedByStaffId?: string | null
  /** Recuperación interna del MCP: jamás autoriza capturar ni enviar. */
  lookupOnly?: boolean
}

export interface EmitRefundCreditNoteDeps {
  findExistingCfdi: IssueCfdiDeps['findExistingCfdi']
  loadRefundForCreditNote: typeof loadRefundForCreditNoteFromDb
  resolveProvider: typeof resolveFiscalProvider
  storeArtifact: IssueCfdiDeps['storeArtifact']
  reserveCfdi: IssueCfdiDeps['reserveCfdi']
  persistCfdi: IssueCfdiDeps['persistCfdi']
  persistArtifacts: IssueCfdiDeps['persistArtifacts']
  runInTransaction: NonNullable<IssueCfdiDeps['runInTransaction']>
  loadEmisor: (id: string, venueId: string) => Promise<any | null>
  loadVenueSlug: (venueId: string) => Promise<string>
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
  | 'ORIGINAL_IVA_MIXTO'
  | 'ORIGINAL_ENTRADA_INVALIDA'

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
  if (!(original.protocoloIva === null && original.entrada == null)) {
    const e = leerEntrada(original.entrada)
    const tratamientos = ['IVA_16', 'IVA_8', 'IVA_0', 'EXENTO', 'NO_OBJETO', 'BLOQUEADO_03', 'BLOQUEADO_04']
    let valid = false
    try {
      valid =
        original.protocoloIva === 1 &&
        !!e &&
        e.orderId === refund.orderId &&
        original.orderId === refund.orderId &&
        e.fiscalEmisorId === original.fiscalEmisor.id &&
        huellaDeEntrada(e) === original.entradaHuella &&
        cents(e.paidCents) &&
        [e.montos.subtotalCents, e.montos.taxCents, e.montos.totalCents].every(cents) &&
        e.montos.subtotalCents === original.subtotalCents &&
        e.montos.taxCents === original.taxCents &&
        e.montos.totalCents === original.totalCents &&
        e.montos.subtotalCents + e.montos.taxCents === e.montos.totalCents &&
        e.renglones.every(r => r.orderItemId.length > 0 && tratamientos.includes(r.tratamiento)) &&
        new Set(e.renglones.map(r => r.orderItemId)).size === e.renglones.length &&
        e.params.receptor?.rfc === original.receptorRfc &&
        e.params.receptor.razonSocial === original.receptorNombre &&
        e.params.receptor.regimenFiscal === original.receptorRegimen &&
        e.params.receptor.codigoPostal === original.receptorCp &&
        ['PUE', 'PPD'].includes(e.params.metodoPago) &&
        Array.isArray(e.params.items) &&
        e.params.items.every(
          i =>
            i &&
            cents(i.unitPriceCents) &&
            cents(i.discountCents) &&
            typeof i.taxIncluded === 'boolean' &&
            Number.isFinite(i.quantity) &&
            i.quantity > 0 &&
            ['01', '02', '03', '04'].includes(i.objetoImp) &&
            Array.isArray(i.taxes) &&
            i.taxes.every(
              t =>
                t &&
                t.type === 'IVA' &&
                ['Tasa', 'Exento'].includes(t.factor) &&
                Number.isFinite(t.rate) &&
                typeof t.withholding === 'boolean',
            ) &&
            (e.clasificacion !== 'TODO_16' ||
              (i.objetoImp === '02' &&
                i.taxes.length === 1 &&
                i.taxes[0].rate === 0.16 &&
                i.taxes[0].factor === 'Tasa' &&
                i.taxes[0].withholding === false)),
        ) &&
        e.clasificacion === (e.renglones.some(r => r.tratamiento !== 'IVA_16') ? 'MIXTA' : 'TODO_16') &&
        validateBeforeStamp({
          csdStatus: 'ACTIVE',
          formaPago: e.params.formaPago,
          receptor: e.params.receptor,
          items: e.params.items,
          expectedSubtotalCents: e.montos.subtotalCents,
          expectedTaxCents: e.montos.taxCents,
          expectedTotalCents: e.montos.totalCents,
          isGlobal: false,
        }).valid
      if (valid && e!.clasificacion === 'TODO_16') {
        let subtotalCents = 0
        let totalCents = 0
        for (const item of e!.params.items) {
          // Mismo half-up por concepto y descuento por línea que la captura individual.
          const lineCents =
            importeConceptoCents({ unitPrice: new Prisma.Decimal(item.unitPriceCents).div(100), quantity: item.quantity }) -
            item.discountCents
          const total = item.taxIncluded ? lineCents : Math.round(lineCents * (1 + 0.16))
          const subtotal = item.taxIncluded ? splitIvaIncluded(lineCents, 0.16).netCents : lineCents
          if (![lineCents, subtotal, total].every(cents)) {
            valid = false
            break
          }
          subtotalCents += subtotal
          totalCents += total
        }
        valid =
          valid &&
          cents(subtotalCents) &&
          cents(totalCents) &&
          subtotalCents === e!.montos.subtotalCents &&
          totalCents - subtotalCents === e!.montos.taxCents &&
          totalCents === e!.montos.totalCents
      }
    } catch {
      valid = false
    }
    if (!valid) return { eligible: false, reason: 'ORIGINAL_ENTRADA_INVALIDA', message: ENTRADA_INVALIDA }
    if (e!.renglones.some(r => r.tratamiento !== 'IVA_16')) return { eligible: false, reason: 'ORIGINAL_IVA_MIXTO', message: IVA_MIXTO }
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

interface EntradaEgreso {
  version: 1
  tipo: 'EGRESO'
  orderId: string
  refundPaymentId: string
  originalCfdiId: string
  originalUuid: string
  fiscalEmisorId: string
  originalSinIvaHistorico?: true
  montos: { subtotalCents: number; taxCents: number; totalCents: number }
  params: Omit<CreditNoteParams, 'externalId' | 'idempotencyKey' | 'protocoloIva'>
}

function leerEgreso(cfdi: any): EntradaEgreso {
  const e = cfdi.entrada as EntradaEgreso | null
  const invalid = () => {
    throw new ConflictError(ENTRADA_INVALIDA)
  }
  if (
    cfdi.protocoloIva !== 1 ||
    !e ||
    e.version !== 1 ||
    e.tipo !== 'EGRESO' ||
    e.orderId !== cfdi.orderId ||
    e.fiscalEmisorId !== cfdi.fiscalEmisorId ||
    typeof e.refundPaymentId !== 'string' ||
    creditNoteIdempotencyKey(e.refundPaymentId) !== cfdi.idempotencyKey ||
    typeof e.originalCfdiId !== 'string' ||
    !e.originalCfdiId ||
    typeof e.originalUuid !== 'string' ||
    !e.originalUuid ||
    (e.originalSinIvaHistorico !== undefined && e.originalSinIvaHistorico !== true) ||
    !e.montos ||
    ![e.montos.subtotalCents, e.montos.taxCents, e.montos.totalCents].every(cents) ||
    e.montos.totalCents <= 0 ||
    e.montos.subtotalCents !== cfdi.subtotalCents ||
    e.montos.taxCents !== cfdi.taxCents ||
    e.montos.totalCents !== cfdi.totalCents ||
    e.montos.subtotalCents + e.montos.taxCents !== e.montos.totalCents ||
    huellaDeEntrada(e) !== cfdi.entradaHuella
  )
    return invalid()
  const p = e.params as CreditNoteParams
  const item = p?.items?.[0]
  if (
    !p ||
    p.externalId !== undefined ||
    p.idempotencyKey !== undefined ||
    p.protocoloIva !== undefined ||
    p.relationship !== '01' ||
    !Array.isArray(p.relatedUuids) ||
    p.relatedUuids.length !== 1 ||
    p.relatedUuids[0] !== e.originalUuid ||
    p.receptor?.usoCfdi !== 'G02' ||
    p.receptor.rfc !== cfdi.receptorRfc ||
    p.receptor.razonSocial !== cfdi.receptorNombre ||
    p.receptor.regimenFiscal !== cfdi.receptorRegimen ||
    p.receptor.codigoPostal !== cfdi.receptorCp ||
    p.formaPago !== cfdi.formaPago ||
    p.metodoPago !== cfdi.metodoPago ||
    !['PUE', 'PPD'].includes(p.metodoPago) ||
    !Array.isArray(p.items) ||
    p.items.length !== 1 ||
    !item ||
    item.quantity !== 1 ||
    item.unitPriceCents !== e.montos.totalCents ||
    item.discountCents !== 0 ||
    item.taxIncluded !== true ||
    item.satProductKey !== '01010101' ||
    item.satUnitKey !== 'ACT' ||
    typeof item.description !== 'string' ||
    !item.description.startsWith('Devolución sobre factura ') ||
    !Array.isArray(item.taxes)
  )
    return invalid()
  if (e.originalSinIvaHistorico) {
    if (item.objetoImp !== '01' || item.taxes.length || e.montos.taxCents !== 0 || e.montos.subtotalCents !== e.montos.totalCents)
      return invalid()
  } else if (
    item.objetoImp !== '02' ||
    item.taxes.length !== 1 ||
    item.taxes[0]?.type !== 'IVA' ||
    item.taxes[0].rate !== 0.16 ||
    item.taxes[0].factor !== 'Tasa' ||
    item.taxes[0].withholding !== false
  )
    return invalid()
  const expected = splitIvaIncluded(e.montos.totalCents, e.originalSinIvaHistorico ? 0 : 0.16)
  if (expected.netCents !== e.montos.subtotalCents || expected.taxCents !== e.montos.taxCents) return invalid()
  if (
    !validateBeforeStamp({
      csdStatus: 'ACTIVE',
      formaPago: p.formaPago,
      receptor: p.receptor,
      items: p.items,
      expectedSubtotalCents: e.montos.subtotalCents,
      expectedTaxCents: e.montos.taxCents,
      expectedTotalCents: e.montos.totalCents,
      isGlobal: false,
    }).valid
  )
    return invalid()
  return e
}

function recuperable(cfdi: any): boolean {
  return (
    cfdi?.protocoloIva === 1 &&
    cfdi.enviadoAt != null &&
    cfdi.falloDefinitivo === false &&
    ['STAMPING', 'STAMP_FAILED'].includes(cfdi.status) &&
    !['ACCEPTED', 'CANCELLED'].includes(cfdi.cancelStatus)
  )
}

function verificarTenant(cfdi: any, venueId: string): void {
  if (cfdi && (cfdi.venueId !== venueId || cfdi.type !== 'EGRESO')) throw new Error('Reembolso no encontrado')
}

function capturarEgreso(loaded: LoadedRefundForCreditNote, idempotencyKey: string) {
  const { refund } = loaded
  const original = loaded.original!
  const originalSinIvaHistorico = original.protocoloIva === null && original.entrada == null && original.taxCents === 0
  const fallbackRate = originalSinIvaHistorico ? 0 : 0.16
  const lines = buildCreditNoteLines(refund.salesRefundCents, [], fallbackRate)
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
  const { externalId: _external, idempotencyKey: _key, ...outbound } = creditNoteParams
  const entrada: EntradaEgreso = structuredClone({
    version: 1,
    tipo: 'EGRESO',
    orderId: refund.orderId,
    refundPaymentId: refund.id,
    originalCfdiId: original.id,
    originalUuid: original.uuid,
    fiscalEmisorId: original.fiscalEmisor.id,
    ...(originalSinIvaHistorico ? { originalSinIvaHistorico: true as const } : {}),
    montos: { subtotalCents: breakdown.netCents, taxCents: breakdown.taxCents, totalCents: refund.salesRefundCents },
    params: outbound,
  })
  return {
    entrada,
    base: baseData(validation.valid ? 'STAMPING' : 'VALIDATION_FAILED', { lastError: validation.reasons.join(' | ') || null }),
    reasons: validation.reasons,
  }
}

export async function emitRefundCreditNote(
  params: EmitRefundCreditNoteParams,
  overrides: Partial<EmitRefundCreditNoteDeps> = {},
): Promise<EmitRefundCreditNoteResult> {
  const deps = { ...defaultDeps, ...overrides }
  const key = creditNoteIdempotencyKey(params.refundPaymentId)
  const existing = await deps.findExistingCfdi(key)
  verificarTenant(existing, params.venueId)
  if (existing?.status === 'STAMPED') return { status: 'STAMPED', cfdi: existing }
  if (params.lookupOnly && !recuperable(existing)) throw new ConflictError(PROCESANDO)
  if (existing) {
    if (
      !['STAMPING', 'STAMP_FAILED', 'VALIDATION_FAILED'].includes(existing.status) ||
      ['ACCEPTED', 'CANCELLED'].includes(existing.cancelStatus)
    )
      throw new ConflictError(PROCESANDO)
    const emisor = await deps.loadEmisor(existing.fiscalEmisorId, params.venueId)
    if (!emisor) throw new Error('Reembolso no encontrado')
    const provider = deps.resolveProvider(emisor, { sandbox: params.sandbox })
    if (existing.protocoloIva === null) return emitirLegacy(existing, params, provider, deps)
    if (existing.protocoloIva !== 1) throw new ConflictError(ENTRADA_INVALIDA)
    const recovered = await consultarIntentoCapturado(existing, provider, deps.runInTransaction)
    if (recovered) return finalizarNota(existing, recovered, provider, params, deps)
    if (params.lookupOnly) throw new ConflictError(PROCESANDO)
  }
  const loaded = await deps.loadRefundForCreditNote(params.venueId, params.refundPaymentId, undefined, existing?.id)
  if (!loaded) throw new Error('Reembolso no encontrado')
  const initial = checkCreditNoteEligibility(loaded)
  if (!initial.eligible) throw new ConflictError(initial.message!)
  const provider = deps.resolveProvider(loaded.original!.fiscalEmisor as any, { sandbox: params.sandbox })
  if (!provider.createCreditNote)
    throw new ConflictError(`El proveedor fiscal (${provider.name}) no soporta notas de crédito (CFDI de egreso).`)
  const reserved = await deps.runInTransaction(async tx => {
    const scope = await bloquearOrdenParaFacturar(tx, loaded.refund.orderId)
    if (!scope || scope.venueId !== params.venueId) throw new Error('Reembolso no encontrado')
    await tomarAdmisionCompartida(tx, scope.organizationId)
    const current = await tx.cfdi.findUnique({ where: { idempotencyKey: key } })
    verificarTenant(current, params.venueId)
    if (current?.status === 'STAMPED') return { cfdi: current, alreadyStamped: true as const }
    if (
      current &&
      (!existing ||
        current.attempts !== existing.attempts ||
        current.status !== existing.status ||
        current.enviadoAt?.getTime() !== existing.enviadoAt?.getTime())
    )
      throw new ConflictError(PROCESANDO)
    if (
      current &&
      (current.protocoloIva !== 1 ||
        !['STAMPING', 'STAMP_FAILED', 'VALIDATION_FAILED'].includes(current.status) ||
        ['ACCEPTED', 'CANCELLED'].includes(current.cancelStatus ?? '') ||
        (current.enviadoAt !== null && !current.falloDefinitivo))
    )
      throw new ConflictError(PROCESANDO)
    const live = await deps.loadRefundForCreditNote(params.venueId, params.refundPaymentId, tx, current?.id)
    if (!live || live.refund.orderId !== loaded.refund.orderId) throw new Error('Reembolso no encontrado')
    const eligible = checkCreditNoteEligibility(live)
    if (!eligible.eligible) throw new ConflictError(eligible.message!)
    const captured = capturarEgreso(live, key)
    const data = {
      ...captured.base,
      protocoloIva: 1,
      entrada: captured.entrada as unknown as Prisma.InputJsonValue,
      entradaHuella: huellaDeEntrada(captured.entrada),
      enviadoAt: null,
      falloDefinitivo: false,
      facturapiId: null,
      attempts: (current?.attempts ?? 0) + (captured.reasons.length ? 0 : 1),
    }
    let cfdi
    if (current) {
      const changed = await tx.cfdi.updateMany({
        where: {
          id: current.id,
          status: current.status,
          attempts: current.attempts,
          enviadoAt: current.enviadoAt,
          falloDefinitivo: current.falloDefinitivo,
        },
        data: data as any,
      })
      if (changed.count !== 1) throw new ConflictError(PROCESANDO)
      cfdi = await tx.cfdi.findUniqueOrThrow({ where: { id: current.id } })
    } else cfdi = await deps.reserveCfdi(data, tx)
    return { alreadyStamped: false as const, cfdi, ...captured, emisor: live.original!.fiscalEmisor, slug: live.venueSlug }
  })
  if (reserved.alreadyStamped) return { status: 'STAMPED', cfdi: reserved.cfdi }
  if (reserved.reasons.length) return { status: 'VALIDATION_FAILED', cfdi: reserved.cfdi, reasons: reserved.reasons }
  const entrada = leerEgreso(reserved.cfdi)
  const sendingProvider = deps.resolveProvider(reserved.emisor as any, { sandbox: params.sandbox })
  const result = await enviarIntentoCapturado(
    reserved.cfdi,
    { tipo: 'EGRESO', params: entrada.params },
    null,
    sendingProvider,
    reserved.slug,
    deps,
  )
  verificarTenant(result.cfdi, params.venueId)
  if (result.status === 'STAMPED') auditarNota(result.cfdi, params, deps, entrada)
  return result
}

async function finalizarNota(
  cfdi: any,
  found: any,
  provider: any,
  params: EmitRefundCreditNoteParams,
  deps: EmitRefundCreditNoteDeps,
  auditLink?: Pick<EntradaEgreso, 'originalUuid' | 'originalCfdiId'>,
) {
  const result = await finalizarEmision(cfdi, found, provider, await deps.loadVenueSlug(params.venueId), deps)
  verificarTenant(result.cfdi, params.venueId)
  auditarNota(result.cfdi, params, deps, cfdi.protocoloIva === 1 ? cfdi.entrada : auditLink)
  return result
}
function auditarNota(
  cfdi: any,
  params: EmitRefundCreditNoteParams,
  deps: EmitRefundCreditNoteDeps,
  entrada?: Pick<EntradaEgreso, 'originalUuid' | 'originalCfdiId'>,
) {
  deps.logAction({
    staffId: params.requestedByStaffId ?? null,
    venueId: params.venueId,
    action: 'CFDI_CREDIT_NOTE_ISSUED',
    entity: 'Cfdi',
    entityId: cfdi.id,
    data: {
      refundPaymentId: params.refundPaymentId,
      orderId: cfdi.orderId,
      relatedUuid: entrada?.originalUuid,
      relatedCfdiId: entrada?.originalCfdiId,
      uuid: cfdi.uuid,
      serie: cfdi.serie,
      folio: cfdi.folio,
      amount: cfdi.totalCents / 100,
      tipoRelacion: '01',
      usoCfdi: CREDIT_NOTE_USO_CFDI,
    },
  })
}

/** Persisted-NULL conserva su llave y política de reintento; desenlaces nunca pisan otra versión/cancelación. */
async function emitirLegacy(
  cfdi: any,
  params: EmitRefundCreditNoteParams,
  provider: any,
  deps: EmitRefundCreditNoteDeps,
): Promise<EmitRefundCreditNoteResult> {
  let found
  try {
    found = cfdi.facturapiId ? await provider.getInvoice(cfdi.facturapiId) : await provider.findByExternalId(cfdi.idempotencyKey)
  } catch {
    throw new ConflictError(PROCESANDO)
  }
  if (found?.status === 'canceled')
    throw new ConflictError('Esta cuenta ya tiene una factura cancelada en el PAC; revísala antes de volver a facturar.')
  if (found?.status === 'valid' && found.uuid) return finalizarNota(cfdi, found, provider, params, deps)
  if (found || (cfdi.status === 'STAMPING' && Date.now() - new Date(cfdi.updatedAt ?? cfdi.createdAt).getTime() < STAMPING_TTL_MS))
    throw new ConflictError(PROCESANDO)
  if (!provider.createCreditNote)
    throw new ConflictError(`El proveedor fiscal (${provider.name}) no soporta notas de crédito (CFDI de egreso).`)
  const reserved = await deps.runInTransaction(async tx => {
    const scope = await bloquearOrdenParaFacturar(tx, cfdi.orderId)
    if (!scope || scope.venueId !== params.venueId) throw new Error('Reembolso no encontrado')
    await tomarAdmisionCompartida(tx, scope.organizationId)
    const loaded = await deps.loadRefundForCreditNote(params.venueId, params.refundPaymentId, tx, cfdi.id)
    if (!loaded || loaded.refund.orderId !== cfdi.orderId) throw new Error('Reembolso no encontrado')
    const eligible = checkCreditNoteEligibility(loaded)
    if (!eligible.eligible) throw new ConflictError(eligible.message!)
    const captured = capturarEgreso(loaded, cfdi.idempotencyKey)
    const updated = await tx.cfdi.updateMany({
      where: { id: cfdi.id, attempts: cfdi.attempts, status: cfdi.status, protocoloIva: null },
      data: { ...captured.base, attempts: { increment: 1 } } as any,
    })
    if (updated.count !== 1) throw new ConflictError(PROCESANDO)
    return { cfdi: await tx.cfdi.findUniqueOrThrow({ where: { id: cfdi.id } }), ...captured }
  })
  cfdi = reserved.cfdi
  if (reserved.reasons.length) return { status: 'VALIDATION_FAILED', cfdi, reasons: reserved.reasons }
  const where = { id: cfdi.id, status: 'STAMPING' as const, attempts: cfdi.attempts }
  let stamped
  try {
    stamped = await provider.createCreditNote({
      ...reserved.entrada.params,
      externalId: cfdi.idempotencyKey,
      idempotencyKey: cfdi.idempotencyKey,
    })
  } catch (err) {
    const updated = await deps.persistCfdi({ status: 'STAMP_FAILED', lastError: err instanceof Error ? err.message : String(err) }, where)
    if (!updated) throw new ConflictError(PROCESANDO)
    return { status: 'STAMP_FAILED', cfdi: updated }
  }
  if (stamped.status !== 'valid' || !stamped.uuid) {
    await deps.persistCfdi({ facturapiId: stamped.providerInvoiceId }, where)
    throw new ConflictError(PROCESANDO)
  }
  return finalizarNota(cfdi, stamped, provider, params, deps, reserved.entrada)
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
      protocoloIva: true,
      enviadoAt: true,
      falloDefinitivo: true,
      cancelStatus: true,
    },
  })
  // Aislamiento por tenant: el idempotencyKey es global, la respuesta NO puede serlo.
  if (!cfdi || cfdi.venueId !== venueId || cfdi.type !== 'EGRESO') return null
  const { protocoloIva, enviadoAt, falloDefinitivo, cancelStatus, ...publicNote } = cfdi
  return { ...publicNote, recoveryOnly: recuperable(cfdi) }
}

export interface RefundCreditNoteStatus {
  recoveryOnly: boolean
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
  const stored = await getRefundCreditNote(venueId, refundPaymentId)
  const { recoveryOnly = false, ...publicNote } = stored ?? {}
  const creditNote = stored ? publicNote : null
  if (recoveryOnly)
    return { creditNote, recoveryOnly: true, eligibility: { eligible: false, reason: null, message: PROCESANDO }, preview: null }
  const loaded = await loadRefundForCreditNoteFromDb(venueId, refundPaymentId)
  if (!loaded) return null
  const eligibility = checkCreditNoteEligibility(loaded)
  const original = loaded.original
  return {
    creditNote,
    recoveryOnly: false,
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
 * Carga el reembolso, su original fiscal y el saldo reservado, sin consultar el catálogo.
 * Extraída de `defaultDeps` para que el guard de tenant sea legible (y auditable) aparte.
 */
export async function loadRefundForCreditNoteFromDb(
  venueId: string,
  refundPaymentId: string,
  tx: Prisma.TransactionClient = prisma,
  excludeCfdiId?: string,
): Promise<LoadedRefundForCreditNote | null> {
  const payment = await tx.payment.findUnique({
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

  const [order, original] = await Promise.all([
    tx.order.findUnique({
      where: { id: payment.orderId },
      select: {
        venue: { select: { slug: true } },
      },
    }),
    tx.cfdi.findFirst({
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
        orderId: true,
        protocoloIva: true,
        entrada: true,
        entradaHuella: true,
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
  ])
  if (!order) return null

  // El email del receptor no vive en `Cfdi` (sólo el snapshot fiscal), así que se busca en el
  // perfil fiscal del cliente para que el PAC pueda mandarle la nota de crédito.
  let receptorEmail: string | null = null
  if (original) {
    const profile = await tx.customerTaxProfile.findFirst({
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

  // Legacy sin vínculo fiable cuenta contra la orden. Nuevos vínculos se validan por páginas;
  // una entrada corrupta cuenta conservadoramente, nunca libera capacidad en silencio.
  const liveWhere: Prisma.CfdiWhereInput = {
    venueId,
    orderId: payment.orderId,
    type: 'EGRESO',
    ...CFDI_VIVO,
    ...(excludeCfdiId ? { id: { not: excludeCfdiId } } : {}),
  }
  const historical = await tx.cfdi.aggregate({ where: { ...liveWhere, protocoloIva: null }, _sum: { totalCents: true } })
  let alreadyCreditedCents = historical._sum.totalCents ?? 0
  let after: string | undefined
  for (;;) {
    const page = await tx.cfdi.findMany({
      where: { ...liveWhere, protocoloIva: { not: null }, ...(after ? { AND: [CFDI_VIVO, { id: { gt: after } }] } : {}) },
      orderBy: { id: 'asc' },
      take: 100,
    })
    for (const cfdi of page) {
      let counts = true
      try {
        const e = leerEgreso(cfdi)
        counts = e.originalCfdiId === original?.id
      } catch {
        /* vínculo desconocido: reservar saldo */
      }
      if (counts) alreadyCreditedCents += cfdi.totalCents
    }
    if (page.length < 100) break
    after = page[page.length - 1].id
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
    grossByRate: [],
    alreadyCreditedCents,
  }
}

const defaultDeps: EmitRefundCreditNoteDeps = {
  findExistingCfdi: idempotencyKey => prisma.cfdi.findUnique({ where: { idempotencyKey } }),
  loadRefundForCreditNote: loadRefundForCreditNoteFromDb,
  resolveProvider: resolveFiscalProvider,
  storeArtifact: uploadFileToStorage,
  reserveCfdi: (data, tx = prisma) => tx.cfdi.create({ data: data as any }),
  runInTransaction: work => prisma.$transaction(work, { timeout: 60000 }),
  persistCfdi: async (data, where) => {
    if (!where) throw new Error('La escritura del egreso exige versión y estado de origen.')
    const { count } = await prisma.cfdi.updateMany({ where, data })
    return count === 1 ? prisma.cfdi.findFirst({ where: { id: where.id as string } }) : null
  },
  persistArtifacts: async (idempotencyKey, data, attempts) => {
    const { count } = await prisma.cfdi.updateMany({ where: { idempotencyKey, attempts, status: 'STAMPED' }, data })
    return count === 1 ? prisma.cfdi.findUnique({ where: { idempotencyKey } }) : null
  },
  loadEmisor: (id, venueId) => prisma.fiscalEmisor.findFirst({ where: { id, venueId } }),
  loadVenueSlug: async id => (await prisma.venue.findUniqueOrThrow({ where: { id }, select: { slug: true } })).slug,
  logAction: params => void defaultLogAction(params as any),
}
