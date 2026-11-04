/**
 * «Por cobrar» — pagar, omitir, deshacer y lo que pinta la pantalla (spec 2026-11-02-por-cobrar-superadmin §3.4, §3.5 y §5).
 *
 * - Toda escritura (pagar, omitir, deshacer) corre en UNA transacción corta que antes toma el candado del cobro (`withChargeLock`) y
 *   ahí adentro vuelve a leer la ocurrencia: lo que se decide es lo releído, nunca lo leído antes. Facturapi y el correo NUNCA van
 *   dentro del candado.
 * - `logAction` va siempre DESPUÉS y fuera de la transacción (nunca lanza; si la transacción se deshace no se registra nada). Todo
 *   `PLATFORM_CHARGE_*` cuelga del cobro (`entity: PlatformCharge`) y trae la ocurrencia en `data`. `PLATFORM_CFDI_ISSUED` la escribe
 *   `invoiceOccurrence` al timbrar: aquí no se repite.
 * - Fechas: `dueDate` sale SIEMPRE como texto `YYYY-MM-DD` (un `Date` a medianoche UTC se pintaría un día antes en CDMX), y «hoy» y
 *   «este mes» son los de CDMX (`schedule.ts`). Dinero: centavos enteros.
 * - Capacidad: lecturas con `take`, tope de página impuesto aquí, orden estable (`id` desempata) y tarjetas sumadas en la base. Los filtros de la
 *   lista, su suma y los grupos salen de UN solo armador de `where` (`occurrenceWhere`); agrupar es `groupBy` y `aggregate` en la base, nunca sobre
 *   un recorte ni trayendo las fechas para sumarlas.
 */
