/**
 * D15 (16-nov-2026) — cada reporte que suma cobros QR legacy de Mindform dice cuándo esa suma puede estar incompleta.
 *
 * El puente se simula desde el pool (`puenteQrLegacy`) y el recorrido por páginas es el REAL: el caso que importa es
 * «la primera página (500 cobros) llegó y la segunda reventó» — antes esa suma parcial salía como total completo.
 * Un cobro simulado = $100 + $10 de propina, así que la suma parcial es $50,000 + $5,000.
 *
 * Los reportes NO fallan: siguen contestando con lo de Avoqado, y marcan `legacyUnavailable: true`.
 */
jest.mock('@/services/legacy/legacyPool', () => require('@tests/__helpers__/puenteQrLegacy').moduloLegacyPool)

import { prismaMock } from '@tests/__helpers__/setup'
import {
  MINDFORM,
  PUENTE_CAIDO,
  TAMANO_DE_PAGINA,
  cobrosLegacy,
  consultasAlPuente,
  puenteContesta,
  puenteSinConfigurar,
} from '@tests/__helpers__/puenteQrLegacy'
import { getPaymentsSummary } from '@/services/dashboard/paymentSummary.dashboard.service'
import { aggregatePaymentsByMethod, aggregateTipsByProcessor, fetchPaymentsForAnalytics } from '@/services/legacy/mergedPayments.service'
import { getBasicMetricsData, getBasicMetricsDetailsPage, getChartData } from '@/services/dashboard/generalStats.dashboard.service'
import { getSalesSummary, type SalesSummaryFilters } from '@/services/dashboard/sales-summary.dashboard.service'

const OTRO_NEGOCIO = 'venue-restaurante'
const DESDE = '2026-10-01T06:00:00.000Z'
const HASTA = '2026-11-01T05:59:59.999Z'
const FECHAS = { fromDate: new Date(DESDE), toDate: new Date(HASTA) }

/** La primera página llega completa y la segunda revienta: la suma queda a medias. */
const fallaLaSegundaPagina = () => puenteContesta(cobrosLegacy(TAMANO_DE_PAGINA), PUENTE_CAIDO)
const puenteSano = () => puenteContesta(cobrosLegacy(3))

beforeEach(() => {
  // Avoqado sin cobros propios: todo lo que se ve en estas pruebas viene del puente.
  prismaMock.$queryRawUnsafe = jest.fn().mockResolvedValue([])
  ;(prismaMock.$queryRaw as jest.Mock).mockReset().mockResolvedValue([])
  ;(prismaMock.payment.groupBy as jest.Mock).mockResolvedValue([])
  ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValue([])
  ;(prismaMock.payment.count as jest.Mock).mockResolvedValue(0)
  ;(prismaMock.payment.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: null, tipAmount: null } })
  ;(prismaMock.commissionCalculation.aggregate as jest.Mock).mockResolvedValue({ _sum: { netCommission: null } })
  ;(prismaMock.venue.findUnique as jest.Mock).mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    timezone: 'America/Mexico_City',
  }))
  puenteContesta()
})

