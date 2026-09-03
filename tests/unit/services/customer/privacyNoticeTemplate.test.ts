import { plantillaDeAviso } from '@/services/customer/privacyNoticeTemplate'

const BASE = {
  nombreDelNegocio: 'Testarudo Café',
  domicilio: 'Av. Reforma 123, CDMX',
  contacto: 'hola@testarudo.mx',
  fecha: new Date('2026-09-02T12:00:00.000Z'),
}

describe('plantillaDeAviso', () => {
  it('rellena nombre y contacto y no deja ningún {{marcador}} sin sustituir', () => {
    const texto = plantillaDeAviso(BASE)
    expect(texto).toContain('Testarudo Café')
    expect(texto).toContain('Av. Reforma 123, CDMX')
    expect(texto).toContain('hola@testarudo.mx')
    expect(texto).not.toMatch(/\{\{[^}]+\}\}/)
  })

  // 🔴 20-mar-2025: la reforma de la LFPDPPP eliminó al INAI y trasladó la autoridad a la
  // Secretaría Anticorrupción y Buen Gobierno. Si el texto vuelve a mencionar al INAI, es
  // porque alguien lo escribió de memoria en vez de copiarlo del documento fuente ya
  // revisado — la misma trampa que costó una auditoría entera en horas extra (art. 66).
  it('menciona a la Secretaría Anticorrupción y Buen Gobierno como autoridad, NUNCA al INAI', () => {
    const texto = plantillaDeAviso(BASE)
    expect(texto).toContain('Secretaría Anticorrupción y Buen Gobierno')
    expect(texto.toUpperCase()).not.toContain('INAI')
  })

  it('sin domicilio, deja un placeholder explícito en vez de un marcador vacío', () => {
    const texto = plantillaDeAviso({ ...BASE, domicilio: undefined })
    expect(texto).not.toMatch(/\{\{[^}]+\}\}/)
    expect(texto).toContain('domicilio pendiente de captura')
  })

  it('formatea la fecha en español (no ISO crudo)', () => {
    const texto = plantillaDeAviso(BASE)
    expect(texto).toContain('2 de septiembre de 2026')
  })

  it('el marcador de contacto aparece en las DOS oraciones que lo usan (baja y derechos ARCO)', () => {
    const texto = plantillaDeAviso(BASE)
    const ocurrencias = texto.split('hola@testarudo.mx').length - 1
    expect(ocurrencias).toBe(2)
  })
})
