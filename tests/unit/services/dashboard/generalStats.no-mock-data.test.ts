/**
 * Guardia contra datos fabricados en el resumen general del dashboard.
 *
 * Estas tres superficies devolvían valores INVENTADOS a clientes reales:
 *  - `weekly-trends`: una gráfica de tendencia semanal de ventas construida con
 *    `Math.random()`, que daba cifras distintas en cada refresh de la pantalla.
 *  - `avgPrepTime` por empleado: `Math.random()`.
 *  - `prepTimesByCategory`: constantes fijas, idénticas para todos los venues.
 *
 * La prueba de fuego de que ya no se fabrica nada es el DETERMINISMO: con la misma
 * entrada, dos llamadas consecutivas deben devolver exactamente lo mismo. Si alguien
 * vuelve a meter aleatoriedad, este test truena.
 */
import { OrderStatus } from '@prisma/client'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    order: { findMany: jest.fn() },
    kdsOrder: { findMany: jest.fn() },
  },
}))

import prisma from '../../../../src/utils/prismaClient'
import { getChartData } from '../../../../src/services/dashboard/generalStats.dashboard.service'

const VENUE = 'venue-test-1'
const TZ = 'America/Mexico_City'

// Rango: lunes 2026-06-01 a domingo 2026-06-07 (hora local del venue).
const FROM = '2026-06-01'
const TO = '2026-06-07'

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ id: VENUE, timezone: TZ })
})

describe('weekly-trends: venta real, no aleatoria', () => {
  it('es DETERMINISTA — dos llamadas con la misma entrada dan el mismo resultado', async () => {
    ;(prisma.order.findMany as jest.Mock).mockResolvedValue([
      // Lunes 1-jun 14:00 local = 20:00 UTC
      { total: 100, createdAt: new Date('2026-06-01T20:00:00Z') },
      { total: 50, createdAt: new Date('2026-06-01T20:30:00Z') },
    ])

    const a = await getChartData(VENUE, 'weekly-trends', { fromDate: FROM, toDate: TO })
    const b = await getChartData(VENUE, 'weekly-trends', { fromDate: FROM, toDate: TO })

    expect(a).toEqual(b)
  })

  it('suma la venta en el día correcto de la semana EN LA ZONA DEL VENUE', async () => {
    // 2026-06-02T04:00:00Z = lunes 1-jun 22:00 en México. Agrupar en UTC lo pondría
    // en martes: es exactamente el bug que se busca prevenir (prod corre en UTC).
    ;(prisma.order.findMany as jest.Mock).mockResolvedValue([{ total: 250, createdAt: new Date('2026-06-02T04:00:00Z') }])

    const data = (await getChartData(VENUE, 'weekly-trends', { fromDate: FROM, toDate: TO })) as Array<{
      day: string
      currentWeek: number
    }>

    expect(data.find(d => d.day === 'Lunes')?.currentWeek).toBe(250)
    expect(data.find(d => d.day === 'Martes')?.currentWeek).toBe(0)
  })

  it('excluye órdenes canceladas, pendientes y borradas', async () => {
    await getChartData(VENUE, 'weekly-trends', { fromDate: FROM, toDate: TO })

    const where = (prisma.order.findMany as jest.Mock).mock.calls[0][0].where
    expect(where.status.notIn).toEqual(expect.arrayContaining([OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED]))
    expect(where.venueId).toBe(VENUE)
  })

  it('devuelve 0% de variación cuando no hay periodo anterior, en vez de un número inventado', async () => {
    ;(prisma.order.findMany as jest.Mock).mockResolvedValue([{ total: 900, createdAt: new Date('2026-06-01T20:00:00Z') }])

    const data = (await getChartData(VENUE, 'weekly-trends', { fromDate: FROM, toDate: TO })) as Array<{
      day: string
      previousWeek: number
      changePercentage: number
    }>
    const lunes = data.find(d => d.day === 'Lunes')!

    expect(lunes.previousWeek).toBe(0)
    expect(lunes.changePercentage).toBe(0)
  })

  it('calcula la variación real contra el periodo inmediato anterior', async () => {
    ;(prisma.order.findMany as jest.Mock).mockResolvedValue([
      { total: 150, createdAt: new Date('2026-06-01T20:00:00Z') }, // periodo actual, lunes
      { total: 100, createdAt: new Date('2026-05-25T20:00:00Z') }, // periodo anterior, lunes
    ])

    const data = (await getChartData(VENUE, 'weekly-trends', { fromDate: FROM, toDate: TO })) as Array<{
      day: string
      currentWeek: number
      previousWeek: number
      changePercentage: number
    }>
    const lunes = data.find(d => d.day === 'Lunes')!

    expect(lunes.currentWeek).toBe(150)
    expect(lunes.previousWeek).toBe(100)
    expect(lunes.changePercentage).toBe(50)
  })

  it('conserva los siete días de la semana en la respuesta (contrato con el dashboard)', async () => {
    ;(prisma.order.findMany as jest.Mock).mockResolvedValue([])

    const data = (await getChartData(VENUE, 'weekly-trends', { fromDate: FROM, toDate: TO })) as Array<{ day: string }>

    expect(data.map(d => d.day)).toEqual(['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'])
  })
})
