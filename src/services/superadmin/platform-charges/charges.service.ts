/**
 * «Por cobrar» — cobros recurrentes y su generador de ocurrencias (spec 2026-11-02-por-cobrar-superadmin §3.3 y §3.4).
 *
 * Un **cobro** (`PlatformCharge`) es lo que Avoqado le cobra a un cliente fuera de Stripe, cada semana, quincena o mes. De él
 * salen las **ocurrencias** (`PlatformChargeOccurrence`): un periodo por cobrar con su foto de conceptos, totales y modo de
 * factura. Editar el cobro cambia sólo lo futuro: lo vencido, lo de hoy y lo ya marcado conservan su foto.
 *
 * - Toda escritura de un cobro y de sus ocurrencias corre en UNA transacción corta que antes toma el candado de su fila
 *   (`withChargeLock`) y ahí adentro vuelve a leer lo que va a decidir. Facturapi y el correo nunca se llaman ahí.
 * - `logAction` va siempre DESPUÉS y fuera de la transacción (nunca lanza; si la transacción se deshace no se registra nada).
 * - Fechas: días de calendario de CDMX (`'YYYY-MM-DD'`), sólo con los helpers de `schedule.ts`. Dinero: centavos enteros.
 */
import { BillingCustomerType, PlatformChargeFrequency, PlatformChargeInvoiceMode } from '@prisma/client'
import type { BillingTaxProfile, PlatformCharge, Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'
import { lockCharge, withChargeLock } from './lock'
import { addDays, calendarDayToDb, dbToCalendarDay, isSamePeriodAsMarked, occurrenceDatesBetween, todayInMexico } from './schedule'
import { computeChargeTotals } from './totals'
import type { CalendarDay, ChargeConcept } from './types'

/** El generador mira de hoy a hoy+7: lo que vence en la semana ya aparece en la pantalla y en el correo. */
const GENERATE_AHEAD_DAYS = 7
/** `anchorDate` entre hoy−366 y hoy+366 días, los dos extremos incluidos (spec §3.1). */
const ANCHOR_WINDOW_DAYS = 366
const MAX_CONCEPTS = 20
/** Centavos por concepto: $9,999,999.99. */
const MAX_CONCEPT_CENTS = 999_999_999
/** Las columnas de dinero de la ocurrencia son `Int` de Postgres: un total con IVA mayor no cabe. */
const MAX_TOTAL_CENTS = 2_147_483_647
/** Cobros activos que lee el generador por página. */
const GENERATOR_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

const CUSTOMER_TYPES = new Set<string>(Object.values(BillingCustomerType))
const FREQUENCIES = new Set<string>(Object.values(PlatformChargeFrequency))
const INVOICE_MODES = new Set<string>(Object.values(PlatformChargeInvoiceMode))
const IVA_MODES = new Set<string>(['WITHOUT_IVA', 'WITH_IVA'])

export interface ChargeInput {
  customerType: BillingCustomerType
  organizationId?: string
  venueId?: string
  customerName: string
  billingTaxProfileId?: string
  frequency: PlatformChargeFrequency
  /** Primera fecha de cobro: día de calendario de CDMX. */
  anchorDate: CalendarDay
  concepts: ChargeConcept[]
  invoiceMode: PlatformChargeInvoiceMode
}

export interface ListChargesFilters {
  /** Sin `status` se listan todos los cobros. */
  status?: 'active' | 'paused'
  /** Búsqueda por nombre del cliente. */
  q?: string
  page?: number
  pageSize?: number
}

/** Lo que define a un cobro, ya limpio: los ids ausentes son `null` y la fecha es un día de calendario. */
interface ChargeState {
  customerType: BillingCustomerType
  organizationId: string | null
  venueId: string | null
  customerName: string
  billingTaxProfileId: string | null
  frequency: PlatformChargeFrequency
  anchorDate: CalendarDay
  concepts: ChargeConcept[]
  invoiceMode: PlatformChargeInvoiceMode
}

type Field = keyof ChargeState
const FIELDS: readonly Field[] = [
  'customerType',
  'organizationId',
  'venueId',
  'customerName',
  'billingTaxProfileId',
  'frequency',
  'anchorDate',
  'concepts',
  'invoiceMode',
]
/** Lo que cambia las fechas futuras: sus fotos (conceptos y modo) y cuándo caen. El resto no regenera nada. */
const RESCHEDULE_FIELDS: readonly Field[] = ['frequency', 'anchorDate', 'concepts', 'invoiceMode']
/** Lo que obliga a volver a revisar a quién le cobramos y con qué datos fiscales. */
const CUSTOMER_FIELDS: readonly Field[] = ['customerType', 'organizationId', 'venueId', 'billingTaxProfileId', 'invoiceMode']

// ── Errores y texto ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const invalid = (message: string, code = 'PLATFORM_CHARGE_INVALID') => new BadRequestError(message, code)
const chargeNotFound = () => new NotFoundError('Cobro no encontrado', 'PLATFORM_CHARGE_NOT_FOUND')

const cleanText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const cleanId = (value: unknown): string | null => cleanText(value) || null

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
/** «5 nov»: el día sin cero a la izquierda y el mes abreviado, fijo (no depende del ICU del servidor). */
export const shortDayEs = (day: CalendarDay): string => `${Number(day.slice(8, 10))} ${MONTHS_ES[Number(day.slice(5, 7)) - 1]}`

// ── Validación de lo que llega ──────────────────────────────────────────────────────────────────────────────────────────────

function isCalendarDay(value: unknown): value is CalendarDay {
  if (typeof value !== 'string') return false
  try {
    addDays(value, 0) // lanza si no es un día real del calendario (un 30 de febrero, un instante, vacío)
    return true
  } catch {
    return false
  }
}

const pickConcept = (c: ChargeConcept): ChargeConcept => ({
  description: c.description,
  amountCents: c.amountCents,
  ivaMode: c.ivaMode,
  satProductKey: c.satProductKey,
  satUnitKey: c.satUnitKey,
})

/** Valida y limpia los conceptos. Lo que se guarda en la base se calcula después con ellos: aquí no puede colarse nada raro. */
function normalizeConcepts(raw: unknown): ChargeConcept[] {
  if (!Array.isArray(raw) || raw.length === 0) throw invalid('Agrega al menos un concepto al cobro')
  if (raw.length > MAX_CONCEPTS) throw invalid(`Un cobro puede tener hasta ${MAX_CONCEPTS} conceptos`)

  const concepts = raw.map((item): ChargeConcept => {
    if (typeof item !== 'object' || item === null) throw invalid('Un concepto no es válido')
    const c = item as Record<string, unknown>
    const description = cleanText(c.description)
    if (!description) throw invalid('Cada concepto necesita una descripción')
    const { amountCents, ivaMode } = c
    if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw invalid('El monto de cada concepto debe ser mayor a $0')
    }
    if (amountCents > MAX_CONCEPT_CENTS) throw invalid('El monto de un concepto no puede pasar de $9,999,999.99')
    if (typeof ivaMode !== 'string' || !IVA_MODES.has(ivaMode)) throw invalid('Elige si el monto de cada concepto trae IVA o no')
    const satProductKey = cleanText(c.satProductKey)
    const satUnitKey = cleanText(c.satUnitKey)
    if (!satProductKey || !satUnitKey) throw invalid('Cada concepto necesita su clave del SAT y su unidad')
    return { description, amountCents, ivaMode: ivaMode as ChargeConcept['ivaMode'], satProductKey, satUnitKey }
  })

  if (computeChargeTotals(concepts).totalCents > MAX_TOTAL_CENTS) {
    throw invalid('El total del cobro, con IVA, no puede pasar de $21,474,836.47')
  }
  return concepts
}

