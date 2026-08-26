/**
 * Asistencia en el dashboard del negocio.
 *
 * El motor del checador ya existia y lo consumian la TPV, Android e iOS; lo que faltaba
 * era que el dueno de un negocio normal pudiera revisar y aprobar las checadas — hasta
 * ahora eso solo vivia en el panel de organizacion, detras del acceso white-label.
 *
 * Estas pruebas cubren lo unico que la delegacion NO hereda gratis: el aislamiento entre
 * negocios. Las funciones que se reusan reciben `staffId` o `timeEntryId` sueltos, sin
 * venue, asi que un id de otro negocio pasaria derecho si nadie lo comprueba.
 */
import { prismaMock } from '@tests/__helpers__/setup'

const mockLogAction = jest.fn()
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...(a as [])) }))

import { getVenueStaffTimeSummary, validateVenueTimeEntry } from '@/services/dashboard/attendance.dashboard.service'
import { NotFoundError } from '@/errors/AppError'

const VENUE_ID = 'venue-1'
const OTHER_VENUE_ID = 'venue-2'
const STAFF_ID = 'staff-1'
const TIME_ENTRY_ID = 'te-1'
const VALIDATOR_ID = 'staff-boss'

describe('getVenueStaffTimeSummary — aislamiento entre negocios', () => {
  beforeEach(() => {
    prismaMock.staffVenue.findFirst.mockReset()
    prismaMock.timeEntry.findMany.mockReset().mockResolvedValue([])
    mockLogAction.mockReset()
  })

  it('rechaza a un empleado que no trabaja en este negocio', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)

    await expect(getVenueStaffTimeSummary(VENUE_ID, STAFF_ID, '2026-08-01', '2026-08-31')).rejects.toThrow(NotFoundError)

    // Lo que importa: no llegamos a leer las horas de alguien de otro negocio.
    expect(prismaMock.timeEntry.findMany).not.toHaveBeenCalled()
  })

  it('comprueba la pertenencia contra ESTE negocio antes de leer nada', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' } as any)

    await getVenueStaffTimeSummary(VENUE_ID, STAFF_ID, '2026-08-01', '2026-08-31')

    expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ staffId: STAFF_ID, venueId: VENUE_ID }) }),
    )
  })
})
