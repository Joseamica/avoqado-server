/**
 * Decidir si una jornada fue puntual, tarde o falta.
 *
 * 🔴 Aquí vive la trampa de todo el checador: el horario se escribe en hora del NEGOCIO
 * ("Ana entra a las 9:00") y la checada se guarda en UTC. Comparar sin la zona del venue
 * hace que en México todo el mundo llegue seis horas tarde. Estas pruebas fijan zonas
 * reales y horarios de verano para que ese fallo no pueda pasar en silencio.
 *
 * Y una decisión de producto: sin horario definido NO se juzga. Un negocio que aún no
 * armó su cuadrante no debe ver a toda su gente marcada como falta.
 */
import { evaluateAttendance } from '@/services/dashboard/attendanceEvaluator'

const MX = 'America/Mexico_City'

// 2026-08-20 fue jueves. 9:00 en Ciudad de México = 15:00 UTC (UTC-6).
const at = (iso: string) => new Date(iso)

describe('evaluateAttendance', () => {
  const base = { expectedStart: '09:00', expectedEnd: '18:00', timezone: MX, graceMinutes: 10 }

  it('llegar antes de la hora es puntual', () => {
    const r = evaluateAttendance({ ...base, clockInTime: at('2026-08-20T14:55:00.000Z') })
    expect(r.status).toBe('ON_TIME')
    expect(r.lateMinutes).toBe(0)
  })

  it('llegar dentro de la tolerancia sigue siendo puntual', () => {
    // 9:08 hora de México — 8 minutos, por debajo de los 10 de gracia.
    const r = evaluateAttendance({ ...base, clockInTime: at('2026-08-20T15:08:00.000Z') })
    expect(r.status).toBe('ON_TIME')
  })

  it('pasada la tolerancia es tarde, y dice cuántos minutos REALES', () => {
    // 9:14 — 14 minutos tarde. El minuto que se reporta es el real, no el que excede
    // la tolerancia: al dueño le importa la hora de llegada, no la aritmética del perdón.
    const r = evaluateAttendance({ ...base, clockInTime: at('2026-08-20T15:14:00.000Z') })
    expect(r.status).toBe('LATE')
    expect(r.lateMinutes).toBe(14)
  })

  it('el borde exacto de la tolerancia todavía es puntual', () => {
    const r = evaluateAttendance({ ...base, clockInTime: at('2026-08-20T15:10:00.000Z') })
    expect(r.status).toBe('ON_TIME')
  })

  it('🔴 compara en la zona del NEGOCIO, no en UTC', () => {
    // Sin la zona, 15:14 UTC parece "6 horas tarde" contra un horario de 9:00.
    const conZona = evaluateAttendance({ ...base, clockInTime: at('2026-08-20T15:14:00.000Z') })
    expect(conZona.lateMinutes).toBe(14)
    expect(conZona.lateMinutes).toBeLessThan(60)
  })

  it('el mismo instante se juzga distinto en dos zonas distintas', () => {
    const enMexico = evaluateAttendance({ ...base, clockInTime: at('2026-08-20T15:00:00.000Z') })
    const enMadrid = evaluateAttendance({ ...base, timezone: 'Europe/Madrid', clockInTime: at('2026-08-20T15:00:00.000Z') })

    expect(enMexico.status).toBe('ON_TIME') // 9:00 local
    expect(enMadrid.status).toBe('LATE') // 17:00 local
  })

  it('sin marcar entrada y con horario definido, es falta', () => {
    const r = evaluateAttendance({ ...base, clockInTime: null })
    expect(r.status).toBe('ABSENT')
  })

  it('sin horario definido NO se juzga, aunque no haya marcado', () => {
    // Un negocio que aún no armó su cuadrante no debe ver a toda su gente en rojo.
    const r = evaluateAttendance({ ...base, expectedStart: null, expectedEnd: null, clockInTime: null })
    expect(r.status).toBe('NO_SCHEDULE')
  })

  it('sin horario definido tampoco se juzga a quien sí marcó', () => {
    const r = evaluateAttendance({ ...base, expectedStart: null, expectedEnd: null, clockInTime: at('2026-08-20T20:00:00.000Z') })
    expect(r.status).toBe('NO_SCHEDULE')
    expect(r.lateMinutes).toBe(0)
  })

  it('un día libre no es falta', () => {
    const r = evaluateAttendance({ ...base, isDayOff: true, clockInTime: null })
    expect(r.status).toBe('DAY_OFF')
  })

  it('un día libre no es falta ni aunque haya venido a trabajar', () => {
    // Vino en su día de descanso: eso no se castiga.
    const r = evaluateAttendance({ ...base, isDayOff: true, clockInTime: at('2026-08-20T15:30:00.000Z') })
    expect(r.status).toBe('DAY_OFF')
  })

  it('salir antes de la hora se marca', () => {
    // Entró puntual, salió 17:00 en vez de 18:00.
    const r = evaluateAttendance({
      ...base,
      clockInTime: at('2026-08-20T15:00:00.000Z'),
      clockOutTime: at('2026-08-20T23:00:00.000Z'),
    })
    expect(r.status).toBe('ON_TIME')
    expect(r.earlyLeaveMinutes).toBe(60)
  })

  it('salir a la hora o después no marca salida temprana', () => {
    const r = evaluateAttendance({
      ...base,
      clockInTime: at('2026-08-20T15:00:00.000Z'),
      clockOutTime: at('2026-08-21T00:30:00.000Z'), // 18:30 local
    })
    expect(r.earlyLeaveMinutes).toBe(0)
  })

  it('quien sigue dentro no cuenta como salida temprana', () => {
    const r = evaluateAttendance({ ...base, clockInTime: at('2026-08-20T15:00:00.000Z'), clockOutTime: null })
    expect(r.earlyLeaveMinutes).toBe(0)
  })

  it('llegar tarde Y salir temprano reporta las dos cosas', () => {
    const r = evaluateAttendance({
      ...base,
      clockInTime: at('2026-08-20T15:30:00.000Z'), // 9:30
      clockOutTime: at('2026-08-20T22:00:00.000Z'), // 16:00
    })
    expect(r.status).toBe('LATE')
    expect(r.lateMinutes).toBe(30)
    expect(r.earlyLeaveMinutes).toBe(120)
  })

  it('tolerancia cero se respeta: un minuto tarde es tarde', () => {
    const r = evaluateAttendance({ ...base, graceMinutes: 0, clockInTime: at('2026-08-20T15:01:00.000Z') })
    expect(r.status).toBe('LATE')
    expect(r.lateMinutes).toBe(1)
  })
})
