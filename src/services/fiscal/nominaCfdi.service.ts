import { type Employee, type PayrollLine, type PayrollPeriodicity, type PayrollRun } from '@prisma/client'

import { BadRequestError } from '../../errors/AppError'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { resolveScopeOrNull } from './chartOfAccounts.service'
import { decryptProviderKey } from './fiscalKey.service'
import { FacturapiProvider } from './providers/facturapi.provider'
import type { PayrollReceiptParams } from './providers/fiscal-provider.interface'

/**
 * CFDI de NÓMINA (recibo timbrado) — CFDI 4.0 tipo "N" + complemento Nómina 1.2 por empleado.
 *
 * Construye el payload del recibo desde la corrida de nómina (PayrollRun + PayrollLine) y lo timbra
 * con el PAC del emisor (Facturapi). El cálculo (ISR/IMSS/subsidio) ya lo hizo `nomina.service`; aquí
 * sólo se mapea a las claves SAT (c_TipoPercepcion/Deduccion/OtroPago) y se timbra. Requiere que el
 * emisor tenga su CSD ACTIVO. Gated PREMIUM (CFDI). Es una ESTIMACIÓN: el nominista valida antes de timbrar producción.
 */

// PayrollPeriodicity → c_PeriodicidadPago del SAT.
const PERIODICIDAD_SAT: Record<PayrollPeriodicity, string> = { SEMANAL: '02', QUINCENAL: '03', MENSUAL: '04' }
const DIAS_PAGADOS: Record<PayrollPeriodicity, number> = { SEMANAL: 7, QUINCENAL: 15, MENSUAL: 30 }

