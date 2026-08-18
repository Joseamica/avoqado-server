/**
 * Llaves de fecha venue-local.
 *
 * El bug que estos tests previenen: `toWeekLabel` construía un Date parseando un string
 * local y luego leía sus componentes con getUTC*, así que el epoch se recorría según el TZ
 * del PROCESO. Resultado medido (2026-08-04): bajo `TZ=UTC` (producción) 2027 divergía del
 * ISO real en 8,320 de 8,760 horas; bajo `TZ=America/Mexico_City`, 2026 ya divergía en 312.
 * O sea: dev y prod no estaban de acuerdo en qué semana fue una venta.
 *
 * Por eso el barrido de abajo corre bajo AMBAS zonas de host y exige resultado idéntico.
 */
import { venueCivilDate, venueMonthKey, venueDayKey, venueIsoWeek, venueWeekLabel, venueIsoWeekKey } from '@/utils/venueDateKeys'

const TZ = 'America/Mexico_City'

describe('venueDateKeys', () => {
  describe('venueCivilDate', () => {
    it('convierte un instante UTC a la fecha civil de México', () => {
      // 2026-08-05 02:00 UTC = 2026-08-04 20:00 en México
      expect(venueCivilDate(new Date('2026-08-05T02:00:00Z'), TZ)).toEqual({ year: 2026, month: 8, day: 4 })
    })

    it('cruza el cambio de mes correctamente', () => {
      // 2026-09-01 04:00 UTC = 2026-08-31 22:00 en México
      expect(venueCivilDate(new Date('2026-09-01T04:00:00Z'), TZ)).toEqual({ year: 2026, month: 8, day: 31 })
    })
  })

  describe('venueMonthKey / venueDayKey', () => {
    it('formatea con ceros a la izquierda', () => {
      expect(venueMonthKey(new Date('2026-03-09T18:00:00Z'), TZ)).toBe('2026-03')
      expect(venueDayKey(new Date('2026-03-09T18:00:00Z'), TZ)).toBe('2026-03-09')
    })

    it('usa el día de México, no el del host', () => {
      // 2026-01-01 03:00 UTC = 2025-12-31 21:00 en México
      expect(venueMonthKey(new Date('2026-01-01T03:00:00Z'), TZ)).toBe('2025-12')
      expect(venueDayKey(new Date('2026-01-01T03:00:00Z'), TZ)).toBe('2025-12-31')
    })
  })

  describe('venueIsoWeek — ISO 8601 real', () => {
    // Referencia ISO 8601: la semana 1 es la que contiene el primer jueves del año.
    it.each([
      // instante UTC            isoYear  semana   por qué importa
      ['2026-01-01T18:00:00Z', 2026, 1], // jue 1-ene-2026 → W01
      ['2026-01-11T23:00:00Z', 2026, 2], // domingo por la noche
      ['2026-08-04T18:00:00Z', 2026, 32],
      ['2027-01-04T18:00:00Z', 2027, 1], // 🔴 LA BOMBA: el código viejo decía W02
      ['2027-01-03T18:00:00Z', 2026, 53], // dom 3-ene-2027 pertenece a la W53 de 2026
      ['2028-01-01T18:00:00Z', 2027, 52], // sáb 1-ene-2028 pertenece a la W52 de 2027
    ])('%s → %i-W%i', (iso, expectedYear, expectedWeek) => {
      expect(venueIsoWeek(new Date(iso as string), TZ)).toEqual({
        isoYear: expectedYear,
        week: expectedWeek,
      })
    })
  })

  describe('venueWeekLabel / venueIsoWeekKey', () => {
    it('formatea con dos dígitos', () => {
      expect(venueWeekLabel(new Date('2026-01-01T18:00:00Z'), TZ)).toBe('W01')
      expect(venueIsoWeekKey(new Date('2026-01-01T18:00:00Z'), TZ)).toBe('2026-W01')
      expect(venueIsoWeekKey(new Date('2027-01-04T18:00:00Z'), TZ)).toBe('2027-W01')
    })

    it('la llave usa el AÑO ISO, no el calendario (3-ene-2027 es 2026-W53)', () => {
      expect(venueIsoWeekKey(new Date('2027-01-03T18:00:00Z'), TZ)).toBe('2026-W53')
    })
  })

  describe('independencia del TZ del host — la regresión que motivó el módulo', () => {
    it('barrido hora por hora 2026-2028 coincide con el ISO de referencia', () => {
      // Referencia independiente: aritmética pura sobre la fecha civil.
      const ref = (d: Date): string => {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: TZ,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(d)
        const get = (t: string) => Number(parts.find(x => x.type === t)!.value)
        const civil = Date.UTC(get('year'), get('month') - 1, get('day'))
        const dow = new Date(civil).getUTCDay() || 7
        const thu = civil + (4 - dow) * 86400000
        const isoYear = new Date(thu).getUTCFullYear()
        const week = Math.floor((thu - Date.UTC(isoYear, 0, 1)) / 604800000) + 1
        return `${isoYear}-W${String(week).padStart(2, '0')}`
      }

      let checked = 0
      for (let t = Date.parse('2026-01-01T00:00:00Z'); t < Date.parse('2029-01-01T00:00:00Z'); t += 3600_000) {
        const d = new Date(t)
        expect(venueIsoWeekKey(d, TZ)).toBe(ref(d))
        checked++
      }
      expect(checked).toBeGreaterThan(26_000) // 3 años de horas
    })
  })

  describe('rendimiento — el formateador se reusa, no se reconstruye por fila', () => {
    /**
     * Cota SUPERIOR de reloj: frágil por naturaleza en una máquina compartida (aquí corren
     * varias sesiones a la vez, con builds de Gradle/Vite encima). El ruido del SO sólo puede
     * INFLAR una medición, nunca reducirla, así que se toma el MÍNIMO de varias corridas — el
     * mismo patrón de `tests/unit/utils/eventLoopBudget.test.ts:44`.
     *
     * Y la vara va holgada a propósito: la regresión que este test busca —reconstruir el
     * `Intl.DateTimeFormat` por fila— cuesta DECENAS DE SEGUNDOS para 10,000 filas, no 600 ms.
     * Un margen 4× no le quita poder de detección y elimina el rojo falso.
     */
    const CORRIDAS = 3
    const VARA_MS = 2_000

    it(`10,000 conversiones tardan menos de ${VARA_MS} ms (mínimo de ${CORRIDAS} corridas)`, () => {
      const rows = Array.from({ length: 10_000 }, (_, i) => new Date(Date.UTC(2026, 6, 1) + i * 3600_000))

      let minimoMs = Infinity
      for (let intento = 0; intento < CORRIDAS; intento++) {
        const t0 = process.hrtime.bigint()
        for (const r of rows) venueIsoWeekKey(r, TZ)
        const ms = Number(process.hrtime.bigint() - t0) / 1e6
        if (ms < minimoMs) minimoMs = ms
      }

      expect(minimoMs).toBeLessThan(VARA_MS)
    })
  })
})
