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
