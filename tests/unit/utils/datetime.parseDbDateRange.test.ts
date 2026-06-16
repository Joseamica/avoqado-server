/**
 * parseDbDateRange runtime-TZ-independence (2026-06-15). On a UTC Node host (prod
 * default — no TZ set) a bare "YYYY-MM-DD" used to be parsed as UTC midnight, so
 * venueStartOfDay floored it to the PREVIOUS day → the whole range shifted a day
 * earlier (income statement / org dashboard reported the wrong days on prod).
 * These exact-ISO assertions hold under ANY host TZ now; they would have FAILED
 * under TZ=UTC before the fix.
 */
import { parseDbDateRange } from '../../../src/utils/datetime'
import { BadRequestError } from '../../../src/errors/AppError'

describe('parseDbDateRange — venue-local day boundaries, runtime-TZ-independent', () => {
  it('bare YYYY-MM-DD range → exact venue-local boundaries in real UTC (Mexico, UTC-6)', () => {
    const { from, to } = parseDbDateRange('2026-06-02', '2026-06-15', 'America/Mexico_City')
    expect(from.toISOString()).toBe('2026-06-02T06:00:00.000Z') // jun-2 00:00 Mexico
    expect(to.toISOString()).toBe('2026-06-16T05:59:59.999Z') // end of jun-15 Mexico (whole last day in)
  })

  it('includes the WHOLE toDate day (end-of-day, not midnight)', () => {
    const { to } = parseDbDateRange('2026-06-02', '2026-06-02', 'America/Mexico_City')
    expect(to.toISOString()).toBe('2026-06-03T05:59:59.999Z')
  })

  it('honors the venue timezone (UTC venue = literal UTC day)', () => {
    const { from, to } = parseDbDateRange('2026-06-02', '2026-06-02', 'UTC')
    expect(from.toISOString()).toBe('2026-06-02T00:00:00.000Z')
    expect(to.toISOString()).toBe('2026-06-02T23:59:59.999Z')
  })

  it('a full ISO instant is treated as the venue-day containing it (unchanged path, also TZ-independent)', () => {
    const { from, to } = parseDbDateRange('2026-06-02T06:00:00.000Z', '2026-06-02T06:00:00.000Z', 'America/Mexico_City')
    expect(from.toISOString()).toBe('2026-06-02T06:00:00.000Z')
    expect(to.toISOString()).toBe('2026-06-03T05:59:59.999Z')
  })
})

/**
 * Regresión (2026-06-16, hallazgo de /full-testing): una fecha con FORMATO válido pero
 * IRREAL (mes 13, día 99, 30-feb) pasaba el regex de Zod y reventaba aquí con un Error
 * genérico → HTTP 500. Ahora lanza BadRequestError → HTTP 400. Cubre income-statement,
 * business-summary y banks (todos via parseDbDateRange) + cualquier otro caller.
 */
describe('parseDbDateRange — fechas inválidas → BadRequestError (400, no 500)', () => {
  it('mes inexistente (2026-13-99) lanza BadRequestError', () => {
    expect(() => parseDbDateRange('2026-13-99', '2026-12-31', 'America/Mexico_City')).toThrow(BadRequestError)
  })

  it('día inexistente (30 de febrero) lanza BadRequestError', () => {
    expect(() => parseDbDateRange('2026-01-01', '2026-02-30', 'America/Mexico_City')).toThrow(BadRequestError)
  })

  it('el error es 400 (statusCode), no 500', () => {
    try {
      parseDbDateRange('2026-99-99', '2026-12-31', 'America/Mexico_City')
      throw new Error('no lanzó')
    } catch (e: any) {
      expect(e).toBeInstanceOf(BadRequestError)
      expect(e.statusCode).toBe(400)
    }
  })

  it('una fecha real sigue funcionando (no rompimos el camino feliz)', () => {
    expect(() => parseDbDateRange('2026-02-28', '2026-12-31', 'America/Mexico_City')).not.toThrow()
  })
})
