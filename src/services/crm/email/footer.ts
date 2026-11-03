/**
 * El pie de cada correo de campaña de Avoqado (LFPDPPP): quién lo manda, por qué le llega a esa persona y cómo dejar de
 * recibirlo. Las cabeceras de baja son las del RFC 8058 (un clic desde el propio cliente de correo).
 */
import { escapeHtml } from '../../../controllers/public/publicHtml'

export const DOMICILIO = 'Servicios Tecnológicos Avo S.A. de C.V. · Ciudad de México, México · hola@avoqado.io'
export const AVISO_DE_PRIVACIDAD_URL = 'https://avoqado.io/privacy'

export type MotivoDeEnvio = 'PROSPECTO' | 'CLIENTE' | 'USUARIO'

function motivo(reason: MotivoDeEnvio, venueName?: string | null): string {
  switch (reason) {
    case 'PROSPECTO':
      return 'Te llega porque pediste recibir novedades de Avoqado.'
    case 'CLIENTE':
      return 'Te llega porque eres cliente de Avoqado.'
    case 'USUARIO':
      return `Te llega porque usas Avoqado en ${venueName?.trim() || 'tu negocio'}.`
  }
}

/** Se AÑADE después del cuerpo. El nombre del negocio viene de la base: va escapado en el HTML. */
export function pieDeCampana(
  reason: MotivoDeEnvio,
  venueName: string | null | undefined,
  unsubscribeUrl: string,
): { html: string; text: string } {
  const porQue = motivo(reason, venueName)
  const html = `
<hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0;" />
<div style="font-size:12px;color:#999;line-height:1.6;">
  <p style="margin:0 0 8px 0;">${escapeHtml(porQue)}</p>
  <p style="margin:0 0 8px 0;">${escapeHtml(DOMICILIO)}</p>
  <p style="margin:0;"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#666;text-decoration:underline;">Dejar de recibir estos correos</a></p>
  <p style="margin:4px 0 0 0;"><a href="${AVISO_DE_PRIVACIDAD_URL}" style="color:#666;text-decoration:underline;">Aviso de privacidad</a></p>
</div>`
  const text = `

---
${porQue}
${DOMICILIO}
Dejar de recibir estos correos: ${unsubscribeUrl}
Aviso de privacidad: ${AVISO_DE_PRIVACIDAD_URL}`
  return { html, text }
}

export function cabecerasDeBaja(unsubscribeUrl: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}
