import { renderizarBloques, dominiosDeLosBloques } from '@/services/marketing/campaignRenderer'

describe('renderizarBloques', () => {
  it('un encabezado y un párrafo salen en html y en texto', () => {
    const { html, text } = renderizarBloques([
      { type: 'heading', text: 'Promoción' },
      { type: 'paragraph', text: 'Este mes 2x1.' },
    ])
    expect(html).toContain('<h1')
    expect(html).toContain('Promoción')
    expect(text).toContain('Este mes 2x1.')
    expect(text).not.toContain('<')
  })

  // 🔴 El texto del dueño es CONTENIDO dentro del HTML del servidor, nunca marcado.
  it('escapa el texto del dueño: un < no puede abrir una etiqueta', () => {
    const { html } = renderizarBloques([{ type: 'paragraph', text: '<script>alert(1)</script>' }])
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapa las comillas de una URL, para que no se escape del atributo', () => {
    const { html } = renderizarBloques([{ type: 'button', label: 'Ver', url: 'https://x.mx/a?b="c' }])
    expect(html).toContain('&quot;')
  })

  it('el botón sale como enlace, y en texto como etiqueta + URL', () => {
    const { html, text } = renderizarBloques([{ type: 'button', label: 'Ver promoción', url: 'https://x.mx/p' }])
    expect(html).toContain('href="https://x.mx/p"')
    expect(text).toContain('Ver promoción: https://x.mx/p')
  })

  it('la imagen lleva su alt — sin alt es inaccesible y sube el spam score', () => {
    const { html } = renderizarBloques([{ type: 'image', url: 'https://x.mx/a.png', alt: 'Corte' }])
    expect(html).toContain('alt="Corte"')
  })
})

describe('dominiosDeLosBloques', () => {
  it('devuelve los dominios de botones e imágenes, sin repetir y en minúsculas', () => {
    const d = dominiosDeLosBloques([
      { type: 'button', label: 'a', url: 'https://Mi-Negocio.MX/p' },
      { type: 'button', label: 'b', url: 'https://mi-negocio.mx/otra' },
      { type: 'image', url: 'https://cdn.avoqado.io/x.png', alt: 'x' },
    ])
    expect(d.sort()).toEqual(['cdn.avoqado.io', 'mi-negocio.mx'])
  })

  it('sin enlaces, devuelve lista vacía', () => {
    expect(dominiosDeLosBloques([{ type: 'heading', text: 'x' }])).toEqual([])
  })
})
