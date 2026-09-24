// src/services/fiscal/cfdi.service.ts
import { CsdStatus, FiscalProviderType, PaymentMethod, VenueType, CfdiStatus, CfdiFlow, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { venueStartOfDay, venueEndOfDay, DEFAULT_TIMEZONE } from '../../utils/datetime'
import { buildStoragePath, uploadFileToStorage } from '../storage.service'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import { buildCreateInvoiceParams } from './cfdiPayloadBuilder'
import { validateBeforeStamp } from './cfdiValidation'
import { assembleSaleInput, LoadedOrderForCfdi } from './assembleSaleInput'
import { splitIvaIncluded } from './ivaMath'
import { logAction, LogActionParams } from '../dashboard/activity-log.service'

// ─── List CFDIs ───────────────────────────────────────────────────────────────

export interface ListCfdisParams {
  venueId: string
  /** Uno o varios (la pantalla deja marcar más de uno). */
  status?: CfdiStatus | CfdiStatus[]
  flow?: CfdiFlow | CfdiFlow[]
  isGlobal?: boolean
  receptorRfc?: string
  from?: string // ISO date string, venue-local day start (e.g. "2026-06-01")
  to?: string // ISO date string, venue-local day end
  page: number
  pageSize: number
  /** Venue IANA timezone — used to convert from/to to real UTC for Prisma queries */
  venueTimezone?: string
}

export interface ListCfdisResult {
  cfdis: any[]
  total: number
  page: number
  pageSize: number
}

/** Subset of Cfdi fields returned on the list endpoint (no sensitive internals). */
const CFDI_LIST_SELECT = {
  id: true,
  type: true,
  status: true,
  flow: true,
  isGlobal: true,
  orderId: true,
  receptorRfc: true,
  receptorNombre: true,
  serie: true,
  folio: true,
  uuid: true,
  subtotalCents: true,
  taxCents: true,
  totalCents: true,
  stampedAt: true,
  createdAt: true,
  cancelStatus: true,
  xmlUrl: true,
  pdfUrl: true,
  globalPeriod: true,
  // Sustitución: `replacesCfdiId` dice a cuál corrige ESTA factura; `replacedBy`, qué factura la
  // corrigió a ella. Sin esto la lista no puede contestar «¿cuál vale?» y enseña dos facturas
  // vivas por la misma venta sin decir que una sustituye a la otra. Acotado a propósito (take).
  replacesCfdiId: true,
  replacedBy: {
    select: { id: true, uuid: true, serie: true, folio: true, status: true, totalCents: true },
    orderBy: { createdAt: 'desc' as const },
    take: 5,
  },
} as const

/**
 * Returns a paginated list of CFDIs for the given venue.
 *
 * Tenant isolation: `venueId` is ALWAYS applied to the `where` clause — it is
 * never optional and is never derived from the request (controller passes
 * authContext.venueId). This prevents cross-venue data leaks.
 *
 * Date range: `from`/`to` are ISO date strings interpreted as venue-local day
 * boundaries (midnight → 23:59:59.999) and converted to real UTC via
 * `venueStartOfDay`/`venueEndOfDay` before being passed to Prisma.
 */
export async function listCfdisForVenue(params: ListCfdisParams): Promise<ListCfdisResult> {
  const { venueId, status, flow, isGlobal, receptorRfc, from, to, page, pageSize } = params
  const timezone = params.venueTimezone ?? DEFAULT_TIMEZONE

  // Build the where clause — venueId is always the first clause (tenant isolation)
  const where: Prisma.CfdiWhereInput = { venueId }

  // Uno ⇒ filtro exacto (igual que siempre); varios ⇒ `in`. Una lista vacía no filtra.
  const unoOVarios = <T>(v: T | T[] | undefined): T | { in: T[] } | undefined => {
    if (v === undefined) return undefined
    if (!Array.isArray(v)) return v
    if (v.length === 0) return undefined
    return v.length === 1 ? v[0] : { in: v }
  }
  const statusWhere = unoOVarios(status)
  if (statusWhere !== undefined) where.status = statusWhere
  const flowWhere = unoOVarios(flow)
  if (flowWhere !== undefined) where.flow = flowWhere
  if (isGlobal !== undefined) {
    where.isGlobal = isGlobal
  }
  if (receptorRfc) {
    // Case-insensitive substring search (mode: 'insensitive' maps to ILIKE in PostgreSQL)
    where.receptorRfc = { contains: receptorRfc, mode: 'insensitive' }
  }

  // Date range: convert venue-local day boundaries → real UTC (critical-warnings rule)
  if (from || to) {
    where.createdAt = {}
    // 🔴 Ancla de MEDIODÍA: `T00:00:00` se lee en el huso del SERVIDOR (UTC en producción) y el «24-sep»
    // se volvía el 23-sep de México — el filtro de Facturas enseñaba el día anterior. El mediodía cae en el
    // mismo día calendario en cualquier huso (critical-warnings, «bare YYYY-MM-DD»).
    if (from) {
      where.createdAt.gte = venueStartOfDay(timezone, new Date(`${from}T12:00:00`))
    }
    if (to) {
      where.createdAt.lte = venueEndOfDay(timezone, new Date(`${to}T12:00:00`))
    }
  }

  const skip = (page - 1) * pageSize
  const take = pageSize

  const [cfdis, total] = await Promise.all([
    prisma.cfdi.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: CFDI_LIST_SELECT,
    }),
    prisma.cfdi.count({ where }),
  ])

  return { cfdis, total, page, pageSize }
}

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
  facturacionEnabled: boolean
  autofacturaEnabled: boolean
  paymentMethod: PaymentMethod
  /**
   * Forma SAT que el NEGOCIO declaró en su tipo de pago, congelada en el cobro. Gana sobre
   * el mapa por método: un cobro con tipo del catálogo es `method = OTHER` → '99' (por
   * definir), y sin esto la factura salía "por definir" con el dato correcto en la base.
   */
  tenderSatFormaPago?: string | null
  metodoPago: 'PUE' | 'PPD'
  subtotalCents: number
  taxCents: number
  totalCents: number
  /**
   * Lo que el cliente PAGÓ por la orden (Σ pagos COMPLETED, reembolsos en negativo, SIN propina).
   * Es la verdad contra la que `issueCfdiForOrder` compara el total de la factura antes de timbrar:
   * un CFDI por menos (o más) de lo cobrado no se emite. Ausente sólo en bundles construidos a mano.
   */
  paidCents?: number
  /**
   * Razones por las que ESTA orden queda fuera del sobre seguro (promoción, reserva con extras, cargo
   * por servicio, IVA mixto con descuento general…). Con razones, el motor NO timbra: responde
   * VALIDATION_FAILED con el texto, y el ticket/recibo no ofrecen autofactura.
   */
  unsupportedReasons?: string[]
  order: LoadedOrderForCfdi
}

export interface IssueCfdiDeps {
  findExistingCfdi: (idempotencyKey: string) => Promise<any | null>
  /**
   * Todas las facturas de VENTA (ingreso, no globales) que ya tuvo la orden, de cualquier estado.
   * 🔴 Se mira por ORDEN y no sólo por la llave: una sustitución (`…-r1`) o una emisión nueva tras
   * cancelar (`…-n2`) viven en otra llave, y sólo así se sabe si la venta ya tiene una factura VIGENTE.
   */
  findOrderInvoices?: (orderId: string) => Promise<any[]>
  /** Le pregunta al PAC cómo va una cancelación que quedó «en trámite» (ver `refreshPendingCancellation`). */
  refreshPendingCancellation?: (cfdi: any, opts: { sandbox: boolean }) => Promise<any>
  loadOrderForCfdi: (orderId: string, opts?: LoadOrderForCfdiOpts) => Promise<LoadedOrderBundle | null>
  resolveProvider: typeof resolveFiscalProvider
  storeArtifact: (buffer: Buffer, path: string, contentType: string) => Promise<string>
  persistCfdi: (data: Record<string, any>) => Promise<any>
  /**
   * Reserves the idempotency slot BEFORE calling the PAC — prevents concurrent double-stamp.
   * Must INSERT a row with status:'STAMPING'. On unique-key conflict the caller handles P2002.
   */
  reserveCfdi: (data: Record<string, any>) => Promise<any>
  /**
   * RECLAMA un intento existente para reintentarlo. Devuelve si ESTE proceso se lo llevó.
   *
   * 🔴 El predicado lleva la VERSIÓN que el llamador leyó (`attempts`), no sólo el estado. Con el
   * estado solo, dos reintentos que leen la misma fila `STAMP_FAILED` ganan LOS DOS: el primero la
   * pasa a `STAMPING`, y `STAMPING` también está entre los estados admitidos, así que el segundo
   * también hace `count === 1` y timbra un documento fiscal de más (auditoría Codex, 22-sep P1-1).
   */
  claimCfdi: (cfdiId: string, desdeEstados: string[], version: number) => Promise<boolean>
  /**
   * Guarda SÓLO las URLs de los archivos. Nunca toca `status`: entre el timbre y la descarga otra
   * petición pudo cancelar el CFDI, y reescribir el estado aquí lo resucitaría (Codex P1-4).
   */
  persistArtifacts: (idempotencyKey: string, urls: { xmlUrl: string; pdfUrl: string }) => Promise<any>
}

