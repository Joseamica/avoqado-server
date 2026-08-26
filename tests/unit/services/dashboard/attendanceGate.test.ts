/**
 * El interruptor de asistencia, del lado del servidor.
 *
 * Apagar asistencia tiene que apagar DE VERDAD: que la gente deje de poder checar, no sólo
 * que se esconda una sección (así lo hacen Square y Toast). Y tiene que ser el servidor
 * quien lo decida, porque los aparatos no leen ajustes del venue: Android/iOS/TPV ya saben
 * mostrar el mensaje de un 4xx, así que rechazar aquí apaga la función sin recompilar nada.
 *
 * 🔴 Este gate NO toca turnos de caja. `enableShifts` es otro interruptor.
 */
import { prismaMock } from '@tests/__helpers__/setup'

import { assertAttendanceEnabled, AttendanceDisabledError } from '@/services/dashboard/attendanceGate'

const VENUE_ID = 'venue-1'

describe('assertAttendanceEnabled', () => {
  beforeEach(() => prismaMock.venueSettings.findUnique.mockReset())

  it('deja pasar cuando el negocio tiene asistencia prendida', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ attendanceEnabled: true } as any)
    await expect(assertAttendanceEnabled(VENUE_ID)).resolves.toBeUndefined()
  })

  it('🔴 rechaza la checada cuando está apagada, con un mensaje que la app puede mostrar', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ attendanceEnabled: false } as any)
    const err = await assertAttendanceEnabled(VENUE_ID).catch(e => e)
    expect(err).toBeInstanceOf(AttendanceDisabledError)
    expect(err.statusCode).toBe(403)
    expect(err.message).toMatch(/asistencia.*apagad/i)
  })

  it('un negocio sin fila de ajustes se trata como PRENDIDO (default seguro hacia atrás)', async () => {
    // Todos los negocios existentes venían checando sin interruptor: no se les puede apagar
    // el reloj por una migración.
    prismaMock.venueSettings.findUnique.mockResolvedValue(null)
    await expect(assertAttendanceEnabled(VENUE_ID)).resolves.toBeUndefined()
  })

  it('sólo lee el campo que necesita', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ attendanceEnabled: true } as any)
    await assertAttendanceEnabled(VENUE_ID)
    expect(prismaMock.venueSettings.findUnique).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID },
      select: { attendanceEnabled: true },
    })
  })
})
