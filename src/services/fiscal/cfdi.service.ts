// src/services/fiscal/cfdi.service.ts
import { ConflictError, ProviderUnavailableError } from '../../errors/AppError'
import { bloquearOrdenParaFacturar, bloquearOrdenesParaFacturar, tomarAdmisionCompartida } from './admisionIva'
import { excluirSiEstaEnGlobal, CFDI_VIVO, llavePrincipalDe } from './exclusionGlobal'
import { capturarEntrada, huellaDeEntrada, leerEntrada, EntradaDocumentalV1 } from './entradaDocumental'
import { finalizarTimbre, completarArchivos, escalarIntentoIncierto, ArchivosCfdi, conLimiteDeTiempo } from './finalizadorCfdi'
import { sellarRenglones, liberarSellosDe } from './sellosIva'
import { esRechazoConfirmado, ProviderHttpError, TIEMPO_LIMITE_CONSULTA_MS, TIEMPO_LIMITE_ENVIO_MS } from './providers/facturapi.provider'
import type { StampedInvoice, ProviderInvoiceSummary } from './providers/fiscal-provider.interface'
import { CsdStatus, FiscalProviderType, PaymentMethod, VenueType, CfdiStatus, CfdiFlow, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { fromZonedTime } from 'date-fns-tz'
import { DEFAULT_TIMEZONE } from '../../utils/datetime'
import { uploadFileToStorage } from '../storage.service'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import { buildCreateInvoiceParams } from './cfdiPayloadBuilder'
import { SIN_CONCEPTOS, validateBeforeStamp } from './cfdiValidation'
import { assembleSaleInput, LoadedOrderForCfdiResuelto } from './assembleSaleInput'
import { splitIvaIncluded } from './ivaMath'
import { clasificarOrden, hayBloqueados, impuestosSatDe, resolverTratamiento } from './ivaDeRenglon'
import { IvaTratamiento, tuplaDesdeTratamiento } from './ivaTratamiento'
import { logAction, LogActionParams } from '../dashboard/activity-log.service'
import { sendNewCfdiByEmail } from './cfdiEmail.service'
import { conceptoDesdeElPayload, cotaDeRedondeoCents, cuadrarConElPac, totalSegunElPacCents, type TrasladoParaElPac } from './reglaDelPac'
import {
  descuentoDeCuentaPorRenglon,
  descuentoPropioEnCabeceraCents,
  DESCUENTOS_PARA_CONCEPTOS,
  type FilaDeDescuento,
  netoRenglonCents,
} from './descuentoPorRenglon'
import { filasDeDescuentoCompletas } from './filasDeDescuentoTx'
import { timbreEnDuda } from './timbreEnDuda'
import { leerReparto } from '../shared/repartoDescuento'

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
  // H23: la fecha de una factura sin timbre es la de su último intento.
  updatedAt: true,
  cancelStatus: true,
  // C2 · T10 (Codex C2-31): con estas se deriva `estadoCancelacion` al momento de la consulta. Son INTERNAS: no salen en la respuesta
  // (`vistaDeCancelacion`). (T10 ronda 1, I-1: «Consultar estado» manda `soloConsultar`; el motivo de la cancelación ya no hace falta aquí.)
  cancelEnviadaAt: true,
  cancelAcusadaAt: true,
  cancelIntento: true,
  // C2 · T10 (M9): el porqué de una cancelación rechazada (`motivoRechazoCancelacion`); el `lastError` de otra cosa no sale.
  lastError: true,
  // C2 · ronda QA (D6): con estas se deriva `timbreEnDuda` (un `STAMP_FAILED` que el PAC no rechazó). INTERNAS: no salen (`vistaDeCancelacion`).
  enviadoAt: true,
  falloDefinitivo: true,
  protocoloIva: true,
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
  // C1 · Tarea 11 (contrato S6 del dashboard): el RFC emisor, para pedir la complementaria de una global desde la lista. La llave sólo se lee
  // por dentro (dice si la global es complementaria y de cuál principal) y NO sale en la respuesta.
  fiscalEmisorId: true,
  idempotencyKey: true,
} as const

/**
 * Returns a paginated list of CFDIs for the given venue.
 *
 * Tenant isolation: `venueId` is ALWAYS applied to the `where` clause — it is
 * never optional and is never derived from the request (controller passes
 * authContext.venueId). This prevents cross-venue data leaks.
 *
 * Date range: `from`/`to` are ISO date strings interpreted as venue-local day
 * boundaries (midnight → 23:59:59.999) and converted to real UTC with `fromZonedTime`
 * (host-tz independent) before being passed to Prisma. They filter by the stamp date
 * (or, without a stamp, by the last attempt).
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
    const range: { gte?: Date; lte?: Date } = {}
    // El día se lee en el huso del NEGOCIO, nunca en el del servidor (el esquema ya garantiza AAAA-MM-DD real).
    if (from) range.gte = fromZonedTime(`${from}T00:00:00.000`, timezone)
    if (to) range.lte = fromZonedTime(`${to}T23:59:59.999`, timezone)
    // 🔴 H23: la fecha de una factura es la de su TIMBRADO; sin timbre (borrador, en proceso o fallida), la de su último
    // intento. Antes filtraba por el PRIMER intento: la A-36 de Testarudo (reintento 9, timbrada el 30-sep) salía el 24-sep.
    where.OR = [{ stampedAt: range }, { stampedAt: null, updatedAt: range }]
  }

  const skip = (page - 1) * pageSize
  const take = pageSize

  const [filas, total] = await Promise.all([
    prisma.cfdi.findMany({
      where,
      // 🔴 H23: por fecha de timbrado. Lo no timbrado (en proceso o fallido) va ARRIBA: una factura que acaba de fallar no
      // se esconde en la última página. `id` desempata para que la paginación sea estable.
      orderBy: [{ stampedAt: { sort: 'desc', nulls: 'first' } }, { updatedAt: 'desc' }, { id: 'desc' }],
      skip,
      take,
      select: CFDI_LIST_SELECT,
    }),
    prisma.cfdi.count({ where }),
  ])

  const ahora = new Date()
  return { cfdis: (await conSuPrincipal(venueId, filas)).map(f => vistaDeCancelacion(f, ahora)), total, page, pageSize }
}

/**
 * C2 · T10 (Codex C2-31): la fila de la lista con `estadoCancelacion` derivado en ESTA consulta (`ENVIANDO` pasa a `CANCELACION_EN_DUDA` sin
 * que nadie escriba nada) y, si la cancelación se rechazó, `motivoRechazoCancelacion` (M9). Las columnas internas de la derivación y el
 * `lastError` no salen.
 */
function vistaDeCancelacion<
  T extends {
    status?: string
    cancelStatus: string | null
    cancelEnviadaAt?: Date | null
    cancelAcusadaAt?: Date | null
    cancelIntento?: number | null
    lastError?: string | null
    enviadoAt?: Date | null
    falloDefinitivo?: boolean | null
    protocoloIva?: number | null
  },
>(fila: T, ahora: Date) {
  const {
    cancelEnviadaAt: _enviada,
    cancelAcusadaAt: _acusada,
    cancelIntento: _intento,
    lastError,
    enviadoAt: _enviadoAt,
    falloDefinitivo: _fallo,
    protocoloIva: _protocolo,
    ...resto
  } = fila
  const estadoCancelacion = estadoDeCancelacion(fila, ahora)
  return {
    ...resto,
    estadoCancelacion,
    ...(estadoCancelacion === 'RECHAZADA' && lastError ? { motivoRechazoCancelacion: lastError } : {}),
    // C2 · ronda QA (D6, aditivo): el timbre quedó EN DUDA (el PAC no contestó claro): la lista no lo pinta «rechazada».
    ...(timbreEnDuda(fila) ? { timbreEnDuda: true as const } : {}),
  }
}

/**
 * C1 · Tarea 11 (S6): a cada fila de la lista, `complementariaDe` = el id de la global principal si la fila es una complementaria (su llave
 * `<llave de la principal>-c<n>`), o null (principal o individual). Las principales se buscan por su llave, UNA consulta acotada a la página.
 * La llave no sale en la respuesta. Una complementaria cuya principal no aparece (no debería pasar: las globales no se borran) lee el dato de su
 * propia entrada, también acotado.
 */
