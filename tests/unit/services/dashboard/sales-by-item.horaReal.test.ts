/**
 * D1 (hz:47b359b5:D1, tras D93 «B» como Square): «Ventas por artículo» lee las órdenes por su hora REAL, igual que el Resumen de
 * ventas. El POS pide los dos reportes del mismo día: una venta sin internet de las 23:50 que subió a las 00:10 salía el día 11 en
 * el Resumen y el 12 en Ventas por artículo. Ahora las tres consultas (artículos, promociones y barras) filtran, agrupan y cortan por
 * hora con «hora del aparato ?? llegada». La prueba con Postgres de verdad es `tests/integration/dashboard/sales-by-item-hora-real`.
 */
import { getSalesByItem } from '@/services/dashboard/sales-by-item.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'

const TZ = 'America/Mexico_City'
const RANGO = { startDate: '2026-11-11T06:00:00.000Z', endDate: '2026-11-12T05:59:59.999Z', timezone: TZ }
const REAL = 'COALESCE(o."clientCreatedAt", o."createdAt")'

function consultas(): string[] {
  return (prismaMock as any).$queryRawUnsafe.mock.calls.map((c: unknown[]) => String(c[0]))
}

describe('getSalesByItem — la hora real de lo vendido sin internet (D1)', () => {
  beforeEach(() => {
    ;(prismaMock as any).$queryRawUnsafe = jest.fn().mockResolvedValue([])
  })

  it('artículos y promociones filtran por la hora real, con la llegada ensanchada para usar el índice', async () => {
    await getSalesByItem('venue-1', { ...RANGO, reportType: 'summary' })
    const sqls = consultas()
    const articulos = sqls.find(s => s.includes('items_sold') && s.includes('units_sold'))!
    const promociones = sqls.find(s => s.includes('promotion_name'))!
    for (const sql of [articulos, promociones]) {
      expect(sql).toContain(`${REAL} >= ($2 AT TIME ZONE 'UTC')`)
      expect(sql).toContain(`${REAL} <= ($3 AT TIME ZONE 'UTC')`)
      expect(sql).toContain(`o."createdAt" <= (($3 AT TIME ZONE 'UTC')) + INTERVAL '25 hours'`)
      // Ya no queda el filtro viejo por la llegada sola.
      expect(sql).not.toContain(`o."createdAt" >= ($2 AT TIME ZONE 'UTC')`)
    }
  })

  it('las barras agrupan por la hora real del aparato en el reloj del negocio', async () => {
    await getSalesByItem('venue-1', { ...RANGO, reportType: 'days' })
    const barras = consultas().find(s => s.includes('as period'))!
    expect(barras).toContain(`DATE_TRUNC('day', ((${REAL} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}'))`)
    expect(barras).toContain(`${REAL} >= ($2 AT TIME ZONE 'UTC')`)
  })

  it('el filtro de horas (de 22:00 a 23:00) también mira la hora real', async () => {
    await getSalesByItem('venue-1', { ...RANGO, reportType: 'summary', startHour: '22:00', endHour: '23:00' })
    const articulos = consultas().find(s => s.includes('units_sold'))!
    expect(articulos).toContain(`EXTRACT(HOUR FROM ((${REAL} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')) >= 22`)
    expect(articulos).not.toContain(`EXTRACT(HOUR FROM ((o."createdAt" AT TIME ZONE 'UTC')`)
  })

  it('regresión: las fechas siguen viajando como parámetros ($2, $3), nunca pegadas al texto', async () => {
    await getSalesByItem('venue-1', { ...RANGO, reportType: 'summary' })
    const call = (prismaMock as any).$queryRawUnsafe.mock.calls[0]
    expect(call[1]).toBe('venue-1')
    expect(call[2]).toEqual(new Date(RANGO.startDate))
    expect(call[3]).toEqual(new Date(RANGO.endDate))
    expect(String(call[0])).not.toContain('2026-11-11')
  })
})
