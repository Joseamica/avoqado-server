import { uploadAnnouncementImage } from '../../../../src/services/announcements/announcementImage.service'
import { uploadFileToStorage } from '../../../../src/services/storage.service'

jest.mock('../../../../src/services/storage.service', () => ({
  uploadFileToStorage: jest.fn(),
  buildStoragePath: jest.fn((p: string) => `dev/${p}`),
}))

const mockUpload = uploadFileToStorage as unknown as jest.Mock

// PNG mínimo válido: la firma de 8 bytes es lo que se valida.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])

describe('uploadAnnouncementImage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUpload.mockResolvedValue('https://storage.example/foto.png')
  })

  // ===== CASOS NUEVOS =====
  it('sube un PNG y devuelve su URL', async () => {
    const url = await uploadAnnouncementImage(PNG, 'image/png', 'terminal.png')
    expect(url).toBe('https://storage.example/foto.png')
  })

  it('acepta JPEG', async () => {
    await expect(uploadAnnouncementImage(JPEG, 'image/jpeg', 'a.jpg')).resolves.toBeTruthy()
  })

  // 🔴 Las fotos de un anuncio son PUBLICAS a proposito: las ve todo negocio que lo
  // reciba, y las apps las cargan sin sesion. Van por el storage publico, NUNCA por
  // `privateStorage`, que es el carril de INE/CURP/contratos.
  it('sube al carril PUBLICO, bajo una ruta propia de anuncios', async () => {
    await uploadAnnouncementImage(PNG, 'image/png', 'terminal.png')
    const ruta = mockUpload.mock.calls[0][1]
    expect(ruta).toContain('announcements/')
    expect(ruta).not.toContain('private/')
  })

  // ===== DESTRUCTIVO =====
  it('rechaza un archivo que dice ser PNG pero no lo es', async () => {
    const falso = Buffer.from('<?php echo 1; ?>')
    await expect(uploadAnnouncementImage(falso, 'image/png', 'x.png')).rejects.toThrow(/im[aá]gen/i)
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('rechaza un tipo que no es imagen', async () => {
    await expect(uploadAnnouncementImage(PNG, 'application/pdf', 'x.pdf')).rejects.toThrow(/im[aá]gen/i)
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('rechaza un archivo vacio', async () => {
    await expect(uploadAnnouncementImage(Buffer.alloc(0), 'image/png', 'x.png')).rejects.toThrow()
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('el nombre del archivo NO se usa tal cual: no puede escaparse de su carpeta', async () => {
    await uploadAnnouncementImage(PNG, 'image/png', '../../../etc/passwd.png')
    const ruta = mockUpload.mock.calls[0][1]
    expect(ruta).not.toContain('..')
    expect(ruta).not.toContain('etc/passwd')
  })
})
