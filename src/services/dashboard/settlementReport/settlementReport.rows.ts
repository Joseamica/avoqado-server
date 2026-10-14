/**
 * Reporte de Transacciones y Dispersiones — la parte PURA (sin base de datos).
 * Spec: docs/superpowers/specs/2026-10-13-reportes-transacciones-y-dispersiones-design.md (§4, §5, D10).
 * Dinero en PESOS 1:1, siempre con Decimal; lo desconocido es null, nunca cero.
 */
import { Prisma } from '@prisma/client'
import type { ActiveConfig } from '@/services/dashboard/settlementCalendar.dashboard.service'

export type ReportKind = 'transactions' | 'deposits'
export type DateBasis = 'charge' | 'deposit'
export type CardTypeKey = 'DEBIT' | 'CREDIT' | 'AMEX' | 'INTERNATIONAL' | 'OTHER' | 'NONE'
export type Operation = 'SALE' | 'REFUND' | 'TIP_REFUND'
export type MotivoSinFecha = 'SIN_COSTO' | 'SIN_REGLA' | 'REGLA_INVALIDA'

export interface EvidenciaFiscal {
  includesTax: boolean | null
  taxRate: string | null
}

export interface TransactionRow {
  paymentId: string
  venueName: string
  folio: string
  /** 'yyyy-MM-dd HH:mm' en la zona del venue. */
  fechaCobro: string
  terminal: string | null
  autorizacion: string | null
  ultimos4: string | null
  tipoTarjeta: CardTypeKey
  operacion: Operation
  marca: string | null
  consumo: number
  propina: number
  total: number
  comision: number | null
  ivaComision: number | null
  totalComision: number | null
  montoADepositar: number | null
  /** 'yyyy-MM-dd' estimada; null = «Sin calcular». */
  fechaDeposito: string | null
  motivoSinFecha: MotivoSinFecha | null
}

export interface DepositRow {
  fechaDeposito: string
  primerCobro: string
  ultimoCobro: string
  cobros: number
  consumo: number
  propinas: number
  total: number
  comision: number | null
  ivaComision: number | null
  totalComision: number
  depositoNeto: number
}

export interface GrupoSinFecha {
  cobros: number
  consumo: number
  propinas: number
  total: number
  desde: string
  hasta: string
}

const D = (v: unknown) => new Prisma.Decimal(String(v ?? 0))

export function clasificarOperacion(amount: number, tip: number): Operation {
  if (amount < 0) return 'REFUND'
  if (amount === 0 && tip < 0) return 'TIP_REFUND'
  return 'SALE'
}

/** D10: lo que el servicio de reglas acepta (`settlementConfiguration.service.ts:155`). Fuera de esto el motor no se invoca. */
export function reglaEsValida(c: Pick<ActiveConfig, 'settlementDays' | 'settlementDayType'>): boolean {
  return (
    Number.isInteger(c.settlementDays) &&
    c.settlementDays >= 0 &&
    c.settlementDays <= 30 &&
    (c.settlementDayType === 'BUSINESS_DAYS' || c.settlementDayType === 'CALENDAR_DAYS')
  )
}

/**
 * Cuántos días antes del rango hay que leer cobros para encontrar todos los que DEPOSITAN dentro (spec §7).
 * Hábiles: ceil(d × 7/5) + 1 (corte) + 15 (festivos). Naturales: d + 1. Sólo reglas válidas (R4: el máximo válido da 58).
 */
export function diasDeRetroceso(configs: Array<Pick<ActiveConfig, 'settlementDays' | 'settlementDayType'>>): number {
  let max = 0
  for (const c of configs) {
    if (!reglaEsValida(c)) continue
    const h = c.settlementDayType === 'BUSINESS_DAYS' ? Math.ceil((c.settlementDays * 7) / 5) + 1 + 15 : c.settlementDays + 1
    if (h > max) max = h
  }
  return max
}

/**
 * Comisión → base + IVA, SÓLO con evidencia congelada del cobro (spec §5). La parte porcentual cobrada ya incluye el IVA
 * (includesTax true: la tasa lo traía; false: `applyTaxIfNeeded` se lo sumó). Con cargo fijo el tratamiento fiscal del fijo no
 * está acreditado ⇒ vacío. El IVA absorbe el centavo: base + IVA = total exacto.
 */