export interface IssueCfdiResult {
  status: 'STAMPED' | 'VALIDATION_FAILED' | 'STAMP_FAILED'
  cfdi: any
  reasons?: string[]
  /**
   * true = NO se timbró nada: la venta ya tenía esta factura vigente y se devuelve ésa. Quien llama NO
   * puede presentarlo como «factura emitida» (Testarudo, 24-sep: la pantalla decía «éxito» y era la vieja).
   */
  alreadyIssued?: boolean
}

/** «A-14», o el UUID si la factura no trae serie/folio. Para mensajes al usuario. */
function folioDe(cfdi: { serie?: string | null; folio?: string | null; uuid?: string | null }): string {
  if (cfdi.serie || cfdi.folio) return [cfdi.serie, cfdi.folio].filter(Boolean).join('-')
  return cfdi.uuid ?? 'anterior'
}

/**
 * La llave de la SIGUIENTE factura de venta de una orden. La primera es `cfdi-order-<orden>` (la de
 * siempre, así no cambia nada para las ventas que nunca se cancelaron); si la última emisión quedó
 * CANCELADA ante el SAT, la venta estrena generación: `-n2`, `-n3`… Un intento que falló sin timbrar se
 * reintenta con SU misma llave (el reclamo atómico de siempre). Las llaves de sustitución (`-rN`) son de
 * otro carril (`cfdiReplacement.service`) y no cuentan como generación.
 */
export function llaveDeEmision(orderId: string, facturas: Array<{ idempotencyKey?: string | null; status: string }>): string {
  const base = `cfdi-order-${orderId}`
  const patron = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-n(\\d+))?$`)
  let ultima: { gen: number; status: string } | null = null
  for (const f of facturas) {
    const m = f.idempotencyKey?.match(patron)
    if (!m) continue
    const gen = m[1] ? Number(m[1]) : 1
    if (!ultima || gen > ultima.gen) ultima = { gen, status: f.status }
  }
  if (!ultima) return base
  const gen = ultima.status === 'CANCELLED' ? ultima.gen + 1 : ultima.gen
  return gen === 1 ? base : `${base}-n${gen}`
}

// A reservation older than this is treated as stale (crashed/deployed mid-stamp) and may be reclaimed,
// so a stuck STAMPING row never permanently locks an order's invoicing.
export const STAMPING_TTL_MS = 3 * 60_000

export async function issueCfdiForOrder(
  params: { orderId: string; receptor: IssueReceptor; sandbox: boolean; flow?: 'STAFF_B' | 'AUTOFACTURA_A'; expectedVenueId?: string },
  deps: IssueCfdiDeps = defaultDeps,
): Promise<IssueCfdiResult> {
  let idempotencyKey = `cfdi-order-${params.orderId}`

  // 0. ¿La venta ya tuvo factura? Una sola factura VIGENTE por venta; después de cancelarla (confirmado
  //    por el PAC, no supuesto) sí se puede volver a facturar — a la misma u otra razón social.
  if (deps.findOrderInvoices) {
    const previas = (await deps.findOrderInvoices(params.orderId)).filter(f => !f.isGlobal && (f.type ?? 'INGRESO') === 'INGRESO')
    // Aislamiento ANTES de mirar nada: una factura de la orden que diga otro negocio es un 404, sin fuga.
    if (params.expectedVenueId && previas.some(f => f.venueId && f.venueId !== params.expectedVenueId)) {
      throw new Error(`Order ${params.orderId} not found`)
    }
    const vistas: any[] = []
    for (const f of previas) {
      if (f.status === 'STAMPED' && f.cancelStatus === 'REQUESTED' && deps.refreshPendingCancellation) {
        try {
          vistas.push((await deps.refreshPendingCancellation(f, { sandbox: params.sandbox })) ?? f)
        } catch (err: unknown) {
          // Si no se pudo preguntar, la cancelación NO se da por hecha: sigue contando como en trámite.
          logger.warn(`[cfdi] no se pudo consultar la cancelación de ${f.id}: ${err instanceof Error ? err.message : String(err)}`)
          vistas.push(f)
        }
      } else {
        vistas.push(f)
      }
    }
    const vigente = vistas.find(f => f.status === 'STAMPED' || f.status === 'CANCEL_REQUESTED')
    if (vigente) {
      if (vigente.cancelStatus === 'REQUESTED' || vigente.status === 'CANCEL_REQUESTED') {
        throw new Error(
          `La cancelación de la factura ${folioDe(vigente)} sigue en trámite ante el SAT; en cuanto quede cancelada podrás volver a facturar esta venta.`,
        ) // → 409
      }
      return { status: 'STAMPED', cfdi: vigente, alreadyIssued: true }
    }
    idempotencyKey = llaveDeEmision(params.orderId, vistas)
    // Otro carril timbrando AHORA mismo sobre esta venta (p. ej. una sustitución): nunca en paralelo.
    const enCurso = vistas.find(
      f =>
        f.status === 'STAMPING' &&
        f.idempotencyKey !== idempotencyKey &&
        Date.now() - new Date(f.updatedAt ?? f.createdAt).getTime() < STAMPING_TTL_MS,
    )
    if (enCurso) throw new Error('CFDI en proceso para esta orden') // → 409
  }

  // 1. Idempotency — never double-stamp (facturapi has no idempotency; we own it)
  const existing = await deps.findExistingCfdi(idempotencyKey)
  if (existing && existing.status === 'STAMPED') {
    // Tenant isolation ANTES del retorno idempotente: sin esto, venue B obtenía las URLs del CFDI de A
    // con sólo conocer el id de la orden.
    if (params.expectedVenueId && existing.venueId && existing.venueId !== params.expectedVenueId) {
      throw new Error(`Order ${params.orderId} not found`) // → 404, no cross-venue leak
    }
    return { status: 'STAMPED', cfdi: existing }
  }

  // 2. Load
  // El personal (Pedidos → Facturar) factura a propósito; la autofactura del cliente respeta el interruptor.
  const bundle = await deps.loadOrderForCfdi(params.orderId, { permitirEfectivo: (params.flow ?? 'STAFF_B') === 'STAFF_B' })
  if (!bundle) throw new Error(`Order ${params.orderId} not found or has no fiscal emisor configured`)
  // Tenant isolation (critical-warnings rule): the order MUST belong to the caller's venue.
  if (params.expectedVenueId && bundle.venueId !== params.expectedVenueId) {
    throw new Error(`Order ${params.orderId} not found`) // → 404, no cross-venue leak
  }

  // Merchant gating: issuance requires facturacionEnabled on the payment merchant.
  if (!bundle.facturacionEnabled) throw new Error('Facturación no habilitada para este comercio')
  // Flow-A gating: autofactura requires autofacturaEnabled in addition.
  if (params.flow === 'AUTOFACTURA_A' && !bundle.autofacturaEnabled) throw new Error('Autofactura no habilitada para este comercio')

  // 3. Assemble + build (pure — no PAC calls, safe to run before reservation)
  const saleInput = assembleSaleInput(bundle.order, {
    receptor: params.receptor,
    paymentMethod: bundle.paymentMethod,
    tenderSatFormaPago: bundle.tenderSatFormaPago ?? null,
    metodoPago: bundle.metodoPago,
    serie: bundle.emisor.serie ?? undefined,
    idempotencyKey,
  })
  const invoiceParams = buildCreateInvoiceParams(saleInput)
  // Stamp our idempotencyKey as the PAC external_id so the reconcile job can look up
  // the document deterministically (GET /v2/invoices?external_id=...) instead of relying
  // solely on attribute matching (RFC + total + global flag + date window).
  invoiceParams.externalId = idempotencyKey

  // 3b. Reserve the idempotency slot BEFORE calling the PAC.
  //     This INSERT prevents a second concurrent request from reaching facturapi
  //     and producing two real fiscal documents (double-stamp / double-charge).
  //     The unique constraint on idempotencyKey is the gate.
  try {
    await deps.reserveCfdi(baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'STAMPING', {}))
  } catch (err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Slot already taken — inspect the current status to decide the response.
      const existing = await deps.findExistingCfdi(idempotencyKey)
      if (existing?.status === 'STAMPED') {
        // Another request already succeeded — idempotent success.
        return { status: 'STAMPED', cfdi: existing }
      }
      if (existing?.status === 'STAMPING') {
        // Another request is in-flight. But a process crash / rolling deploy mid-stamp could
        // leave a STAMPING row stuck forever, permanently locking this order's invoicing.
        // Bound the lock: only block if the reservation is FRESH; reclaim a stale one.
        const ageMs = Date.now() - new Date(existing.updatedAt ?? existing.createdAt).getTime()
        if (ageMs < STAMPING_TTL_MS) {
          throw new Error('CFDI en proceso para esta orden') // → 409 in controllers
        }
        logger.warn(`[cfdi] reclaiming stale STAMPING reservation for order ${params.orderId} (age ${Math.round(ageMs / 1000)}s)`)
      }
      // 🔴 RECLAMO ATÓMICO: sin esto, dos peticiones que encuentran el mismo intento fallido (o la
      // misma reserva vieja) seguían las DOS y podían timbrar dos veces. Quien pierde recibe el mismo
      // 409 de siempre.
      if (existing) {
        // 🔴 Un intento anterior de OTRO emisor no se re-timbra: el documento pudo emitirse con el
        // comercio viejo y preguntarle al nuevo devolvería «no existe» (Codex P1-3).
        if (existing.fiscalEmisorId && existing.fiscalEmisorId !== bundle.emisor.id) {
          throw new Error('El emisor fiscal de esta cuenta cambió desde el intento anterior; revísalo antes de volver a facturar.')
        }
        const mio = await deps.claimCfdi(existing.id, ['STAMPING', 'STAMP_FAILED', 'VALIDATION_FAILED'], existing.attempts ?? 0)
        if (!mio) throw new Error('CFDI en proceso para esta orden') // → 409
        // 🔴 RECONCILIAR ANTES DE RE-TIMBRAR: un intento anterior pudo haber timbrado y fallar DESPUÉS
        // (un timeout tras la respuesta del PAC deja `STAMP_FAILED` con el documento ya emitido). Se le
        // pregunta al PAC por nuestro `external_id` antes de emitir otro.
        const yaEmitido = await reconciliarIntentoPrevio(params, bundle, idempotencyKey, invoiceParams, deps)
        if (yaEmitido) return yaEmitido
      }
    } else {
      throw err
    }
  }

  // 4. Validate (D1) — never send garbage to the PAC
  const validation = validateBeforeStamp({
    csdStatus: bundle.emisor.csdStatus,
    formaPago: invoiceParams.formaPago,
    receptor: { ...params.receptor },
    items: invoiceParams.items,
    expectedSubtotalCents: bundle.subtotalCents,
    expectedTaxCents: bundle.taxCents,
    expectedTotalCents: bundle.totalCents,
    isGlobal: false, // individual issuance — XAXX010101000 ("Público en General") is blocked here
  })
  const reasons = [...validation.reasons, ...(bundle.unsupportedReasons ?? [])]
  // 🔴 Barrera de dinero: la factura tiene que decir EXACTAMENTE lo que el cliente pagó (sin propina).
  // Testarudo (21-sep-2026) recibió 5 facturas por menos de lo cobrado; un CFDI que no cuadra con el
  // ticket es peor que ninguno — no se timbra, y la razón se le enseña a quien factura.
  // Se compara el DOCUMENTO que se manda (los conceptos como los calculará el PAC), no los agregados
  // de la orden: con precios NET el PAC suma el IVA encima, con precios IVA-incluido lo extrae.
  const documentoCents = totalDelDocumentoCents(bundle.order)
  // Con razones del sobre el descuento pudo quedar sin repartir a propósito: el desajuste de importe ya
  // no dice nada nuevo y confundiría («no coincide con lo cobrado» cuando el cobro está bien).
  if (!bundle.unsupportedReasons?.length && bundle.paidCents !== undefined && bundle.paidCents !== documentoCents) {
    const pesos = (c: number) => `$${(c / 100).toFixed(2)}`
    reasons.push(
      `El total de la factura (${pesos(documentoCents)}) no coincide con lo cobrado (${pesos(bundle.paidCents)}). No se timbró; revisa la cuenta o repórtala a soporte.`,
    )
  }
  if (reasons.length > 0) {
    const cfdi = await deps.persistCfdi(
      baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'VALIDATION_FAILED', { lastError: reasons.join(' | ') }),
    )
    return { status: 'VALIDATION_FAILED', cfdi, reasons }
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

  // 6. 🔴 Persistir el TIMBRE de inmediato, ANTES de tocar Storage. El documento ya existe ante el SAT:
  //    si la descarga o la subida fallan, la fila tiene que conservar uuid/serie/folio o quedamos con un
  //    CFDI real que no sabemos identificar (pasó el 21-sep con la factura de Laura: 13 min en STAMPING
  //    sin identificadores tras un `fetch failed`).
  const identidad = {
    facturapiId: stamped.providerInvoiceId,
    uuid: stamped.uuid,
    serie: stamped.serie,
    folio: stamped.folio,
    stampedAt: stamped.stampedAt,
  }
  let cfdi = await deps.persistCfdi(baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'STAMPED', identidad))

  // 7. Archivos: best-effort. Un fallo aquí NO invalida el timbre; el job de conciliación los completa.
  try {
    const [xmlBuf, pdfBuf] = await Promise.all([
      provider.downloadXml(stamped.providerInvoiceId),
      provider.downloadPdf(stamped.providerInvoiceId),
    ])
    const base = `venues/${bundle.venueSlug}/cfdi/${stamped.uuid}`
    const [xmlUrl, pdfUrl] = await Promise.all([
      deps.storeArtifact(xmlBuf, buildStoragePath(`${base}.xml`), 'application/xml'),
      deps.storeArtifact(pdfBuf, buildStoragePath(`${base}.pdf`), 'application/pdf'),
    ])
    const guardada = await deps.persistArtifacts(idempotencyKey, { xmlUrl, pdfUrl })
    // Se FUNDE sobre la fila que ya traía el timbre: `persistArtifacts` sólo escribe URLs y
    // podría devolver una vista parcial; perder aquí el uuid rompería la cancelación de abajo.
    cfdi = { ...cfdi, ...(guardada ?? {}), xmlUrl, pdfUrl }
  } catch (err: unknown) {
    // 🔴 El timbre YA es válido; lo que falta son los archivos. Se deja dicho en la fila porque
    // NADIE los repone solo: el job de conciliación sólo mira filas `STAMPING` (Codex P2-8). Hasta
    // que alguien los baje, la descarga del dashboard contestará 404.
    logger.error(
      `[cfdi] timbrado OK pero fallaron los archivos de ${stamped.uuid} (orden ${params.orderId}): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return { status: 'STAMPED', cfdi }
}

