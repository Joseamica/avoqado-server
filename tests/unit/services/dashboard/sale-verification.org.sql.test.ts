/**
 * Expresiones SQL compartidas de las agregaciones de ventas org.
 *
 * Estas cadenas se interpolan en SQL crudo, así que hay dos cosas que probar:
 *   1. Que produzcan el bucket correcto, y que el formato coincida CARÁCTER POR CARÁCTER
 *      con lo que calcula `venueDateKeys` en JS. Si se separan, los números dejan de
 *      cuadrar sin que nada falle visiblemente.
 *   2. Que una zona horaria inventada no pueda colarse como inyección.
 */
import {
  venueLocalExpr,
  monthBucketSql,
  dayBucketSql,
  isoWeekKeySql,
  weekLabelSql,
  buildRangeConditions,
} from '@/services/dashboard/sale-verification.org.sql'

const TZ = 'America/Mexico_City'
const COL = 'sv."createdAt"'

describe('expresiones de fecha', () => {
  it('convierte de UTC almacenado a hora local del venue', () => {
    // Doble AT TIME ZONE: el primero marca el timestamp como UTC, el segundo lo lleva
    // a hora de pared del venue. Precedente: commandCenter.service.ts:590.
    expect(venueLocalExpr(COL, TZ)).toBe(`(sv."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City')`)
  })

  it('mes en formato YYYY-MM, igual que venueMonthKey', () => {
    expect(monthBucketSql(COL, TZ)).toBe(`to_char((sv."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City'), 'YYYY-MM')`)
  })

  it('día en formato YYYY-MM-DD, igual que venueDayKey', () => {
    expect(dayBucketSql(COL, TZ)).toBe(`to_char((sv."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City'), 'YYYY-MM-DD')`)
  })

  it('semana usa IYYY/IW — el año ISO, no el calendario', () => {
    // 🔴 IYYY, no YYYY. Con YYYY, el 3-ene-2027 saldría "2027-W53" en vez de "2026-W53".
    // Sólo se nota en los bordes de año, que es justo cuando más duele.
    expect(isoWeekKeySql(COL, TZ)).toBe(`to_char((sv."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City'), 'IYYY-"W"IW')`)
  })

  it('etiqueta de semana sin año, igual que venueWeekLabel', () => {
    expect(weekLabelSql(COL, TZ)).toBe(`to_char((sv."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City'), '"W"IW')`)
  })
})

describe('defensa contra inyección por zona horaria', () => {
  it.each([
    [`America/Mexico_City'; DROP TABLE "Payment"; --`, 'intento de DROP'],
    [`'; SELECT 1; --`, 'comilla suelta'],
    ['Zona/Inventada', 'zona que no existe'],
    ['', 'cadena vacía'],
  ])('rechaza %p (%s)', bad => {
    expect(() => monthBucketSql(COL, bad)).toThrow()
    expect(() => isoWeekKeySql(COL, bad)).toThrow()
    expect(() => dayBucketSql(COL, bad)).toThrow()
    expect(() => weekLabelSql(COL, bad)).toThrow()
  })

  it('acepta zonas IANA reales', () => {
    expect(() => monthBucketSql(COL, 'UTC')).not.toThrow()
    expect(() => monthBucketSql(COL, 'America/Monterrey')).not.toThrow()
    expect(() => monthBucketSql(COL, 'America/Tijuana')).not.toThrow()
  })
})

describe('buildRangeConditions — las fechas van PARAMETRIZADAS, nunca interpoladas', () => {
  it('sin rango no agrega nada', () => {
    const sql = buildRangeConditions({}, COL)
    expect(sql.strings.join('')).toBe('')
    expect(sql.values).toEqual([])
  })

  it('sólo fecha inicial', () => {
    const desde = new Date('2026-08-01T06:00:00Z')
    const sql = buildRangeConditions({ fromDate: desde }, COL)
    expect(sql.strings.join('')).toContain('>=')
    expect(sql.values).toEqual([desde])
  })

  it('sólo fecha final', () => {
    const hasta = new Date('2026-08-31T05:59:59Z')
    const sql = buildRangeConditions({ toDate: hasta }, COL)
    expect(sql.strings.join('')).toContain('<=')
    expect(sql.values).toEqual([hasta])
  })

  it('ambas fechas, como parámetros y en orden', () => {
    const desde = new Date('2026-08-01T06:00:00Z')
    const hasta = new Date('2026-08-31T05:59:59Z')
    const sql = buildRangeConditions({ fromDate: desde, toDate: hasta }, COL)
    // Las fechas NUNCA aparecen como texto dentro del SQL: van en values.
    expect(sql.strings.join('')).not.toContain('2026')
    expect(sql.values).toEqual([desde, hasta])
  })

  /**
   * 🔴 REGRESIÓN: sin este `AT TIME ZONE 'UTC'` el rango se corre SEIS HORAS.
   *
   * La columna es `timestamp without time zone` guardando UTC; Prisma manda el `Date` como
   * `timestamp with time zone`; la sesión de Postgres está en `America/Mexico_City`. Al
   * compararlos directo, Postgres lee el valor UTC de la columna como si fuera hora de
   * México. Verificado contra la base real el 2026-08-04: `'2026-08-04 05:00:00'::timestamp
   * >= <2026-08-04T06:00:00Z>` devolvía `true` cuando la respuesta correcta es `false`.
   *
   * Si alguien borra el AT TIME ZONE "porque se ve redundante", todos los reportes con
   * rango de fechas empiezan a incluir seis horas del día anterior. En silencio.
   */
  it('marca la columna como UTC antes de comparar — si no, el rango se corre 6 horas', () => {
    const sql = buildRangeConditions({ fromDate: new Date('2026-08-01T06:00:00Z') }, COL)
    expect(sql.strings.join('')).toContain(`AT TIME ZONE 'UTC'`)
  })

  it('marca la columna como UTC también en la fecha final', () => {
    const sql = buildRangeConditions({ toDate: new Date('2026-08-31T05:59:59Z') }, COL)
    expect(sql.strings.join('')).toContain(`AT TIME ZONE 'UTC'`)
  })
})