describe('Resumen de pagos (getPaymentsSummary)', () => {
  it('🔴 falla la segunda página: contesta la suma parcial y avisa', async () => {
    fallaLaSegundaPagina()

    const resumen = await getPaymentsSummary(MINDFORM, { startDate: DESDE, endDate: HASTA })

    expect(resumen.legacyUnavailable).toBe(true)
    expect(resumen.total).toBe(TAMANO_DE_PAGINA)
    expect(resumen.groups).toEqual([{ status: 'COMPLETED', type: 'REGULAR', count: 500, amount: 50000, tipAmount: 5000 }])
  })

  it('🔴 puente sin configurar: avisa', async () => {
    puenteSinConfigurar()
    expect((await getPaymentsSummary(MINDFORM, { startDate: DESDE, endDate: HASTA })).legacyUnavailable).toBe(true)
  })

  it('puente sano (con filas o con cero): sin aviso', async () => {
    puenteSano()
    const conFilas = await getPaymentsSummary(MINDFORM, { startDate: DESDE, endDate: HASTA })
    expect(conFilas).not.toHaveProperty('legacyUnavailable')
    expect(conFilas.total).toBe(3)

    puenteContesta([])
    expect(await getPaymentsSummary(MINDFORM, { startDate: DESDE, endDate: HASTA })).toEqual({
      groups: [],
      filteredGroups: [],
      total: 0,
      filteredTotal: 0,
    })
  })

  it('un filtro que no admite cobros QR ni siquiera pregunta al puente: sin aviso aunque esté caído', async () => {
    puenteSinConfigurar()
    expect(await getPaymentsSummary(MINDFORM, { startDate: DESDE, endDate: HASTA, methods: ['CREDIT_CARD'] })).not.toHaveProperty(
      'legacyUnavailable',
    )
  })

  // Codex r2 #2, confirmación: los otros filtros que dejan fuera todo lo legacy (por origen, y los de un solo valor).
  it.each([
    ['por origen', { sources: ['TPV'] }],
    ['por método, de un solo valor', { method: 'DEBIT_CARD' }],
    ['por origen, de un solo valor', { source: 'TPV' }],
  ])('filtro %s que excluye todo el QR legacy, con el puente caído: sin aviso y sin preguntarle', async (_nombre, filtro) => {
    fallaLaSegundaPagina()
    expect(await getPaymentsSummary(MINDFORM, { startDate: DESDE, endDate: HASTA, ...filtro })).not.toHaveProperty('legacyUnavailable')
    expect(consultasAlPuente()).toBe(0)
  })

  it('otro negocio: nunca toca el puente ni avisa', async () => {
    fallaLaSegundaPagina()
    expect(await getPaymentsSummary(OTRO_NEGOCIO, { startDate: DESDE, endDate: HASTA })).not.toHaveProperty('legacyUnavailable')
    expect(consultasAlPuente()).toBe(0)
  })

  it('el aviso no se guarda: tras una caída, la siguiente consulta sana sale completa y sin aviso', async () => {
    fallaLaSegundaPagina()
    expect((await getPaymentsSummary(MINDFORM, { startDate: DESDE, endDate: HASTA })).legacyUnavailable).toBe(true)

    puenteContesta(cobrosLegacy(TAMANO_DE_PAGINA), cobrosLegacy(2, 500))
    const despues = await getPaymentsSummary(MINDFORM, { startDate: DESDE, endDate: HASTA })
    expect(despues).not.toHaveProperty('legacyUnavailable')
    expect(despues.total).toBe(TAMANO_DE_PAGINA + 2)
  })
})

describe('Pagos fusionados (mergedPayments) — lo que usan las herramientas de ventas del MCP y las gráficas de Inicio', () => {
  it('🔴 aggregatePaymentsByMethod: suma parcial marcada', async () => {
    fallaLaSegundaPagina()

    const filas = await aggregatePaymentsByMethod(MINDFORM, FECHAS)

    expect(filas.legacyUnavailable).toBe(true)
    expect([...filas]).toEqual([{ method: 'CARD', amount: 50000, tips: 5000, count: 500 }])
  })

  it('🔴 aggregateTipsByProcessor: suma parcial marcada', async () => {
    fallaLaSegundaPagina()

    const filas = await aggregateTipsByProcessor(MINDFORM, FECHAS)

    expect(filas.legacyUnavailable).toBe(true)
    expect([...filas]).toEqual([{ processedById: null, processedByName: null, tips: 5000, payments: 500 }])
  })

  it('🔴 fetchPaymentsForAnalytics: lista parcial marcada', async () => {
    fallaLaSegundaPagina()

    const pagos = await fetchPaymentsForAnalytics(MINDFORM, FECHAS)

    expect(pagos.legacyUnavailable).toBe(true)
    expect(pagos).toHaveLength(TAMANO_DE_PAGINA)
  })

  it('puente sano: las tres devuelven su arreglo de siempre, sin marca', async () => {
    puenteSano()
    const porMetodo = await aggregatePaymentsByMethod(MINDFORM, FECHAS)
    expect(porMetodo).toEqual([{ method: 'CARD', amount: 300, tips: 30, count: 3 }])
    expect(porMetodo.legacyUnavailable).toBeUndefined()

    puenteSano()
    expect((await aggregateTipsByProcessor(MINDFORM, FECHAS)).legacyUnavailable).toBeUndefined()

    puenteContesta([])
    const pagos = await fetchPaymentsForAnalytics(MINDFORM, FECHAS)
    expect(pagos).toEqual([])
    expect(pagos.legacyUnavailable).toBeUndefined()
  })

  it('otro negocio: sin marca y sin tocar el puente, aunque esté caído', async () => {
    puenteSinConfigurar()
    expect((await aggregatePaymentsByMethod(OTRO_NEGOCIO, FECHAS)).legacyUnavailable).toBeUndefined()
    expect((await fetchPaymentsForAnalytics(OTRO_NEGOCIO, FECHAS)).legacyUnavailable).toBeUndefined()
    expect(consultasAlPuente()).toBe(0)
  })
})