export function desglosarComision(
  totalComision: number,
  evidencia: EvidenciaFiscal | null,
  cargoFijo: number,
): { comision: number | null; iva: number | null } {
  const vacio = { comision: null, iva: null }
  if (!evidencia || evidencia.includesTax === null || evidencia.taxRate === null) return vacio
  if (!D(cargoFijo).isZero()) return vacio
  let tasa: Prisma.Decimal
  try {
    tasa = D(evidencia.taxRate)
  } catch {
    return vacio
  }
  if (tasa.isNaN() || tasa.lt(0) || tasa.gt(1)) return vacio
  const total = D(totalComision).toDecimalPlaces(2)
  const base = total.div(tasa.plus(1)).toDecimalPlaces(2)
  return { comision: base.toNumber(), iva: total.minus(base).toNumber() }
}

/** Mitigación de inyección de fórmulas (OWASP) para celdas de TEXTO. Los importes son números y no pasan por aquí. */
export function neutralizarFormula(texto: string): string {
  // Sólo espacios (ASCII y Unicode); TAB/CR/LF NO se quitan: son justo lo que se busca (Codex plan r1 #6)
  const sinEspacios = texto.replace(/^[ \u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]+/, '')
  return /^[=+\-@\t\r\n]/.test(sinEspacios) ? `'${texto}` : texto
}

/** Suma por día los importes YA redondeados de cada renglón (invariante del spec §5). Lo sin fecha va aparte. */
export function agruparDepositos(rows: TransactionRow[]): { depositos: DepositRow[]; sinFecha: GrupoSinFecha | null } {
  type Acc = {
    primer: string
    ultimo: string
    cobros: number
    consumo: Prisma.Decimal
    propinas: Prisma.Decimal
    total: Prisma.Decimal
    comision: Prisma.Decimal | null
    iva: Prisma.Decimal | null
    totalComision: Prisma.Decimal
    neto: Prisma.Decimal
  }
  const dias = new Map<string, Acc>()
  let sin: {
    cobros: number
    consumo: Prisma.Decimal
    propinas: Prisma.Decimal
    total: Prisma.Decimal
    desde: string
    hasta: string
  } | null = null
  for (const r of rows) {
    const dia = r.fechaCobro.slice(0, 10)
    if (r.fechaDeposito === null) {
      if (!sin) sin = { cobros: 0, consumo: D(0), propinas: D(0), total: D(0), desde: dia, hasta: dia }
      sin.cobros += 1
      sin.consumo = sin.consumo.plus(r.consumo)
      sin.propinas = sin.propinas.plus(r.propina)
      sin.total = sin.total.plus(r.total)
      if (dia < sin.desde) sin.desde = dia
      if (dia > sin.hasta) sin.hasta = dia
      continue
    }
    let a = dias.get(r.fechaDeposito)
    if (!a) {
      a = {
        primer: dia,
        ultimo: dia,
        cobros: 0,
        consumo: D(0),
        propinas: D(0),
        total: D(0),
        comision: D(0),
        iva: D(0),
        totalComision: D(0),
        neto: D(0),
      }
      dias.set(r.fechaDeposito, a)
    }
    if (dia < a.primer) a.primer = dia
    if (dia > a.ultimo) a.ultimo = dia
    a.cobros += 1
    a.consumo = a.consumo.plus(r.consumo)
    a.propinas = a.propinas.plus(r.propina)
    a.total = a.total.plus(r.total)
    a.totalComision = a.totalComision.plus(r.totalComision ?? 0)
    a.neto = a.neto.plus(r.montoADepositar ?? 0)
    a.comision = a.comision !== null && r.comision !== null ? a.comision.plus(r.comision) : null
    a.iva = a.iva !== null && r.ivaComision !== null ? a.iva.plus(r.ivaComision) : null
  }
  const depositos = [...dias.entries()]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([fechaDeposito, a]) => ({
      fechaDeposito,
      primerCobro: a.primer,
      ultimoCobro: a.ultimo,
      cobros: a.cobros,
      consumo: a.consumo.toNumber(),
      propinas: a.propinas.toNumber(),
      total: a.total.toNumber(),
      comision: a.comision?.toNumber() ?? null,
      ivaComision: a.iva?.toNumber() ?? null,
      totalComision: a.totalComision.toNumber(),
      depositoNeto: a.neto.toNumber(),
    }))
  const sinFecha = sin
    ? {
        cobros: sin.cobros,
        consumo: sin.consumo.toNumber(),
        propinas: sin.propinas.toNumber(),
        total: sin.total.toNumber(),
        desde: sin.desde,
        hasta: sin.hasta,
      }
    : null
  return { depositos, sinFecha }
}
