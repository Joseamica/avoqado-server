/**
 * Resend Email Service
 *
 * Handles sending emails via Resend API with professional HTML templates
 *
 * SETUP INSTRUCTIONS:
 * ===================
 *
 * 1. Create a Resend account at https://resend.com
 *
 * 2. Verify your domain (avoqado.io):
 *    - Go to Resend Dashboard → Domains
 *    - Add domain: avoqado.io
 *    - Add the DNS records they provide to your domain registrar:
 *      • TXT record for domain verification
 *      • CNAME records for SPF/DKIM
 *    - Wait for verification (usually takes a few minutes)
 *
 * 3. Get your API key:
 *    - Go to Resend Dashboard → API Keys
 *    - Create new API key
 *    - Copy the key (starts with "re_")
 *
 * 4. Add to .env file:
 *    RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxx
 *    EMAIL_FROM=Avoqado <noreply@avoqado.io>
 *    FRONTEND_URL=https://dashboard.avoqado.io
 *
 * 5. Test email sending:
 *    - Restart the server
 *    - Complete onboarding with KYC documents
 *    - Check hola@avoqado.io for notification email
 *
 * NOTES:
 * - After domain verification, you can send FROM any email @avoqado.io
 * - noreply@avoqado.io doesn't need to be a real mailbox (send-only)
 * - hola@avoqado.io MUST be a real mailbox to receive notifications
 * - Free tier: 3,000 emails/month, then $20/month for 50k emails
 */

import { Resend } from 'resend'
import logger from '../config/logger'

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY)

// Email configuration
const FROM_EMAIL = process.env.EMAIL_FROM || 'Avoqado <noreply@avoqado.io>'
const ADMIN_EMAIL = 'hola@avoqado.io' // Central admin email for KYC notifications

interface KycNotificationData {
  venueName: string
  venueId: string
  actionUrl: string
  dashboardBaseUrl?: string
  recipients: string[] // Array of email addresses (superadmins + owner)
}

/**
 * Send KYC submission notification to admin team
 * Now sends to multiple recipients: all SUPERADMINs + venue OWNER
 */