describe('Inicio (generalStats)', () => {
  const RANGO = { fromDate: DESDE, toDate: HASTA }

  it('🔴 tarjetas (basic-metrics): suma parcial marcada', async () => {
    fallaLaSegundaPagina()

    const inicio = await getBasicMetricsData(MINDFORM, { ...RANGO, responseMode: 'aggregated-v1' })

    expect(inicio.legacyUnavailable).toBe(true)
    expect(inicio.summary).toMatchObject({ totalAmount: 50000, totalTips: 5000, totalTransactions: 500 })
  })

  it('tarjetas con el puente sano: sin marca', async () => {
    puenteSano()
    const inicio = await getBasicMetricsData(MINDFORM, { ...RANGO, responseMode: 'aggregated-v1' })
    expect(inicio).not.toHaveProperty('legacyUnavailable')
    expect(inicio.summary.totalAmount).toBe(300)
  })

  it('🔴 detalle para exportar (basic-metrics/details): la página dice que le faltan los cobros QR', async () => {
    puenteContesta(PUENTE_CAIDO)

    const pagina = await getBasicMetricsDetailsPage(MINDFORM, { ...RANGO, kind: 'payments', limit: 10 })

    expect(pagina).toEqual({ items: [], nextCursor: null, legacyUnavailable: true })
  })

  // Codex r2 #2, confirmación: el detalle de RESEÑAS no lleva cobros, así que no pregunta al puente ni avisa.
  it('detalle de reseñas con el puente caído: sin marca y sin preguntarle', async () => {
    fallaLaSegundaPagina()
    ;(prismaMock.review.findMany as jest.Mock).mockResolvedValue([])

    const pagina = await getBasicMetricsDetailsPage(MINDFORM, { ...RANGO, kind: 'reviews', limit: 10 })

    expect(pagina).toEqual({ items: [], nextCursor: null })
    expect(consultasAlPuente()).toBe(0)
  })

  it('detalle con el puente sano: sin marca', async () => {
    puenteSano()
    const pagina = await getBasicMetricsDetailsPage(MINDFORM, { ...RANGO, kind: 'payments', limit: 10 })
    expect(pagina).not.toHaveProperty('legacyUnavailable')
    expect(pagina.items).toHaveLength(3)
  })

  it('🔴 Codex r1 #1 — Inicio cargó sano y DESPUÉS falla la gráfica de propinas: la serie viaja marcada', async () => {
    puenteSano()
    expect(await getBasicMetricsData(MINDFORM, { ...RANGO, responseMode: 'aggregated-v1' })).not.toHaveProperty('legacyUnavailable')

    fallaLaSegundaPagina()
    const propinas = (await getChartData(MINDFORM, 'tips-over-time', RANGO)) as unknown as { payments: unknown[]; legacyUnavailable?: true }

    expect(propinas.legacyUnavailable).toBe(true)
    expect(propinas.payments).toHaveLength(TAMANO_DE_PAGINA)
  })

  it('🔴 la gráfica de ventas por método también viaja marcada', async () => {
    fallaLaSegundaPagina()
    const porMetodo = (await getChartData(MINDFORM, 'sales-by-payment-method', RANGO)) as unknown as { legacyUnavailable?: true }
    expect(porMetodo.legacyUnavailable).toBe(true)
  })

  it('gráficas con el puente sano: sin marca', async () => {
    puenteSano()
    expect(await getChartData(MINDFORM, 'tips-over-time', RANGO)).not.toHaveProperty('legacyUnavailable')
    puenteSano()
    expect(await getChartData(MINDFORM, 'sales-by-payment-method', RANGO)).not.toHaveProperty('legacyUnavailable')
  })
})

