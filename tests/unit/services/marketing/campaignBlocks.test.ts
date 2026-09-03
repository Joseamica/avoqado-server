import { bloquesCampanaSchema } from '@/services/marketing/campaignBlocks'

describe('catálogo de bloques de campaña', () => {
  it('acepta los cinco tipos del catálogo', () => {
    const bloques = [
      { type: 'heading', text: 'Promoción de septiembre' },
      { type: 'paragraph', text: 'Este mes, 2x1 en cortes.' },
      { type: 'image', url: 'https://cdn.avoqado.io/a.png', alt: 'Corte de cabello' },
      { type: 'button', label: 'Ver promoción', url: 'https://mi-negocio.mx/promo' },
      { type: 'divider' },
    ]
    expect(bloquesCampanaSchema.parse(bloques)).toHaveLength(5)
  })

  // 🔴 Es la razón de ser del discriminatedUnion: un tipo inventado se rechaza AL ESCRIBIR.
  it('rechaza un bloque con un type inventado', () => {
    expect(() => bloquesCampanaSchema.parse([{ type: 'script', text: 'alert(1)' }])).toThrow()
  })

  it('rechaza una URL que no es http(s) — nada de javascript: ni data:', () => {
    expect(() => bloquesCampanaSchema.parse([{ type: 'button', label: 'x', url: 'javascript:alert(1)' }])).toThrow()
    expect(() => bloquesCampanaSchema.parse([{ type: 'image', url: 'data:text/html,<script>', alt: 'x' }])).toThrow()
  })

  it('rechaza una lista vacía: una campaña sin contenido no se publica', () => {
    expect(() => bloquesCampanaSchema.parse([])).toThrow()
  })

  it('rechaza texto en blanco en un encabezado', () => {
    expect(() => bloquesCampanaSchema.parse([{ type: 'heading', text: '   ' }])).toThrow()
  })
})
