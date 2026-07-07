import {
  Prisma,
  type DiotTipoTercero,
  type ExpenseCategoria,
  type ExpenseMetodoPago,
  type ExpensePaymentStatus,
  type ExpenseSource,
  type ReceivedComprobanteTipo,
} from '@prisma/client'

import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { parseCfdiXml } from './cfdiReceived.parser'
import { resolveScopeOrNull, type CatalogScope } from './chartOfAccounts.service'

/**
 * Gastos / CFDIs recibidos de proveedores (Buzón) — Capa B, lado de ENTRADAS.
 *
 * Es el espejo del Cfdi de ventas: aquí entran los comprobantes que NOS emiten. Habilita el
 * IVA acreditable (cash-basis), los costos/gastos reales y la DIOT. Scope = (organizationId,
 * rfc) = el contribuyente RECEPTOR (igual que el catálogo y las pólizas). Gated PREMIUM (CFDI).
 *
 * Este slice cubre la captura manual + lectura. El posteo de pólizas (postExpensePolicy), el
 * IVA acreditable (getAcreditablePagado) y la DIOT (getDiot) viven en slices aparte y leen de
 * estos registros.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** RFC genérico de extranjeros y de "público en general" del SAT. */
const RFC_EXTRANJERO = 'XEXX010101000'
const RFC_PUBLICO_GENERAL = 'XAXX010101000'

export interface CreateExpenseInput {
  // Proveedor (emisor)
  proveedorRfc: string
  proveedorNombre: string
  proveedorRegimen?: string | null
  /** Si se omite, se deriva del RFC (extranjero / público en general / nacional). */
  tipoTercero?: DiotTipoTercero

  // Clasificación
  comprobanteTipo?: ReceivedComprobanteTipo
  usoCfdi?: string | null
  metodoPago?: ExpenseMetodoPago
  formaPago?: string | null
  categoria?: ExpenseCategoria

  // Fechas ('YYYY-MM-DD')
  fechaEmision: string
  fechaPago?: string | null

  // Money (centavos enteros)
  subtotalCents: number
  descuentoCents?: number
  ivaCents?: number
  iva16Cents?: number
  iva8Cents?: number
  iva0BaseCents?: number
  exentoBaseCents?: number
  iepsCents?: number
  isrRetenidoCents?: number
  ivaRetenidoCents?: number
  totalCents: number
  taxBreakdown?: Prisma.InputJsonValue | null

  // Deducibilidad (criterio fiscal del contribuyente; default permisivo)
  deducible?: boolean
  ivaAcreditable?: boolean

  /**
   * ¿Ya lo pagamos? Gobierna el IVA acreditable (cash-basis) y la DIOT.
   * Si se omite: PUE ⇒ pagado (al emitir), PPD ⇒ pendiente. PUE auto-pagado es lo que DICE el
   * proveedor; pásalo `false` si aún no desembolsas (MUST-FIX: no asumir pago a ciegas).
   */
  paid?: boolean

  // IDs fiscales / provenance
  uuid?: string | null
  serie?: string | null
  folio?: string | null
  source?: ExpenseSource
  xmlUrl?: string | null
  pdfUrl?: string | null
  supplierId?: string | null

  /** Centro de costo (local que lo registró). Informativo. */
  venueId?: string | null
}

export interface ExpenseDTO {
  id: string
  proveedorRfc: string
  proveedorNombre: string
  tipoTercero: DiotTipoTercero
  comprobanteTipo: ReceivedComprobanteTipo
  metodoPago: ExpenseMetodoPago
  categoria: ExpenseCategoria
  fechaEmision: string
  fechaPago: string | null
  subtotalCents: number
  descuentoCents: number
  ivaCents: number
  iva16Cents: number
  iva8Cents: number
  iepsCents: number
  isrRetenidoCents: number
  ivaRetenidoCents: number
  totalCents: number
  deducible: boolean
  ivaAcreditable: boolean
  paymentStatus: ExpensePaymentStatus
  paidCents: number
  paidPeriod: string | null
  posted: boolean
  uuid: string | null
  serie: string | null
  folio: string | null
  source: ExpenseSource
  status: string
  createdAt: string
}

async function requireScope(venueId: string): Promise<CatalogScope> {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) {
    throw new BadRequestError('Este local aún no tiene un RFC/emisor fiscal configurado. Configura la facturación (CFDI) primero.')
  }
  return scope
}