describe('Resumen de ventas (getSalesSummary)', () => {
  const RANGO = { startDate: DESDE, endDate: HASTA }

  it('🔴 totales: suma parcial marcada (y el reporte NO falla)', async () => {
    fallaLaSegundaPagina()

    const reporte = await getSalesSummary(MINDFORM, RANGO)

    expect(reporte.legacyUnavailable).toBe(true)
    expect(reporte.summary).toMatchObject({ grossSales: 50000, tips: 5000, totalCollected: 55000, transactionCount: 500 })
  })

  it('🔴 puente sin configurar: totales marcados', async () => {
    puenteSinConfigurar()
    expect((await getSalesSummary(MINDFORM, RANGO)).legacyUnavailable).toBe(true)
  })

  it('totales con el puente sano (con filas o con cero): sin marca', async () => {
    puenteSano()
    const conFilas = await getSalesSummary(MINDFORM, RANGO)
    expect(conFilas).not.toHaveProperty('legacyUnavailable')
    expect(conFilas.summary.transactionCount).toBe(3)

    puenteContesta([])
    expect(await getSalesSummary(MINDFORM, RANGO)).not.toHaveProperty('legacyUnavailable')
  })

  it('🔴 filtro «QR legacy» (por método): suma parcial marcada', async () => {
    fallaLaSegundaPagina()

    const reporte = await getSalesSummary(MINDFORM, { ...RANGO, paymentMethod: 'QR_LEGACY' })

    expect(reporte.legacyUnavailable).toBe(true)
    expect(reporte.summary).toMatchObject({ tips: 5000, totalCollected: 55000, transactionCount: 500 })
  })

  it('filtro «QR legacy» con el puente sano: sin marca', async () => {
    puenteSano()
    expect(await getSalesSummary(MINDFORM, { ...RANGO, paymentMethod: 'QR_LEGACY' })).not.toHaveProperty('legacyUnavailable')
  })

  // Codex r1: «una consulta por periodos exitosa no debe BORRAR el fallo previo del recorrido por páginas».
  it('🔴 con gráfica por día: la consulta por periodos sale bien y NO borra la marca del total (sin filtro)', async () => {
    puenteContesta(cobrosLegacy(TAMANO_DE_PAGINA), PUENTE_CAIDO, []) // la tercera consulta (por periodos) contesta sana

    const reporte = await getSalesSummary(MINDFORM, { ...RANGO, reportType: 'days' })

    expect(consultasAlPuente()).toBe(3)
    expect(reporte.legacyUnavailable).toBe(true)
  })

  it('🔴 con gráfica por día y filtro «QR legacy»: la consulta por periodos tampoco borra la marca', async () => {
    puenteContesta(cobrosLegacy(TAMANO_DE_PAGINA), PUENTE_CAIDO, [])

    const reporte = await getSalesSummary(MINDFORM, { ...RANGO, reportType: 'days', paymentMethod: 'QR_LEGACY' })

    expect(consultasAlPuente()).toBe(3)
    expect(reporte.legacyUnavailable).toBe(true)
  })

  it('regresión: si lo que falla es SÓLO la consulta por periodos, se sigue marcando como antes', async () => {
    puenteContesta(cobrosLegacy(3), PUENTE_CAIDO)
    expect((await getSalesSummary(MINDFORM, { ...RANGO, reportType: 'days' })).legacyUnavailable).toBe(true)
  })

  // D9.1 (21-nov): los cobros QR del sistema anterior no tienen comercio. Con un comercio elegido no suman (ni en el total ni en
  // los periodos), así que tampoco se le pregunta al puente ni su caída marca un total en el que no entran.
  it('🔴 con un comercio elegido: el puente no suma, no se le pregunta y su caída no marca', async () => {
    ;(prismaMock.payment.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: 700, tipAmount: 70 } })
    ;(prismaMock.payment.count as jest.Mock).mockResolvedValue(7)
    fallaLaSegundaPagina()

    const reporte = await getSalesSummary(MINDFORM, { ...RANGO, merchantAccountId: 'comercio-a' })
    const porDia = await getSalesSummary(MINDFORM, { ...RANGO, merchantAccountId: 'comercio-a', reportType: 'days' })

    expect(consultasAlPuente()).toBe(0)
    expect(reporte).not.toHaveProperty('legacyUnavailable')
    expect(porDia).not.toHaveProperty('legacyUnavailable')
    expect(reporte.summary).toMatchObject({ grossSales: null, tips: 70, totalCollected: 770, transactionCount: 7 })
  })

  it('otro negocio: sin marca y sin tocar el puente', async () => {
    puenteSinConfigurar()
    expect(await getSalesSummary(OTRO_NEGOCIO, RANGO)).not.toHaveProperty('legacyUnavailable')
    expect(consultasAlPuente()).toBe(0)
  })

  // Codex r2 #2 (regresión del arreglo): «Otros» y «Tarjeta → Débito / Amex / Internacional» no admiten NINGÚN cobro QR legacy
  // (`legacyAdmission(...).include === false`). El recorrido de totales preguntaba igual al puente y copiaba su caída: el panel
  // y el exporte avisaban «puede estar incompleto» de un total en el que ningún cobro del puente puede entrar.
  describe('un filtro que excluye todo el QR legacy', () => {
    const EXCLUYEN: Array<[string, Pick<SalesSummaryFilters, 'paymentMethod' | 'cardType'>]> = [
      ['«Otros»', { paymentMethod: 'OTHER' }],
      ['«Tarjeta → Débito»', { paymentMethod: 'CARD', cardType: 'DEBIT' }],
      ['«Tarjeta → Amex»', { paymentMethod: 'CARD', cardType: 'AMEX' }],
      ['«Tarjeta → Internacional»', { paymentMethod: 'CARD', cardType: 'INTERNATIONAL' }],
    ]
    const INCLUYEN: Array<[string, Pick<SalesSummaryFilters, 'paymentMethod' | 'cardType'>]> = [
      ['sin filtro', {}],
      ['«Efectivo»', { paymentMethod: 'CASH' }],
      ['«Tarjeta»', { paymentMethod: 'CARD' }],
      ['«Tarjeta → Crédito»', { paymentMethod: 'CARD', cardType: 'CREDIT' }],
      ['«QR legacy»', { paymentMethod: 'QR_LEGACY' }],
    ]

    beforeEach(() => {
      // Avoqado SÍ tiene cobros propios en estas pruebas: así «las mismas cifras» no es comparar ceros con ceros.
      ;(prismaMock.payment.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: 700, tipAmount: 70 } })
      ;(prismaMock.payment.count as jest.Mock).mockResolvedValue(7)
    })

    it.each(EXCLUYEN)(
      '🔴 %s con el puente caído: sin marca, sin preguntarle al puente y con las mismas cifras',
      async (_nombre, filtro) => {
        // Lo que salía antes del arreglo de D15 (y lo que sale con el puente sano): el filtro ya dejaba fuera todo lo legacy.
        puenteContesta(cobrosLegacy(3))
        const conPuenteSano = await getSalesSummary(MINDFORM, { ...RANGO, ...filtro })

        fallaLaSegundaPagina()
        const conPuenteCaido = await getSalesSummary(MINDFORM, { ...RANGO, ...filtro })

        expect(conPuenteCaido).not.toHaveProperty('legacyUnavailable')
        expect(consultasAlPuente()).toBe(0)
        expect(conPuenteCaido.summary).toEqual(conPuenteSano.summary)
        expect(conPuenteCaido.summary).toMatchObject({ tips: 70, totalCollected: 770, transactionCount: 7 }) // sólo lo de Avoqado
      },
    )

    it.each(EXCLUYEN)('🔴 %s con el puente sin configurar: sin marca', async (_nombre, filtro) => {
      puenteSinConfigurar()
      expect(await getSalesSummary(MINDFORM, { ...RANGO, ...filtro })).not.toHaveProperty('legacyUnavailable')
    })

    it.each(EXCLUYEN)(
      '%s con gráfica por día y el puente caído: tampoco marca (la consulta por periodos ya lo respetaba)',
      async (_n, filtro) => {
        puenteContesta(PUENTE_CAIDO, PUENTE_CAIDO)
        const reporte = await getSalesSummary(MINDFORM, { ...RANGO, ...filtro, reportType: 'days' })
        expect(reporte).not.toHaveProperty('legacyUnavailable')
        expect(consultasAlPuente()).toBe(0)
      },
    )

    it.each(INCLUYEN)('%s SÍ admite cobros QR legacy: con el puente caído se sigue marcando', async (_nombre, filtro) => {
      fallaLaSegundaPagina()
      expect((await getSalesSummary(MINDFORM, { ...RANGO, ...filtro })).legacyUnavailable).toBe(true)
    })
  })
})
