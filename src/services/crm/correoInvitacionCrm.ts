/**
 * El correo de invitación al CRM de ventas (D3, hz:e0c38c0d:D3, 4-nov-2026).
 *
 * La invitación al negocio interno «Avoqado · Equipo de ventas» usaba el correo genérico de un negocio («como Observador…
 * gestionar órdenes y pagos, administrar el menú») y su botón llevaba al DASHBOARD de ese negocio vacío. Éste dice que es
 * el CRM y lleva al SUPERADMIN: ahí «Continuar con Google» ya acepta la invitación (D2). Quien no usa Google crea su
 * contraseña con la liga de la invitación de siempre y después entra al SUPERADMIN.
 *
 * Pieza pura (sin efectos) para poder probarla sola; la manda `emailService.sendCrmTeamInvitation`.
 */
import { escapeHtml } from '../../controllers/public/publicHtml'

export interface CorreoInvitacionCrmData {
  inviterName: string
  /** La entrada del SUPERADMIN (`${SUPERADMIN_URL}/login`). */
  crmUrl: string
  /** La invitación de siempre (`${FRONTEND_URL}/invite/:token`), para crear contraseña. */
  inviteLink: string
  /** El correo invitado: es con el que tiene que entrar. */
  email: string
}

const LOGO = 'https://avoqado.io/isotipo.svg'

export function correoInvitacionCrm(data: CorreoInvitacionCrmData): { subject: string; html: string; text: string } {
  const quien = escapeHtml(data.inviterName)
  const correo = escapeHtml(data.email)
  const subject = 'Te invitaron al CRM de ventas de Avoqado'

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">
    <div style="padding-bottom: 32px;">
      <img src="${LOGO}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <h1 style="margin: 0 0 24px 0; font-size: 32px; font-weight: 400; color: #000;">Te invitaron al CRM de ventas de Avoqado</h1>

    <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hola,</p>
    <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">
      <strong>${quien}</strong> te dio acceso al CRM de ventas de Avoqado, donde trabajas tus prospectos, plantillas y campañas.
    </p>
    <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
      Entra con este correo, <strong>${correo}</strong>. Si es de Google, aprieta «Continuar con Google» y listo.
    </p>

    <div style="padding: 8px 0 32px 0; text-align: center;">
      <a href="${data.crmUrl}" style="background-color:#000000; color:#ffffff; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block;">
        Entrar al CRM
      </a>
    </div>

    <p style="font-size: 14px; margin: 0 0 8px 0; color: #000;">
      ¿Tu correo no es de Google? <a href="${data.inviteLink}" style="color: #000; font-weight: 600;">Crea tu contraseña aquí</a>
      y después entra al CRM con el botón de arriba.
    </p>
    <p style="font-size: 14px; color: #666; margin: 0 0 24px 0;">
      Esta invitación expira en 7 días. Si tienes alguna pregunta, contacta a ${quien}.
    </p>

    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 40px 0 24px 0;">
    <div>
      <div style="margin-bottom: 16px;">
        <img src="${LOGO}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0 0 16px 0; font-size: 14px; color: #000;">
        Servicios Tecnologicos Avo S.A. de C.V.<br>
        Ciudad de Mexico, Mexico
      </p>
      <p style="margin: 0; font-size: 12px; color: #666;">
        Este correo fue enviado por Avoqado. Si no esperabas recibir esta invitación, puedes ignorar este mensaje.
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">Política de Privacidad</a>
      </p>
    </div>
  </div>
</body>
</html>
`

  const text = `Hola,

${data.inviterName} te dio acceso al CRM de ventas de Avoqado, donde trabajas tus prospectos, plantillas y campañas.

Entra con este correo (${data.email}). Si es de Google, aprieta «Continuar con Google»:
${data.crmUrl}

¿Tu correo no es de Google? Crea tu contraseña aquí y después entra al CRM con la liga de arriba:
${data.inviteLink}

Esta invitación expira en 7 días.

Equipo de Avoqado
`

  return { subject, html, text }
}
