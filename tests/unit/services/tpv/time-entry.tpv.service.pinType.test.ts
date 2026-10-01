/**
 * 🔴 Auditoría 2026-09-30: en la terminal el PIN confirma que quien checa es `staffId`. Un objeto
 * `{ not: null }` en lugar del PIN pasaba la verificación para cualquier empleado con PIN.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { clockIn, clockOut } from '@/services/tpv/time-entry.tpv.service'
import { UnauthorizedError } from '@/errors/AppError'

beforeEach(() => {
  prismaMock.venueSettings.findUnique.mockReset().mockResolvedValue({ attendanceEnabled: true } as any)
  // Si la búsqueda llegara a la base, "encontraría" a alguien: así se ve si el filtro se coló.
  prismaMock.staffVenue.findFirst.mockReset().mockResolvedValue({ id: 'sv-1' } as any)
  prismaMock.timeEntry.findFirst.mockReset().mockResolvedValue(null)
  prismaMock.timeEntry.create.mockReset()
})

it.each([
  ['clockIn', () => clockIn({ venueId: 'venue-1', staffId: 's1', pin: { not: null } } as any)],
  ['clockOut', () => clockOut({ venueId: 'venue-1', staffId: 's1', pin: { not: null } } as any)],
])('%s rechaza un PIN que no es texto sin consultar la base', async (_name, run) => {
  await expect(run()).rejects.toBeInstanceOf(UnauthorizedError)
  expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
  expect(prismaMock.timeEntry.create).not.toHaveBeenCalled()
})

it('un PIN de texto se sigue verificando contra la base, con su staffId', async () => {
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  await expect(clockIn({ venueId: 'venue-1', staffId: 's1', pin: '0637' } as any)).rejects.toBeInstanceOf(UnauthorizedError)
  expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ staffId: 's1', venueId: 'venue-1', pin: '0637' }) }),
  )
})
