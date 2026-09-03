import type { BloqueCampana } from './campaignBlocks'

/**
 * Convierte los bloques en el HTML y el texto del correo.
 *
 * 🔴 Todo lo que el dueño teclea se ESCAPA antes de entrar al HTML: su texto es CONTENIDO dentro
 * del HTML que genera el servidor, nunca marcado. Por eso no hace falta sanitizar nada — no hay
 * HTML ajeno que limpiar. Las URLs ya vienen restringidas a http(s) por el esquema (T1); aquí
 * además se escapan las comillas para que no puedan salirse del atributo.
 *
 * Estilos EN LÍNEA a propósito: los clientes de correo (sobre todo Outlook) ignoran las hojas de
 * estilo y buena parte de flexbox.
 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

export function renderizarBloques(bloques: BloqueCampana[]): { html: string; text: string } {
  const html: string[] = []
  const text: string[] = []

  for (const b of bloques) {
    switch (b.type) {
      case 'heading':
        html.push(`<h1 style="font-size:22px;font-weight:600;margin:0 0 12px 0;color:#111;">${esc(b.text)}</h1>`)
        text.push(b.text)
        break
      case 'paragraph':
        html.push(`<p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;color:#333;">${esc(b.text)}</p>`)
        text.push(b.text)
        break
      case 'image':
        html.push(`<img src="${esc(b.url)}" alt="${esc(b.alt)}" style="max-width:100%;height:auto;display:block;margin:0 0 16px 0;" />`)
        text.push(`[${b.alt}]`)
        break
      case 'button':
        html.push(
          `<p style="margin:0 0 20px 0;"><a href="${esc(b.url)}" style="display:inline-block;background:#000;color:#fff;` +
            `padding:12px 20px;border-radius:6px;text-decoration:none;font-size:15px;">${esc(b.label)}</a></p>`,
        )
        text.push(`${b.label}: ${b.url}`)
        break
      case 'divider':
        html.push('<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />')
        text.push('---')
        break
    }
  }

  return { html: html.join('\n'), text: text.join('\n\n') }
}

/**
 * Dominios de los enlaces del cuerpo, para registrarlos al publicar (§Motor punto 8 del spec).
 * 🔑 Con bloques esto es fiable: se leen del campo `url`, en vez de buscarlos parseando HTML.
 */
export function dominiosDeLosBloques(bloques: BloqueCampana[]): string[] {
  const dominios = new Set<string>()
  for (const b of bloques) {
    const url = b.type === 'button' || b.type === 'image' ? b.url : null
    if (!url) continue
    try {
      dominios.add(new URL(url).hostname.toLowerCase())
    } catch {
      // El esquema ya validó la URL; si aun así no parsea, no se registra y ya.
    }
  }
  return [...dominios]
}
