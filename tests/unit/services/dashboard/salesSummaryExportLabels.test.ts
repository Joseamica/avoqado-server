/**
 * Los textos del archivo del Resumen de ventas (carril F · hz:fefa11b6, deuda del carril E): «Sección» y «Concepto» salían con
 * ids en inglés (`totals`, `CARD`, `CREDIT`) en CSV, Excel y PDF. Las filas (y la MCP `export_sales_summary`) no cambian.
 */
import { conceptoDelArchivo, seccionDelArchivo } from '@/services/dashboard/salesSummaryExportLabels'
import type { SalesSummaryExportRow } from '@/services/dashboard/sales-summary.dashboard.service'

const fila = (section: SalesSummaryExportRow['section'], label: string): SalesSummaryExportRow => ({
  section,
  label,
  count: null,
  amount: 1,
  percentage: null,
})

describe('textos del archivo del Resumen de ventas', () => {
  it('🔴 cada sección con su nombre en español', () => {
    const esperado: Record<SalesSummaryExportRow['section'], string> = {
      aviso: 'Aviso',
      totals: 'Totales',
      paymentMethods: 'Métodos de pago',
      cardTypes: 'Tipos de tarjeta',
      merchantAccounts: 'Por comercio',
      statement: 'Estado del periodo',
      byPeriod: 'Por periodo',
    }
    for (const [id, nombre] of Object.entries(esperado))
      expect(seccionDelArchivo(fila(id as SalesSummaryExportRow['section'], 'x'))).toBe(nombre)
  })

  it('🔴 los métodos de pago con el nombre de la pantalla', () => {
    expect(conceptoDelArchivo(fila('paymentMethods', 'CARD'))).toBe('Tarjeta')
    expect(conceptoDelArchivo(fila('paymentMethods', 'CASH'))).toBe('Efectivo')
    expect(conceptoDelArchivo(fila('paymentMethods', 'CREDIT_CARD'))).toBe('Tarjeta de crédito')
    expect(conceptoDelArchivo(fila('paymentMethods', 'QR_LEGACY'))).toBe('QR anterior')
  })

  it('🔴 los tipos de tarjeta en español', () => {
    expect(conceptoDelArchivo(fila('cardTypes', 'CREDIT'))).toBe('Crédito')
    expect(conceptoDelArchivo(fila('cardTypes', 'INTERNATIONAL'))).toBe('Internacional')
  })

  // Regresión: lo que ya venía en español, o un nombre de comercio, no se toca; un id desconocido sale tal cual (nunca vacío).
  it('control · los conceptos ya en español y los nombres de comercio salen igual', () => {
    expect(conceptoDelArchivo(fila('totals', 'Ventas brutas'))).toBe('Ventas brutas')
    expect(conceptoDelArchivo(fila('merchantAccounts', 'CARD'))).toBe('CARD') // un comercio que se llame así
    expect(conceptoDelArchivo(fila('paymentMethods', 'Saldo de tarjeta de regalo'))).toBe('Saldo de tarjeta de regalo')
    expect(conceptoDelArchivo(fila('paymentMethods', 'NUEVO_METODO'))).toBe('NUEVO_METODO')
  })
})
