import { JournalEntrySource, JournalEntryType, type PayrollPeriodicity } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'

import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { getMappings } from './accountMapping.service'
import { resolveScopeOrNull } from './chartOfAccounts.service'
import { applyTariff, ART96_MONTHLY } from './isr.service'
import { postJournalEntry } from './journalEntry.service'

/**
 * Nómina (sueldos y salarios, Capa B) — empleados + corrida de nómina + póliza. PREMIUM (bundle CFDI).
 *
 * Por empleado calcula: percepción → ISR a retener (tarifa art-96 mensual − subsidio para el empleo) →
 * cuota IMSS obrera → neto. La corrida persiste el snapshot y postea la póliza (601.01 sueldos · 216.01
 * ISR retenido · 216.07 IMSS retenido · 205.06 sueldos por pagar). Es una ESTIMACIÓN: el cálculo
 * definitivo (con todas las prestaciones, ajuste anual, IMSS exacto por SBC) lo hace el nominista.
 * Importes en centavos enteros.
 */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DEFAULT_TZ = 'America/Mexico_City'

/**
 * Subsidio para el empleo MENSUAL. **VERIFICADO por workflow de 4 noministas (verify-nomina-2026,
 * confidence high).** Desde el Decreto 01-may-2024 es un monto FIJO mensual (≈15.02% de la UMA 2026)
 * para ingreso gravado ≤ $11,492.66/mes, y $0 arriba. ⚠️ Enero-2026 usa UMA 2025 (~$536.21); Feb-Dic
 * = $535.65. Confirmar contra DOF/Anexo 8 RMF 2026 antes de timbrar nómina de producción.
 * El subsidio NO es percepción: se ACREDITA contra el ISR (reduce la retención; si excede, se ENTREGA
 * al trabajador y el patrón lo recupera contra el ISR de salarios a enterar).
 */
const SUBSIDIO_TABLE: { limInfCents: number; limSupCents: number; subsidioCents: number }[] = [
  { limInfCents: 0, limSupCents: 11_492_66, subsidioCents: 535_65 },
  { limInfCents: 11_492_67, limSupCents: Number.MAX_SAFE_INTEGER, subsidioCents: 0 },
]

/**
 * Cuota IMSS OBRERA (a cargo del trabajador) como % del Salario Base de Cotización. **VERIFICADO por
 * workflow.** Suma de los conceptos obrero (enf/maternidad especie+dinero, invalidez/vida, cesantía/vejez).
 * v1 usa el % combinado; el nominista ajusta por excedente de 3 UMA y topes.
 */
const IMSS_OBRERO_PCT = 0.02375

const round = (n: number) => Math.round(n)

/** Factor de la percepción mensual según la periodicidad de la corrida. */
function periodFactor(p: PayrollPeriodicity): number {
  if (p === 'QUINCENAL') return 0.5
  if (p === 'SEMANAL') return 7 / 30.4
  return 1
}

/** Subsidio para el empleo aplicable a una percepción mensual. */
function subsidioFor(percepcionMensualCents: number): number {
  for (const r of SUBSIDIO_TABLE)
    if (percepcionMensualCents >= r.limInfCents && percepcionMensualCents <= r.limSupCents) return r.subsidioCents
  return 0
}

export interface PayrollLineCalc {
  percepcionGravadaCents: number
  percepcionExentaCents: number
  totalPercepcionesCents: number
  isrCausadoCents: number
  subsidioCents: number
  /** Subsidio que EXCEDE al ISR y se entrega al trabajador (sube el neto; el patrón lo recupera). */
  subsidioEntregadoCents: number
  isrRetenidoCents: number
  imssObreroCents: number
  otrasDeduccionesCents: number
  netoCents: number
}

/**
 * Cálculo de un renglón de nómina para una percepción mensual gravada + SBC. La percepción ya viene
 * escalada a la periodicidad de la corrida; el ISR/subsidio usan la tarifa mensual (se escala el resultado).
 */
