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
 * - Capacidad: lecturas con `take`, tope de página impuesto aquí, orden estable (`id` desempata) y tarjetas sumadas en la base.
 */
import type {
  PlatformCfdi,
  PlatformChargeFrequency,
  PlatformChargeInvoiceMode,
  PlatformChargeOccurrenceStatus,
  Prisma,
} from '@prisma/client'
import logger from '@/config/logger'
import AppError, { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { PlatformBillingError } from '@/services/superadmin/platform-billing/platformEmisor.service'
import prisma from '@/utils/prismaClient'
import { pageParams } from './charges.service'
import { findProfileId, intentKey, invoiceOccurrence, resolverIntento } from './invoice.service'
import type { InvoiceOccurrenceInput } from './invoice.service'
import { withChargeLock } from './lock'
import { addDays, calendarDayToDb, dbToCalendarDay, monthBoundsInMexico, todayInMexico } from './schedule'
import type { CalendarDay, ChargeConcept } from './types'

/** «Próximos 7 días» de las tarjetas: el mismo horizonte con el que el generador crea las fechas. */
const UPCOMING_DAYS = 7

const VIEW_STATUS: Record<string, PlatformChargeOccurrenceStatus> = { open: 'PENDING', paid: 'PAID', skipped: 'SKIPPED' }

export type OccurrenceViewName = 'open' | 'paid' | 'skipped'
/** Dónde cae una ocurrencia PENDIENTE respecto a hoy (de CDMX). Una pagada u omitida no tiene. */
export type OccurrenceBucket = 'OVERDUE' | 'TODAY' | 'UPCOMING'

/** Lo que la pantalla pinta de la factura más reciente de una ocurrencia. */
export interface OccurrenceInvoiceView {
  id: string
  status: PlatformCfdi['status']
  serie: string | null
  folio: string | null
  uuid: string | null
  totalCents: number
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
  concepts: ChargeConcept[]
  subtotalCents: number
  taxCents: number
  totalCents: number
  /** La casilla «Timbrar factura ahora» sale marcada. */
  willInvoice: boolean
  /** A quién se le timbraría; `null` si no hay datos fiscales con qué hacerlo. */
  receptor: { rfc: string; razonSocial: string } | null
  /** Facturas PPD ya timbradas del receptor que todavía no se liquidan en «Facturas CFDI». */
  pendingPpdCount: number
}

export type PayInvoiceResult = { ok: true; cfdi: PlatformCfdi } | { ok: false; message: string; code: string; field?: string }

export interface PayResult {
  occurrence: OccurrenceView
  /** `null` = no se pidió factura, o la ocurrencia ya estaba pagada (repetir no vuelve a facturar). */
  invoice: PayInvoiceResult | null
}

export interface ListOccurrencesFilters {
  view?: OccurrenceViewName
  /** Búsqueda por nombre del cliente. */
  q?: string
  page?: number
  pageSize?: number
}

// ── Errores y textos ────────────────────────────────────────────────────────────────────────────────────────────────────────

const occurrenceNotFound = () => new NotFoundError('Cobro no encontrado', 'PLATFORM_CHARGE_OCCURRENCE_NOT_FOUND')
const conflict = (message: string, code: string) => new ConflictError(message, code)

/** «la factura A-118», o «la factura» si aún no tiene serie y folio. */
const invoiceName = (row: Pick<PlatformCfdi, 'serie' | 'folio'>): string => {
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

/** El cobro y SU factura más reciente (una sola por ocurrencia: `take: 1` por la más nueva, `id` desempata). */
const VIEW_INCLUDE = {
  charge: { select: { customerName: true, frequency: true } },
  invoices: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: {
      id: true,
      status: true,
      serie: true,
      folio: true,
      uuid: true,
      totalCents: true,
      lastError: true,
      emailSentAt: true,
      createdAt: true,
    },
  },
} satisfies Prisma.PlatformChargeOccurrenceInclude

type OccurrenceRow = Prisma.PlatformChargeOccurrenceGetPayload<{ include: typeof VIEW_INCLUDE }>

const conceptsOf = (json: Prisma.JsonValue): ChargeConcept[] => (Array.isArray(json) ? (json as unknown as ChargeConcept[]) : [])

/** 'YYYY-MM-DD' con ceros a la izquierda se ordena como el calendario: comparar los textos es comparar los días. */
function bucketOf(status: PlatformChargeOccurrenceStatus, dueDate: CalendarDay, today: CalendarDay): OccurrenceBucket | null {
  if (status !== 'PENDING') return null
  return dueDate < today ? 'OVERDUE' : dueDate === today ? 'TODAY' : 'UPCOMING'
}

function toView(row: OccurrenceRow, today: CalendarDay): OccurrenceView {
  const dueDate = dbToCalendarDay(row.dueDate)
  const [invoice] = row.invoices
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
    invoice: invoice
      ? {
          id: invoice.id,
          status: invoice.status,
          serie: invoice.serie,
          folio: invoice.folio,
          uuid: invoice.uuid,
          totalCents: invoice.totalCents,
          lastError: invoice.lastError,
          emailSentAt: invoice.emailSentAt,
          createdAt: invoice.createdAt,
        }
      : null,
  }
}

