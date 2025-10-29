import nodemailer from 'nodemailer'
import logger from '../config/logger'

interface EmailOptions {
  to: string
  subject: string
  html?: string
  text?: string
}

interface InvitationEmailData {
  inviterName: string
  organizationName: string
  venueName: string
  role: string
  inviteLink: string
}

interface ReceiptEmailData {
  venueName: string
  receiptUrl: string
  orderNumber?: string
  totalAmount?: string
  venueLogoUrl?: string
}

interface TrialEndingEmailData {
  venueName: string
  featureName: string
  trialEndDate: Date
  billingPortalUrl: string
}

interface PaymentFailedEmailData {
  venueName: string
  featureName: string
  attemptCount: number
  amountDue: number
  currency: string
  billingPortalUrl: string
  last4?: string // Last 4 digits of card
}

interface SubscriptionSuspendedEmailData {
  venueName: string
  featureName: string
  suspendedAt: Date
  gracePeriodEndsAt: Date
  billingPortalUrl: string
}

interface SubscriptionCanceledEmailData {
  venueName: string
  featureName: string
  canceledAt: Date
  suspendedAt: Date
}

interface EmailVerificationData {
  firstName: string
  verificationCode: string
}

class EmailService {
  private transporter: nodemailer.Transporter | null = null

  constructor() {
    this.initializeTransporter()
  }

  private initializeTransporter() {
    const smtpHost = process.env.SMTP_HOST
    const smtpPort = process.env.SMTP_PORT
    const smtpUser = process.env.SMTP_USER
    const smtpPass = process.env.SMTP_PASS

    if (!smtpHost || !smtpPort || !smtpUser || !smtpPass) {
      logger.warn('Email service not configured. Email functionality will be disabled.')
      return
    }

    try {
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(smtpPort),
        secure: parseInt(smtpPort) === 465, // true for 465, false for other ports
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      })

