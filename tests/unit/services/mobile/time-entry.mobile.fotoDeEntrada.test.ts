// Foto de entrada en el checador del POS (encargo b0c1a1, 15-nov). El identify dice si el negocio la pide, y la
// entrada guarda la selfie en la caja fuerte privada DESPUÉS de validar el PIN.
jest.mock('@/services/privateStorage.service', () => ({
  PRIVATE_PREFIX: 'private',
  savePrivateFile: jest.fn(),
  signPrivateFileUrl: jest.fn(),
  deletePrivateFile: jest.fn().mockResolvedValue(undefined),
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { deletePrivateFile, savePrivateFile } from '@/services/privateStorage.service'
import { clockIn, identifyByPin } from '@/services/mobile/time-entry.mobile.service'

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)])
const RUTA = 'private/dev/attendance/venue-1/staff-1/1_entrada.jpg'

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.venueSettings.findUnique.mockResolvedValue({ attendanceEnabled: true, requireClockInPhoto: false } as any)
  prismaMock.staffVenue.findFirst.mockResolvedValue({
    staffId: 'staff-1',
    role: 'WAITER',
    staff: { id: 'staff-1', firstName: 'Ana', lastName: 'López', email: 'a@x.mx', photoUrl: null },
  } as any)
  prismaMock.timeEntry.findFirst.mockResolvedValue(null)
  prismaMock.timeEntry.create.mockImplementation((async (args: any) => ({ id: 'te-1', ...args.data, staff: {} })) as any)
  ;(savePrivateFile as jest.Mock).mockResolvedValue({ path: RUTA })
})

describe('identifyByPin — dice si el negocio pide foto de entrada', () => {
  it('requireClockInPhoto: true cuando el negocio la prendió', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ requireClockInPhoto: true } as any)
    await expect(identifyByPin('venue-1', '1234')).resolves.toMatchObject({ requireClockInPhoto: true })
  })

  it('requireClockInPhoto: false si está apagada o el negocio no tiene ajustes', async () => {
    await expect(identifyByPin('venue-1', '1234')).resolves.toMatchObject({ requireClockInPhoto: false })
    prismaMock.venueSettings.findUnique.mockResolvedValue(null)
    await expect(identifyByPin('venue-1', '1234')).resolves.toMatchObject({ requireClockInPhoto: false })
  })

  it('regresión: sigue devolviendo la persona y su checada abierta', async () => {
    const r = await identifyByPin('venue-1', '1234')
    expect(r.staff).toMatchObject({ id: 'staff-1', firstName: 'Ana', role: 'WAITER' })
    expect(r.currentEntry).toBeNull()
  })
})

describe('clockIn — la selfie del POS', () => {
  it('guarda la foto en la carpeta privada de la persona y la checada apunta a esa ruta', async () => {
    await clockIn({ venueId: 'venue-1', pin: '1234', checkInPhoto: JPEG.toString('base64') })

    expect(savePrivateFile).toHaveBeenCalledWith(expect.objectContaining({ scope: 'attendance/venue-1/staff-1', buffer: JPEG }))
    expect((prismaMock.timeEntry.create.mock.calls[0][0] as any).data.checkInPhotoUrl).toBe(RUTA)
  })

  it('con PIN equivocado no sube nada', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    await expect(clockIn({ venueId: 'venue-1', pin: '9999', checkInPhoto: JPEG.toString('base64') })).rejects.toThrow(/PIN/)
    expect(savePrivateFile).not.toHaveBeenCalled()
  })

  it('si ya tenía entrada (p. ej. un reintento), contesta lo de siempre y borra la foto que acaba de subir', async () => {
    prismaMock.timeEntry.findFirst.mockResolvedValue({ id: 'te-0', status: 'CLOCKED_IN' } as any)
    await expect(clockIn({ venueId: 'venue-1', pin: '1234', checkInPhoto: JPEG.toString('base64') })).rejects.toThrow(/Ya tienes entrada/)
    expect(prismaMock.timeEntry.create).not.toHaveBeenCalled()
    expect(deletePrivateFile).toHaveBeenCalledWith(RUTA)
  })

  it('si el almacén falla, la entrada se registra sin foto', async () => {
    ;(savePrivateFile as jest.Mock).mockRejectedValue(new Error('Storage caído'))
    await clockIn({ venueId: 'venue-1', pin: '1234', checkInPhoto: JPEG.toString('base64') })
    expect((prismaMock.timeEntry.create.mock.calls[0][0] as any).data.checkInPhotoUrl ?? null).toBeNull()
  })

  it('una foto que no es JPEG se rechaza con 400 y no crea la checada', async () => {
    await expect(clockIn({ venueId: 'venue-1', pin: '1234', checkInPhoto: Buffer.from('hola').toString('base64') })).rejects.toThrow(
      /foto/i,
    )
    expect(prismaMock.timeEntry.create).not.toHaveBeenCalled()
  })

  it('rechaza una ruta privada mandada como checkInPhotoUrl (antes de mirar el PIN)', async () => {
    await expect(
      clockIn({ venueId: 'venue-1', pin: '1234', checkInPhotoUrl: 'private/dev/staff/venue-1/staff-2/ine.jpg' }),
    ).rejects.toThrow(/foto/i)
    expect(prismaMock.timeEntry.create).not.toHaveBeenCalled()
  })

  it('regresión: sin foto (app vieja, iOS o negocio sin el interruptor) registra la entrada como hoy', async () => {
    await clockIn({ venueId: 'venue-1', pin: '1234', note: 'llegué' })
    expect(savePrivateFile).not.toHaveBeenCalled()
    expect((prismaMock.timeEntry.create.mock.calls[0][0] as any).data).toMatchObject({ staffId: 'staff-1', notes: 'llegué' })
  })

  it('regresión: una URL https pública sigue guardándose tal cual', async () => {
    await clockIn({ venueId: 'venue-1', pin: '1234', checkInPhotoUrl: 'https://firebasestorage.googleapis.com/a.jpg' })
    expect((prismaMock.timeEntry.create.mock.calls[0][0] as any).data.checkInPhotoUrl).toBe('https://firebasestorage.googleapis.com/a.jpg')
  })
})