import { PlatformChargeFrequency } from '@prisma/client'
import type {
  BillingCustomerType,
  PlatformCfdi,
  PlatformCharge,
  PlatformChargeInvoiceMode,
  PlatformChargeOccurrenceStatus,
  Prisma,
} from '@prisma/client'
import logger from '@/config/logger'
import AppError, { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { formatMoney } from '@/services/shared/receiptLayout/format'
import { PlatformBillingError } from '@/services/superadmin/platform-billing/platformEmisor.service'
import prisma from '@/utils/prismaClient'
import { isCalendarDay, pageParams } from './charges.service'
import { findProfileId, intentKey, invoiceOccurrence, resolverIntento, type ConfirmedReceptor } from './invoice.service'
import type { InvoiceOccurrenceInput } from './invoice.service'
import { withChargeLock } from './lock'
import { addDays, calendarDayToDb, dbToCalendarDay, monthBoundsInMexico, todayInMexico } from './schedule'
import { LIVE_INVOICE_STATUSES, linkedLiveWhere, NEWEST_INVOICE_FIRST, type CalendarDay, type ChargeConcept } from './types'

/** «Próximos 7 días» de las tarjetas: el mismo horizonte con el que el generador crea las fechas (y el de la consulta por MCP). */
export const UPCOMING_DAYS = 7

const VIEW_STATUS: Record<string, PlatformChargeOccurrenceStatus> = { open: 'PENDING', paid: 'PAID', skipped: 'SKIPPED' }

export type OccurrenceViewName = 'open' | 'paid' | 'skipped'
/** Dónde cae una ocurrencia PENDIENTE respecto a hoy (de CDMX). Una pagada u omitida no tiene. */
export type OccurrenceBucket = 'OVERDUE' | 'TODAY' | 'UPCOMING'

/** Lo que la pantalla pinta de la factura de una ocurrencia: la viva y, si no hay, la más reciente. */
export interface OccurrenceInvoiceView {
  id: string
  status: PlatformCfdi['status']
  serie: string | null
  folio: string | null
  uuid: string | null
  totalCents: number
  /** PUE o PPD: la pantalla avisa distinto en cada una. */
  metodoPago: string
  /** Se anexó desde «Facturas CFDI», y por eso se puede quitar. Una timbrada desde «Por cobrar» sólo se cancela. */
  linked: boolean
  /** Por qué falló el último intento (también en una fila STAMPING: el documento pudo quedar en camino). */
  lastError: string | null
  /** `null` = el correo con el PDF y el XML no le ha llegado al cliente. */
  emailSentAt: Date | null
  createdAt: Date
}

export interface OccurrenceView {
  id: string
  chargeId: string
  customerName: string
  frequency: PlatformChargeFrequency
  /** Día de calendario de CDMX, `YYYY-MM-DD`. */
  dueDate: CalendarDay
  concepts: ChargeConcept[]
  subtotalCents: number
  taxCents: number
  totalCents: number
  invoiceMode: PlatformChargeInvoiceMode
  status: PlatformChargeOccurrenceStatus
  paidAt: Date | null
  skippedAt: Date | null
  bucket: OccurrenceBucket | null
  invoice: OccurrenceInvoiceView | null
}

export interface SummaryBucket {
  count: number
  totalCents: number
}

export interface ChargeSummary {
  /** El día de CDMX con el que se hizo el corte. */
  today: CalendarDay
  overdue: SummaryBucket
  dueToday: SummaryBucket
  upcoming: SummaryBucket
  paidThisMonth: SummaryBucket
}

export interface PayPreview {
  customerName: string
  /** De quién es el cobro y qué perfil usaría la factura: SUPERADMIN los necesita para enseñar y corregir sus datos fiscales. */
  customerType: PlatformCharge['customerType']
  organizationId: string | null
  venueId: string | null
  billingTaxProfileId: string | null
  concepts: ChargeConcept[]
  subtotalCents: number
  taxCents: number
  totalCents: number
  /** La casilla «Timbrar factura ahora» sale marcada: sólo en AUTOMATIC. MANUAL y NONE (sin factura) salen sin marcar. */
  willInvoice: boolean
  /** A quién se le timbraría; `null` si no hay datos fiscales con qué hacerlo. Regresa en `pay`: sólo se timbra lo que se vio. */
  receptor: ConfirmedReceptor | null
  /** Facturas PPD ya timbradas del receptor que todavía no se liquidan en «Facturas CFDI». */
  pendingPpdCount: number
  /** La factura anexada y viva de esta fecha: la pantalla la enseña en vez de ofrecer timbrar. */
  linkedInvoice: OccurrenceInvoiceView | null
}

export type PayInvoiceResult = { ok: true; cfdi: PlatformCfdi } | { ok: false; message: string; code: string; field?: string }

export interface PayResult {
  occurrence: OccurrenceView
  /** `null` = no se pidió factura, o la ocurrencia ya estaba pagada (repetir no vuelve a facturar). */
  invoice: PayInvoiceResult | null
}

/**
 * Cómo está la factura de una fecha, en cuatro categorías que NO se traslapan y no dejan fuera a nadie (en este orden): `STAMPED` tiene una factura
 * timbrada o con la cancelación en trámite; `PROBLEM`, si no, tiene un intento en camino o fallido; `NONE`, si no, es un cobro sin factura; `PENDING`
 * es el resto (por facturar, o con facturas ya canceladas).
 */
export type InvoiceCategory = 'STAMPED' | 'PROBLEM' | 'PENDING' | 'NONE'
export type OccurrenceGroupBy = 'customer' | 'month' | 'frequency' | 'invoice'

/** Lo que filtra la lista, su suma y los grupos: siempre el mismo `where`. Los arreglos vacíos no filtran. */
export interface OccurrenceFilters {
  view?: OccurrenceViewName
  /** Búsqueda por nombre del cliente (contiene, sin importar mayúsculas). */
  q?: string
  frequency?: PlatformChargeFrequency[]
  invoice?: InvoiceCategory[]
  customerType?: BillingCustomerType[]
  /** Fecha de cobro desde / hasta, días de calendario `AAAA-MM-DD`, los dos extremos incluidos. */
  from?: CalendarDay
  to?: CalendarDay
  /** Nombre EXACTO del cliente (el de un grupo de «Agrupar por cliente»). */
  customer?: string
}

export interface ListOccurrencesFilters extends OccurrenceFilters {
  page?: number
  pageSize?: number
}

export interface OccurrenceGroup {
  /** Qué identifica al grupo (para filtrar o repintar): el cliente, el mes `AAAA-MM`, la periodicidad o la categoría de factura. */
  key: string
  label: string
  count: number
  totalCents: number
}

// ── Errores y textos ────────────────────────────────────────────────────────────────────────────────────────────────────────

const occurrenceNotFound = () =>
  new NotFoundError('Esta fecha de cobro ya no existe porque el cobro se editó: revisa la lista', 'PLATFORM_CHARGE_OCCURRENCE_NOT_FOUND')
const conflict = (message: string, code: string) => new ConflictError(message, code)

/** «la factura A-118», o «la factura» si aún no tiene serie y folio. */
export const invoiceName = (row: Pick<PlatformCfdi, 'serie' | 'folio'>): string => {
  const id = [row.serie, row.folio].filter(Boolean).join('-')
  return id ? `la factura ${id}` : 'la factura'
}

/** Por qué una factura de esta ocurrencia impide deshacerla (la viva que regresó `resolverIntento`, o la que apareció bajo el candado). */
function blockedByInvoice(row: Pick<PlatformCfdi, 'status' | 'serie' | 'folio'>): ConflictError {
  if (row.status === 'STAMPED') return conflict(`Cancela primero ${invoiceName(row)} en Facturas CFDI`, 'PLATFORM_CHARGE_HAS_INVOICE')
  if (row.status === 'CANCEL_REQUESTED') {
    return conflict(
      `La cancelación de ${invoiceName(row)} sigue en trámite ante el SAT; consulta de nuevo más tarde`,
      'PLATFORM_CHARGE_CANCELLATION_PENDING',
    )
  }
  return conflict(
    'Hay un intento de factura en proceso para este cobro; consulta su estado antes de deshacerlo',
    'PLATFORM_CHARGE_INVOICE_STAMPING',
  )
}

// ── La ocurrencia como la ve la pantalla ────────────────────────────────────────────────────────────────────────────────────

/** Lo que se lee de una factura para la vista. */
const INVOICE_VIEW_SELECT = {
  id: true,
  status: true,
  serie: true,
  folio: true,
  uuid: true,
  totalCents: true,
  metodoPago: true,
  chargeLinkedAt: true,
  lastError: true,
  emailSentAt: true,
  createdAt: true,
} satisfies Prisma.PlatformCfdiSelect

/** El cobro y SU factura más reciente (una sola por ocurrencia: `take: 1` por la más nueva, `id` desempata). La viva sale aparte: `liveInvoicesOf`. */
const VIEW_INCLUDE = {
  charge: { select: { customerName: true, frequency: true } },
  invoices: { orderBy: NEWEST_INVOICE_FIRST, take: 1, select: INVOICE_VIEW_SELECT },
} satisfies Prisma.PlatformChargeOccurrenceInclude

type OccurrenceRow = Prisma.PlatformChargeOccurrenceGetPayload<{ include: typeof VIEW_INCLUDE }>
type InvoiceRow = Prisma.PlatformCfdiGetPayload<{ select: typeof INVOICE_VIEW_SELECT }>

/**
 * 🔴 La factura VIVA de cada fecha, de UNA consulta aparte y acotada a la página. Una anexada es más vieja que un intento fallido o una
 * cancelada, así que no siempre es la que trae la relación; agrandar su `take` sólo movería el problema. Una por fecha (`distinct`): varias
 * vivas no deberían existir y, si existen, gana la más nueva sin quitarle su lugar a otra fecha de la página.
 */
async function liveInvoicesOf(occurrenceIds: string[]): Promise<Map<string, InvoiceRow>> {
  if (occurrenceIds.length === 0) return new Map()
  const rows = await prisma.platformCfdi.findMany({
    where: { platformChargeOccurrenceId: { in: occurrenceIds }, status: { in: LIVE_INVOICE_STATUSES } },
    orderBy: NEWEST_INVOICE_FIRST,
    distinct: ['platformChargeOccurrenceId'],
    take: occurrenceIds.length,
    select: { ...INVOICE_VIEW_SELECT, platformChargeOccurrenceId: true },
  })
  return new Map(rows.map(row => [row.platformChargeOccurrenceId as string, row]))
}

function invoiceView(invoice: InvoiceRow): OccurrenceInvoiceView {
  return {
    id: invoice.id,
    status: invoice.status,
    serie: invoice.serie,
    folio: invoice.folio,
    uuid: invoice.uuid,
    totalCents: invoice.totalCents,
    metodoPago: invoice.metodoPago,
    linked: invoice.chargeLinkedAt !== null,
    lastError: invoice.lastError,
    emailSentAt: invoice.emailSentAt,
    createdAt: invoice.createdAt,
  }
}

const conceptsOf = (json: Prisma.JsonValue): ChargeConcept[] => (Array.isArray(json) ? (json as unknown as ChargeConcept[]) : [])

/** 'YYYY-MM-DD' con ceros a la izquierda se ordena como el calendario: comparar los textos es comparar los días. */
function bucketOf(status: PlatformChargeOccurrenceStatus, dueDate: CalendarDay, today: CalendarDay): OccurrenceBucket | null {
  if (status !== 'PENDING') return null
  return dueDate < today ? 'OVERDUE' : dueDate === today ? 'TODAY' : 'UPCOMING'
}

function toView(row: OccurrenceRow, today: CalendarDay, live: InvoiceRow | undefined): OccurrenceView {
  const dueDate = dbToCalendarDay(row.dueDate)
  const invoice = live ?? row.invoices[0]
  return {
    id: row.id,
    chargeId: row.chargeId,
    customerName: row.charge.customerName,
    frequency: row.charge.frequency,
    dueDate,
    concepts: conceptsOf(row.concepts),
    subtotalCents: row.subtotalCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    invoiceMode: row.invoiceMode,
    status: row.status,
    paidAt: row.paidAt,
    skippedAt: row.skippedAt,
    bucket: bucketOf(row.status, dueDate, today),
    invoice: invoice ? invoiceView(invoice) : null,
  }
}

export async function viewOf(id: string, now: Date): Promise<OccurrenceView> {
  const row = await prisma.platformChargeOccurrence.findUnique({ where: { id }, include: VIEW_INCLUDE })
  if (!row) throw occurrenceNotFound()
  const live = await liveInvoicesOf([id])
  return toView(row, todayInMexico(now), live.get(id))
}

// ── Lo que comparten las tres escrituras ────────────────────────────────────────────────────────────────────────────────────

/** De qué cobro es la ocurrencia (y cómo está): se lee SIN candado sólo para saber cuál tomar; la decisión se relee adentro. */
export async function probe(id: string) {
  const row = await prisma.platformChargeOccurrence.findUnique({ where: { id }, select: { chargeId: true, status: true } })
  if (!row) throw occurrenceNotFound()
  return row
}

const LOCKED_INCLUDE = {
  charge: { select: { venueId: true, organizationId: true, invoiceMode: true } },
} satisfies Prisma.PlatformChargeOccurrenceInclude

/** Bajo el candado: la ocurrencia como está AHORA, con lo que la bitácora y «Deshacer» necesitan del cobro. */
export async function readLocked(tx: Prisma.TransactionClient, id: string) {
  const row = await tx.platformChargeOccurrence.findUnique({ where: { id }, include: LOCKED_INCLUDE })
  if (!row) throw occurrenceNotFound()
  return row
}

/** Una entrada de la bitácora del cobro, con quien lo pidió, el negocio y la organización. Siempre FUERA del candado. */
export function audit(
  action: string,
  actorId: string,
  chargeId: string,
  charge: { venueId: string | null; organizationId: string | null },
  data: Prisma.InputJsonObject,
): void {
  void logAction({
    staffId: actorId,
    venueId: charge.venueId,
    organizationId: charge.organizationId,
    action,
    entity: 'PlatformCharge',
    entityId: chargeId,
    data,
  })
}

// ── Pagar ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Lo que falló al facturar, ya en la forma que la respuesta de «Ya me pagó» entrega: el cobro sigue pagado. */
function invoiceFailure(error: unknown, occurrenceId: string): Extract<PayInvoiceResult, { ok: false }> {
  if (error instanceof PlatformBillingError) {
    return { ok: false, message: error.message, code: error.code, ...(error.field ? { field: error.field } : {}) }
  }
  if (error instanceof AppError) return { ok: false, message: error.message, code: error.code ?? 'ERROR' }
  // Algo que no es de negocio (se cayó la base, un bug): el detalle queda en el log y no se le cuela al operador.
  logger.error('[platform-charges] «Ya me pagó» con factura falló por un error inesperado; la ocurrencia sigue pagada', {
    platformChargeOccurrenceId: occurrenceId,
    error: error instanceof Error ? error.message : String(error),
  })
  return {
    ok: false,
    message: 'No se pudo facturar por un error inesperado; el cobro sigue pagado. Intenta de nuevo con «Facturar»',
    code: 'UNEXPECTED',
  }
}

/**
 * «Ya me pagó» (spec §3.5): `PENDING → PAID` bajo el candado. Repetirlo sobre una ya pagada contesta éxito y no vuelve a facturar
 * (dos pestañas: una marca, la otra ve «ya pagado»); sobre una omitida es 409. Sin la casilla «Timbrar factura ahora» (`invoice:
 * false`), una ocurrencia AUTOMÁTICA queda MANUAL: no vuelve a aparecer como una factura automática que falló.
 *
 * 🔴 `expectedTotalCents` es el total que el operador vio al confirmar: si viene y ya no es el de la fecha (otra pestaña anexó una factura de otro
 * monto), es 409 `PLATFORM_CHARGE_OCCURRENCE_TOTAL_CHANGED` y no se marca nada: nadie da por recibido un importe que no confirmó. Se compara bajo el
 * candado, DESPUÉS de «omitida» y de «pagada» (repetir sobre una pagada sigue siendo éxito). Sin el campo, se paga lo que haya (clientes viejos).
 *
 * Con `invoice: true`, DESPUÉS de marcarla (y fuera del candado) llama a `invoiceOccurrence` y atrapa su error: el cobro SIGUE
 * pagado y la respuesta trae `invoice: { ok: false, message, code, field? }`. Un proceso que muere en medio deja «Pagado · sin
 * factura», con su botón «Facturar».
 */
export async function payOccurrence(
  id: string,
  input: { invoice: boolean; receptor?: ConfirmedReceptor; expectedTotalCents?: number },
  actorId: string,
  now: Date = new Date(),
): Promise<PayResult> {
  const { chargeId } = await probe(id)

  const paid = await withChargeLock(chargeId, async tx => {
    const row = await readLocked(tx, id)
    if (row.status === 'SKIPPED') {
      throw conflict('Este cobro está omitido; deshazlo para poder marcarlo como pagado', 'PLATFORM_CHARGE_OCCURRENCE_SKIPPED')
    }
    if (row.status === 'PAID') return null // repetir: éxito, sin volver a escribir ni a facturar
    if (input.expectedTotalCents !== undefined && input.expectedTotalCents !== row.totalCents) {
      throw conflict(
        `El monto de este cobro cambió a ${formatMoney(row.totalCents)}; revísalo y confirma otra vez`,
        'PLATFORM_CHARGE_OCCURRENCE_TOTAL_CHANGED',
      )
    }
    const becomesManual = !input.invoice && row.invoiceMode === 'AUTOMATIC'
    const updated = await tx.platformChargeOccurrence.update({
      where: { id },
      data: { status: 'PAID', paidAt: now, paidById: actorId, ...(becomesManual ? { invoiceMode: 'MANUAL' as const } : {}) },
    })
    return { updated, charge: row.charge }
  })

  if (paid) {
    audit('PLATFORM_CHARGE_PAID', actorId, chargeId, paid.charge, {
      occurrenceId: id,
      dueDate: dbToCalendarDay(paid.updated.dueDate),
      totalCents: paid.updated.totalCents,
      invoice: input.invoice,
      invoiceMode: paid.updated.invoiceMode,
    })
  }

  let invoice: PayInvoiceResult | null = null
  if (paid && input.invoice) {
    try {
      invoice = { ok: true, cfdi: await invoiceOccurrence(id, { actorId, receptor: input.receptor }) }
    } catch (error) {
      invoice = invoiceFailure(error, id)
    }
  }
  return { occurrence: await viewOf(id, now), invoice }
}

// ── Omitir y deshacer ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * «Omitir» (spec §3.5): `PENDING → SKIPPED`. Sobre una pagada es 409; repetirlo sobre una ya omitida contesta éxito sin escribir.
 * 🔴 Con una factura ANEXADA viva también es 409: omitir escondería de la lista una factura real que alguien debe, y después «Deshacer» pide
 * quitarla (un callejón). Una timbrada desde «Por cobrar» se comporta como siempre.
 */
export async function skipOccurrence(id: string, actorId: string, now: Date = new Date()): Promise<OccurrenceView> {
  const { chargeId } = await probe(id)

  const skipped = await withChargeLock(chargeId, async tx => {
    const row = await readLocked(tx, id)
    if (row.status === 'SKIPPED') return null
    if (row.status === 'PAID') {
      throw conflict('Este cobro ya está marcado como pagado; deshazlo antes de omitirlo', 'PLATFORM_CHARGE_OCCURRENCE_PAID')
    }
    // Dentro del candado: otra pestaña pudo anexarla después de que se leyó la lista.
    const linked = await tx.platformCfdi.findFirst({
      where: linkedLiveWhere(id),
      orderBy: NEWEST_INVOICE_FIRST,
      select: { serie: true, folio: true },
    })
    if (linked) {
      throw conflict(`Esta fecha tiene anexada ${invoiceName(linked)}; quítala antes de omitirla`, 'PLATFORM_CHARGE_INVOICE_LINKED')
    }
    const updated = await tx.platformChargeOccurrence.update({
      where: { id },
      data: { status: 'SKIPPED', skippedAt: now, skippedById: actorId },
    })
    return { updated, charge: row.charge }
  })

  if (skipped) {
    audit('PLATFORM_CHARGE_SKIPPED', actorId, chargeId, skipped.charge, {
      occurrenceId: id,
      dueDate: dbToCalendarDay(skipped.updated.dueDate),
      totalCents: skipped.updated.totalCents,
    })
  }
  return viewOf(id, now)
}

/**
 * «Deshacer» (spec §3.5): `PAID | SKIPPED → PENDING`. Primero resuelve el intento de factura con el PAC (`resolverIntento`: puede
 * adoptar o cerrar un intento, o decir 409 «se está timbrando», «la cancelación sigue en trámite»…) y DESPUÉS, bajo el candado,
 * comprueba que no haya ninguna fila con la llave ACTUAL (la que resolverIntento pudo haber subido): con una factura viva o en
 * proceso es 409 «Cancela primero la factura A-118 en Facturas CFDI». Si «Facturar» reservó primero, aquí se ve su fila; si éste va
 * primero, la reserva ve PENDING y no timbra (`reserveCheck`). Con una factura ANEXADA viva, que tiene otra llave, es 409 «Quita primero
 * la factura A-19»: se puede quitar y no hace falta cancelarla.
 *
 * Limpia el pago y la omisión (`paidAt`, `paidById`, `skippedAt`, `skippedById`) y regresa la ocurrencia al modo de factura del
 * cobro. Repetirlo sobre una ya pendiente contesta éxito.
 */
export async function reopenOccurrence(id: string, actorId: string, now: Date = new Date()): Promise<OccurrenceView> {
  const { chargeId, status } = await probe(id)
  if (status === 'PENDING') return viewOf(id, now) // nada que deshacer

  const attempt = await resolverIntento(id, actorId)
  if (attempt.kind === 'LIVE') throw blockedByInvoice(attempt.cfdi)

  const reopened = await withChargeLock(chargeId, async tx => {
    const row = await readLocked(tx, id)
    if (row.status === 'PENDING') return null // otra pestaña ya la deshizo
    // La llave sale del invoiceSeq RELEÍDO: si resolverIntento cerró un intento, la actual es la siguiente.
    const clash = await tx.platformCfdi.findUnique({
      where: { idempotencyKey: intentKey(row) },
      select: { status: true, serie: true, folio: true },
    })
    if (clash) throw blockedByInvoice(clash)
    // 🔴 Dentro del candado: otra pestaña pudo anexarla mientras se le preguntaba al PAC.
    const linked = await tx.platformCfdi.findFirst({
      where: linkedLiveWhere(id),
      orderBy: NEWEST_INVOICE_FIRST,
      select: { serie: true, folio: true },
    })
    if (linked) throw conflict(`Quita primero ${invoiceName(linked)}`, 'PLATFORM_CHARGE_INVOICE_LINKED')
    const updated = await tx.platformChargeOccurrence.update({
      where: { id },
      // El modo también se deshace: «Ya me pagó» sin la casilla pudo haberla vuelto manual.
      data: { status: 'PENDING', paidAt: null, paidById: null, skippedAt: null, skippedById: null, invoiceMode: row.charge.invoiceMode },
    })
    return { previousStatus: row.status, updated, charge: row.charge }
  })

  if (reopened) {
    audit('PLATFORM_CHARGE_REOPENED', actorId, chargeId, reopened.charge, {
      occurrenceId: id,
      dueDate: dbToCalendarDay(reopened.updated.dueDate),
      previousStatus: reopened.previousStatus,
    })
  }
  return viewOf(id, now)
}

// ── Factura desde la fila pagada ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `POST /occurrences/:id/invoice`: «Facturar», reintentar o «Consultar estado» (spec §6). Toda la lógica fiscal es de
 * `invoiceOccurrence`; aquí sólo se le agrega la ocurrencia ya con su factura para que la pantalla se repinte. Sus errores salen
 * tal cual (409 «se está timbrando», 422 de datos fiscales, 502 del PAC…): el controlador los traduce.
 */
export async function invoiceOccurrenceView(
  id: string,
  input: InvoiceOccurrenceInput,
  now: Date = new Date(),
): Promise<{ occurrence: OccurrenceView; cfdi: PlatformCfdi }> {
  const cfdi = await invoiceOccurrence(id, input)
  return { occurrence: await viewOf(id, now), cfdi }
}

// ── Filtros: un solo armador de where ────────────────────────────────────────────────────────────────────────────────────────

const STAMPED_STATUSES: PlatformCfdi['status'][] = ['STAMPED', 'CANCEL_REQUESTED']
const PROBLEM_STATUSES: PlatformCfdi['status'][] = ['STAMPING', 'STAMP_FAILED']
const hasInvoice = (statuses: PlatformCfdi['status'][]): Prisma.PlatformChargeOccurrenceWhereInput => ({
  invoices: { some: { status: { in: statuses } } },
})
const lacksInvoice = (statuses: PlatformCfdi['status'][]): Prisma.PlatformChargeOccurrenceWhereInput => ({
  invoices: { none: { status: { in: statuses } } },
})

/**
 * 🔴 El `where` de UNA categoría de factura, y el único: el filtro de la lista (varias se unen con OR) y los grupos usan esta misma función, así que
 * una fecha nunca cuenta en dos categorías ni en ninguna. El orden de las reglas es el de `InvoiceCategory`: lo timbrado manda sobre un intento en
 * camino, y éste sobre el modo del cobro. Una factura cancelada o en borrador no cuenta como factura.
 */
export function invoiceCategoryWhere(category: InvoiceCategory): Prisma.PlatformChargeOccurrenceWhereInput {
  const withoutInvoice = lacksInvoice([...STAMPED_STATUSES, ...PROBLEM_STATUSES])
  switch (category) {
    case 'STAMPED':
      return hasInvoice(STAMPED_STATUSES)
    case 'PROBLEM':
      return { AND: [lacksInvoice(STAMPED_STATUSES), hasInvoice(PROBLEM_STATUSES)] }
    case 'NONE':
      return { AND: [withoutInvoice, { invoiceMode: 'NONE' }] }
    case 'PENDING':
      return { AND: [withoutInvoice, { invoiceMode: { not: 'NONE' } }] }
  }
}

/**
 * El `where` de la vista y todos sus filtros. La búsqueda por nombre, la periodicidad y el tipo de cliente comparten UN filtro del cobro; el nombre
 * exacto y la factura van en `AND` para no pisar a los demás. Fechas: días de calendario sobre `dueDate` (columna `@db.Date`, sin zona), con los dos
 * extremos incluidos; un día que no existe o «desde» después de «hasta» es 400.
 */
export function occurrenceWhere(filters: OccurrenceFilters): Prisma.PlatformChargeOccurrenceWhereInput {
  const view = filters.view ?? 'open'
  // `hasOwnProperty`: «constructor» o «toString» no son vistas (el objeto los hereda).
  if (!Object.prototype.hasOwnProperty.call(VIEW_STATUS, view)) {
    throw new BadRequestError('Elige una vista válida: pendientes, pagados u omitidos', 'PLATFORM_CHARGE_INVALID_VIEW')
  }
  const where: Prisma.PlatformChargeOccurrenceWhereInput = { status: VIEW_STATUS[view] }

  const charge: Prisma.PlatformChargeWhereInput = {}
  const term = (filters.q ?? '').trim()
  if (term) charge.customerName = { contains: term, mode: 'insensitive' }
  if (filters.frequency?.length) charge.frequency = { in: filters.frequency }
  if (filters.customerType?.length) charge.customerType = { in: filters.customerType }
  if (Object.keys(charge).length > 0) where.charge = charge

  const and: Prisma.PlatformChargeOccurrenceWhereInput[] = []
  const customer = (filters.customer ?? '').trim()
  if (customer) and.push({ charge: { customerName: customer } })
  if (filters.invoice?.length) and.push({ OR: filters.invoice.map(invoiceCategoryWhere) })
  if (and.length > 0) where.AND = and

  const from = (filters.from ?? '').trim()
  const to = (filters.to ?? '').trim()
  for (const day of [from, to]) {
    if (day && !isCalendarDay(day)) {
      throw new BadRequestError('Las fechas deben ser días válidos con el formato AAAA-MM-DD', 'PLATFORM_CHARGE_INVALID_DATE')
    }
  }
  // 'YYYY-MM-DD' con ceros a la izquierda se ordena como el calendario: comparar los textos es comparar los días.
  if (from && to && from > to) {
    throw new BadRequestError('La fecha inicial no puede ser después de la final', 'PLATFORM_CHARGE_INVALID_DATE_RANGE')
  }
  if (from || to) where.dueDate = { ...(from ? { gte: calendarDayToDb(from) } : {}), ...(to ? { lte: calendarDayToDb(to) } : {}) }
  return where
}

// ── Agrupar ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo más que se lee al agrupar por cliente o por mes (un renglón por cobro, o por día de cobro). 🔴 Si hay más, NO se suma nada: la respuesta es
 * `{ groups: [], truncated: true }`. Un grupo hecho con un recorte mostraría menos que lo que trae su clic (5,001 cobros de un cliente, un grupo de 5,000).
 */
export const MAX_GROUP_ROWS = 5000

const MONTH_NAMES_ES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
]
const GROUP_BY = new Set<string>(['customer', 'month', 'frequency', 'invoice'])
// Las etiquetas van en un `Record` tipado y los grupos salen de ahí o del enum: un valor nuevo no se omite en silencio (el total sumaría de menos),
// el compilador pide su etiqueta.
const FREQUENCY_LABELS: Record<PlatformChargeFrequency, string> = {
  WEEKLY: 'Semanal',
  BIWEEKLY: 'Quincenal',
  MONTHLY: 'Mensual',
  ONE_TIME: 'Una sola vez',
}
const INVOICE_LABELS: Record<InvoiceCategory, string> = {
  STAMPED: 'Facturado',
  PROBLEM: 'Con problema',
  PENDING: 'Por facturar',
  NONE: 'Sin factura',
}