      logger.info('Email service initialized successfully')
    } catch (error) {
      logger.error('Failed to initialize email service:', error)
    }
  }

  async sendEmail(options: EmailOptions): Promise<boolean> {
    if (!this.transporter) {
      logger.warn('Email service not available. Skipping email send.')
      return false
    }

    try {
      const info = await this.transporter.sendMail({
        from: process.env.SMTP_USER,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      })

      logger.info('Email sent successfully:', { messageId: info.messageId, to: options.to })
      return true
    } catch (error) {
      logger.error('Failed to send email:', error)
      return false
    }
  }

  async sendReceiptEmail(email: string, data: ReceiptEmailData): Promise<boolean> {
    const subject = `Tu recibo digital de ${data.venueName} - Avoqado`

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Recibo Digital - ${data.venueName}</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background: white; border-radius: 15px; box-shadow: 0 8px 25px rgba(0,0,0,0.1); overflow: hidden;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
              ${data.venueLogoUrl ? `<img src="${data.venueLogoUrl}" alt="${data.venueName}" style="max-height: 60px; margin-bottom: 20px; background: white; padding: 10px; border-radius: 8px;">` : ''}
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: bold;">¡Tu recibo digital está listo!</h1>
              <p style="color: #e8f4f8; margin: 10px 0 0 0; font-size: 16px;">${data.venueName}</p>
            </div>
            
            <div style="padding: 40px 30px;">
              <p style="font-size: 18px; margin-bottom: 20px; color: #333;">Hola,</p>
              
              <p style="font-size: 16px; margin-bottom: 25px; color: #555;">
                Gracias por tu visita a <strong>${data.venueName}</strong>. Tu recibo digital está disponible y puedes acceder a él en cualquier momento.
              </p>
              
              ${data.orderNumber ? `<p style="font-size: 14px; color: #666; margin-bottom: 20px;">Orden: <strong>#${data.orderNumber}</strong></p>` : ''}
              ${data.totalAmount ? `<p style="font-size: 14px; color: #666; margin-bottom: 30px;">Total: <strong>${data.totalAmount}</strong></p>` : ''}
              
              <div style="background: #f8f9ff; border: 1px solid #e1e5f2; border-radius: 10px; padding: 25px; margin: 30px 0; text-align: center;">
                <p style="font-size: 16px; margin-bottom: 20px; color: #555;">Accede a tu recibo digital:</p>
                <a href="${data.receiptUrl}" 
                   style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                          color: white; 
                          padding: 15px 35px; 
                          text-decoration: none; 
                          border-radius: 25px; 
                          font-weight: bold; 
                          font-size: 16px;
                          display: inline-block;
                          box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
                          transition: all 0.3s ease;">
                  📱 Ver Recibo Digital
                </a>
              </div>
              
              <div style="background: #f9f9f9; border-left: 4px solid #667eea; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 14px; margin: 0; color: #666;">
                  💡 <strong>Tip:</strong> Guarda este enlace para acceder a tu recibo cuando lo necesites. También puedes imprimirlo o descargarlo como PDF desde la página del recibo.
                </p>
              </div>
              
              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">
              
              <p style="font-size: 14px; color: #666; text-align: center; margin-bottom: 10px;">
                ¡Gracias por elegirnos! Esperamos verte pronto.
              </p>
              <p style="font-size: 12px; color: #999; text-align: center; margin: 0;">
                Este correo fue enviado automáticamente por Avoqado.
              </p>
            </div>
          </div>
        </body>
      </html>
    `

    const text = `
      Hola,
      
      Gracias por tu visita a ${data.venueName}. Tu recibo digital está disponible en el siguiente enlace:
      
      ${data.receiptUrl}
      
      ${data.orderNumber ? `Orden: #${data.orderNumber}` : ''}
      ${data.totalAmount ? `Total: ${data.totalAmount}` : ''}
      
      Puedes acceder a tu recibo, imprimirlo o descargarlo como PDF desde el enlace anterior.
      
      ¡Gracias por elegirnos!
      
      Equipo de Avoqado
    `

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  async sendTeamInvitation(email: string, data: InvitationEmailData): Promise<boolean> {
    const subject = `Invitación para unirte al equipo de ${data.venueName}`

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Invitación al equipo</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">¡Te han invitado!</h1>
          </div>
          
          <div style="background: white; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
            <p style="font-size: 18px; margin-bottom: 20px;">Hola,</p>
            
            <p style="font-size: 16px; margin-bottom: 20px;">
              <strong>${data.inviterName}</strong> te ha invitado a unirte al equipo de 
              <strong>${data.venueName}</strong> como <strong>${data.role}</strong>.
            </p>
            
            <p style="font-size: 16px; margin-bottom: 30px;">
              Esto te dará acceso al panel de administración de ${data.organizationName} donde podrás:
            </p>
            
            <ul style="font-size: 14px; margin-bottom: 30px; padding-left: 20px;">
              <li>Gestionar órdenes y pagos</li>
              <li>Ver reportes y estadísticas</li>
              <li>Administrar el menú y productos</li>
              <li>Supervisar las operaciones del restaurante</li>
            </ul>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${data.inviteLink}" 
                 style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                        color: white; 
                        padding: 15px 30px; 
                        text-decoration: none; 
                        border-radius: 25px; 
                        font-weight: bold; 
                        font-size: 16px;
                        display: inline-block;
                        box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);">
                Aceptar Invitación
              </a>
            </div>
            
            <p style="font-size: 14px; color: #666; margin-top: 30px;">
              Esta invitación expirará en 7 días. Si tienes alguna pregunta, contacta con ${data.inviterName}.
            </p>
            
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">
            
            <p style="font-size: 12px; color: #999; text-align: center;">
              Este correo fue enviado por Avoqado. Si no esperabas recibir esta invitación, puedes ignorar este mensaje.
            </p>
          </div>
        </body>
      </html>
    `

    const text = `
      Hola,
      
      ${data.inviterName} te ha invitado a unirte al equipo de ${data.venueName} como ${data.role}.
      
      Para aceptar la invitación, visita: ${data.inviteLink}
      
      Esta invitación expirará en 7 días.
      
      Saludos,
      Equipo de Avoqado
    `

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  async sendTrialEndingEmail(email: string, data: TrialEndingEmailData): Promise<boolean> {
    const subject = `⏰ Tu prueba gratuita de ${data.featureName} está por terminar - ${data.venueName}`
    const trialEndDateFormatted = data.trialEndDate.toLocaleDateString('es-MX', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Tu prueba gratuita está por terminar</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background: white; border-radius: 15px; box-shadow: 0 8px 25px rgba(0,0,0,0.1); overflow: hidden;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: bold;">⏰ Tu prueba gratuita está por terminar</h1>
              <p style="color: #e8f4f8; margin: 10px 0 0 0; font-size: 16px;">${data.venueName}</p>
            </div>

            <div style="padding: 40px 30px;">
              <p style="font-size: 18px; margin-bottom: 20px; color: #333;">Hola,</p>

              <p style="font-size: 16px; margin-bottom: 25px; color: #555;">
                Te escribimos para recordarte que tu <strong>prueba gratuita de ${data.featureName}</strong> está por terminar el <strong>${trialEndDateFormatted}</strong>.
              </p>

              <div style="background: #fff8e1; border-left: 4px solid #ffc107; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  ⚠️ <strong>Importante:</strong> Después de esta fecha, la función será desactivada automáticamente si no actualizas tu método de pago.
                </p>
                <p style="font-size: 14px; margin: 0; color: #666;">
                  Para continuar usando ${data.featureName} sin interrupciones, actualiza tu método de pago ahora.
                </p>
              </div>

              <div style="background: #f8f9ff; border: 1px solid #e1e5f2; border-radius: 10px; padding: 25px; margin: 30px 0; text-align: center;">
                <p style="font-size: 16px; margin-bottom: 20px; color: #555;">Actualiza tu método de pago:</p>
                <a href="${data.billingPortalUrl}"
                   style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                          color: white;
                          padding: 15px 35px;
                          text-decoration: none;
                          border-radius: 25px;
                          font-weight: bold;
                          font-size: 16px;
                          display: inline-block;
                          box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
                          transition: all 0.3s ease;">
                  💳 Ir a Facturación
                </a>
              </div>

              <div style="background: #f9f9f9; border-left: 4px solid #667eea; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  💡 <strong>¿Por qué ${data.featureName}?</strong>
                </p>
                <p style="font-size: 14px; margin: 0; color: #666;">
                  Esta función te ayuda a gestionar mejor tu restaurante y mejorar la experiencia de tus clientes. No pierdas acceso a todas estas ventajas.
                </p>
              </div>

              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">

              <p style="font-size: 14px; color: #666; text-align: center; margin-bottom: 10px;">
                ¿Necesitas ayuda? Contáctanos en cualquier momento.
              </p>
              <p style="font-size: 12px; color: #999; text-align: center; margin: 0;">
                Este correo fue enviado automáticamente por Avoqado.
              </p>
            </div>
          </div>
        </body>
      </html>
    `

    const text = `
      Hola,

      Tu prueba gratuita de ${data.featureName} está por terminar el ${trialEndDateFormatted}.

      ⚠️ IMPORTANTE: Después de esta fecha, la función será desactivada automáticamente si no actualizas tu método de pago.

      Para continuar usando ${data.featureName} sin interrupciones, actualiza tu método de pago ahora:

      ${data.billingPortalUrl}

      ¿Por qué ${data.featureName}?
      Esta función te ayuda a gestionar mejor tu restaurante y mejorar la experiencia de tus clientes.

      ¿Necesitas ayuda? Contáctanos en cualquier momento.

      Equipo de Avoqado
    `

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  async sendPaymentFailedEmail(email: string, data: PaymentFailedEmailData): Promise<boolean> {
    const subject = `🚨 Problema con el pago de ${data.featureName} - ${data.venueName}`
    const amountFormatted = new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: data.currency.toUpperCase(),
    }).format(data.amountDue / 100) // Convert cents to currency

    // Customize message based on attempt count
    let urgencyLevel = ''
    let urgencyColor = '#ffc107'
    let nextSteps = ''

    if (data.attemptCount === 1) {
      urgencyLevel = 'Intento 1 de 3'
      urgencyColor = '#ffc107'
      nextSteps = 'Stripe intentará cobrar nuevamente en los próximos días. Por favor, actualiza tu método de pago lo antes posible.'
    } else if (data.attemptCount === 2) {
      urgencyLevel = 'Intento 2 de 3 - Acción Requerida'
      urgencyColor = '#ff9800'
      nextSteps = 'Este es el segundo intento fallido. Si el próximo intento también falla, tu suscripción será cancelada automáticamente.'
    } else {
      urgencyLevel = 'ÚLTIMO INTENTO - Acción Urgente'
      urgencyColor = '#f44336'
      nextSteps =
        'Este es el último intento. Si no actualizas tu método de pago inmediatamente, tu suscripción será cancelada y perderás acceso a esta función.'
    }

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Problema con el pago</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background: white; border-radius: 15px; box-shadow: 0 8px 25px rgba(0,0,0,0.1); overflow: hidden;">
            <div style="background: linear-gradient(135deg, #f44336 0%, #e91e63 100%); padding: 40px 30px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: bold;">🚨 Problema con el pago</h1>
              <p style="color: #ffebee; margin: 10px 0 0 0; font-size: 16px;">${data.venueName}</p>
            </div>

            <div style="padding: 40px 30px;">
              <p style="font-size: 18px; margin-bottom: 20px; color: #333;">Hola,</p>

              <p style="font-size: 16px; margin-bottom: 25px; color: #555;">
                No pudimos procesar el pago de <strong>${amountFormatted}</strong> para tu suscripción de <strong>${data.featureName}</strong>.
              </p>

              <div style="background: #ffebee; border-left: 4px solid ${urgencyColor}; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  ⚠️ <strong>${urgencyLevel}</strong>
                </p>
                ${
                  data.last4
                    ? `<p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  💳 Tarjeta terminada en <strong>${data.last4}</strong>
                </p>`
                    : ''
                }
                <p style="font-size: 14px; margin: 0; color: #666;">
                  ${nextSteps}
                </p>
              </div>

              <div style="background: #f8f9ff; border: 1px solid #e1e5f2; border-radius: 10px; padding: 25px; margin: 30px 0; text-align: center;">
                <p style="font-size: 16px; margin-bottom: 20px; color: #555;">Actualiza tu método de pago ahora:</p>
                <a href="${data.billingPortalUrl}"
                   style="background: linear-gradient(135deg, #f44336 0%, #e91e63 100%);
                          color: white;
                          padding: 15px 35px;
                          text-decoration: none;
                          border-radius: 25px;
                          font-weight: bold;
                          font-size: 16px;
                          display: inline-block;
                          box-shadow: 0 4px 15px rgba(244, 67, 54, 0.3);
                          transition: all 0.3s ease;">
                  💳 Actualizar Método de Pago
                </a>
              </div>

              <div style="background: #f9f9f9; border-left: 4px solid #2196f3; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  💡 <strong>Razones comunes de rechazo:</strong>
                </p>
                <ul style="font-size: 14px; margin: 10px 0 0 20px; color: #666; padding: 0;">
                  <li>Fondos insuficientes en la tarjeta</li>
                  <li>Tarjeta vencida o cerca de vencer</li>
                  <li>Límite de crédito alcanzado</li>
                  <li>Bloqueo temporal del banco</li>
                </ul>
              </div>

              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">

              <p style="font-size: 14px; color: #666; text-align: center; margin-bottom: 10px;">
                ¿Necesitas ayuda? Contáctanos en cualquier momento o verifica con tu banco.
              </p>
              <p style="font-size: 12px; color: #999; text-align: center; margin: 0;">
                Este correo fue enviado automáticamente por Avoqado.
              </p>
            </div>
          </div>
        </body>
      </html>
    `

    const text = `
      Hola,

      No pudimos procesar el pago de ${amountFormatted} para tu suscripción de ${data.featureName}.

      ⚠️ ${urgencyLevel}
      ${data.last4 ? `💳 Tarjeta terminada en ${data.last4}` : ''}

      ${nextSteps}

      Actualiza tu método de pago ahora:
      ${data.billingPortalUrl}

      Razones comunes de rechazo:
      - Fondos insuficientes en la tarjeta
      - Tarjeta vencida o cerca de vencer
      - Límite de crédito alcanzado
      - Bloqueo temporal del banco

      ¿Necesitas ayuda? Contáctanos en cualquier momento o verifica con tu banco.

      Equipo de Avoqado
    `

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  async sendSubscriptionSuspendedEmail(email: string, data: SubscriptionSuspendedEmailData): Promise<boolean> {
    const subject = `⛔ Tu suscripción de ${data.featureName} ha sido suspendida - ${data.venueName}`
    const suspendedDateFormatted = data.suspendedAt.toLocaleDateString('es-MX', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    const cancellationDateFormatted = data.gracePeriodEndsAt.toLocaleDateString('es-MX', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Suscripción suspendida</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background: white; border-radius: 15px; box-shadow: 0 8px 25px rgba(0,0,0,0.1); overflow: hidden;">
            <div style="background: linear-gradient(135deg, #f44336 0%, #e91e63 100%); padding: 40px 30px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: bold;">⛔ Suscripción Suspendida</h1>
              <p style="color: #ffebee; margin: 10px 0 0 0; font-size: 16px;">${data.venueName}</p>
            </div>

            <div style="padding: 40px 30px;">
              <p style="font-size: 18px; margin-bottom: 20px; color: #333;">Hola,</p>

              <p style="font-size: 16px; margin-bottom: 25px; color: #555;">
                Tu suscripción de <strong>${data.featureName}</strong> ha sido <strong>suspendida</strong> debido a múltiples intentos de pago fallidos.
              </p>

              <div style="background: #ffebee; border-left: 4px solid #f44336; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  🚨 <strong>Estado actual:</strong> Acceso bloqueado desde ${suspendedDateFormatted}
                </p>
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  ⚠️ <strong>Fecha de cancelación definitiva:</strong> ${cancellationDateFormatted}
                </p>
                <p style="font-size: 14px; margin: 0; color: #666;">
                  Si no actualizas tu método de pago antes de esta fecha, tu suscripción será <strong>cancelada permanentemente</strong>.
                </p>
              </div>

              <div style="background: #fff3e0; border-left: 4px solid #ff9800; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  💡 <strong>¿Qué significa esto?</strong>
                </p>
                <ul style="font-size: 14px; margin: 10px 0 0 20px; color: #666; padding: 0;">
                  <li>Tu acceso a ${data.featureName} está actualmente bloqueado</li>
                  <li>Tus datos permanecen seguros y guardados</li>
                  <li>Puedes reactivar tu suscripción actualizando tu método de pago</li>
                  <li>Después del ${cancellationDateFormatted}, la suscripción será cancelada</li>
                </ul>
              </div>

              <div style="background: #f8f9ff; border: 1px solid #e1e5f2; border-radius: 10px; padding: 25px; margin: 30px 0; text-align: center;">
                <p style="font-size: 16px; margin-bottom: 20px; color: #555;">Reactiva tu suscripción ahora:</p>
                <a href="${data.billingPortalUrl}"
                   style="background: linear-gradient(135deg, #4caf50 0%, #66bb6a 100%);
                          color: white;
                          padding: 15px 35px;
                          text-decoration: none;
                          border-radius: 25px;
                          font-weight: bold;
                          font-size: 16px;
                          display: inline-block;
                          box-shadow: 0 4px 15px rgba(76, 175, 80, 0.3);
                          transition: all 0.3s ease;">
                  🔄 Actualizar Método de Pago
                </a>
              </div>

              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">

              <p style="font-size: 14px; color: #666; text-align: center; margin-bottom: 10px;">
                ¿Necesitas ayuda? Contáctanos en cualquier momento.
              </p>
              <p style="font-size: 12px; color: #999; text-align: center; margin: 0;">
                Este correo fue enviado automáticamente por Avoqado.
              </p>
            </div>
          </div>
        </body>
      </html>
    `

    const text = `
      Hola,

      Tu suscripción de ${data.featureName} ha sido SUSPENDIDA debido a múltiples intentos de pago fallidos.

      🚨 Estado actual: Acceso bloqueado desde ${suspendedDateFormatted}
      ⚠️ Fecha de cancelación definitiva: ${cancellationDateFormatted}

      ¿Qué significa esto?
      - Tu acceso a ${data.featureName} está actualmente bloqueado
      - Tus datos permanecen seguros y guardados
      - Puedes reactivar tu suscripción actualizando tu método de pago
      - Después del ${cancellationDateFormatted}, la suscripción será cancelada

      Reactiva tu suscripción ahora:
      ${data.billingPortalUrl}

      ¿Necesitas ayuda? Contáctanos en cualquier momento.

      Equipo de Avoqado
    `

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  async sendSubscriptionCanceledEmail(email: string, data: SubscriptionCanceledEmailData): Promise<boolean> {
    const subject = `❌ Tu suscripción de ${data.featureName} ha sido cancelada - ${data.venueName}`
    const canceledDateFormatted = data.canceledAt.toLocaleDateString('es-MX', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    const suspendedDateFormatted = data.suspendedAt.toLocaleDateString('es-MX', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Suscripción cancelada</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background: white; border-radius: 15px; box-shadow: 0 8px 25px rgba(0,0,0,0.1); overflow: hidden;">
            <div style="background: linear-gradient(135deg, #424242 0%, #616161 100%); padding: 40px 30px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: bold;">❌ Suscripción Cancelada</h1>
              <p style="color: #e0e0e0; margin: 10px 0 0 0; font-size: 16px;">${data.venueName}</p>
            </div>

            <div style="padding: 40px 30px;">
              <p style="font-size: 18px; margin-bottom: 20px; color: #333;">Hola,</p>

              <p style="font-size: 16px; margin-bottom: 25px; color: #555;">
                Tu suscripción de <strong>${data.featureName}</strong> ha sido <strong>cancelada permanentemente</strong> el ${canceledDateFormatted} debido a problemas de pago no resueltos.
              </p>

              <div style="background: #f5f5f5; border-left: 4px solid #9e9e9e; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  📅 <strong>Fecha de suspensión:</strong> ${suspendedDateFormatted}
                </p>
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  ❌ <strong>Fecha de cancelación:</strong> ${canceledDateFormatted}
                </p>
                <p style="font-size: 14px; margin: 0; color: #666;">
                  Tu acceso a ${data.featureName} ha sido completamente desactivado.
                </p>
              </div>

              <div style="background: #e3f2fd; border-left: 4px solid #2196f3; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  💡 <strong>¿Quieres volver a activar ${data.featureName}?</strong>
                </p>
                <p style="font-size: 14px; margin: 0; color: #666;">
                  Puedes reactivar tu suscripción en cualquier momento. Tus datos previos permanecen seguros y podrás recuperar el acceso inmediatamente después de configurar tu método de pago.
                </p>
              </div>

              <div style="background: #f8f9ff; border: 1px solid #e1e5f2; border-radius: 10px; padding: 25px; margin: 30px 0; text-align: center;">
                <p style="font-size: 16px; margin-bottom: 20px; color: #555;">¿Listo para volver?</p>
                <p style="font-size: 14px; margin-bottom: 20px; color: #666;">
                  Contáctanos y te ayudaremos a reactivar tu suscripción.
                </p>
              </div>

              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">

              <p style="font-size: 14px; color: #666; text-align: center; margin-bottom: 10px;">
                Lamentamos verte partir. Si necesitas ayuda o tienes preguntas, estamos aquí para ti.
              </p>
              <p style="font-size: 12px; color: #999; text-align: center; margin: 0;">
                Este correo fue enviado automáticamente por Avoqado.
              </p>
            </div>
          </div>
        </body>
      </html>
    `

    const text = `
      Hola,

      Tu suscripción de ${data.featureName} ha sido CANCELADA PERMANENTEMENTE el ${canceledDateFormatted} debido a problemas de pago no resueltos.

      📅 Fecha de suspensión: ${suspendedDateFormatted}
      ❌ Fecha de cancelación: ${canceledDateFormatted}

      Tu acceso a ${data.featureName} ha sido completamente desactivado.

      ¿Quieres volver a activar ${data.featureName}?
      Puedes reactivar tu suscripción en cualquier momento. Tus datos previos permanecen seguros y podrás recuperar el acceso inmediatamente después de configurar tu método de pago.

      Contáctanos si necesitas ayuda.

      Lamentamos verte partir. Si necesitas ayuda o tienes preguntas, estamos aquí para ti.

      Equipo de Avoqado
    `

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  async sendEmailVerification(email: string, data: EmailVerificationData): Promise<boolean> {
    const subject = `Código de verificación - Avoqado`

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Código de verificación</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background: white; border-radius: 15px; box-shadow: 0 8px 25px rgba(0,0,0,0.1); overflow: hidden;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: bold;">✉️ Verifica tu correo</h1>
            </div>

            <div style="padding: 40px 30px;">
              <p style="font-size: 18px; margin-bottom: 20px; color: #333;">Hola ${data.firstName},</p>

              <p style="font-size: 16px; margin-bottom: 25px; color: #555;">
                Gracias por registrarte en Avoqado. Para continuar, por favor verifica tu correo electrónico usando el siguiente código:
              </p>

              <div style="background: #f8f9ff; border: 2px solid #667eea; border-radius: 10px; padding: 30px; margin: 30px 0; text-align: center;">
                <p style="font-size: 14px; margin-bottom: 15px; color: #666; text-transform: uppercase; letter-spacing: 1px;">Tu código de verificación</p>
                <div style="font-size: 48px; font-weight: bold; color: #667eea; letter-spacing: 8px; font-family: 'Courier New', monospace;">
                  ${data.verificationCode}
                </div>
              </div>

              <div style="background: #fff8e1; border-left: 4px solid #ffc107; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  ⏱️ <strong>Este código expirará en 10 minutos</strong>
                </p>
                <p style="font-size: 14px; margin: 0; color: #666;">
                  Si no solicitaste este código, puedes ignorar este correo.
                </p>
              </div>

              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">

              <p style="font-size: 14px; color: #666; text-align: center; margin-bottom: 10px;">
                ¿Necesitas ayuda? Contáctanos en cualquier momento.
              </p>
              <p style="font-size: 12px; color: #999; text-align: center; margin: 0;">
                Este correo fue enviado automáticamente por Avoqado.
              </p>
            </div>
          </div>
        </body>
      </html>
    `

    const text = `
      Hola ${data.firstName},

      Gracias por registrarte en Avoqado. Para continuar, por favor verifica tu correo electrónico usando el siguiente código:

      Código de verificación: ${data.verificationCode}

      ⏱️ Este código expirará en 10 minutos.

      Si no solicitaste este código, puedes ignorar este correo.

      ¿Necesitas ayuda? Contáctanos en cualquier momento.

      Equipo de Avoqado
    `

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) {
      return false
    }

    try {
      await this.transporter.verify()
      logger.info('Email service connection verified')
      return true
    } catch (error) {
      logger.error('Email service connection failed:', error)
      return false
    }
  }
}

export default new EmailService()
