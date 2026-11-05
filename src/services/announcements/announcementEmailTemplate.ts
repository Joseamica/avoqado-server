import { escapeHtml } from '../../controllers/public/publicHtml'

/**
 * Correo de un anuncio de plataforma. Función pura: sin red, sin base de datos.
 * Los bloques vienen de `Announcement.contentBlocks` (JSON ya validado al escribir), pero aquí se
 * tratan como no confiables: todo texto se escapa, toda URL debe ser http(s) y un tipo desconocido
 * se salta (el servidor puede conocer tipos que esta plantilla aún no).
 */

export interface AnnouncementEmailInput {
  title: string
  body: string
  imageUrl?: string | null
  contentBlocks: unknown
  actionLabel?: string | null
  actionUrl?: string | null
  openUrl: string
  unsubscribeUrl: string
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
const IMG_STYLE = 'width:100%;max-width:560px;height:auto'
const TONES: Record<string, { bg: string; border: string }> = {
  info: { bg: '#e8f0fe', border: '#1a73e8' },
  warning: { bg: '#fff4e5', border: '#f5a623' },
  success: { bg: '#e6f4ea', border: '#34a853' },
}

const esc = (v: unknown): string => escapeHtml(typeof v === 'string' ? v : '')
const safeUrl = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

const img = (url: unknown, alt: unknown, caption?: unknown, width?: unknown, height?: unknown): string => {
  const src = safeUrl(url)
  if (!src) return ''
  const dims = [typeof width === 'number' ? ` width="${width}"` : '', typeof height === 'number' ? ` height="${height}"` : ''].join('')
  const cap = typeof caption === 'string' && caption ? `<p style="margin:6px 0 0;font-size:13px;color:#666;">${esc(caption)}</p>` : ''
  return `<div style="margin:16px 0;"><img src="${escapeHtml(src)}" alt="${esc(alt)}"${dims} style="${IMG_STYLE};display:block;border-radius:8px;border:0;">${cap}</div>`
}

const button = (label: unknown, url: unknown): string => {
  const href = safeUrl(url)
  if (!href || typeof label !== 'string' || !label) return ''
  return `<div style="margin:20px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;background:#000000;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 24px;border-radius:8px;">${esc(label)}</a></div>`
}

function videoUrl(b: any): string | null {
  if (typeof b.videoId !== 'string' || !/^[\w-]+$/.test(b.videoId)) return null
  if (b.provider === 'youtube') return `https://www.youtube.com/watch?v=${b.videoId}`
  if (b.provider === 'vimeo') return `https://vimeo.com/${b.videoId}`
  return null
}

function renderBlock(b: any): { html: string; text: string } {
  if (!b || typeof b !== 'object') return { html: '', text: '' }
  switch (b.type) {
    case 'heading':
      return { html: `<h2 style="margin:24px 0 8px;font-size:18px;font-weight:700;color:#000;">${esc(b.text)}</h2>`, text: String(b.text ?? '') }
    case 'paragraph':
      return { html: `<p style="margin:0 0 16px;font-size:15px;color:#333;">${esc(b.text)}</p>`, text: String(b.text ?? '') }
    case 'bullets': {
      const items: string[] = Array.isArray(b.items) ? b.items.filter((i: unknown) => typeof i === 'string') : []
      return {
        html: `<ul style="margin:0 0 16px;padding-left:20px;font-size:15px;color:#333;">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`,
        text: items.map(i => `- ${i}`).join('\n'),
      }
    }
    case 'image':
      return { html: img(b.url, b.alt, b.caption, b.width, b.height), text: typeof b.caption === 'string' ? b.caption : '' }
    case 'gallery': {
      const imgs: any[] = Array.isArray(b.images) ? b.images : []
      return { html: imgs.map(i => img(i?.url, i?.alt, i?.caption, i?.width, i?.height)).join(''), text: '' }
    }
    case 'specs': {
      const rows: any[] = Array.isArray(b.rows) ? b.rows : []
      return {
        html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-collapse:collapse;">${rows
          .map(
            r =>
              `<tr style="border-bottom:1px solid #e0e0e0;"><td style="padding:8px 0;font-size:14px;color:#666;">${esc(r?.label)}</td><td style="padding:8px 0;font-size:14px;color:#000;text-align:right;">${esc(r?.value)}</td></tr>`,
          )
          .join('')}</table>`,
        text: rows.map(r => `${r?.label ?? ''}: ${r?.value ?? ''}`).join('\n'),
      }
    }
    case 'callout': {
      const t = TONES[b.tone] ?? TONES.info
      return {
        html: `<div style="margin:0 0 16px;padding:12px 16px;background:${t.bg};border-left:4px solid ${t.border};border-radius:4px;font-size:15px;color:#000;">${esc(b.text)}</div>`,
        text: String(b.text ?? ''),
      }
    }
    case 'button':
      return { html: button(b.label, b.url), text: safeUrl(b.url) ? `${b.label}: ${b.url}` : '' }
    case 'video': {
      const url = videoUrl(b)
      return { html: button('Ver video', url), text: url ? `Ver video: ${url}` : '' }
    }
    case 'divider':
      return { html: '<hr style="border:none;border-top:1px solid #e0e0e0;margin:24px 0;">', text: '' }
    default:
      return { html: '', text: '' }
  }
}

export function renderAnnouncementEmail(input: AnnouncementEmailInput): { subject: string; html: string; text: string } {
  const blocks = Array.isArray(input.contentBlocks) ? input.contentBlocks : []
  const parts = blocks.map(renderBlock)
  const open = safeUrl(input.openUrl) ?? ''
  const unsub = safeUrl(input.unsubscribeUrl) ?? ''
  const action = input.actionLabel ? button(input.actionLabel, input.actionUrl) : ''

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(input.title)}</title></head>
<body style="font-family:${FONT};line-height:1.6;margin:0;padding:0;background-color:#ffffff;color:#000000;">
  <div style="max-width:600px;margin:0 auto;padding:24px;">
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#000;">${esc(input.title)}</h1>
    ${input.imageUrl ? img(input.imageUrl, input.title) : ''}
    ${input.body ? `<p style="margin:0 0 16px;font-size:15px;color:#333;">${esc(input.body)}</p>` : ''}
    ${parts.map(p => p.html).join('\n    ')}
    ${action}
    <hr style="border:none;border-top:1px solid #e0e0e0;margin:32px 0 16px;">
    <p style="margin:0 0 8px;font-size:13px;"><a href="${escapeHtml(open)}" style="color:#1a73e8;">Abrir en Avoqado</a></p>
    <p style="margin:0;font-size:12px;color:#888;"><a href="${escapeHtml(unsub)}" style="color:#888;">Dejar de recibir anuncios de Avoqado por correo</a></p>
  </div>
</body>
</html>`

  const text = [
    input.title,
    input.body,
    ...parts.map(p => p.text),
    input.actionLabel && safeUrl(input.actionUrl) ? `${input.actionLabel}: ${input.actionUrl}` : '',
    `Abrir en Avoqado: ${open}`,
    `Dejar de recibir anuncios de Avoqado por correo: ${unsub}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  return { subject: input.title, html, text }
}