type GroupResult = { groups: OccurrenceGroup[]; truncated: boolean }

/** Un `aggregate` por categoría (pocas y fijas), cada uno con el `where` del filtro Y el de la categoría. Sólo salen las que tienen cobros. */
async function groupByCategory(
  where: Prisma.PlatformChargeOccurrenceWhereInput,
  categories: { key: string; label: string; where: Prisma.PlatformChargeOccurrenceWhereInput }[],
): Promise<GroupResult> {
  const sums = await Promise.all(
    categories.map(category =>
      prisma.platformChargeOccurrence.aggregate({
        where: { AND: [where, category.where] },
        _count: { _all: true },
        _sum: { totalCents: true },
      }),
    ),
  )
  const groups = categories
    .map(({ key, label }, i) => ({ key, label, count: sums[i]._count._all, totalCents: sums[i]._sum.totalCents ?? 0 }))
    .filter(group => group.count > 0)
  return { groups, truncated: false }
}

/**
 * Por cliente: un `groupBy` por cobro y, aparte, el nombre de ESOS cobros en una sola lectura acotada a ellos. 🔴 La llave y la etiqueta del grupo son
 * `customerName`, el mismo criterio que el filtro `customer` (nombre exacto): dos cobros con el mismo nombre se suman en un grupo, y el clic en un grupo
 * (filtrar por esa llave) enseña exactamente lo que el grupo sumó.
 */
