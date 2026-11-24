/**
 * Los textos del archivo del Resumen de ventas (carril F · hz:fefa11b6, deuda del carril E): «Sección» y «Concepto» salían con
 * ids en inglés (`totals`, `CARD`, `CREDIT`) en CSV, Excel y PDF. Las filas (y la MCP `export_sales_summary`) no cambian.
 */
import {
  COLUMNAS_DEL_ARCHIVO,
  conceptoDelArchivo,
  encabezadoDelArchivo,
  filasDelArchivo,
  seccionDelArchivo,
} from '@/services/dashboard/salesSummaryExportLabels'
import { flattenSalesSummaryForExport, type SalesSummaryResponse } from '@/services/dashboard/sales-summary.dashboard.service'
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

/** Un resumen como el de la revisión final (full-testing del carril F): cifras de «Hoy» y la misma vista con filtro de efectivo. */
const BASE: SalesSummaryResponse['summary'] = {
  grossSales: 761.4,
  items: 752,
  serviceCosts: 9.4,
  discounts: 0,
  refunds: 50,
  netSales: 711.4,
  deferredSales: 154,
  taxes: 0,
  tips: 17,
  platformFees: 4.425,
  staffCommissions: 0,
  commissions: 4.425,
  totalCollected: 643.975,
  netProfit: 626.975,
  transactionCount: 7,
  unpaidSales: 154,
  unpaidOrders: 3,
  tenderCommissions: 80,
  refundCount: 1,
  giftCardLoads: 0,
  giftCardLoadsCount: 0,
  paidWithGiftCardBalance: 0,
}
const reporte = (over: Partial<SalesSummaryResponse> = {}): SalesSummaryResponse => ({
  dateRange: { startDate: new Date('2026-11-23T06:00:00.000Z'), endDate: new Date('2026-11-24T05:59:59.999Z') },
  reportType: 'summary',
  summary: BASE,
  filtered: false,
  ...over,
})
const totales = (r: SalesSummaryResponse) =>
  filasDelArchivo(flattenSalesSummaryForExport(r, ['totals']).rows, r, []).filter(f => f.seccion === 'Totales')
const monto = (r: SalesSummaryResponse, concepto: string) => totales(r).find(f => f.concepto === concepto)?.monto