async function conSuPrincipal<T extends { id: string; isGlobal: boolean; idempotencyKey: string | null }>(
  venueId: string,
  filas: T[],
): Promise<Array<Omit<T, 'idempotencyKey'> & { complementariaDe: string | null }>> {
  const llaves = [
    ...new Set(
      filas
        .filter(f => f.isGlobal && f.idempotencyKey)
        .map(f => llavePrincipalDe(f.idempotencyKey as string))
        .filter((k): k is string => k !== null),
    ),
  ]
  const porLlave = new Map<string, string>()
  if (llaves.length) {
    const principales = await prisma.cfdi.findMany({
      where: { venueId, isGlobal: true, idempotencyKey: { in: llaves } },
      select: { id: true, idempotencyKey: true },
      take: llaves.length,
    })
    for (const p of principales) if (p.idempotencyKey) porLlave.set(p.idempotencyKey, p.id)
  }
  const deLaEntrada = new Map<string, string>()
  const sinPrincipal = filas.filter(f => {
    const k = f.isGlobal && f.idempotencyKey ? llavePrincipalDe(f.idempotencyKey) : null
    return k !== null && !porLlave.has(k)
  })
  if (sinPrincipal.length) {
    const propias = await prisma.cfdi.findMany({
      where: { venueId, id: { in: sinPrincipal.map(f => f.id) } },
      select: { id: true, entrada: true },
      take: sinPrincipal.length,
    })
    for (const f of propias) {
      const de = (f.entrada as { complementariaDe?: unknown } | null)?.complementariaDe
      if (typeof de === 'string' && de) deLaEntrada.set(f.id, de)
    }
  }
  return filas.map(({ idempotencyKey, ...resto }) => {
    const k = resto.isGlobal && idempotencyKey ? llavePrincipalDe(idempotencyKey) : null
    return { ...resto, complementariaDe: k === null ? null : (porLlave.get(k) ?? deLaEntrada.get(resto.id) ?? null) }
  })
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
   * Razones por las que ESTA orden queda fuera del sobre seguro (reserva con extras, cargo
   * por servicio, IVA mixto con descuento general…). Con razones, el motor NO timbra: responde
   * VALIDATION_FAILED con el texto, y el ticket/recibo no ofrecen autofactura.
   */
  unsupportedReasons?: string[]
  order: LoadedOrderForCfdiResuelto
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
  loadOrderForCfdi: (orderId: string, opts?: LoadOrderForCfdiOpts, tx?: Prisma.TransactionClient) => Promise<LoadedOrderBundle | null>
  resolveProvider: typeof resolveFiscalProvider
  storeArtifact: (buffer: Buffer, path: string, contentType: string) => Promise<string>
  persistCfdi: (data: Record<string, any>, where?: Prisma.CfdiWhereInput) => Promise<any>
  /**
   * Reserves the idempotency slot BEFORE calling the PAC — prevents concurrent double-stamp.
   * Must INSERT a row with status:'STAMPING'. On unique-key conflict the caller handles P2002.
   */
  reserveCfdi: (data: Record<string, any>, tx?: Prisma.TransactionClient) => Promise<any>
  runInTransaction?: <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>
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
  persistArtifacts: (idempotencyKey: string, urls: ArchivosCfdi, version?: number) => Promise<any>
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
  /**
   * C2 · OF-2 (T10 N-2): con `alreadyIssued`, la factura que la devuelta SUSTITUYE y que sigue vigente (su cancelación no ha terminado).
   * Quien llama dice cuál falta cancelar en vez de mandar a corregirla.
   */
  originalVigente?: any
  /**
   * Ronda de la ola (review-OF m2): con `alreadyIssued`, la SUSTITUTA de la devuelta que tiene su cancelación en trámite (la venta sigue
   * facturada con la devuelta, la original). Quien llama lo dice en vez de «espera a que se cancele».
   */
  sustitutaEnCancelacion?: any
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
  overrides: Partial<IssueCfdiDeps> = {},
): Promise<IssueCfdiResult> {
  const deps = { ...defaultDeps, ...overrides }
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
    const vigentes = vistas.filter(f => f.status === 'STAMPED' || f.status === 'CANCEL_REQUESTED')
    // C2 · OF-2 (T10 N-2): una vigente cuya sustituta ya está TIMBRADA no es «la» factura de la venta: lo es la sustituta (la original
    // sólo espera su cancelación). Sin esto se contestaba con la original, la más vieja, y los textos mandaban a lo que no existe.
    const vigente = vigentes.find(f => !vigentes.some(s => s.replacesCfdiId === f.id && s.status === 'STAMPED')) ?? vigentes[0]
    if (vigente) {
      const originalVigente = vigentes.find(f => f.id === vigente.replacesCfdiId)
      if (vigente.cancelStatus === 'REQUESTED' || vigente.status === 'CANCEL_REQUESTED') {
        // Ronda de la ola (review-OF m2): la que se está cancelando es la SUSTITUTA y la original sigue vigente ⇒ la venta ESTÁ facturada
        // con la original (se cancele o no la sustituta). No es «espera a que se cancele»: es «ya facturada».
        if (originalVigente) return { status: 'STAMPED', cfdi: originalVigente, alreadyIssued: true, sustitutaEnCancelacion: vigente }
        // C2 · T10 ronda 1 (M3): un código estable (`CFDI_CANCEL_PENDING`) en vez de la regex `/en trámite/` de los controladores, y el texto
        // según en qué va la cancelación (como la nota y la sustitución).
        throw new ConflictError(textoDeCancelacionPendienteAlRefacturar(vigente, new Date()), 'CFDI_CANCEL_PENDING') // → 409
      }
      return { status: 'STAMPED', cfdi: vigente, alreadyIssued: true, ...(originalVigente ? { originalVigente } : {}) }
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

  // 1. Idempotency — consult the local reservation before selecting its protocol.
  const existing = await deps.findExistingCfdi(idempotencyKey)
  if (existing && existing.status === 'STAMPED') {
    // Tenant isolation ANTES del retorno idempotente: sin esto, venue B obtenía las URLs del CFDI de A
    // con sólo conocer el id de la orden.
    if (params.expectedVenueId && existing.venueId && existing.venueId !== params.expectedVenueId) {
      throw new Error(`Order ${params.orderId} not found`) // → 404, no cross-venue leak
    }
    // Esta llamada no timbró nada: la factura ya existía (Codex R3-2). Sin la marca, el que llama dice «facturada».
    return { status: 'STAMPED', cfdi: existing, alreadyIssued: true }
  }

  if (!existing || existing.protocoloIva === 1) return emitirConEntrada(params, idempotencyKey, deps)

  // 2. Load (legacy rows only)
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
  let legacyReservation = existing
  try {
    legacyReservation = await deps.reserveCfdi(baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'STAMPING', {}))
  } catch (err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Slot already taken — inspect the current status to decide the response.
      const existing = await deps.findExistingCfdi(idempotencyKey)
      if (existing?.status === 'STAMPED') {
        // Another request already succeeded — idempotent success, pero esta llamada no timbró nada.
        return { status: 'STAMPED', cfdi: existing, alreadyIssued: true }
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
        legacyReservation = { ...existing, idempotencyKey, status: 'STAMPING', attempts: (existing.attempts ?? 0) + 1 }
        // 🔴 RECONCILIAR ANTES DE RE-TIMBRAR: un intento anterior pudo haber timbrado y fallar DESPUÉS
        // (un timeout tras la respuesta del PAC deja `STAMP_FAILED` con el documento ya emitido). Se le
        // pregunta al PAC por nuestro `external_id` antes de emitir otro.
        const yaEmitido = await reconciliarIntentoPrevio(params, bundle, legacyReservation, deps)
        if (yaEmitido) return yaEmitido
      }
    } else {
      throw err
    }
  }

  const legacyWhere = { id: legacyReservation.id, attempts: legacyReservation.attempts, status: 'STAMPING' as const }

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
  const reasons = motivosParaMostrar(validation.reasons, bundle.unsupportedReasons ?? [])
  // 🔴 Barrera de dinero: la factura tiene que decir EXACTAMENTE lo que el cliente pagó (sin propina).
  // Testarudo (21-sep-2026) recibió 5 facturas por menos de lo cobrado; un CFDI que no cuadra con el
  // ticket es peor que ninguno — no se timbra, y la razón se le enseña a quien factura.
  // Se compara el DOCUMENTO que se manda (los conceptos como los calculará el PAC), no los agregados
  // de la orden: con precios NET el PAC suma el IVA encima, con precios IVA-incluido lo extrae.
  // B3a Tarea 6b: el documento que SE MANDA, sumado como el PAC; tras el ajuste del cargador, la suma por concepto ya no es lo cobrado a propósito.
  const documentoCents = totalSegunElPacCents(invoiceParams.items.map(conceptoDesdeElPayload))
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
      legacyWhere,
    )
    if (!cfdi) throw new ConflictError(PROCESANDO)
    return { status: 'VALIDATION_FAILED', cfdi, reasons }
  }

  // Legacy has no frozen input: preserve its prior recalculated amounts before sending this version.
  const legacyData = baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'STAMPING', {})
  const refreshed = await deps.persistCfdi(legacyData, legacyWhere)
  if (!refreshed) throw new ConflictError(PROCESANDO)
  legacyReservation = { ...legacyReservation, ...legacyData }

  // 5. Stamp via the connector
  const provider = deps.resolveProvider(bundle.emisor as any, { sandbox: params.sandbox })
  let stamped
  try {
    stamped = await provider.createInvoice(invoiceParams)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi] stamp failed for order ${params.orderId}: ${message}`)
    const cfdi = await deps.persistCfdi({ idempotencyKey, status: 'STAMP_FAILED', lastError: message }, legacyWhere)
    if (!cfdi) throw new ConflictError(PROCESANDO)
    return { status: 'STAMP_FAILED', cfdi }
  }

  if (stamped.status !== 'valid' || !stamped.uuid) {
    await deps.persistCfdi({ idempotencyKey, facturapiId: stamped.providerInvoiceId }, legacyWhere)
    throw new ConflictError('CFDI en proceso para esta orden')
  }

  return finalizarEmision(legacyReservation, stamped, provider, bundle.venueSlug, deps)
}

/** «Otra solicitud lo tiene en proceso». La global (`cfdiGlobal.service.ts`) la importa: el job lo distingue de un periodo detenido por el texto EXACTO. */
export const PROCESANDO = 'La factura de esta venta se está procesando; intenta de nuevo en unos minutos.'
/** D9 (B3a): no queda ningún concepto con importe que facturar. */
export const MOTIVO_TODO_CORTESIA =
  'Esta venta no tiene importe que facturar: todos sus artículos son cortesía o tienen descuento completo.'
/** Venta MIXTA sin contrato: el dueño la desbloquea confirmando que el precio ya incluía IVA (§4.6). */
export const MOTIVO_CONTRATO_DESCONOCIDO =
  'Esta venta tiene productos con IVA distinto de 16 % y no consta que se cobró con IVA incluido; confírmalo antes de facturar.'
/** Venta MIXTA que separó el impuesto al cobrar: no se confirma (§4.2), se dice por qué. */
export const MOTIVO_IVA_APARTE =
  'Esta venta cobró el IVA aparte y tiene productos con IVA distinto de 16 %; no se puede facturar desde Avoqado. Si necesitas factura, escríbenos a soporte.'
// B3a: los motivos de la regla del PAC viven con ella (`reglaDelPac.ts`, para probar la decisión pura); se publican también aquí.
export {
  motivoNoCuadra,
  MOTIVO_BUSQUEDA_LIMITADA,
  MOTIVO_CONCEPTO_INVALIDO_ANTE_EL_SAT,
  MOTIVO_OCHO_SIN_REGLA,
  MOTIVO_MEDIO_CENTAVO_SIN_REGLA,
} from './reglaDelPac'
type IssueParams = Parameters<typeof issueCfdiForOrder>[0]

/** Reservar y recapturar son las únicas rutas que leen la venta viva. El PAC sólo recibe la foto. */
export async function emitirConEntrada(
  params: IssueParams,
  idempotencyKey: string,
  overrides: Partial<IssueCfdiDeps> = {},
  sustitucion?: { id: string; uuid: string; fiscalEmisorId: string },
): Promise<IssueCfdiResult> {
  const deps = { ...defaultDeps, ...overrides }
  const transaction = deps.runInTransaction ?? defaultDeps.runInTransaction!
  async function admission(tx: Prisma.TransactionClient) {
    const order = await bloquearOrdenParaFacturar(tx, params.orderId)
    if (!order || (params.expectedVenueId && order.venueId !== params.expectedVenueId)) throw new Error(`Order ${params.orderId} not found`)
    await tomarAdmisionCompartida(tx, order.organizationId)
    const motivo = await excluirSiEstaEnGlobal(tx, params.orderId)
    if (motivo) throw new ConflictError(motivo)
    // findFirst answers existence without silently truncating the order's invoice history.
    const alive = await tx.cfdi.findFirst({
      where: {
        orderId: params.orderId,
        venueId: order.venueId,
        isGlobal: false,
        type: 'INGRESO',
        ...(sustitucion ? { id: { not: sustitucion.id } } : {}),
        AND: [{ OR: [{ idempotencyKey: null }, { idempotencyKey: { not: idempotencyKey } }] }, CFDI_VIVO],
      },
    })
    if (alive) throw new ConflictError('CFDI en proceso para esta orden')
  }
  async function capture(tx: Prisma.TransactionClient) {
    // La original sólo debe seguir vigente al reservar/recapturar; recuperar un envío no depende de ello.
    if (sustitucion) {
      const original = await tx.cfdi.findUnique({ where: { id: sustitucion.id } })
      // C2 · Tarea 3: ninguna sustitución EMPIEZA sobre una original con cancelación en trámite (reserva o recaptura).
      // T10 (M2 de la T3): el texto dice en qué va (se está enviando · en duda · en trámite).
      if (original?.cancelStatus === 'REQUESTED') throw new ConflictError(textoDeCancelacionPendienteAlSustituir(original, new Date()))
      if (
        !original ||
        original.orderId !== params.orderId ||
        original.venueId !== params.expectedVenueId ||
        original.status !== 'STAMPED' ||
        ['ACCEPTED', 'CANCELLED'].includes(original.cancelStatus ?? '') ||
        original.uuid !== sustitucion.uuid ||
        original.fiscalEmisorId !== sustitucion.fiscalEmisorId
      )
        throw new ConflictError('Solo se puede sustituir una factura timbrada y vigente.')
      // G4 (controlador, C2): tampoco sobre una original con notas de crédito vivas. Sin esto la sustituta se timbraría y LUEGO la
      // guarda C2-6 rechazaría cancelar la original: dos ingresos vivos por la misma venta. Misma búsqueda y mismo texto que la
      // cancelación. Esto cierra «nota primero, sustitución después»: la reserva de la nota toma el mismo candado de la orden. El orden
      // inverso (la sustituta ya se reservó, soltó el candado y está en el PAC) lo cierra el ESPEJO, en la elegibilidad de la nota
      // (`ORIGINAL_EN_SUSTITUCION`, `cfdiCreditNote.service.ts`), que ve la sustituta viva bajo el mismo candado.
      // Conservador a propósito (M7 de la T2): una nota HEREDADA viva (sin protocolo) de la misma orden bloquea aunque haya sido de una
      // factura ANTERIOR de esa orden, porque las heredadas apuntan a la orden, no a la factura.
      const relacionado = await documentoRelacionadoVivo(tx, original.id, original)
      if (relacionado) throw new ConflictError(textoDeDocumentoRelacionado(relacionado))
    }
    const bundle = await deps.loadOrderForCfdi(
      params.orderId,
      { permitirEfectivo: !!sustitucion || (params.flow ?? 'STAFF_B') === 'STAFF_B' },
      tx,
    )
    if (!bundle) throw new Error(`Order ${params.orderId} not found or has no fiscal emisor configured`)
    if (params.expectedVenueId && bundle.venueId !== params.expectedVenueId) throw new Error(`Order ${params.orderId} not found`)
    if (!bundle.facturacionEnabled) throw new Error('Facturación no habilitada para este comercio')
    if (!sustitucion && params.flow === 'AUTOFACTURA_A' && !bundle.autofacturaEnabled)
      throw new Error('Autofactura no habilitada para este comercio')
    if (sustitucion && bundle.emisor.id !== sustitucion.fiscalEmisorId) {
      throw new ConflictError(
        'El emisor fiscal de esta cuenta cambió desde que se emitió la factura; no se puede sustituir automáticamente.',
      )
    }
    const entrada = capturarEntrada(bundle, params.receptor, params.orderId, { replacesCfdiId: sustitucion?.id })
    if (sustitucion) entrada.params.relation = { tipoRelacion: '04', relatedUuids: [sustitucion.uuid] }
    const validation = validateBeforeStamp({
      csdStatus: bundle.emisor.csdStatus,
      formaPago: entrada.params.formaPago,
      receptor: params.receptor,
      items: entrada.params.items,
      expectedSubtotalCents: entrada.montos.subtotalCents,
      expectedTaxCents: entrada.montos.taxCents,
      expectedTotalCents: entrada.montos.totalCents,
      isGlobal: false,
    })
    const reasons = motivosParaMostrar(validation.reasons, bundle.unsupportedReasons ?? [])
    // B3a Tarea 6b: el documento que SE MANDA, sumado como el PAC; tras el ajuste del cargador, la suma por concepto ya no es lo cobrado a propósito.
    const documentoCents = totalSegunElPacCents(entrada.params.items.map(conceptoDesdeElPayload))
    if (!bundle.unsupportedReasons?.length && bundle.paidCents !== undefined && bundle.paidCents !== documentoCents) {
      const pesos = (c: number) => `$${(c / 100).toFixed(2)}`
      reasons.push(
        sustitucion
          ? `El total de la factura corregida (${pesos(documentoCents)}) no coincide con lo cobrado (${pesos(bundle.paidCents)}). No se sustituyó; revisa la cuenta o repórtala a soporte.`
          : `El total de la factura (${pesos(documentoCents)}) no coincide con lo cobrado (${pesos(bundle.paidCents)}). No se timbró; revisa la cuenta o repórtala a soporte.`,
      )
    }
    const data = baseCfdiData(
      params,
      bundle,
      idempotencyKey,
      entrada.params,
      reasons.length ? 'VALIDATION_FAILED' : 'STAMPING',
      {
        entrada,
        entradaHuella: huellaDeEntrada(entrada),
        ...(sustitucion ? { replacesCfdiId: sustitucion.id } : {}),
        protocoloIva: 1,
        enviadoAt: null,
        falloDefinitivo: false,
        lastError: reasons.length ? reasons.join(' | ') : null,
      },
      entrada,
    )
    return { bundle, entrada, reasons, data }
  }
  let reserved = await transaction(async tx => {
    await admission(tx)
    const existing = await tx.cfdi.findUnique({
      where: { idempotencyKey },
      include: { fiscalEmisor: true, venue: { select: { slug: true } } },
    })
    if (existing) return { cfdi: existing, fresh: false, emisor: existing.fiscalEmisor, slug: existing.venue.slug, reasons: [] as string[] }
    const captured = await capture(tx)
    const data = { ...captured.data, attempts: captured.reasons.length ? 0 : 1 }
    const cfdi = await deps.reserveCfdi(data, tx)
    if (!captured.reasons.length)
      await sellarRenglones(tx, { cfdiId: cfdi.id, intento: cfdi.attempts, renglones: captured.entrada.renglones })
    return { cfdi, fresh: true, emisor: captured.bundle.emisor, slug: captured.bundle.venueSlug, reasons: captured.reasons }
  })
  let cfdi = reserved.cfdi
  if (params.expectedVenueId && cfdi.venueId !== params.expectedVenueId) throw new Error(`Order ${params.orderId} not found`)
  // Otra petición timbró esta misma llave antes que ésta: no se timbró nada nuevo.
  if (cfdi.status === 'STAMPED') return { status: 'STAMPED', cfdi, alreadyIssued: true }
  if (!['STAMPING', 'STAMP_FAILED', 'VALIDATION_FAILED'].includes(cfdi.status)) throw new ConflictError(PROCESANDO)
  if (reserved.fresh && reserved.reasons.length) return { status: 'VALIDATION_FAILED', cfdi, reasons: reserved.reasons }
  // A concurrent legacy row is retried through its existing, explicitly legacy route.
  if (cfdi.protocoloIva !== 1) throw new ConflictError('CFDI en proceso para esta orden')
  let entrada = leerEntrada(cfdi.entrada)
  if (
    !entrada ||
    entrada.fiscalEmisorId !== cfdi.fiscalEmisorId ||
    entrada.orderId !== params.orderId ||
    (sustitucion &&
      (entrada.replacesCfdiId !== sustitucion.id ||
        cfdi.replacesCfdiId !== sustitucion.id ||
        entrada.params.relation?.tipoRelacion !== '04' ||
        !Array.isArray(entrada.params.relation.relatedUuids) ||
        entrada.params.relation.relatedUuids.length !== 1 ||
        entrada.params.relation.relatedUuids[0] !== sustitucion.uuid)) ||
    huellaDeEntrada(entrada) !== cfdi.entradaHuella
  ) {
    throw new ConflictError('La entrada fiscal de esta factura requiere revisión de soporte.')
  }
  const provider = deps.resolveProvider(reserved.emisor as any, { sandbox: params.sandbox })
  let recovered: StampedInvoice | ProviderInvoiceSummary | null = null
  if (!reserved.fresh) {
    recovered = await consultarIntentoCapturado(cfdi, provider, transaction)
    if (!recovered) {
      const previous = cfdi
      reserved = await transaction(async tx => {
        await admission(tx)
        const where = {
          id: previous.id,
          status: previous.status,
          attempts: previous.attempts,
          OR: [{ enviadoAt: null }, { falloDefinitivo: true }],
        }
        const claimed = await tx.cfdi.updateMany({ where, data: { status: 'STAMPING' } })
        if (claimed.count !== 1) throw new ConflictError(PROCESANDO)
        await liberarSellosDe(tx, previous.id)
        const captured = await capture(tx)
        const attempts = previous.attempts + (captured.reasons.length ? 0 : 1)
        const { count } = await tx.cfdi.updateMany({
          where: { id: previous.id, status: 'STAMPING', attempts: previous.attempts },
          data: {
            ...captured.data,
            entrada: captured.entrada as unknown as Prisma.InputJsonValue,
            attempts,
            facturapiId: null,
            uuid: null,
          },
        })
        if (count !== 1) throw new ConflictError(PROCESANDO)
        const updated = await tx.cfdi.findUniqueOrThrow({ where: { id: previous.id } })
        if (!captured.reasons.length)
          await sellarRenglones(tx, { cfdiId: previous.id, intento: attempts, renglones: captured.entrada.renglones })
        return { cfdi: updated, fresh: true, emisor: captured.bundle.emisor, slug: captured.bundle.venueSlug, reasons: captured.reasons }
      })
      cfdi = reserved.cfdi
      entrada = leerEntrada(cfdi.entrada)!
      if (reserved.reasons.length) return { status: 'VALIDATION_FAILED', cfdi, reasons: reserved.reasons }
    }
  }
  // Resolve from the captured emisor after recapture; no live order/product reads after commit.
  const sendingProvider = deps.resolveProvider(reserved.emisor as any, { sandbox: params.sandbox })
  return enviarIntentoCapturado(cfdi, { tipo: 'INDIVIDUAL', params: entrada.params }, recovered, sendingProvider, reserved.slug, deps)
}

/** Consulta sin reclamar ni recapturar. Un resultado negativo no prueba rechazo del PAC. */
export async function consultarIntentoCapturado(
  cfdi: any,
  provider: Pick<import('./providers/fiscal-provider.interface').FiscalProvider, 'getInvoice' | 'findByExternalId'>,
  transaction: NonNullable<IssueCfdiDeps['runInTransaction']>,
): Promise<StampedInvoice | ProviderInvoiceSummary | null> {
  const escalate = () => escalarIntentoIncierto(cfdi, new Date(), { runInTransaction: transaction })
  let recovered
  try {
    recovered = cfdi.facturapiId
      ? await provider.getInvoice(cfdi.facturapiId)
      : await provider.findByExternalId(`${cfdi.idempotencyKey}#${cfdi.attempts}`)
  } catch {
    await escalate()
    throw new ConflictError(PROCESANDO)
  }
  if (recovered?.status === 'canceled')
    throw new ConflictError('Esta cuenta ya tiene una factura cancelada en el PAC; revísala antes de volver a facturar.')
  if (
    (recovered && (recovered.status !== 'valid' || !recovered.uuid)) ||
    (!recovered && cfdi.enviadoAt !== null && !cfdi.falloDefinitivo)
  ) {
    await escalate()
    throw new ConflictError(PROCESANDO)
  }
  return recovered
}

/** Sólo transporte y desenlace de una reserva protocolo1; cada emisor conserva su propia captura. */
export async function enviarIntentoCapturado(
  cfdi: any,
  documento:
    | { tipo: 'INDIVIDUAL'; params: import('./providers/fiscal-provider.interface').CreateInvoiceParams }
    | { tipo: 'GLOBAL'; params: import('./providers/fiscal-provider.interface').GlobalInvoiceParams }
    | { tipo: 'EGRESO'; params: Omit<import('./providers/fiscal-provider.interface').CreditNoteParams, 'idempotencyKey'> },
  recovered: StampedInvoice | ProviderInvoiceSummary | null,
  sendingProvider: import('./providers/fiscal-provider.interface').FiscalProvider,
  venueSlug: string,
  deps: Pick<IssueCfdiDeps, 'runInTransaction' | 'findExistingCfdi' | 'persistCfdi' | 'persistArtifacts' | 'storeArtifact'>,
): Promise<IssueCfdiResult> {
  if (cfdi.protocoloIva !== 1) throw new ConflictError(PROCESANDO)
  const transaction = deps.runInTransaction ?? defaultDeps.runInTransaction!
  const idempotencyKey = cfdi.idempotencyKey
  const version = cfdi.attempts
  async function reportConflictingVersion(current: any, uuid: string | null) {
    if (current?.attempts === version && (!uuid || !current.uuid || current.uuid === uuid)) return
    const data = {
      attempts: version,
      currentAttempts: current?.attempts ?? null,
      uuid,
      currentUuid: current?.uuid ?? null,
      orderId: cfdi.orderId,
      idempotencyKey,
    }
    logger.error('🚨 CFDI_TIMBRE_DUPLICADO', { venueId: cfdi.venueId, ...data })
    await transaction(tx =>
      tx.activityLog.create({ data: { venueId: cfdi.venueId, action: 'CFDI_TIMBRE_DUPLICADO', entity: 'Cfdi', entityId: cfdi.id, data } }),
    )
  }
  let stamped = recovered
  if (!stamped) {
    if (documento.tipo === 'EGRESO' && !sendingProvider.createCreditNote)
      throw new ConflictError('El proveedor fiscal no soporta notas de crédito (CFDI de egreso).')
    const sent = await transaction(tx =>
      tx.cfdi.updateMany({
        where: { id: cfdi.id, status: 'STAMPING', attempts: version, enviadoAt: null },
        data: { enviadoAt: new Date() },
      }),
    )
    if (sent.count !== 1) throw new ConflictError(PROCESANDO)
    const identity = `${idempotencyKey}#${version}`
    try {
      stamped = await (documento.tipo === 'GLOBAL'
        ? sendingProvider.createGlobalInvoice({ ...structuredClone(documento.params), externalId: identity, idempotencyKey: identity })
        : documento.tipo === 'EGRESO'
          ? sendingProvider.createCreditNote!({
              ...structuredClone(documento.params),
              externalId: identity,
              idempotencyKey: identity,
              protocoloIva: 1,
            })
          : sendingProvider.createInvoice({ ...structuredClone(documento.params), externalId: identity, idempotencyKey: identity }))
    } catch (err) {
      const definitive = esRechazoConfirmado(err, true)
      const where: Prisma.CfdiWhereInput = {
        id: cfdi.id,
        attempts: version,
        ...(definitive ? { status: { in: ['STAMPING', 'STAMP_FAILED'] }, falloDefinitivo: false } : { status: 'STAMPING' }),
      }
      const data = {
        status: 'STAMP_FAILED' as const,
        attempts: version,
        falloDefinitivo: definitive,
        lastError: err instanceof Error ? err.message : String(err),
      }
      const updated = definitive
        ? await transaction(async tx => {
            // A rejected global is no longer live: release every member under the same
            // ordered admission locks as capture, only after winning this version's CAS.
            const ids = cfdi.orderId ? [cfdi.orderId as string] : []
            let after: string | undefined
            for (;;) {
              const page = await tx.cfdiGlobalOrden.findMany({
                where: { cfdiId: cfdi.id, ...(after ? { orderId: { gt: after } } : {}) },
                orderBy: { orderId: 'asc' },
                take: 100,
                select: { orderId: true },
              })
              ids.push(...page.map(member => member.orderId))
              if (page.length < 100) break
              after = page[page.length - 1].orderId
            }
            await bloquearOrdenesParaFacturar(tx, [...new Set(ids)].sort(), cfdi.venueId)
            const venue = await tx.venue.findUniqueOrThrow({ where: { id: cfdi.venueId }, select: { organizationId: true } })
            await tomarAdmisionCompartida(tx, venue.organizationId)
            const { count } = await tx.cfdi.updateMany({ where, data })
            if (count !== 1) return null
            await liberarSellosDe(tx, cfdi.id)
            return tx.cfdi.findUniqueOrThrow({ where: { id: cfdi.id } })
          })
        : await deps.persistCfdi({ idempotencyKey, ...data }, where)
      const current = updated ?? (await deps.findExistingCfdi(idempotencyKey))
      if (!updated) await reportConflictingVersion(current, null)
      // Misma versión: es el timbre de ESTE envío, completado por la conciliación. Otra versión: lo timbró otro envío.
      if (current?.status === 'STAMPED')
        return { status: 'STAMPED', cfdi: current, ...(current.attempts !== version ? { alreadyIssued: true } : {}) }
      if (!current || current.attempts !== version || current.status !== 'STAMP_FAILED') throw new ConflictError(PROCESANDO)
      return { status: 'STAMP_FAILED', cfdi: current }
    }
  }
  if (stamped.status !== 'valid' || !stamped.uuid) {
    const pending = await deps.persistCfdi(
      { idempotencyKey, facturapiId: stamped.providerInvoiceId },
      { id: cfdi.id, attempts: version, status: 'STAMPING' },
    )
    if (!pending) await reportConflictingVersion(await deps.findExistingCfdi(idempotencyKey), stamped.uuid)
    throw new ConflictError(PROCESANDO)
  }
  return finalizarEmision(cfdi, stamped, sendingProvider, venueSlug, deps)
}