async function groupByCustomer(where: Prisma.PlatformChargeOccurrenceWhereInput): Promise<GroupResult> {
  const rows = await prisma.platformChargeOccurrence.groupBy({
    by: ['chargeId'],
    where,
    _count: { _all: true },
    _sum: { totalCents: true },
    orderBy: { chargeId: 'asc' },
    take: MAX_GROUP_ROWS + 1,
  })
  if (rows.length > MAX_GROUP_ROWS) return { groups: [], truncated: true }
  if (rows.length === 0) return { groups: [], truncated: false }

  const charges = await prisma.platformCharge.findMany({
    where: { id: { in: rows.map(row => row.chargeId) } },
    select: { id: true, customerName: true },
    take: rows.length,
  })
  const nameOf = new Map(charges.map(charge => [charge.id, charge.customerName]))

  const groups = new Map<string, OccurrenceGroup>()
  for (const row of rows) {
    // Un cobro con fechas no se puede borrar (`Restrict`); si aun así faltara, su dinero cuenta aparte en vez de perderse.
    const name = nameOf.get(row.chargeId)
    const key = name ?? `CHARGE:${row.chargeId}`
    const group = groups.get(key) ?? { key, label: name ?? 'Cobro que ya no existe', count: 0, totalCents: 0 }
    group.count += row._count._all
    group.totalCents += row._sum.totalCents ?? 0
    groups.set(key, group)
  }
  const sorted = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'es') || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { groups: sorted, truncated: false }
}

