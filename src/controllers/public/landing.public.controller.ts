import { Request, Response, NextFunction } from 'express'
import emailService from '../../services/email.service'
import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'

const CONTACT_NOTIFY_EMAIL = process.env.CONTACT_NOTIFY_EMAIL || 'hola@avoqado.io'
const LABS_NOTIFY_EMAIL = process.env.LABS_NOTIFY_EMAIL || 'hola@avoqado.io'

const projectLabel: Record<string, string> = {
  'web-app': 'Web App',
  'mobile-app': 'App Móvil',
  dashboard: 'Dashboard',
  automation: 'Automatización',
  'ai-agent': 'Agente AI',
  integration: 'Integración',
  report: 'Reporte',
  other: 'Otro',
}

const urgencyLabel: Record<string, string> = {
  hoy: 'Hoy',
  'esta-semana': 'Esta semana',
  'este-mes': 'Este mes',
  'sin-prisa': 'Sin prisa',
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ------------------------------------------------------------
// POST /api/v1/public/contact — landing demo request form
// ------------------------------------------------------------
export async function submitContact(req: Request, res: Response, next: NextFunction) {
  try {
    const { firstName, lastName, phone, email, companyName, employees, revenue } = req.body || {}

    if (!firstName || !lastName || !phone || !email || !companyName) {
      throw new BadRequestError('Todos los campos son requeridos')
    }

    const internalHtml = `
      <h2>Nueva solicitud de ventas</h2>
      <p><strong>Nombre:</strong> ${escapeHtml(String(firstName))} ${escapeHtml(String(lastName))}</p>
      <p><strong>Email:</strong> ${escapeHtml(String(email))}</p>
      <p><strong>Teléfono:</strong> ${escapeHtml(String(phone))}</p>
      <p><strong>Empresa:</strong> ${escapeHtml(String(companyName))}</p>
      <p><strong>Tamaño:</strong> ${escapeHtml(String(employees ?? '-'))}</p>
      <p><strong>Ingresos:</strong> ${escapeHtml(String(revenue ?? '-'))}</p>
      <hr>
      <p><em>Enviado desde avoqado.io/contact</em></p>
    `

    const confirmHtml = `
      <h2>¡Gracias por tu interés en Avoqado!</h2>
      <p>Hola ${escapeHtml(String(firstName))},</p>
      <p>Hemos recibido tu solicitud de información para <strong>${escapeHtml(String(companyName))}</strong>.</p>
      <p>Nuestro equipo de ventas se pondrá en contacto contigo en las próximas 24 horas.</p>
      <br>
      <p>Saludos,<br>El equipo de Avoqado</p>
    `

    const [internalSent, confirmSent] = await Promise.all([
      emailService.sendEmail({
        to: CONTACT_NOTIFY_EMAIL,
        subject: `Nueva solicitud de demo - ${String(companyName)}`,
        html: internalHtml,
      }),
      emailService.sendEmail({
        to: String(email),
        subject: 'Solicitud de contacto recibida - Avoqado',
        html: confirmHtml,
      }),
    ])

    if (!internalSent) {
      logger.error('[CONTACT_SUBMIT] Internal notification failed', { email, companyName })
      return res.status(502).json({ success: false, message: 'No se pudo notificar al equipo. Intenta de nuevo.' })
    }
    if (!confirmSent) {
      logger.warn('[CONTACT_SUBMIT] Confirmation email failed (lead saved)', { email })
    }

    return res.status(200).json({ success: true, message: 'Demo solicitada exitosamente' })
  } catch (err) {
    return next(err)
  }
}

// ------------------------------------------------------------
// POST /api/v1/public/labs/submit — Avoqado Labs brief
// ------------------------------------------------------------
interface LabsContact {
  name: string
  email?: string
  whatsapp?: string
}

interface LabsSubmitPayload {
  sessionId: string
  fields: {
    projectType: string
    projectTypeFreeText?: string
    businessContext: string
    coreFunctionality: string
    integrations: string[]
    designReference: string
    urgency: string
    contact: LabsContact
  }
  additionalNotes?: string
  transcript: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validateLabsPayload(p: any): p is LabsSubmitPayload {
  if (!p || typeof p !== 'object') return false
  if (typeof p.sessionId !== 'string') return false
  const f = p.fields
  if (!f || typeof f !== 'object') return false
  if (typeof f.projectType !== 'string') return false
  if (typeof f.businessContext !== 'string' || !f.businessContext.trim()) return false
  if (typeof f.coreFunctionality !== 'string' || !f.coreFunctionality.trim()) return false
  if (!Array.isArray(f.integrations)) return false
  if (typeof f.designReference !== 'string') return false
  if (typeof f.urgency !== 'string') return false
  const c = f.contact
  if (!c || typeof c.name !== 'string' || !c.name.trim()) return false
  // Need at least one reachable channel: a valid email OR a non-empty whatsapp.
  const hasEmail = typeof c.email === 'string' && EMAIL_RE.test(c.email)
  const hasWhatsapp = typeof c.whatsapp === 'string' && c.whatsapp.trim().length > 0
  if (!hasEmail && !hasWhatsapp) return false
  // If email is present but invalid (truthy non-empty string that doesn't match), reject.
  // Empty / undefined email is fine as long as whatsapp is present.
  if (typeof c.email === 'string' && c.email.trim().length > 0 && !EMAIL_RE.test(c.email)) return false
  if (!Array.isArray(p.transcript)) return false
  return true
}

function renderLabsBriefHtml(payload: LabsSubmitPayload): string {
  const f = payload.fields
  const transcriptHtml = payload.transcript
    .map(
      m =>
        `<div style="margin:8px 0;padding:8px 12px;border-left:3px solid ${m.role === 'user' ? '#d97452' : '#888'};background:#fafafa;font-size:13px;">
          <strong>${m.role === 'user' ? 'Cliente' : 'Agente'}:</strong>
          <div style="white-space:pre-wrap;margin-top:4px;">${escapeHtml(m.content)}</div>
        </div>`,
    )
    .join('')

  const projectTypeLabel =
    f.projectType === 'other' && f.projectTypeFreeText
      ? `Otro: ${escapeHtml(f.projectTypeFreeText)}`
      : projectLabel[f.projectType] || f.projectType

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8" />
<style>
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #222; max-width: 720px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: #888; margin: 24px 0 8px; border-bottom: 1px solid #eee; padding-bottom: 4px; }
  .field { margin: 8px 0; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #999; }
  .value { font-size: 15px; line-height: 1.5; }
  .pill { display: inline-block; background: #f5e8df; color: #d97452; padding: 2px 10px; border-radius: 999px; font-size: 12px; margin: 0 4px 4px 0; }
  .meta { background: #fafafa; padding: 12px; border-radius: 8px; font-size: 12px; color: #666; margin-top: 24px; }
</style></head><body>
  <h1>Nuevo brief de Avoqado Labs</h1>
  <p style="color:#666;font-size:14px;margin:0 0 16px;">
    Sesión <code>${escapeHtml(payload.sessionId)}</code> · ${projectLabel[f.projectType] || f.projectType} · Urgencia: ${urgencyLabel[f.urgency] || f.urgency}
  </p>
  <h2>Contacto</h2>
  <div class="field"><div class="label">Nombre</div><div class="value">${escapeHtml(f.contact.name)}</div></div>
  ${f.contact.email ? `<div class="field"><div class="label">Email</div><div class="value"><a href="mailto:${escapeHtml(f.contact.email)}">${escapeHtml(f.contact.email)}</a></div></div>` : ''}
  ${f.contact.whatsapp ? `<div class="field"><div class="label">WhatsApp</div><div class="value">${escapeHtml(f.contact.whatsapp)}</div></div>` : ''}
  <h2>Proyecto</h2>
  <div class="field"><div class="label">Tipo</div><div class="value">${projectTypeLabel}</div></div>
  <div class="field"><div class="label">Contexto del negocio</div><div class="value">${escapeHtml(f.businessContext)}</div></div>
  <div class="field"><div class="label">Funcionalidad principal</div><div class="value">${escapeHtml(f.coreFunctionality)}</div></div>
  <div class="field"><div class="label">Integraciones</div><div class="value">
    ${f.integrations.length === 0 ? 'ninguna' : f.integrations.map(i => `<span class="pill">${escapeHtml(i)}</span>`).join('')}
  </div></div>
  <div class="field"><div class="label">Referencia de diseño</div><div class="value">${escapeHtml(f.designReference)}</div></div>
  <div class="field"><div class="label">Urgencia</div><div class="value">${urgencyLabel[f.urgency] || f.urgency}</div></div>
  ${payload.additionalNotes ? `<h2>Notas adicionales del cliente</h2><div class="value" style="white-space:pre-wrap;">${escapeHtml(payload.additionalNotes)}</div>` : ''}
  <h2>Transcripción</h2>
  ${transcriptHtml}
  <div class="meta">Enviado desde avoqado.io/labs · ${new Date().toISOString()}</div>
</body></html>`
}

export async function submitLabsBrief(req: Request, res: Response, next: NextFunction) {
  try {
    const payload = req.body
    if (!validateLabsPayload(payload)) {
      throw new BadRequestError('Faltan campos requeridos o son inválidos')
    }

    const html = renderLabsBriefHtml(payload)
    const subject = `[Labs] ${payload.fields.projectType} — ${payload.fields.contact.name} (${payload.fields.urgency})`

    // Internal notification with full brief as JSON attachment for archival
    const internalSent = await emailService.sendEmail({
      to: LABS_NOTIFY_EMAIL,
      subject,
      html,
      attachments: [
        {
          filename: `brief-${payload.sessionId}.json`,
          content: JSON.stringify(payload, null, 2),
          contentType: 'application/json',
        },
      ],
    })

    if (!internalSent) {
      // Always log the brief so we can recover the lead manually if email fails
      logger.error('[LABS_SUBMIT_FAILED]', {
        sessionId: payload.sessionId,
        contact: payload.fields.contact,
        projectType: payload.fields.projectType,
        coreFunctionality: payload.fields.coreFunctionality,
      })
      return res.status(502).json({
        success: false,
        message: 'El correo no se pudo enviar. Tu brief quedó registrado; Avoqado lo recupera manualmente.',
      })
    }

    // Confirmation to the lead — non-blocking quality.
    // Only sent if the lead provided an email. Whatsapp-only leads will be
    // contacted by Avoqado directly (no automated outbound on WA from this flow).
    if (payload.fields.contact.email) {
      const confirmSent = await emailService.sendEmail({
        to: payload.fields.contact.email,
        subject: 'Recibimos tu brief — Avoqado Labs',
        html: `
          <h2>Hola ${escapeHtml(payload.fields.contact.name)},</h2>
          <p>Recibimos tu brief para Avoqado Labs. Lo revisamos personalmente y te confirmamos timeline y costo en menos de 24 horas.</p>
          <p>Mientras tanto, si quieres agregar algo, responde a este correo.</p>
          <p style="color:#888;font-size:13px;">— El equipo de Avoqado Labs</p>
        `,
      })

      if (!confirmSent) {
        logger.warn('[LABS_SUBMIT] Confirmation email failed (brief delivered)', {
          sessionId: payload.sessionId,
          email: payload.fields.contact.email,
        })
      }
    }

    return res.status(200).json({ success: true, message: 'Brief enviado' })
  } catch (err) {
    return next(err)
  }
}
