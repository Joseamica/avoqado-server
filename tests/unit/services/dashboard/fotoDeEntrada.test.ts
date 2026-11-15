// Foto de entrada del checador (encargo b0c1a1, 15-nov): la selfie del POS va a la caja fuerte privada y el panel sólo
// firma las fotos de ESE negocio. Promesa: workspace docs/audit/2026-11-15-foto-de-entrada-checador/promesa.md
jest.mock('@/services/privateStorage.service', () => ({
  PRIVATE_PREFIX: 'private',
  savePrivateFile: jest.fn(),
  signPrivateFileUrl: jest.fn(),
  deletePrivateFile: jest.fn(),
}))

import { savePrivateFile, signPrivateFileUrl } from '@/services/privateStorage.service'
import { assertFotoNoPrivada, decodificarSelfie, fotoParaVer, guardarSelfieDeEntrada } from '@/services/dashboard/fotoDeEntrada'

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)])

describe('decodificarSelfie', () => {
  it('acepta un JPEG en base64 y devuelve sus bytes', () => {
    expect(decodificarSelfie(JPEG.toString('base64'))).toEqual(JPEG)
  })

  it('acepta el prefijo data:image/jpeg;base64,', () => {
    expect(decodificarSelfie(`data:image/jpeg;base64,${JPEG.toString('base64')}`)).toEqual(JPEG)
  })

  it('rechaza lo que no es JPEG (un PNG, un PDF o texto)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])
    expect(() => decodificarSelfie(png.toString('base64'))).toThrow(/foto/i)
    expect(() => decodificarSelfie(Buffer.from('%PDF-1.4').toString('base64'))).toThrow(/foto/i)
    expect(() => decodificarSelfie('hola')).toThrow(/foto/i)
  })

  it('rechaza una foto de más de 600 KB (no cabría en el cuerpo de 1 MB) y lo que no es texto', () => {
    const grande = Buffer.concat([JPEG, Buffer.alloc(600 * 1024)])
    // Lo que sí cabe: 600 KB en base64 + el resto del cuerpo queda bajo 1 MB.
    expect(Math.ceil((600 * 1024 * 4) / 3) + 200).toBeLessThan(1024 * 1024)
    expect(() => decodificarSelfie(grande.toString('base64'))).toThrow(/grande/i)
    expect(() => decodificarSelfie({ a: 1 } as unknown as string)).toThrow(/foto/i)
  })
})

describe('assertFotoNoPrivada', () => {
  it('deja pasar la URL pública de la TPV y la ausencia de foto', () => {
    expect(() => assertFotoNoPrivada('https://firebasestorage.googleapis.com/v0/b/x/o/a.jpg')).not.toThrow()
    expect(() => assertFotoNoPrivada(undefined)).not.toThrow()
    expect(() => assertFotoNoPrivada(null)).not.toThrow()
  })

  it('rechaza una ruta del almacén privado mandada por la app (sería pedirle al panel que firme el INE de alguien)', () => {
    expect(() => assertFotoNoPrivada('private/prod/staff/v1/s1/123_ine.jpg')).toThrow()
    expect(() => assertFotoNoPrivada('  private/dev/attendance/v1/s1/a.jpg')).toThrow()
    expect(() => assertFotoNoPrivada('/private/prod/x')).toThrow()
  })
})

describe('guardarSelfieDeEntrada', () => {
  beforeEach(() => jest.clearAllMocks())

  it('la guarda bajo attendance/<venue>/<persona> y devuelve la ruta', async () => {
    ;(savePrivateFile as jest.Mock).mockResolvedValue({ path: 'private/dev/attendance/v1/s1/1_entrada.jpg' })
    await expect(guardarSelfieDeEntrada({ venueId: 'v1', staffId: 's1', foto: JPEG })).resolves.toBe(
      'private/dev/attendance/v1/s1/1_entrada.jpg',
    )
    expect(savePrivateFile).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'attendance/v1/s1', contentType: 'image/jpeg', buffer: JPEG }),
    )
  })

  it('si el almacén falla, devuelve null (la entrada se registra igual, sin foto)', async () => {
    ;(savePrivateFile as jest.Mock).mockRejectedValue(new Error('Storage caído'))
    await expect(guardarSelfieDeEntrada({ venueId: 'v1', staffId: 's1', foto: JPEG })).resolves.toBeNull()
  })
})

describe('fotoParaVer', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(signPrivateFileUrl as jest.Mock).mockImplementation(async (p: string) => `https://firmada/${p}`)
  })

  it('firma 10 min la foto privada de ESTE negocio', async () => {
    await expect(fotoParaVer('v1', 'private/dev/attendance/v1/s1/1_entrada.jpg')).resolves.toBe(
      'https://firmada/private/dev/attendance/v1/s1/1_entrada.jpg',
    )
    expect(signPrivateFileUrl).toHaveBeenCalledWith('private/dev/attendance/v1/s1/1_entrada.jpg', 10)
  })

  it('nunca firma la foto de otro negocio ni otra carpeta privada (INE, contratos)', async () => {
    await expect(fotoParaVer('v1', 'private/dev/attendance/v2/s1/a.jpg')).resolves.toBeNull()
    await expect(fotoParaVer('v1', 'private/dev/staff/v1/s1/ine.jpg')).resolves.toBeNull()
    await expect(fotoParaVer('v1', 'private/dev/attendance/v1/../../staff/v1/s1/ine.jpg')).resolves.toBeNull()
    await expect(fotoParaVer('v1', 'private/prod/attendance/v1/s1/a.jpg')).resolves.toBeNull() // otro ambiente
    expect(signPrivateFileUrl).not.toHaveBeenCalled()
  })

  it('la URL pública https de la TPV pasa tal cual; lo demás no se muestra', async () => {
    await expect(fotoParaVer('v1', 'https://firebasestorage.googleapis.com/a.jpg')).resolves.toBe(
      'https://firebasestorage.googleapis.com/a.jpg',
    )
    await expect(fotoParaVer('v1', 'http://inseguro/a.jpg')).resolves.toBeNull()
    await expect(fotoParaVer('v1', 'javascript:alert(1)')).resolves.toBeNull()
    await expect(fotoParaVer('v1', null)).resolves.toBeNull()
  })

  it('si firmar falla, no tumba la lista: devuelve null', async () => {
    ;(signPrivateFileUrl as jest.Mock).mockRejectedValue(new Error('sin llave'))
    await expect(fotoParaVer('v1', 'private/dev/attendance/v1/s1/a.jpg')).resolves.toBeNull()
  })
})