const isInt = (n: number) => Number.isInteger(n)

/** Deriva el tipo de tercero (para DIOT) a partir del RFC del proveedor. */
export function deriveTipoTercero(proveedorRfc: string): DiotTipoTercero {
  const rfc = proveedorRfc.toUpperCase().trim()
  if (rfc === RFC_EXTRANJERO) return 'EXTRANJERO'
  if (rfc === RFC_PUBLICO_GENERAL) return 'GLOBAL'
  return 'NACIONAL'
}

/** Clave de deduplicación: el folio fiscal (UUID) si existe; si no, una composición estable. */
function buildDedupeKey(input: {
  uuid?: string | null
  proveedorRfc: string
  fechaEmision: string
  totalCents: number
  folio?: string | null
}): string {
  if (input.uuid && input.uuid.trim()) return input.uuid.trim().toUpperCase()
  return [input.proveedorRfc, input.fechaEmision, String(input.totalCents), input.folio ?? ''].join('|')
}

function mapExpense(e: {
  id: string
  proveedorRfc: string
  proveedorNombre: string
  tipoTercero: DiotTipoTercero
  comprobanteTipo: ReceivedComprobanteTipo
  metodoPago: ExpenseMetodoPago
  categoria: ExpenseCategoria
  fechaEmision: Date
  fechaPago: Date | null
  subtotalCents: number
  descuentoCents: number
  ivaCents: number
  iva16Cents: number
  iva8Cents: number
  iepsCents: number
  isrRetenidoCents: number
  ivaRetenidoCents: number
  totalCents: number
  deducible: boolean
  ivaAcreditable: boolean
  paymentStatus: ExpensePaymentStatus
  paidCents: number
  paidPeriod: string | null
  posted: boolean
  uuid: string | null
  serie: string | null
  folio: string | null
  source: ExpenseSource
  status: string
  createdAt: Date
}): ExpenseDTO {
  return {
    id: e.id,
    proveedorRfc: e.proveedorRfc,
    proveedorNombre: e.proveedorNombre,
    tipoTercero: e.tipoTercero,
    comprobanteTipo: e.comprobanteTipo,
    metodoPago: e.metodoPago,
    categoria: e.categoria,
    fechaEmision: e.fechaEmision.toISOString().slice(0, 10),
    fechaPago: e.fechaPago ? e.fechaPago.toISOString().slice(0, 10) : null,
    subtotalCents: e.subtotalCents,
    descuentoCents: e.descuentoCents,
    ivaCents: e.ivaCents,
    iva16Cents: e.iva16Cents,
    iva8Cents: e.iva8Cents,
    iepsCents: e.iepsCents,
    isrRetenidoCents: e.isrRetenidoCents,
    ivaRetenidoCents: e.ivaRetenidoCents,
    totalCents: e.totalCents,
    deducible: e.deducible,
    ivaAcreditable: e.ivaAcreditable,
    paymentStatus: e.paymentStatus,
    paidCents: e.paidCents,
    paidPeriod: e.paidPeriod,
    posted: e.posted,
    uuid: e.uuid,
    serie: e.serie,
    folio: e.folio,
    source: e.source,
    status: e.status,
    createdAt: e.createdAt.toISOString(),
  }
}

/**
 * Registra un gasto / CFDI recibido. Valida el cuadre del comprobante al centavo, normaliza el
 * RFC del proveedor, deriva el tipo de tercero y deduplica por folio fiscal. Idempotente por
 * (org, rfc, uuid) y (org, rfc, dedupeKey).
 */
