/**
 * El interruptor apagado tiene que frenar la checada en el CAMINO REAL (TPV y mobile), no
 * sólo en el guard aislado. Y tiene que frenarla ANTES de validar el PIN: si el negocio
 * apagó asistencia, el mensaje debe ser "está apagado", no "PIN inválido".
 *
 * 🔴 Y no debe tocar nada de turnos de caja.
 */
import { prismaMock } from '@tests/__helpers__/setup'

import { clockIn as clockInTpv } from '@/services/tpv/time-entry.tpv.service'
import { clockIn as clockInMobile } from '@/services/mobile/time-entry.mobile.service'
import { AttendanceDisabledError } from '@/services/dashboard/attendanceGate'

const VENUE_ID = 'venue-1'

describe('clockIn con asistencia APAGADA', () => {
  beforeEach(() => {
    prismaMock.venueSettings.findUnique.mockReset().mockResolvedValue({ attendanceEnabled: false } as any)
    prismaMock.staffVenue.findFirst.mockReset()
    prismaMock.timeEntry.findFirst.mockReset()
    prismaMock.timeEntry.create.mockReset()
    prismaMock.shift.findFirst.mockReset()
  })

  it('TPV: rechaza con 403 y NO llega a validar el PIN ni a crear la checada', async () => {
    await expect(clockInTpv({ venueId: VENUE_ID, staffId: 's1', pin: '1234' } as any)).rejects.toBeInstanceOf(AttendanceDisabledError)
    expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.timeEntry.create).not.toHaveBeenCalled()
  })

  it('mobile: rechaza con 403 y NO llega a buscar por PIN', async () => {
    await expect(clockInMobile({ venueId: VENUE_ID, pin: '1234' } as any)).rejects.toBeInstanceOf(AttendanceDisabledError)
    expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.timeEntry.create).not.toHaveBeenCalled()
  })

  it('🔴 apagar asistencia no consulta ni toca turnos de caja', async () => {
    await clockInTpv({ venueId: VENUE_ID, staffId: 's1', pin: '1234' } as any).catch(() => {})
    await clockInMobile({ venueId: VENUE_ID, pin: '1234' } as any).catch(() => {})
    expect(prismaMock.shift.findFirst).not.toHaveBeenCalled()
  })

  it('el mensaje es el que la app va a mostrar tal cual', async () => {
    const err = await clockInTpv({ venueId: VENUE_ID, staffId: 's1', pin: '1234' } as any).catch(e => e)
    expect(err.statusCode).toBe(403)
    expect(err.message).toMatch(/apagado/)
    expect(err.message).toMatch(/administrador/)
  })
})