/**
 * Por mes: un `groupBy` por fecha de cobro (tiene tope natural: un renglón por día con cobros) y los días se juntan por mes aquí, de más viejo a
 * más nuevo. Es una columna `@db.Date` sin zona: el día 1 y el último de cada mes caen en su mes. No es un `date_trunc` en SQL porque el `where` de los
 * filtros (relaciones con el cobro y las facturas) no se puede repetir en SQL a mano sin duplicarlo.
 */
async function groupByMonth(where: Prisma.PlatformChargeOccurrenceWhereInput): Promise<GroupResult> {
  const rows = await prisma.platformChargeOccurrence.groupBy({
    by: ['dueDate'],
    where,
    _count: { _all: true },
    _sum: { totalCents: true },
    orderBy: { dueDate: 'asc' },
    take: MAX_GROUP_ROWS + 1,
  })
  if (rows.length > MAX_GROUP_ROWS) return { groups: [], truncated: true }
  const months = new Map<string, OccurrenceGroup>()
  for (const row of rows) {
    const key = dbToCalendarDay(row.dueDate).slice(0, 7)
    const group = months.get(key) ?? {
      key,
      label: `${MONTH_NAMES_ES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`,
      count: 0,
      totalCents: 0,
    }
    group.count += row._count._all
    group.totalCents += row._sum.totalCents ?? 0
    months.set(key, group)
  }
  return { groups: [...months.values()], truncated: false }
}

