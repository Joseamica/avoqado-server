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
  receiptNumber: string // Last 4 chars of accessKey
  orderNumber?: string
  venueLogoUrl?: string
  venueAddress?: string
  venueCity?: string
  venueState?: string
  venuePhone?: string
  venueEmail?: string
  currency?: string
  // Order items
  items?: Array<{
    name: string
    quantity: number
    price: number
    totalPrice: number
    modifiers?: Array<{ name: string; price: number }>
  }>
  // Totals
  subtotal?: number
  taxAmount?: number
  tipAmount?: number
  totalAmount?: number
  // Payment info
  paymentMethod?: string
  paymentDate?: string
  // People
  processedBy?: string
  customerName?: string
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

interface TrialExpiredEmailData {
  venueName: string
  featureName: string
  expiredAt: Date
}

interface EmailVerificationData {
  firstName: string
  verificationCode: string
}

interface PasswordResetData {
  firstName: string
  resetLink: string
  expiresInMinutes: number
}

interface TerminalPurchaseEmailData {
  venueName: string
  contactName: string
  contactEmail: string
  quantity: number
  productName: string
  productPrice: number
  shippingAddress: string
  shippingCity: string
  shippingState: string
  shippingPostalCode: string
  shippingCountry: string
  shippingSpeed: string
  subtotal: number
  shippingCost: number
  tax: number
  totalAmount: number
  currency: string
  orderDate: string
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
      // Format: "Display Name <email>" so recipients see "Avoqado" instead of raw email
      const fromAddress = process.env.EMAIL_FROM_NAME
        ? `${process.env.EMAIL_FROM_NAME} <${process.env.SMTP_USER}>`
        : `Avoqado <${process.env.SMTP_USER}>`