/**
 * El ancla debe quedar entre hoy−366 y hoy+366 días, los dos extremos incluidos. Sólo se exige al FIJARLA (el alta, o una edición que
 * la cambia): el formulario de edición reenvía el ancla de siempre, y un cobro viejo no puede quedar sin poderse editar por eso.
 */
function assertAnchorInWindow(anchor: CalendarDay, today: CalendarDay): void {
  // 'YYYY-MM-DD' con ceros a la izquierda se ordena como el calendario: comparar los textos es comparar los días.
  if (anchor < addDays(today, -ANCHOR_WINDOW_DAYS) || anchor > addDays(today, ANCHOR_WINDOW_DAYS)) {
    throw invalid(`La fecha de inicio debe estar a menos de ${ANCHOR_WINDOW_DAYS} días de hoy`)
  }
}

/** Valida y limpia sólo lo que se mande (en un alta, todo): lo inválido se rechaza ANTES de abrir una transacción. */
function normalizeFields(input: Partial<ChargeInput>, requireAll: boolean): Partial<ChargeState> {
  const out: Partial<ChargeState> = {}
  const given = (key: keyof ChargeInput): boolean => requireAll || input[key] !== undefined

  if (given('customerType')) {
    if (!CUSTOMER_TYPES.has(input.customerType as string)) {
      throw invalid('Elige si el cliente es una organización, un negocio o un cliente externo')
    }
    out.customerType = input.customerType
  }
  for (const key of ['organizationId', 'venueId', 'billingTaxProfileId'] as const) {
    if (input[key] !== undefined) out[key] = cleanId(input[key])
  }
  if (given('customerName')) {
    const name = cleanText(input.customerName)
    if (!name) throw invalid('Escribe el nombre del cliente')
    out.customerName = name
  }
  if (given('frequency')) {
    if (!FREQUENCIES.has(input.frequency as string)) throw invalid('Elige la periodicidad del cobro: semanal, quincenal o mensual')
    out.frequency = input.frequency
  }
  if (given('anchorDate')) {
    if (!isCalendarDay(input.anchorDate)) throw invalid('La fecha de inicio no es válida')
    out.anchorDate = input.anchorDate
  }
  if (given('concepts')) out.concepts = normalizeConcepts(input.concepts)
  if (given('invoiceMode')) {
    if (!INVOICE_MODES.has(input.invoiceMode as string)) throw invalid('Elige si el cobro se factura automáticamente o con un botón')
    out.invoiceMode = input.invoiceMode
  }
  return out
}