/**
 * Antes de re-timbrar un intento reclamado, le pregunta al PAC si NUESTRO `external_id` ya tiene
 * documento. Tres desenlaces: existe y es válido ⇒ se completa la fila sin volver a timbrar; existe y
 * está cancelado ⇒ no se toca (queda para revisión humana); no existe ⇒ se sigue al timbrado normal.
 */
async function reconciliarIntentoPrevio(
  params: { orderId: string; receptor: IssueReceptor; sandbox: boolean; flow?: 'STAFF_B' | 'AUTOFACTURA_A'; expectedVenueId?: string },
  bundle: LoadedOrderBundle,
  reservation: any,
  deps: IssueCfdiDeps,
): Promise<IssueCfdiResult | null> {
  const idempotencyKey = reservation.idempotencyKey
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
  if (previo.status !== 'canceled' && (previo.status !== 'valid' || !previo.uuid)) throw new ConflictError(PROCESANDO)
  if (previo.status === 'canceled') {
    throw new Error(
      `Esta cuenta ya tiene una factura cancelada en el PAC (${previo.uuid ?? previo.providerInvoiceId}); revísala antes de volver a facturar`,
    )
  }
  logger.warn(`[cfdi] el PAC ya tenía ${previo.uuid} para ${idempotencyKey}: se completa sin volver a timbrar`)
  return finalizarEmision(reservation, previo, provider, bundle.venueSlug, deps)
}

/** Todas las respuestas válidas pasan por la misma finalización, incluidas las recuperadas. */
export async function finalizarEmision(
  reservation: any,
  invoice: StampedInvoice | ProviderInvoiceSummary,
  provider: Pick<import('./providers/fiscal-provider.interface').FiscalProvider, 'downloadXml' | 'downloadPdf' | 'sendInvoiceByEmail'>,
  venueSlug: string,
  deps: Pick<IssueCfdiDeps, 'runInTransaction' | 'findExistingCfdi' | 'storeArtifact' | 'persistArtifacts'>,
): Promise<IssueCfdiResult> {
  const identity = {
    status: invoice.status,
    facturapiId: invoice.providerInvoiceId,
    uuid: invoice.uuid,
    serie: invoice.serie,
    folio: invoice.folio,
    stampedAt: invoice.stampedAt ?? new Date(),
  }
  const result = await finalizarTimbre(
    { cfdiId: reservation.id, idempotencyKey: reservation.idempotencyKey, version: reservation.attempts, identidad: identity },
    { runInTransaction: deps.runInTransaction ?? (work => prisma.$transaction(work)) },
  )
  if (result === 'DUPLICADO') throw new ConflictError(PROCESANDO)
  // 🔴 H24: sólo quien FINALIZA el timbre manda el correo — una vez por factura, venga del dashboard, la autofactura, una
  // sustitución, una nota de crédito o una recuperación. Una repetición (YA_FINALIZADO) no lo manda otra vez.
  if (result === 'FINALIZADO') void sendNewCfdiByEmail({ cfdiId: reservation.id, venueId: reservation.venueId, provider })
  let cfdi =
    result === 'YA_FINALIZADO'
      ? await deps.findExistingCfdi(reservation.idempotencyKey)
      : { ...reservation, ...identity, status: 'STAMPED', lastError: null }
  if (!cfdi || cfdi.status !== 'STAMPED') throw new ConflictError(PROCESANDO)
  await completarArchivos(
    {
      cfdiId: reservation.id,
      idempotencyKey: reservation.idempotencyKey,
      version: reservation.attempts,
      providerInvoiceId: invoice.providerInvoiceId,
      uuid: invoice.uuid!,
      venueSlug,
      provider,
    },
    {
      storeArtifact: deps.storeArtifact,
      persistArtifacts: async (_p, archivos) => {
        const saved = await deps.persistArtifacts(reservation.idempotencyKey, archivos, reservation.attempts)
        if (!saved) return false
        cfdi = { ...cfdi, ...saved }
        return saved.status === 'STAMPED'
      },
    },
  )
  if (cfdi.status !== 'STAMPED') throw new ConflictError(PROCESANDO)
  return { status: 'STAMPED', cfdi }
}