/**
 * `GET /occurrences/groups`: cuántos cobros y cuánto suman, por cliente, mes, periodicidad o factura, con LOS MISMOS filtros que la lista. 🔴 Todo se agrupa en
 * la base: nunca sobre un recorte ni trayendo las fechas para sumarlas. Por cliente y por mes se lee hasta `MAX_GROUP_ROWS` renglones y, si hay
 * más, no se devuelve ningún grupo y `truncated` lo dice (la lista y su suma siguen contando todo).
 */
export async function groupOccurrences(filters: OccurrenceFilters, groupBy: OccurrenceGroupBy): Promise<GroupResult> {
  if (!GROUP_BY.has(groupBy)) {
    throw new BadRequestError('Elige cómo agrupar: por cliente, mes, periodicidad o factura', 'PLATFORM_CHARGE_INVALID_GROUP_BY')
  }
  const where = occurrenceWhere(filters)
  switch (groupBy) {
    case 'customer':
      return groupByCustomer(where)
    case 'month':
      return groupByMonth(where)
    case 'frequency':
      return groupByCategory(
        where,
        Object.values(PlatformChargeFrequency).map(key => ({ key, label: FREQUENCY_LABELS[key], where: { charge: { frequency: key } } })),
      )
    case 'invoice':
      return groupByCategory(
        where,
        (Object.keys(INVOICE_LABELS) as InvoiceCategory[]).map(key => ({
          key,
          label: INVOICE_LABELS[key],
          where: invoiceCategoryWhere(key),
        })),
      )
  }
}