/** A quién se le cobra: el tipo de cliente y su organización o negocio (los dos null en un cliente externo). */
export interface CustomerRef {
  customerType: BillingCustomerType
  organizationId: string | null
  venueId: string | null
}

/**
 * El perfil fiscal es de este cliente si es del mismo tipo y de la misma organización o negocio (los dos null en un cliente externo);
 * si no, 400 PLATFORM_CHARGE_TAX_PROFILE_MISMATCH. La misma regla vale al guardar el cobro y al facturar (`invoice.service.ts`):
 * facturar al RFC equivocado sólo se deshace cancelando ante el SAT.
 */
export function assertTaxProfileOfCustomer(
  profile: Pick<BillingTaxProfile, 'customerType' | 'organizationId' | 'venueId'>,
  customer: CustomerRef,
): void {
  if (
    profile.customerType !== customer.customerType ||
    (profile.organizationId ?? null) !== customer.organizationId ||
    (profile.venueId ?? null) !== customer.venueId
  ) {
    throw new BadRequestError('Ese perfil fiscal no es de este cliente', 'PLATFORM_CHARGE_TAX_PROFILE_MISMATCH')
  }
}

/**
 * A quién se le cobra y con qué datos fiscales (spec §5). Va DENTRO de la transacción y con su `tx`: leer el perfil con otra
 * conexión mientras ésta espera el candado es pedir dos conexiones a la vez por una sola operación.
 */
