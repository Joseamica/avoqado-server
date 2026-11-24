import {
  alCentavoComoLaPantalla,
  type SalesSummaryExportRow,
  type SalesSummaryFilters,
  type SalesSummaryResponse,
} from '@/services/dashboard/sales-summary.dashboard.service'
import type { ExportColumnDef } from '@/services/dashboard/export.helpers'

/**
 * Los textos del ARCHIVO del Resumen de ventas (CSV, Excel, PDF). Las filas de `flattenSalesSummaryForExport` traen la sección y el
 * método como ids (`totals`, `CARD`, `CREDIT`), que también lee la tool `export_sales_summary` del MCP: ahí no se tocan. Sólo el
 * archivo que abre una persona los dice en español (deuda del carril E, carril F · hz:fefa11b6).
 */
const SECCION: Record<SalesSummaryExportRow['section'], string> = {
  aviso: 'Aviso',
  totals: 'Totales',
  paymentMethods: 'Métodos de pago',
  cardTypes: 'Tipos de tarjeta',
  merchantAccounts: 'Por comercio',
  statement: 'Estado del periodo',
  byPeriod: 'Por periodo',
}

/** Los nombres de la pantalla («Métodos de pago», «Filtrar por»). */
const METODO: Record<string, string> = {
  CASH: 'Efectivo',
  CARD: 'Tarjeta',
  CREDIT_CARD: 'Tarjeta de crédito',
  DEBIT_CARD: 'Tarjeta de débito',
  DIGITAL_WALLET: 'Monedero digital',
  BANK_TRANSFER: 'Transferencia',
  CRYPTOCURRENCY: 'Cripto',
  OTHER: 'Otro método',
  QR_LEGACY: 'QR anterior',
  GIFT_CARD: 'Saldo de tarjeta de regalo',
}

const TIPO_DE_TARJETA: Record<string, string> = {
  CREDIT: 'Crédito',
  DEBIT: 'Débito',
  AMEX: 'Amex',
  INTERNATIONAL: 'Internacional',
}

/** «Sección» de una fila del archivo. Un id que no conozca sale tal cual (nunca vacío). */
export const seccionDelArchivo = (row: SalesSummaryExportRow): string => SECCION[row.section] ?? row.section

/** «Concepto» de una fila del archivo: el método y el tipo de tarjeta con su nombre; lo demás ya viene en español. */
export const conceptoDelArchivo = (row: SalesSummaryExportRow): string => {
  if (row.section === 'paymentMethods') return METODO[row.label] ?? row.label
  if (row.section === 'cardTypes') return TIPO_DE_TARJETA[row.label] ?? row.label
  return row.label
}

/** Una fila del ARCHIVO (CSV, Excel, PDF), ya con los textos de la pantalla. Las filas de la MCP no pasan por aquí. */
export interface FilaDelArchivo {
  seccion: string
  concepto: string
  cantidad: number | null
  monto: number | null
  porcentaje: number | null
}

/** Los nombres de la pantalla para los totales (full-testing W3 del carril F). Lo que no está aquí sale igual. */
const TOTAL_EN_PANTALLA: Record<string, string> = {
  Reembolsos: 'Devoluciones',
  Impuestos: 'Impuestos incluidos',
  'Total cobrado': 'Neto cobrado',
  'Sin cobrar: cuentas abiertas (no es venta)': 'Sin cobrar (aparte: cuentas abiertas, no es venta)',
}
/** Renglones que la pantalla sólo enseña si no son cero. */
const SOLO_SI_HAY = new Set([
  'Tarjetas de regalo cargadas (no es venta)',
  'Pagado con saldo de tarjeta de regalo (incluido en ventas y propinas)',
])

/** Redondeo al centavo como la pantalla (el mismo Intl). */
const alCentavo = (n: number | null): number | null => (n === null ? null : alCentavoComoLaPantalla(n))

/**
 * Las filas del archivo: arriba el periodo y los filtros (W4); los totales con los nombres y el orden de la pantalla, sin renglones
 * vacíos y, con un filtro de pago, abriendo con «Cobrado» (W3); lo demás con su sección y su concepto en español.
 * `encabezado` son líneas «Etiqueta: texto» (la etiqueta va en «Sección»).
 */
