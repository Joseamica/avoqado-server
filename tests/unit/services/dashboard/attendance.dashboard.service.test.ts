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

import { getVenueStaffTimeSummary } from '@/services/dashboard/attendance.dashboard.service'
import { NotFoundError } from '@/errors/AppError'

const VENUE_ID = 'venue-1'
const STAFF_ID = 'staff-1'

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

// Foto de entrada (encargo b0c1a1, 15-nov): la lista de checadas trae `checkInPhotoViewUrl`, lista para pintarse.
jest.mock('@/services/privateStorage.service', () => ({
  PRIVATE_PREFIX: 'private',
  savePrivateFile: jest.fn(),
  deletePrivateFile: jest.fn(),
  signPrivateFileUrl: jest.fn(async (p: string) => `https://firmada/${p}`),
}))

describe('getVenueTimeEntries — foto de entrada para ver', () => {
  beforeEach(() => {
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
    ;(prismaMock.$transaction as jest.Mock).mockResolvedValue([
      [
        { id: 'te-1', checkInPhotoUrl: `private/dev/attendance/${VENUE_ID}/s1/1_entrada.jpg` },
        { id: 'te-2', checkInPhotoUrl: 'https://firebasestorage.googleapis.com/a.jpg' },
        { id: 'te-3', checkInPhotoUrl: null },
        { id: 'te-4', checkInPhotoUrl: 'private/dev/staff/venue-otro/s9/ine.jpg' },
      ],
      4,
    ])
  })

  it('firma la foto privada del negocio, deja la pública y no enseña lo ajeno; el resto de la respuesta sigue igual', async () => {
    const { getVenueTimeEntries } = await import('@/services/dashboard/attendance.dashboard.service')
    const r = await getVenueTimeEntries(VENUE_ID, { startDate: '2026-11-15', endDate: '2026-11-15' })

    expect(r.timeEntries.map((e: any) => e.checkInPhotoViewUrl)).toEqual([
      `https://firmada/private/dev/attendance/${VENUE_ID}/s1/1_entrada.jpg`,
      'https://firebasestorage.googleapis.com/a.jpg',
      null,
      null,
    ])
    // Regresión: el campo crudo y el total no cambian (el panel de organización y las apps leen la forma vieja).
    expect(r.timeEntries[1].checkInPhotoUrl).toBe('https://firebasestorage.googleapis.com/a.jpg')
    expect(r.total).toBe(4)
  })
})