async function viewOf(id: string, now: Date): Promise<OccurrenceView> {
  const row = await prisma.platformChargeOccurrence.findUnique({ where: { id }, include: VIEW_INCLUDE })
  if (!row) throw occurrenceNotFound()
  return toView(row, todayInMexico(now))
}

// ── Lo que comparten las tres escrituras ────────────────────────────────────────────────────────────────────────────────────

/** De qué cobro es la ocurrencia (y cómo está): se lee SIN candado sólo para saber cuál tomar; la decisión se relee adentro. */
async function probe(id: string) {
  const row = await prisma.platformChargeOccurrence.findUnique({ where: { id }, select: { chargeId: true, status: true } })
  if (!row) throw occurrenceNotFound()
  return row
}

const LOCKED_INCLUDE = { charge: { select: { venueId: true, organizationId: true } } } satisfies Prisma.PlatformChargeOccurrenceInclude

/** Bajo el candado: la ocurrencia como está AHORA, con lo que la bitácora necesita del cobro. */
async function readLocked(tx: Prisma.TransactionClient, id: string) {
  const row = await tx.platformChargeOccurrence.findUnique({ where: { id }, include: LOCKED_INCLUDE })
  if (!row) throw occurrenceNotFound()
  return row
}

/** Una entrada de la bitácora del cobro, con quien lo pidió, el negocio y la organización. Siempre FUERA del candado. */
function audit(
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
 * Con `invoice: true`, DESPUÉS de marcarla (y fuera del candado) llama a `invoiceOccurrence` y atrapa su error: el cobro SIGUE
 * pagado y la respuesta trae `invoice: { ok: false, message, code, field? }`. Un proceso que muere en medio deja «Pagado · sin
 * factura», con su botón «Facturar».
 */
export async function payOccurrence(id: string, input: { invoice: boolean }, actorId: string, now: Date = new Date()): Promise<PayResult> {
  const { chargeId } = await probe(id)

  const paid = await withChargeLock(chargeId, async tx => {
    const row = await readLocked(tx, id)
    if (row.status === 'SKIPPED') {
      throw conflict('Este cobro está omitido; deshazlo para poder marcarlo como pagado', 'PLATFORM_CHARGE_OCCURRENCE_SKIPPED')
    }
    if (row.status === 'PAID') return null // repetir: éxito, sin volver a escribir ni a facturar
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
      invoice = { ok: true, cfdi: await invoiceOccurrence(id, { actorId }) }
    } catch (error) {
      invoice = invoiceFailure(error, id)
    }
  }
  return { occurrence: await viewOf(id, now), invoice }
}

// ── Omitir y deshacer ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** «Omitir» (spec §3.5): `PENDING → SKIPPED`. Sobre una pagada es 409; repetirlo sobre una ya omitida contesta éxito sin escribir. */
export async function skipOccurrence(id: string, actorId: string, now: Date = new Date()): Promise<OccurrenceView> {
  const { chargeId } = await probe(id)

  const skipped = await withChargeLock(chargeId, async tx => {
    const row = await readLocked(tx, id)
    if (row.status === 'SKIPPED') return null
    if (row.status === 'PAID') {
      throw conflict('Este cobro ya está marcado como pagado; deshazlo antes de omitirlo', 'PLATFORM_CHARGE_OCCURRENCE_PAID')
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
 * primero, la reserva ve PENDING y no timbra (`reserveCheck`).
 *
 * Limpia el pago y la omisión (`paidAt`, `paidById`, `skippedAt`, `skippedById`). Repetirlo sobre una ya pendiente contesta éxito.
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
    const updated = await tx.platformChargeOccurrence.update({
      where: { id },
      data: { status: 'PENDING', paidAt: null, paidById: null, skippedAt: null, skippedById: null },
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

// ── Lecturas de la pantalla ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Cuántas facturas PPD ya timbradas del receptor siguen sin liquidar en «Facturas CFDI» (`amountPaidCents < totalCents`). Una
 * columna contra otra no se puede pedir con `where` de Prisma, y traerlas todas para contarlas en memoria sería un `findMany` sin
 * tope: se cuenta en la base.
 */
async function countPendingPpd(billingTaxProfileId: string): Promise<number> {
  const [row] = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS "count"
    FROM "PlatformCfdi"
    WHERE "billingTaxProfileId" = ${billingTaxProfileId}
      AND type = 'INGRESO'
      AND "metodoPago" = 'PPD'
      AND status = 'STAMPED'
      AND "amountPaidCents" < "totalCents"`
  return row?.count ?? 0
}

/**
 * Lo que el diálogo «Ya me pagó» enseña (spec §3.5): receptor, conceptos y total de la FOTO de la ocurrencia, si la casilla «Timbrar
 * factura ahora» sale marcada y cuántas facturas PPD sin liquidar tiene el receptor. 🔴 Con PPD pendientes NO se timbra aunque la
 * ocurrencia sea automática («si una es de este periodo, no timbres otra y registra el pago allá»); sin receptor tampoco, porque no
 * habría a quién timbrarle.
 */
export async function payPreview(occurrenceId: string): Promise<PayPreview> {
  const row = await prisma.platformChargeOccurrence.findUnique({ where: { id: occurrenceId }, include: { charge: true } })
  if (!row) throw occurrenceNotFound()

  const profileId = await findProfileId(row.charge)
  const profile = profileId
    ? await prisma.billingTaxProfile.findUnique({ where: { id: profileId }, select: { rfc: true, razonSocial: true } })
    : null
  const pendingPpdCount = profile && profileId ? await countPendingPpd(profileId) : 0

  return {
    customerName: row.charge.customerName,
    concepts: conceptsOf(row.concepts),
    subtotalCents: row.subtotalCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    willInvoice: row.invoiceMode === 'AUTOMATIC' && profile !== null && pendingPpdCount === 0,
    receptor: profile ? { rfc: profile.rfc, razonSocial: profile.razonSocial } : null,
    pendingPpdCount,
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
 * desempata; los pagados van del más reciente al más viejo, lo demás por fecha de cobro) y el total sale de un `count` con el mismo
 * filtro. La búsqueda por nombre del cliente corre en la base, antes de paginar. Cada fila trae su factura más reciente.
 */
export async function listOccurrences(
  filters: ListOccurrencesFilters,
  now: Date = new Date(),
): Promise<{ rows: OccurrenceView[]; total: number; page: number; pageSize: number }> {
  const view = filters.view ?? 'open'
  // `hasOwnProperty`: «constructor» o «toString» no son vistas (el objeto los hereda).
  if (!Object.prototype.hasOwnProperty.call(VIEW_STATUS, view)) {
    throw new BadRequestError('Elige una vista válida: pendientes, pagados u omitidos', 'PLATFORM_CHARGE_INVALID_VIEW')
  }
  const where: Prisma.PlatformChargeOccurrenceWhereInput = { status: VIEW_STATUS[view] }
  const term = (filters.q ?? '').trim()
  if (term) where.charge = { customerName: { contains: term, mode: 'insensitive' } }

  const { page, pageSize } = pageParams(filters)
  const [rows, total] = await Promise.all([
    prisma.platformChargeOccurrence.findMany({
      where,
      include: VIEW_INCLUDE,
      orderBy: view === 'paid' ? [{ paidAt: 'desc' }, { id: 'desc' }] : [{ dueDate: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.platformChargeOccurrence.count({ where }),
  ])
  const today = todayInMexico(now)
  return { rows: rows.map(row => toView(row, today)), total, page, pageSize }
}