async function assertCustomerAndProfile(tx: Prisma.TransactionClient, state: ChargeState): Promise<void> {
  const { customerType, organizationId, venueId, billingTaxProfileId } = state
  const mismatch = () => invalid('Los datos del cliente no coinciden con su tipo')
  if (customerType === 'ORGANIZATION') {
    if (!organizationId) throw invalid('Elige la organización a la que le cobrarás')
    if (venueId) throw mismatch()
  } else if (customerType === 'VENUE') {
    if (!venueId) throw invalid('Elige el negocio al que le cobrarás')
    if (organizationId) throw mismatch()
  } else if (organizationId || venueId) {
    throw mismatch() // un cliente externo no es de ninguna organización ni negocio
  }

  if (!billingTaxProfileId) {
    if (state.invoiceMode === 'AUTOMATIC') {
      throw new BadRequestError(
        'Para facturar automáticamente captura primero los datos fiscales del cliente',
        'PLATFORM_CHARGE_NEEDS_TAX_PROFILE',
      )
    }
    return // MANUAL puede no tenerlo: se pide al facturar
  }
  const profile = await tx.billingTaxProfile.findUnique({
    where: { id: billingTaxProfileId },
    select: { customerType: true, organizationId: true, venueId: true },
  })
  if (!profile) throw invalid('El perfil fiscal no existe')
  assertTaxProfileOfCustomer(profile, state)
}

// ── Estado del cobro ────────────────────────────────────────────────────────────────────────────────────────────────────────

function stateOf(row: PlatformCharge): ChargeState {
  return {
    customerType: row.customerType,
    organizationId: row.organizationId,
    venueId: row.venueId,
    customerName: row.customerName,
    billingTaxProfileId: row.billingTaxProfileId,
    frequency: row.frequency,
    anchorDate: dbToCalendarDay(row.anchorDate),
    concepts: Array.isArray(row.concepts) ? (row.concepts as unknown as ChargeConcept[]).map(pickConcept) : [],
    invoiceMode: row.invoiceMode,
  }
}

/** El cliente es una unidad (tipo + organización + negocio): si cambia cualquiera, los ids que no vengan quedan en null. */
function mergeFields(current: ChargeState, fields: Partial<ChargeState>): ChargeState {
  const next: ChargeState = { ...current, ...fields }
  if (fields.customerType !== undefined || fields.organizationId !== undefined || fields.venueId !== undefined) {
    next.organizationId = fields.organizationId ?? null
    next.venueId = fields.venueId ?? null
  }
  return next
}