export async function sendKycSubmissionNotification(data: KycNotificationData): Promise<boolean> {
  try {
    const dashboardUrl = data.dashboardBaseUrl || process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'
    const fullActionUrl = `${dashboardUrl}${data.actionUrl}`

    // Validate recipients
    if (!data.recipients || data.recipients.length === 0) {
      logger.warn('No recipients provided for KYC notification. Falling back to admin email.')
      data.recipients = [ADMIN_EMAIL]
    }

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Nueva solicitud KYC - ${data.venueName}</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background: white; border-radius: 15px; box-shadow: 0 8px 25px rgba(0,0,0,0.1); overflow: hidden;">
            <!-- Header -->
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: bold;">🆕 Nueva Solicitud KYC</h1>
              <p style="color: #e8f4f8; margin: 10px 0 0 0; font-size: 16px;">Requiere revisión de Superadmin</p>
            </div>

            <!-- Content -->
            <div style="padding: 40px 30px;">
              <p style="font-size: 18px; margin-bottom: 20px; color: #333;">Hola equipo Avoqado,</p>

              <p style="font-size: 16px; margin-bottom: 25px; color: #555;">
                <strong>${data.venueName}</strong> ha completado el onboarding y ha enviado sus documentos KYC para revisión.
              </p>

              <!-- Venue Info Box -->
              <div style="background: #f8f9ff; border-left: 4px solid #667eea; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  🏢 <strong>Venue:</strong> ${data.venueName}
                </p>
                <p style="font-size: 14px; margin: 0; color: #666;">
                  🆔 <strong>ID:</strong> <code style="background: #e0e0e0; padding: 2px 6px; border-radius: 3px; font-family: monospace;">${data.venueId}</code>
                </p>
              </div>

              <!-- Action Required -->
              <div style="background: #fff8e1; border-left: 4px solid #ffc107; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  ⚠️ <strong>Acción requerida:</strong>
                </p>
                <ul style="font-size: 14px; margin: 10px 0 0 20px; color: #666; padding: 0;">
                  <li>Revisar documentos KYC subidos</li>
                  <li>Verificar información CLABE bancaria</li>
                  <li>Asignar procesador de pagos</li>
                  <li>Aprobar o rechazar la solicitud</li>
                </ul>
              </div>

              <!-- CTA Button -->
              <div style="text-align: center; margin: 40px 0;">
                <a href="${fullActionUrl}"
                   style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                          color: white;
                          padding: 16px 40px;
                          text-decoration: none;
                          border-radius: 30px;
                          font-weight: bold;
                          font-size: 16px;
                          display: inline-block;
                          box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
                          transition: all 0.3s ease;">
                  🔍 Revisar Solicitud KYC
                </a>
              </div>

              <!-- Info Note -->
              <div style="background: #f0f0f0; padding: 20px; margin: 30px 0; border-radius: 8px;">
                <p style="font-size: 13px; margin: 0; color: #666; text-align: center;">
                  💡 Este venue quedará en estado <strong>PENDING_REVIEW</strong> hasta que completes la revisión
                </p>
              </div>

              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">

              <!-- Footer -->
              <p style="font-size: 14px; color: #666; text-align: center; margin-bottom: 10px;">
                Notificación automática de Avoqado Platform
              </p>
              <p style="font-size: 12px; color: #999; text-align: center; margin: 0;">
                Venue ID: ${data.venueId}
              </p>
            </div>
          </div>
        </body>
      </html>
    `

    const text = `
Nueva Solicitud KYC - Requiere Revisión

Hola equipo Avoqado,

${data.venueName} ha completado el onboarding y ha enviado sus documentos KYC para revisión.

INFORMACIÓN DEL VENUE:
- Venue: ${data.venueName}
- ID: ${data.venueId}

ACCIÓN REQUERIDA:
- Revisar documentos KYC subidos
- Verificar información CLABE bancaria
- Asignar procesador de pagos
- Aprobar o rechazar la solicitud

Revisar solicitud: ${fullActionUrl}

Este venue quedará en estado PENDING_REVIEW hasta que completes la revisión.

---
Notificación automática de Avoqado Platform
Venue ID: ${data.venueId}
    `

    logger.info(`📧 Sending KYC notification email to ${data.recipients.length} recipients for venue: ${data.venueName}`)
    logger.info(`📧 Recipients: ${data.recipients.join(', ')}`)

    // Send email to all recipients
    const results = await Promise.allSettled(
      data.recipients.map(email =>
        resend.emails.send({
          from: FROM_EMAIL,
          to: email,
          subject: `🆕 Nueva solicitud KYC: ${data.venueName}`,
          html,
          text,
        }),
      ),
    )

    // Check if all emails were sent successfully
    const successCount = results.filter(r => r.status === 'fulfilled' && !(r.value as any).error).length
    const failureCount = results.length - successCount

    if (failureCount > 0) {
      logger.warn(`⚠️ KYC notification: ${successCount} sent, ${failureCount} failed`)
      results.forEach((result, index) => {
        if (result.status === 'rejected' || (result.status === 'fulfilled' && (result.value as any).error)) {
          const email = data.recipients[index]
          const error = result.status === 'rejected' ? result.reason : (result.value as any).error
          logger.error(`Failed to send KYC notification to ${email}:`, error)
        }
      })
    }

    logger.info(`✅ KYC notification email sent to ${successCount}/${results.length} recipients`)
    return successCount > 0 // Return true if at least one email was sent successfully
  } catch (error) {
    logger.error('Error sending KYC notification email:', error)
    return false
  }
}

/**
 * Send generic notification email (used by notification.service.ts)
 */
export async function sendNotificationEmail(
  to: string,
  subject: string,
  title: string,
  message: string,
  actionUrl?: string,
  actionLabel?: string,
): Promise<boolean> {
  try {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${title}</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background: white; border-radius: 15px; box-shadow: 0 8px 25px rgba(0,0,0,0.1); overflow: hidden;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: bold;">${title}</h1>
            </div>

            <div style="padding: 40px 30px;">
              <p style="font-size: 16px; margin-bottom: 25px; color: #555; white-space: pre-line;">
                ${message}
              </p>

              ${
                actionUrl
                  ? `
              <div style="text-align: center; margin: 40px 0;">
                <a href="${actionUrl}"
                   style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                          color: white;
                          padding: 16px 40px;
                          text-decoration: none;
                          border-radius: 30px;
                          font-weight: bold;
                          font-size: 16px;
                          display: inline-block;
                          box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);">
                  ${actionLabel || 'Ver más'}
                </a>
              </div>
              `
                  : ''
              }

              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">

              <p style="font-size: 12px; color: #999; text-align: center; margin: 0;">
                Este correo fue enviado por Avoqado
              </p>
            </div>
          </div>
        </body>
      </html>
    `

    const text = `
${title}

${message}

${actionUrl ? `${actionLabel || 'Ver más'}: ${actionUrl}` : ''}

---
Este correo fue enviado por Avoqado
    `

    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject,
      html,
      text,
    })

    if (result.error) {
      logger.error(`Failed to send notification email to ${to}:`, result.error)
      return false
    }

    logger.info(`✅ Notification email sent successfully to ${to} (ID: ${result.data?.id})`)
    return true
  } catch (error) {
    logger.error(`Error sending notification email to ${to}:`, error)
    return false
  }
}

/**
 * Verify Resend API connection
 */
export async function verifyResendConnection(): Promise<boolean> {
  try {
    if (!process.env.RESEND_API_KEY) {
      logger.warn('RESEND_API_KEY not configured. Email functionality will be disabled.')
      return false
    }

    logger.info('Resend email service initialized successfully')
    return true
  } catch (error) {
    logger.error('Failed to initialize Resend email service:', error)
    return false
  }
}
