/**
 * 🔴 Turno de caja (`Shift`) y asistencia (`TimeEntry`) NUNCA se hablan.
 *
 * Pedido explícito del founder (2026-08-26): un negocio puede tener el reloj checador sin
 * control de asistencia, o turnos de caja sin checador, y nada debe romperse ni de caja ni
 * de nada. Abrir turno no pregunta si checaste; checar no pregunta si hay turno abierto.
 *
 * Esta prueba es ESTÁTICA a propósito: lee el código fuente y falla si alguien conecta los
 * dos rieles. Una prueba de comportamiento no lo cazaría — el acoplamiento se cuela como
 * "sólo una consulta más" que no cambia el resultado feliz.
 */
import * as fs from 'fs'
import * as path from 'path'

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../src', rel), 'utf8')

describe('independencia turno de caja ↔ asistencia', () => {
  const attendanceFiles = [
    'services/dashboard/attendance.dashboard.service.ts',
    'services/dashboard/attendanceEvaluator.ts',
    'services/dashboard/workSchedule.service.ts',
    'services/tpv/time-entry.tpv.service.ts',
    'services/mobile/time-entry.mobile.service.ts',
  ]

  it.each(attendanceFiles)('%s no consulta ni escribe turnos de caja', file => {
    const src = read(file)
    // `prisma.shift.` es la única forma de tocar la tabla Shift desde un servicio.
    expect(src).not.toMatch(/prisma\.shift\./)
    expect(src).not.toMatch(/tx\.shift\./)
  })

  it('abrir o cerrar un turno de caja no consulta asistencia', () => {
    const src = read('services/tpv/shift.tpv.service.ts')
    expect(src).not.toMatch(/prisma\.timeEntry\./)
    expect(src).not.toMatch(/tx\.timeEntry\./)
    expect(src).not.toMatch(/clockIn|clockOut|attendance/i)
  })

  it('el interruptor de asistencia no es el de turnos', () => {
    // `enableShifts` gobierna la caja. Si alguien reusa ese flag para asistencia, un
    // negocio que apague la caja se quedaría sin checador, o al revés.
    for (const file of attendanceFiles.slice(0, 3)) {
      expect(read(file)).not.toMatch(/enableShifts/)
    }
  })
})
