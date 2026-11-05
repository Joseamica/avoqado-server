import { renderAnnouncementEmail } from '../../../../src/services/announcements/announcementEmailTemplate'

const base = { title: 'Novedad', body: 'Texto', contentBlocks: [], openUrl: 'https://app.avoqado.io/x', unsubscribeUrl: 'https://api.avoqado.io/baja?t=1' }

describe('renderAnnouncementEmail', () => {
  it('escapa HTML del título, texto y bloques', () => {
    const r = renderAnnouncementEmail({
      ...base,
      title: '<b>Hola & "tú"</b>',
      contentBlocks: [{ type: 'paragraph', text: '<script>x</script>' }],
    })
    expect(r.subject).toBe('<b>Hola & "tú"</b>')
    expect(r.html).toContain('&lt;b&gt;Hola &amp; &quot;tú&quot;&lt;/b&gt;')
    expect(r.html).not.toContain('<script>')
    expect(r.html).toContain('&lt;script&gt;x&lt;/script&gt;')
  })

  it('descarta urls que no son http(s)', () => {
    const r = renderAnnouncementEmail({
      ...base,
      actionLabel: 'Ir',
      actionUrl: 'javascript:alert(1)',
      contentBlocks: [
        { type: 'image', url: 'data:image/png;base64,AAAA', alt: 'x' },
        { type: 'button', label: 'Malo', url: 'javascript:alert(2)' },
      ],
    })
    expect(r.html).not.toContain('javascript:')
    expect(r.html).not.toContain('data:image')
  })

  it('imágenes con width 100% y max-width 560px y height auto', () => {
    const r = renderAnnouncementEmail({
      ...base,
      imageUrl: 'https://cdn.x/a.png',
      contentBlocks: [{ type: 'gallery', images: [{ url: 'https://cdn.x/b.png', alt: 'b' }, { url: 'https://cdn.x/c.png', alt: 'c' }] }],
    })
    expect(r.html.match(/width:100%;max-width:560px;height:auto/g)?.length).toBe(3)
  })

  it('trae la liga de baja y la de abrir, y text sin etiquetas', () => {
    const r = renderAnnouncementEmail({ ...base, contentBlocks: [{ type: 'heading', text: 'Título' }, { type: 'bullets', items: ['uno', 'dos'] }] })
    expect(r.html).toContain('href="https://app.avoqado.io/x"')
    expect(r.html).toContain('Abrir en Avoqado')
    expect(r.html).toContain('href="https://api.avoqado.io/baja?t=1"')
    expect(r.html).toContain('Dejar de recibir anuncios de Avoqado por correo')
    expect(r.text).not.toMatch(/<[a-z/][^>]*>/i)
    expect(r.text).toContain('uno')
    expect(r.text).toContain('https://api.avoqado.io/baja?t=1')
  })

  it('video es botón «Ver video»; specs, callout, divider y desconocidos no truenan', () => {
    const r = renderAnnouncementEmail({
      ...base,
      contentBlocks: [
        { type: 'video', provider: 'youtube', videoId: 'abc123' },
        { type: 'specs', rows: [{ label: 'A', value: 'B' }] },
        { type: 'callout', tone: 'info', text: 'ojo' },
        { type: 'divider' },
        { type: 'inventado', foo: 1 },
        null,
      ],
    })
    expect(r.html).toContain('Ver video')
    expect(r.html).toContain('https://www.youtube.com/watch?v=abc123')
    expect(r.html).toContain('ojo')
  })

  it('contentBlocks que no es arreglo no truena', () => {
    expect(() => renderAnnouncementEmail({ ...base, contentBlocks: 'basura' })).not.toThrow()
  })
})
