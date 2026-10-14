/**
 * Reporte de Transacciones y Dispersiones — la parte con base de datos.
 * Spec §4, §7. Un solo motor (projectPaymentSettlement), sin fechas/netos guardados (D7). Tope de cobros LEÍDOS durante
 * el recorrido, no sólo en el conteo previo (Codex r1 #8): si se pasa, se lanza antes de devolver nada.
 */
import { CardBrand, PaymentMethod, Prisma, TransactionCardType } from '@prisma/client'
import { subDays } from 'date-fns'
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz'

import AppError, { BadRequestError } from '@/errors/AppError'
import {
  encontrarReglaActiva,
  projectPaymentSettlement,
  type ActiveConfig,
} from '@/services/dashboard/settlementCalendar.dashboard.service'
import { proyectarComisionYNeto } from '@/services/payments/proyeccionMonetaria'
import { tarifaCongeladaDelPago } from '@/services/payments/transactionCost.service'
import { paymentIsAvoqadoSettled, TENDER_SEMANTICS_SELECT } from '@/services/shared/tenderSemantics'
import { DEFAULT_TIMEZONE } from '@/utils/datetime'
import prisma from '@/utils/prismaClient'

import {
  agruparDepositos,
  clasificarOperacion,
  desglosarComision,
  diasDeRetroceso,
  reglaEsValida,
  type CardTypeKey,
  type DateBasis,
  type DepositRow,
  type EvidenciaFiscal,
  type GrupoSinFecha,
  type MotivoSinFecha,
  type Operation,
  type TransactionRow,
} from './settlementReport.rows'

export const TOPE_XLSX = 5_000
export const TOPE_CSV = 10_000
export const RANGO_MAXIMO_DIAS = 92
const PAGINA = 500
const TOPE_VERSIONES_DE_REGLAS = 500
const TOPE_CUENTAS = 200
const VENTANA_DE_CUENTAS_DIAS = 60
const DIA_MS = 24 * 60 * 60 * 1000

export interface FiltrosDelReporte {
  terminalIds?: string[] // ids o 'NONE' (sin terminal)
  cardTypes?: CardTypeKey[]
  brands?: string[]
  operations?: Operation[]
}
export interface ParametrosDelReporte {
  venueId: string
  startDate: string
  endDate: string
  dateBasis: DateBasis
  filtros: FiltrosDelReporte
  tope: number
  ahora?: Date
}
export interface ReporteDeLiquidacion {
  venueName: string
  timezone: string
  startDate: string
  endDate: string
  dateBasis: DateBasis
  ventanaDesde: string
  ventanaHasta: string
  transacciones: TransactionRow[]
  depositos: DepositRow[]
  sinFecha: GrupoSinFecha | null
  candidatosLeidos: number
}

export class ReporteDemasiadoGrandeError extends AppError {
  constructor(candidatos: number, tope: number) {
    super(
      `El reporte revisaría ${candidatos.toLocaleString('es-MX')} cobros y el máximo por archivo es ${tope.toLocaleString('es-MX')}. Acorta las fechas o usa filtros.`,
      413,
      true,
      'SETTLEMENT_REPORT_TOO_LARGE',
      { candidatos, tope },
    )
  }
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

/** Días de calendario entre dos 'yyyy-MM-dd', inclusivo. */
function diasInclusivos(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number)
  const [y2, m2, d2] = b.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DIA_MS) + 1
}

function validarRango(startDate: string, endDate: string): void {
  if (!YMD.test(startDate) || !YMD.test(endDate)) throw new BadRequestError('Las fechas deben tener el formato AAAA-MM-DD.')
  // `Date.UTC` normaliza 2026-02-31 → 2026-03-03: se exige que el día exista (Codex plan r1 #8).
  for (const f of [startDate, endDate]) {
    const [y, m, d] = f.split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d))
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)
      throw new BadRequestError(`La fecha ${f} no existe.`)
  }
  const dias = diasInclusivos(startDate, endDate)
  if (dias < 1) throw new BadRequestError('La fecha final no puede ser anterior a la inicial.')
  if (dias > RANGO_MAXIMO_DIAS) throw new BadRequestError(`Elige ${RANGO_MAXIMO_DIAS} días o menos.`)
}