// ── Lecturas de la pantalla ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Cuántas facturas PPD ya timbradas del receptor siguen sin liquidar en «Facturas CFDI». Se cuenta en la base, nunca en memoria. */
function countPendingPpd(billingTaxProfileId: string): Promise<number> {
  return prisma.platformCfdi.count({
    where: {
      billingTaxProfileId,
      type: 'INGRESO',
      metodoPago: 'PPD',
      // Una cancelación en trámite sigue vigente: mientras el SAT no la acepte, esa factura se debe.
      status: { in: ['STAMPED', 'CANCEL_REQUESTED'] },
      amountPaidCents: { lt: prisma.platformCfdi.fields.totalCents },
    },
  })
}

/**
 * Lo que el diálogo «Ya me pagó» enseña (spec §3.5): receptor, conceptos y total de la FOTO de la ocurrencia, si la casilla «Timbrar
 * factura ahora» sale marcada y cuántas facturas PPD sin liquidar tiene el receptor. 🔴 Con PPD pendientes NO se timbra aunque la
 * ocurrencia sea automática («si una es de este periodo, no timbres otra y registra el pago allá»); sin receptor tampoco, porque no
 * habría a quién timbrarle; con una factura anexada viva tampoco: ya la tiene, y viene en `linkedInvoice`.
 */