export async function createExpense(venueId: string, input: CreateExpenseInput, actor: { staffId?: string | null }): Promise<ExpenseDTO> {
  const scope = await requireScope(venueId)

  // --- Validación de forma ---
  const proveedorRfc = (input.proveedorRfc ?? '').toUpperCase().trim()
  if (!proveedorRfc) throw new BadRequestError('El RFC del proveedor es requerido.')
  if (!input.proveedorNombre || !input.proveedorNombre.trim()) throw new BadRequestError('El nombre del proveedor es requerido.')
  if (!DATE_RE.test(input.fechaEmision)) throw new BadRequestError('La fecha de emisión debe tener formato AAAA-MM-DD.')
  if (input.fechaPago != null && input.fechaPago !== '' && !DATE_RE.test(input.fechaPago)) {
    throw new BadRequestError('La fecha de pago debe tener formato AAAA-MM-DD.')
  }

  // --- Money (centavos enteros, no negativos) ---
  const subtotalCents = input.subtotalCents
  const descuentoCents = input.descuentoCents ?? 0
  const ivaCents = input.ivaCents ?? 0
  const iva8Cents = input.iva8Cents ?? 0
  const iva0BaseCents = input.iva0BaseCents ?? 0
  const exentoBaseCents = input.exentoBaseCents ?? 0
  const iepsCents = input.iepsCents ?? 0
  const isrRetenidoCents = input.isrRetenidoCents ?? 0
  const ivaRetenidoCents = input.ivaRetenidoCents ?? 0
  const totalCents = input.totalCents
  const money = {
    subtotalCents,
    descuentoCents,
    ivaCents,
    iva8Cents,
    iva0BaseCents,
    exentoBaseCents,
    iepsCents,
    isrRetenidoCents,
    ivaRetenidoCents,
    totalCents,
  }
  for (const [k, v] of Object.entries(money)) {
    if (!isInt(v)) throw new BadRequestError(`El monto '${k}' debe ser un entero en centavos.`)
    if (v < 0) throw new BadRequestError(`El monto '${k}' no puede ser negativo.`)
  }
  if (subtotalCents <= 0) throw new BadRequestError('El subtotal del gasto debe ser mayor a cero.')
  if (totalCents <= 0) throw new BadRequestError('El total del gasto debe ser mayor a cero.')

  // Si no se desglosó el IVA por tasa, asume 16% (la tasa abrumadoramente común). La carga por
  // XML (slice 5) llena el desglose real por tasa; aquí es un default razonable para la DIOT.
  let iva16Cents = input.iva16Cents ?? 0
  if (ivaCents > 0 && iva16Cents === 0 && iva8Cents === 0) iva16Cents = ivaCents
  if (iva16Cents + iva8Cents > ivaCents) {
    throw new BadRequestError('La suma del IVA por tasa (16% + 8%) no puede exceder el IVA total.')
  }

  // --- Invariante de cuadre del comprobante (tolerancia 1¢) ---
  const computedTotal = subtotalCents - descuentoCents + ivaCents + iepsCents - ivaRetenidoCents - isrRetenidoCents
  if (Math.abs(computedTotal - totalCents) > 1) {
    throw new BadRequestError(
      `El comprobante no cuadra: subtotal − descuento + IVA + IEPS − retenciones = ${computedTotal}¢, pero el total es ${totalCents}¢.`,
    )
  }

  // --- Clasificación / derivaciones ---
  const tipoTercero = input.tipoTercero ?? deriveTipoTercero(proveedorRfc)
  const metodoPago: ExpenseMetodoPago = input.metodoPago ?? 'PUE'
  const uuid = input.uuid && input.uuid.trim() ? input.uuid.trim().toUpperCase() : null

  // Deducibilidad por DEFAULT según forma de pago, tipo de gasto e importe (LISR art. 27-III). No es un
  // "efectivo = no deducible" plano — depende del monto y del tipo de gasto (lo que pidió el contador):
  //   · Efectivo ≤ $2,000 por operación → SÍ deducible.
  //   · Efectivo > $2,000 → NO deducible (debe pagarse por medio electrónico).
  //   · Combustible en efectivo → NO deducible a cualquier monto (siempre requiere pago electrónico).
  //   · Pago electrónico → deducible.
  // Siempre se puede forzar con `deducible`/`ivaAcreditable` explícitos. El IVA acreditable sigue a la
  // deducibilidad (si el gasto no es deducible para ISR, su IVA tampoco es acreditable).
  const categoria = input.categoria ?? 'GASTO_GENERAL'
  const paidCash = (input.formaPago ?? null) === '01'
  const CASH_DEDUCTION_LIMIT_CENTS = 2000_00
  let defaultDeducible = true
  if (paidCash) {
    if (categoria === 'COMBUSTIBLE') defaultDeducible = false
    else if (totalCents > CASH_DEDUCTION_LIMIT_CENTS) defaultDeducible = false
  }

  // --- Estado de pago (cash-basis) ---
  const paid = input.paid ?? metodoPago === 'PUE'
  let paymentStatus: ExpensePaymentStatus = 'UNPAID'
  let fechaPagoStr: string | null = null
  let paidCents = 0
  let paidPeriod: string | null = null
  if (paid) {
    paymentStatus = 'PAID'
    fechaPagoStr = input.fechaPago && input.fechaPago !== '' ? input.fechaPago : input.fechaEmision
    paidCents = totalCents
    paidPeriod = fechaPagoStr.slice(0, 7) // 'YYYY-MM' directo del string (sin parse → sin drift de zona)
  }

  // Fechas como mediodía UTC: el día no se corre por zona horaria (igual que postJournalEntry).
  const fechaEmision = new Date(`${input.fechaEmision}T12:00:00.000Z`)
  const fechaPago = fechaPagoStr ? new Date(`${fechaPagoStr}T12:00:00.000Z`) : null

  const dedupeKey = buildDedupeKey({ uuid, proveedorRfc, fechaEmision: input.fechaEmision, totalCents, folio: input.folio })

  try {
    const created = await prisma.expense.create({
      data: {
        organizationId: scope.organizationId,
        rfc: scope.rfc,
        venueId: input.venueId ?? venueId,
        proveedorRfc,
        proveedorNombre: input.proveedorNombre.trim(),
        proveedorRegimen: input.proveedorRegimen ?? null,
        tipoTercero,
        comprobanteTipo: input.comprobanteTipo ?? 'INGRESO',
        usoCfdi: input.usoCfdi ?? null,
        metodoPago,
        formaPago: input.formaPago ?? null,
        categoria,
        fechaEmision,
        fechaPago,
        subtotalCents,
        descuentoCents,
        ivaCents,
        iva16Cents,
        iva8Cents,
        iva0BaseCents,
        exentoBaseCents,
        iepsCents,
        isrRetenidoCents,
        ivaRetenidoCents,
        totalCents,
        taxBreakdown: input.taxBreakdown ?? Prisma.JsonNull,
        deducible: input.deducible ?? defaultDeducible,
        ivaAcreditable: input.ivaAcreditable ?? defaultDeducible,
        paymentStatus,
        paidCents,
        paidPeriod,
        uuid,
        serie: input.serie ?? null,
        folio: input.folio ?? null,
        source: input.source ?? 'MANUAL',
        xmlUrl: input.xmlUrl ?? null,
        pdfUrl: input.pdfUrl ?? null,
        supplierId: input.supplierId ?? null,
        dedupeKey,
        createdById: actor.staffId ?? null,
      },
    })

    await logAction({
      action: 'EXPENSE_CREATED',
      entity: 'Expense',
      entityId: created.id,
      staffId: actor.staffId ?? null,
      venueId,
      data: { proveedorRfc, totalCents, metodoPago, paymentStatus, uuid },
    })

    return mapExpense(created)
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new BadRequestError('Este gasto ya fue registrado (folio fiscal o comprobante duplicado).')
    }
    throw e
  }
}