/** «N días antes» en el calendario del venue (no N×24 h): un cambio de horario no corre la ventana (Codex código #1). */
const restarDiasDelVenue = (d: Date, dias: number, tz: string): Date => fromZonedTime(subDays(toZonedTime(d, tz), dias), tz)

interface Contexto {
  venueName: string
  tz: string
  inicio: Date
  fin: Date
  configs: ActiveConfig[]
  ventanaDesde: Date
  ventanaHasta: Date
}

async function prepararContexto(p: Omit<ParametrosDelReporte, 'tope'>): Promise<Contexto> {
  validarRango(p.startDate, p.endDate)
  const venue = await prisma.venue.findUnique({ where: { id: p.venueId }, select: { name: true, timezone: true } })
  const tz = venue?.timezone || DEFAULT_TIMEZONE
  const inicio = fromZonedTime(`${p.startDate}T00:00:00.000`, tz)
  const fin = fromZonedTime(`${p.endDate}T23:59:59.999`, tz)
  const desdeCuentas = restarDiasDelVenue(inicio, VENTANA_DE_CUENTAS_DIAS, tz)

  // Cuentas con cobros del venue alrededor del rango (acotado) → sus reglas vigentes en la ventana (R1).
  const cuentas = await prisma.payment.groupBy({
    by: ['merchantAccountId'],
    where: { venueId: p.venueId, merchantAccountId: { not: null }, createdAt: { gte: desdeCuentas, lte: fin } },
    orderBy: { merchantAccountId: 'asc' },
    take: TOPE_CUENTAS + 1,
  })
  // Nunca seguir con reglas incompletas: una cuenta omitida inventaría «Sin regla» (Codex plan r1 #1).
  if (cuentas.length > TOPE_CUENTAS) {
    throw new AppError(
      'Este negocio tiene demasiadas cuentas de cobro para armar el reporte. Contacta a soporte.',
      413,
      true,
      'SETTLEMENT_REPORT_TOO_MANY_ACCOUNTS',
    )
  }
  const ids = cuentas.map(c => c.merchantAccountId).filter((x): x is string => !!x)
  const configs = ids.length
    ? ((await prisma.settlementConfiguration.findMany({
        where: {
          merchantAccountId: { in: ids },
          effectiveFrom: { lte: fin },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: desdeCuentas } }],
        },
        select: {
          merchantAccountId: true,
          cardType: true,
          settlementDays: true,
          settlementDayType: true,
          cutoffTime: true,
          cutoffTimezone: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
        orderBy: { effectiveFrom: 'desc' },
        take: TOPE_VERSIONES_DE_REGLAS + 1,
      })) as ActiveConfig[])
    : []
  if (configs.length > TOPE_VERSIONES_DE_REGLAS) {
    throw new AppError(
      'Este negocio tiene demasiadas versiones de reglas de depósito para armar el reporte. Contacta a soporte.',
      413,
      true,
      'SETTLEMENT_REPORT_TOO_MANY_RULES',
    )
  }

  const retroceso = p.dateBasis === 'deposit' ? diasDeRetroceso(configs) : 0
  const ahora = p.ahora ?? new Date()
  return {
    venueName: venue?.name ?? '',
    tz,
    inicio,
    fin,
    configs,
    ventanaDesde: restarDiasDelVenue(inicio, retroceso, tz),
    ventanaHasta: fin.getTime() < ahora.getTime() ? fin : ahora,
  }
}

