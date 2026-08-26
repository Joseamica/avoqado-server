/**
 * El diseño de la credencial: lo que TODO cliente de un negocio ve en su teléfono.
 *
 * Lo que se prueba aquí es lo que falla en silencio si nadie lo cuida:
 *
 * 1. **Un color mal formado se rechaza AL GUARDAR.** Apple no protesta ante un color
 *    invalido: lo ignora y pinta la tarjeta gris. Si el valor entra a la base, el
 *    negocio ve su vista previa bien —el navegador tolera formatos que Apple no— y
 *    el defecto aparece semanas despues en el iPhone de un cliente.
 * 2. **Guardar un color NO borra el logo.** Un guardado que pisara el objeto entero
 *    dejaria a un negocio sin su logo cada vez que toca un color.
 * 3. **Sin configurar, la credencial funciona igual.** Obligar a configurar antes de
 *    emitir convertiria un detalle estetico en un bloqueo de operacion.
 */
import { getCardDesign, saveCardDesign, assertValidDesign, DEFAULT_CARD_DESIGN } from '../../../../src/services/wallet/cardDesign.service'
import { prismaMock } from '../../../__helpers__/setup'

const FILA = {
  id: 'd1',
  venueId: 'v1',
  logoUrl: 'https://cdn.test/logo.png',
  iconUrl: null,
  backgroundColor: '#101010',
  textColor: '#FFFFFF',
  labelColor: '#888888',
  stripColor: '#202020',
  stampFilledColor: '#FF6600',
  stampEmptyColor: null,
  stampShape: 'STAR',
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('diseño de la credencial', () => {
  beforeEach(() => jest.clearAllMocks())

  it('un negocio que nunca lo configuró recibe los defaults, no un error', async () => {
    prismaMock.walletCardDesign.findUnique.mockResolvedValue(null)

    const design = await getCardDesign('v1')

    expect(design).toEqual(DEFAULT_CARD_DESIGN)
    expect(design.stampShape).toBe('CIRCLE')
  })

  it('🔴 los defaults son los tokens REALES del tema de avoqado-android', () => {
    // Si alguien los cambia por unos "parecidos", la credencial deja de sentirse
    // del mismo producto que la app. Los valores salen de
    // `designsystem/theme/Color.kt`: SurfaceDark, OnSurfaceDark,
    // OnSurfaceVariantDark, SurfaceContainerDark y el verde de marca.
    expect(DEFAULT_CARD_DESIGN.backgroundColor).toBe('#1C1C1E')
    expect(DEFAULT_CARD_DESIGN.textColor).toBe('#FFFFFF')
    expect(DEFAULT_CARD_DESIGN.labelColor).toBe('#98989D')
    expect(DEFAULT_CARD_DESIGN.stripColor).toBe('#2C2C2E')
    expect(DEFAULT_CARD_DESIGN.stampFilledColor).toBe('#7ADD2C')
  })

  it('devuelve el diseño guardado cuando existe', async () => {
    prismaMock.walletCardDesign.findUnique.mockResolvedValue(FILA as any)

    const design = await getCardDesign('v1')

    expect(design.stampFilledColor).toBe('#FF6600')
    expect(design.logoUrl).toBe('https://cdn.test/logo.png')
    expect(design.stampShape).toBe('STAR')
  })

  describe('validación de colores', () => {
    it('🔴 rechaza un color sin numeral', () => {
      expect(() => assertValidDesign({ backgroundColor: '1C1C1E' })).toThrow(/#RRGGBB/)
    })

    it('🔴 rechaza un nombre de color CSS — el navegador lo entiende, Apple no', () => {
      // Es la trampa realista: alguien escribe "red" porque en la vista previa web
      // funciona. En el pase produce una tarjeta gris, sin ningún error.
      expect(() => assertValidDesign({ stampFilledColor: 'red' })).toThrow()
    })

    it('🔴 rechaza la forma corta de 3 dígitos', () => {
      // #FFF es válido en CSS y NO en un pase.
      expect(() => assertValidDesign({ textColor: '#FFF' })).toThrow()
    })

    it('acepta hex de 6 dígitos en cualquier caja', () => {
      expect(() => assertValidDesign({ backgroundColor: '#1c1c1e', textColor: '#FFFFFF' })).not.toThrow()
    })

    it('el color del sello vacío SÍ puede ser nulo — significa "derívalo"', () => {
      expect(() => assertValidDesign({ stampEmptyColor: null })).not.toThrow()
    })

    it('🔴 pero el fondo NO puede quedar vacío', () => {
      expect(() => assertValidDesign({ backgroundColor: null as any })).toThrow(/no puede quedar vacío/)
    })

    it('🔴 rechaza una imagen que no viaje por https', () => {
      // Apple no carga la imagen: viaja DENTRO del paquete. Pero una URL http en un
      // panel de administración es una fuga de contenido mixto y un vector para
      // servir otra cosa.
      expect(() => assertValidDesign({ logoUrl: 'http://cdn.test/logo.png' })).toThrow(/https/)
    })

    it('un campo ausente no se valida — es un guardado parcial', () => {
      expect(() => assertValidDesign({})).not.toThrow()
    })
  })

  describe('guardado', () => {
    it('🔴 guardar un color NO toca el logo', async () => {
      prismaMock.walletCardDesign.upsert.mockResolvedValue(FILA as any)
      prismaMock.walletCardDesign.findUnique.mockResolvedValue(FILA as any)

      await saveCardDesign('v1', { backgroundColor: '#000000' })

      const llamada = prismaMock.walletCardDesign.upsert.mock.calls[0][0] as any
      expect(llamada.update).toEqual({ backgroundColor: '#000000' })
      // Si `logoUrl` apareciera aquí como undefined o null, el negocio perdería su
      // logo cada vez que alguien cambia un color desde una pantalla que no lo cargó.
      expect(llamada.update).not.toHaveProperty('logoUrl')
    })

    it('🔴 un color inválido no llega a la base', async () => {
      await expect(saveCardDesign('v1', { textColor: 'azul' })).rejects.toThrow()

      expect(prismaMock.walletCardDesign.upsert).not.toHaveBeenCalled()
    })

    it('crea la fila la primera vez, con el venue', async () => {
      prismaMock.walletCardDesign.upsert.mockResolvedValue(FILA as any)
      prismaMock.walletCardDesign.findUnique.mockResolvedValue(FILA as any)

      await saveCardDesign('v1', { stampShape: 'HEART' as any })

      const llamada = prismaMock.walletCardDesign.upsert.mock.calls[0][0] as any
      expect(llamada.where).toEqual({ venueId: 'v1' })
      expect(llamada.create).toEqual({ venueId: 'v1', stampShape: 'HEART' })
    })
  })
})