      const info = await this.transporter.sendMail({
        from: fromAddress,
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
    const subject = `Recibo #${data.receiptNumber} - ${data.venueName}`
    const currency = data.currency || 'MXN'

    // Format currency
    const formatCurrency = (amount: number | undefined) => {
      if (amount === undefined) return ''
      return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(amount)
    }

    // Format payment method
    const formatPaymentMethod = (method: string | undefined) => {
      if (!method) return 'N/A'
      const methods: Record<string, string> = {
        CASH: 'Efectivo',
        CARD: 'Tarjeta',
        TRANSFER: 'Transferencia',
        CREDIT_CARD: 'Tarjeta de Crédito',
        DEBIT_CARD: 'Tarjeta de Débito',
      }
      return methods[method] || method
    }

    // Build items HTML
    const itemsHtml =
      data.items && data.items.length > 0
        ? data.items
            .map(
              item => `
          <tr>
            <td style="padding: 12px 0; border-bottom: 1px solid #27272a;">
              <div style="color: #fafafa; font-size: 14px; font-weight: 500;">${item.name}</div>
              ${
                item.modifiers && item.modifiers.length > 0
                  ? `<div style="color: #71717a; font-size: 12px; margin-top: 4px;">${item.modifiers.map(m => `+ ${m.name}`).join(', ')}</div>`
                  : ''
              }
            </td>
            <td style="padding: 12px 0; border-bottom: 1px solid #27272a; text-align: center; color: #a1a1aa; font-size: 14px;">×${item.quantity}</td>
            <td style="padding: 12px 0; border-bottom: 1px solid #27272a; text-align: right; color: #fafafa; font-size: 14px;">${formatCurrency(item.totalPrice)}</td>
          </tr>
        `,
            )
            .join('')
        : ''

    // Build items text for plain text version
    const itemsText =
      data.items && data.items.length > 0
        ? data.items.map(item => `  ${item.name} x${item.quantity} - ${formatCurrency(item.totalPrice)}`).join('\n')
        : ''

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta name="color-scheme" content="dark">
          <title>Recibo #${data.receiptNumber} - ${data.venueName}</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.5; margin: 0; padding: 0; background-color: #0a0a0a;">
          <div style="max-width: 500px; margin: 0 auto; padding: 32px 16px;">

            <!-- Main Card -->
            <div style="background: #18181b; border-radius: 16px; overflow: hidden; border: 1px solid #27272a;">

              <!-- Header with Logo -->
              <div style="padding: 28px 24px 20px 24px; text-align: center; border-bottom: 1px solid #27272a;">
                ${
                  data.venueLogoUrl
                    ? `<img src="${data.venueLogoUrl}" alt="${data.venueName}" style="max-width: 80px; max-height: 80px; width: auto; height: auto; margin-bottom: 12px; border-radius: 8px; object-fit: contain;">`
                    : `<div style="width: 48px; height: 48px; background: #3b82f6; border-radius: 12px; margin: 0 auto 12px auto; line-height: 48px; text-align: center;">
                    <span style="color: white; font-size: 20px; font-weight: bold;">${data.venueName.charAt(0)}</span>
                  </div>`
                }
                <h1 style="color: #fafafa; margin: 0 0 4px 0; font-size: 18px; font-weight: 600;">${data.venueName}</h1>
                ${
                  data.venueAddress || data.venueCity
                    ? `<p style="color: #71717a; margin: 0; font-size: 12px;">${[data.venueAddress, data.venueCity, data.venueState].filter(Boolean).join(', ')}</p>`
                    : ''
                }
              </div>

              <!-- Receipt Info -->
              <div style="padding: 20px 24px; border-bottom: 1px solid #27272a;">
                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style="color: #71717a; font-size: 13px; padding: 4px 0;">Recibo</td>
                    <td style="color: #fafafa; font-size: 13px; padding: 4px 0; text-align: right; font-weight: 500;">#${data.receiptNumber}</td>
                  </tr>
                  ${data.orderNumber ? `<tr><td style="color: #71717a; font-size: 13px; padding: 4px 0;">Orden</td><td style="color: #fafafa; font-size: 13px; padding: 4px 0; text-align: right;">#${data.orderNumber}</td></tr>` : ''}
                  ${data.paymentDate ? `<tr><td style="color: #71717a; font-size: 13px; padding: 4px 0;">Fecha</td><td style="color: #fafafa; font-size: 13px; padding: 4px 0; text-align: right;">${data.paymentDate}</td></tr>` : ''}
                  ${data.processedBy ? `<tr><td style="color: #71717a; font-size: 13px; padding: 4px 0;">Atendido por</td><td style="color: #fafafa; font-size: 13px; padding: 4px 0; text-align: right;">${data.processedBy}</td></tr>` : ''}
                </table>
              </div>

              ${
                itemsHtml
                  ? `
              <!-- Items -->
              <div style="padding: 20px 24px; border-bottom: 1px solid #27272a;">
                <h2 style="color: #a1a1aa; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 12px 0;">Productos</h2>
                <table style="width: 100%; border-collapse: collapse;">
                  ${itemsHtml}
                </table>
              </div>
              `
                  : ''
              }

              <!-- Totals -->
              <div style="padding: 20px 24px; border-bottom: 1px solid #27272a;">
                <table style="width: 100%; border-collapse: collapse;">
                  ${data.subtotal !== undefined ? `<tr><td style="color: #a1a1aa; font-size: 14px; padding: 6px 0;">Subtotal</td><td style="color: #fafafa; font-size: 14px; padding: 6px 0; text-align: right;">${formatCurrency(data.subtotal)}</td></tr>` : ''}
                  ${data.taxAmount !== undefined && data.taxAmount > 0 ? `<tr><td style="color: #a1a1aa; font-size: 14px; padding: 6px 0;">Impuestos</td><td style="color: #fafafa; font-size: 14px; padding: 6px 0; text-align: right;">${formatCurrency(data.taxAmount)}</td></tr>` : ''}
                  ${data.tipAmount !== undefined && data.tipAmount > 0 ? `<tr><td style="color: #a1a1aa; font-size: 14px; padding: 6px 0;">Propina</td><td style="color: #3b82f6; font-size: 14px; padding: 6px 0; text-align: right;">${formatCurrency(data.tipAmount)}</td></tr>` : ''}
                  <tr>
                    <td style="color: #fafafa; font-size: 18px; font-weight: 600; padding: 12px 0 0 0;">Total</td>
                    <td style="color: #22c55e; font-size: 20px; font-weight: 700; padding: 12px 0 0 0; text-align: right;">${formatCurrency(data.totalAmount)}</td>
                  </tr>
                </table>
              </div>

              <!-- Payment Method -->
              <div style="padding: 16px 24px; border-bottom: 1px solid #27272a; background: #1f1f23;">
                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style="color: #71717a; font-size: 13px;">Método de pago</td>
                    <td style="color: #fafafa; font-size: 13px; text-align: right; font-weight: 500;">${formatPaymentMethod(data.paymentMethod)}</td>
                  </tr>
                </table>
              </div>

              <!-- CTA Button -->
              <div style="padding: 24px; text-align: center;">
                <a href="${data.receiptUrl}"
                   style="background: #3b82f6;
                          color: white;
                          padding: 12px 28px;
                          text-decoration: none;
                          border-radius: 8px;
                          font-weight: 600;
                          font-size: 14px;
                          display: inline-block;">
                  Ver Recibo Completo
                </a>
                <p style="color: #52525b; font-size: 11px; margin: 12px 0 0 0;">
                  Descarga o imprime desde el enlace
                </p>
              </div>

              <!-- Footer -->
              <div style="padding: 16px 24px; border-top: 1px solid #27272a; text-align: center; background: #141417;">
                <p style="font-size: 12px; color: #52525b; margin: 0;">
                  Recibo enviado por ${data.venueName} vía Avoqado
                </p>
              </div>
            </div>

          </div>
        </body>
      </html>
    `

    const text = `
RECIBO DIGITAL #${data.receiptNumber}
${data.venueName}
${[data.venueAddress, data.venueCity, data.venueState].filter(Boolean).join(', ')}

${data.orderNumber ? `Orden: #${data.orderNumber}` : ''}
${data.paymentDate ? `Fecha: ${data.paymentDate}` : ''}
${data.processedBy ? `Atendido por: ${data.processedBy}` : ''}

${itemsText ? `PRODUCTOS:\n${itemsText}\n` : ''}
${data.subtotal !== undefined ? `Subtotal: ${formatCurrency(data.subtotal)}` : ''}
${data.taxAmount !== undefined && data.taxAmount > 0 ? `Impuestos: ${formatCurrency(data.taxAmount)}` : ''}
${data.tipAmount !== undefined && data.tipAmount > 0 ? `Propina: ${formatCurrency(data.tipAmount)}` : ''}
TOTAL: ${formatCurrency(data.totalAmount)}

Método de pago: ${formatPaymentMethod(data.paymentMethod)}

Ver recibo completo: ${data.receiptUrl}

¡Gracias por tu preferencia!
Recibo enviado por ${data.venueName} vía Avoqado
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

  async sendTrialExpiredEmail(email: string, data: TrialExpiredEmailData): Promise<boolean> {
    const subject = `⏰ Tu período de prueba de ${data.featureName} ha terminado - ${data.venueName}`
    const expiredDateFormatted = data.expiredAt.toLocaleDateString('es-MX', {
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
          <title>Período de prueba terminado</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background: white; border-radius: 15px; box-shadow: 0 8px 25px rgba(0,0,0,0.1); overflow: hidden;">
            <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 40px 30px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: bold;">⏰ Período de Prueba Terminado</h1>
              <p style="color: #fef3c7; margin: 10px 0 0 0; font-size: 16px;">${data.venueName}</p>
            </div>

            <div style="padding: 40px 30px;">
              <p style="font-size: 18px; margin-bottom: 20px; color: #333;">Hola,</p>

              <p style="font-size: 16px; margin-bottom: 25px; color: #555;">
                Tu período de prueba de <strong>${data.featureName}</strong> ha <strong>terminado</strong> el ${expiredDateFormatted}.
              </p>

              <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #92400e;">
                  📅 <strong>Fecha de expiración:</strong> ${expiredDateFormatted}
                </p>
                <p style="font-size: 14px; margin: 0; color: #92400e;">
                  Tu acceso a ${data.featureName} ha sido desactivado temporalmente.
                </p>
              </div>

              <div style="background: #e3f2fd; border-left: 4px solid #2196f3; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  💡 <strong>¿Te gustó ${data.featureName}?</strong>
                </p>
                <p style="font-size: 14px; margin: 0; color: #666;">
                  Puedes suscribirte en cualquier momento para continuar disfrutando de todas las funcionalidades. Tus datos están seguros y el acceso se reactivará inmediatamente.
                </p>
              </div>

              <div style="background: #f8f9ff; border: 1px solid #e1e5f2; border-radius: 10px; padding: 25px; margin: 30px 0; text-align: center;">
                <p style="font-size: 16px; margin-bottom: 20px; color: #555;">¿Listo para suscribirte?</p>
                <p style="font-size: 14px; margin-bottom: 20px; color: #666;">
                  Visita la sección de facturación en tu dashboard para activar tu suscripción.
                </p>
              </div>

              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">

              <p style="font-size: 14px; color: #666; text-align: center; margin-bottom: 10px;">
                Gracias por probar ${data.featureName}. Si tienes preguntas, estamos aquí para ayudarte.
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

      Tu período de prueba de ${data.featureName} ha TERMINADO el ${expiredDateFormatted}.

      📅 Fecha de expiración: ${expiredDateFormatted}

      Tu acceso a ${data.featureName} ha sido desactivado temporalmente.

      ¿Te gustó ${data.featureName}?
      Puedes suscribirte en cualquier momento para continuar disfrutando de todas las funcionalidades. Tus datos están seguros y el acceso se reactivará inmediatamente.

      Visita la sección de facturación en tu dashboard para activar tu suscripción.

      Gracias por probar ${data.featureName}. Si tienes preguntas, estamos aquí para ayudarte.

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
    const subject = `Verifica tu correo electrónico`

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta name="color-scheme" content="light dark">
          <meta name="supported-color-schemes" content="light dark">
          <title>Verifica tu correo</title>
          <style>
            @media (prefers-color-scheme: dark) {
              .dark-mode-bg { background-color: #1a1a1a !important; }
              .dark-mode-card { background-color: #2a2a2a !important; }
              .dark-mode-text { color: #e0e0e0 !important; }
              .dark-mode-muted { color: #a0a0a0 !important; }
              .dark-mode-border { border-color: #404040 !important; }
            }
          </style>
        </head>
        <body class="dark-mode-bg" style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif; background-color: #f6f8fa; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f6f8fa; padding: 40px 20px;">
            <tr>
              <td align="center">
                <!-- Main Container -->
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 600px;">

                  <!-- Logo/Header -->
                  <tr>
                    <td style="padding: 0 0 32px 0; text-align: center;">
                      <svg width="48" height="48" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
                        <rect width="48" height="48" rx="8" fill="#635BFF"/>
                        <text x="24" y="33" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-size="24" font-weight="bold">A</text>
                      </svg>
                    </td>
                  </tr>

                  <!-- Main Card -->
                  <tr>
                    <td class="dark-mode-card" style="background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08); overflow: hidden;">
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">

                        <!-- Content -->
                        <tr>
                          <td style="padding: 48px 40px;">
                            <h1 class="dark-mode-text" style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #0a0a0a; line-height: 1.3;">
                              Verifica tu correo
                            </h1>

                            <p class="dark-mode-text" style="margin: 0 0 24px 0; font-size: 16px; color: #3c4149; line-height: 1.5;">
                              Hola ${data.firstName},
                            </p>

                            <p class="dark-mode-muted" style="margin: 0 0 32px 0; font-size: 15px; color: #697386; line-height: 1.5;">
                              Gracias por registrarte en Avoqado. Para continuar, por favor verifica tu correo electrónico usando el siguiente código:
                            </p>

                            <!-- Verification Code Box -->
                            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 32px 0;">
                              <tr>
                                <td class="dark-mode-border" style="background-color: #f6f8fa; border: 1px solid #e3e8ee; border-radius: 8px; padding: 32px; text-align: center;">
                                  <p style="margin: 0 0 12px 0; font-size: 13px; color: #697386; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 500;">
                                    TU CÓDIGO DE VERIFICACIÓN
                                  </p>
                                  <div style="font-size: 40px; font-weight: 600; color: #0a0a0a; letter-spacing: 12px; font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', 'Droid Sans Mono', 'Source Code Pro', monospace; line-height: 1.2;">
                                    ${data.verificationCode}
                                  </div>
                                </td>
                              </tr>
                            </table>

                            <!-- Warning Box -->
                            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 32px 0;">
                              <tr>
                                <td style="background-color: #fef7e0; border: 1px solid #f0e4c3; border-radius: 6px; padding: 16px;">
                                  <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                                    <tr>
                                      <td style="padding-right: 12px; vertical-align: top;">
                                        <div style="width: 20px; height: 20px; background-color: #f59e0b; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
                                          <span style="color: white; font-size: 12px; font-weight: bold;">⏱</span>
                                        </div>
                                      </td>
                                      <td>
                                        <p style="margin: 0 0 4px 0; font-size: 14px; color: #92400e; font-weight: 500;">
                                          Este código expirará en 10 minutos
                                        </p>
                                        <p style="margin: 0; font-size: 13px; color: #b45309; line-height: 1.4;">
                                          Si no solicitaste este código, puedes ignorar este correo.
                                        </p>
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                            </table>

                            <!-- Divider -->
                            <hr class="dark-mode-border" style="border: none; border-top: 1px solid #e3e8ee; margin: 32px 0;">

                            <!-- Footer Text -->
                            <p style="margin: 0; font-size: 13px; color: #8898aa; line-height: 1.5; text-align: center;">
                              ¿Necesitas ayuda? Contáctanos en cualquier momento.
                            </p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>

                  <!-- Email Footer -->
                  <tr>
                    <td style="padding: 32px 0 0 0; text-align: center;">
                      <p style="margin: 0 0 8px 0; font-size: 12px; color: #8898aa; line-height: 1.5;">
                        Este correo fue enviado automáticamente por Avoqado.
                      </p>
                      <p style="margin: 0; font-size: 12px; color: #aab7c4;">
                        © ${new Date().getFullYear()} Avoqado. Todos los derechos reservados.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
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

  async sendPasswordResetEmail(email: string, data: PasswordResetData): Promise<boolean> {
    const subject = `Restablece tu contraseña - Avoqado`

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta name="color-scheme" content="light dark">
          <meta name="supported-color-schemes" content="light dark">
          <title>Restablece tu contraseña</title>
          <style>
            @media (prefers-color-scheme: dark) {
              .dark-mode-bg { background-color: #1a1a1a !important; }
              .dark-mode-card { background-color: #2a2a2a !important; }
              .dark-mode-text { color: #e0e0e0 !important; }
              .dark-mode-muted { color: #a0a0a0 !important; }
              .dark-mode-border { border-color: #404040 !important; }
            }
          </style>
        </head>
        <body class="dark-mode-bg" style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
          <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
            <!-- Logo -->
            <div style="text-align: center; margin-bottom: 40px;">
              <div style="display: inline-block; background-color: #18181b; padding: 40px 60px; border-radius: 8px;">
                <img src="https://firebasestorage.googleapis.com/v0/b/avoqado-d0a24.appspot.com/o/Avoqado-(white).png?alt=media&token=05008dee-fc4d-42fd-bbcd-390a3bf88d79"
                     alt="Avoqado"
                     width="200"
                     height="200"
                     style="display: block;">
              </div>
            </div>

            <!-- Main Card -->
            <div class="dark-mode-card" style="background-color: white; border-radius: 12px; padding: 48px 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
              <h2 style="color: #18181b; margin: 0 0 24px 0; font-size: 24px; font-weight: 600; text-align: center;" class="dark-mode-text">
                Restablece tu contraseña
              </h2>

              <p style="color: #52525b; margin: 0 0 12px 0; font-size: 15px; line-height: 1.6;" class="dark-mode-muted">
                Hola <strong>${data.firstName}</strong>,
              </p>

              <p style="color: #52525b; margin: 0 0 32px 0; font-size: 15px; line-height: 1.6;" class="dark-mode-muted">
                Recibimos una solicitud para restablecer la contraseña de tu cuenta de Avoqado.
                Haz clic en el botón de abajo para crear una nueva contraseña.
              </p>

              <!-- Reset Button -->
              <div style="text-align: center; margin: 32px 0;">
                <a href="${data.resetLink}"
                   style="display: inline-block; background: #18181b; color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 15px; font-weight: 500;">
                  Restablecer Contraseña
                </a>
              </div>

              <div style="background-color: #f4f4f5; padding: 16px; margin-top: 32px; border-radius: 8px; border: 1px solid #e4e4e7;">
                <p style="color: #71717a; margin: 0 0 8px 0; font-size: 13px; font-weight: 500;" class="dark-mode-muted">
                  O copia y pega este enlace:
                </p>
                <p style="color: #18181b; margin: 0; font-size: 13px; word-break: break-all; font-family: 'Courier New', monospace;" class="dark-mode-text">
                  ${data.resetLink}
                </p>
              </div>

              <!-- Security Info -->
              <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e4e4e7;">
                <div style="background-color: #fef3c7; border-left: 3px solid #f59e0b; padding: 14px 16px; margin-bottom: 16px; border-radius: 6px;">
                  <p style="color: #92400e; margin: 0; font-size: 13px; line-height: 1.5;">
                    <strong>⏰ Expira en ${data.expiresInMinutes} minutos</strong><br>
                    Este enlace solo puede usarse una vez por seguridad.
                  </p>
                </div>

                <div style="background-color: #f0fdf4; border-left: 3px solid #22c55e; padding: 14px 16px; border-radius: 6px;">
                  <p style="color: #166534; margin: 0; font-size: 13px; line-height: 1.5;">
                    <strong>🔒 ¿No solicitaste esto?</strong><br>
                    Si no pediste restablecer tu contraseña, ignora este correo. Tu cuenta está segura.
                  </p>
                </div>
              </div>
            </div>

            <!-- Footer -->
            <div style="text-align: center; margin-top: 40px; padding-top: 24px; border-top: 1px solid #e4e4e7;">
              <p style="color: #a1a1aa; margin: 0 0 8px 0; font-size: 13px;" class="dark-mode-muted">
                Este correo fue enviado por <strong style="color: #71717a;">Avoqado</strong>
              </p>
              <p style="color: #a1a1aa; margin: 0; font-size: 13px;" class="dark-mode-muted">
                ¿Necesitas ayuda? Contáctanos en <a href="mailto:soporte@avoqado.com" style="color: #18181b; text-decoration: none;" class="dark-mode-text">soporte@avoqado.com</a>
              </p>
            </div>
          </div>
        </body>
      </html>
    `

    const text = `
      Restablece tu contraseña - Avoqado

      Hola ${data.firstName},

      Recibimos una solicitud para restablecer la contraseña de tu cuenta de Avoqado.

      Para restablecer tu contraseña, visita el siguiente enlace:
      ${data.resetLink}

      Este enlace expirará en ${data.expiresInMinutes} minutos y solo puede usarse una vez.

      ¿No solicitaste esto?
      Si no pediste restablecer tu contraseña, ignora este correo. Tu cuenta está segura.

      Equipo de Avoqado
    `

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  async sendTerminalPurchaseEmail(email: string, data: TerminalPurchaseEmailData): Promise<boolean> {
    const subject = `✅ Confirmación de compra de terminales - ${data.venueName}`

    const shippingSpeedText =
      data.shippingSpeed === 'express'
        ? 'Express (2-3 días)'
        : data.shippingSpeed === 'overnight'
          ? 'Nocturno (1 día)'
          : 'Estándar (5-7 días)'

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Confirmación de Compra - ${data.venueName}</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background: white; border-radius: 15px; box-shadow: 0 8px 25px rgba(0,0,0,0.1); overflow: hidden;">
            <div style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); padding: 40px 30px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: bold;">🎉 ¡Compra confirmada!</h1>
              <p style="color: #e8f4f8; margin: 10px 0 0 0; font-size: 16px;">${data.venueName}</p>
            </div>

            <div style="padding: 40px 30px;">
              <p style="font-size: 18px; margin-bottom: 20px; color: #333;">Hola ${data.contactName},</p>

              <p style="font-size: 16px; margin-bottom: 25px; color: #555;">
                ¡Gracias por tu compra! Hemos recibido tu orden de terminales PAX A910S. A continuación encontrarás los detalles de tu pedido:
              </p>

              <div style="background: #f8f9ff; border: 1px solid #e1e5f2; border-radius: 10px; padding: 25px; margin: 30px 0;">
                <h2 style="font-size: 18px; margin: 0 0 20px 0; color: #3b82f6; border-bottom: 2px solid #3b82f6; padding-bottom: 10px;">📦 Detalles del Pedido</h2>

                <div style="margin-bottom: 15px;">
                  <strong style="color: #555;">Producto:</strong> ${data.productName}<br>
                  <strong style="color: #555;">Cantidad:</strong> ${data.quantity} ${data.quantity === 1 ? 'terminal' : 'terminales'}<br>
                  <strong style="color: #555;">Precio unitario:</strong> $${data.productPrice.toFixed(2)} ${data.currency}<br>
                  <strong style="color: #555;">Fecha de orden:</strong> ${new Date(data.orderDate).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })}
                </div>
              </div>

              <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; padding: 25px; margin: 30px 0;">
                <h2 style="font-size: 18px; margin: 0 0 20px 0; color: #16a34a; border-bottom: 2px solid #16a34a; padding-bottom: 10px;">🚚 Información de Envío</h2>

                <div style="margin-bottom: 15px;">
                  <strong style="color: #555;">Dirección:</strong><br>
                  ${data.shippingAddress}<br>
                  ${data.shippingCity}, ${data.shippingState} ${data.shippingPostalCode}<br>
                  ${data.shippingCountry}<br><br>
                  <strong style="color: #555;">Velocidad de envío:</strong> ${shippingSpeedText}
                </div>
              </div>

              <div style="background: #fef3c7; border: 1px solid #fde68a; border-radius: 10px; padding: 25px; margin: 30px 0;">
                <h2 style="font-size: 18px; margin: 0 0 20px 0; color: #d97706; border-bottom: 2px solid #d97706; padding-bottom: 10px;">💰 Resumen de Pago</h2>

                <table style="width: 100%; font-size: 14px;">
                  <tr>
                    <td style="padding: 8px 0; color: #555;">Subtotal (${data.quantity} ${data.quantity === 1 ? 'terminal' : 'terminales'}):</td>
                    <td style="padding: 8px 0; text-align: right; font-weight: bold;">$${data.subtotal.toFixed(2)} ${data.currency}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #555;">Envío:</td>
                    <td style="padding: 8px 0; text-align: right; font-weight: bold;">$${data.shippingCost.toFixed(2)} ${data.currency}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #555;">IVA (16%):</td>
                    <td style="padding: 8px 0; text-align: right; font-weight: bold;">$${data.tax.toFixed(2)} ${data.currency}</td>
                  </tr>
                  <tr style="border-top: 2px solid #d97706;">
                    <td style="padding: 15px 0 0 0; color: #333; font-size: 18px;"><strong>Total:</strong></td>
                    <td style="padding: 15px 0 0 0; text-align: right; font-size: 20px; font-weight: bold; color: #d97706;">$${data.totalAmount.toFixed(2)} ${data.currency}</td>
                  </tr>
                </table>
              </div>

              <div style="background: #eff6ff; border-left: 4px solid #3b82f6; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 14px; margin: 0 0 10px 0; color: #666;">
                  🔑 <strong>Próximos pasos:</strong>
                </p>
                <ol style="font-size: 14px; margin: 0; padding-left: 20px; color: #666;">
                  <li style="margin-bottom: 8px;">Tus terminales serán enviados a la dirección proporcionada</li>
                  <li style="margin-bottom: 8px;">Una vez que recibas los dispositivos, encontrarás el <strong>número de serie físico</strong> en la parte posterior</li>
                  <li style="margin-bottom: 8px;">Ingresa a tu dashboard de Avoqado y haz clic en <strong>"Activar"</strong> para registrar cada terminal</li>
                  <li>¡Listo! Tus terminales estarán activos y listos para procesar pagos</li>
                </ol>
              </div>

              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">

              <p style="font-size: 14px; color: #666; text-align: center; margin-bottom: 10px;">
                Si tienes alguna pregunta sobre tu pedido, no dudes en contactarnos.
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
      ¡Compra confirmada! - ${data.venueName}

      Hola ${data.contactName},

      ¡Gracias por tu compra! Hemos recibido tu orden de terminales PAX A910S.

      DETALLES DEL PEDIDO
      -------------------
      Producto: ${data.productName}
      Cantidad: ${data.quantity} ${data.quantity === 1 ? 'terminal' : 'terminales'}
      Precio unitario: $${data.productPrice.toFixed(2)} ${data.currency}
      Fecha de orden: ${new Date(data.orderDate).toLocaleDateString('es-MX')}

      INFORMACIÓN DE ENVÍO
      --------------------
      ${data.shippingAddress}
      ${data.shippingCity}, ${data.shippingState} ${data.shippingPostalCode}
      ${data.shippingCountry}

      Velocidad de envío: ${shippingSpeedText}

      RESUMEN DE PAGO
      ---------------
      Subtotal: $${data.subtotal.toFixed(2)} ${data.currency}
      Envío: $${data.shippingCost.toFixed(2)} ${data.currency}
      IVA (16%): $${data.tax.toFixed(2)} ${data.currency}
      -------------------
      TOTAL: $${data.totalAmount.toFixed(2)} ${data.currency}

      PRÓXIMOS PASOS:
      1. Tus terminales serán enviados a la dirección proporcionada
      2. Una vez que recibas los dispositivos, encontrarás el número de serie físico en la parte posterior
      3. Ingresa a tu dashboard de Avoqado y haz clic en "Activar" para registrar cada terminal
      4. ¡Listo! Tus terminales estarán activos y listos para procesar pagos

      Si tienes alguna pregunta sobre tu pedido, no dudes en contactarnos.

      Equipo de Avoqado
    `

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  /**
   * Send admin notification for terminal purchase order
   * This email is sent to Avoqado team to process and ship the order
   */
  async sendTerminalPurchaseAdminNotification(data: TerminalPurchaseEmailData): Promise<boolean> {
    const adminEmail = process.env.ORDER_NOTIFICATIONS_EMAIL

    if (!adminEmail) {
      logger.warn('ORDER_NOTIFICATIONS_EMAIL not configured - skipping admin notification')
      return false
    }

    const subject = `🛒 Nueva orden de terminales - ${data.venueName} (${data.quantity}x)`

    const shippingSpeedText =
      data.shippingSpeed === 'express'
        ? 'Express (2-3 días)'
        : data.shippingSpeed === 'overnight'
          ? 'Nocturno (1 día)'
          : 'Estándar (5-7 días)'

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Nueva Orden - ${data.venueName}</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 700px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background: white; border-radius: 15px; box-shadow: 0 8px 25px rgba(0,0,0,0.1); overflow: hidden;">
            <div style="background: linear-gradient(135deg, #16a34a 0%, #15803d 100%); padding: 40px 30px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: bold;">🛒 Nueva Orden de Terminales</h1>
              <p style="color: #d1fae5; margin: 10px 0 0 0; font-size: 16px;">Fecha: ${new Date(data.orderDate).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
            </div>

            <div style="padding: 40px 30px;">
              <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 20px; margin-bottom: 30px; border-radius: 0 8px 8px 0;">
                <p style="font-size: 16px; margin: 0; color: #92400e;">
                  <strong>⚡ Acción requerida:</strong> Procesar orden y coordinar envío de terminales.
                </p>
              </div>

              <div style="background: #f8f9ff; border: 2px solid #3b82f6; border-radius: 10px; padding: 25px; margin: 30px 0;">
                <h2 style="font-size: 20px; margin: 0 0 20px 0; color: #3b82f6;">🏢 Información del Cliente</h2>

                <table style="width: 100%; font-size: 15px;">
                  <tr>
                    <td style="padding: 8px 0; color: #555; width: 40%;"><strong>Restaurante:</strong></td>
                    <td style="padding: 8px 0; color: #333;">${data.venueName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #555;"><strong>Contacto:</strong></td>
                    <td style="padding: 8px 0; color: #333;">${data.contactName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #555;"><strong>Email:</strong></td>
                    <td style="padding: 8px 0; color: #333;"><a href="mailto:${data.contactEmail}" style="color: #3b82f6; text-decoration: none;">${data.contactEmail}</a></td>
                  </tr>
                </table>
              </div>

              <div style="background: #f0fdf4; border: 2px solid #16a34a; border-radius: 10px; padding: 25px; margin: 30px 0;">
                <h2 style="font-size: 20px; margin: 0 0 20px 0; color: #16a34a;">📦 Detalles del Pedido</h2>

                <table style="width: 100%; font-size: 15px;">
                  <tr>
                    <td style="padding: 8px 0; color: #555; width: 40%;"><strong>Producto:</strong></td>
                    <td style="padding: 8px 0; color: #333;">${data.productName}</td>
                  </tr>
                  <tr style="background: #dcfce7;">
                    <td style="padding: 12px 8px; color: #555;"><strong>Cantidad:</strong></td>
                    <td style="padding: 12px 8px; color: #333; font-size: 18px; font-weight: bold;">${data.quantity} ${data.quantity === 1 ? 'terminal' : 'terminales'}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #555;"><strong>Precio unitario:</strong></td>
                    <td style="padding: 8px 0; color: #333;">$${data.productPrice.toFixed(2)} ${data.currency}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #555;"><strong>Total:</strong></td>
                    <td style="padding: 8px 0; color: #333; font-size: 18px; font-weight: bold; color: #16a34a;">$${data.totalAmount.toFixed(2)} ${data.currency}</td>
                  </tr>
                </table>
              </div>

              <div style="background: #fef2f2; border: 2px solid #ef4444; border-radius: 10px; padding: 25px; margin: 30px 0;">
                <h2 style="font-size: 20px; margin: 0 0 20px 0; color: #ef4444;">🚚 Dirección de Envío</h2>

                <div style="background: white; padding: 20px; border-radius: 8px; font-size: 15px; line-height: 1.8;">
                  <strong style="color: #333; display: block; margin-bottom: 10px;">${data.contactName}</strong>
                  ${data.shippingAddress}<br>
                  ${data.shippingCity}, ${data.shippingState} ${data.shippingPostalCode}<br>
                  ${data.shippingCountry}<br><br>
                  <div style="background: #fee2e2; padding: 12px; border-radius: 6px; margin-top: 15px;">
                    <strong style="color: #991b1b;">Velocidad de envío:</strong> ${shippingSpeedText}
                  </div>
                </div>
              </div>

              <div style="background: #fff7ed; border: 1px solid #fdba74; border-radius: 10px; padding: 25px; margin: 30px 0;">
                <h2 style="font-size: 18px; margin: 0 0 15px 0; color: #ea580c;">💰 Resumen Financiero</h2>

                <table style="width: 100%; font-size: 14px;">
                  <tr>
                    <td style="padding: 8px 0; color: #555;">Subtotal (${data.quantity}x):</td>
                    <td style="padding: 8px 0; text-align: right;">$${data.subtotal.toFixed(2)} ${data.currency}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #555;">Envío:</td>
                    <td style="padding: 8px 0; text-align: right;">$${data.shippingCost.toFixed(2)} ${data.currency}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #555;">IVA (16%):</td>
                    <td style="padding: 8px 0; text-align: right;">$${data.tax.toFixed(2)} ${data.currency}</td>
                  </tr>
                  <tr style="border-top: 2px solid #ea580c;">
                    <td style="padding: 12px 0 0 0; font-size: 16px;"><strong>Total:</strong></td>
                    <td style="padding: 12px 0 0 0; text-align: right; font-size: 18px; font-weight: bold; color: #ea580c;">$${data.totalAmount.toFixed(2)} ${data.currency}</td>
                  </tr>
                </table>
              </div>

              <div style="background: #eff6ff; border-left: 4px solid #3b82f6; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 15px; margin: 0 0 12px 0; color: #1e40af;">
                  <strong>✅ Próximas acciones:</strong>
                </p>
                <ol style="font-size: 14px; margin: 0; padding-left: 20px; color: #334155; line-height: 1.8;">
                  <li>Verificar disponibilidad de stock de terminales PAX A910S</li>
                  <li>Coordinar el envío ${shippingSpeedText} a la dirección proporcionada</li>
                  <li>Generar guía de rastreo y notificar al cliente</li>
                  <li>El cliente activará las terminales cuando reciba los dispositivos físicos</li>
                </ol>
              </div>

              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">

              <p style="font-size: 13px; color: #666; text-align: center; margin: 0;">
                Correo automático enviado por Avoqado Dashboard
              </p>
            </div>
          </div>
        </body>
      </html>
    `

    const text = `
      NUEVA ORDEN DE TERMINALES
      =========================

      Restaurante: ${data.venueName}
      Contacto: ${data.contactName}
      Fecha: ${new Date(data.orderDate).toLocaleDateString('es-MX')}

      DETALLES DEL PEDIDO
      -------------------
      Producto: ${data.productName}
      Cantidad: ${data.quantity} ${data.quantity === 1 ? 'terminal' : 'terminales'}
      Precio unitario: $${data.productPrice.toFixed(2)} ${data.currency}

      DIRECCIÓN DE ENVÍO
      ------------------
      ${data.contactName}
      ${data.shippingAddress}
      ${data.shippingCity}, ${data.shippingState} ${data.shippingPostalCode}
      ${data.shippingCountry}

      Velocidad: ${shippingSpeedText}

      RESUMEN FINANCIERO
      ------------------
      Subtotal: $${data.subtotal.toFixed(2)} ${data.currency}
      Envío: $${data.shippingCost.toFixed(2)} ${data.currency}
      IVA (16%): $${data.tax.toFixed(2)} ${data.currency}
      -------------------
      TOTAL: $${data.totalAmount.toFixed(2)} ${data.currency}

      PRÓXIMAS ACCIONES:
      1. Verificar disponibilidad de stock
      2. Coordinar el envío a la dirección proporcionada
      3. Generar guía de rastreo y notificar al cliente
      4. El cliente activará las terminales al recibir los dispositivos

      ---
      Avoqado Dashboard
    `

    return this.sendEmail({
      to: adminEmail,
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
