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
 *
 * 2026-09-01: la agregación por día de la semana se movió a Postgres (GROUP BY
 * sobre ISODOW en la zona del venue) tras el incidente del event loop. Aquí se
 * prueba la capa de FORMA que quedó en Node (el arreglo de 7 días, la variación
 * porcentual) y la forma de la consulta (el timezone del venue viaja como bind,
 * los estados descartados van en el WHERE). El bucketing REAL por zona horaria
 * ya no es simulable con un mock — vive contra Postgres de verdad en
 * tests/integration/dashboard/generalStats-sql-aggregation.integration.test.ts.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    $queryRaw: jest.fn(),
  },
}))

import prisma from '../../../../src/utils/prismaClient'
import { getChartData } from '../../../../src/services/dashboard/generalStats.dashboard.service'

const VENUE = 'venue-test-1'
const TZ = 'America/Mexico_City'

// Rango: lunes 2026-06-01 a domingo 2026-06-07 (hora local del venue).
const FROM = '2026-06-01'
const TO = '2026-06-07'

// Aplana el tagged template que recibió el mock de $queryRaw: los fragmentos
// anidados (Prisma.sql / Prisma.raw) se expanden y los binds reales se juntan.
function flattenSql(strings: ReadonlyArray<string>, values: unknown[]): { text: string; binds: unknown[] } {
  let text = ''
  const binds: unknown[] = []
  for (let i = 0; i < strings.length; i++) {
    text += strings[i]
    if (i < values.length) {
      const v = values[i] as { strings?: ReadonlyArray<string>; values?: unknown[] } | unknown
      if (v && typeof v === 'object' && Array.isArray((v as any).strings)) {
        const inner = flattenSql((v as any).strings, (v as any).values ?? [])
        text += inner.text
        binds.push(...inner.binds)
      } else {
        text += '?'
        binds.push(v)
      }
    }
  }
  return { text, binds }
}

function lastQuery() {
  const calls = (prisma.$queryRaw as jest.Mock).mock.calls
  const [strings, ...values] = calls[calls.length - 1]
  return flattenSql(strings, values)
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ id: VENUE, timezone: TZ })
  ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([])
})

describe('weekly-trends: venta real, no aleatoria', () => {
  it('es DETERMINISTA — dos llamadas con la misma entrada dan el mismo resultado', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([
      // Postgres ya agregó: lunes con 150 de venta en el periodo actual.
      { idx: 1, current: 150, previous: 0 },
    ])

    const a = await getChartData(VENUE, 'weekly-trends', { fromDate: FROM, toDate: TO })
    const b = await getChartData(VENUE, 'weekly-trends', { fromDate: FROM, toDate: TO })

    expect(a).toEqual(b)
  })

  it('agrupa EN LA ZONA DEL VENUE: el timezone viaja como bind y el bucket es doble AT TIME ZONE', async () => {
    await getChartData(VENUE, 'weekly-trends', { fromDate: FROM, toDate: TO })

    const { text, binds } = lastQuery()
    // 🔴 Se fija el ORDEN de la composición, no su mera presencia: primero se
    // declara que el valor guardado es UTC, y sólo entonces se convierte a la zona
    // del venue. La composición INVERTIDA —(col AT TIME ZONE tz) AT TIME ZONE 'UTC'—
    // contiene exactamente los mismos dos fragmentos y produce el corrimiento de 6
    // horas que este archivo existe para prevenir; una aserción que sólo comprobara
    // que ambos aparecen pasaría con el defecto puesto.
    expect(text).toMatch(/AT TIME ZONE 'UTC'\)\s*AT TIME ZONE \?/)
    expect(text).not.toMatch(/AT TIME ZONE \?\)\s*AT TIME ZONE 'UTC'/)
    // La zona viaja como BIND, nunca interpolada en el texto (no es inyectable).
    expect(binds).toContain(TZ)
    // El caso con datos reales (04:30Z = ayer 22:30 local) vive en integración.
  })

  it('excluye órdenes canceladas, pendientes y borradas, acotado al venue', async () => {
    await getChartData(VENUE, 'weekly-trends', { fromDate: FROM, toDate: TO })

    const { text, binds } = lastQuery()
    expect(text).toContain(`NOT IN ('PENDING','CANCELLED','DELETED')`)
    expect(binds).toContain(VENUE)
  })

  it('devuelve 0% de variación cuando no hay periodo anterior, en vez de un número inventado', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ idx: 1, current: 900, previous: 0 }])

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
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ idx: 1, current: 150, previous: 100 }])

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
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([])

    const data = (await getChartData(VENUE, 'weekly-trends', { fromDate: FROM, toDate: TO })) as Array<{ day: string }>

    expect(data.map(d => d.day)).toEqual(['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'])
  })
})