export function filasDelArchivo(rows: SalesSummaryExportRow[], report: SalesSummaryResponse, encabezado: string[]): FilaDelArchivo[] {
  const fila = (
    seccion: string,
    concepto: string,
    cantidad: number | null = null,
    monto: number | null = null,
    porcentaje: number | null = null,
  ) => ({
    seccion,
    concepto,
    cantidad,
    monto,
    porcentaje,
  })
  const arriba = encabezado.map(linea => {
    const i = linea.indexOf(': ')
    return i > 0 ? fila(linea.slice(0, i), linea.slice(i + 2)) : fila('', linea)
  })

  const totales: FilaDelArchivo[] = []
  const resto: FilaDelArchivo[] = []
  for (const r of rows) {
    if (r.section !== 'totals') {
      resto.push(fila(seccionDelArchivo(r), conceptoDelArchivo(r), r.count, r.amount, r.percentage))
      continue
    }
    if (r.amount === null) continue // métrica de orden que la vista de movimientos no puede medir
    if (SOLO_SI_HAY.has(r.label) && alCentavo(r.amount) === 0) continue
    totales.push(fila(seccionDelArchivo(r), TOTAL_EN_PANTALLA[r.label] ?? r.label, r.count, alCentavo(r.amount)))
  }
  // Empleados después de «Neto cobrado», como la pantalla (no los resta «Neto cobrado», sólo «Ganancia neta»).
  const empleados = totales.findIndex(f => f.concepto === 'Comisiones a empleados')
  if (empleados >= 0) {
    const [f] = totales.splice(empleados, 1)
    const neto = totales.findIndex(t => t.concepto === 'Neto cobrado')
    totales.splice(neto >= 0 ? neto + 1 : totales.length, 0, f)
  }
  // «Sin cobrar» al final, aparte, como en la pantalla (no entra en «Neto cobrado»; Codex r8 #3).
  const sinCobrar = totales.findIndex(f => f.concepto.startsWith('Sin cobrar'))
  if (sinCobrar >= 0) totales.push(...totales.splice(sinCobrar, 1))
  // D16.2: con un filtro de pago, la cuenta abre con lo cobrado con ese filtro (con propina, sin devoluciones). Las propinas ya van
  // dentro: se dice en su renglón, para que nadie las sume dos veces (Codex r8 #3).
  if (totales.length > 0 && typeof report.summary.chargedAmount === 'number') {
    totales.unshift(fila('Totales', 'Cobrado', null, alCentavo(report.summary.chargedAmount)))
    for (const f of totales) if (f.concepto === 'Propinas') f.concepto = 'Propinas (ya incluidas en «Cobrado»)'
  }

  // El aviso del QR anterior (sección «Aviso») sigue siendo lo primero después del encabezado.
  const aviso = resto.filter(f => f.seccion === SECCION.aviso)
  return [...arriba, ...aviso, ...totales, ...resto.filter(f => f.seccion !== SECCION.aviso)]
}

/** Las columnas del archivo. En el PDF, «Concepto» es la más ancha y se parte en líneas (W4: antes se cortaba con «…»). */
export const COLUMNAS_DEL_ARCHIVO: ExportColumnDef<FilaDelArchivo>[] = [
  { id: 'section', label: 'Sección', value: f => f.seccion, pdfAncho: 1.4, pdfAjustar: true },
  { id: 'label', label: 'Concepto', value: f => f.concepto, pdfAncho: 4, pdfAjustar: true },
  { id: 'count', label: 'Cantidad', value: f => f.cantidad, pdfAncho: 0.8 },
  { id: 'amount', label: 'Monto', value: f => f.monto, pdfAncho: 1 },
  { id: 'percentage', label: 'Porcentaje', value: f => f.porcentaje, pdfAncho: 0.8 },
]

/** «23 nov 2026» en la zona del negocio. */
const dia = (iso: string, zona: string) =>
  new Intl.DateTimeFormat('es-MX', { timeZone: zona, day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(iso))
    .replace('.', '')

/** Los nombres de los filtros de la pantalla («Filtrar por» y «Comercio»). */
const FILTRO_DE_METODO: Record<string, string> = { CASH: 'Efectivo', CARD: 'Tarjeta', OTHER: 'Otros', QR_LEGACY: 'QR anterior' }

/**
 * Las líneas de arriba del archivo (W4): «Periodo: …» y «Filtros: …». El comercio va con el nombre que ya trae el reporte (su
 * desglose por comercio, del mismo negocio); sin él, «Comercio elegido».
 */
export function encabezadoDelArchivo(
  startDate: string,
  endDate: string,
  filtros: Pick<SalesSummaryFilters, 'paymentMethod' | 'cardType' | 'merchantAccountId' | 'timezone'>,
  report: Pick<SalesSummaryResponse, 'byMerchantAccount'>,
): string[] {
  const zona = filtros.timezone || 'America/Mexico_City'
  const partes: string[] = []
  if (filtros.paymentMethod) partes.push(FILTRO_DE_METODO[filtros.paymentMethod] ?? filtros.paymentMethod)
  // El tipo de tarjeta sólo cuenta con «Tarjeta» (el cálculo lo ignora con otro método; Codex r8 #4).
  if (filtros.cardType && filtros.paymentMethod === 'CARD') partes.push(TIPO_DE_TARJETA[filtros.cardType] ?? filtros.cardType)
  if (filtros.merchantAccountId) {
    const nombre = report.byMerchantAccount?.find(m => m.merchantAccountId === filtros.merchantAccountId)?.displayName
    partes.push(nombre ? `Comercio ${nombre}` : 'Comercio elegido')
  }
  return [`Periodo: ${dia(startDate, zona)} – ${dia(endDate, zona)}`, `Filtros: ${partes.length > 0 ? partes.join(' · ') : 'Ninguno'}`]
}