/** El MISMO where para contar y para leer (R3). Las devoluciones siempre se leen: se filtran después con lo heredado. */
function whereDeCandidatos(venueId: string, desde: Date, hasta: Date, f: FiltrosDelReporte): Prisma.PaymentWhereInput {
  const and: Prisma.PaymentWhereInput[] = [{ OR: [{ type: null }, { type: { notIn: ['TEST', 'ADJUSTMENT'] } }] }]
  const propios: Prisma.PaymentWhereInput[] = []
  if (f.terminalIds?.length) {
    const ids = f.terminalIds.filter(t => t !== 'NONE')
    propios.push({
      OR: [...(ids.length ? [{ terminalId: { in: ids } }] : []), ...(f.terminalIds.includes('NONE') ? [{ terminalId: null }] : [])],
    })
  }
  if (f.cardTypes?.length) {
    const tipos = f.cardTypes.filter((t): t is TransactionCardType => t !== 'NONE')
    propios.push({
      OR: [
        ...(tipos.length ? [{ transactionCost: { is: { transactionType: { in: tipos } } } }] : []),
        ...(f.cardTypes.includes('NONE') ? [{ transactionCost: { is: null } }] : []),
      ],
    })
  }
  if (f.brands?.length) propios.push({ cardBrand: { in: f.brands as CardBrand[] } })
  if (propios.length) and.push({ OR: [{ amount: { lt: 0 } }, { tipAmount: { lt: 0 } }, { AND: propios }] })
  // Operación en la base, equivalente a `clasificarOperacion`, para que el filtro SÍ baje conteo y lectura (Codex plan r1 #3).
  if (f.operations?.length) {
    const ops: Prisma.PaymentWhereInput[] = []
    if (f.operations.includes('SALE')) ops.push({ amount: { gt: 0 } }, { amount: 0, tipAmount: { gte: 0 } })
    if (f.operations.includes('REFUND')) ops.push({ amount: { lt: 0 } })
    if (f.operations.includes('TIP_REFUND')) ops.push({ amount: 0, tipAmount: { lt: 0 } })
    and.push({ OR: ops })
  }
  return {
    venueId,
    status: 'COMPLETED',
    method: { not: PaymentMethod.CASH },
    createdAt: { gte: desde, lte: hasta },
    AND: and,
  }
}

export async function contarCandidatos(
  p: Omit<ParametrosDelReporte, 'tope'>,
): Promise<{ candidateCount: number; windowFrom: string; windowTo: string }> {
  const c = await prepararContexto(p)
  const candidateCount = await prisma.payment.count({ where: whereDeCandidatos(p.venueId, c.ventanaDesde, c.ventanaHasta, p.filtros) })
  return { candidateCount, windowFrom: c.ventanaDesde.toISOString(), windowTo: c.ventanaHasta.toISOString() }
}

const SELECT_COBRO = {
  id: true,
  amount: true,
  tipAmount: true,
  createdAt: true,
  merchantAccountId: true,
  referenceNumber: true,
  authorizationNumber: true,
  maskedPan: true,
  cardBrand: true,
  terminalId: true,
  type: true,
  processorData: true,
  ...TENDER_SEMANTICS_SELECT,
  terminal: { select: { serialNumber: true } },
  transactionCost: { select: { transactionType: true, venueChargeAmount: true, venueFixedFee: true } },
} as const

type Cobro = Prisma.PaymentGetPayload<{ select: typeof SELECT_COBRO }>

const ultimos4 = (pan: string | null): string | null => {
  const d = (pan ?? '').replace(/\D/g, '')
  return d.length >= 4 ? d.slice(-4) : null
}
const evidenciaDe = (c: Pick<Cobro, 'processorData' | 'merchantAccountId'> | undefined): EvidenciaFiscal | null => {
  const v = c ? tarifaCongeladaDelPago(c.processorData, c.merchantAccountId)?.venue : null
  return v ? { includesTax: v.includesTax, taxRate: v.taxRate } : null
}
const originalIdDe = (c: Cobro): string | null => {
  const pd = c.processorData as Record<string, unknown> | null
  return pd && typeof pd.originalPaymentId === 'string' ? pd.originalPaymentId : null
}

