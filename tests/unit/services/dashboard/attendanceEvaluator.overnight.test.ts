/**
 * Evaluador — turnos nocturnos con el DÍA DEL TURNO como ancla.
 *
 * Sin `scheduleDate`, la hora esperada se ancla al día de la LLEGADA: para un turno del
 * miércoles 22:00–06:00, llegar el jueves 00:05 se comparaba contra el JUEVES 22:00 y salía
 * "a tiempo" con 22 horas de anticipación. El día del turno lo sabe el reporte, no la checada.
 */
import { evaluateAttendance } from '@/services/dashboard/attendanceEvaluator'

const TZ = 'America/Mexico_City' // UTC-6 en agosto
const base = { expectedStart: '22:00', expectedEnd: '06:00', timezone: TZ, graceMinutes: 10, scheduleDate: '2026-08-26' }

describe('evaluateAttendance — nocturno anclado al día del turno', () => {
  it('llegar el jueves 00:05 a un turno del miércoles 22:00 son 125 minutos tarde, no "a tiempo"', () => {
    const r = evaluateAttendance({ ...base, clockInTime: new Date('2026-08-27T06:05:00.000Z') }) // jue 00:05 local
    expect(r.status).toBe('LATE')
    expect(r.lateMinutes).toBe(125)
  })

  it('miércoles 22:05 local: dentro de la tolerancia', () => {
    const r = evaluateAttendance({ ...base, clockInTime: new Date('2026-08-27T04:05:00.000Z') }) // mié 22:05 local
    expect(r.status).toBe('ON_TIME')
    expect(r.lateMinutes).toBe(5)
  })

  it('salir el jueves 05:30 local de un turno que termina 06:00 son 30 min de salida temprana', () => {
    const r = evaluateAttendance({
      ...base,
      clockInTime: new Date('2026-08-27T04:00:00.000Z'), // mié 22:00
      clockOutTime: new Date('2026-08-27T11:30:00.000Z'), // jue 05:30
    })
    expect(r.earlyLeaveMinutes).toBe(30)
  })

  it('regresión: sin scheduleDate se comporta como siempre (ancla = día de la llegada)', () => {
    const r = evaluateAttendance({
      expectedStart: '09:00',
      expectedEnd: '18:00',
      timezone: TZ,
      graceMinutes: 10,
      clockInTime: new Date('2026-08-26T15:20:00.000Z'), // mié 09:20 local
    })
    expect(r.status).toBe('LATE')
    expect(r.lateMinutes).toBe(20)
  })
})
