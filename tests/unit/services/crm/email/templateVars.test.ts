/**
 * Variables de las plantillas (`{{nombre}}`, `{{negocio}}`, `{{vendedor}}`) y el pie de cada correo de campaña.
 *
 * 🔴 Lo que importa: lo que viene de la base (un nombre con HTML, una URL) no puede inyectar nada. La sustitución pone
 * TEXTO en los bloques y es `renderizarBloques` quien lo escapa al armar el HTML; la `url` nunca se toca.
 */
import { renderizarBloques } from '@/services/marketing/campaignRenderer'
import type { BloqueCampana } from '@/services/marketing/campaignBlocks'
import { aplicarVariables, variablesDesconocidas, VARIABLES } from '@/services/crm/email/templateVars'
import { cabecerasDeBaja, DOMICILIO, pieDeCampana } from '@/services/crm/email/footer'

const URL_BAJA = 'https://api.avoqado.io/api/v1/public/avoqado/unsubscribe?token=abc'

describe('variablesDesconocidas', () => {
  it('la lista cerrada son tres', () => {
    expect([...VARIABLES]).toEqual(['nombre', 'negocio', 'vendedor'])
  })

  it('Hola {{nombre}} {{precio}} da ["precio"]', () => {
    expect(variablesDesconocidas('Hola {{nombre}} {{precio}}')).toEqual(['precio'])
  })

  it('las tres conocidas no dan nada, también con espacios dentro de las llaves', () => {
    expect(variablesDesconocidas('{{nombre}} {{ negocio }} {{vendedor}}')).toEqual([])
  })

  it('no repite la misma desconocida y respeta el orden', () => {
    expect(variablesDesconocidas('{{b}} {{a}} {{b}}')).toEqual(['b', 'a'])
  })

  it('es estricta con las mayúsculas y con las llaves vacías', () => {
    expect(variablesDesconocidas('{{Nombre}} {{}}')).toEqual(['Nombre', ''])
  })

  it('un {{ sin cerrar es texto, no una variable', () => {
    expect(variablesDesconocidas('mira {{esto y {{nombre}')).toEqual([])
  })
})

describe('aplicarVariables', () => {
  const bloques: BloqueCampana[] = [
    { type: 'heading', text: 'Hola {{nombre}}' },
    { type: 'paragraph', text: '{{vendedor}} te escribe sobre {{negocio}}.' },
    { type: 'image', url: 'https://x.mx/{{nombre}}.png', alt: 'Foto de {{negocio}}' },
    { type: 'button', label: 'Ver {{negocio}}', url: 'https://x.mx/?n={{nombre}}' },
    { type: 'divider' },
  ]

  it('sustituye en text, label y alt, y en el asunto', () => {
    const r = aplicarVariables(bloques, 'Novedades para {{negocio}}', { nombre: 'Ana', negocio: 'Café Lalo', vendedor: 'Rafa' })

    expect(r.asunto).toBe('Novedades para Café Lalo')
    expect(r.bloques[0]).toEqual({ type: 'heading', text: 'Hola Ana' })
    expect(r.bloques[1]).toEqual({ type: 'paragraph', text: 'Rafa te escribe sobre Café Lalo.' })
    expect((r.bloques[2] as { alt: string }).alt).toBe('Foto de Café Lalo')
    expect((r.bloques[3] as { label: string }).label).toBe('Ver Café Lalo')
    expect(r.bloques[4]).toEqual({ type: 'divider' })
  })

  it('el {{nombre}} dentro de una url queda intacto', () => {
    const r = aplicarVariables(bloques, 'x', { nombre: 'Ana', negocio: 'Café Lalo', vendedor: 'Rafa' })

    expect((r.bloques[2] as { url: string }).url).toBe('https://x.mx/{{nombre}}.png')
    expect((r.bloques[3] as { url: string }).url).toBe('https://x.mx/?n={{nombre}}')
  })

  it('no toca los bloques de entrada', () => {
    const copia = JSON.parse(JSON.stringify(bloques))
    aplicarVariables(bloques, 'x', { nombre: 'Ana' })
    expect(bloques).toEqual(copia)
  })

  it('un nombre con HTML se escapa al renderizar: &lt;b&gt;Ana&lt;/b&gt;', () => {
    const r = aplicarVariables([{ type: 'paragraph', text: 'Hola {{nombre}}' }], 'x', { nombre: '<b>Ana</b>' })
    const { html } = renderizarBloques(r.bloques)

    expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;')
    expect(html).not.toContain('<b>')
  })

  it('un <script> en el negocio sale escapado en el cuerpo y en un atributo', () => {
    const r = aplicarVariables(
      [
        { type: 'paragraph', text: '{{negocio}}' },
        { type: 'image', url: 'https://x.mx/a.png', alt: '{{negocio}}' },
      ],
      'x',
      { negocio: '<script>alert(1)</script>"onerror="x' },
    )
    const { html } = renderizarBloques(r.bloques)

    expect(html).not.toContain('<script>')
    expect(html).not.toContain('"onerror="x')
    expect(html).toContain('&lt;script&gt;')
  })

  it('un valor que trae {{otra}} no se vuelve a expandir', () => {
    const r = aplicarVariables([{ type: 'paragraph', text: '{{nombre}} / {{vendedor}}' }], 'x', {
      nombre: '{{vendedor}}',
      vendedor: 'Rafa',
    })
    expect(r.bloques[0]).toEqual({ type: 'paragraph', text: '{{vendedor}} / Rafa' })
  })

  it('nombre vacío cae en negocio, y sin negocio queda vacío', () => {
    const t = (vars: Parameters<typeof aplicarVariables>[2]) =>
      (aplicarVariables([{ type: 'paragraph', text: '[{{nombre}}]' }], 'x', vars).bloques[0] as { text: string }).text

    expect(t({ nombre: '', negocio: 'Café Lalo' })).toBe('[Café Lalo]')
    expect(t({ nombre: '   ', negocio: 'Café Lalo' })).toBe('[Café Lalo]')
    expect(t({ nombre: null, negocio: 'Café Lalo' })).toBe('[Café Lalo]')
    expect(t({ nombre: null, negocio: null })).toBe('[]')
    expect(t({})).toBe('[]')
  })

  it('negocio vacío cae en «tu negocio» y vendedor vacío en «el equipo de Avoqado»', () => {
    const r = aplicarVariables([{ type: 'paragraph', text: '{{negocio}} · {{vendedor}}' }], 'x', { negocio: '', vendedor: null })
    expect(r.bloques[0]).toEqual({ type: 'paragraph', text: 'tu negocio · el equipo de Avoqado' })
  })

  it('un salto de línea en un valor no parte el asunto', () => {
    const r = aplicarVariables([{ type: 'divider' }], 'Hola {{nombre}}', { nombre: 'Ana\r\nBcc: x@y.com' })
    expect(r.asunto).toBe('Hola Ana Bcc: x@y.com')
  })

  it('una variable que no existe se queda tal cual (se rechaza al guardar, no al mandar)', () => {
    const r = aplicarVariables([{ type: 'paragraph', text: '{{precio}}' }], '{{x}}', { nombre: 'Ana' })
    expect(r.bloques[0]).toEqual({ type: 'paragraph', text: '{{precio}}' })
    expect(r.asunto).toBe('{{x}}')
  })
})