/**
 * Antes de re-timbrar un intento reclamado, le pregunta al PAC si NUESTRO `external_id` ya tiene
 * documento. Tres desenlaces: existe y es válido ⇒ se completa la fila sin volver a timbrar; existe y
 * está cancelado ⇒ no se toca (queda para revisión humana); no existe ⇒ se sigue al timbrado normal.
 */
async function reconciliarIntentoPrevio(
  params: { orderId: string; receptor: IssueReceptor; sandbox: boolean; flow?: 'STAFF_B' | 'AUTOFACTURA_A'; expectedVenueId?: string },
  bundle: LoadedOrderBundle,
  idempotencyKey: string,
  invoiceParams: any,
  deps: IssueCfdiDeps,
): Promise<IssueCfdiResult | null> {
  const provider = deps.resolveProvider(bundle.emisor as any, { sandbox: params.sandbox })
  if (typeof provider.findByExternalId !== 'function') return null
  let previo
  try {
    previo = await provider.findByExternalId(idempotencyKey)
  } catch (err: unknown) {
    // Si no se puede preguntar, NO se timbra a ciegas: se corta con 409 y el job lo reintenta.
    logger.error(
      `[cfdi] no se pudo consultar el PAC antes de reintentar ${idempotencyKey}: ${err instanceof Error ? err.message : String(err)}`,
    )
    throw new Error('CFDI en proceso para esta orden')
  }
  if (!previo) return null
  if (previo.status === 'canceled') {
    throw new Error(
      `Esta cuenta ya tiene una factura cancelada en el PAC (${previo.uuid ?? previo.providerInvoiceId}); revísala antes de volver a facturar`,
    )
  }
  logger.warn(`[cfdi] el PAC ya tenía ${previo.uuid} para ${idempotencyKey}: se completa sin volver a timbrar`)
  const cfdi = await deps.persistCfdi(
    baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'STAMPED', {
      facturapiId: previo.providerInvoiceId,
      uuid: previo.uuid,
      serie: previo.serie,
      folio: previo.folio,
      stampedAt: previo.stampedAt ?? new Date(),
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
  // Acotado: una venta tiene un puñado de facturas (original, sustitutas, reemisiones). 50 sobra.
  findOrderInvoices: orderId =>
    prisma.cfdi.findMany({
      where: { orderId, isGlobal: false, type: 'INGRESO' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 50,
      include: { fiscalEmisor: true },
    }),
  refreshPendingCancellation: (cfdi, opts) => refreshPendingCancellation(cfdi, opts),
  storeArtifact: (buffer, path, contentType) => uploadFileToStorage(buffer, path, contentType),
  resolveProvider: resolveFiscalProvider,
  // Reserves the idempotency slot (INSERT only — raises P2002 on conflict).
  reserveCfdi: data => prisma.cfdi.create({ data: data as any }),
  persistCfdi: data =>
    prisma.cfdi.upsert({
      where: { idempotencyKey: data.idempotencyKey },
      create: data as any,
      // 🔴 El dinero se REFRESCA: entre una reserva fallida y el reintento la cuenta pudo corregirse,
      // y la fila tiene que describir el documento que de verdad se timbró (Codex P2-6).
      update: {
        status: data.status,
        lastError: data.lastError ?? null,
        attempts: { increment: 1 },
        ...moneyFields(data),
        ...stampedFields(data),
      },
    }),
  loadOrderForCfdi: loadOrderForCfdiFromDb,
  claimCfdi: async (cfdiId, desdeEstados, version) => {
    const { count } = await prisma.cfdi.updateMany({
      where: claimWhere(cfdiId, desdeEstados, version) as any,
      data: { status: 'STAMPING', attempts: { increment: 1 }, updatedAt: new Date() },
    })
    return count === 1
  },
  persistArtifacts: async (idempotencyKey, urls) => {
    // Sólo las URLs, y sólo sobre una fila que siga timbrada. Un `update` normal reescribiría el
    // estado que otra petición acaba de cambiar.
    const { count } = await prisma.cfdi.updateMany({ where: { idempotencyKey, status: 'STAMPED' }, data: urls })
    if (count === 0) logger.warn(`[cfdi] no se guardaron los archivos de ${idempotencyKey}: la fila ya no está timbrada`)
    return prisma.cfdi.findUnique({ where: { idempotencyKey } })
  },
}

/**
 * El predicado del reclamo, aparte y puro para poder probarlo: id + estado admitido + **la versión
 * exacta que se leyó**. `attempts` sólo crece, así que dos reclamos que leyeron la misma fila no
 * pueden ganar los dos aunque ocurran en el mismo milisegundo.
 */
export function claimWhere(cfdiId: string, desdeEstados: string[], version: number) {
  return { id: cfdiId, status: { in: desdeEstados }, attempts: version }
}

export type RenglonParaCfdi = {
  productName: string | null
  quantity: number
  unitPrice: any
  discountAmount: any
  total?: any
  weightQuantity?: any
  modifiers?: Array<{ name: string | null; price: any; quantity: number }> | null
  product: any
}

const centavos = (d: any) => Math.round(Number(d ?? 0) * 100)

/**
 * Total que el PAC va a calcular para estos conceptos: `Σ (unitario × cantidad − descuento)`, y si los
 * precios son NET se les suma su tasa (exento/0 % = igual). Es contra ESTO —no contra `order.total`—
 * que se compara lo cobrado antes de timbrar.
 */
export function totalDelDocumentoCents(order: {
  items: Array<{ unitPrice: any; quantity: number; discountAmount: any; product: { taxRate: any } | null }>
  pricesIncludeIva?: boolean
}): number {
  return order.items.reduce((sum, it) => {
    const neto = importeConceptoCents(it) - centavos(it.discountAmount)
    if (order.pricesIncludeIva) return sum + neto
    const rate = it.product ? Number(it.product.taxRate) : 0.16
    return sum + Math.round(neto * (1 + rate))
  }, 0)
}

/** Cobros que forman la base facturable: REGULAR/FAST (`null` = legado). TEST/ADJUSTMENT no son ventas; REFUND va en su nota de crédito. */
export function esCobroElegible(p: { type?: string | null }): boolean {
  return p.type == null || p.type === 'REGULAR' || p.type === 'FAST'
}

/**
 * Importe bruto de un concepto = valor unitario × cantidad, en centavos. En DECIMAL y redondeando UNA
 * vez al final (half-up), como pide el SAT: con float, 100.05 × 0.300 daba 3,001 ¢ en vez de 3,002.
 */
export function importeConceptoCents(it: { unitPrice: any; quantity: number }): number {
  return new Prisma.Decimal(String(it.unitPrice ?? 0))
    .mul(new Prisma.Decimal(String(it.quantity)))
    .mul(100)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber()
}

/** Resultado de reconstruir un renglón: sus conceptos, o la razón por la que NO se puede facturar así. */
export interface ConceptosDeRenglon {
  items: RenglonParaCfdi[]
  /** Vacío = dentro del sobre seguro. Con texto = el motor lo BLOQUEA con esta razón, nunca timbra a ciegas. */
  motivos: string[]
}

/** Reparte `cents` entre `pesos` en proporción, residuo de redondeo al último; Σ partes == cents. */
function repartir(cents: number, pesos: number[]): number[] {
  if (pesos.length === 0) return []
  const suma = pesos.reduce((a, b) => a + b, 0)
  const partes = suma > 0 ? pesos.map(w => Math.floor((cents * w) / suma)) : pesos.map((_, i) => (i === 0 ? cents : 0))
  // El residuo de redondeo va al concepto con MÁS saldo disponible (peso − parte), nunca a uno sin saldo:
  // una cortesía al final de la cuenta recibía el centavo sobrante y quedaba con descuento > importe.
  let residuo = cents - partes.reduce((a, b) => a + b, 0)
  while (residuo > 0) {
    let mejor = -1
    for (let i = 0; i < pesos.length; i++) {
      const saldo = pesos[i] - partes[i]
      if (saldo > 0 && (mejor < 0 || saldo > pesos[mejor] - partes[mejor])) mejor = i
    }
    if (mejor < 0) break
    partes[mejor] += 1
    residuo -= 1
  }
  return partes
}

const pesosTxt = (cents: number) => `$${(cents / 100).toFixed(2)}`

/**
 * Un renglón de la orden → los CONCEPTOS que van a la factura. La factura tiene que cuadrar con el
 * TICKET (lo cobrado), no con el precio de lista. Caso real (Testarudo, 21-sep-2026): CAPUCCINO $65 +
 * «Deslactosada» $5 se facturó por $65.
 *
 * 🔑 `OrderItem.total` NO significa lo mismo en todos los escritores (Codex, pasada 4): TPV y mobile
 * guardan `(precio + extras) × cantidad` ANTES del descuento de renglón (venta por peso: `precio ×
 * kilos`); las PROMOCIONES lo guardan ya neto; las RESERVAS guardan sólo el producto base. Por eso esto
 * es un SOBRE SEGURO: se reconstruye sólo cuando las identidades del escritor normal se cumplen —
 * `total ≥ lista × cantidad`, extras con precio ⇔ `total − lista × cantidad > 0`, peso que cuadra — y
 * cualquier otro dato devuelve un MOTIVO para bloquear la factura con la razón escrita. Un `total` de
 * 0 es dato (cortesía recalculada), no ausencia: nunca se reconstruye por `lineGross`.
 *
 * - Producto: cantidad y precio de lista REALES (el SAT exige cantidad y valor unitario); venta por
 *   peso: cantidad = kilos, unitario = precio por kilo (unidad KGM).
 * - Extras con precio: un concepto propio cada uno («Deslactosada (CAPUCCINO)»), con las claves SAT del
 *   producto padre; reparten `total − lista × cantidad` en proporción a su precio.
 * - Extras de $0 se quedan en el nombre del producto, como en el ticket.
 * - El descuento del renglón (cortesía incluida) se reparte entre el producto y sus extras en proporción
 *   a su importe: ningún concepto queda con descuento > importe.
 */
export function conceptosDesdeRenglon(it: RenglonParaCfdi, _orderId: string): ConceptosDeRenglon {
  const extras = it.modifiers ?? []
  const nombreProducto = it.productName ?? 'Producto'
  const nombresSinPrecio = extras
    .filter(m => centavos(m.price) === 0)
    .map(m => m.name?.trim())
    .filter((n): n is string => !!n)
  const productName = nombresSinPrecio.length > 0 ? `${nombreProducto} (${nombresSinPrecio.join(', ')})` : nombreProducto
  const porPeso = it.weightQuantity != null
  const unidades = porPeso ? Number(it.weightQuantity) : it.quantity
  if (!(unidades > 0)) return { items: [], motivos: [`«${nombreProducto}»: cantidad inválida (${unidades}).`] }
  const baseCents = importeConceptoCents({ unitPrice: it.unitPrice, quantity: unidades })
  const totalCents = centavos(it.total)
  const descuentoCents = centavos(it.discountAmount)
  const extrasCents = totalCents - baseCents
  const conPrecio = extras.filter(m => centavos(m.price) > 0)

  if (extrasCents < 0) {
    return {
      items: [],
      motivos: [
        `«${nombreProducto}»: el importe cobrado (${pesosTxt(totalCents)}) es menor que precio × cantidad (${pesosTxt(baseCents)}); no se puede reconstruir el concepto (promoción o recálculo).`,
      ],
    }
  }
  // Tasa 0 con «sí objeto de impuesto» es ambigua (¿tasa cero o exento?) y el constructor la convierte en
  // exento: hasta distinguirlas, fuera del sobre.
  const tasa = Number(it.product?.taxRate ?? 0.16)
  const objeto = it.product?.objetoImp ?? '02'
  if (objeto !== '01' && objeto !== '02') {
    return { items: [], motivos: [`«${nombreProducto}»: objeto de impuesto ${objeto} no soportado.`] }
  }
  if (objeto === '01' && tasa !== 0) {
    return { items: [], motivos: [`«${nombreProducto}»: producto «no objeto de impuesto» (01) con tasa ${tasa}; catálogo inconsistente.`] }
  }
  if (tasa === 0 && objeto === '02') {
    return {
      items: [],
      motivos: [`«${nombreProducto}»: producto con tasa 0 y objeto de impuesto 02 (tasa cero vs exento sin distinguir).`],
    }
  }
  if (porPeso) {
    // El PAC calcula con hasta 6 decimales; si precio × kilos no cae en centavos exactos, la suma del
    // documento puede diferir de lo cobrado (0.5 kg × $39.99 = 19.995): fuera del sobre.
    const exacto = new Prisma.Decimal(String(it.unitPrice))
      .mul(new Prisma.Decimal(String(unidades)))
      .toDecimalPlaces(2)
      .equals(new Prisma.Decimal(String(it.unitPrice)).mul(new Prisma.Decimal(String(unidades))))
    if (!exacto)
      return {
        items: [],
        motivos: [`«${nombreProducto}»: precio × kilos no cae en centavos exactos; no se puede garantizar el importe ante el PAC.`],
      }
    if (it.product?.satUnitKey !== 'KGM') {
      return { items: [], motivos: [`«${nombreProducto}»: venta por peso sin clave SAT de unidad de peso (KGM) en el producto.`] }
    }
  }
  // Los extras deben explicar EXACTAMENTE la diferencia: precio por unidad × cantidad del padre (así lo
  // guardan TPV y mobile). Si no cuadra —p. ej. un cambio de precio a media cuenta que dejó `unitPrice`
  // viejo— no se inventa un extra con la diferencia.
  const extrasEsperadosCents = conPrecio.reduce((sum, m) => sum + centavos(m.price) * (m.quantity ?? 1), 0) * (porPeso ? 1 : it.quantity)
  if (extrasCents !== extrasEsperadosCents) {
    return {
      items: [],
      motivos: [
        `«${nombreProducto}»: el importe del renglón (${pesosTxt(totalCents)}) no cuadra con precio × cantidad + extras (${pesosTxt(baseCents + extrasEsperadosCents)}).`,
      ],
    }
  }
  if (descuentoCents > totalCents) {
    return {
      items: [],
      motivos: [
        `«${nombreProducto}»: el descuento (${pesosTxt(descuentoCents)}) es mayor que el importe del renglón (${pesosTxt(totalCents)}).`,
      ],
    }
  }

  const producto: RenglonParaCfdi = {
    ...it,
    productName,
    quantity: unidades,
    unitPrice: new Prisma.Decimal(String(it.unitPrice)),
    discountAmount: 0,
    modifiers: [],
  }
  const partesExtras = repartir(
    extrasCents,
    conPrecio.map(m => centavos(m.price) * (m.quantity ?? 1)),
  )
  const conceptosExtras: RenglonParaCfdi[] = partesExtras.map((cents, i) => ({
    productName: `${conPrecio[i].name?.trim() || 'Extra'} (${nombreProducto})`,
    quantity: 1,
    unitPrice: new Prisma.Decimal(cents / 100),
    discountAmount: 0,
    weightQuantity: null,
    modifiers: [],
    product: it.product, // mismas claves SAT y misma tasa que el producto al que acompañan
  }))
  const items = [producto, ...conceptosExtras]
  // El descuento del renglón se reparte en proporción al importe de cada concepto (cortesía = 100 % de cada uno).
  const partesDescuento = repartir(
    descuentoCents,
    items.map(c => importeConceptoCents(c)),
  )
  return { items: items.map((c, i) => ({ ...c, discountAmount: new Prisma.Decimal(partesDescuento[i] / 100) })), motivos: [] }
}

/**
 * Reparte el descuento GENERAL de la orden entre los conceptos como descuento de concepto (el CFDI no
 * tiene descuento global), en proporción al neto de cada uno: Σ netos == lo cobrado. Sólo cuando todos
 * los conceptos llevan la MISMA tasa: repartirlo entre tasas distintas cuadra el total pero mueve base
 * gravable de una tasa a otra (Codex, pasada 4).
 */
export function repartirDescuentoDeOrden(items: RenglonParaCfdi[], orderDiscountCents: number): ConceptosDeRenglon {
  if (orderDiscountCents <= 0) return { items, motivos: [] }
  const tasas = new Set(items.map(it => Number(it.product?.taxRate ?? 0.16)))
  if (tasas.size > 1) {
    return {
      items,
      motivos: [
        'La cuenta lleva un descuento general y productos con IVA distinto; el reparto del descuento entre tasas no está soportado todavía.',
      ],
    }
  }
  const netos = items.map(it => importeConceptoCents(it) - centavos(it.discountAmount))
  const base = netos.reduce((a, b) => a + b, 0)
  if (base < orderDiscountCents) {
    return {
      items,
      motivos: [`El descuento general (${pesosTxt(orderDiscountCents)}) es mayor que el importe de la cuenta (${pesosTxt(base)}).`],
    }
  }
  const partes = repartir(orderDiscountCents, netos)
  return {
    items: items.map((it, i) => ({ ...it, discountAmount: new Prisma.Decimal((centavos(it.discountAmount) + partes[i]) / 100) })),
    motivos: [],
  }
}

/** Última red antes del PAC: ningún concepto con importe negativo ni descuento mayor que su importe. */
export function validarConceptos(items: RenglonParaCfdi[]): string[] {
  const motivos: string[] = []
  for (const it of items) {
    const importe = importeConceptoCents(it)
    const descuento = centavos(it.discountAmount)
    if (importe < 0) motivos.push(`Concepto «${it.productName}»: importe negativo.`)
    if (descuento < 0 || descuento > importe) {
      motivos.push(`Concepto «${it.productName}»: descuento (${pesosTxt(descuento)}) mayor que su importe (${pesosTxt(importe)}).`)
    }
  }
  return motivos
}

export interface OrdenParaConceptos {
  items: RenglonParaCfdi[]
  discountAmount?: any
  serviceChargeAmount?: any
  promotions?: Array<{ id: string }> | null
}

/**
 * Orden con renglones → conceptos de la factura dentro del SOBRE SEGURO, o los motivos por los que se
 * bloquea. Compartido por la factura individual y la global para que las dos digan lo mismo.
 */
/** Exclusiones a nivel ORDEN (aplican con y sin renglones). */
export function motivosDeOrden(order: OrdenParaConceptos): string[] {
  const motivos: string[] = []
  if ((order.promotions?.length ?? 0) > 0) {
    motivos.push('La cuenta lleva una promoción; la facturación de cuentas con promoción llega en la siguiente versión.')
  }
  if (centavos(order.serviceChargeAmount) > 0) {
    motivos.push('La cuenta lleva cargo por servicio; la facturación de cargos por servicio llega en la siguiente versión.')
  }
  return motivos
}

export function reconstruirConceptos(order: OrdenParaConceptos, orderId: string): ConceptosDeRenglon {
  const motivos: string[] = motivosDeOrden(order)
  const porRenglon = order.items.map(it => conceptosDesdeRenglon(it, orderId))
  motivos.push(...porRenglon.flatMap(r => r.motivos))
  let items = porRenglon.flatMap(r => r.items)
  // `Order.discountAmount` en TPV/mobile = descuentos de renglón + descuento general; el general es lo que
  // sobra tras restar lo que ya vive en cada renglón.
  const descuentoRenglonesCents = order.items.reduce((sum, it) => sum + centavos(it.discountAmount), 0)
  const descuentoOrdenCents = Math.max(0, centavos(order.discountAmount) - descuentoRenglonesCents)
  // 🔴 El alcance de un descuento de orden NO se puede demostrar con los datos: TPV guarda el descuento
  // dirigido a artículos sólo como total de orden, y el motor de descuentos de catálogo tampoco deja
  // rastro por renglón (Codex, pasadas 6 y 7). Repartirlo entre varios renglones pondría el descuento
  // en el producto equivocado con el total cuadrado. Con UN solo renglón el alcance es inequívoco.
  // Se cuentan CONCEPTOS reconstruidos, no renglones: una línea con extras produce varios conceptos y el
  // motor de descuentos admite descontar SÓLO un extra (MODIFIER / MODIFIER_GROUP) — también sin rastro.
  if (descuentoOrdenCents > 0 && items.length > 1) {
    motivos.push(
      'La cuenta lleva un descuento general sobre varios artículos o extras; la facturación de descuentos generales llega en la siguiente versión.',
    )
  }
  if (motivos.length === 0) {
    const repartido = repartirDescuentoDeOrden(items, descuentoOrdenCents)
    items = repartido.items
    motivos.push(...repartido.motivos)
    motivos.push(...validarConceptos(items))
  }
  return { items, motivos }
}

/**
 * DB-backed order loader for CFDI issuance — extracted from defaultDeps so the tenant guard
 * (emisor.venueId MUST equal order.venueId) and merchant-resolution edge cases are unit-testable.
 */
/**
 * Métodos que pueden facturarse sin comercio (el cobro no pasó por una terminal nuestra): efectivo,
 * transferencia, y tarjeta cobrada en otra terminal. Los tipos del catálogo (`OTHER`: Uber Eats, vales…)
 * y cripto quedan fuera: quién factura esa venta no es evidente.
 */
const METODOS_SIN_COMERCIO = new Set<string>(['CASH', 'BANK_TRANSFER', 'CREDIT_CARD', 'DEBIT_CARD'])

export interface LoadOrderForCfdiOpts {
  /**
   * `true` cuando la factura la emite el PERSONAL a propósito (Pedidos → Facturar, o una sustitución).
   * El interruptor «Facturar ventas en efectivo» (`invoiceCashSales`) gobierna la AUTOFACTURA del cliente
   * y la factura global — así lo dice su definición en el schema —, no la decisión deliberada del dueño.
   * Por default `false`: todo lector que no lo pida (QR del ticket, portal) sigue siendo estricto.
   */
  permitirEfectivo?: boolean
}

export async function loadOrderForCfdiFromDb(orderId: string, opts: LoadOrderForCfdiOpts = {}): Promise<LoadedOrderBundle | null> {
  // Tenant-safe load: order + items + product(+category) + venue.
  // Emisor is now resolved via the most-recent payment's merchant → MerchantFiscalConfig → fiscalEmisor.
  // Schema-verified field names:
  //   Order → venue (slug, type), payments (method, merchantAccountId, ecommerceMerchantId),
  //           items, subtotal, taxAmount, total, tipAmount
  //   OrderItem → productName, quantity, unitPrice, discountAmount, product → { satProductKey, satUnitKey, objetoImp, taxRate, category }
  //   MenuCategory → defaultSatProductKey, defaultSatUnitKey
  //   Payment → method  (NOT paymentMethod — schema field is "method")
  //   MerchantFiscalConfig → facturacionEnabled, autofacturaEnabled, fiscalEmisor (unique on merchantAccountId XOR ecommerceMerchantId)
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      venueId: true,
      subtotal: true,
      taxAmount: true,
      total: true,
      tipAmount: true,
      discountAmount: true,
      serviceChargeAmount: true,
      promotions: { select: { id: true }, take: 1 },
      venue: {
        select: {
          slug: true,
          type: true,
        },
      },
      payments: {
        // TODOS los pagos liquidados de la orden (no solo el último): en una orden MIXTA (efectivo +
        // tarjeta) hay que ver si ALGÚN pago fue en efectivo, no solo el más reciente.
        // Sólo COBROS elegibles: REGULAR/FAST (`null` = legado). TEST y ADJUSTMENT no son ventas; REFUND
        // no resta — la devolución lleva su propia nota de crédito (`cfdiCreditNote.service`).
        where: { status: 'COMPLETED', OR: [{ type: { in: ['REGULAR', 'FAST'] } }, { type: null }] },
        orderBy: { createdAt: 'desc' },
        select: { method: true, merchantAccountId: true, ecommerceMerchantId: true, tenderSatFormaPago: true, amount: true, type: true },
      },
      items: {
        select: {
          productName: true,
          quantity: true,
          unitPrice: true,
          discountAmount: true,
          total: true,
          weightQuantity: true,
          modifiers: { select: { name: true, price: true, quantity: true } },
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
  if (!order) return null

  // Resolver el emisor por el pago que trae merchant (el que cobró por procesador). En una orden mixta
  // el efectivo no trae merchant, así que se prefiere el pago con tarjeta para resolver el emisor.
  // Defensa en profundidad: el `where` ya filtra, pero la regla de elegibilidad vive también aquí para
  // que ningún llamador con filas sin filtrar (o una prueba) sume un pago TEST/ADJUSTMENT/REFUND.
  const pays = order.payments.filter(pp => esCobroElegible(pp))
  const pay = pays.find(pp => pp.merchantAccountId || pp.ecommerceMerchantId) ?? pays[0]
  if (!pay) return null

  const EMISOR_SELECT = {
    id: true,
    venueId: true,
    provider: true,
    providerKeyEnc: true,
    csdStatus: true,
    serie: true,
    invoiceCashSales: true,
  } as const
  let cfg: {
    facturacionEnabled: boolean
    autofacturaEnabled: boolean
    fiscalEmisor: {
      id: string
      venueId: string
      provider: FiscalProviderType
      providerKeyEnc: string | null
      csdStatus: CsdStatus
      serie: string | null
      invoiceCashSales: boolean
    } | null
  } | null

  if (pay.merchantAccountId || pay.ecommerceMerchantId) {
    // Resolve MerchantFiscalConfig via the unique merchantAccountId XOR ecommerceMerchantId
    cfg = await prisma.merchantFiscalConfig.findUnique({
      where: pay.merchantAccountId ? { merchantAccountId: pay.merchantAccountId } : { ecommerceMerchantId: pay.ecommerceMerchantId! },
      select: { facturacionEnabled: true, autofacturaEnabled: true, fiscalEmisor: { select: EMISOR_SELECT } },
    })
  } else {
    // 🔴 Venta SIN terminal (efectivo, transferencia, tarjeta de otra terminal). Testarudo, 24-sep-2026:
    // 698 ventas en efectivo y una transferencia de $3,082 en 30 días no se podían facturar porque el
    // emisor sólo se sacaba del comercio de la terminal. El emisor es el del NEGOCIO, y sólo cuando es
    // inequívoco: con UN solo RFC. Con dos o más no se adivina (queda como antes).
    if (pays.some(pp => !METODOS_SIN_COMERCIO.has(pp.method))) return null
    const emisores = await prisma.fiscalEmisor.findMany({
      where: { venueId: order.venueId },
      select: { ...EMISOR_SELECT, merchantConfigs: { select: { facturacionEnabled: true, autofacturaEnabled: true }, take: 50 } },
      take: 2,
    })
    if (emisores.length !== 1) return null
    const { merchantConfigs, ...emisor } = emisores[0]
    // Hereda los interruptores de SUS comercios: se factura si alguno la tiene encendida; la autofactura
    // sólo si TODOS los que facturan la tienen encendida (mismo criterio que una cuenta con varios comercios).
    const encendidos = merchantConfigs.filter(c => c.facturacionEnabled)
    cfg = {
      facturacionEnabled: encendidos.length > 0,
      autofacturaEnabled: encendidos.length > 0 && encendidos.every(c => c.autofacturaEnabled),
      fiscalEmisor: emisor,
    }
  }
  // No merchant config or emisor not set up → cannot invoice
  if (!cfg || !cfg.fiscalEmisor) return null

  // Todos los pagos con comercio deben resolver al MISMO emisor: una cuenta cobrada mitad con un comercio
  // del RFC A y mitad con uno del RFC B no se factura completa bajo A «porque fue el más reciente».
  // Todos los comercios de la cuenta cuentan por igual (no «el primero»): mismo emisor, con configuración
  // y con facturación encendida; la autofactura sólo se ofrece si TODOS la tienen encendida.
  const motivosComercios: string[] = []
  let autofacturaTodos = cfg.autofacturaEnabled
  for (const otro of pays.filter(pp => pp !== pay && (pp.merchantAccountId || pp.ecommerceMerchantId))) {
    const cfgOtro = await prisma.merchantFiscalConfig.findUnique({
      where: otro.merchantAccountId ? { merchantAccountId: otro.merchantAccountId } : { ecommerceMerchantId: otro.ecommerceMerchantId! },
      select: { facturacionEnabled: true, autofacturaEnabled: true, fiscalEmisor: { select: { id: true } } },
    })
    if (!cfgOtro || !cfgOtro.fiscalEmisor)
      motivosComercios.push('La cuenta se cobró con un comercio sin configuración fiscal; factúrala por separado.')
    else if (cfgOtro.fiscalEmisor.id !== cfg.fiscalEmisor.id)
      motivosComercios.push('La cuenta se cobró con comercios de RFC distinto; factúrala por separado.')
    else if (!cfgOtro.facturacionEnabled)
      motivosComercios.push('La cuenta se cobró con un comercio que tiene la facturación apagada; factúrala por separado.')
    else if (!cfgOtro.autofacturaEnabled) autofacturaTodos = false
  }

  // Cash sales are not invoiceable unless the emisor opted in (most venues don't declare cash, so a
  // cash-settled ticket must not self-invoice via the receipt QR). En una orden MIXTA basta que CUALQUIER
  // pago sea en efectivo para bloquearla — si no, se facturaría el total (incl. la parte de efectivo).
  // Salvo que la emita el personal a propósito (`permitirEfectivo`): ver `LoadOrderForCfdiOpts`.
  const hasCash = pays.some(pp => pp.method === 'CASH')
  if (hasCash && !cfg.fiscalEmisor.invoiceCashSales && !opts.permitirEfectivo) return null

  // Tenant isolation: a MerchantAccount can be shared across venues in the same org (via VenuePaymentConfig
  // primary/secondary/tertiary slots). The emisor it maps to MUST belong to THIS order's venue — otherwise
  // venue B could stamp a CFDI under venue A's RFC. FiscalEmisor is venue-scoped (@@unique([venueId, rfc])).
  if (cfg.fiscalEmisor.venueId !== order.venueId) {
    logger.warn(
      `[cfdi] emisor/venue mismatch for order ${orderId}: order.venueId=${order.venueId}, emisor.venueId=${cfg.fiscalEmisor.venueId} — refusing to stamp`,
    )
    return null
  }

  const peso = (d: any) => Math.round(Number(d) * 100)

  // Lo que el cliente pagó por la orden: Σ cobros elegibles (ver el `where` de arriba). `Payment.amount`
  // NUNCA trae la propina (va en `tipAmount`), así que esto es exactamente la base facturable.
  const paidCents = pays.reduce((sum, pp) => sum + peso(pp.amount), 0)

  // Custom-amount / quick sales (e.g. an "Importe personalizado" charge on the POS) carry NO line
  // items — but the customer still has the right to invoice what they paid. Fall back to a SINGLE
  // generic concepto for what was PAID (SAT clave 01010101 "no existe en el catálogo" + unidad
  // ACT), so the CFDI has at least one line instead of failing with "no tiene conceptos".
  // 🔴 Lo pagado, no `order.total`: en varias fuentes `Order.total` ya trae la propina dentro, y la
  // propina jamás va en el CFDI.
  const sinRenglones = order.items.length === 0
  const { items: itemsReconstruidos, motivos: unsupportedReasons } = sinRenglones
    ? {
        items: [
          {
            productName: 'Venta',
            quantity: 1,
            unitPrice: new Prisma.Decimal(paidCents / 100),
            discountAmount: 0,
            product: { satProductKey: '01010101', satUnitKey: 'ACT', objetoImp: '02', taxRate: 0.16, category: null },
          } as unknown as RenglonParaCfdi,
        ],
        // Las exclusiones de ORDEN (promoción, cargo por servicio) aplican también sin renglones.
        motivos: motivosDeOrden(order as OrdenParaConceptos),
      }
    : reconstruirConceptos(order as OrdenParaConceptos, orderId)
  unsupportedReasons.push(...Array.from(new Set(motivosComercios)))
  const items = itemsReconstruidos as unknown as typeof order.items

  // Mexican POS prices are IVA-included (gross): the customer's out-of-pocket already contains the
  // tax, and these orders carry taxAmount=0 (e.g. TPV). A non-zero taxAmount means a separated-tax
  // source (reservations, pos-sync) whose subtotal/taxAmount/total are already the real split.
  // 🔴 El concepto de respaldo (sin renglones) es SIEMPRE «lo pagado, IVA incluido»: si se mandara como
  // neto en una orden NET, el PAC le sumaría el 16 % encima de lo que el cliente ya pagó.
  const pricesIncludeIva = peso(order.taxAmount) === 0 || sinRenglones

  let subtotalCents: number
  let taxCents: number
  let totalCents: number
  if (pricesIncludeIva) {
    // Derive base + IVA per concepto from the gross line so the row cuadra al centavo AND the total
    // stays equal to what the customer paid (tax_included stamping preserves the gross at the PAC).
    subtotalCents = 0
    taxCents = 0
    totalCents = 0
    for (const it of items) {
      const rate = it.product ? Number(it.product.taxRate) : 0.16
      const grossLine = importeConceptoCents(it) - peso(it.discountAmount)
      const split = splitIvaIncluded(grossLine, rate)
      subtotalCents += split.netCents
      taxCents += split.taxCents
      totalCents += grossLine
    }
  } else {
    subtotalCents = peso(order.subtotal)
    taxCents = peso(order.taxAmount)
    totalCents = peso(order.total)
  }

  // El documento que se mandaría al PAC tiene que cuadrar con lo cobrado. Se declara AQUÍ (y no sólo en
  // el motor) para que el ticket y el recibo tampoco ofrezcan una autofactura que después fallaría.
  if (unsupportedReasons.length === 0) {
    const documentoCents = totalDelDocumentoCents({ items: items as any, pricesIncludeIva })
    if (documentoCents !== paidCents) {
      unsupportedReasons.push(
        `El total de la factura (${pesosTxt(documentoCents)}) no coincide con lo cobrado (${pesosTxt(paidCents)}). No se timbró; revisa la cuenta o repórtala a soporte.`,
      )
    }
  }

  return {
    venueId: order.venueId,
    venueSlug: order.venue.slug,
    venueType: order.venue.type,
    emisor: cfg.fiscalEmisor,
    facturacionEnabled: cfg.facturacionEnabled,
    autofacturaEnabled: autofacturaTodos,
    paymentMethod: pay.method,
    tenderSatFormaPago: pay.tenderSatFormaPago ?? null,
    metodoPago: 'PUE', // POS = PUE (PPD/REP deferred)
    subtotalCents,
    taxCents,
    paidCents,
    totalCents,
    ...(unsupportedReasons.length > 0 ? { unsupportedReasons } : {}),
    order: { venueType: order.venue.type, tipAmount: order.tipAmount, items: items as any, pricesIncludeIva },
  }
}

/** Importes y clasificación de pago del documento realmente emitido. */
function moneyFields(data: Record<string, any>) {
  const keys = ['subtotalCents', 'taxCents', 'totalCents', 'discountCents', 'formaPago', 'metodoPago'] as const
  const out: Record<string, any> = {}
  for (const k of keys) if (data[k] !== undefined) out[k] = data[k]
  return out
}

function stampedFields(data: Record<string, any>) {
  const keys = ['facturapiId', 'uuid', 'serie', 'folio', 'stampedAt', 'xmlUrl', 'pdfUrl'] as const
  const out: Record<string, any> = {}
  for (const k of keys) if (data[k] !== undefined) out[k] = data[k]
  return out
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

export interface CancelCfdiDeps {
  loadCfdi: (cfdiId: string) => Promise<any | null>
  resolveProvider: typeof resolveFiscalProvider
  updateCfdi: (cfdiId: string, data: Record<string, any>) => Promise<any>
}

export interface CancelCfdiResult {
  cancelStatus: 'REQUESTED' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED'
  cancelledAt: Date | null
  cfdi: any
}

export async function cancelCfdi(
  params: {
    cfdiId: string
    motivo: '01' | '02' | '03' | '04'
    substituteUuid?: string
    sandbox: boolean
    expectedVenueId?: string
  },
  deps: CancelCfdiDeps = defaultCancelDeps,
): Promise<CancelCfdiResult> {
  // 1. Load + tenant isolation
  const cfdi = await deps.loadCfdi(params.cfdiId)
  if (!cfdi) throw new Error(`CFDI ${params.cfdiId} not found`)
  if (params.expectedVenueId && cfdi.venueId !== params.expectedVenueId) {
    throw new Error(`CFDI ${params.cfdiId} not found`) // tenant isolation → 404
  }

  // 2. Business-rule guards (spec §12: shape-only in Zod; rules stay in service)
  if (cfdi.status !== 'STAMPED') {
    throw new Error('Solo se puede cancelar un CFDI timbrado (STAMPED)')
  }
  if (params.motivo === '01' && !params.substituteUuid) {
    throw new Error('El motivo 01 requiere el UUID de sustitución')
  }

  // 3. Call the PAC via the provider interface
  const provider = deps.resolveProvider(cfdi.fiscalEmisor, { sandbox: params.sandbox })
  const result = await provider.cancelInvoice({
    providerInvoiceId: cfdi.facturapiId,
    motivo: params.motivo,
    substituteUuid: params.substituteUuid,
  })

  // 4. Map provider status → CfdiCancelStatus enum
  const cancelStatus = mapProviderCancelStatus(result.status)
  // 🔴 `none` y `expired` NO son cancelaciones: la factura sigue vigente ante el SAT. Se guardan como
  // rechazo (que es lo que el dueño necesita saber: no quedó cancelada) pero con su razón propia, para
  // que la pantalla no diga sólo «rechazada» cuando en realidad nadie la rechazó.
  const porQue =
    result.status === 'none'
      ? 'El PAC no registró la cancelación: la factura sigue vigente. Vuelve a intentarlo.'
      : result.status === 'expired'
        ? 'La solicitud de cancelación caducó sin respuesta del receptor: la factura sigue vigente. Vuelve a pedirla.'
        : null

  // 5. Persist — update cancel fields + flip cfdi.status when definitively resolved
  const updated = await deps.updateCfdi(cfdi.id, {
    cancelMotivo: params.motivo,
    // 🔴 Nunca se BORRA lo que ya constaba: una respuesta `pending` que llega tarde no puede tirar
    // el sustituto ni la fecha de una cancelación que el SAT ya confirmó (Codex P2-5).
    ...(params.substituteUuid ? { cancelSubstituteUuid: params.substituteUuid } : {}),
    cancelStatus,
    cancelRequestedAt: new Date(),
    ...(result.cancelledAt ? { cancelledAt: result.cancelledAt } : {}),
    ...(porQue ? { lastError: porQue } : {}),
    // Sólo se marca CANCELLED cuando el PAC lo confirma — y nunca se baja de CANCELLED.
    status: cancelStatus === 'CANCELLED' || cancelStatus === 'ACCEPTED' || cfdi.status === 'CANCELLED' ? 'CANCELLED' : cfdi.status,
  })

  return { cancelStatus, cancelledAt: result.cancelledAt, cfdi: updated }
}

function mapProviderCancelStatus(s: string): 'REQUESTED' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED' {
  switch (s) {
    case 'canceled':
      return 'CANCELLED'
    case 'accepted':
      return 'ACCEPTED'
    // La factura sigue vigente: se registran como «no quedó cancelada», con su razón en `lastError`.
    case 'none':
    case 'expired':
      return 'REJECTED'
    case 'rejected':
      return 'REJECTED'
    default:
      // 'pending' / 'verifying' / unknown → still awaiting SAT resolution
      return 'REQUESTED'
  }
}

// Real defaults — mirror defaultDeps pattern
const defaultCancelDeps: CancelCfdiDeps = {
  loadCfdi: id => prisma.cfdi.findUnique({ where: { id }, include: { fiscalEmisor: true } }),
  resolveProvider: resolveFiscalProvider,
  updateCfdi: (id, data) => prisma.cfdi.update({ where: { id }, data }),
}

// ─── Cancelaciones que el SAT dejó «en trámite» ───────────────────────────────
//
// Testarudo, 21→24-sep-2026: al cancelar la A-14 el PAC contestó «en trámite», se guardó REQUESTED y
// NADIE volvió a preguntar. El SAT la canceló minutos después; Avoqado siguió diciendo «Timbrada» tres
// días y no dejaba volver a facturar la venta. Esto es lo que faltaba: preguntar después.

export interface RefreshCancellationDeps {
  loadEmisor: (fiscalEmisorId: string) => Promise<any | null>
  resolveProvider: typeof resolveFiscalProvider
  /**
   * Escribe el desenlace SÓLO si la fila sigue en trámite (CAS). Devuelve la fila actualizada, o `null`
   * si otra petición ya la había resuelto — así nunca se escribe la bitácora dos veces.
   */
  applyCancelOutcome: (cfdiId: string, data: Record<string, any>) => Promise<any | null>
  logAction: (params: LogActionParams) => Promise<void>
}

/** Por qué una cancelación NO quedó, en palabras del dueño. `null` si sí quedó o sigue en trámite. */
function porQueNoQuedoCancelada(providerStatus: string): string | null {
  switch (providerStatus) {
    case 'none':
      return 'El PAC no registró la cancelación: la factura sigue vigente. Vuelve a intentarlo.'
    case 'expired':
      return 'La solicitud de cancelación caducó sin respuesta del receptor: la factura sigue vigente. Vuelve a pedirla.'
    case 'rejected':
      return 'El receptor rechazó la cancelación ante el SAT: la factura sigue vigente.'
    default:
      return null
  }
}

export async function refreshPendingCancellation(
  cfdi: any,
  opts: { sandbox: boolean },
  deps: RefreshCancellationDeps = defaultRefreshDeps,
): Promise<any> {
  if (cfdi.cancelStatus !== 'REQUESTED' || !cfdi.facturapiId) return cfdi
  const emisor = cfdi.fiscalEmisor ?? (cfdi.fiscalEmisorId ? await deps.loadEmisor(cfdi.fiscalEmisorId) : null)
  if (!emisor) return cfdi
  const provider = deps.resolveProvider(emisor, { sandbox: opts.sandbox })
  if (typeof provider.getCancellationStatus !== 'function') return cfdi

  const res = await provider.getCancellationStatus(cfdi.facturapiId)
  const cancelStatus = mapProviderCancelStatus(res.status)
  if (cancelStatus === 'REQUESTED') return cfdi // sigue en trámite: no hay nada que escribir

  const cancelada = cancelStatus === 'CANCELLED' || cancelStatus === 'ACCEPTED'
  const razon = cancelada ? null : porQueNoQuedoCancelada(res.status)
  const updated = await deps.applyCancelOutcome(cfdi.id, {
    cancelStatus,
    // Sólo se marca CANCELLED cuando el PAC lo confirma — y nunca se baja de CANCELLED.
    status: cancelada || cfdi.status === 'CANCELLED' ? 'CANCELLED' : cfdi.status,
    // La fecha es la que registró el PAC; sin ella se deja vacía en vez de inventar una.
    ...(res.cancelledAt ? { cancelledAt: res.cancelledAt } : {}),
    ...(razon ? { lastError: razon } : {}),
  })
  if (!updated) return cfdi

  await deps.logAction({
    staffId: null,
    venueId: cfdi.venueId,
    action: cancelada ? 'CFDI_CANCEL_CONFIRMED' : 'CFDI_CANCEL_NOT_APPLIED',
    entity: 'Cfdi',
    entityId: cfdi.id,
    data: { uuid: cfdi.uuid ?? null, folio: folioDe(cfdi), providerStatus: res.status, cancelStatus },
  })
  return updated
}

const defaultRefreshDeps: RefreshCancellationDeps = {
  loadEmisor: id => prisma.fiscalEmisor.findUnique({ where: { id } }),
  resolveProvider: resolveFiscalProvider,
  applyCancelOutcome: async (id, data) => {
    const { count } = await prisma.cfdi.updateMany({ where: { id, cancelStatus: 'REQUESTED' }, data })
    if (count === 0) return null
    return prisma.cfdi.findUnique({ where: { id }, include: { fiscalEmisor: true } })
  },
  logAction,
}

export interface SyncPendingCancellationsDeps {
  /** Filas con cancelación en trámite pedida antes de `cutoff`, acotadas. */
  findPending: (cutoff: Date) => Promise<any[]>
  refresh: (cfdi: any) => Promise<any>
}

/** Cuánto se espera tras pedir la cancelación antes de volver a preguntar (el SAT suele tardar minutos). */
export const CANCEL_RECHECK_AFTER_MS = 2 * 60_000
/** Tope por pasada del barrido (bounded-queries): cada fila es una llamada al PAC. */
export const CANCEL_SYNC_MAX_PER_TICK = 50

/**
 * El barrido del job: le pregunta al PAC por cada cancelación en trámite. Un fallo en una fila no
 * detiene a las demás; la que falló se reintenta en la siguiente pasada.
 */
export async function syncPendingCancellations(
  params: { sandbox: boolean; now: Date },
  deps: SyncPendingCancellationsDeps = {
    findPending: cutoff =>
      prisma.cfdi.findMany({
        where: { cancelStatus: 'REQUESTED', cancelRequestedAt: { lt: cutoff } },
        orderBy: [{ cancelRequestedAt: 'asc' }, { id: 'asc' }],
        take: CANCEL_SYNC_MAX_PER_TICK,
        include: { fiscalEmisor: true },
      }),
    refresh: cfdi => refreshPendingCancellation(cfdi, { sandbox: params.sandbox }),
  },
): Promise<{ revisadas: number; resueltas: number; siguenEnTramite: number; errores: number }> {
  const pendientes = await deps.findPending(new Date(params.now.getTime() - CANCEL_RECHECK_AFTER_MS))
  const tally = { revisadas: pendientes.length, resueltas: 0, siguenEnTramite: 0, errores: 0 }
  for (const cfdi of pendientes) {
    try {
      const r = await deps.refresh(cfdi)
      if (r?.cancelStatus && r.cancelStatus !== 'REQUESTED') tally.resueltas += 1
      else tally.siguenEnTramite += 1
    } catch (err: unknown) {
      tally.errores += 1
      // warn, no error: la fila sigue «en trámite» y se reintenta en la siguiente pasada (cada 5 min). Como
      // error, una sola factura que el PAC no reconoce llenaba el log de alertas falsas (full-testing 24-sep).
      // El recuento `errores` sale en el resumen de la pasada.
      logger.warn(`[cfdi] no se pudo consultar la cancelación de ${cfdi.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return tally
}

// ─── Status ───────────────────────────────────────────────────────────────────

export interface GetCfdiStatusDeps {
  loadCfdi: (cfdiId: string) => Promise<any | null>
}

export async function getCfdiStatus(
  params: { cfdiId: string; expectedVenueId?: string },
  deps: GetCfdiStatusDeps = defaultStatusDeps,
): Promise<any> {
  const cfdi = await deps.loadCfdi(params.cfdiId)
  if (!cfdi) throw new Error(`CFDI ${params.cfdiId} not found`)
  if (params.expectedVenueId && cfdi.venueId !== params.expectedVenueId) {
    throw new Error(`CFDI ${params.cfdiId} not found`) // tenant isolation → 404
  }
  return cfdi
}

// Real defaults
const defaultStatusDeps: GetCfdiStatusDeps = {
  loadCfdi: id =>
    prisma.cfdi.findUnique({
      where: { id },
      include: {
        replacedBy: { select: { id: true, uuid: true, serie: true, folio: true, status: true }, orderBy: { createdAt: 'desc' }, take: 5 },
      },
    }),
}