export function computePayrollLine(input: {
  salarioMensualBrutoCents: number
  sbcMensualCents?: number | null
  periodicidad: PayrollPeriodicity
}): PayrollLineCalc {
  const factor = periodFactor(input.periodicidad)
  const percepcionMensual = input.salarioMensualBrutoCents
  // ISR y subsidio se calculan en base MENSUAL y se escalan a la periodicidad (método simplificado v1).
  const isrCausadoMensual = applyTariff(percepcionMensual, ART96_MONTHLY)
  const subsidioMensual = subsidioFor(percepcionMensual)
  const isrRetenidoMensual = Math.max(0, isrCausadoMensual - subsidioMensual)
  const subsidioEntregadoMensual = Math.max(0, subsidioMensual - isrCausadoMensual)

  const sbc = input.sbcMensualCents ?? input.salarioMensualBrutoCents
  const imssMensual = round(sbc * IMSS_OBRERO_PCT)

  // Escala a la periodicidad de pago.
  const totalPercepcionesCents = round(percepcionMensual * factor)
  const isrRetenidoCents = round(isrRetenidoMensual * factor)
  const subsidioCents = round(subsidioMensual * factor)
  const subsidioEntregadoCents = round(subsidioEntregadoMensual * factor)
  const imssObreroCents = round(imssMensual * factor)
  // Otras deducciones (préstamos, pensión alimenticia, fondo de ahorro…): sin captura hoy → siempre 0.
  // 🔴 El día que se capturen (>0), la póliza se DESCUADRA salvo que se hagan TRES cosas juntas:
  //   1) restarlas del neto (ya contemplado en la fórmula de abajo),
  //   2) agregar una línea HABER `OTHER_DEDUCTIONS_PAYABLE` en `buildPayrollJournalLines` (+ su AccountMapping/catálogo),
  //   3) PERSISTIR `subsidioEntregado` en `PayrollRun` (la recuperación lo deriva del neto asumiendo otras=0).
  const otrasDeduccionesCents = 0
  // Neto = percepciones + subsidio entregado (cuando excede al ISR) − ISR retenido − IMSS − otras deducciones.
  const netoCents = totalPercepcionesCents - isrRetenidoCents - imssObreroCents + subsidioEntregadoCents - otrasDeduccionesCents

  return {
    percepcionGravadaCents: totalPercepcionesCents,
    percepcionExentaCents: 0,
    totalPercepcionesCents,
    isrCausadoCents: round(isrCausadoMensual * factor),
    subsidioCents,
    subsidioEntregadoCents,
    isrRetenidoCents,
    imssObreroCents,
    otrasDeduccionesCents,
    netoCents,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Empleados (master)
// ─────────────────────────────────────────────────────────────────────────────

export interface EmployeeDTO {
  id: string
  nombre: string
  rfcEmpleado: string
  curp: string | null
  nss: string | null
  puesto: string | null
  salarioMensualBrutoCents: number
  sbcMensualCents: number | null
  periodicidadPago: PayrollPeriodicity
  tipoContrato: string
  tipoRegimen: string
  claveEntFed: string | null
  numEmpleado: string | null
  registroPatronal: string | null
  salarioDiarioIntegradoCents: number | null
  fechaIngreso: string | null
  activo: boolean
}

export interface CreateEmployeeInput {
  nombre: string
  rfcEmpleado: string
  curp?: string | null
  nss?: string | null
  puesto?: string | null
  salarioMensualBrutoCents: number
  sbcMensualCents?: number | null
  periodicidadPago?: PayrollPeriodicity
  // Datos fiscales para el CFDI de nómina (opcionales; claveEntFed requerido para timbrar).
  tipoContrato?: string
  tipoRegimen?: string
  claveEntFed?: string | null
  numEmpleado?: string | null
  registroPatronal?: string | null
  salarioDiarioIntegradoCents?: number | null
  fechaIngreso?: string | null
  activo?: boolean
  venueId?: string | null
}

function mapEmployee(e: {
  id: string
  nombre: string
  rfcEmpleado: string
  curp: string | null
  nss: string | null
  puesto: string | null
  salarioMensualBrutoCents: number
  sbcMensualCents: number | null
  periodicidadPago: PayrollPeriodicity
  tipoContrato: string
  tipoRegimen: string
  claveEntFed: string | null
  numEmpleado: string | null
  registroPatronal: string | null
  salarioDiarioIntegradoCents: number | null
  fechaIngreso: Date | null
  activo: boolean
}): EmployeeDTO {
  return {
    id: e.id,
    nombre: e.nombre,
    rfcEmpleado: e.rfcEmpleado,
    curp: e.curp,
    nss: e.nss,
    puesto: e.puesto,
    salarioMensualBrutoCents: e.salarioMensualBrutoCents,
    sbcMensualCents: e.sbcMensualCents,
    periodicidadPago: e.periodicidadPago,
    tipoContrato: e.tipoContrato,
    tipoRegimen: e.tipoRegimen,
    claveEntFed: e.claveEntFed,
    numEmpleado: e.numEmpleado,
    registroPatronal: e.registroPatronal,
    salarioDiarioIntegradoCents: e.salarioDiarioIntegradoCents,
    fechaIngreso: e.fechaIngreso ? e.fechaIngreso.toISOString().slice(0, 10) : null,
    activo: e.activo,
  }
}

async function requireScope(venueId: string) {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope)
    throw new BadRequestError('Este local aún no tiene un RFC/emisor fiscal configurado. Configura la facturación (CFDI) primero.')
  return scope
}

/** Da de alta un empleado. Scope = patrón (org, rfc). */
export async function createEmployee(
  venueId: string,
  input: CreateEmployeeInput,
  actor: { staffId?: string | null },
): Promise<EmployeeDTO> {
  const scope = await requireScope(venueId)
  const rfcEmpleado = (input.rfcEmpleado ?? '').toUpperCase().trim()
  if (!input.nombre?.trim()) throw new BadRequestError('El nombre del empleado es requerido.')
  if (!rfcEmpleado) throw new BadRequestError('El RFC del empleado es requerido.')
  if (!Number.isInteger(input.salarioMensualBrutoCents) || input.salarioMensualBrutoCents <= 0) {
    throw new BadRequestError('El salario mensual bruto debe ser un entero en centavos mayor a cero.')
  }
  if (input.fechaIngreso && !/^\d{4}-\d{2}-\d{2}$/.test(input.fechaIngreso))
    throw new BadRequestError('La fecha de ingreso debe tener formato AAAA-MM-DD.')

  try {
    const created = await prisma.employee.create({
      data: {
        organizationId: scope.organizationId,
        rfc: scope.rfc,
        venueId: input.venueId ?? venueId,
        nombre: input.nombre.trim(),
        rfcEmpleado,
        curp: input.curp ?? null,
        nss: input.nss ?? null,
        puesto: input.puesto ?? null,
        salarioMensualBrutoCents: input.salarioMensualBrutoCents,
        sbcMensualCents: input.sbcMensualCents ?? null,
        periodicidadPago: input.periodicidadPago ?? 'MENSUAL',
        tipoContrato: input.tipoContrato ?? '01',
        tipoRegimen: input.tipoRegimen ?? '02',
        claveEntFed: input.claveEntFed ?? null,
        numEmpleado: input.numEmpleado ?? null,
        registroPatronal: input.registroPatronal ?? null,
        salarioDiarioIntegradoCents: input.salarioDiarioIntegradoCents ?? null,
        fechaIngreso: input.fechaIngreso ? new Date(`${input.fechaIngreso}T12:00:00.000Z`) : null,
        activo: input.activo ?? true,
        createdById: actor.staffId ?? null,
      },
    })
    await logAction({
      action: 'EMPLOYEE_CREATED',
      entity: 'Employee',
      entityId: created.id,
      staffId: actor.staffId ?? null,
      venueId,
      data: { rfcEmpleado, nombre: created.nombre },
    })
    return mapEmployee(created)
  } catch (e: any) {
    if (e?.code === 'P2002') throw new BadRequestError('Ya existe un empleado con ese RFC para este patrón.')
    throw e
  }
}

export interface EmployeesResult {
  needsFiscalSetup: boolean
  rfc: string | null
  employees: EmployeeDTO[]
}

/** Lista los empleados del patrón (activos por defecto). */
export async function listEmployees(venueId: string, opts: { includeInactive?: boolean } = {}): Promise<EmployeesResult> {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return { needsFiscalSetup: true, rfc: null, employees: [] }
  const rows = await prisma.employee.findMany({
    where: { organizationId: scope.organizationId, rfc: scope.rfc, ...(opts.includeInactive ? {} : { activo: true }) },
    orderBy: { nombre: 'asc' },
  })
  return { needsFiscalSetup: false, rfc: scope.rfc, employees: rows.map(mapEmployee) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Corrida de nómina
// ─────────────────────────────────────────────────────────────────────────────

export interface PayrollPreviewLine extends PayrollLineCalc {
  employeeId: string
  nombre: string
  rfcEmpleado: string
}

export interface PayrollTotals {
  empleados: number
  percepcionesCents: number
  isrCents: number
  subsidioCents: number
  subsidioEntregadoCents: number
  imssCents: number
  netoCents: number
}

export interface PayrollPreview {
  needsFiscalSetup: boolean
  rfc: string | null
  period: string
  periodicidad: PayrollPeriodicity
  lines: PayrollPreviewLine[]
  totals: PayrollTotals
}

const emptyTotals = (): PayrollTotals => ({
  empleados: 0,
  percepcionesCents: 0,
  isrCents: 0,
  subsidioCents: 0,
  subsidioEntregadoCents: 0,
  imssCents: 0,
  netoCents: 0,
})

/** Preview del cálculo de nómina del periodo para los empleados activos (no persiste). */
export async function computePayrollPreview(
  venueId: string,
  period: string,
  periodicidad: PayrollPeriodicity = 'MENSUAL',
): Promise<PayrollPreview> {
  if (!PERIOD_RE.test(period)) throw new BadRequestError('El periodo debe tener formato AAAA-MM (mes 01-12).')
  const scope = await resolveScopeOrNull(venueId)
  const base: PayrollPreview = {
    needsFiscalSetup: scope === null,
    rfc: scope?.rfc ?? null,
    period,
    periodicidad,
    lines: [],
    totals: emptyTotals(),
  }
  if (!scope) return base

  // Sólo los empleados de ESTA periodicidad. Si no se filtra, una corrida SEMANAL/QUINCENAL barre a
  // los empleados mensuales y los escala con el periodFactor equivocado (defecto del audit C4).
  const employees = await prisma.employee.findMany({
    where: { organizationId: scope.organizationId, rfc: scope.rfc, activo: true, periodicidadPago: periodicidad },
    orderBy: { nombre: 'asc' },
  })
  for (const e of employees) {
    const calc = computePayrollLine({
      salarioMensualBrutoCents: e.salarioMensualBrutoCents,
      sbcMensualCents: e.sbcMensualCents,
      periodicidad,
    })
    base.lines.push({ employeeId: e.id, nombre: e.nombre, rfcEmpleado: e.rfcEmpleado, ...calc })
    base.totals.empleados += 1
    base.totals.percepcionesCents += calc.totalPercepcionesCents
    base.totals.isrCents += calc.isrRetenidoCents
    base.totals.subsidioCents += calc.subsidioCents
    base.totals.subsidioEntregadoCents += calc.subsidioEntregadoCents
    base.totals.imssCents += calc.imssObreroCents
    base.totals.netoCents += calc.netoCents
  }
  return base
}

export interface RunPayrollResult {
  needsFiscalSetup: boolean
  missingMappings: string[]
  alreadyExists: boolean
  payrollRunId: string | null
  posted: boolean
  totals: PayrollPreview['totals']
}

const PAYROLL_MOVEMENTS = ['PAYROLL_SALARIES', 'ISR_PAYROLL_WITHHELD', 'IMSS_PAYABLE', 'SALARIES_PAYABLE'] as const

/**
 * Líneas de la póliza de nómina a partir de los totales. DEBE sueldos (percepciones) [+ DEBE 216.01
 * subsidio entregado, que el patrón recupera] · HABER ISR ret · HABER IMSS ret · HABER sueldos por
 * pagar (neto). Cuadra por la identidad del neto: neto = percepciones + subsidioEntregado − isr − imss.
 */
function buildPayrollJournalLines(
  acct: Map<string, string>,
  t: { percepcionesCents: number; subsidioEntregadoCents: number; isrCents: number; imssCents: number; netoCents: number },
) {
  return [
    { ledgerAccountId: acct.get('PAYROLL_SALARIES')!, debitCents: t.percepcionesCents, creditCents: 0 },
    { ledgerAccountId: acct.get('ISR_PAYROLL_WITHHELD')!, debitCents: t.subsidioEntregadoCents, creditCents: 0 },
    { ledgerAccountId: acct.get('ISR_PAYROLL_WITHHELD')!, debitCents: 0, creditCents: t.isrCents },
    { ledgerAccountId: acct.get('IMSS_PAYABLE')!, debitCents: 0, creditCents: t.imssCents },
    { ledgerAccountId: acct.get('SALARIES_PAYABLE')!, debitCents: 0, creditCents: t.netoCents },
  ].filter(l => l.debitCents > 0 || l.creditCents > 0)
}

/**
 * Postea la póliza de una corrida y la marca POSTED. Idempotente por `payroll:<runId>:v1`: si la póliza
 * ya existía (p. ej. el posteo había quedado a medias), postJournalEntry devuelve la existente y aquí
 * sólo se completa el marcado POSTED. El posteo va ANTES del update, así que una corrida nunca queda
 * marcada POSTED sin su póliza.
 */
async function postAndMarkPayrollRun(args: {
  venueId: string
  runId: string
  date: string
  lines: { ledgerAccountId: string; debitCents: number; creditCents: number }[]
  period: string
  periodicidad: PayrollPeriodicity
  empleados: number
  netoCents: number
  actorStaffId: string | null
}): Promise<void> {
  const dto = await postJournalEntry(
    args.venueId,
    {
      date: args.date,
      type: JournalEntryType.EGRESO,
      source: JournalEntrySource.EXPENSE,
      sourceId: args.runId,
      idempotencyKey: `payroll:${args.runId}:v1`,
      concept: `Nómina ${args.period} (${args.periodicidad.toLowerCase()})`,
      venueId: args.venueId,
      lines: args.lines,
    },
    { staffId: args.actorStaffId },
  )
  await prisma.payrollRun.update({ where: { id: args.runId }, data: { posted: true, status: 'POSTED', journalEntryId: dto.id } })
  await logAction({
    action: 'PAYROLL_RUN_POSTED',
    entity: 'PayrollRun',
    entityId: args.runId,
    staffId: args.actorStaffId,
    venueId: args.venueId,
    data: { period: args.period, periodicidad: args.periodicidad, empleados: args.empleados, netoCents: args.netoCents },
  })
}

/**
 * Corre la nómina del periodo: calcula, persiste PayrollRun + PayrollLine y postea la póliza
 * (601.01 sueldos · 216.01 ISR ret · 216.07 IMSS ret · 205.06 sueldos por pagar). Idempotente por
 * (org, rfc, period, periodicidad) — re-correr devuelve la existente; si la existente quedó SIN postear
 * (la póliza falló o el marcado no se completó), se recupera re-disparando el posteo en vez de dejarla
 * atascada en DRAFT.
 */
export async function runPayroll(
  venueId: string,
  period: string,
  periodicidad: PayrollPeriodicity,
  fechaPago: string,
  actor: { staffId?: string | null },
): Promise<RunPayrollResult> {
  if (!PERIOD_RE.test(period)) throw new BadRequestError('El periodo debe tener formato AAAA-MM (mes 01-12).')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaPago)) throw new BadRequestError('La fecha de pago debe tener formato AAAA-MM-DD.')

  const base: RunPayrollResult = {
    needsFiscalSetup: false,
    missingMappings: [],
    alreadyExists: false,
    payrollRunId: null,
    posted: false,
    totals: emptyTotals(),
  }
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return { ...base, needsFiscalSetup: true }

  // Idempotencia: una corrida por (org, rfc, period, periodicidad).
  const existing = await prisma.payrollRun.findUnique({
    where: { organizationId_rfc_period_periodicidad: { organizationId: scope.organizationId, rfc: scope.rfc, period, periodicidad } },
  })
  if (existing) {
    // El venueId que CREÓ la corrida (su centro de costos), NO el del llamador — que podría ser otro
    // local del mismo (org,rfc), ya que la corrida es idempotente por (org,rfc,period,periodicidad).
    const runVenueId = existing.venueId ?? venueId
    // Subsidio entregado: no se persiste en PayrollRun, pero se deriva EXACTO de la identidad del neto
    // (neto = percepciones + subsidioEntregado − isr − imss). Sirve para el retorno Y para reconstruir
    // la póliza en la recuperación, sin recalcular contra empleados (que pudieron cambiar) → sin drift.
    const subsidioEntregadoCents =
      existing.totalNetoCents - existing.totalPercepcionesCents + existing.totalIsrCents + existing.totalImssObreroCents
    const existingTotals = {
      empleados: existing.empleados,
      percepcionesCents: existing.totalPercepcionesCents,
      isrCents: existing.totalIsrCents,
      subsidioCents: existing.totalSubsidioCents,
      subsidioEntregadoCents,
      imssCents: existing.totalImssObreroCents,
      netoCents: existing.totalNetoCents,
    }
    // Recuperación: una corrida previa quedó SIN postear (la póliza falló, o el marcado POSTED no se
    // completó tras postearla). NO la dejamos atascada en DRAFT: re-disparamos el posteo —idempotente
    // por `payroll:<id>:v1`, así que si la póliza ya existía no se duplica— y la marcamos POSTED.
    if (!existing.posted) {
      const mapResult = await getMappings(runVenueId)
      const acct = new Map<string, string>()
      for (const m of mapResult.mappings) if (m.account) acct.set(m.movementType, m.account.id)
      const missing = PAYROLL_MOVEMENTS.filter(m => !acct.has(m))
      if (missing.length > 0) {
        return { ...base, alreadyExists: true, payrollRunId: existing.id, posted: false, missingMappings: missing, totals: existingTotals }
      }

      const venue = await prisma.venue.findUnique({ where: { id: runVenueId }, select: { timezone: true } })
      const tz = venue?.timezone || DEFAULT_TZ
      const lines = buildPayrollJournalLines(acct, {
        percepcionesCents: existing.totalPercepcionesCents,
        subsidioEntregadoCents,
        isrCents: existing.totalIsrCents,
        imssCents: existing.totalImssObreroCents,
        netoCents: existing.totalNetoCents,
      })
      await postAndMarkPayrollRun({
        venueId: runVenueId,
        runId: existing.id,
        date: formatInTimeZone(existing.fechaPago, tz, 'yyyy-MM-dd'),
        lines,
        period,
        periodicidad,
        empleados: existing.empleados,
        netoCents: existing.totalNetoCents,
        actorStaffId: actor.staffId ?? null,
      })
      return { ...base, alreadyExists: true, payrollRunId: existing.id, posted: true, totals: existingTotals }
    }
    return { ...base, alreadyExists: true, payrollRunId: existing.id, posted: existing.posted, totals: existingTotals }
  }

  const preview = await computePayrollPreview(venueId, period, periodicidad)
  if (preview.lines.length === 0) return base // sin empleados activos
  base.totals = preview.totals

  // Mapeos requeridos para la póliza.
  const mapResult = await getMappings(venueId)
  const acct = new Map<string, string>()
  for (const m of mapResult.mappings) if (m.account) acct.set(m.movementType, m.account.id)
  const missing = PAYROLL_MOVEMENTS.filter(m => !acct.has(m))
  if (missing.length > 0) return { ...base, missingMappings: missing }

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const tz = venue?.timezone || DEFAULT_TZ

  // Corrida + renglones en UNA transacción → nunca una corrida sin sus líneas. La póliza se postea
  // DESPUÉS (postJournalEntry abre su propia tx Serializable); si fallara, la corrida queda en DRAFT
  // y la PRÓXIMA llamada la recupera por el bloque `existing` de arriba — nunca queda POSTED sin póliza.
  const run = await prisma.$transaction(async tx => {
    const created = await tx.payrollRun.create({
      data: {
        organizationId: scope.organizationId,
        rfc: scope.rfc,
        venueId,
        period,
        periodicidad,
        fechaPago: new Date(`${fechaPago}T12:00:00.000Z`),
        empleados: preview.totals.empleados,
        totalPercepcionesCents: preview.totals.percepcionesCents,
        totalIsrCents: preview.totals.isrCents,
        totalSubsidioCents: preview.totals.subsidioCents,
        totalImssObreroCents: preview.totals.imssCents,
        totalNetoCents: preview.totals.netoCents,
        createdById: actor.staffId ?? null,
      },
    })
    await tx.payrollLine.createMany({
      data: preview.lines.map(l => ({
        payrollRunId: created.id,
        employeeId: l.employeeId,
        nombre: l.nombre,
        rfcEmpleado: l.rfcEmpleado,
        percepcionGravadaCents: l.percepcionGravadaCents,
        percepcionExentaCents: l.percepcionExentaCents,
        totalPercepcionesCents: l.totalPercepcionesCents,
        isrCents: l.isrRetenidoCents,
        subsidioCents: l.subsidioCents,
        imssObreroCents: l.imssObreroCents,
        otrasDeduccionesCents: l.otrasDeduccionesCents,
        netoCents: l.netoCents,
      })),
    })
    return created
  })

  const lines = buildPayrollJournalLines(acct, {
    percepcionesCents: preview.totals.percepcionesCents,
    subsidioEntregadoCents: preview.totals.subsidioEntregadoCents,
    isrCents: preview.totals.isrCents,
    imssCents: preview.totals.imssCents,
    netoCents: preview.totals.netoCents,
  })
  await postAndMarkPayrollRun({
    venueId,
    runId: run.id,
    date: formatInTimeZone(new Date(`${fechaPago}T12:00:00.000Z`), tz, 'yyyy-MM-dd'),
    lines,
    period,
    periodicidad,
    empleados: preview.totals.empleados,
    netoCents: preview.totals.netoCents,
    actorStaffId: actor.staffId ?? null,
  })

  return { ...base, payrollRunId: run.id, posted: true }
}