function baseCfdiData(
  params: { orderId: string; receptor: IssueReceptor; flow?: CfdiFlow },
  bundle: LoadedOrderBundle,
  idempotencyKey: string,
  invoiceParams: ReturnType<typeof buildCreateInvoiceParams>,
  status: CfdiStatus,
  extra: Record<string, any>,
  entrada?: EntradaDocumentalV1,
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
    subtotalCents: entrada?.montos.subtotalCents ?? bundle.subtotalCents,
    taxCents: entrada?.montos.taxCents ?? bundle.taxCents,
    totalCents: entrada?.montos.totalCents ?? bundle.totalCents,
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
  runInTransaction: work => prisma.$transaction(work, { timeout: 15_000, maxWait: 5_000 }),
  reserveCfdi: (data, tx = prisma) => tx.cfdi.create({ data: data as any }),
  persistCfdi: async (data, where) => {
    if (where) {
      const { idempotencyKey: _key, ...changes } = data
      const { count } = await prisma.cfdi.updateMany({ where, data: changes })
      return count === 1 ? prisma.cfdi.findUnique({ where: { idempotencyKey: data.idempotencyKey } }) : null
    }
    return prisma.cfdi.upsert({
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
    })
  },
  loadOrderForCfdi: loadOrderForCfdiFromDb,
  claimCfdi: async (cfdiId, desdeEstados, version) => {
    const { count } = await prisma.cfdi.updateMany({
      where: claimWhere(cfdiId, desdeEstados, version) as any,
      data: { status: 'STAMPING', attempts: { increment: 1 }, updatedAt: new Date() },
    })
    return count === 1
  },
  persistArtifacts: async (idempotencyKey, urls, version) => {
    // Sólo las URLs, y sólo sobre una fila que siga timbrada. Un `update` normal reescribiría el
    // estado que otra petición acaba de cambiar.
    const { count } = await prisma.cfdi.updateMany({
      where: { idempotencyKey, status: 'STAMPED', ...(version !== undefined ? { attempts: version } : {}) },
      data: urls,
    })
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

/**
 * Motivos que se le enseñan a quien factura. Si el sobre seguro ya explicó por qué se quitaron los
 * renglones, «sin conceptos» es sólo su consecuencia (y en jerga): se omite para que la primera línea
 * sea una causa que se puede corregir.
 */
export function motivosParaMostrar(validacion: string[], delSobre: string[]): string[] {
  const base = delSobre.length > 0 ? validacion.filter(m => m !== SIN_CONCEPTOS) : validacion
  return [...base, ...delSobre]
}

export type RenglonParaCfdi = {
  /** `OrderItem.id`: la llave con que B2 guarda cada reparto. */
  id?: string
  productName: string | null
  quantity: number
  unitPrice: any
  discountAmount: any
  total?: any
  weightQuantity?: any
  modifiers?: Array<{ name: string | null; price: any; quantity: number }> | null
  product: any
  /**
   * IVA del renglón (plan 3): sellado > producto > IVA_16 sin producto. Lo pone `loadOrderForCfdiFromDb`;
   * los conceptos de extras heredan el del padre. Ausente = entrada legacy (se decide por la tupla vieja
   * `taxRate` + `objetoImp` del producto, exactamente como antes del plan 3).
   */
  tratamiento?: IvaTratamiento
  /** La promoción de la que nació (su total ya es neto; su descuento no está en la cabecera). */
  orderPromotionId?: string | null
  /** Cortesía (terminal o móvil): decide qué parte de su descuento vive en la cabecera. */
  isCortesia?: boolean | null
  /** C1/C2: el OrderItem del que nace el concepto (también sus extras). No viaja al PAC. */
  origen?: string
}

const centavos = (d: any) => Math.round(Number(d ?? 0) * 100)

/**
 * Tasa con la que el PAC calculará el concepto. Con tratamiento, la de su traslado (IVA_0/EXENTO/NO_OBJETO = 0);
 * sin él (legacy), la del producto, y 16 % sin producto — la regla de siempre. Un bloqueado no llega al PAC
 * (lo detiene su motivo); aquí sólo conserva la tasa guardada.
 */
function tasaDelConcepto(it: { tratamiento?: IvaTratamiento; product: { taxRate: any } | null }): number {
  if (it.tratamiento) {
    const sat = impuestosSatDe(it.tratamiento)
    if (!('bloqueado' in sat)) return sat.rate
  }
  return it.product ? Number(it.product.taxRate) : 0.16
}

/**
 * Total que el PAC va a calcular para estos conceptos: `Σ (unitario × cantidad − descuento)`, y si los
 * precios son NET se les suma su tasa (exento/0 % = igual). Es contra ESTO —no contra `order.total`—
 * que se compara lo cobrado antes de timbrar.
 */
export function totalDelDocumentoCents(order: {
  items: Array<{ unitPrice: any; quantity: number; discountAmount: any; product: { taxRate: any } | null; tratamiento?: IvaTratamiento }>
  pricesIncludeIva?: boolean
}): number {
  return order.items.reduce((sum, it) => {
    const neto = importeConceptoCents(it) - centavos(it.discountAmount)
    if (order.pricesIncludeIva) return sum + neto
    return sum + Math.round(neto * (1 + tasaDelConcepto(it)))
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
  /** B3a: lo que B3a desbloquea; el cargador lo calcula con la regla del PAC (`totalSegunElPacCents`). */
  requiereReglaDelPac?: boolean
}

/** Reparte `cents` entre `pesos` en proporción, residuo de redondeo al último; Σ partes == cents.
 * B3a: se conserva DENTRO del renglón (producto y extras) por decisión del founder (1-oct): el proporcional movía centavos y, sin IVA incluido, el total. */
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
/**
 * Un renglón que va a la factura (bloque B3a): sus conceptos —producto y extras con precio— SIN descuento todavía, y lo que el
 * renglón trae de suyo. El descuento se le pone después (`aplicarDescuentoAlRenglon`), cuando también se sabe lo que le toca de
 * los descuentos de la cuenta.
 */
export interface RenglonExaminado {
  /** `OrderItem.id` (lo que guardan los repartos de B2); sin id, su posición. */
  llave: string
  /** C1: el `OrderItem.id` del renglón, que heredan TODOS sus conceptos como `origen`; sin id, ausente (nunca la posición). */
  orderItemId?: string
  nombre: string
  /** El IVA con que se agrupa para D8: el tratamiento, o la tupla vieja si es una entrada legacy. */
  grupoIva: string
  /** Lo que valen sus conceptos antes de cualquier descuento. */
  brutoCents: number
  /** Su descuento propio (`OrderItem.discountAmount`): de artículo, cortesía o promoción. */
  propioCents: number
  conceptos: RenglonParaCfdi[]
  /** D9: el precio por kilo se derivó de lo cobrado (venta por peso con fracción de centavo); entra a `requiereReglaDelPac`. */
  precioDerivado?: boolean
}

/** La llave del renglón: su id; sin id (entradas armadas a mano), su posición con ceros para que ordene igual que el arreglo. */
export const llaveDeRenglon = (it: { id?: string | null }, indice: number): string => it.id ?? `#${String(indice).padStart(6, '0')}`

const grupoIvaDe = (it: RenglonParaCfdi): string => it.tratamiento ?? `tasa:${Number(it.product?.taxRate ?? 0.16)}`

export function examinarRenglon(it: RenglonParaCfdi, indice: number): RenglonExaminado | { omitido: true } | { motivos: string[] } {
  const extras = it.modifiers ?? []
  // El nombre guardado en la venta manda; si el camino de venta no lo guardó, el del catálogo (como en
  // el ticket y el inventario). «Producto» sólo si no hay ninguno de los dos.
  const nombreProducto = it.productName?.trim() || it.product?.name?.trim() || 'Producto'
  const nombresSinPrecio = extras
    .filter(m => centavos(m.price) === 0)
    .map(m => m.name?.trim())
    .filter((n): n is string => !!n)
  const productName = nombresSinPrecio.length > 0 ? `${nombreProducto} (${nombresSinPrecio.join(', ')})` : nombreProducto
  const porPeso = it.weightQuantity != null
  const unidades = porPeso ? Number(it.weightQuantity) : it.quantity
  if (!(unidades > 0)) return { motivos: [`«${nombreProducto}»: cantidad inválida (${unidades}).`] }
  // Con tratamiento (plan 3) el IVA del renglón ya está decidido sin ambigüedad; un tratamiento no
  // timbrable (objeto 03/04) se detiene con el motivo de `impuestosSatDe`, nombrando el producto (como
  // hacía el mensaje legacy de abajo) para que quien factura sepa CUÁL corregir.
  if (it.tratamiento) {
    const sat = impuestosSatDe(it.tratamiento)
    if ('bloqueado' in sat) return { motivos: [`«${nombreProducto}»: ${sat.motivo}`] }
  }
  // D9 (spec planes 6-7): un renglón que no cobra nada —cortesía de «Cobrar» o de la terminal (descuento = total, también sobre
  // una promoción), cortesía del móvil o importe libre regalado (total 0), promoción regalada— no va a la factura: la base de un
  // traslado debe ser mayor que cero. Va DESPUÉS del producto por revisar, que detiene aunque esté regalado. Sin `total`
  // (entradas armadas a mano) no se omite.
  if (it.total != null && netoRenglonCents(it) === 0) return { omitido: true }
  const totalCents = centavos(it.total)
  const descuentoCents = centavos(it.discountAmount)
  // Promoción (spec §4.2): su línea guarda el total YA neto y su descuento aparte (`promotion.service.ts`), a precio de lista.
  // Su bruto es la suma; los demás renglones guardan el bruto en `total`. (Una promoción regalada ya se omitió arriba.)
  const brutoRenglonCents = it.orderPromotionId ? totalCents + descuentoCents : totalCents
  const conPrecio = extras.filter(m => centavos(m.price) > 0)
  // Los extras deben explicar EXACTAMENTE la diferencia: precio por unidad × cantidad del padre (así lo
  // guardan TPV y mobile). Si no cuadra —p. ej. un cambio de precio a media cuenta que dejó `unitPrice`
  // viejo— no se inventa un extra con la diferencia.
  const extrasEsperadosCents = conPrecio.reduce((sum, m) => sum + centavos(m.price) * (m.quantity ?? 1), 0) * (porPeso ? 1 : it.quantity)
  let precioUnitario = new Prisma.Decimal(String(it.unitPrice))
  let precioDerivado = false
  let baseCents = importeConceptoCents({ unitPrice: precioUnitario, quantity: unidades })
  if (porPeso) {
    const exacto = precioUnitario.mul(new Prisma.Decimal(String(unidades)))
    if (!exacto.equals(exacto.toDecimalPlaces(2))) {
      // D9: el POS cobró precio × kilos redondeado a centavos, con la MISMA cuenta que el escritor
      // (`Math.round(precio × kilos × 100)`, order.tpv.service.ts:1738 y order.mobile.service.ts:666), que con flotante puede bajar
      // donde el redondeo decimal sube. Sólo esos dos resultados se aceptan (Codex r1 #5): con ellos el concepto lleva los kilos
      // reales y el precio por kilo que explica EXACTO lo cobrado, con hasta 6 decimales (experimento de la Tarea 1). Con
      // cualquier otro, los motivos de abajo («menor que…» / «no cuadra…») lo dicen.
      const cobradoCents = brutoRenglonCents - extrasEsperadosCents
      const delEscritor = Math.round(Number(it.unitPrice) * Number(it.weightQuantity) * 100)
      if (cobradoCents === baseCents || cobradoCents === delEscritor) {
        const derivado = new Prisma.Decimal(cobradoCents)
          .div(100)
          .div(new Prisma.Decimal(String(unidades)))
          .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP)
        if (importeConceptoCents({ unitPrice: derivado, quantity: unidades }) !== cobradoCents) {
          return {
            motivos: [`«${nombreProducto}»: precio × kilos no cae en centavos exactos; no se puede garantizar el importe ante el PAC.`],
          }
        }
        precioUnitario = derivado
        baseCents = cobradoCents
        precioDerivado = true
      }
    }
  }
  const extrasCents = brutoRenglonCents - baseCents

  if (extrasCents < 0) {
    return {
      motivos: [
        `«${nombreProducto}»: el importe cobrado (${pesosTxt(brutoRenglonCents)}) es menor que precio × cantidad (${pesosTxt(baseCents)}); no se puede reconstruir el concepto (promoción o recálculo).`,
      ],
    }
  }
  // Tasa 0 con «sí objeto de impuesto» es ambigua (¿tasa cero o exento?) y el constructor la convierte en
  // exento: hasta distinguirlas, fuera del sobre.
  const tasa = Number(it.product?.taxRate ?? 0.16)
  const objeto = it.product?.objetoImp ?? '02'
  if (objeto !== '01' && objeto !== '02') {
    return { motivos: [`«${nombreProducto}»: objeto de impuesto ${objeto} no soportado.`] }
  }
  if (objeto === '01' && tasa !== 0) {
    return { motivos: [`«${nombreProducto}»: producto «no objeto de impuesto» (01) con tasa ${tasa}; catálogo inconsistente.`] }
  }
  // Sólo en la entrada LEGACY (sin tratamiento): con tratamiento, IVA_0 y EXENTO son distintos y válidos.
  if (!it.tratamiento && tasa === 0 && objeto === '02') {
    return {
      motivos: [`«${nombreProducto}»: producto con tasa 0 y objeto de impuesto 02 (tasa cero vs exento sin distinguir).`],
    }
  }
  if (porPeso && it.product?.satUnitKey !== 'KGM') {
    return { motivos: [`«${nombreProducto}»: venta por peso sin clave SAT de unidad de peso (KGM) en el producto.`] }
  }
  if (extrasCents !== extrasEsperadosCents) {
    return {
      motivos: [
        `«${nombreProducto}»: el importe del renglón (${pesosTxt(brutoRenglonCents)}) no cuadra con precio × cantidad + extras (${pesosTxt(baseCents + extrasEsperadosCents)}).`,
      ],
    }
  }
  if (descuentoCents > brutoRenglonCents) {
    return {
      motivos: [
        `«${nombreProducto}»: el descuento (${pesosTxt(descuentoCents)}) es mayor que el importe del renglón (${pesosTxt(brutoRenglonCents)}).`,
      ],
    }
  }

  const producto: RenglonParaCfdi = {
    ...it,
    productName,
    quantity: unidades,
    unitPrice: precioUnitario,
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
    ...(it.tratamiento ? { tratamiento: it.tratamiento } : {}), // y el mismo IVA que su renglón
  }))
  return {
    llave: llaveDeRenglon(it, indice),
    ...(it.id ? { orderItemId: it.id } : {}),
    nombre: nombreProducto,
    grupoIva: grupoIvaDe(it),
    brutoCents: brutoRenglonCents,
    propioCents: descuentoCents,
    conceptos: [producto, ...conceptosExtras],
    precioDerivado,
  }
}

/**
 * Pone el descuento TOTAL del renglón (el suyo + lo que le toca de la cuenta) entre sus conceptos en proporción a su importe,
 * con el repartidor de hoy (`repartir`, con topes: decisión del founder del 1-oct, excepción a D19 dentro del renglón).
 */
export function aplicarDescuentoAlRenglon(r: RenglonExaminado, descuentoCents: number): ConceptosDeRenglon {
  if (descuentoCents > r.brutoCents) {
    return {
      items: [],
      motivos: [
        `«${r.nombre}»: el descuento (${pesosTxt(descuentoCents)}) es mayor que el importe del renglón (${pesosTxt(r.brutoCents)}).`,
      ],
    }
  }
  const partes = repartir(
    descuentoCents,
    r.conceptos.map(c => importeConceptoCents(c)),
  )
  // C1/C2: cada concepto —el producto y cada extra— sabe de qué OrderItem nace (`origen`); no viaja al PAC (`assembleSaleInput` arma el
  // item campo por campo). Un renglón sin id no lo pone: la posición no identifica nada fuera de esta cuenta.
  const origen = r.orderItemId ? { origen: r.orderItemId } : {}
  return { items: r.conceptos.map((c, i) => ({ ...c, discountAmount: new Prisma.Decimal(partes[i] / 100), ...origen })), motivos: [] }
}

/** Un renglón suelto con sólo su descuento propio. Sólo lo usan las pruebas del nombre del concepto: un omitido (D9) devuelve vacío, sin motivo ni marca de la regla del PAC. */
export function conceptosDesdeRenglon(it: RenglonParaCfdi, _orderId: string): ConceptosDeRenglon {
  const r = examinarRenglon(it, 0)
  if ('omitido' in r) return { items: [], motivos: [] }
  return 'motivos' in r ? { items: [], motivos: r.motivos } : aplicarDescuentoAlRenglon(r, r.propioCents)
}

/** El traslado de IVA con que el PAC calculará el concepto: el mismo que arma `resolveItem` (`cfdiPayloadBuilder.ts`). */
export function trasladoParaElPac(it: RenglonParaCfdi): TrasladoParaElPac {
  if (it.tratamiento) {
    const sat = impuestosSatDe(it.tratamiento)
    if ('bloqueado' in sat) return null
    const tax = sat.taxes[0]
    if (!tax) return null
    return tax.factor === 'Exento' ? { factor: 'Exento' } : { factor: 'Tasa', tasa: tax.rate }
  }
  // Entrada legacy: tasa 0 va sin traslado (`resolveItem`: taxExempt ⇒ taxes []); sin producto, 16 %.
  const tasa = it.product ? Number(it.product.taxRate) : 0.16
  return tasa > 0 ? { factor: 'Tasa', tasa } : null
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
  /** Filas `OrderDiscount` con su reparto (B2). Ausente = ninguna. */
  orderDiscounts?: FilaDeDescuento[] | null
}

/**
 * Orden con renglones → conceptos de la factura dentro del SOBRE SEGURO, o los motivos por los que se
 * bloquea. Compartido por la factura individual y la global para que las dos digan lo mismo.
 */
/** Exclusiones a nivel ORDEN (aplican con y sin renglones). */
export function motivosDeOrden(order: OrdenParaConceptos): string[] {
  const motivos: string[] = []
  if (centavos(order.serviceChargeAmount) > 0) {
    motivos.push('La cuenta lleva cargo por servicio; la facturación de cargos por servicio llega en la siguiente versión.')
  }
  return motivos
}

/**
 * Bloque B3a (spec §4.2): cada renglón suma su descuento propio + lo que consta para él en cada reparto (no las espejo); lo
 * que no consta va por D8. Dentro del renglón, entre producto y extras, con el repartidor de hoy (founder, 1-oct). Nunca se
 * decide con la cabecera A QUIÉN le toca un descuento.
 */
export function reconstruirConceptos(order: OrdenParaConceptos, _orderId: string): ConceptosDeRenglon {
  const motivos: string[] = motivosDeOrden(order)
  const examinados = order.items.map((it, i) => examinarRenglon(it, i))
  const vivos = examinados.filter((r): r is RenglonExaminado => !('motivos' in r) && !('omitido' in r))
  for (const r of examinados) if ('motivos' in r) motivos.push(...r.motivos)
  // Con un motivo ya no se timbra: los conceptos que se enseñan llevan sólo su descuento propio (como hasta hoy).
  const soloPropios = () => vivos.flatMap(v => aplicarDescuentoAlRenglon(v, v.propioCents).items)
  if (motivos.length > 0) return { items: soloPropios(), motivos }
  if (vivos.length === 0 && order.items.length > 0) return { items: [], motivos: [MOTIVO_TODO_CORTESIA] }
  const cuenta = descuentoDeCuentaPorRenglon({
    cabeceraCents: centavos(order.discountAmount),
    // Con un motivo ya se regresó arriba: cada renglón examinado es vivo u omitido (D9: `vivo: null`, sus filas espejo no cuentan y un
    // reparto que le dé parte es MOTIVO_REPARTO_FUERA_DE_LA_CUENTA). La llave es la del renglón examinado (Tarea 2), no el `id` que el
    // concepto del producto hereda por spread.
    renglones: examinados.map((r, i) => {
      const propioEnCabeceraCents = descuentoPropioEnCabeceraCents(order.items[i])
      if ('omitido' in r) return { llave: llaveDeRenglon(order.items[i], i), propioEnCabeceraCents, vivo: null }
      const v = r as RenglonExaminado
      return { llave: v.llave, propioEnCabeceraCents, vivo: { grupoIva: v.grupoIva, disponibleCents: v.brutoCents - v.propioCents } }
    }),
    filas: order.orderDiscounts ?? [],
  })
  if (cuenta.motivos.length > 0) return { items: soloPropios(), motivos: cuenta.motivos }
  const items: RenglonParaCfdi[] = []
  for (const v of vivos) {
    const r = aplicarDescuentoAlRenglon(v, v.propioCents + (cuenta.porLlave[v.llave] ?? 0))
    motivos.push(...r.motivos)
    items.push(...r.items)
  }
  if (motivos.length > 0) return { items, motivos }
  // D9 también después de los descuentos de la cuenta (Codex r1 #3): un concepto que un premio o un descuento dejó sin cobrar
  // nada no se manda al PAC (descuento = importe ⇒ base 0). Si no queda ninguno, no hay importe que facturar.
  const cobrables = items.filter(c => importeConceptoCents(c) - centavos(c.discountAmount) > 0)
  if (cobrables.length === 0) return { items: [], motivos: [MOTIVO_TODO_CORTESIA] }
  // B3a (Codex r3 R3-1 y r4 R4-1): también es nuevo todo lo que se quita —un renglón omitido arriba o un concepto que quita este
  // filtro— y quitar un concepto mueve el subtotal y el descuento que el PAC redondea: se calcula como el PAC. Ojo: el filtro
  // quita conceptos aunque no haya descuento de cuenta, porque `repartir` le da el centavo sobrante al primer concepto con saldo
  // (CAPUCCINO $65 + extra $5.04 con $70.03 propios ⇒ 6500 / 503: el producto queda en base 0).
  // Y una promoción (Tarea 5): el primer concepto de cada renglón es el producto, que conserva los campos del renglón.
  const requiereReglaDelPac =
    (items.length > 1 && Object.values(cuenta.porLlave).some(c => c > 0)) ||
    examinados.some(r => 'omitido' in r) ||
    cobrables.length < items.length ||
    vivos.some(v => !!v.conceptos[0]?.orderPromotionId) ||
    // Tarea 6 (Codex r3 R3-1): un precio por kilo derivado de lo cobrado, aunque quede con 2 decimales ($2.16).
    vivos.some(v => v.precioDerivado)
  return { items: cobrables, motivos: validarConceptos(cobrables), requiereReglaDelPac }
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

export async function loadOrderForCfdiFromDb(
  orderId: string,
  opts: LoadOrderForCfdiOpts = {},
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<LoadedOrderBundle | null> {
  // Tenant-safe load: order + items + product(+category) + venue.
  // Emisor is now resolved via the most-recent payment's merchant → MerchantFiscalConfig → fiscalEmisor.
  // Schema-verified field names:
  //   Order → venue (slug, type), payments (method, merchantAccountId, ecommerceMerchantId),
  //           items, subtotal, taxAmount, total, tipAmount
  //   OrderItem → productName, quantity, unitPrice, discountAmount, product → { satProductKey, satUnitKey, objetoImp, taxRate, category }
  //   MenuCategory → defaultSatProductKey, defaultSatUnitKey
  //   Payment → method  (NOT paymentMethod — schema field is "method")
  //   MerchantFiscalConfig → facturacionEnabled, autofacturaEnabled, fiscalEmisor (unique on merchantAccountId XOR ecommerceMerchantId)
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      venueId: true,
      subtotal: true,
      taxAmount: true,
      total: true,
      tipAmount: true,
      discountAmount: true,
      serviceChargeAmount: true,
      // Candados de la rama mixta (plan 3): cómo se cobró el precio y si la venta está liquidada.
      contratoDePrecio: true,
      paymentStatus: true,
      // B3a: las filas de descuento con su reparto (una página y una de más; ver filasDeDescuentoCompletas).
      orderDiscounts: DESCUENTOS_PARA_CONCEPTOS,
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
          id: true,
          // NULL = sigue el tratamiento vivo del producto; con valor = sellado por un documento (manda).
          ivaTratamiento: true,
          productName: true,
          quantity: true,
          unitPrice: true,
          discountAmount: true,
          total: true,
          weightQuantity: true,
          orderPromotionId: true,
          isCortesia: true,
          modifiers: { select: { name: true, price: true, quantity: true } },
          product: {
            select: {
              name: true,
              satProductKey: true,
              satUnitKey: true,
              objetoImp: true,
              taxRate: true,
              ivaTratamiento: true,
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
    cfg = await db.merchantFiscalConfig.findUnique({
      where: pay.merchantAccountId ? { merchantAccountId: pay.merchantAccountId } : { ecommerceMerchantId: pay.ecommerceMerchantId! },
      select: { facturacionEnabled: true, autofacturaEnabled: true, fiscalEmisor: { select: EMISOR_SELECT } },
    })
  } else {
    // 🔴 Venta SIN terminal (efectivo, transferencia, tarjeta de otra terminal). Testarudo, 24-sep-2026:
    // 698 ventas en efectivo y una transferencia de $3,082 en 30 días no se podían facturar porque el
    // emisor sólo se sacaba del comercio de la terminal. El emisor es el del NEGOCIO, y sólo cuando es
    // inequívoco: con UN solo RFC. Con dos o más no se adivina (queda como antes).
    if (pays.some(pp => !METODOS_SIN_COMERCIO.has(pp.method))) return null
    const emisores = await db.fiscalEmisor.findMany({
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
    const cfgOtro = await db.merchantFiscalConfig.findUnique({
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
  const orderDiscounts = await filasDeDescuentoCompletas(db, orderId, order.orderDiscounts)
  const sinRenglones = order.items.length === 0
  const renglones = order.items.map(renglonConTratamiento)
  const {
    items: itemsReconstruidos,
    motivos: unsupportedReasons,
    requiereReglaDelPac = false,
  }: ConceptosDeRenglon = sinRenglones
    ? {
        items: [
          {
            productName: 'Venta',
            quantity: 1,
            unitPrice: new Prisma.Decimal(paidCents / 100),
            discountAmount: 0,
            product: { satProductKey: '01010101', satUnitKey: 'ACT', objetoImp: '02', taxRate: 0.16, category: null },
            tratamiento: 'IVA_16',
          } as unknown as RenglonParaCfdi,
        ],
        // Las exclusiones de ORDEN (cargo por servicio) aplican también sin renglones.
        motivos: motivosDeOrden(order as OrdenParaConceptos),
      }
    : reconstruirConceptos({ ...order, orderDiscounts, items: renglones } as OrdenParaConceptos, orderId)
  unsupportedReasons.push(...Array.from(new Set(motivosComercios)))
  const items = itemsReconstruidos as unknown as typeof order.items

  // 🔴 Rama todo-16 vs rama mixta (plan 3). Un renglón legacy (sin tratamiento) sigue el camino de hoy,
  // igual que uno en IVA_16. La mixta sólo se factura con TRES candados: precio cobrado con IVA incluido
  // (el contrato, no la heurística), la venta liquidada, y la barrera «documento = cobrado» de abajo.
  const tratamientos: IvaTratamiento[] = renglones.map(r => r.tratamiento ?? 'IVA_16')
  const clasificacion = clasificarOrden(tratamientos)
  if (clasificacion === 'MIXTA') {
    // Un renglón bloqueado (03/04) ya puso SU motivo, con nombre, al reconstruir conceptos arriba
    // (`conceptosDesdeRenglon`). Con un bloqueado a la vista, ESO es lo único que se enseña: el
    // contrato/liquidación no aportan nada nuevo (nunca se timbraría de todos modos) y sólo
    // distraerían de la causa real, que es corregir el producto.
    if (!hayBloqueados(tratamientos)) {
      // B3b: «IVA aparte» NO se confirma (§4.2), así que su motivo no puede pedir confirmarlo; sólo la venta
      // sin contrato (DESCONOCIDO) lleva el de «confírmalo», que el controlador enriquece con la vista previa.
      if (order.contratoDePrecio === 'IVA_APARTE') unsupportedReasons.push(MOTIVO_IVA_APARTE)
      else if (order.contratoDePrecio !== 'IVA_INCLUIDO') unsupportedReasons.push(MOTIVO_CONTRATO_DESCONOCIDO)
      if (order.paymentStatus !== 'PAID') {
        unsupportedReasons.push(
          'Esta venta tiene productos con IVA distinto de 16 % y no está pagada por completo; se factura cuando se liquide.',
        )
      }
    }
    const unicos = Array.from(new Set(unsupportedReasons))
    unsupportedReasons.splice(0, unsupportedReasons.length, ...unicos)
  }

  // Mexican POS prices are IVA-included (gross): the customer's out-of-pocket already contains the
  // tax, and these orders carry taxAmount=0 (e.g. TPV). A non-zero taxAmount means a separated-tax
  // source (reservations, pos-sync) whose subtotal/taxAmount/total are already the real split.
  // 🔴 El concepto de respaldo (sin renglones) es SIEMPRE «lo pagado, IVA incluido»: si se mandara como
  // neto en una orden NET, el PAC le sumaría el 16 % encima de lo que el cliente ya pagó.
  // En la rama mixta manda el CONTRATO: con IVA_INCLUIDO los precios son brutos aunque `taxAmount` diga otra
  // cosa; sin él la factura ya quedó bloqueada arriba y se conserva la heurística para los importes de la fila.
  const pricesIncludeIva =
    (clasificacion === 'MIXTA' && order.contratoDePrecio === 'IVA_INCLUIDO') || peso(order.taxAmount) === 0 || sinRenglones

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
      const rate = tasaDelConcepto(it as RenglonParaCfdi)
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
  // Ronda final F2: una diferencia de REDONDEO (≤ `cotaDeRedondeoCents`, p. ej. la de D16) sigue a la búsqueda de abajo, que la
  // cuadra o se detiene con su motivo; más que eso es error de armado y se detiene aquí.
  // B3a Tarea 6b (founder, 5-oct: «la factura siempre coincide con el ticket»): TODA factura individual se calcula como el PAC y
  // tiene que dar lo cobrado. Si le faltan o le sobran centavos, se mueven en los descuentos (`cuadrarConElPac`); si así no
  // cuadra, se detiene con su motivo: nunca se timbra distinto. La marca de las Tareas 3-6 sólo decide la guarda del 8 %.
  if (unsupportedReasons.length === 0) {
    const conceptos = items as RenglonParaCfdi[]
    const paraElPac = conceptos.map(it => ({
      precio: new Prisma.Decimal(String(it.unitPrice)),
      cantidad: it.quantity,
      descuentoCents: peso(it.discountAmount),
      ivaIncluido: pricesIncludeIva,
      traslado: trasladoParaElPac(it),
      nombre: it.productName ?? undefined,
    }))
    const documentoCents = totalDelDocumentoCents({ items: items as any, pricesIncludeIva })
    // Ajuste 2 (Codex final r2): D16 redondea UNA VEZ POR FILA que participa (`sincronizarRepartos`), y sólo con IVA aparte.
    const filasD16 =
      order.contratoDePrecio === 'IVA_APARTE' ? orderDiscounts.filter(f => leerReparto(f.reparto)?.reduceImpuesto === true).length : 0
    const cuadre =
      Math.abs(documentoCents - paidCents) > cotaDeRedondeoCents(paraElPac, filasD16)
        ? {
            ok: false as const,
            motivo: `El total de la factura (${pesosTxt(documentoCents)}) no coincide con lo cobrado (${pesosTxt(paidCents)}). No se timbró; revisa la cuenta o repórtala a soporte.`,
          }
        : cuadrarConElPac(paraElPac, paidCents, { desbloqueado: requiereReglaDelPac })
    if (!cuadre.ok) unsupportedReasons.push(cuadre.motivo)
    else {
      for (const { indice, aCents } of cuadre.ajustes) {
        conceptos[indice] = { ...conceptos[indice], discountAmount: new Prisma.Decimal(aCents / 100) }
      }
      // Lo que se guarda es lo que dirá el XML: base neta del descuento, el IVA de cada tasa y el total = lo cobrado. SIEMPRE, aun
      // sin ajustes (ronda final F1, Codex final #1): con IVA aparte el escritor nativo guarda el subtotal BRUTO, y 20000 + 2880 ≠
      // 20880 rechazaba en la validación una factura que el PAC cuadra exacto.
      subtotalCents = cuadre.documento.subtotalCents - cuadre.documento.descuentoCents
      taxCents = cuadre.documento.ivaCents
      totalCents = cuadre.documento.totalCents
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
    order: {
      venueType: order.venue.type,
      tipAmount: order.tipAmount,
      items: items as any,
      pricesIncludeIva,
      clasificacion,
      // Lo que la entrada documental (Tarea 4) SELLA: un renglón por OrderItem real con su tratamiento
      // resuelto. Los conceptos de extras no tienen `orderItemId`, por eso no van aquí.
      renglonesOrigen: renglones.map(r => ({ orderItemId: r.id, tratamiento: r.tratamiento ?? 'IVA_16' })),
      // Foto congelada (Tarea 4): lo que el contrato/pago DECÍAN al cargar el bundle, no lo que digan después.
      contratoDePrecio: order.contratoDePrecio,
      paymentStatus: order.paymentStatus,
    },
  }
}

/**
 * Pone el `tratamiento` de un renglón (sellado > producto > IVA_16 sin producto) y DERIVA de él la tupla
 * vieja del producto (`taxRate` + `objetoImp`), para que montos, reparto y barrera sigan calculándose igual.
 * Con IVA_16 la tupla derivada es la misma que la guardada (el trigger del plan 1 las mantiene coherentes).
 * Un renglón con producto pero sin ningún tratamiento a la vista es entrada legacy: se deja como hoy.
 */
export function renglonConTratamiento<
  T extends { ivaTratamiento?: IvaTratamiento | null; product: { taxRate: any; ivaTratamiento?: IvaTratamiento | null } | null },
>(it: T): T & { tratamiento?: IvaTratamiento } {
  const tieneProducto = it.product != null
  if (tieneProducto && it.ivaTratamiento == null && it.product?.ivaTratamiento == null) return it
  const tratamiento = resolverTratamiento({ selladoIva: it.ivaTratamiento, productoIva: it.product?.ivaTratamiento, tieneProducto })
  if (!it.product) return { ...it, tratamiento }
  const tupla = tuplaDesdeTratamiento(tratamiento, Number(it.product.taxRate))
  return { ...it, tratamiento, product: { ...it.product, taxRate: new Prisma.Decimal(tupla.taxRate), objetoImp: tupla.objetoImp } }
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
//
// C2 · Tarea 2 (plan v7; Codex C2-5, C2-6, C2-7, C2-11, C2-20 a C2-29, C2-32). La cancelación NUNCA se reenvía sola:
//   1. la INTENCIÓN se anota antes del PAC (número de intento, motivo, sustituto), bajo los candados de la emisión;
//   2. cada intento se ENVÍA UNA vez, por su único dueño (`SELECT … FOR UPDATE` + token, confirmado antes de la red);
//   3. el dueño CONSULTA al PAC por la identidad de la factura antes del POST y relee su token justo antes de mandarlo;
//   4. la respuesta se clasifica por el contrato de CANCELACIÓN de Facturapi; lo que no se sabe queda EN DUDA (derivado);
//   5. el barrido, el webhook y toda consulta SÓLO consultan (GET); un rechazo confirmado cierra el intento;
//   6. un intento nuevo sólo lo crea una persona («Cancelar» en el panel), con número nuevo.

/** C2: una intención anotada que nunca se mandó al PAC deja de bloquear después de esto (el proceso que la anotó murió). */
export const INTENCION_ABANDONADA_MS = 10 * 60_000
/**
 * C2 ronda 2 (N1): cuánto se espera a que el PAC registre un envío EN DUDA antes de creerle un «sin solicitud». Si nuestro POST se cortó,
 * Facturapi puede seguir procesándolo: un `none` temprano no prueba que no salió.
 */
export const PLAZO_DE_LA_DUDA_MS = 24 * 60 * 60_000
/** C2 ronda 2 (N1): el cierre de un envío en duda que el PAC no registró en todo el plazo. */
export const MOTIVO_SIN_SOLICITUD_EN_EL_PLAZO =
  'No se llegó a cancelar: en 24 horas el SAT no registró la solicitud. La factura sigue vigente; si la sigues necesitando, pídela otra vez.'
/**
 * C2 (ronda 1, I2): margen sobre consulta previa + POST para declarar terminado un envío. Cubre lo que no tiene tiempo límite propio: la
 * espera del pool de conexiones en `sigoSiendoDueno` (~10 s) y la base de datos. (Ronda 2, N7: la espera del candado de `tomarEnvio` ya no
 * cuenta: el token se fija después de tenerlo.)
 */
export const MARGEN_DE_ENVIO_MS = 30_000
/**
 * C2: un envío con token de más de esto ya terminó: sin acuse, está EN DUDA. Nunca se reenvía.
 * 🔴 Ronda 1 (I2): el token se toma ANTES de la consulta previa y del POST, y cada una tiene su propio tiempo límite. Con 60 s (el plan
 * contaba sólo el POST) una consulta concurrente a los 61 s veía «en duda» con el POST todavía en vuelo y cerraba el intento. Se DERIVA de
 * los MISMOS tiempos límite del proveedor: consulta previa + POST + margen.
 */
export const ENVIO_TERMINADO_MS = TIEMPO_LIMITE_CONSULTA_MS + TIEMPO_LIMITE_ENVIO_MS + MARGEN_DE_ENVIO_MS

export type IntencionDeCancelar =
  | { estado: 'ANOTADA' | 'MISMA_EN_TRAMITE'; intento: number }
  | { estado: 'PERDIDA' }
  | { conflicto: string }
export type EstadoDeCancelacion = 'ANOTADA' | 'ENVIANDO' | 'EN_TRAMITE' | 'CANCELACION_EN_DUDA' | 'RECHAZADA' | 'CANCELADA' | null
export type ClaseDeErrorDeCancelacion = 'TRAMITE_EXISTENTE' | 'RECHAZO' | 'NO_SALIO' | 'EN_DUDA'
type ParamsDeCancelacion = { motivo: string; substituteUuid?: string }

/**
 * C2 v5: el estado de la cancelación, derivado de las columnas (sin columna nueva). EN DUDA = enviada, terminada y sin acuse.
 * Ronda 1 (M2): una `REQUESTED` con `cancelIntento = 0` es LEGADO —el código de antes de C2 sólo escribía `REQUESTED` después de que el PAC
 * contestara «en trámite»—: enviada y acusada aunque el backfill no la haya alcanzado (traslape del despliegue). Nunca «anotada».
 */
export function estadoDeCancelacion(
  c: { cancelStatus: string | null; cancelIntento?: number | null; cancelEnviadaAt?: Date | null; cancelAcusadaAt?: Date | null },
  ahora: Date,
): EstadoDeCancelacion {
  if (c.cancelStatus === 'CANCELLED' || c.cancelStatus === 'ACCEPTED') return 'CANCELADA'
  if (c.cancelStatus === 'REJECTED') return 'RECHAZADA'
  if (c.cancelStatus !== 'REQUESTED') return null
  if (c.cancelAcusadaAt || c.cancelIntento === 0) return 'EN_TRAMITE'
  if (!c.cancelEnviadaAt) return 'ANOTADA'
  return ahora.getTime() - new Date(c.cancelEnviadaAt).getTime() >= ENVIO_TERMINADO_MS ? 'CANCELACION_EN_DUDA' : 'ENVIANDO'
}

/**
 * C2 v5 (Codex C2-25): los códigos de CANCELACIÓN de Facturapi (docs «Errores», 5-oct). 🔴 La lista de rechazos de TIMBRADO
 * (`RECHAZOS_CONFIRMADOS`) no aplica aquí: un `invoice_stamping_validation_error` en una cancelación no dice nada de ella.
 */
/**
 * C2 · T10: el PAC (o el SAT) dice que la factura tiene CFDI relacionados. Ronda 1 (M2): con límites de palabra, para que «unrelated» (u
 * otra palabra que sólo CONTIENE «related») no cuente.
 */
const RELACIONADOS = /\brelacionad|\brelated\b/i
/**
 * C2 · T10 ronda 1 (M2): con un código de SUSTITUCIÓN el problema es la factura sustituta (motivo 01), no «notas de crédito». Cada uno, su
 * texto; uno nuevo con ese prefijo cae al genérico de la sustituta.
 */
const TEXTO_DE_LA_SUSTITUTA: Record<string, string> = {
  substitution_invoice_required:
    'El SAT pide la factura que sustituye a ésta (motivo 01) y no la recibió. La factura sigue vigente; pídela otra vez con el folio fiscal de la sustituta.',
  substitution_invoice_not_found:
    'El SAT no encontró la factura sustituta que se indicó. La factura sigue vigente; revisa el folio fiscal de la sustituta y pídela otra vez.',
  substitution_invoice_canceled:
    'La factura sustituta que se indicó está cancelada. La factura sigue vigente; indica una sustituta vigente y pídela otra vez.',
  substitution_invoice_status_not_allowed:
    'La factura sustituta que se indicó no está en un estado que permita la sustitución. La factura sigue vigente.',
}
const TEXTO_DE_LA_SUSTITUTA_GENERICO = 'El SAT no aceptó la factura sustituta que se indicó. La factura sigue vigente.'
const RECHAZOS_DE_CANCELACION = [
  'invoice_cancellation_not_allowed',
  'invoice_not_cancelable',
  'invoice_not_cancelable_by_sat',
  'invoice_cancellation_rfc_mismatch',
  'substitution_invoice_required',
  'substitution_invoice_not_found',
  'substitution_invoice_canceled',
  'substitution_invoice_status_not_allowed',
  'invalid_request',
]
export function clasificarErrorDeCancelacion(err: unknown): ClaseDeErrorDeCancelacion {
  const http = err instanceof ProviderHttpError ? err : null
  const code = http?.code ?? null
  // Ronda 1 (M3): la llave no pasó (401/403) o la factura no existe en el PAC (404 resource_missing): la solicitud NO salió.
  if (http && (http.status === 401 || http.status === 403 || (http.status === 404 && code === 'resource_missing'))) return 'NO_SALIO'
  if (code === 'invoice_cancellation_in_progress') return 'TRAMITE_EXISTENTE'
  if (code && RECHAZOS_DE_CANCELACION.includes(code)) return 'RECHAZO'
  // C2 · T10 (respuesta del controlador a P6): un 4xx que dice que la factura tiene CFDI relacionados es la negativa del SAT, aunque el
  // código no esté en la lista; se cierra con su frase (`traducirRechazoDeCancelacion`). Como todo rechazo, antes de cerrar se consulta
  // por identidad (`enviarCancelacion`). Un 5xx con el mismo texto sigue en duda: no se sabe si salió.
  if (http && http.status >= 400 && http.status < 500 && RELACIONADOS.test(http.message)) return 'RECHAZO'
  return 'EN_DUDA' // red, tiempo, 5xx, servicio no disponible, «no se pudo», desconocido: no se sabe; se consulta, nunca se reenvía
}

/**
 * C2: por qué el PAC rechazó la cancelación, en palabras del dueño (nace en la Tarea 2; la Tarea 10 la amplía). Si el PAC habla de
 * documentos relacionados, dice qué hacer; si no, su mensaje tal cual (y nunca un texto vacío).
 */
export function traducirRechazoDeCancelacion(err: unknown): string {
  const mensaje = (err instanceof Error ? err.message : String(err ?? '')).trim()
  const code = err instanceof ProviderHttpError ? err.code : null
  // Ronda 1 (M2): un código de sustitución habla de la SUSTITUTA aunque el texto diga «relacionado» (lo es: la sustituta se relaciona).
  if (code?.startsWith('substitution_invoice_')) return TEXTO_DE_LA_SUSTITUTA[code] ?? TEXTO_DE_LA_SUSTITUTA_GENERICO
  if (RELACIONADOS.test(mensaje)) return 'Esta factura ya tiene notas de crédito; cancélalas primero.'
  return mensaje || 'El SAT no aceptó la cancelación: la factura sigue vigente.'
}

/**
 * C2 (Codex C2-6): el SAT exige cancelar primero lo relacionado. Un egreso VIVO (timbrado, reservado o incierto) que apunta a esta
 * factura impide anotar la intención: si no, el PAC podría aceptar la cancelación y después timbrar la nota contra una factura cancelada.
 * (Las notas heredadas, sin protocolo, apuntan a la orden: cuentan contra la individual de esa orden.) La Tarea 3 la usa también en la
 * sustitución (G4).
 * Ronda 1 (M7, conservador a propósito): una nota HEREDADA no guarda a qué factura pertenece, así que una viva bloquea la cancelación de
 * CUALQUIER factura individual de su orden —también de una sustituta posterior, aunque la nota fuera de la factura anterior—. Es raro (las
 * heredadas son de antes del protocolo) y bloquear de más sólo pide cancelar antes la nota; bloquear de menos dejaría una nota viva
 * contra una factura cancelada.
 */
export async function documentoRelacionadoVivo(
  tx: Prisma.TransactionClient,
  cfdiId: string,
  actual: { orderId: string | null; isGlobal: boolean },
): Promise<{ serie: string | null; folio: string | null; uuid: string | null; status: CfdiStatus } | null> {
  return tx.cfdi.findFirst({
    where: {
      type: 'EGRESO',
      id: { not: cfdiId },
      ...CFDI_VIVO,
      OR: [
        { entrada: { path: ['originalCfdiId'], equals: cfdiId } },
        ...(actual.orderId && !actual.isGlobal ? [{ orderId: actual.orderId, protocoloIva: null }] : []),
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { serie: true, folio: true, uuid: true, status: true },
  })
}

/** El texto del conflicto C2-6, con el folio de la nota si ya lo tiene (una nota reservada todavía no tiene folio). */
export function textoDeDocumentoRelacionado(r: {
  serie: string | null
  folio: string | null
  uuid: string | null
  status: string
}): string {
  const nota = r.serie || r.folio || r.uuid ? `la nota de crédito ${folioDe(r)}` : 'una nota de crédito'
  return `Esta factura tiene ${nota} ${r.status === 'STAMPED' ? 'vigente' : 'en proceso'}; el SAT exige cancelar primero lo relacionado.`
}

/** C2 · Tarea 3, ronda 1 (M1): el conflicto de cancelar una factura cuya sustitución sigue en curso. */
export const TEXTO_SUSTITUCION_EN_CURSO = 'Esta factura se está sustituyendo; espera a que termine antes de cancelarla.'
/**
 * C2 · T10 (N1 de la re-revisión de la T3): una sustituta ENVIADA al PAC hace más de esto y sin timbrar está atorada. La política
 * `CFDI_VIVO` la deja viva (puede estar timbrada en el SAT) hasta que soporte la resuelva: bloquear sigue siendo lo correcto, pero el texto
 * no puede prometer «espera a que termine».
 */
export const SUSTITUTA_ATORADA_MS = 60 * 60_000
export function sustitutaAtorada(s: { status: string; enviadoAt: Date | string | null } | null, ahora: Date): boolean {
  return !!s?.enviadoAt && s.status !== 'STAMPED' && ahora.getTime() - new Date(s.enviadoAt).getTime() >= SUSTITUTA_ATORADA_MS
}
/**
 * C2 · T10 (M2 de la T3): por qué no EMPIEZA una sustitución sobre una original con la cancelación pedida, según en qué va. «En trámite ante
 * el SAT» es sólo la acusada; anotada o enviándose, el SAT todavía no la tiene; en duda, puede tardar hasta 24 h (`PLAZO_DE_LA_DUDA_MS`).
 */
export function textoDeCancelacionPendienteAlSustituir(
  c: { cancelStatus: string | null; cancelIntento?: number | null; cancelEnviadaAt?: Date | null; cancelAcusadaAt?: Date | null },
  ahora: Date,
): string {
  const e = estadoDeCancelacion(c, ahora)
  if (e === 'ANOTADA' || e === 'ENVIANDO')
    return 'La cancelación de esta factura se está enviando al SAT; espera a que se resuelva antes de sustituirla.'
  if (e === 'CANCELACION_EN_DUDA')
    return 'La cancelación de esta factura está en duda: la estamos confirmando con el SAT (puede tardar hasta 24 horas). Espera a que se resuelva antes de sustituirla.'
  return 'Esta factura tiene una cancelación en trámite ante el SAT; espera a que se resuelva antes de sustituirla.'
}
/**
 * C2 · T10 ronda 1 (M3): por qué no se puede volver a facturar una venta cuya factura anterior tiene la cancelación pedida, según en qué va
 * (el mismo criterio que `textoDeCancelacionPendienteAlSustituir`). «En trámite ante el SAT» sólo con el acuse, un legado o el estado heredado.
 */
export function textoDeCancelacionPendienteAlRefacturar(
  c: {
    cancelStatus: string | null
    cancelIntento?: number | null
    cancelEnviadaAt?: Date | null
    cancelAcusadaAt?: Date | null
    serie?: string | null
    folio?: string | null
    uuid?: string | null
  },
  ahora: Date,
): string {
  const e = estadoDeCancelacion(c, ahora)
  const factura = `la factura ${folioDe(c)}`
  if (e === 'ANOTADA' || e === 'ENVIANDO')
    return `La cancelación de ${factura} se está enviando al SAT; en cuanto quede cancelada podrás volver a facturar esta venta.`
  if (e === 'CANCELACION_EN_DUDA')
    return `La cancelación de ${factura} está en duda: la estamos confirmando con el SAT (puede tardar hasta 24 horas). En cuanto quede cancelada podrás volver a facturar esta venta.`
  return `La cancelación de ${factura} sigue en trámite ante el SAT; en cuanto quede cancelada podrás volver a facturar esta venta.`
}
export const TEXTO_SUSTITUCION_ATORADA =
  'Esta factura se está sustituyendo y la factura nueva lleva más de una hora sin respuesta del PAC. Escríbenos a soporte para resolverla; después podrás cancelarla.'

/**
 * C2 (spec §4.5, Codex C2-5): la intención de cancelar se anota ANTES de llamar al PAC, con número de intento, bajo los candados de la
 * emisión (órdenes del CFDI → productos → admisión compartida). La misma cancelación ya en trámite devuelve su número; una distinta,
 * conflicto. C2-22: el sustituto SIEMPRE se escribe (también `null`), así un 02 tras un 01 rechazado no arrastra el UUID viejo.
 * (C3 agrega su guarda aquí.)
 */
export async function anotarIntencionDeCancelar(cfdiId: string, version: number, p: ParamsDeCancelacion): Promise<IntencionDeCancelar> {
  return prisma.$transaction(
    async tx => {
      const orders = await tx.$queryRaw<Array<{ orderId: string }>>`
        SELECT "orderId" FROM "Cfdi" WHERE id = ${cfdiId} AND "orderId" IS NOT NULL
        UNION SELECT "orderId" FROM "CfdiGlobalOrden" WHERE "cfdiId" = ${cfdiId}
        ORDER BY "orderId"
      `
      await bloquearOrdenesParaFacturar(
        tx,
        orders.map(o => o.orderId),
      )
      const actual = await tx.cfdi.findUnique({
        where: { id: cfdiId },
        select: {
          status: true,
          attempts: true,
          cancelStatus: true,
          cancelMotivo: true,
          cancelSubstituteUuid: true,
          cancelIntento: true,
          orderId: true,
          isGlobal: true,
          venue: { select: { organizationId: true } },
        },
      })
      if (!actual) return { estado: 'PERDIDA' }
      await tomarAdmisionCompartida(tx, actual.venue.organizationId)
      if (
        actual.status !== 'STAMPED' ||
        actual.attempts !== version ||
        actual.cancelStatus === 'ACCEPTED' ||
        actual.cancelStatus === 'CANCELLED'
      )
        return { estado: 'PERDIDA' }
      const relacionado = await documentoRelacionadoVivo(tx, cfdiId, actual)
      if (relacionado) return { conflicto: textoDeDocumentoRelacionado(relacionado) }
      // C2 · Tarea 3, ronda 1 (M1): tampoco con una sustitución EN CURSO (sustituta viva y todavía sin timbrar): si el SAT rechazara esta
      // cancelación, la sustituta quedaría timbrada junto a la original. `cancelarOriginal` sólo anota con la sustituta ya timbrada, así
      // que no le afecta. Mismo candado de la orden que la reserva de la sustituta.
      const sustituyendose = await tx.cfdi.findFirst({
        where: { replacesCfdiId: cfdiId, type: 'INGRESO', status: { not: 'STAMPED' }, ...CFDI_VIVO },
        select: { id: true, status: true, enviadoAt: true },
      })
      // T10 (N1 de la T3): una sustituta atorada en el PAC (enviada hace más de una hora) no la termina nadie sola: el texto manda a soporte.
      if (sustituyendose)
        return { conflicto: sustitutaAtorada(sustituyendose, new Date()) ? TEXTO_SUSTITUCION_ATORADA : TEXTO_SUSTITUCION_EN_CURSO }
      if (actual.cancelStatus === 'REQUESTED') {
        const misma = actual.cancelMotivo === p.motivo && (actual.cancelSubstituteUuid ?? null) === (p.substituteUuid ?? null)
        return misma
          ? { estado: 'MISMA_EN_TRAMITE', intento: actual.cancelIntento }
          : { conflicto: 'Esta factura ya tiene una cancelación en trámite con otro motivo; espera a que el SAT la resuelva.' }
      }
      const { count } = await tx.cfdi.updateMany({
        where: {
          id: cfdiId,
          status: 'STAMPED',
          attempts: version,
          cancelIntento: actual.cancelIntento,
          OR: [{ cancelStatus: null }, { cancelStatus: 'REJECTED' }],
        },
        data: {
          cancelStatus: 'REQUESTED',
          cancelRequestedAt: new Date(),
          cancelMotivo: p.motivo,
          cancelSubstituteUuid: p.substituteUuid ?? null,
          cancelIntento: { increment: 1 },
          cancelEnviadaAt: null,
          cancelAcusadaAt: null,
          lastError: null,
        },
      })
      return count === 1 ? { estado: 'ANOTADA', intento: actual.cancelIntento + 1 } : { estado: 'PERDIDA' }
    },
    { timeout: 15_000, maxWait: 5_000 },
  )
}

/**
 * C2 (Codex C2-11/C2-20/C2-24): UN envío por intento. Transacción CORTA con la fila `FOR UPDATE`: el intento sigue abierto y nadie lo tomó.
 * Escribe el token y confirma ANTES de la red. Con token puesto, nadie vuelve a mandar ese intento (no hay reenvío). Nunca se pide
 * teniendo los candados de emisión.
 */
export async function tomarEnvio(cfdiId: string, intento: number, ahora: Date): Promise<Date | null> {
  return prisma.$transaction(async tx => {
    const [f] = await tx.$queryRaw<Array<{ cancelStatus: string | null; cancelIntento: number; cancelEnviadaAt: Date | null }>>`
      SELECT "cancelStatus"::text AS "cancelStatus", "cancelIntento", "cancelEnviadaAt" FROM "Cfdi" WHERE id = ${cfdiId} FOR UPDATE`
    // Ronda 1 (M2): el intento 0 es legado (enviado y acusado por el código de antes de C2): nadie lo vuelve a enviar.
    if (!f || f.cancelStatus !== 'REQUESTED' || f.cancelIntento !== intento || intento === 0 || f.cancelEnviadaAt !== null) return null
    // Ronda 2 (N7): el token se fija DESPUÉS de tener el candado (la espera del candado no cuenta contra la ventana del envío).
    const token = new Date(Math.max(ahora.getTime(), Date.now()))
    await tx.cfdi.update({ where: { id: cfdiId }, data: { cancelEnviadaAt: token } })
    return token
  })
}

/** C2 v5: justo antes del POST, ¿el token sigue siendo el vigente y el intento sigue abierto? (achica la ventana del dueño dormido) */
export async function sigoSiendoDueno(cfdiId: string, intento: number, token: Date): Promise<boolean> {
  return (
    (await prisma.cfdi.count({
      where: { id: cfdiId, cancelStatus: 'REQUESTED', cancelIntento: intento, cancelEnviadaAt: token, cancelAcusadaAt: null },
    })) === 1
  )
}

export type ResultadoDeEnvio = 'ACUSADA' | 'APLICADA' | 'EN_DUDA' | 'YA_NO_ES_DUENO'

/** C2 ronda 1 (M1): lo que queda escrito cuando la consulta previa falla (no se envió nada). */
export const MOTIVO_CONSULTA_PREVIA_FALLIDA =
  'No se llegó a enviar la cancelación al SAT (no se pudo consultar antes de enviarla): la factura sigue vigente. Vuelve a pedirla.'
/** C2 ronda 1 (M1): lo que oye quien pidió la cancelación cuando la consulta previa falla (502). */
export const TEXTO_CONSULTA_PREVIA_FALLIDA =
  'No se pudo consultar al SAT antes de enviar la cancelación: no se envió nada y la factura sigue vigente. Intenta de nuevo en unos minutos.'

/** C2 ronda 1 (M3): por qué no salió la solicitud (401/403: la llave; 404: la factura no existe en el PAC). */
function porQueNoSalio(err: unknown): string {
  const status = err instanceof ProviderHttpError ? err.status : null
  return status === 404
    ? 'Facturapi no encontró la factura: la cancelación no se envió y la factura sigue vigente. Revisa la factura con soporte.'
    : 'Facturapi rechazó la llave del emisor: la cancelación no se envió y la factura sigue vigente. Revisa la conexión del emisor con el PAC.'
}

/** C2 ronda 2 (N6): el `origen` de las dos bitácoras de la vía tardía del dueño (confirmación y tardía), uno solo. */
export const ORIGEN_DUENO_TARDIO = 'DUENO_TARDIO'
/** C2 · OF-2 (T2 R4): el `origen` de la bitácora de un desenlace que escribe la petición del dueño al momento. */
export const ORIGEN_DUENO = 'DUENO'

export interface OpcionesDeEnvio {
  /** Relee la fila (la vía tardía del dueño: ¿una consulta cerró el intento mientras su POST volaba?). */
  releer?: (cfdiId: string) => Promise<any | null>
  /** La bitácora de la vía tardía (`CFDI_CANCELACION_TARDIA`, y la confirmación cuando la factura quedó cancelada). */
  registrar?: (params: LogActionParams) => Promise<void>
}

/**
 * C2 (Codex C2-20/C2-24/C2-25): consulta primero por la identidad de la factura y manda UNA vez sólo si no hay trámite. Cada desenlace
 * con CAS sobre (intento, token). Lo que no se sabe queda EN DUDA: no se escribe nada y nunca se reenvía. Un proveedor sin consulta (la
 * interfaz la hace opcional) manda sin consulta previa; el token ya garantiza un solo envío por intento.
 *
 * Ronda 1:
 * - M1: si la consulta previa FALLA, no sale nada: el intento se cierra «no se llegó a enviar» (CAS intento + token, sin acuse) y se lanza
 *   `ProviderUnavailableError` (502). Nunca una «en duda» falsa.
 * - M3: 401/403 y 404 `resource_missing` en el POST ⇒ «no salió»: se cierra con su porqué, sin consulta de confirmación.
 * - 🔴 I2 (b): el dueño NUNCA descarta en silencio la respuesta de su propio POST. Si su escritura pierde el CAS porque una consulta ya cerró
 *   el intento (REJECTED, mismo intento), relee y aplica la vía tardía (REQUESTED acusada o CANCELLED) con `CFDI_CANCELACION_TARDIA`; si
 *   la fila ya dice lo mismo o más, lo deja en el log. Un hecho «cancelada» tras el POST sube primero SÓLO desde REQUESTED: subir desde un
 *   REJECTED es justamente la vía tardía, que se registra.
 */
export async function enviarCancelacion(
  cfdi: any,
  intento: number,
  token: Date,
  provider: any,
  p: ParamsDeCancelacion,
  aplicar: typeof aplicarCancelacion = aplicarCancelacion,
  dueno: typeof sigoSiendoDueno = sigoSiendoDueno,
  opciones: OpcionesDeEnvio = {},
): Promise<ResultadoDeEnvio> {
  const releer = opciones.releer ?? ((id: string) => prisma.cfdi.findUnique({ where: { id }, include: { fiscalEmisor: true } }))
  const registrar = opciones.registrar ?? logAction
  const mio: Prisma.CfdiWhereInput = { cancelIntento: intento, cancelEnviadaAt: token }
  const consultar: ((id: string) => Promise<{ status: string; cancelledAt: Date | null }>) | null =
    typeof provider.getCancellationStatus === 'function' ? id => provider.getCancellationStatus(id) : null
  type Respuesta = { status: string; cancelledAt: Date | null }

  /** I2 (b): la respuesta del POST llegó cuando la fila ya había cambiado. */
  const viaTardia = async (r: Respuesta): Promise<ResultadoDeEnvio> => {
    const s = mapProviderCancelStatus(r.status)
    const fila = await releer(cfdi.id)
    if (fila?.status === 'STAMPED' && fila.cancelStatus === 'REJECTED' && fila.cancelIntento === intento) {
      const data: Record<string, any> =
        s === 'REQUESTED'
          ? { cancelStatus: 'REQUESTED', cancelAcusadaAt: new Date(), lastError: null } // ronda 2 (N4): el porqué del cierre ya no aplica
          : { status: 'CANCELLED', cancelStatus: s, ...(r.cancelledAt ? { cancelledAt: r.cancelledAt } : {}) }
      const escrita = await aplicar(cfdi.id, data, cfdi.attempts, 'EXTERNA', { cancelStatus: 'REJECTED', cancelIntento: intento })
      if (escrita) {
        const base = { uuid: cfdi.uuid ?? null, folio: folioDe(cfdi), providerStatus: r.status, cancelStatus: data.cancelStatus }
        if (data.status === 'CANCELLED')
          await registrar({
            staffId: null,
            venueId: cfdi.venueId,
            action: 'CFDI_CANCEL_CONFIRMED',
            entity: 'Cfdi',
            entityId: cfdi.id,
            data: { ...base, cancelIntento: intento, origen: ORIGEN_DUENO_TARDIO },
          })
        await registrar({
          staffId: null,
          venueId: cfdi.venueId,
          action: 'CFDI_CANCELACION_TARDIA',
          entity: 'Cfdi',
          entityId: cfdi.id,
          data: { ...base, cancelIntento: intento, lastError: fila.lastError ?? null, origen: ORIGEN_DUENO_TARDIO },
        })
        return s === 'REQUESTED' ? 'ACUSADA' : 'APLICADA'
      }
    }
    logger.info('[cancelación] la respuesta del POST llegó cuando la fila ya había cambiado; no hay nada que aplicar', {
      cfdiId: cfdi.id,
      cancelIntento: intento,
      providerStatus: r.status,
      cancelStatus: fila?.cancelStatus ?? null,
      cancelIntentoFila: fila?.cancelIntento ?? null,
    })
    return s === 'REQUESTED' ? 'ACUSADA' : 'APLICADA'
  }

  /**
   * C2 · OF-2 (T2 R4): un desenlace que escribe el DUEÑO (un hecho o un cierre) deja su bitácora, como las demás vías: `CFDI_CANCEL_CONFIRMED`
   * o `CFDI_CANCEL_NOT_APPLIED`, con `origen: DUENO`. Sólo si SU escritura ganó (audita sólo el ganador). El acuse no es un desenlace.
   */
  const desenlace = async (data: Record<string, any>, cas: Prisma.CfdiWhereInput, providerStatus: string | null) => {
    const escrita = await aplicar(cfdi.id, data, cfdi.attempts, 'PENDIENTE', cas)
    if (escrita)
      await registrar({
        staffId: null,
        venueId: cfdi.venueId,
        action: data.status === 'CANCELLED' ? 'CFDI_CANCEL_CONFIRMED' : 'CFDI_CANCEL_NOT_APPLIED',
        entity: 'Cfdi',
        entityId: cfdi.id,
        data: {
          uuid: cfdi.uuid ?? null,
          folio: folioDe(cfdi),
          providerStatus,
          cancelStatus: data.cancelStatus,
          cancelIntento: intento,
          origen: ORIGEN_DUENO,
        },
      })
    return escrita
  }

  /** Aplica un hecho o un acuse. `trasPost`: la respuesta viene de (o después de) NUESTRO POST, y nunca se descarta en silencio. */
  const hecho = async (r: Respuesta, trasPost: boolean): Promise<ResultadoDeEnvio | null> => {
    const s = mapProviderCancelStatus(r.status) // pending y verifying ⇒ REQUESTED
    if (s === 'CANCELLED' || s === 'ACCEPTED') {
      // Un hecho: terminal. Antes del POST sube desde REQUESTED o REJECTED de ESTE intento (C2-32); tras el POST, primero sólo desde
      // REQUESTED, y si no, la vía tardía (que lo registra).
      const escrita = await desenlace(
        { status: 'CANCELLED', cancelStatus: s, ...(r.cancelledAt ? { cancelledAt: r.cancelledAt } : {}) },
        trasPost ? { cancelIntento: intento, cancelStatus: 'REQUESTED' } : { cancelIntento: intento },
        r.status,
      )
      return escrita || !trasPost ? 'APLICADA' : viaTardia(r)
    }
    if (s === 'REQUESTED') {
      const escrita = await aplicar(cfdi.id, { cancelAcusadaAt: new Date() }, cfdi.attempts, 'PENDIENTE', mio)
      return escrita || !trasPost ? 'ACUSADA' : viaTardia(r)
    }
    return null // negativo: no dice nada de este intento
  }

  if (consultar) {
    let previa: Respuesta
    try {
      previa = await consultar(cfdi.facturapiId) // 1) consulta por identidad
    } catch (err: unknown) {
      // M1: no salió nada. Se cierra el intento (si sigue siendo nuestro) y se dice con claridad.
      logger.warn(
        `[cancelación] ${cfdi.id} intento ${intento}: la consulta previa falló; no se envió: ${err instanceof Error ? err.message : String(err)}`,
      )
      await desenlace({ cancelStatus: 'REJECTED', lastError: MOTIVO_CONSULTA_PREVIA_FALLIDA }, { ...mio, cancelAcusadaAt: null }, null)
      throw new ProviderUnavailableError(TEXTO_CONSULTA_PREVIA_FALLIDA)
    }
    const yaHabia = await hecho(previa, false)
    if (yaHabia) return yaHabia
  }
  if (!(await dueno(cfdi.id, intento, token))) return 'YA_NO_ES_DUENO' // 2) el intento se cerró mientras dormía
  let res: Respuesta
  try {
    res = await provider.cancelInvoice({ providerInvoiceId: cfdi.facturapiId, motivo: p.motivo, substituteUuid: p.substituteUuid }) // 3) UN POST
  } catch (err: unknown) {
    const clase = clasificarErrorDeCancelacion(err)
    if (clase === 'EN_DUDA') {
      logger.warn(`[cancelación] ${cfdi.id} intento ${intento} en duda: ${err instanceof Error ? err.message : String(err)}`)
      return 'EN_DUDA'
    }
    if (clase === 'NO_SALIO') {
      await desenlace({ cancelStatus: 'REJECTED', lastError: porQueNoSalio(err) }, { ...mio, cancelAcusadaAt: null }, null)
      return 'APLICADA'
    }
    // Trámite existente o rechazo concluyente: una consulta por identidad decide antes de cerrar nada. Si no se puede consultar, no se
    // sabe: en duda (la consulta del barrido decide después).
    let despues: ResultadoDeEnvio | null = null
    try {
      despues = consultar ? await hecho(await consultar(cfdi.facturapiId), true) : null
    } catch {
      return 'EN_DUDA'
    }
    if (despues) return despues
    if (clase === 'TRAMITE_EXISTENTE') return 'EN_DUDA' // dijo «en curso» y la consulta no lo ve: no se sabe
    await desenlace({ cancelStatus: 'REJECTED', lastError: traducirRechazoDeCancelacion(err) }, { ...mio, cancelAcusadaAt: null }, null)
    return 'APLICADA'
  }
  return (await hecho(res, true)) ?? 'EN_DUDA'
}

/**
 * C2-32 (v7): el orden monótono del estado de cancelación DENTRO de un intento. Un hecho confirmado (cancelada/aceptada) es terminal y está
 * arriba: sube desde cualquier estado menor del MISMO intento, también desde un `REJECTED` que un negativo concurrente acaba de escribir. El
 * negativo y el acuse (que no cambia el estado) sólo salen de `REQUESTED`. Y `status: 'STAMPED'` del `where` impide rebajar un `CANCELLED`.
 */
export const RANGO_DE_CANCELACION = { REQUESTED: 1, REJECTED: 2, CANCELLED: 3, ACCEPTED: 3 } as const
type EstadoConRango = keyof typeof RANGO_DE_CANCELACION
export function desdeDondeSube(destino: EstadoConRango): Array<'REQUESTED' | 'REJECTED'> {
  if (destino === 'REQUESTED') return ['REQUESTED'] // el acuse: mismo rango, sólo sobre sí mismo
  return (['REQUESTED', 'REJECTED'] as const).filter(e => RANGO_DE_CANCELACION[e] < RANGO_DE_CANCELACION[destino])
}

export interface CancelCfdiDeps {
  loadCfdi: (cfdiId: string) => Promise<any | null>
  resolveProvider: typeof resolveFiscalProvider
  /** El escritor del desenlace: `aplicarCancelacion` (C2-26: una sola firma; el CAS va en el 5.º argumento). */
  updateCfdi: typeof aplicarCancelacion
  /** C2: anota la intención (con número de intento) ANTES de tocar al PAC, bajo los candados de la emisión. */
  anotarIntencion: typeof anotarIntencionDeCancelar
  /** C2: toma el ÚNICO envío del intento (`SELECT … FOR UPDATE` + token). `null` = no ganó. */
  tomarEnvio: typeof tomarEnvio
  /** C2: SÓLO consulta al PAC (nunca envía): lo que se usa cuando el intento ya está abierto por otro. */
  refresh: (cfdi: any, opts: { sandbox: boolean }) => Promise<any>
  /** C2: el envío (consulta → relectura → UN POST). Por defecto `enviarCancelacion`; las pruebas lo pausan. */
  enviar?: typeof enviarCancelacion
  /** C2: la relectura del token justo antes del POST. Por defecto `sigoSiendoDueno`. */
  dueno?: typeof sigoSiendoDueno
  /** C2 (ronda 1, I2): la bitácora de la vía tardía del dueño (`CFDI_CANCELACION_TARDIA`). Por defecto `logAction`. */
  logAction?: (params: LogActionParams) => Promise<void>
}

export interface CancelCfdiResult {
  /** Quien ENVIÓ el intento (o lo dejó en duda) escribe la bitácora del controlador; quien sólo consultó, no. */
  applied: boolean
  /** `null` sólo en «Consultar estado» (`soloConsultar`) sobre una factura sin cancelación pedida: sigue vigente. */
  cancelStatus: 'REQUESTED' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | null
  cancelledAt: Date | null
  cfdi: any
  /** C2: el POST no tuvo respuesta clara: la cancelación quedó EN DUDA y sólo se consulta (nunca se reenvía sola). */
  enDuda?: boolean
  /** C2: el intento ya estaba abierto (otra petición lo envió): no se mandó nada, sólo se consultó. */
  enTramitePorOtro?: boolean
  /** C2: el estado derivado de la cancelación (incluye `CANCELACION_EN_DUDA`). */
  estado?: EstadoDeCancelacion
  /** C2 (ronda 1, M6): ESTA petición anotó un intento nuevo (para registrar quién lo pidió aunque otra escritura gane). */
  intencionNueva?: boolean
}

export async function cancelCfdi(
  params: {
    cfdiId: string
    /** Con `soloConsultar` no hace falta (no se pide nada). */
    motivo?: '01' | '02' | '03' | '04'
    substituteUuid?: string
    sandbox: boolean
    expectedVenueId?: string
    /**
     * C2 · T10 ronda 1 (I-1): «Consultar estado». NUNCA anota un intento, ni toma el envío, ni manda nada al PAC: con la cancelación
     * pedida (`REQUESTED`) sólo CONSULTA (GET); si no, dice cómo está la fila sin escribir nada.
     */
    soloConsultar?: boolean
  },
  deps: CancelCfdiDeps = defaultCancelDeps,
): Promise<CancelCfdiResult> {
  // 1. Load + tenant isolation
  const cfdi = await deps.loadCfdi(params.cfdiId)
  if (!cfdi) throw new Error(`CFDI ${params.cfdiId} not found`)
  if (params.expectedVenueId && cfdi.venueId !== params.expectedVenueId) {
    throw new Error(`CFDI ${params.cfdiId} not found`) // tenant isolation → 404
  }

  // C2 · T10 ronda 1 (I-1): «Consultar estado» sólo consulta. Va ANTES de las reglas de cancelar: consultar una cancelada, o sin motivo,
  // no es un error. 🔴 Nunca llega a `anotarIntencion` ni a `tomarEnvio`: un intento nuevo sólo lo pide una persona con «Cancelar».
  if (params.soloConsultar) return consultarCancelacion(cfdi, params.sandbox, deps)

  // 2. Business-rule guards (spec §12: shape-only in Zod; rules stay in service)
  if (cfdi.status !== 'STAMPED') {
    throw new Error('Solo se puede cancelar un CFDI timbrado (STAMPED)')
  }
  if (!params.motivo) {
    throw new Error('El motivo de cancelación es requerido')
  }
  if (params.motivo === '01' && !params.substituteUuid) {
    throw new Error('El motivo 01 requiere el UUID de sustitución')
  }

  // 3. C2: la intención, ANTES del PAC (con documentos relacionados vivos ⇒ conflicto que los nombra, C2-6).
  const version = cfdi.attempts
  const p: ParamsDeCancelacion = { motivo: params.motivo, substituteUuid: params.substituteUuid }
  const intencion = await deps.anotarIntencion(cfdi.id, version, p)
  if ('conflicto' in intencion) throw new ConflictError(intencion.conflicto)
  const actualDe = async () => (await deps.loadCfdi(cfdi.id)) ?? cfdi
  // Ronda 1 (M6): ¿ESTA petición anotó un intento nuevo? El controlador registra quién lo pidió aunque otra escritura gane.
  const intencionNueva = intencion.estado === 'ANOTADA'
  const comoQuedo = (c: any, extra: Partial<CancelCfdiResult> = {}): CancelCfdiResult => ({
    applied: false,
    cancelStatus: c.cancelStatus ?? (c.status === 'CANCELLED' ? 'CANCELLED' : 'REJECTED'),
    cancelledAt: c.cancelledAt ?? null,
    cfdi: c,
    estado: estadoDeCancelacion(c, new Date()),
    intencionNueva,
    ...extra,
  })
  if (intencion.estado === 'PERDIDA') return comoQuedo(await actualDe())

  // 4. C2: el ÚNICO envío del intento. Si otro ya lo tomó (o ya tiene token), no se manda nada: sólo se consulta y se dice.
  const token = await deps.tomarEnvio(cfdi.id, intencion.intento, new Date())
  if (!token) {
    const fila = await actualDe()
    let vista = fila
    try {
      vista = (await deps.refresh(fila, { sandbox: params.sandbox })) ?? fila
    } catch (err: unknown) {
      // Consultar es sólo informativo aquí (no se envió nada): si el PAC no contesta, se dice cómo quedó la fila.
      logger.warn(`[cancelación] no se pudo consultar ${cfdi.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return comoQuedo(vista, { enTramitePorOtro: true })
  }

  // 5. consulta → relectura del token → UN POST → desenlace con CAS (intento, token).
  const provider = deps.resolveProvider(cfdi.fiscalEmisor, { sandbox: params.sandbox })
  // ¿Salió el POST? El proveedor se envuelve sin perder su prototipo (`this` de sus métodos), para saber si ESTA petición mandó algo.
  let salio = false
  const proveedor = Object.create(provider, {
    cancelInvoice: {
      value: (q: Parameters<typeof provider.cancelInvoice>[0]) => {
        salio = true
        return provider.cancelInvoice(q)
      },
    },
  })
  let escrita: any = null // la fila que devolvió la escritura ganadora (misma transacción que el estado)
  const aplicar: typeof aplicarCancelacion = async (...a) => {
    const r = await deps.updateCfdi(...a)
    if (r) escrita = r
    return r
  }
  const r = await (deps.enviar ?? enviarCancelacion)(cfdi, intencion.intento, token, proveedor, p, aplicar, deps.dueno ?? sigoSiendoDueno, {
    releer: deps.loadCfdi,
    registrar: deps.logAction ?? logAction,
  })
  const actual = escrita ?? (await actualDe())
  // Ronda 1 (I1): el dueño SABE que su POST terminó sin respuesta clara: eso es «en duda», aunque el token sea de hace menos del umbral
  // (el umbral sólo sirve a quien mira desde fuera y no lo sabe).
  const enDudaPropia = r === 'EN_DUDA' && (actual.cancelStatus ?? 'REQUESTED') === 'REQUESTED' && !actual.cancelAcusadaAt
  return {
    // Audita (CFDI_CANCELLED en el controlador) quien MANDÓ la solicitud o quien GANÓ la escritura: si la consulta previa vio el hecho y
    // otra petición ya lo había escrito (y auditado), ésta no repite el registro (liberarAlCancelar: «auditan sólo al ganador»).
    applied: salio || escrita !== null,
    cancelStatus: actual.cancelStatus ?? 'REQUESTED',
    cancelledAt: actual.cancelledAt ?? null,
    cfdi: actual,
    estado: enDudaPropia ? 'CANCELACION_EN_DUDA' : estadoDeCancelacion(actual, new Date()),
    intencionNueva,
    // Ronda 2 (N2): `enDuda` sólo si, al releer, la fila SIGUE en duda (no si ya se acusó o se cerró).
    ...(enDudaPropia ? { enDuda: true } : {}),
  }
}

/**
 * C2 · T10 ronda 1 (I-1): «Consultar estado». Con la cancelación pedida (`REQUESTED`) sólo consulta al PAC (`deps.refresh`: GET + su
 * desenlace con CAS, como el barrido); si no (rechazada, cancelada o sin cancelación), dice cómo está la fila sin escribir ni consultar
 * nada. Nunca audita como «cancelación pedida» (`applied: false`, `intencionNueva: false`). Si el PAC no contesta, dice cómo está la fila.
 */
async function consultarCancelacion(cfdi: any, sandbox: boolean, deps: CancelCfdiDeps): Promise<CancelCfdiResult> {
  let vista = cfdi
  if (cfdi.cancelStatus === 'REQUESTED') {
    try {
      vista = (await deps.refresh(cfdi, { sandbox })) ?? cfdi
    } catch (err: unknown) {
      logger.warn(`[cancelación] «Consultar estado» no pudo consultar ${cfdi.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const cancelada = vista.status === 'CANCELLED'
  return {
    applied: false,
    cancelStatus: vista.cancelStatus ?? (cancelada ? 'CANCELLED' : null),
    cancelledAt: vista.cancelledAt ?? null,
    cfdi: vista,
    estado: estadoDeCancelacion(vista, new Date()) ?? (cancelada ? 'CANCELADA' : null),
    intencionNueva: false,
  }
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
export const defaultCancelDeps: CancelCfdiDeps = {
  loadCfdi: id => prisma.cfdi.findUnique({ where: { id }, include: { fiscalEmisor: true } }),
  resolveProvider: resolveFiscalProvider,
  updateCfdi: aplicarCancelacion,
  anotarIntencion: anotarIntencionDeCancelar,
  tomarEnvio,
  refresh: (cfdi, opts) => refreshPendingCancellation(cfdi, opts),
}

/**
 * Estado y sellos cambian juntos; el orden de locks coincide con la reserva de emisión.
 * C2-21: con `tx`, TODO va en la transacción recibida (estado y sellos se revierten juntos); sin ella, abre la suya como antes.
 * C2-26: una sola firma — el CAS de quien llama (intento, token, acuse) va en el 5.º argumento, junto (AND) a la regla del origen.
 */
export async function aplicarCancelacion(
  cfdiId: string,
  data: Record<string, any>,
  version: number,
  origen: 'DIRECTA' | 'PENDIENTE' | 'EXTERNA' = 'DIRECTA',
  cas: Prisma.CfdiWhereInput = {},
  tx?: Prisma.TransactionClient,
): Promise<any | null> {
  const trabajo = async (t: Prisma.TransactionClient) => {
    // El manifiesto cubre globales, cuyo orderId es NULL. UNION evita tomar dos veces una orden.
    const orders = await t.$queryRaw<Array<{ orderId: string }>>`
      SELECT "orderId" FROM "Cfdi" WHERE id = ${cfdiId} AND "orderId" IS NOT NULL
      UNION SELECT "orderId" FROM "CfdiGlobalOrden" WHERE "cfdiId" = ${cfdiId}
      ORDER BY "orderId"
    `
    // Plan 4b (Ruling 4b-R13): TODAS las órdenes antes del primer producto, en una sola llamada, como la sustitución (`:769`).
    // Orden por orden (O1 → sus productos → O2) se cruzaba con la conciliación de Uber: ella retiene O2 y pide el producto que
    // esta cancelación ya tomó con O1 ⇒ 40P01. `orders` ya llega sin repetidos y ordenado (UNION + ORDER BY). Sin negocio: por
    // id, como el bucle de antes — el manifiesto ya está acotado por la factura, y una orden movida de negocio sigue en él.
    const ids = orders.map(o => o.orderId)
    await bloquearOrdenesParaFacturar(t, ids)
    // 🔴 C2-32 (v7): la respuesta del PAC (`PENDIENTE`) sigue el rango explícito: un hecho confirmado sube desde REQUESTED o REJECTED (del
    // intento que pone el CAS); el negativo y el acuse, sólo desde REQUESTED. `DIRECTA` y `EXTERNA`, como antes.
    const cancelWhere: Prisma.CfdiWhereInput =
      origen === 'PENDIENTE'
        ? { cancelStatus: { in: desdeDondeSube((data.cancelStatus ?? 'REQUESTED') as EstadoConRango) } }
        : {
            OR: [
              { cancelStatus: null },
              { cancelStatus: { notIn: origen === 'EXTERNA' ? ['REQUESTED', 'CANCELLED', 'ACCEPTED'] : ['CANCELLED', 'ACCEPTED'] } },
            ],
          }
    const { count } = await t.cfdi.updateMany({
      where: { id: cfdiId, status: 'STAMPED', attempts: version, AND: [cancelWhere, cas] },
      data,
    })
    if (count === 0) return null
    if (data.status === 'CANCELLED' && (data.cancelStatus === 'CANCELLED' || data.cancelStatus === 'ACCEPTED')) {
      await liberarSellosDe(t, cfdiId)
    }
    return t.cfdi.findUnique({ where: { id: cfdiId }, include: { fiscalEmisor: true } })
  }
  return tx ? trabajo(tx) : prisma.$transaction(trabajo)
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
   * C2-26: es `aplicarCancelacion` (una sola firma; el CAS va en el 5.º argumento). 🔴 Sin `tomarEnvio` ni `enviar`: el barrido no envía.
   */
  applyCancelOutcome: typeof aplicarCancelacion
  logAction: (params: LogActionParams) => Promise<void>
  /** C2: el reloj (la ventana de ENVIANDO / EN DUDA / intención abandonada). */
  now: () => Date
  /** C2-28: relee la fila cuando una respuesta atrasada pierde su CAS. */
  loadCfdi?: (cfdiId: string) => Promise<any | null>
  /** Gancho de prueba (C2-28/C2-32): pausa entre la consulta al PAC y la escritura. */
  despuesDeConsultar?: () => Promise<void>
}

/** Por qué una cancelación NO quedó, en palabras del dueño. `null` si sí quedó o sigue en trámite. */
function porQueNoQuedoCancelada(providerStatus: string): string | null {
  switch (providerStatus) {
    case 'none':
      return 'El SAT no tiene la solicitud de cancelación: la factura sigue vigente. Si la sigues necesitando, pídela otra vez.'
    case 'expired':
      return 'La solicitud de cancelación caducó sin respuesta del receptor: la factura sigue vigente. Vuelve a pedirla.'
    case 'rejected':
      return 'El receptor rechazó la cancelación ante el SAT: la factura sigue vigente.'
    default:
      return null
  }
}

/**
 * C2 (v5-v7): SÓLO consulta al PAC (GET, idempotente) y aplica su respuesta con CAS; nunca envía. `cfdi` es la FOTO leída ANTES de
 * consultar (el barrido la trae de su página; `cancelCfdi`, de su relectura).
 */
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
  // 🔴 C2-28 (v6): todo desenlace va con CAS sobre la foto (intento, token y acuse, también cuando eran null). Si alguien guardó un acuse
  // entretanto, el CAS pierde: la respuesta atrasada se ignora y se registra. El estado es monótono: nada baja un acuse guardado.
  const ahora = deps.now()
  const estado = estadoDeCancelacion(cfdi, ahora)
  const intento: number = cfdi.cancelIntento ?? 0
  const enviada = cfdi.cancelEnviadaAt ? new Date(cfdi.cancelEnviadaAt) : null
  const acusada = cfdi.cancelAcusadaAt ? new Date(cfdi.cancelAcusadaAt) : null
  const foto: Prisma.CfdiWhereInput = { cancelIntento: intento, cancelEnviadaAt: enviada, cancelAcusadaAt: acusada }
  const res = await provider.getCancellationStatus(cfdi.facturapiId) // C2-29: también en ENVIANDO (un hecho definitivo nunca se descarta)
  await deps.despuesDeConsultar?.()
  const s = mapProviderCancelStatus(res.status)
  let data: Record<string, any> | null = null
  let cas: Prisma.CfdiWhereInput = foto
  if (s === 'CANCELLED' || s === 'ACCEPTED') {
    // Un hecho: terminal. C2-32 (v7): el escritor lo deja subir desde REQUESTED o REJECTED de ESTE intento (`desdeDondeSube`), así un
    // negativo concurrente del mismo intento (B escribió REJECTED entre la foto y esta respuesta) no le gana.
    data = { status: 'CANCELLED', cancelStatus: s, ...(res.cancelledAt ? { cancelledAt: res.cancelledAt } : {}) }
    cas = { cancelIntento: intento }
  } else if (s === 'REQUESTED') {
    if (!acusada) data = { cancelAcusadaAt: ahora } // acuse (CAS foto: acuse null), también en ENVIANDO
  } else if (estado === 'ENVIANDO') {
    // El POST puede seguir en vuelo: un negativo todavía no dice nada (C2-29: la cautela es sólo contra cierres negativos prematuros).
  } else if (estado === 'ANOTADA') {
    // Nadie puede enviarlo ya sin ganar `tomarEnvio` sobre un REQUESTED: pasada la ventana, la intención abandonada se cierra.
    const anotadaAt = cfdi.cancelRequestedAt ? new Date(cfdi.cancelRequestedAt).getTime() : Number.NEGATIVE_INFINITY
    if (ahora.getTime() - anotadaAt >= INTENCION_ABANDONADA_MS)
      data = {
        cancelStatus: 'REJECTED',
        lastError: 'No se llegó a enviar la cancelación al SAT: la factura sigue vigente. Vuelve a pedirla.',
      }
  } else if (
    estado === 'CANCELACION_EN_DUDA' &&
    (res.status === 'none' || (intento > 1 && (res.status === 'rejected' || res.status === 'expired')))
  ) {
    // 🔴 C2 ronda 2 (N1): nuestro POST se cortó, pero Facturapi pudo seguir procesándolo. Un «sin solicitud» temprano no prueba que no
    // salió: sigue en duda (el barrido la vuelve a consultar cada hora). Sólo pasado `PLAZO_DE_LA_DUDA_MS` se cierra, y queda registrado.
    // C2 · OF-2 (T2 R1): lo mismo con un «rechazada»/«caducada» desde el SEGUNDO intento: el `cancellation_status` del PAC es de la FACTURA,
    // no del intento, así que puede ser la respuesta al intento anterior. Al cerrar, el porqué es el del PAC.
    if (enviada && ahora.getTime() - enviada.getTime() >= PLAZO_DE_LA_DUDA_MS)
      data = {
        cancelStatus: 'REJECTED',
        lastError: res.status === 'none' ? MOTIVO_SIN_SOLICITUD_EN_EL_PLAZO : porQueNoQuedoCancelada(res.status),
      }
  } else {
    // C2-24: el envío ya terminó (en trámite acusado, o EN DUDA) y el PAC dice rechazada o caducada (una respuesta del SAT sobre una
    // solicitud registrada), o un intento ACUSADO ya no aparece: su respuesta manda. Un rechazo confirmado CIERRA el intento; nunca se
    // reenvía. Si hace falta otra, la pide una persona (intento nuevo).
    data = {
      cancelStatus: 'REJECTED',
      lastError: porQueNoQuedoCancelada(res.status) ?? 'El SAT no confirmó la cancelación: la factura sigue vigente.',
    }
  }
  if (!data) return cfdi
  const updated = await deps.applyCancelOutcome(cfdi.id, data, cfdi.attempts, 'PENDIENTE', cas)
  if (!updated) {
    logger.info('[cancelación] respuesta atrasada ignorada: la fila cambió después de la foto', {
      cfdiId: cfdi.id,
      cancelIntento: intento,
      providerStatus: res.status,
      estadoPrevio: estado,
    })
    return (await deps.loadCfdi?.(cfdi.id)) ?? cfdi
  }
  if (data.cancelStatus)
    await deps.logAction({
      staffId: null,
      venueId: cfdi.venueId,
      action: data.status === 'CANCELLED' ? 'CFDI_CANCEL_CONFIRMED' : 'CFDI_CANCEL_NOT_APPLIED',
      entity: 'Cfdi',
      entityId: cfdi.id,
      data: {
        uuid: cfdi.uuid ?? null,
        folio: folioDe(cfdi),
        providerStatus: res.status,
        cancelStatus: data.cancelStatus,
        cancelIntento: intento,
        estadoPrevio: estado,
      },
    })
  return updated
}

/** El barrido y toda consulta: sólo GET + `aplicarCancelacion`. 🔴 Sin `tomarEnvio` ni `enviar` (C2: el barrido no puede enviar). */
export const defaultRefreshDeps: RefreshCancellationDeps = {
  loadEmisor: id => prisma.fiscalEmisor.findUnique({ where: { id } }),
  resolveProvider: resolveFiscalProvider,
  applyCancelOutcome: aplicarCancelacion,
  logAction,
  now: () => new Date(),
  loadCfdi: id => prisma.cfdi.findUnique({ where: { id }, include: { fiscalEmisor: true } }),
}

export interface SincronizarExternaDeps {
  loadEmisor: RefreshCancellationDeps['loadEmisor']
  resolveProvider: RefreshCancellationDeps['resolveProvider']
  /**
   * Marca cancelada SÓLO si sigue timbrada y sin cancelación en trámite (CAS). `null` si alguien ganó.
   * C2: el 4.º argumento es el CAS extra de un POST tardío (la fila local sigue `REJECTED` en el MISMO intento).
   */
  applyExternalCancel: (cfdiId: string, data: Record<string, any>, version: number, cas?: Prisma.CfdiWhereInput) => Promise<any | null>
  logAction: RefreshCancellationDeps['logAction']
}

/**
 * Una factura TIMBRADA que alguien canceló por fuera de Avoqado (p. ej. desde el portal de Facturapi) —
 * el caso A-14, que seguía «Timbrada» aquí. La dispara el webhook; como con las cancelaciones propias, no se
 * le cree al aviso: se le pregunta al PAC. Sólo se escribe si el PAC CONFIRMA la cancelación: un «pendiente»
 * o «sin cancelación» no dice nada de una cancelación que nosotros no pedimos, así que no se toca la fila.
 *
 * C2 (punto 8, lo que se DETECTA): si la fila local está `REJECTED` (nuestro intento ya se cerró) y el PAC dice cancelada o en trámite,
 * es un POST tardío de un dueño que despertó después del cierre: se aplica (CANCELLED, o REQUESTED acusada) y se registra
 * `CFDI_CANCELACION_TARDIA` con el intento y el último motivo. Nunca en silencio.
 */
export async function sincronizarCancelacionExterna(
  cfdi: any,
  opts: { sandbox: boolean },
  deps: SincronizarExternaDeps = defaultExternaDeps,
): Promise<any> {
  if (cfdi.status !== 'STAMPED' || cfdi.cancelStatus === 'REQUESTED' || !cfdi.facturapiId) return cfdi
  const version = cfdi.attempts
  const emisor = cfdi.fiscalEmisor ?? (cfdi.fiscalEmisorId ? await deps.loadEmisor(cfdi.fiscalEmisorId) : null)
  if (!emisor) return cfdi
  const provider = deps.resolveProvider(emisor, { sandbox: opts.sandbox })
  if (typeof provider.getCancellationStatus !== 'function') return cfdi

  const res = await provider.getCancellationStatus(cfdi.facturapiId)
  const cancelStatus = mapProviderCancelStatus(res.status)
  const tardia = cfdi.cancelStatus === 'REJECTED'
  let data: Record<string, any>
  if (cancelStatus === 'CANCELLED' || cancelStatus === 'ACCEPTED')
    data = { status: 'CANCELLED', cancelStatus, ...(res.cancelledAt ? { cancelledAt: res.cancelledAt } : {}) }
  else if (cancelStatus === 'REQUESTED' && tardia)
    data = { cancelStatus: 'REQUESTED', cancelAcusadaAt: new Date(), lastError: null } // ronda 2 (N4)
  else return cfdi

  const updated = await deps.applyExternalCancel(
    cfdi.id,
    data,
    version,
    tardia ? { cancelStatus: 'REJECTED', cancelIntento: cfdi.cancelIntento ?? 0 } : undefined,
  )
  if (!updated) return cfdi

  if (data.status === 'CANCELLED')
    await deps.logAction({
      staffId: null,
      venueId: cfdi.venueId,
      action: 'CFDI_CANCEL_CONFIRMED',
      entity: 'Cfdi',
      entityId: cfdi.id,
      data: { uuid: cfdi.uuid ?? null, folio: folioDe(cfdi), providerStatus: res.status, cancelStatus, origen: 'EXTERNA' },
    })
  if (tardia)
    await deps.logAction({
      staffId: null,
      venueId: cfdi.venueId,
      action: 'CFDI_CANCELACION_TARDIA',
      entity: 'Cfdi',
      entityId: cfdi.id,
      data: {
        uuid: cfdi.uuid ?? null,
        folio: folioDe(cfdi),
        providerStatus: res.status,
        cancelStatus: data.cancelStatus,
        cancelIntento: cfdi.cancelIntento ?? 0,
        lastError: cfdi.lastError ?? null,
      },
    })
  return updated
}

const defaultExternaDeps: SincronizarExternaDeps = {
  loadEmisor: id => prisma.fiscalEmisor.findUnique({ where: { id } }),
  resolveProvider: resolveFiscalProvider,
  applyExternalCancel: (id, data, version, cas) => aplicarCancelacion(id, data, version, 'EXTERNA', cas),
  logAction,
}

/** C2-7: dónde se quedó el barrido (la última fila revisada de una página llena). */
export type CursorDeCancelaciones = { requestedAt: Date; id: string }

/** C2 ronda 2 (N1): los cierres recientes de intentos que SÍ se enviaron; el barrido los vuelve a consultar. */
export type CursorDeCierres = { updatedAt: Date; id: string }
export function dondeBuscarCierresRecientes(desde: Date, cursor?: CursorDeCierres | null): Prisma.CfdiWhereInput {
  // Rechazados (vigentes) cuyo intento SÍ tuvo token (se envió o pudo enviarse) y que no son legado; cerrados (o tocados) desde `desde`.
  return {
    cancelStatus: 'REJECTED',
    status: 'STAMPED',
    cancelIntento: { gt: 0 },
    cancelEnviadaAt: { not: null },
    AND: [
      { updatedAt: { gte: desde } },
      ...(cursor ? [{ OR: [{ updatedAt: { gt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { gt: cursor.id } }] }] : []),
    ],
  }
}

/** C2-7: lo que el barrido busca — en trámite, pedidas antes del corte, después del cursor, en orden (`cancelRequestedAt`, `id`). */
export function dondeBuscarCancelacionesPendientes(cutoff: Date, cursor?: CursorDeCancelaciones | null): Prisma.CfdiWhereInput {
  return {
    cancelStatus: 'REQUESTED',
    AND: [
      { cancelRequestedAt: { lt: cutoff } },
      ...(cursor
        ? [{ OR: [{ cancelRequestedAt: { gt: cursor.requestedAt } }, { cancelRequestedAt: cursor.requestedAt, id: { gt: cursor.id } }] }]
        : []),
    ],
  }
}

export interface SyncPendingCancellationsDeps {
  /** Filas con cancelación en trámite pedida antes de `cutoff`, acotadas, a partir del cursor (orden `cancelRequestedAt`, `id`). */
  findPending: (cutoff: Date, cursor?: CursorDeCancelaciones | null) => Promise<any[]>
  refresh: (cfdi: any) => Promise<any>
  /** C2 ronda 2 (N1): cierres recientes de intentos enviados (`REJECTED`), acotados, desde el cursor (orden `updatedAt`, `id`). */
  findRecentlyClosed?: (desde: Date, cursor?: CursorDeCierres | null) => Promise<any[]>
  /** C2 ronda 2 (N1): vuelve a consultar un cierre reciente (la vía externa/tardía: sólo un hecho o un trámite lo reabre). */
  recheckClosed?: (cfdi: any) => Promise<any>
}

/**
 * El barrido es la RED DE SEGURIDAD: la vía principal es el webhook de Facturapi (facturapiWebhook.service),
 * que avisa en cuanto el SAT resuelve. El barrido sólo mira lo que lleva más de una hora en trámite (si el
 * aviso llegó, ya no queda nada que mirar) y corre una vez por hora, no cada 5 min (decisión del founder,
 * 24-sep-2026). Facturapi no documenta cuántas veces reintenta un aviso que no pudimos recibir.
 */
export const CANCEL_RECHECK_AFTER_MS = 60 * 60_000
/** Cada cuánto corre el barrido de cancelaciones dentro del job de conciliación. */
export const CANCEL_SYNC_EVERY_MS = 60 * 60_000

/** ¿Ya toca otra pasada del barrido? La primera pasada tras arrancar el proceso siempre toca. */
export function tocaRevisarCancelaciones(ultimaPasadaMs: number | null, ahoraMs: number): boolean {
  return ultimaPasadaMs === null || ahoraMs - ultimaPasadaMs >= CANCEL_SYNC_EVERY_MS
}
/** Tope por pasada del barrido (bounded-queries): cada fila es una llamada al PAC. */
export const CANCEL_SYNC_MAX_PER_TICK = 50
/** OF-1 (T2 R3): lo más que dura una pasada del barrido de cancelaciones (las dos fases juntas), con el PAC lento o colgado. */
export const PRESUPUESTO_BARRIDO_CANCELACIONES_MS = 60_000

/**
 * OF-1: dónde sigue una fase del barrido. Página llena o pasada cortada ⇒ después de la última INTENTADA; sin intentar ninguna (se agotó el
 * presupuesto), donde iba; si no, `null` (vuelve al principio).
 */
function siguienteCursor<C>(filas: any[], intentadas: number, anterior: C | null, cursorDe: (fila: any) => C | null): C | null {
  if (filas.length > 0 && intentadas === 0) return anterior
  return filas.length >= CANCEL_SYNC_MAX_PER_TICK || intentadas < filas.length ? cursorDe(filas[intentadas - 1]) : null
}

/**
 * El barrido del job: le pregunta al PAC por cada cancelación en trámite. Un fallo en una fila no
 * detiene a las demás; la que falló se reintenta en la siguiente pasada.
 * C2-7: recorre con cursor `(cancelRequestedAt, id)`, 50 por pasada; con más de 50 en trámite, cada 50 adicionales esperan una pasada
 * más (una hora), pero ninguna se salta. Devuelve el cursor: la última fila revisada si la página vino llena; `null` si no (vuelve al
 * principio). OF-1 (T2 R3): con presupuesto por pasada (`PRESUPUESTO_BARRIDO_CANCELACIONES_MS`); si se corta, la última INTENTADA.
 */
export async function syncPendingCancellations(
  params: { sandbox: boolean; now: Date; cursor?: CursorDeCancelaciones | null; cursorCerradas?: CursorDeCierres | null },
  deps: SyncPendingCancellationsDeps = {
    findPending: (cutoff, cursor) =>
      prisma.cfdi.findMany({
        where: dondeBuscarCancelacionesPendientes(cutoff, cursor),
        orderBy: [{ cancelRequestedAt: 'asc' }, { id: 'asc' }],
        take: CANCEL_SYNC_MAX_PER_TICK,
        include: { fiscalEmisor: true },
        omit: { xmlConceptos: true }, // C2 · T5 ronda 1 (M1)
      }),
    refresh: cfdi => refreshPendingCancellation(cfdi, { sandbox: params.sandbox }),
    findRecentlyClosed: (desde, cursor) =>
      prisma.cfdi.findMany({
        where: dondeBuscarCierresRecientes(desde, cursor),
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: CANCEL_SYNC_MAX_PER_TICK,
        include: { fiscalEmisor: true },
        omit: { xmlConceptos: true }, // C2 · T5 ronda 1 (M1)
      }),
    recheckClosed: cfdi => sincronizarCancelacionExterna(cfdi, { sandbox: params.sandbox }),
  },
): Promise<{
  revisadas: number
  resueltas: number
  siguenEnTramite: number
  errores: number
  cursor: CursorDeCancelaciones | null
  /** C2 ronda 2 (N1): fase de cierres recientes. */
  cierresRevisados?: number
  cursorCerradas?: CursorDeCierres | null
}> {
  // OF-1 (T2 R3): presupuesto de la pasada (las dos fases juntas). Cada consulta espera a lo más lo que quede; la que pierde sigue sola
  // (sólo consulta y aplica con el CAS del intento) y se cuenta como error. Al agotarse no se toman más filas, y el cursor de cada fase
  // queda en la última fila INTENTADA (la siguiente pasada sigue ahí; ninguna se salta). Antes: con el PAC colgado, 50 + 50 consultas de
  // 30 s, ~50 min con `isRunning` del job en `true`.
  const inicio = Date.now()
  const restante = () => PRESUPUESTO_BARRIDO_CANCELACIONES_MS - (Date.now() - inicio)
  const SIN_RESPUESTA = Symbol('sin respuesta a tiempo')
  const consultar = async (trabajo: () => Promise<any>, queda: number) => {
    const r = await conLimiteDeTiempo(trabajo(), queda, () => SIN_RESPUESTA)
    if (r === SIN_RESPUESTA)
      throw new Error(`el PAC no contestó dentro del presupuesto de la pasada (${PRESUPUESTO_BARRIDO_CANCELACIONES_MS} ms)`)
    return r
  }
  const pendientes = await deps.findPending(new Date(params.now.getTime() - CANCEL_RECHECK_AFTER_MS), params.cursor ?? null)
  const tally = {
    revisadas: 0,
    resueltas: 0,
    siguenEnTramite: 0,
    errores: 0,
    cursor: null,
  } as {
    revisadas: number
    resueltas: number
    siguenEnTramite: number
    errores: number
    cursor: CursorDeCancelaciones | null
    cierresRevisados?: number
    cursorCerradas?: CursorDeCierres | null
  }
  for (const cfdi of pendientes) {
    const queda = restante()
    if (queda <= 0) break
    tally.revisadas += 1
    try {
      const r = await consultar(() => deps.refresh(cfdi), queda)
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
  tally.cursor = siguienteCursor(pendientes, tally.revisadas, params.cursor ?? null, f =>
    f.cancelRequestedAt ? { requestedAt: new Date(f.cancelRequestedAt), id: String(f.id) } : null,
  )
  // 🔴 C2 ronda 2 (N1): los cierres recientes de intentos que SÍ se enviaron se vuelven a consultar durante `PLAZO_DE_LA_DUDA_MS` (por
  // la vía externa/tardía: sólo un hecho o un trámite del PAC reabre la fila, con CFDI_CANCELACION_TARDIA). Así un POST cortado que
  // Facturapi terminó después no queda cancelado allá y vigente aquí aunque no llegue el webhook. Sólo GET.
  if (deps.findRecentlyClosed && deps.recheckClosed) {
    const recheck = deps.recheckClosed
    // OF-1: sin presupuesto, esta fase no corre en esta pasada y su cursor se queda donde iba.
    const corre = restante() > 0
    const cerradas = corre
      ? await deps.findRecentlyClosed(new Date(params.now.getTime() - PLAZO_DE_LA_DUDA_MS), params.cursorCerradas ?? null)
      : []
    let intentadas = 0
    for (const cfdi of cerradas) {
      const queda = restante()
      if (queda <= 0) break
      intentadas += 1
      try {
        await consultar(() => recheck(cfdi), queda)
      } catch (err: unknown) {
        tally.errores += 1
        logger.warn(`[cfdi] no se pudo volver a consultar el cierre de ${cfdi.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    tally.cierresRevisados = intentadas
    tally.cursorCerradas = corre
      ? siguienteCursor(cerradas, intentadas, params.cursorCerradas ?? null, f =>
          f.updatedAt ? { updatedAt: new Date(f.updatedAt), id: String(f.id) } : null,
        )
      : (params.cursorCerradas ?? null)
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
  // C2 · T10 (Codex C2-31): el estado de la cancelación derivado en ESTA consulta; las dos fechas de la derivación son internas. Ronda 1
  // (M1): el número de intento (columna nueva de C2) también. `lastError`, `facturapiId` e `idempotencyKey` ya salían: son contrato.
  const { cancelEnviadaAt: _enviada, cancelAcusadaAt: _acusada, cancelIntento: _intento, ...vista } = cfdi
  return { ...vista, estadoCancelacion: estadoDeCancelacion(cfdi, new Date()) }
}

// Real defaults
const defaultStatusDeps: GetCfdiStatusDeps = {
  loadCfdi: id =>
    prisma.cfdi.findUnique({
      where: { id },
      include: {
        replacedBy: { select: { id: true, uuid: true, serie: true, folio: true, status: true }, orderBy: { createdAt: 'desc' }, take: 5 },
      },
      // C2 · T5 ronda 1 (M1): `GET /cfdi/:id` devuelve esta fila; `xmlConceptos` (evidencia interna, ~1 MiB en una global) no sale.
      omit: { xmlConceptos: true },
    }),
}