/** Las columnas del cobro. Los conceptos ya van limpios y en el mismo orden de llaves, así que se comparan por su JSON. */
function dbFields(state: ChargeState) {
  return {
    customerType: state.customerType,
    organizationId: state.organizationId,
    venueId: state.venueId,
    customerName: state.customerName,
    billingTaxProfileId: state.billingTaxProfileId,
    frequency: state.frequency,
    anchorDate: calendarDayToDb(state.anchorDate),
    concepts: state.concepts as unknown as Prisma.InputJsonValue,
    invoiceMode: state.invoiceMode,
  }
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ── Ocurrencias ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Crea las ocurrencias del cobro con fecha en `[from, to]` (nunca antes del ancla), cada una con la foto de conceptos, totales y
 * modo de factura de ESTE momento. Idempotente: la llave única `[chargeId, dueDate]` con `skipDuplicates` respeta lo que ya existe
 * (incluido lo ya pagado u omitido), y no crea una fecha del mismo periodo que lo último marcado (`isSamePeriodAsMarked`). Devuelve
 * cuántas creó. Debe correr dentro del candado del cobro.
 */
async function generateOccurrences(
  tx: Prisma.TransactionClient,
  charge: PlatformCharge,
  from: CalendarDay,
  to: CalendarDay,
): Promise<number> {
  const state = stateOf(charge)
  const candidates = occurrenceDatesBetween(state.frequency, state.anchorDate, from, to)
  if (candidates.length === 0) return 0
  const lastMarked = await tx.platformChargeOccurrence.findFirst({
    where: { chargeId: charge.id, status: { in: ['PAID', 'SKIPPED'] } },
    orderBy: { dueDate: 'desc' },
    select: { dueDate: true },
  })
  const marked = lastMarked ? dbToCalendarDay(lastMarked.dueDate) : null
  const dates = marked ? candidates.filter(day => !isSamePeriodAsMarked(state.frequency, marked, day)) : candidates
  if (dates.length === 0) return 0
  const { subtotalCents, taxCents, totalCents } = computeChargeTotals(state.concepts)
  const { count } = await tx.platformChargeOccurrence.createMany({
    data: dates.map(day => ({
      chargeId: charge.id,
      dueDate: calendarDayToDb(day),
      concepts: state.concepts as unknown as Prisma.InputJsonValue,
      subtotalCents,
      taxCents,
      totalCents,
      invoiceMode: state.invoiceMode,
    })),
    skipDuplicates: true,
  })
  return count
}

/**
 * 🔴 Cambiar el calendario con una ocurrencia futura ya pagada u omitida generaría otro cobro por el mismo periodo (no se
 * modelan periodos). Se avisa con la más próxima. Va dentro del candado, junto con el borrado y la regeneración.
 */
async function assertNoMarkedFuture(tx: Prisma.TransactionClient, chargeId: string, today: CalendarDay): Promise<void> {
  const marked = await tx.platformChargeOccurrence.findFirst({
    where: { chargeId, status: { in: ['PAID', 'SKIPPED'] }, dueDate: { gt: calendarDayToDb(today) } },
    orderBy: { dueDate: 'asc' },
    select: { dueDate: true },
  })
  if (marked) {
    throw new ConflictError(
      `Ya marcaste el cobro del ${shortDayEs(dbToCalendarDay(marked.dueDate))}; deshazlo para cambiar la fecha`,
      'PLATFORM_CHARGE_FUTURE_MARKED',
    )
  }
}

function audit(action: string, charge: PlatformCharge, actorId: string, data: Prisma.InputJsonValue): void {
  void logAction({
    staffId: actorId,
    venueId: charge.venueId,
    organizationId: charge.organizationId,
    action,
    entity: 'PlatformCharge',
    entityId: charge.id,
    data,
  })
}

// ── API ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Da de alta un cobro y genera sus ocurrencias desde el ancla hasta hoy+7 (lo anterior a hoy nace vencido). Todo en una sola
 * transacción: o quedan el cobro y sus fechas, o nada. Se toma el candado de la fila recién creada por uniformidad: nadie más
 * puede verla hasta el commit, así que no espera a nadie.
 */
export async function createCharge(input: ChargeInput, actorId: string, now: Date = new Date()): Promise<PlatformCharge> {
  const today = todayInMexico(now)
  const fields = normalizeFields(input, true)
  const state: ChargeState = {
    ...(fields as ChargeState),
    organizationId: fields.organizationId ?? null,
    venueId: fields.venueId ?? null,
    billingTaxProfileId: fields.billingTaxProfileId ?? null,
  }
  assertAnchorInWindow(state.anchorDate, today)

  const charge = await prisma.$transaction(async tx => {
    await assertCustomerAndProfile(tx, state)
    const created = await tx.platformCharge.create({ data: { ...dbFields(state), createdById: actorId } })
    await lockCharge(tx, created.id)
    await generateOccurrences(tx, created, state.anchorDate, addDays(today, GENERATE_AHEAD_DAYS))
    return created
  })

  audit('PLATFORM_CHARGE_CREATED', charge, actorId, {
    customerType: state.customerType,
    customerName: state.customerName,
    frequency: state.frequency,
    anchorDate: state.anchorDate,
    invoiceMode: state.invoiceMode,
    conceptCount: state.concepts.length,
  })
  return charge
}

/**
 * Edita un cobro: sólo cambia lo futuro. Si cambió algo que afecta las fechas (calendario, conceptos o modo), borra las PENDING
 * con fecha mayor a hoy y las regenera de hoy a hoy+7 con la foto nueva; lo vencido y lo de hoy conservan la suya. Cambiar el
 * ancla o la periodicidad con una ocurrencia futura ya marcada es un 409. Si no cambió nada, no escribe nada.
 */
export async function updateCharge(
  id: string,
  input: Partial<ChargeInput>,
  actorId: string,
  now: Date = new Date(),
): Promise<PlatformCharge> {
  const today = todayInMexico(now)
  const fields = normalizeFields(input, false)

  const { charge, changed } = await withChargeLock(id, async tx => {
    const row = await tx.platformCharge.findUnique({ where: { id } })
    if (!row) throw chargeNotFound()
    const current = stateOf(row)
    const next = mergeFields(current, fields)
    const changed = FIELDS.filter(field => !sameValue(current[field], next[field]))
    if (changed.length === 0) return { charge: row, changed }

    if (changed.includes('anchorDate')) assertAnchorInWindow(next.anchorDate, today)
    if (changed.some(field => CUSTOMER_FIELDS.includes(field))) await assertCustomerAndProfile(tx, next)
    if (changed.includes('anchorDate') || changed.includes('frequency')) await assertNoMarkedFuture(tx, id, today)

    const updated = await tx.platformCharge.update({ where: { id }, data: dbFields(next) })
    if (changed.some(field => RESCHEDULE_FIELDS.includes(field))) {
      await tx.platformChargeOccurrence.deleteMany({ where: { chargeId: id, status: 'PENDING', dueDate: { gt: calendarDayToDb(today) } } })
      // Un cobro pausado no genera: al reanudarlo se generará desde hoy.
      if (!updated.pausedAt) await generateOccurrences(tx, updated, today, addDays(today, GENERATE_AHEAD_DAYS))
    }
    return { charge: updated, changed }
  })

  if (changed.length > 0) audit('PLATFORM_CHARGE_UPDATED', charge, actorId, { changedFields: [...changed] })
  return charge
}

/**
 * Pausa un cobro: deja de generar y borra sus PENDING futuras. Con `skipOverdue` pasa a SKIPPED lo vencido y lo de hoy (para un
 * cliente que se fue); sin él se quedan por cobrar. Repetir no cambia nada: `pausedAt` conserva el momento original y no se
 * vuelve a borrar nada; sólo `skipOverdue` se sigue respetando, por si la segunda vez se eligió «Omitirlo».
 */
export async function pauseCharge(
  id: string,
  options: { skipOverdue: boolean },
  actorId: string,
  now: Date = new Date(),
): Promise<PlatformCharge> {
  const todayDb = calendarDayToDb(todayInMexico(now))

  const outcome = await withChargeLock(id, async tx => {
    const row = await tx.platformCharge.findUnique({ where: { id } })
    if (!row) throw chargeNotFound()
    const wasActive = row.pausedAt === null
    let charge = row
    let removedFuture = 0
    let skippedOverdue = 0
    if (wasActive) {
      charge = await tx.platformCharge.update({ where: { id }, data: { pausedAt: now } })
      removedFuture = (
        await tx.platformChargeOccurrence.deleteMany({ where: { chargeId: id, status: 'PENDING', dueDate: { gt: todayDb } } })
      ).count
    }
    if (options.skipOverdue === true) {
      skippedOverdue = (
        await tx.platformChargeOccurrence.updateMany({
          where: { chargeId: id, status: 'PENDING', dueDate: { lte: todayDb } },
          data: { status: 'SKIPPED', skippedAt: now, skippedById: actorId },
        })
      ).count
    }
    return { charge, wasActive, removedFuture, skippedOverdue }
  })

  // Repetir sin nada que omitir no cambia nada, y un no-op no se audita.
  if (outcome.wasActive || outcome.skippedOverdue > 0) {
    audit('PLATFORM_CHARGE_PAUSED', outcome.charge, actorId, {
      skipOverdue: options.skipOverdue === true,
      removedFuture: outcome.removedFuture,
      skippedOverdue: outcome.skippedOverdue,
    })
  }
  return outcome.charge
}

/**
 * Reanuda un cobro: genera desde max(ancla, hoy) hasta hoy+7. Lo que pasó durante la pausa no se cobra (esas fechas no se crean)
 * y `skipDuplicates` respeta lo ya marcado. Repetir sobre un cobro activo no cambia nada.
 */
export async function resumeCharge(id: string, actorId: string, now: Date = new Date()): Promise<PlatformCharge> {
  const today = todayInMexico(now)

  const outcome = await withChargeLock(id, async tx => {
    const row = await tx.platformCharge.findUnique({ where: { id } })
    if (!row) throw chargeNotFound()
    if (row.pausedAt === null) return { charge: row, resumed: false, created: 0 }
    const charge = await tx.platformCharge.update({ where: { id }, data: { pausedAt: null } })
    const created = await generateOccurrences(tx, charge, today, addDays(today, GENERATE_AHEAD_DAYS))
    return { charge, resumed: true, created }
  })

  if (outcome.resumed) audit('PLATFORM_CHARGE_RESUMED', outcome.charge, actorId, { occurrencesCreated: outcome.created })
  return outcome.charge
}

/** Página y tamaño ya acotados: el servidor impone el default (50) y el tope (100), nunca confía en lo que pida el cliente. */
export function pageParams(filters: { page?: number; pageSize?: number }): { page: number; pageSize: number } {
  const whole = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return {
    page: Math.max(whole(filters.page, 1), 1),
    pageSize: Math.min(Math.max(whole(filters.pageSize, DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE),
  }
}

/**
 * Los cobros, de tantos en tantos: el servidor impone el tope de página, el orden es estable (`id` desempata) y el total sale de
 * un `count` con el mismo filtro. La búsqueda por nombre y el estado corren en la base, antes de paginar.
 */
export async function listCharges(
  filters: ListChargesFilters,
): Promise<{ rows: PlatformCharge[]; total: number; page: number; pageSize: number }> {
  const where: Prisma.PlatformChargeWhereInput = {}
  if (filters.status === 'active') where.pausedAt = null
  else if (filters.status === 'paused') where.pausedAt = { not: null }
  const term = cleanText(filters.q)
  if (term) where.customerName = { contains: term, mode: 'insensitive' }

  const { page, pageSize } = pageParams(filters)

  const [rows, total] = await Promise.all([
    prisma.platformCharge.findMany({
      where,
      orderBy: [{ customerName: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.platformCharge.count({ where }),
  ])
  return { rows, total, page, pageSize }
}

/**
 * Genera, para todo cobro activo, las ocurrencias de hoy a hoy+7 (spec §3.3; lo llama la tarea diaria). Idempotente. Lee los ids
 * activos de 100 en 100 ordenados por `id` y procesa cada cobro en SU transacción: dentro del candado vuelve a leerlo, así que uno
 * pausado o editado después de la lectura de la página no recibe fechas viejas. Un cobro que falla se registra y no detiene a los
 * demás; un error al leer la lista sí se propaga.
 *
 * ponytail: una caída del servidor de más de 7 días dejaría fechas sin generar; no vale un marcador de avance.
 * ponytail: un cobro a la vez, cada uno en su transacción corta; con miles de cobros activos se agruparían en lotes.
 */
export async function generateAllActive(now: Date): Promise<void> {
  const today = todayInMexico(now)
  const to = addDays(today, GENERATE_AHEAD_DAYS)
  let after: string | undefined

  for (;;) {
    const page = await prisma.platformCharge.findMany({
      where: after === undefined ? { pausedAt: null } : { pausedAt: null, id: { gt: after } },
      orderBy: { id: 'asc' },
      take: GENERATOR_PAGE_SIZE,
      select: { id: true },
    })
    for (const { id } of page) {
      try {
        await withChargeLock(id, async tx => {
          const charge = await tx.platformCharge.findUnique({ where: { id } })
          if (!charge || charge.pausedAt) return
          await generateOccurrences(tx, charge, today, to)
        })
      } catch (error) {
        logger.error('[platform-charges] no se pudieron generar las fechas de un cobro', {
          chargeId: id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (page.length < GENERATOR_PAGE_SIZE) return
    after = page[page.length - 1].id
  }
}
