/**
 * Almacenamiento PRIVADO: la caja fuerte para datos personales.
 *
 * El helper existente `uploadFileToStorage` hace `makePublic()` y devuelve una URL
 * permanente: sirve para logos y fotos de producto, NO para el INE de un empleado. Este
 * servicio nunca publica el objeto, escribe bajo un prefijo que las reglas de Storage no
 * cubren (y Firebase deniega por defecto lo que no tiene regla), y sólo entrega el archivo
 * a través de una URL FIRMADA que caduca.
 *
 * Las reglas públicas de `/venues/**` NO se tocan: de ahí siguen subiendo la PAX y las apps.
 */
const mockFile = {
  save: jest.fn().mockResolvedValue(undefined),
  makePublic: jest.fn(),
  getSignedUrl: jest.fn().mockResolvedValue(['https://signed.example/doc?sig=abc']),
  delete: jest.fn().mockResolvedValue(undefined),
}
const mockBucket = { name: 'test-bucket', file: jest.fn(() => mockFile) }
jest.mock('@/config/firebase', () => ({
  getStorageBucket: () => ({ bucket: () => mockBucket }),
}))
jest.mock('@/services/storage.service', () => ({
  ...jest.requireActual('@/services/storage.service'),
  getStorageEnvPrefix: () => 'test',
}))

import { PRIVATE_PREFIX, savePrivateFile, signPrivateFileUrl, deletePrivateFile } from '@/services/privateStorage.service'

describe('privateStorage', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 escribe FUERA del árbol público /venues', async () => {
    const { path } = await savePrivateFile({
      scope: 'staff/venue-1/staff-1',
      fileName: 'ine.pdf',
      buffer: Buffer.from('x'),
      contentType: 'application/pdf',
    })
    expect(path.startsWith(`${PRIVATE_PREFIX}/`)).toBe(true)
    expect(path).not.toMatch(/(^|\/)venues\//)
  })

  it('🔴 NUNCA hace público el objeto', async () => {
    await savePrivateFile({ scope: 'staff/venue-1/staff-1', fileName: 'ine.pdf', buffer: Buffer.from('x'), contentType: 'application/pdf' })
    expect(mockFile.makePublic).not.toHaveBeenCalled()
  })

  it('devuelve una RUTA, no una URL: la URL se firma al momento de leer', async () => {
    const r = await savePrivateFile({
      scope: 'staff/venue-1/staff-1',
      fileName: 'ine.pdf',
      buffer: Buffer.from('x'),
      contentType: 'application/pdf',
    })
    expect(r.path).not.toMatch(/^https?:/)
  })

  it('el nombre del archivo se sanea: nada de ../ ni rutas', async () => {
    const r = await savePrivateFile({
      scope: 'staff/venue-1/staff-1',
      fileName: '../../etc/passwd',
      buffer: Buffer.from('x'),
      contentType: 'text/plain',
    })
    expect(r.path).not.toContain('..')
    expect(r.path.split('/').slice(0, 2).join('/')).toBe(`${PRIVATE_PREFIX}/test`)
  })

  it('la URL firmada caduca: pide expiración en minutos y la pasa como fecha futura', async () => {
    const before = Date.now()
    await signPrivateFileUrl(`${PRIVATE_PREFIX}/test/staff/v/s/doc.pdf`, 10)
    const opts = mockFile.getSignedUrl.mock.calls[0][0]
    expect(opts.action).toBe('read')
    expect(opts.expires).toBeGreaterThan(before + 9 * 60 * 1000)
    expect(opts.expires).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000 + 1000)
  })

  it('🔴 se niega a firmar una ruta que no esté bajo el prefijo privado', async () => {
    // Si alguien pasa una ruta pública, no hay que firmarla: eso ocultaría que es pública.
    await expect(signPrivateFileUrl('prod/venues/x/logo.png', 10)).rejects.toThrow(/privad/i)
    expect(mockFile.getSignedUrl).not.toHaveBeenCalled()
  })

  it('borrar sólo actúa bajo el prefijo privado', async () => {
    await expect(deletePrivateFile('prod/venues/x/logo.png')).rejects.toThrow(/privad/i)
    expect(mockFile.delete).not.toHaveBeenCalled()
    await deletePrivateFile(`${PRIVATE_PREFIX}/test/staff/v/s/doc.pdf`)
    expect(mockFile.delete).toHaveBeenCalled()
  })
})