export async function payPreview(occurrenceId: string): Promise<PayPreview> {
  const row = await prisma.platformChargeOccurrence.findUnique({ where: { id: occurrenceId }, include: { charge: true } })
  if (!row) throw occurrenceNotFound()

  const profileId = await findProfileId(row.charge)
  const profile = profileId
    ? await prisma.billingTaxProfile.findUnique({
        where: { id: profileId },
        select: { rfc: true, razonSocial: true, regimenFiscal: true, codigoPostal: true },
      })
    : null
  const pendingPpdCount = profile && profileId ? await countPendingPpd(profileId) : 0
  const linked = await prisma.platformCfdi.findFirst({
    where: linkedLiveWhere(occurrenceId),
    orderBy: NEWEST_INVOICE_FIRST,
    select: INVOICE_VIEW_SELECT,
  })

  return {
    customerName: row.charge.customerName,
    customerType: row.charge.customerType,
    organizationId: row.charge.organizationId,
    venueId: row.charge.venueId,
    billingTaxProfileId: profile ? profileId : null,
    concepts: conceptsOf(row.concepts),
    subtotalCents: row.subtotalCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    willInvoice: !linked && row.invoiceMode === 'AUTOMATIC' && profile !== null && pendingPpdCount === 0,
    receptor: profile,
    pendingPpdCount,
    linkedInvoice: linked ? invoiceView(linked) : null,
  }
}

/**
 * Las tarjetas de la pantalla (spec §5), sumadas en la base: vencido (< hoy), hoy, próximos 7 días ((hoy, hoy+7]) y pagado este mes
 * (por `paidAt`, dentro del mes de CDMX). Todo lo pendiente cuenta por la fecha de cobro; «hoy» es el día de CDMX de `now`: a las
 * 23:30 de CDMX, que en UTC ya es mañana, sigue siendo hoy.
 */
export async function summarizeOccurrences(now: Date = new Date()): Promise<ChargeSummary> {
  const today = todayInMexico(now)
  const todayDb = calendarDayToDb(today)
  const month = monthBoundsInMexico(today)

  const sum = async (where: Prisma.PlatformChargeOccurrenceWhereInput): Promise<SummaryBucket> => {
    const { _count, _sum } = await prisma.platformChargeOccurrence.aggregate({ where, _count: { _all: true }, _sum: { totalCents: true } })
    return { count: _count._all, totalCents: _sum.totalCents ?? 0 }
  }

  const [overdue, dueToday, upcoming, paidThisMonth] = await Promise.all([
    sum({ status: 'PENDING', dueDate: { lt: todayDb } }),
    sum({ status: 'PENDING', dueDate: todayDb }),
    sum({ status: 'PENDING', dueDate: { gt: todayDb, lte: calendarDayToDb(addDays(today, UPCOMING_DAYS)) } }),
    sum({ status: 'PAID', paidAt: { gte: month.from, lt: month.to } }),
  ])
  return { today, overdue, dueToday, upcoming, paidThisMonth }
}

/**
 * Las ocurrencias de una vista, de tantas en tantas: el servidor impone el tope de página (100), el orden es estable (`id`
 * desempata; los pagados van del más reciente al más viejo, lo demás por fecha de cobro) y el total y la suma salen de la base con EL MISMO filtro
 * (`occurrenceWhere`: vista, nombre, periodicidad, factura, tipo de cliente y fechas), nunca de la página. Cada fila trae su factura viva y, si no
 * hay, la más reciente.
 */
export async function listOccurrences(
  filters: ListOccurrencesFilters,
  now: Date = new Date(),
): Promise<{ rows: OccurrenceView[]; total: number; page: number; pageSize: number; sumCents: number }> {
  const view = filters.view ?? 'open'
  const where = occurrenceWhere(filters)

  const { page, pageSize } = pageParams(filters)
  // El total y la suma salen de UNA pasada con el mismo `where` (los filtros de factura son subconsultas NOT EXISTS: no se pagan dos veces).
  const [rows, { _count, _sum }] = await Promise.all([
    prisma.platformChargeOccurrence.findMany({
      where,
      include: VIEW_INCLUDE,
      orderBy: view === 'paid' ? [{ paidAt: 'desc' }, { id: 'desc' }] : [{ dueDate: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.platformChargeOccurrence.aggregate({ where, _count: { _all: true }, _sum: { totalCents: true } }),
  ])
  const total = _count._all
  const today = todayInMexico(now)
  const live = await liveInvoicesOf(rows.map(row => row.id))
  return { rows: rows.map(row => toView(row, today, live.get(row.id))), total, page, pageSize, sumCents: _sum.totalCents ?? 0 }
}