describe('el archivo del Resumen de ventas dice lo mismo que la pantalla (full-testing del carril F)', () => {
  it('🔴 W2 · la comisión de plataforma redondea como la pantalla: −4.43, no −4.42', () => {
    expect(monto(reporte(), 'Comisiones de plataforma')).toBe(-4.43)
    expect(monto(reporte(), 'Neto cobrado')).toBe(643.98)
  })

  it('🔴 Codex r8 #2 · el redondeo es el de la pantalla también donde ×100 queda apenas abajo de la mitad (1.005 ⇒ −1.01)', () => {
    expect(monto(reporte({ summary: { ...BASE, platformFees: 1.005 } }), 'Comisiones de plataforma')).toBe(-1.01)
  })

  it('🔴 Codex r8 #3 · con «Cobrado», las propinas dicen que ya van dentro; «Sin cobrar» va al final, aparte, como en la pantalla', () => {
    const filtrado = reporte({
      filtered: true,
      summary: {
        ...BASE,
        grossSales: null,
        items: null,
        serviceCosts: null,
        discounts: null,
        netSales: null,
        deferredSales: null,
        taxes: null,
        unpaidSales: null,
        unpaidOrders: null,
        chargedAmount: 110,
        refunds: 0,
        tips: 10,
        platformFees: 0,
        tenderCommissions: 0,
        totalCollected: 110,
      },
    })
    expect(totales(filtrado).map(f => f.concepto)).toContain('Propinas (ya incluidas en «Cobrado»)')
    const conceptos = totales(reporte()).map(f => f.concepto)
    expect(conceptos[conceptos.length - 1]).toMatch(/^Sin cobrar/)
  })

  it('🔴 Codex r8 #4 · el encabezado sólo dice el tipo de tarjeta con «Tarjeta»; el comercio va por su clave, nunca por su nombre', () => {
    const z = { timezone: 'America/Mexico_City' }
    const inicio = '2026-11-23T06:00:00.000Z'
    const fin = '2026-11-24T05:59:59.999Z'
    expect(encabezadoDelArchivo(inicio, fin, { ...z, paymentMethod: 'CASH', cardType: 'CREDIT' })[1]).toBe('Filtros: Efectivo')
    // Regla de parada (Codex r9-r11): el nombre pedía otro permiso, se podía renombrar o reusar y el PDF no dibuja todas las letras.
    expect(encabezadoDelArchivo(inicio, fin, { ...z, merchantAccountId: 'clmerchantsse01234567890' })[1]).toBe(
      'Filtros: Comercio con clave clmerchantsse01234567890',
    )
  })

  it('🔴 W3 · los nombres de la pantalla: Devoluciones, Impuestos incluidos, Neto cobrado; y empleados después de «Neto cobrado»', () => {
    const conceptos = totales(reporte()).map(f => f.concepto)
    expect(conceptos).toEqual(expect.arrayContaining(['Devoluciones', 'Impuestos incluidos', 'Neto cobrado']))
    expect(conceptos).not.toEqual(expect.arrayContaining(['Reembolsos', 'Total cobrado', 'Impuestos']))
    expect(conceptos.indexOf('Comisiones a empleados')).toBe(conceptos.indexOf('Neto cobrado') + 1)
  })

  it('🔴 W3 · sin renglones vacíos: ni métricas de orden en null ni tarjetas de regalo en cero', () => {
    const filtrado = reporte({
      filtered: true,
      summary: {
        ...BASE,
        grossSales: null,
        items: null,
        serviceCosts: null,
        discounts: null,
        netSales: null,
        deferredSales: null,
        taxes: null,
        unpaidSales: null,
        unpaidOrders: null,
        chargedAmount: 336.4,
        refunds: 50,
        tips: 15,
        platformFees: 0,
        tenderCommissions: 0,
        totalCollected: 286.4,
      },
    })
    const filas = totales(filtrado)
    expect(filas.every(f => f.monto !== null)).toBe(true)
    expect(totales(reporte()).map(f => f.concepto)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/tarjeta de regalo|regalo cargadas/i)]),
    )
  })

  it('🔴 W3 · con un filtro de pago trae «Cobrado» primero, y la cuenta cierra con «Neto cobrado»', () => {
    const filtrado = reporte({
      filtered: true,
      summary: {
        ...BASE,
        grossSales: null,
        items: null,
        serviceCosts: null,
        discounts: null,
        netSales: null,
        deferredSales: null,
        taxes: null,
        unpaidSales: null,
        unpaidOrders: null,
        chargedAmount: 336.4,
        refunds: 50,
        tips: 15,
        platformFees: 0,
        tenderCommissions: 0,
        totalCollected: 286.4,
      },
    })
    const filas = totales(filtrado)
    expect(filas[0]).toMatchObject({ concepto: 'Cobrado', monto: 336.4 })
    expect(monto(filtrado, 'Devoluciones')).toBe(-50)
    expect(monto(filtrado, 'Neto cobrado')).toBe(286.4)
  })

  it('🔴 W4 · arriba del archivo: el periodo y los filtros', () => {
    const filas = filasDelArchivo([], reporte(), ['Periodo: 23 nov 2026 – 23 nov 2026', 'Filtros: Efectivo'])
    expect(filas.slice(0, 2)).toEqual([
      expect.objectContaining({ seccion: 'Periodo', concepto: '23 nov 2026 – 23 nov 2026' }),
      expect.objectContaining({ seccion: 'Filtros', concepto: 'Efectivo' }),
    ])
  })

  it('🔴 W4 · el encabezado dice el periodo en la zona del negocio y los filtros con sus nombres', () => {
    const lineas = encabezadoDelArchivo('2026-11-23T06:00:00.000Z', '2026-11-24T05:59:59.999Z', {
      paymentMethod: 'CARD',
      cardType: 'CREDIT',
      merchantAccountId: 'm1',
      timezone: 'America/Mexico_City',
    })
    expect(lineas).toEqual(['Periodo: 23 nov 2026 – 23 nov 2026', 'Filtros: Tarjeta · Crédito · Comercio con clave m1'])
    expect(encabezadoDelArchivo('2026-11-23T06:00:00.000Z', '2026-11-24T05:59:59.999Z', { timezone: 'America/Mexico_City' })[1]).toBe(
      'Filtros: Ninguno',
    )
  })

  it('🔴 W4 · en el PDF, «Concepto» se parte en líneas en vez de cortarse con «…»', () => {
    const concepto = COLUMNAS_DEL_ARCHIVO.find(c => c.id === 'label')
    expect(concepto?.pdfAjustar).toBe(true)
  })

  // Regresión: la MCP lee las filas de flattenSalesSummaryForExport; su forma y sus textos no cambian aquí.
  it('control · las filas de la MCP conservan sus ids y textos', () => {
    const { rows } = flattenSalesSummaryForExport(reporte(), ['totals'])
    expect(rows.map(r => r.label)).toEqual(expect.arrayContaining(['Reembolsos', 'Total cobrado', 'Impuestos']))
    expect(rows.every(r => r.section === 'totals')).toBe(true)
  })
})