/** Último día del mes de un periodo 'YYYY-MM'. */
function lastDayOfPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${period}-${String(last).padStart(2, '0')}`
}

/**
 * Arma los parámetros del recibo de nómina de un empleado (función PURA, testeable). Mapea el cálculo
 * a las claves SAT. El subsidio para el empleo va en OtrosPagos (clave 002), no en deducciones.
 */
export function buildPayrollReceiptParams(
  employee: Pick<
    Employee,
    | 'rfcEmpleado'
    | 'nombre'
    | 'curp'
    | 'nss'
    | 'puesto'
    | 'tipoContrato'
    | 'tipoRegimen'
    | 'claveEntFed'
    | 'numEmpleado'
    | 'registroPatronal'
    | 'sbcMensualCents'
    | 'salarioDiarioIntegradoCents'
    | 'fechaIngreso'
    | 'id'
  >,
  line: Pick<
    PayrollLine,
    'id' | 'percepcionGravadaCents' | 'percepcionExentaCents' | 'isrCents' | 'imssObreroCents' | 'subsidioCents' | 'otrasDeduccionesCents'
  >,
  run: Pick<PayrollRun, 'period' | 'periodicidad' | 'fechaPago'>,
  receptorCodigoPostal: string,
): PayrollReceiptParams {
  const deducciones = [
    { clave: '002', concepto: 'ISR', importeCents: line.isrCents },
    { clave: '001', concepto: 'Seguridad social (IMSS)', importeCents: line.imssObreroCents },
    { clave: '004', concepto: 'Otras deducciones', importeCents: line.otrasDeduccionesCents },
  ].filter(d => d.importeCents > 0)

  const otrosPagos =
    line.subsidioCents > 0
      ? [{ clave: '002', concepto: 'Subsidio para el empleo', importeCents: line.subsidioCents, subsidioCausadoCents: line.subsidioCents }]
      : []

  return {
    receptor: {
      rfc: employee.rfcEmpleado,
      nombre: employee.nombre,
      curp: employee.curp,
      numSeguridadSocial: employee.nss,
      fechaInicioRelLaboral: employee.fechaIngreso ? employee.fechaIngreso.toISOString().slice(0, 10) : null,
      tipoContrato: employee.tipoContrato,
      tipoRegimen: employee.tipoRegimen,
      numEmpleado: employee.numEmpleado ?? employee.id.slice(-8),
      periodicidadPago: PERIODICIDAD_SAT[run.periodicidad],
      claveEntFed: employee.claveEntFed ?? '',
      salarioBaseCotAporCents: employee.sbcMensualCents,
      salarioDiarioIntegradoCents:
        employee.salarioDiarioIntegradoCents ?? (employee.sbcMensualCents ? Math.round(employee.sbcMensualCents / 30) : null),
      puesto: employee.puesto,
      codigoPostal: receptorCodigoPostal,
    },
    registroPatronal: employee.registroPatronal,
    tipoNomina: 'O',
    fechaPago: run.fechaPago.toISOString().slice(0, 10),
    fechaInicialPago: `${run.period}-01`,
    fechaFinalPago: lastDayOfPeriod(run.period),
    numDiasPagados: DIAS_PAGADOS[run.periodicidad],
    percepciones: [
      {
        clave: '001',
        concepto: 'Sueldos, Salarios Rayas y Jornales',
        gravadoCents: line.percepcionGravadaCents,
        exentoCents: line.percepcionExentaCents,
      },
    ],
    deducciones,
    otrosPagos,
    idempotencyKey: `payroll-cfdi:${line.id}:v1`,
  }
}

export interface StampPayrollResult {
  needsFiscalSetup: boolean
  needsCsd: boolean
  stamped: number
  alreadyStamped: number
  errors: { employeeId: string; nombre: string; error: string }[]
}

/**
 * Timbra los recibos de nómina de una corrida POSTED. Por cada renglón aún sin timbrar arma el payload
 * y lo manda al PAC; guarda el folio fiscal (UUID) en el PayrollLine. Idempotente (salta los STAMPED).
 * Requiere el CSD del emisor ACTIVO.
 */
export async function stampPayrollReceipts(
  venueId: string,
  payrollRunId: string,
  actor: { staffId?: string | null },
): Promise<StampPayrollResult> {
  const base: StampPayrollResult = { needsFiscalSetup: false, needsCsd: false, stamped: 0, alreadyStamped: 0, errors: [] }
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return { ...base, needsFiscalSetup: true }

  const run = await prisma.payrollRun.findFirst({
    where: { id: payrollRunId, organizationId: scope.organizationId, rfc: scope.rfc, status: 'POSTED' },
  })
  if (!run) throw new BadRequestError('La corrida de nómina no existe o aún no está posteada.')

  // Emisor + CSD (provider key encriptada). Sin CSD ACTIVO no se puede timbrar.
  const emisor = await prisma.fiscalEmisor.findFirst({
    where: { venueId },
    select: { provider: true, providerKeyEnc: true, csdStatus: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!emisor || !emisor.providerKeyEnc || emisor.csdStatus !== 'ACTIVE') {
    return { ...base, needsCsd: true }
  }

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { zipCode: true } })
  const receptorCp = venue?.zipCode || '00000'
  const provider = new FacturapiProvider(decryptProviderKey(emisor.providerKeyEnc))
  if (!provider.createPayrollReceipt) return { ...base, needsCsd: true }

  const lines = await prisma.payrollLine.findMany({ where: { payrollRunId: run.id } })
  for (const line of lines) {
    if (line.cfdiStatus === 'STAMPED') {
      base.alreadyStamped++
      continue
    }
    const employee = await prisma.employee.findUnique({ where: { id: line.employeeId } })
    if (!employee) {
      base.errors.push({ employeeId: line.employeeId, nombre: line.nombre, error: 'Empleado no encontrado.' })
      continue
    }
    if (!employee.claveEntFed) {
      const msg = 'Falta la clave de entidad federativa (estado) del empleado.'
      await prisma.payrollLine.update({ where: { id: line.id }, data: { cfdiStatus: 'ERROR', cfdiError: msg } })
      base.errors.push({ employeeId: employee.id, nombre: employee.nombre, error: msg })
      continue
    }
    try {
      const params = buildPayrollReceiptParams(employee, line, run, receptorCp)
      const stamped = await provider.createPayrollReceipt!(params)
      await prisma.payrollLine.update({
        where: { id: line.id },
        data: { cfdiStatus: 'STAMPED', cfdiUuid: stamped.uuid, cfdiProviderId: stamped.providerInvoiceId, cfdiError: null },
      })
      base.stamped++
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[nomina-cfdi] stamp failed for line ${line.id}: ${msg}`)
      await prisma.payrollLine.update({ where: { id: line.id }, data: { cfdiStatus: 'ERROR', cfdiError: msg.slice(0, 500) } })
      base.errors.push({ employeeId: employee.id, nombre: employee.nombre, error: msg.slice(0, 200) })
    }
  }

  await logAction({
    action: 'PAYROLL_RECEIPTS_STAMPED',
    entity: 'PayrollRun',
    entityId: run.id,
    staffId: actor.staffId ?? null,
    venueId,
    data: { period: run.period, stamped: base.stamped, alreadyStamped: base.alreadyStamped, errors: base.errors.length },
  })

  return base
}