describe('pieDeCampana', () => {
  it('USUARIO dice en qué negocio usa Avoqado y trae el domicilio exacto', () => {
    const { html, text } = pieDeCampana('USUARIO', 'Testarudo', URL_BAJA)

    expect(text).toContain('Te llega porque usas Avoqado en Testarudo.')
    expect(html).toContain('Te llega porque usas Avoqado en Testarudo.')
    expect(DOMICILIO).toBe('Servicios Tecnológicos Avo S.A. de C.V. · Ciudad de México, México · hola@avoqado.io')
    expect(text).toContain(DOMICILIO)
    expect(html).toContain(DOMICILIO)
  })

  it('un nombre de negocio con < sale escapado en el HTML y tal cual en el texto', () => {
    const { html, text } = pieDeCampana('USUARIO', '<img src=x onerror=1>', URL_BAJA)

    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=1&gt;')
    expect(text).toContain('<img src=x onerror=1>')
  })

  it('PROSPECTO y CLIENTE llevan su motivo', () => {
    expect(pieDeCampana('PROSPECTO', null, URL_BAJA).text).toContain('Te llega porque pediste recibir novedades de Avoqado.')
    expect(pieDeCampana('CLIENTE', null, URL_BAJA).text).toContain('Te llega porque eres cliente de Avoqado.')
  })

  it('USUARIO sin negocio no truena: «tu negocio»', () => {
    expect(pieDeCampana('USUARIO', undefined, URL_BAJA).text).toContain('Te llega porque usas Avoqado en tu negocio.')
  })

  it('trae los dos enlaces: baja y aviso de privacidad', () => {
    const { html, text } = pieDeCampana('CLIENTE', null, URL_BAJA)

    expect(html).toContain(`href="${URL_BAJA}"`)
    expect(html).toContain('Dejar de recibir estos correos')
    expect(html).toContain('href="https://avoqado.io/privacy"')
    expect(html).toContain('Aviso de privacidad')
    expect(text).toContain(`Dejar de recibir estos correos: ${URL_BAJA}`)
    expect(text).toContain('Aviso de privacidad: https://avoqado.io/privacy')
  })

  it('una liga de baja con comillas no se sale del atributo', () => {
    const { html } = pieDeCampana('CLIENTE', null, 'https://x.mx/?a="onclick="x')
    expect(html).not.toContain('"onclick="x')
    expect(html).toContain('&quot;onclick=&quot;x')
  })
})

describe('cabecerasDeBaja', () => {
  it('List-Unsubscribe y el POST de un clic (RFC 8058)', () => {
    expect(cabecerasDeBaja(URL_BAJA)).toEqual({
      'List-Unsubscribe': `<${URL_BAJA}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })
  })
})
