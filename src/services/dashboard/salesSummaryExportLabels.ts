import type { SalesSummaryExportRow } from '@/services/dashboard/sales-summary.dashboard.service'

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