export interface ListExpensesFilters {
  /** Mes 'YYYY-MM' — filtra por fecha de EMISIÓN. */
  period?: string
  paymentStatus?: ExpensePaymentStatus
  proveedorRfc?: string
  /** Incluye cancelados (default: solo REGISTERED). */
  includeCancelled?: boolean
  limit?: number
}

export interface ListExpensesResult {
  needsFiscalSetup: boolean
  organizationId: string | null
  rfc: string | null
  expenses: ExpenseDTO[]
  summary: { count: number; totalCents: number; ivaCents: number; deducibleCents: number }
}

/** Lista los gastos del contribuyente (todos los locales del RFC) con un resumen agregado. */
export async function listExpenses(venueId: string, filters: ListExpensesFilters = {}): Promise<ListExpensesResult> {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) {
    return {
      needsFiscalSetup: true,
      organizationId: null,
      rfc: null,
      expenses: [],
      summary: { count: 0, totalCents: 0, ivaCents: 0, deducibleCents: 0 },
    }
  }

  const where: Prisma.ExpenseWhereInput = { organizationId: scope.organizationId, rfc: scope.rfc }
  if (!filters.includeCancelled) where.status = 'REGISTERED'
  if (filters.paymentStatus) where.paymentStatus = filters.paymentStatus
  if (filters.proveedorRfc) where.proveedorRfc = filters.proveedorRfc.toUpperCase().trim()
  if (filters.period) {
    if (!/^\d{4}-\d{2}$/.test(filters.period)) throw new BadRequestError("El periodo debe tener formato 'AAAA-MM'.")
    // Rango UTC [primer día 00:00Z, primer día del mes siguiente 00:00Z): captura todos los
    // fechaEmision (almacenados a mediodía UTC) del mes sin drift de zona horaria.
    const start = new Date(`${filters.period}-01T00:00:00.000Z`)
    const end = new Date(start)
    end.setUTCMonth(end.getUTCMonth() + 1)
    where.fechaEmision = { gte: start, lt: end }
  }

  const rows = await prisma.expense.findMany({
    where,
    orderBy: { fechaEmision: 'desc' },
    take: filters.limit && filters.limit > 0 ? Math.min(filters.limit, 500) : 200,
  })

  const summary = rows.reduce(
    (acc, r) => {
      acc.count += 1
      acc.totalCents += r.totalCents
      acc.ivaCents += r.ivaCents
      if (r.deducible) acc.deducibleCents += r.subtotalCents - r.descuentoCents + r.iepsCents
      return acc
    },
    { count: 0, totalCents: 0, ivaCents: 0, deducibleCents: 0 },
  )

  return { needsFiscalSetup: false, organizationId: scope.organizationId, rfc: scope.rfc, expenses: rows.map(mapExpense), summary }
}