function armarRenglon(c: Cobro, original: Cobro | undefined, ctx: Contexto): TransactionRow {
  const amount = Number(c.amount)
  const tip = Number(c.tipAmount ?? 0)
  const consumo = new Prisma.Decimal(String(c.amount)).toDecimalPlaces(2)
  const propina = new Prisma.Decimal(String(c.tipAmount ?? 0)).toDecimalPlaces(2)
  const tc = c.transactionCost
  // Devolución: el spec hereda del ORIGINAL (tipo, tarjeta, terminal, marca, snapshot); lo propio sólo si no hay original.
  const tipo: CardTypeKey = ((original ? original.transactionCost?.transactionType : undefined) ??
    tc?.transactionType ??
    'NONE') as CardTypeKey
  let fechaDeposito: string | null = null
  let motivo: MotivoSinFecha | null = null
  let totalComision: number | null = null
  let neto: number | null = null
  if (!tc) {
    motivo = 'SIN_COSTO'
  } else {
    const regla = c.merchantAccountId ? encontrarReglaActiva(c.merchantAccountId, tc.transactionType, c.createdAt, ctx.configs) : null
    const pr =
      regla && reglaEsValida(regla)
        ? projectPaymentSettlement(
            {
              amount: c.amount,
              tipAmount: c.tipAmount,
              createdAt: c.createdAt,
              merchantAccountId: c.merchantAccountId!,
              transactionCost: tc,
            },
            [regla],
            ctx.tz,
          )
        : null
    if (pr) {
      fechaDeposito = pr.settlementDateKey
      totalComision = pr.commission
      neto = pr.net
    } else {
      // Sin fecha, pero el dinero SÍ se conoce: el mismo cálculo que usa el motor (sólo aquí, sin duplicarlo).
      const { fee, net } = proyectarComisionYNeto(consumo.plus(propina), tc.venueChargeAmount, tc.venueFixedFee)
      totalComision = fee
      neto = net
      motivo = regla && !reglaEsValida(regla) ? 'REGLA_INVALIDA' : 'SIN_REGLA'
    }
  }
  const desglose =
    totalComision === null
      ? { comision: null, iva: null }
      : desglosarComision(totalComision, original ? evidenciaDe(original) : evidenciaDe(c), Number(tc?.venueFixedFee ?? 0))
  return {
    paymentId: c.id,
    venueName: ctx.venueName,
    folio: c.referenceNumber || c.id,
    fechaCobro: formatInTimeZone(c.createdAt, ctx.tz, 'yyyy-MM-dd HH:mm'),
    terminal: (original ? original.terminal?.serialNumber : undefined) ?? c.terminal?.serialNumber ?? null,
    autorizacion: c.authorizationNumber ?? original?.authorizationNumber ?? null,
    ultimos4: (original ? ultimos4(original.maskedPan) : null) ?? ultimos4(c.maskedPan),
    tipoTarjeta: tipo,
    operacion: clasificarOperacion(amount, tip),
    marca: (original ? original.cardBrand : undefined) ?? c.cardBrand ?? null,
    consumo: consumo.toNumber(),
    propina: propina.toNumber(),
    total: consumo.plus(propina).toNumber(),
    comision: desglose.comision,
    ivaComision: desglose.iva,
    totalComision,
    montoADepositar: neto,
    fechaDeposito,
    motivoSinFecha: motivo,
  }
}

