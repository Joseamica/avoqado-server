/**
 * Fechas del cuadrante y del reporte — forma Y calendario.
 * Auditoría Codex de la fase 2 del checador (2026-08-26), hallazgo 3: `2026-13-40` pasaba.
 */
import { AttendanceReportSchema, ReplaceWorkScheduleSchema } from '@/schemas/dashboard/attendance.schema'

const params = { venueId: 'ckz0000000000000000000001', staffVenueId: 'ckz0000000000000000000002' }
const weekly = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: false, ranges: [] }]),
)

describe('isoDate', () => {
  it('rechaza mes 13 y día 40 aunque tengan la forma correcta', () => {
    const r = ReplaceWorkScheduleSchema.safeParse({
      params,
      body: { weekly, exceptions: [{ startDate: '2026-13-40', endDate: '2026-13-41', kind: 'OFF' }] },
    })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.success ? null : r.error.issues)).toMatch(/calendario/)
  })

  it('rechaza el 30 de febrero', () => {
    const r = AttendanceReportSchema.safeParse({
      params: { venueId: params.venueId },
      query: { startDate: '2026-02-30', endDate: '2026-03-01' },
    })
    expect(r.success).toBe(false)
  })

  it('regresión: una fecha real sigue pasando, y la forma DD-MM-YYYY sigue fallando por forma', () => {
    expect(
      AttendanceReportSchema.safeParse({ params: { venueId: params.venueId }, query: { startDate: '2026-02-28', endDate: '2026-03-01' } })
        .success,
    ).toBe(true)
    const bad = AttendanceReportSchema.safeParse({
      params: { venueId: params.venueId },
      query: { startDate: '28-02-2026', endDate: '2026-03-01' },
    })
    expect(bad.success).toBe(false)
    expect(JSON.stringify(bad.success ? null : bad.error.issues)).toMatch(/YYYY-MM-DD/)
  })
})
