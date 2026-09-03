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

  // 🔴 Estas tres pruebas sostienen la decisión de NO sanitizar: el escape tiene que ser COMPLETO
  // en los cinco puntos donde entra texto del dueño a un atributo o al cuerpo, no sólo en los dos
  // que ya cubrían las pruebas de arriba. Un solo punto sin escapar es un correo con marcado
  // inyectado firmado con nuestro dominio de marketing.

  it('escapa el alt de la imagen: un atributo hostil no puede inyectar onerror', () => {
    const { html } = renderizarBloques([{ type: 'image', url: 'https://x.mx/a.png', alt: '" onerror="alert(1)' }])
    expect(html).not.toContain('" onerror="alert(1)"')
    expect(html).toContain('&quot; onerror=&quot;alert(1)')
  })

  it('escapa las comillas del src de la imagen: el atributo no se puede cerrar antes de tiempo', () => {
    const { html } = renderizarBloques([{ type: 'image', url: 'https://x.mx/a.png?q="onerror="alert(1)', alt: 'x' }])
    expect(html).not.toContain('src="https://x.mx/a.png?q="')
    expect(html).toContain('&quot;onerror=&quot;alert(1)')
  })

  it('escapa la etiqueta del botón: un script no puede colarse en el texto visible', () => {
    const { html } = renderizarBloques([{ type: 'button', label: '<script>alert(1)</script>', url: 'https://x.mx/p' }])
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
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