/** Filtro final con los valores EFECTIVOS (heredados en devoluciones), igual para conteo≈, recorrido y MCP. */
function pasaFiltros(row: TransactionRow, c: Cobro, original: Cobro | undefined, f: FiltrosDelReporte): boolean {
  if (f.operations?.length && !f.operations.includes(row.operacion)) return false
  if (f.cardTypes?.length && !f.cardTypes.includes(row.tipoTarjeta)) return false
  if (f.brands?.length && !(row.marca && f.brands.includes(row.marca))) return false
  if (f.terminalIds?.length) {
    const tid = (original ? original.terminalId : undefined) ?? c.terminalId ?? null
    if (!(tid ? f.terminalIds.includes(tid) : f.terminalIds.includes('NONE'))) return false
  }
  return true
}

export async function construirReporte(p: ParametrosDelReporte): Promise<ReporteDeLiquidacion> {
  const ctx = await prepararContexto(p)
  const where = whereDeCandidatos(p.venueId, ctx.ventanaDesde, ctx.ventanaHasta, p.filtros)
  const previo = await prisma.payment.count({ where })
  if (previo > p.tope) throw new ReporteDemasiadoGrandeError(previo, p.tope)

  const startKey = p.startDate
  const endKey = p.endDate
  const transacciones: TransactionRow[] = []
  let leidos = 0
  let cursorId: string | undefined
  while (true) {
    const pagina = await prisma.payment.findMany({
      where,
      select: SELECT_COBRO,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PAGINA,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    })
    if (pagina.length === 0) break
    leidos += pagina.length
    if (leidos > p.tope) throw new ReporteDemasiadoGrandeError(leidos, p.tope)

    const idsOriginales = [...new Set(pagina.map(originalIdDe).filter((x): x is string => !!x))]
    const originales = idsOriginales.length
      ? await prisma.payment.findMany({
          where: { venueId: p.venueId, id: { in: idsOriginales } },
          select: SELECT_COBRO,
          take: idsOriginales.length,
        })
      : []
    const porId = new Map(originales.map(o => [o.id, o]))

    for (const c of pagina) {
      if (!paymentIsAvoqadoSettled(c)) continue
      const id = originalIdDe(c)
      const original = id ? porId.get(id) : undefined
      // Devolución de un cobro TEST/ADJUSTMENT: fuera, igual que su original (Codex plan r1 #2). `type` nulo SÍ entra.
      if (original && (original.type === 'TEST' || original.type === 'ADJUSTMENT')) continue
      const row = armarRenglon(c, original, ctx)
      if (!pasaFiltros(row, c, original, p.filtros)) continue
      if (p.dateBasis === 'deposit' && row.fechaDeposito !== null && (row.fechaDeposito < startKey || row.fechaDeposito > endKey)) continue
      transacciones.push(row)
    }
    if (pagina.length < PAGINA) break
    cursorId = pagina[pagina.length - 1].id
    await new Promise(resolve => setImmediate(resolve))
  }

  const { depositos, sinFecha } = agruparDepositos(transacciones)
  return {
    venueName: ctx.venueName,
    timezone: ctx.tz,
    startDate: p.startDate,
    endDate: p.endDate,
    dateBasis: p.dateBasis,
    ventanaDesde: formatInTimeZone(ctx.ventanaDesde, ctx.tz, 'yyyy-MM-dd'),
    ventanaHasta: formatInTimeZone(ctx.ventanaHasta, ctx.tz, 'yyyy-MM-dd'),
    transacciones,
    depositos,
    sinFecha,
    candidatosLeidos: leidos,
  }
}

export async function opcionesDeTerminal(
  venueId: string,
  search: string | undefined,
  cursor: string | undefined,
  limit: number,
): Promise<{ items: Array<{ id: string; name: string; serialNumber: string | null }>; nextCursor: string | null }> {
  const take = Math.min(Math.max(limit, 1), 100)
  const q = search?.trim()
  const filas = await prisma.terminal.findMany({
    where: {
      venueId,
      ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { serialNumber: { contains: q, mode: 'insensitive' } }] } : {}),
    },
    select: { id: true, name: true, serialNumber: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  })
  const items = filas.slice(0, take)
  return { items, nextCursor: filas.length > take ? items[items.length - 1].id : null }
}