/**
 * Importa un gasto desde el XML de un CFDI recibido. Resuelve el RFC del contribuyente (receptor),
 * parsea el CFDI (valida que el receptor seamos nosotros), y crea el gasto. Reusa toda la validación
 * de createExpense (cuadre, dedupe por UUID, estado de pago).
 */
export async function importExpenseFromXml(venueId: string, xml: string, actor: { staffId?: string | null }): Promise<ExpenseDTO> {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) {
    throw new BadRequestError('Este local aún no tiene un RFC/emisor fiscal configurado. Configura la facturación (CFDI) primero.')
  }
  const input = parseCfdiXml(xml, scope.rfc)
  return createExpense(venueId, { ...input, venueId }, actor)
}

export interface AcreditableResult {
  organizationId: string
  rfc: string
  period: string
  /** IVA acreditable PAGADO en el periodo (LIVA art 5-I + 1-B, cash-basis). Reduce el IVA a cargo. */
  acreditablePagadoCents: number
  /** IVA que NOSOTROS retuvimos a proveedores en el periodo — obligación SEPARADA a enterar (no resta al IVA a cargo). */
  ivaRetenidoTercerosCents: number
  /** ISR que NOSOTROS retuvimos a proveedores en el periodo — obligación separada (informativo). */
  isrRetenidoTercerosCents: number
  /** Gastos PAGADOS y acreditables contados en el periodo. */
  expenseCount: number
}

/**
 * IVA acreditable pagado del contribuyente en el periodo (cash-basis). Suma `ivaCents` sobre los
 * gastos de TODOS los locales del RFC que son INGRESO, deducibles, con IVA acreditable, PAGADOS y
 * cuyo `paidPeriod` (mes de PAGO, no de emisión) == period, no cancelados. Llena el placeholder del
 * IVA-flujo. Devuelve null si el local aún no tiene RFC fiscal.
 */
export async function getAcreditablePagado(venueId: string, period: string): Promise<AcreditableResult | null> {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new BadRequestError("El periodo debe tener formato 'AAAA-MM'.")
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return null

  // Filtra por RFC (no por org): la declaración cubre TODOS los locales del contribuyente, aun en
  // otra organización Avoqado. El rfc se guarda normalizado (mayúsculas) al crear, igual que el scope.
  const agg = await prisma.expense.aggregate({
    where: {
      rfc: scope.rfc,
      status: 'REGISTERED',
      comprobanteTipo: 'INGRESO',
      deducible: true,
      ivaAcreditable: true,
      paymentStatus: 'PAID',
      paidPeriod: period,
    },
    _sum: { ivaCents: true, ivaRetenidoCents: true, isrRetenidoCents: true },
    _count: { _all: true },
  })

  return {
    organizationId: scope.organizationId,
    rfc: scope.rfc,
    period,
    acreditablePagadoCents: agg._sum.ivaCents ?? 0,
    ivaRetenidoTercerosCents: agg._sum.ivaRetenidoCents ?? 0,
    isrRetenidoTercerosCents: agg._sum.isrRetenidoCents ?? 0,
    expenseCount: agg._count._all,
  }
}
