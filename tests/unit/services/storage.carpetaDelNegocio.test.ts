/**
 * Al cambiar el logo, el servidor borra el archivo anterior. Antes borraba CUALQUIER archivo del bucket que se hubiera
 * guardado como logo (una URL pegada de otro negocio). Codex r1 de negocios demo, hallazgo 8: con usuarios compartidos se
 * vuelve fácil de abusar, pero el hueco era de todos los negocios.
 */
jest.mock('../../../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import { estaEnLaCarpetaDelNegocio, buildStoragePath } from '../../../src/services/storage.service'

const url = (ruta: string) =>
  `https://firebasestorage.googleapis.com/v0/b/avoqado.appspot.com/o/${encodeURIComponent(ruta)}?alt=media&token=t`

describe('estaEnLaCarpetaDelNegocio', () => {
  it('un logo de la carpeta del negocio sí es suyo', () => {
    expect(estaEnLaCarpetaDelNegocio(url(buildStoragePath('venues/studio-bloom/logos/a.png')), 'studio-bloom')).toBe(true)
  })
  it('un archivo de otro negocio no es suyo (no se borra)', () => {
    expect(estaEnLaCarpetaDelNegocio(url(buildStoragePath('venues/testarudo/logos/a.png')), 'studio-bloom')).toBe(false)
    expect(estaEnLaCarpetaDelNegocio(url(buildStoragePath('venues/studio-bloom-2/logos/a.png')), 'studio-bloom')).toBe(false)
  })
  it('la foto que subió el panel (sin prefijo de ambiente, por nombre o por id) también es suya (Codex r10)', () => {
    expect(estaEnLaCarpetaDelNegocio(url('venues/studio-bloom/productos/a.jpg'), 'studio-bloom')).toBe(true)
    expect(estaEnLaCarpetaDelNegocio(url('venues/cvenue000000000000000000a/services/a.jpg'), 'studio-bloom', 'cvenue000000000000000000a')).toBe(true)
    expect(estaEnLaCarpetaDelNegocio(url('venues/testarudo/productos/a.jpg'), 'studio-bloom', 'cvenue000000000000000000a')).toBe(false)
    expect(estaEnLaCarpetaDelNegocio(url('venues/cotro0000000000000000000a/services/a.jpg'), 'studio-bloom', 'cvenue000000000000000000a')).toBe(false)
  })
  it('KYC u otra carpeta del bucket, una URL que no es de Firebase o vacía: no es suyo', () => {
    expect(estaEnLaCarpetaDelNegocio(url(buildStoragePath('kyc/x.pdf')), 'studio-bloom')).toBe(false)
    expect(estaEnLaCarpetaDelNegocio('https://evil.example/o/venues%2Fstudio-bloom%2Fa.png', 'studio-bloom')).toBe(false)
    expect(estaEnLaCarpetaDelNegocio(null, 'studio-bloom')).toBe(false)
  })
})
