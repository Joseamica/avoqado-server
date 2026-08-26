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

import {
  getVenueStaffTimeSummary,
  validateVenueTimeEntry,
} from '@/services/dashboard/attendance.dashboard.service'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

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

describe('validateVenueTimeEntry', () => {
  beforeEach(() => {
    prismaMock.timeEntry.findFirst.mockReset()
    prismaMock.timeEntry.update.mockReset().mockResolvedValue({ id: TIME_ENTRY_ID } as any)
    mockLogAction.mockReset()
  })

  it('no aprueba una checada de otro negocio', async () => {
    // La consulta filtra por venueId, asi que un id ajeno simplemente no aparece.
    prismaMock.timeEntry.findFirst.mockResolvedValue(null)

    await expect(validateVenueTimeEntry(OTHER_VENUE_ID, TIME_ENTRY_ID, VALIDATOR_ID, 'APPROVED')).rejects.toThrow(NotFoundError)

    expect(prismaMock.timeEntry.update).not.toHaveBeenCalled()
  })

  it('busca la checada acotada al negocio, nunca por id suelto', async () => {
    prismaMock.timeEntry.findFirst.mockResolvedValue({ id: TIME_ENTRY_ID, staffId: STAFF_ID, venueId: VENUE_ID } as any)

    await validateVenueTimeEntry(VENUE_ID, TIME_ENTRY_ID, VALIDATOR_ID, 'APPROVED')

    expect(prismaMock.timeEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: TIME_ENTRY_ID, venueId: VENUE_ID }) }),
    )
  })

  it('rechaza un estado que no sea aprobar o rechazar', async () => {
    await expect(validateVenueTimeEntry(VENUE_ID, TIME_ENTRY_ID, VALIDATOR_ID, 'PENDING' as never)).rejects.toThrow(BadRequestError)

    expect(prismaMock.timeEntry.findFirst).not.toHaveBeenCalled()
  })

  it('guarda quien valido y cuando, con su nota', async () => {
    prismaMock.timeEntry.findFirst.mockResolvedValue({ id: TIME_ENTRY_ID, staffId: STAFF_ID, venueId: VENUE_ID } as any)

    await validateVenueTimeEntry(VENUE_ID, TIME_ENTRY_ID, VALIDATOR_ID, 'REJECTED', 'La foto no es de la sucursal')

    expect(prismaMock.timeEntry.update).toHaveBeenCalledWith({
      where: { id: TIME_ENTRY_ID },
      data: expect.objectContaining({
        validationStatus: 'REJECTED',
        validatedBy: VALIDATOR_ID,
        validatedAt: expect.any(Date),
        validationNote: 'La foto no es de la sucursal',
      }),
    })
  })

  it('deja rastro en la bitacora del negocio', async () => {
    prismaMock.timeEntry.findFirst.mockResolvedValue({ id: TIME_ENTRY_ID, staffId: STAFF_ID, venueId: VENUE_ID } as any)

    await validateVenueTimeEntry(VENUE_ID, TIME_ENTRY_ID, VALIDATOR_ID, 'APPROVED')

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: VALIDATOR_ID,
        venueId: VENUE_ID,
        action: 'TIME_ENTRY_APPROVED',
        entity: 'TimeEntry',
        entityId: TIME_ENTRY_ID,
      }),
    )
  })

  it('guarda la nota como null cuando no se escribio ninguna', async () => {
    prismaMock.timeEntry.findFirst.mockResolvedValue({ id: TIME_ENTRY_ID, staffId: STAFF_ID, venueId: VENUE_ID } as any)

    await validateVenueTimeEntry(VENUE_ID, TIME_ENTRY_ID, VALIDATOR_ID, 'APPROVED')

    expect(prismaMock.timeEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ validationNote: null }) }),
    )
  })
})
