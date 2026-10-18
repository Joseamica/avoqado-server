/**
 * Bloque «Descarga y empieza a usar tu punto de venta» de los correos: las insignias oficiales de
 * las tres tiendas en UNA fila (founder, 16-oct: el lead no entendía que tenía que instalar la app).
 * Lo usan el correo del alta en la landing y la confirmación del plan al terminar el onboarding.
 *
 * Pieza pura, sin efectos: las suites que mockean `email.service` la siguen viendo entera.
 *
 * Ligas: las mismas de avoqado-landing/src/data/apps.ts (iOS y Android) y la ficha de la Microsoft
 * Store. Insignias: el artwork oficial en español, en PNG porque Gmail y Outlook no pintan SVG,
 * servido desde avoqado-landing/public/badges/. `ancho` = px a 40 de alto (el mínimo de Apple).
 */
type Idioma = 'es' | 'en'

export const APPS_POS = [
  {
    aparato: { es: 'iPhone y iPad', en: 'iPhone & iPad' },
    url: 'https://apps.apple.com/mx/app/avoqado/id6758351745',
    insignia: 'https://avoqado.io/badges/app-store-es.png',
    alt: 'Descárgalo en el App Store',
    ancho: 120,
  },
  {
    aparato: { es: 'Android', en: 'Android' },
    url: 'https://play.google.com/store/apps/details?id=com.avoqado.pos',
    insignia: 'https://avoqado.io/badges/google-play-es.png',
    alt: 'Descargar en Google Play',
    ancho: 135,
  },
  {
    aparato: { es: 'PC con Windows', en: 'Windows PC' },
    url: 'https://apps.microsoft.com/detail/9PCZG05M3PVC',
    insignia: 'https://avoqado.io/badges/microsoft-store-es.png',
    alt: 'Descargar desde Microsoft Store',
    ancho: 146,
  },
]
const ANCHO_INSIGNIAS = APPS_POS.reduce((s, a) => s + a.ancho, 0)

const TEXTOS = {
  es: {
    titulo: 'Descarga y empieza a usar tu punto de venta',
    detalle: 'Instala Avoqado en el celular, la tablet o la computadora donde vas a cobrar, y entra con este mismo correo y tu contraseña.',
  },
  en: {
    titulo: 'Download and start using your point of sale',
    detalle: 'Install Avoqado on the phone, tablet or computer where you take payments, and sign in with this email and your password.',
  },
}

/** `paso` antepone «PASO 2» cuando el correo trae otro paso antes (crear la contraseña). */
export function descargarAppHtml(opts: { idioma?: Idioma; paso?: number } = {}): string {
  const idioma = opts.idioma ?? 'es'
  const t = TEXTOS[idioma]
  // Cada celda mide lo que su insignia: las tres quedan a la misma altura y en el celular se
  // encogen juntas en vez de partirse en dos renglones.
  const celdas = APPS_POS.map(
    a => `<td style="width:${((a.ancho / ANCHO_INSIGNIAS) * 100).toFixed(1)}%;padding:0 4px;text-align:center;vertical-align:top;">
            <a href="${a.url}" style="display:block;text-decoration:none;"><img src="${a.insignia}" alt="${a.alt}" width="${a.ancho}" style="display:block;width:100%;max-width:${a.ancho}px;height:auto;border:0;margin:0 auto;"></a>
            <div style="font-size:12px;color:#666;margin-top:6px;line-height:1.3;">${a.aparato[idioma]}</div>
          </td>`,
  ).join('')
  return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:24px 12px;margin:0 0 24px 0;text-align:center;">
      ${opts.paso ? `<p style="margin:0 0 6px 0;font-size:12px;font-weight:600;color:#666;letter-spacing:0.5px;text-transform:uppercase;">${idioma === 'en' ? 'Step' : 'Paso'} ${opts.paso}</p>` : ''}
      <p style="margin:0 0 4px 0;font-size:18px;font-weight:600;color:#000;">${t.titulo}</p>
      <p style="margin:0 0 20px 0;font-size:14px;color:#666;">${t.detalle}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${ANCHO_INSIGNIAS + APPS_POS.length * 8}px;margin:0 auto;border-collapse:collapse;">
        <tr>
          ${celdas}
        </tr>
      </table>
    </div>`
}

export function descargarAppTexto(opts: { idioma?: Idioma; paso?: number } = {}): string {
  const idioma = opts.idioma ?? 'es'
  const t = TEXTOS[idioma]
  const paso = opts.paso ? `${idioma === 'en' ? 'Step' : 'Paso'} ${opts.paso}: ` : ''
  return `${paso}${t.titulo}. ${t.detalle}
${APPS_POS.map(a => `- ${a.aparato[idioma]}: ${a.url}`).join('\n')}`
}
