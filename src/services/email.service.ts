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
  roleDisplayName?: string // Custom role name from venue settings
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

interface TpvFeedbackEmailData {
  feedbackType: 'bug' | 'feature'
  message: string
  venueSlug: string
  appVersion: string
  buildVersion: string
  androidVersion: string
  deviceModel: string
  deviceManufacturer: string
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
    const logoUrl = 'https://avoqado.io/isotipo.svg'

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
        CREDIT_CARD: 'Tarjeta de Credito',
        DEBIT_CARD: 'Tarjeta de Debito',
      }
      return methods[method] || method
    }

    // Build items HTML
    const itemsHtml =
      data.items && data.items.length > 0
        ? data.items
            .map(
              item => `
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 12px 0; font-size: 15px; color: #000;">
            ${item.name}
            ${item.modifiers && item.modifiers.length > 0 ? `<br><span style="font-size: 13px; color: #666;">${item.modifiers.map(m => `+ ${m.name}`).join(', ')}</span>` : ''}
          </td>
          <td style="padding: 12px 0; font-size: 15px; color: #000; text-align: center;">x${item.quantity}</td>
          <td style="padding: 12px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(item.totalPrice)}</td>
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
  <title>Recibo #${data.receiptNumber} - ${data.venueName}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header with Avoqado Logo -->
    <div style="padding-bottom: 24px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <!-- Venue Header -->
    <div style="text-align: center; padding: 24px 0; border-bottom: 1px solid #e0e0e0;">
      ${
        data.venueLogoUrl
          ? `<img src="${data.venueLogoUrl}" alt="${data.venueName}" style="max-width: 80px; max-height: 80px; width: auto; height: auto; margin-bottom: 12px; border-radius: 8px;">`
          : ''
      }
      <h1 style="margin: 0 0 4px 0; font-size: 24px; font-weight: 400; color: #000;">${data.venueName}</h1>
      ${data.venueAddress || data.venueCity ? `<p style="color: #666; margin: 0; font-size: 14px;">${[data.venueAddress, data.venueCity, data.venueState].filter(Boolean).join(', ')}</p>` : ''}
    </div>

    <!-- Receipt Info -->
    <div style="padding: 24px 0; border-bottom: 1px solid #e0e0e0;">
      <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 400; color: #000;">Recibo #${data.receiptNumber}</h2>
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        ${data.orderNumber ? `<tr><td style="padding: 4px 0; font-size: 14px; color: #666;">Orden</td><td style="padding: 4px 0; font-size: 14px; color: #000; text-align: right;">#${data.orderNumber}</td></tr>` : ''}
        ${data.paymentDate ? `<tr><td style="padding: 4px 0; font-size: 14px; color: #666;">Fecha</td><td style="padding: 4px 0; font-size: 14px; color: #000; text-align: right;">${data.paymentDate}</td></tr>` : ''}
        ${data.processedBy ? `<tr><td style="padding: 4px 0; font-size: 14px; color: #666;">Atendido por</td><td style="padding: 4px 0; font-size: 14px; color: #000; text-align: right;">${data.processedBy}</td></tr>` : ''}
        <tr><td style="padding: 4px 0; font-size: 14px; color: #666;">Metodo de pago</td><td style="padding: 4px 0; font-size: 14px; color: #000; text-align: right;">${formatPaymentMethod(data.paymentMethod)}</td></tr>
      </table>
    </div>

    ${
      itemsHtml
        ? `
    <!-- Items -->
    <div style="padding: 24px 0; border-bottom: 1px solid #e0e0e0;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #000;">Productos</h3>
      <table cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse;">
        <tr style="border-bottom: 1px solid #e0e0e0;">
          <td style="padding: 8px 0; font-size: 14px; font-weight: 600; color: #000;">Articulo</td>
          <td style="padding: 8px 0; font-size: 14px; font-weight: 600; color: #000; text-align: center;">Cant.</td>
          <td style="padding: 8px 0; font-size: 14px; font-weight: 600; color: #000; text-align: right;">Precio</td>
        </tr>
        ${itemsHtml}
      </table>
    </div>
    `
        : ''
    }

    <!-- Totals -->
    <div style="padding: 24px 0; border-bottom: 1px solid #e0e0e0;">
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        ${data.subtotal !== undefined ? `<tr><td style="padding: 8px 0; font-size: 15px; color: #000;">Subtotal</td><td style="padding: 8px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.subtotal)}</td></tr>` : ''}
        ${data.taxAmount !== undefined && data.taxAmount > 0 ? `<tr><td style="padding: 8px 0; font-size: 15px; color: #000;">Impuestos</td><td style="padding: 8px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.taxAmount)}</td></tr>` : ''}
        ${data.tipAmount !== undefined && data.tipAmount > 0 ? `<tr><td style="padding: 8px 0; font-size: 15px; color: #000;">Propina</td><td style="padding: 8px 0; font-size: 15px; color: #1a73e8; text-align: right;">${formatCurrency(data.tipAmount)}</td></tr>` : ''}
        <tr style="border-top: 1px solid #e0e0e0;">
          <td style="padding: 16px 0 0 0; font-size: 18px; font-weight: 600; color: #000;">Total</td>
          <td style="padding: 16px 0 0 0; font-size: 18px; font-weight: 600; color: #000; text-align: right;">${formatCurrency(data.totalAmount)}</td>
        </tr>
      </table>
    </div>

    <!-- CTA Button -->
    <div style="padding: 32px 0; text-align: center;">
      <a href="${data.receiptUrl}" style="background: #000; color: #fff; padding: 14px 32px; text-decoration: none; border-radius: 4px; font-weight: 600; font-size: 14px; display: inline-block;">
        Ver Recibo Completo
      </a>
    </div>

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0; font-size: 14px; color: #666;">
        Recibo enviado por ${data.venueName} via Avoqado
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">Politica de Privacidad</a>
      </p>
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

Metodo de pago: ${formatPaymentMethod(data.paymentMethod)}

Ver recibo completo: ${data.receiptUrl}

Gracias por tu preferencia!
Recibo enviado por ${data.venueName} via Avoqado
    `

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  async sendTeamInvitation(email: string, data: InvitationEmailData): Promise<boolean> {
    const subject = `Invitacion para unirte al equipo de ${data.venueName}`
    const logoUrl = 'https://avoqado.io/isotipo.svg'

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invitacion al equipo</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header with Logo -->
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <!-- Title -->
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">Te han invitado a unirte al equipo</h1>
    </div>

    <!-- Content -->
    <div style="padding-bottom: 24px;">
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hola,</p>

      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">
        <strong>${data.inviterName}</strong> te ha invitado a unirte al equipo de
        <strong>${data.venueName}</strong> como <strong>${data.roleDisplayName || data.role}</strong>.
      </p>

      <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
        Esto te dara acceso al panel de administracion de ${data.organizationName} donde podras:
      </p>

      <ul style="font-size: 15px; margin: 0 0 24px 0; padding-left: 24px; color: #000;">
        <li style="margin-bottom: 8px;">Gestionar ordenes y pagos</li>
        <li style="margin-bottom: 8px;">Ver reportes y estadisticas</li>
        <li style="margin-bottom: 8px;">Administrar el menu y productos</li>
        <li style="margin-bottom: 8px;">Supervisar las operaciones del negocio</li>
      </ul>
    </div>

    <!-- CTA Button -->
    <div style="padding: 32px 0; text-align: center;">
      <a href="${data.inviteLink}" style="background: #000; color: #fff; padding: 14px 32px; text-decoration: none; border-radius: 4px; font-weight: 600; font-size: 14px; display: inline-block;">
        Aceptar Invitacion
      </a>
    </div>

    <!-- Note -->
    <div style="padding-bottom: 24px;">
      <p style="font-size: 14px; color: #666; margin: 0;">
        Esta invitacion expirara en 7 dias. Si tienes alguna pregunta, contacta con ${data.inviterName}.
      </p>
    </div>

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 40px 0 24px 0;">
    <div>
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0 0 16px 0; font-size: 14px; color: #000;">
        Avoqado Technologies S.A. de C.V.<br>
        Ciudad de Mexico, Mexico
      </p>
      <p style="margin: 0; font-size: 12px; color: #666;">
        Este correo fue enviado por Avoqado. Si no esperabas recibir esta invitacion, puedes ignorar este mensaje.
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">Politica de Privacidad</a>
      </p>
    </div>

  </div>
</body>
</html>
    `

    const text = `
Hola,

${data.inviterName} te ha invitado a unirte al equipo de ${data.venueName} como ${data.roleDisplayName || data.role}.

Para aceptar la invitacion, visita: ${data.inviteLink}

Esta invitacion expirara en 7 dias.

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
    const subject = `Tu prueba gratuita de ${data.featureName} esta por terminar - ${data.venueName}`
    const logoUrl = 'https://avoqado.io/isotipo.svg'
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
  <title>Tu prueba gratuita esta por terminar</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header with Logo -->
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <!-- Title -->
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">Tu prueba gratuita esta por terminar</h1>
      <p style="margin: 0; font-size: 14px; color: #666;">${data.venueName}</p>
    </div>

    <!-- Content -->
    <div style="padding-bottom: 24px;">
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hola,</p>

      <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
        Te escribimos para recordarte que tu <strong>prueba gratuita de ${data.featureName}</strong> esta por terminar el <strong>${trialEndDateFormatted}</strong>.
      </p>

      <!-- Warning Box -->
      <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="font-size: 15px; margin: 0 0 8px 0; color: #000; font-weight: 600;">Importante</p>
        <p style="font-size: 14px; margin: 0; color: #666;">
          Despues de esta fecha, la funcion sera desactivada automaticamente si no actualizas tu metodo de pago. Para continuar usando ${data.featureName} sin interrupciones, actualiza tu metodo de pago ahora.
        </p>
      </div>
    </div>

    <!-- CTA Button -->
    <div style="padding: 32px 0; text-align: center;">
      <a href="${data.billingPortalUrl}" style="background: #000; color: #fff; padding: 14px 32px; text-decoration: none; border-radius: 4px; font-weight: 600; font-size: 14px; display: inline-block;">
        Ir a Facturacion
      </a>
    </div>

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 40px 0 24px 0;">
    <div>
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0 0 16px 0; font-size: 14px; color: #000;">
        Avoqado Technologies S.A. de C.V.<br>
        Ciudad de Mexico, Mexico
      </p>
      <p style="margin: 0; font-size: 12px; color: #666;">
        Necesitas ayuda? Contactanos en cualquier momento.
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">Politica de Privacidad</a>
      </p>
    </div>

  </div>
</body>
</html>
    `

    const text = `
Hola,

Tu prueba gratuita de ${data.featureName} esta por terminar el ${trialEndDateFormatted}.

IMPORTANTE: Despues de esta fecha, la funcion sera desactivada automaticamente si no actualizas tu metodo de pago.

Para continuar usando ${data.featureName} sin interrupciones, actualiza tu metodo de pago ahora:

${data.billingPortalUrl}

Necesitas ayuda? Contactanos en cualquier momento.

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
    const subject = `Problema con el pago de ${data.featureName} - ${data.venueName}`
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const amountFormatted = new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: data.currency.toUpperCase(),
    }).format(data.amountDue / 100)

    let urgencyLevel = ''
    let nextSteps = ''

    if (data.attemptCount === 1) {
      urgencyLevel = 'Intento 1 de 3'
      nextSteps = 'Intentaremos cobrar nuevamente en los proximos dias. Por favor, actualiza tu metodo de pago lo antes posible.'
    } else if (data.attemptCount === 2) {
      urgencyLevel = 'Intento 2 de 3 - Accion Requerida'
      nextSteps = 'Este es el segundo intento fallido. Si el proximo intento tambien falla, tu suscripcion sera cancelada automaticamente.'
    } else {
      urgencyLevel = 'ULTIMO INTENTO - Accion Urgente'
      nextSteps = 'Este es el ultimo intento. Si no actualizas tu metodo de pago inmediatamente, tu suscripcion sera cancelada.'
    }

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Problema con el pago</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header with Logo -->
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <!-- Title -->
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">Problema con el pago</h1>
      <p style="margin: 0; font-size: 14px; color: #666;">${data.venueName}</p>
    </div>

    <!-- Content -->
    <div style="padding-bottom: 24px;">
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hola,</p>

      <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
        No pudimos procesar el pago de <strong>${amountFormatted}</strong> para tu suscripcion de <strong>${data.featureName}</strong>.
      </p>

      <!-- Alert Box -->
      <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="font-size: 15px; margin: 0 0 8px 0; color: #000; font-weight: 600;">${urgencyLevel}</p>
        ${data.last4 ? `<p style="font-size: 14px; margin: 0 0 8px 0; color: #666;">Tarjeta terminada en <strong>${data.last4}</strong></p>` : ''}
        <p style="font-size: 14px; margin: 0; color: #666;">${nextSteps}</p>
      </div>

      <!-- Info Box -->
      <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="font-size: 15px; margin: 0 0 12px 0; color: #000; font-weight: 600;">Razones comunes de rechazo</p>
        <ul style="font-size: 14px; margin: 0; padding-left: 20px; color: #666;">
          <li style="margin-bottom: 4px;">Fondos insuficientes en la tarjeta</li>
          <li style="margin-bottom: 4px;">Tarjeta vencida o cerca de vencer</li>
          <li style="margin-bottom: 4px;">Limite de credito alcanzado</li>
          <li>Bloqueo temporal del banco</li>
        </ul>
      </div>
    </div>

    <!-- CTA Button -->
    <div style="padding: 32px 0; text-align: center;">
      <a href="${data.billingPortalUrl}" style="background: #000; color: #fff; padding: 14px 32px; text-decoration: none; border-radius: 4px; font-weight: 600; font-size: 14px; display: inline-block;">
        Actualizar Metodo de Pago
      </a>
    </div>

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 40px 0 24px 0;">
    <div>
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0 0 16px 0; font-size: 14px; color: #000;">
        Avoqado Technologies S.A. de C.V.<br>
        Ciudad de Mexico, Mexico
      </p>
      <p style="margin: 0; font-size: 12px; color: #666;">
        Necesitas ayuda? Contactanos en cualquier momento o verifica con tu banco.
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">Politica de Privacidad</a>
      </p>
    </div>

  </div>
</body>
</html>
    `

    const text = `
Hola,

No pudimos procesar el pago de ${amountFormatted} para tu suscripcion de ${data.featureName}.

${urgencyLevel}
${data.last4 ? `Tarjeta terminada en ${data.last4}` : ''}

${nextSteps}

Actualiza tu metodo de pago ahora:
${data.billingPortalUrl}

Razones comunes de rechazo:
- Fondos insuficientes en la tarjeta
- Tarjeta vencida o cerca de vencer
- Limite de credito alcanzado
- Bloqueo temporal del banco

Necesitas ayuda? Contactanos en cualquier momento o verifica con tu banco.

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
    const subject = `Tu suscripcion de ${data.featureName} ha sido suspendida - ${data.venueName}`
    const logoUrl = 'https://avoqado.io/isotipo.svg'
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
  <title>Suscripcion suspendida</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header with Logo -->
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <!-- Title -->
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">Suscripcion Suspendida</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">${data.venueName}</p>
    </div>

    <!-- Content -->
    <div style="padding-bottom: 24px;">
      <p style="font-size: 16px; color: #000; margin: 0 0 16px 0;">Hola,</p>
      <p style="font-size: 15px; color: #000; margin: 0 0 24px 0;">
        Tu suscripcion de <strong>${data.featureName}</strong> ha sido suspendida debido a multiples intentos de pago fallidos.
      </p>
    </div>

    <!-- Status Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Estado actual</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">Acceso bloqueado desde ${suspendedDateFormatted}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Fecha de cancelacion definitiva</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${cancellationDateFormatted}</td>
        </tr>
      </table>
    </div>

    <!-- Warning -->
    <div style="background: #fef3c7; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <p style="font-size: 14px; color: #92400e; margin: 0;">
        Si no actualizas tu metodo de pago antes del ${cancellationDateFormatted}, tu suscripcion sera cancelada permanentemente.
      </p>
    </div>

    <!-- Info Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <p style="font-size: 14px; font-weight: 600; color: #000; margin: 0 0 12px 0;">Que significa esto:</p>
      <ul style="font-size: 14px; margin: 0; padding-left: 20px; color: #000;">
        <li style="margin-bottom: 8px;">Tu acceso a ${data.featureName} esta actualmente bloqueado</li>
        <li style="margin-bottom: 8px;">Tus datos permanecen seguros y guardados</li>
        <li style="margin-bottom: 8px;">Puedes reactivar tu suscripcion actualizando tu metodo de pago</li>
        <li>Despues del ${cancellationDateFormatted}, la suscripcion sera cancelada</li>
      </ul>
    </div>

    <!-- CTA Button -->
    <div style="padding: 24px 0; text-align: center;">
      <a href="${data.billingPortalUrl}" style="background: #000; color: #fff; padding: 14px 32px; text-decoration: none; border-radius: 4px; font-weight: 600; font-size: 14px; display: inline-block;">
        Actualizar Metodo de Pago
      </a>
    </div>

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0; font-size: 14px; color: #666;">
        Necesitas ayuda? Contactanos en cualquier momento.
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">Politica de Privacidad</a>
      </p>
    </div>

  </div>
</body>
</html>
    `

    const text = `
Hola,

Tu suscripcion de ${data.featureName} ha sido SUSPENDIDA debido a multiples intentos de pago fallidos.

Estado actual: Acceso bloqueado desde ${suspendedDateFormatted}
Fecha de cancelacion definitiva: ${cancellationDateFormatted}

Que significa esto:
- Tu acceso a ${data.featureName} esta actualmente bloqueado
- Tus datos permanecen seguros y guardados
- Puedes reactivar tu suscripcion actualizando tu metodo de pago
- Despues del ${cancellationDateFormatted}, la suscripcion sera cancelada

Reactiva tu suscripcion ahora:
${data.billingPortalUrl}

Necesitas ayuda? Contactanos en cualquier momento.

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
    const subject = `Tu suscripcion de ${data.featureName} ha sido cancelada - ${data.venueName}`
    const logoUrl = 'https://avoqado.io/isotipo.svg'
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
  <title>Suscripcion cancelada</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header with Logo -->
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <!-- Title -->
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">Suscripcion Cancelada</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">${data.venueName}</p>
    </div>

    <!-- Content -->
    <div style="padding-bottom: 24px;">
      <p style="font-size: 16px; color: #000; margin: 0 0 16px 0;">Hola,</p>
      <p style="font-size: 15px; color: #000; margin: 0 0 24px 0;">
        Tu suscripcion de <strong>${data.featureName}</strong> ha sido cancelada permanentemente el ${canceledDateFormatted} debido a problemas de pago no resueltos.
      </p>
    </div>

    <!-- Status Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Fecha de suspension</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${suspendedDateFormatted}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Fecha de cancelacion</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${canceledDateFormatted}</td>
        </tr>
      </table>
      <p style="font-size: 14px; color: #666; margin: 16px 0 0 0;">
        Tu acceso a ${data.featureName} ha sido completamente desactivado.
      </p>
    </div>

    <!-- Info Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <p style="font-size: 14px; font-weight: 600; color: #000; margin: 0 0 12px 0;">Quieres volver a activar ${data.featureName}?</p>
      <p style="font-size: 14px; color: #000; margin: 0;">
        Puedes reactivar tu suscripcion en cualquier momento. Tus datos previos permanecen seguros y podras recuperar el acceso inmediatamente despues de configurar tu metodo de pago.
      </p>
    </div>

    <!-- CTA -->
    <div style="padding: 16px 0 24px 0; text-align: center;">
      <p style="font-size: 15px; color: #000; margin: 0 0 16px 0;">Listo para volver?</p>
      <a href="mailto:hola@avoqado.io" style="color: #1a73e8; text-decoration: none; font-weight: 600; font-size: 14px;">
        Contactanos para reactivar tu suscripcion
      </a>
    </div>

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0; font-size: 14px; color: #666;">
        Lamentamos verte partir. Si necesitas ayuda o tienes preguntas, estamos aqui para ti.
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">Politica de Privacidad</a>
      </p>
    </div>

  </div>
</body>
</html>
    `

    const text = `
Hola,

Tu suscripcion de ${data.featureName} ha sido CANCELADA PERMANENTEMENTE el ${canceledDateFormatted} debido a problemas de pago no resueltos.

Fecha de suspension: ${suspendedDateFormatted}
Fecha de cancelacion: ${canceledDateFormatted}

Tu acceso a ${data.featureName} ha sido completamente desactivado.

Quieres volver a activar ${data.featureName}?
Puedes reactivar tu suscripcion en cualquier momento. Tus datos previos permanecen seguros y podras recuperar el acceso inmediatamente despues de configurar tu metodo de pago.

Contactanos si necesitas ayuda: hola@avoqado.io

Lamentamos verte partir. Si necesitas ayuda o tienes preguntas, estamos aqui para ti.

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
    const subject = `Tu periodo de prueba de ${data.featureName} ha terminado - ${data.venueName}`
    const logoUrl = 'https://avoqado.io/isotipo.svg'
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
  <title>Periodo de prueba terminado</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header with Logo -->
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <!-- Title -->
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">Periodo de Prueba Terminado</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">${data.venueName}</p>
    </div>

    <!-- Content -->
    <div style="padding-bottom: 24px;">
      <p style="font-size: 16px; color: #000; margin: 0 0 16px 0;">Hola,</p>
      <p style="font-size: 15px; color: #000; margin: 0 0 24px 0;">
        Tu periodo de prueba de <strong>${data.featureName}</strong> ha terminado el ${expiredDateFormatted}.
      </p>
    </div>

    <!-- Status Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Fecha de expiracion</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${expiredDateFormatted}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Estado</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">Acceso desactivado temporalmente</td>
        </tr>
      </table>
    </div>

    <!-- Info Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <p style="font-size: 14px; font-weight: 600; color: #000; margin: 0 0 12px 0;">Te gusto ${data.featureName}?</p>
      <p style="font-size: 14px; color: #000; margin: 0;">
        Puedes suscribirte en cualquier momento para continuar disfrutando de todas las funcionalidades. Tus datos estan seguros y el acceso se reactivara inmediatamente.
      </p>
    </div>

    <!-- CTA -->
    <div style="padding: 16px 0 24px 0; text-align: center;">
      <p style="font-size: 15px; color: #000; margin: 0 0 16px 0;">Listo para suscribirte?</p>
      <p style="font-size: 14px; color: #666; margin: 0;">
        Visita la seccion de facturacion en tu dashboard para activar tu suscripcion.
      </p>
    </div>

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0; font-size: 14px; color: #666;">
        Gracias por probar ${data.featureName}. Si tienes preguntas, estamos aqui para ayudarte.
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">Politica de Privacidad</a>
      </p>
    </div>

  </div>
</body>
</html>
    `

    const text = `
Hola,

Tu periodo de prueba de ${data.featureName} ha TERMINADO el ${expiredDateFormatted}.

Fecha de expiracion: ${expiredDateFormatted}

Tu acceso a ${data.featureName} ha sido desactivado temporalmente.

Te gusto ${data.featureName}?
Puedes suscribirte en cualquier momento para continuar disfrutando de todas las funcionalidades. Tus datos estan seguros y el acceso se reactivara inmediatamente.

Visita la seccion de facturacion en tu dashboard para activar tu suscripcion.

Gracias por probar ${data.featureName}. Si tienes preguntas, estamos aqui para ayudarte.

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
    const subject = `Verifica tu correo electronico`
    const logoUrl = 'https://avoqado.io/isotipo.svg'

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verifica tu correo</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header with Logo -->
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <!-- Title -->
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">Verifica tu correo</h1>
    </div>

    <!-- Content -->
    <div style="padding-bottom: 24px;">
      <p style="font-size: 16px; color: #000; margin: 0 0 16px 0;">Hola ${data.firstName},</p>
      <p style="font-size: 15px; color: #000; margin: 0 0 24px 0;">
        Gracias por registrarte en Avoqado. Para continuar, por favor verifica tu correo electronico usando el siguiente codigo:
      </p>
    </div>

    <!-- Verification Code Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 32px; margin-bottom: 24px; text-align: center;">
      <p style="margin: 0 0 12px 0; font-size: 13px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 500;">
        TU CODIGO DE VERIFICACION
      </p>
      <div style="font-size: 40px; font-weight: 600; color: #000; letter-spacing: 12px; font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace; line-height: 1.2;">
        ${data.verificationCode}
      </div>
    </div>

    <!-- Warning -->
    <div style="background: #fef3c7; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <p style="font-size: 14px; color: #92400e; margin: 0 0 4px 0; font-weight: 500;">
        Este codigo expirara en 10 minutos
      </p>
      <p style="font-size: 13px; color: #92400e; margin: 0;">
        Si no solicitaste este codigo, puedes ignorar este correo.
      </p>
    </div>

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0; font-size: 14px; color: #666;">
        Necesitas ayuda? Contactanos en cualquier momento.
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">Politica de Privacidad</a>
      </p>
    </div>

  </div>
</body>
</html>
    `

    const text = `
Hola ${data.firstName},

Gracias por registrarte en Avoqado. Para continuar, por favor verifica tu correo electronico usando el siguiente codigo:

Codigo de verificacion: ${data.verificationCode}

Este codigo expirara en 10 minutos.

Si no solicitaste este codigo, puedes ignorar este correo.

Necesitas ayuda? Contactanos en cualquier momento.

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
    const subject = `Restablece tu contrasena - Avoqado`
    const logoUrl = 'https://avoqado.io/isotipo.svg'

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Restablece tu contrasena</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header with Logo -->
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <!-- Title -->
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">Restablece tu contrasena</h1>
    </div>

    <!-- Content -->
    <div style="padding-bottom: 24px;">
      <p style="font-size: 16px; color: #000; margin: 0 0 16px 0;">Hola ${data.firstName},</p>
      <p style="font-size: 15px; color: #000; margin: 0 0 24px 0;">
        Recibimos una solicitud para restablecer la contrasena de tu cuenta de Avoqado. Haz clic en el boton de abajo para crear una nueva contrasena.
      </p>
    </div>

    <!-- CTA Button -->
    <div style="padding: 16px 0 24px 0; text-align: center;">
      <a href="${data.resetLink}" style="background: #000; color: #fff; padding: 14px 32px; text-decoration: none; border-radius: 4px; font-weight: 600; font-size: 14px; display: inline-block;">
        Restablecer Contrasena
      </a>
    </div>

    <!-- Link Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <p style="color: #666; margin: 0 0 8px 0; font-size: 13px; font-weight: 500;">
        O copia y pega este enlace:
      </p>
      <p style="color: #000; margin: 0; font-size: 13px; word-break: break-all; font-family: 'Courier New', monospace;">
        ${data.resetLink}
      </p>
    </div>

    <!-- Warning -->
    <div style="background: #fef3c7; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
      <p style="font-size: 14px; color: #92400e; margin: 0;">
        <strong>Expira en ${data.expiresInMinutes} minutos</strong><br>
        Este enlace solo puede usarse una vez por seguridad.
      </p>
    </div>

    <!-- Security Info -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <p style="font-size: 14px; color: #000; margin: 0;">
        <strong>No solicitaste esto?</strong><br>
        Si no pediste restablecer tu contrasena, ignora este correo. Tu cuenta esta segura.
      </p>
    </div>

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0; font-size: 14px; color: #666;">
        Necesitas ayuda? Contactanos en <a href="mailto:hola@avoqado.io" style="color: #1a73e8; text-decoration: none;">hola@avoqado.io</a>
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">Politica de Privacidad</a>
      </p>
    </div>

  </div>
</body>
</html>
    `

    const text = `
Restablece tu contrasena - Avoqado

Hola ${data.firstName},

Recibimos una solicitud para restablecer la contrasena de tu cuenta de Avoqado.

Para restablecer tu contrasena, visita el siguiente enlace:
${data.resetLink}

Este enlace expirara en ${data.expiresInMinutes} minutos y solo puede usarse una vez.

No solicitaste esto?
Si no pediste restablecer tu contrasena, ignora este correo. Tu cuenta esta segura.

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
    const subject = `Confirmacion de compra de terminales - ${data.venueName}`
    const logoUrl = 'https://avoqado.io/isotipo.svg'

    const shippingSpeedText =
      data.shippingSpeed === 'express'
        ? 'Express (2-3 dias)'
        : data.shippingSpeed === 'overnight'
          ? 'Nocturno (1 dia)'
          : 'Estandar (5-7 dias)'

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirmacion de Compra - ${data.venueName}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header with Logo -->
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <!-- Title -->
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">Compra Confirmada</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">${data.venueName}</p>
    </div>

    <!-- Content -->
    <div style="padding-bottom: 24px;">
      <p style="font-size: 16px; color: #000; margin: 0 0 16px 0;">Hola ${data.contactName},</p>
      <p style="font-size: 15px; color: #000; margin: 0 0 24px 0;">
        Gracias por tu compra! Hemos recibido tu orden de terminales PAX A910S. A continuacion encontraras los detalles de tu pedido:
      </p>
    </div>

    <!-- Order Details -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #000;">Detalles del Pedido</h3>
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Producto</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${data.productName}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Cantidad</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${data.quantity} ${data.quantity === 1 ? 'terminal' : 'terminales'}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Precio unitario</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">$${data.productPrice.toFixed(2)} ${data.currency}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Fecha de orden</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${new Date(data.orderDate).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })}</td>
        </tr>
      </table>
    </div>

    <!-- Shipping Info -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #000;">Informacion de Envio</h3>
      <p style="font-size: 14px; color: #000; margin: 0 0 8px 0;">
        ${data.shippingAddress}<br>
        ${data.shippingCity}, ${data.shippingState} ${data.shippingPostalCode}<br>
        ${data.shippingCountry}
      </p>
      <p style="font-size: 14px; color: #666; margin: 16px 0 0 0;">
        <strong>Velocidad de envio:</strong> ${shippingSpeedText}
      </p>
    </div>

    <!-- Payment Summary -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #000;">Resumen de Pago</h3>
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Subtotal (${data.quantity} ${data.quantity === 1 ? 'terminal' : 'terminales'})</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">$${data.subtotal.toFixed(2)} ${data.currency}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Envio</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">$${data.shippingCost.toFixed(2)} ${data.currency}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">IVA (16%)</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">$${data.tax.toFixed(2)} ${data.currency}</td>
        </tr>
        <tr style="border-top: 1px solid #e0e0e0;">
          <td style="padding: 16px 0 0 0; font-size: 16px; font-weight: 600; color: #000;">Total</td>
          <td style="padding: 16px 0 0 0; font-size: 16px; font-weight: 600; color: #000; text-align: right;">$${data.totalAmount.toFixed(2)} ${data.currency}</td>
        </tr>
      </table>
    </div>

    <!-- Next Steps -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <p style="font-size: 14px; font-weight: 600; color: #000; margin: 0 0 12px 0;">Proximos pasos:</p>
      <ol style="font-size: 14px; margin: 0; padding-left: 20px; color: #000;">
        <li style="margin-bottom: 8px;">Tus terminales seran enviados a la direccion proporcionada</li>
        <li style="margin-bottom: 8px;">Una vez que recibas los dispositivos, encontraras el <strong>numero de serie fisico</strong> en la parte posterior</li>
        <li style="margin-bottom: 8px;">Ingresa a tu dashboard de Avoqado y haz clic en <strong>"Activar"</strong> para registrar cada terminal</li>
        <li>Listo! Tus terminales estaran activos y listos para procesar pagos</li>
      </ol>
    </div>

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0; font-size: 14px; color: #666;">
        Si tienes alguna pregunta sobre tu pedido, no dudes en contactarnos.
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">Politica de Privacidad</a>
      </p>
    </div>

  </div>
</body>
</html>
    `

    const text = `
Compra confirmada! - ${data.venueName}

Hola ${data.contactName},

Gracias por tu compra! Hemos recibido tu orden de terminales PAX A910S.

DETALLES DEL PEDIDO
-------------------
Producto: ${data.productName}
Cantidad: ${data.quantity} ${data.quantity === 1 ? 'terminal' : 'terminales'}
Precio unitario: $${data.productPrice.toFixed(2)} ${data.currency}
Fecha de orden: ${new Date(data.orderDate).toLocaleDateString('es-MX')}

INFORMACION DE ENVIO
--------------------
${data.shippingAddress}
${data.shippingCity}, ${data.shippingState} ${data.shippingPostalCode}
${data.shippingCountry}

Velocidad de envio: ${shippingSpeedText}

RESUMEN DE PAGO
---------------
Subtotal: $${data.subtotal.toFixed(2)} ${data.currency}
Envio: $${data.shippingCost.toFixed(2)} ${data.currency}
IVA (16%): $${data.tax.toFixed(2)} ${data.currency}
-------------------
TOTAL: $${data.totalAmount.toFixed(2)} ${data.currency}

PROXIMOS PASOS:
1. Tus terminales seran enviados a la direccion proporcionada
2. Una vez que recibas los dispositivos, encontraras el numero de serie fisico en la parte posterior
3. Ingresa a tu dashboard de Avoqado y haz clic en "Activar" para registrar cada terminal
4. Listo! Tus terminales estaran activos y listos para procesar pagos

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

    const subject = `Nueva orden de terminales - ${data.venueName} (${data.quantity}x)`
    const logoUrl = 'https://avoqado.io/isotipo.svg'

    const shippingSpeedText =
      data.shippingSpeed === 'express'
        ? 'Express (2-3 dias)'
        : data.shippingSpeed === 'overnight'
          ? 'Nocturno (1 dia)'
          : 'Estandar (5-7 dias)'

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nueva Orden - ${data.venueName}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header with Logo -->
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <!-- Title -->
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">Nueva Orden de Terminales</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">Fecha: ${new Date(data.orderDate).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
    </div>

    <!-- Warning -->
    <div style="background: #fef3c7; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <p style="font-size: 14px; color: #92400e; margin: 0;">
        <strong>Accion requerida:</strong> Procesar orden y coordinar envio de terminales.
      </p>
    </div>

    <!-- Client Info -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #000;">Informacion del Cliente</h3>
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Restaurante</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${data.venueName}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Contacto</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${data.contactName}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Email</td>
          <td style="padding: 8px 0; font-size: 14px; text-align: right;"><a href="mailto:${data.contactEmail}" style="color: #1a73e8; text-decoration: none;">${data.contactEmail}</a></td>
        </tr>
      </table>
    </div>

    <!-- Order Details -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #000;">Detalles del Pedido</h3>
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Producto</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${data.productName}</td>
        </tr>
        <tr style="background: #f5f5f5;">
          <td style="padding: 12px 8px; font-size: 14px; color: #666;">Cantidad</td>
          <td style="padding: 12px 8px; font-size: 16px; font-weight: 600; color: #000; text-align: right;">${data.quantity} ${data.quantity === 1 ? 'terminal' : 'terminales'}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Precio unitario</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">$${data.productPrice.toFixed(2)} ${data.currency}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Total</td>
          <td style="padding: 8px 0; font-size: 16px; font-weight: 600; color: #000; text-align: right;">$${data.totalAmount.toFixed(2)} ${data.currency}</td>
        </tr>
      </table>
    </div>

    <!-- Shipping Address -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #000;">Direccion de Envio</h3>
      <p style="font-size: 14px; color: #000; margin: 0 0 8px 0;">
        <strong>${data.contactName}</strong><br>
        ${data.shippingAddress}<br>
        ${data.shippingCity}, ${data.shippingState} ${data.shippingPostalCode}<br>
        ${data.shippingCountry}
      </p>
      <p style="font-size: 14px; color: #666; margin: 16px 0 0 0;">
        <strong>Velocidad de envio:</strong> ${shippingSpeedText}
      </p>
    </div>

    <!-- Payment Summary -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #000;">Resumen Financiero</h3>
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Subtotal (${data.quantity}x)</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">$${data.subtotal.toFixed(2)} ${data.currency}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Envio</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">$${data.shippingCost.toFixed(2)} ${data.currency}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">IVA (16%)</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">$${data.tax.toFixed(2)} ${data.currency}</td>
        </tr>
        <tr style="border-top: 1px solid #e0e0e0;">
          <td style="padding: 16px 0 0 0; font-size: 16px; font-weight: 600; color: #000;">Total</td>
          <td style="padding: 16px 0 0 0; font-size: 16px; font-weight: 600; color: #000; text-align: right;">$${data.totalAmount.toFixed(2)} ${data.currency}</td>
        </tr>
      </table>
    </div>

    <!-- Next Actions -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <p style="font-size: 14px; font-weight: 600; color: #000; margin: 0 0 12px 0;">Proximas acciones:</p>
      <ol style="font-size: 14px; margin: 0; padding-left: 20px; color: #000;">
        <li style="margin-bottom: 8px;">Verificar disponibilidad de stock de terminales PAX A910S</li>
        <li style="margin-bottom: 8px;">Coordinar el envio ${shippingSpeedText} a la direccion proporcionada</li>
        <li style="margin-bottom: 8px;">Generar guia de rastreo y notificar al cliente</li>
        <li>El cliente activara las terminales cuando reciba los dispositivos fisicos</li>
      </ol>
    </div>

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0; font-size: 14px; color: #666;">
        Correo automatico enviado por Avoqado Dashboard
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

DIRECCION DE ENVIO
------------------
${data.contactName}
${data.shippingAddress}
${data.shippingCity}, ${data.shippingState} ${data.shippingPostalCode}
${data.shippingCountry}

Velocidad: ${shippingSpeedText}

RESUMEN FINANCIERO
------------------
Subtotal: $${data.subtotal.toFixed(2)} ${data.currency}
Envio: $${data.shippingCost.toFixed(2)} ${data.currency}
IVA (16%): $${data.tax.toFixed(2)} ${data.currency}
-------------------
TOTAL: $${data.totalAmount.toFixed(2)} ${data.currency}

PROXIMAS ACCIONES:
1. Verificar disponibilidad de stock
2. Coordinar el envio a la direccion proporcionada
3. Generar guia de rastreo y notificar al cliente
4. El cliente activara las terminales al recibir los dispositivos

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

  /**
   * Send TPV feedback email (bug report or feature suggestion)
   * Sent to hola@avoqado.io with device info and venue context
   */
  async sendTpvFeedbackEmail(data: TpvFeedbackEmailData): Promise<boolean> {
    const feedbackTypeLabel = data.feedbackType === 'bug' ? 'Reporte de Bug' : 'Sugerencia de Funcion'
    const subject = data.feedbackType === 'bug' ? `Reporte de bug - ${data.venueSlug}` : `Sugerencia - ${data.venueSlug}`
    const logoUrl = 'https://avoqado.io/isotipo.svg'

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${feedbackTypeLabel} - ${data.venueSlug}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header with Logo -->
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <!-- Title -->
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">${feedbackTypeLabel}</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">Desde TPV: ${data.venueSlug}</p>
    </div>

    <!-- Message Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #000;">Mensaje del Usuario:</h3>
      <div style="font-size: 14px; color: #000; white-space: pre-wrap; word-wrap: break-word;">${data.message}</div>
    </div>

    <!-- Device Info -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #000;">Informacion del Dispositivo</h3>
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666; width: 140px;">Venue</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000;"><strong>${data.venueSlug}</strong></td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">App Version</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000;">${data.appVersion}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Build</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000;">${data.buildVersion}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Android</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000;">${data.androidVersion}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">Device</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000;">${data.deviceManufacturer} ${data.deviceModel}</td>
        </tr>
      </table>
    </div>

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0; font-size: 14px; color: #666;">
        Este email fue enviado automaticamente desde Avoqado TPV
      </p>
      <p style="margin: 8px 0 0 0; font-size: 14px; color: #666;">
        Para responder al usuario, contacta directamente al venue: ${data.venueSlug}
      </p>
    </div>

  </div>
</body>
</html>
    `

    return this.sendEmail({
      to: 'hola@avoqado.io',
      subject,
      html,
    })
  }

  /**
   * Send daily sales summary email (similar to Square's daily digest)
   */
  async sendSalesSummaryEmail(
    email: string,
    data: {
      venueId: string
      venueName: string
      venueTimezone: string
      venueCurrency: string
      reportDate: Date
      businessHoursStart: string
      businessHoursEnd: string
      dashboardUrl: string
      metrics: {
        grossSales: number
        items: number
        serviceCosts: number
        discounts: number
        refunds: number
        netSales: number
        deferredSales: number
        taxes: number
        tips: number
        platformFees: number
        staffCommissions: number
        commissions: number
        totalCollected: number
        netProfit: number
        transactionCount: number
      }
      previousPeriod?: {
        netSales: number
        avgOrder: number
        transactionCount: number
      }
      categoryBreakdown: Array<{
        name: string
        itemsSold: number
        netSales: number
      }>
      orderSources: Array<{
        source: string
        orders: number
        netSales: number
        avgOrder: number
      }>
      customers?: {
        total: number
        new: number
        returning: number
      }
    },
    weeklyChange: number = 0,
  ): Promise<boolean> {
    const currency = data.venueCurrency || 'MXN'

    // Format currency
    const formatCurrency = (amount: number) => {
      return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(amount)
    }

    // Format percentage change
    const formatChange = (current: number, previous: number) => {
      if (previous === 0) return 'n/a'
      const change = ((current - previous) / previous) * 100
      const sign = change >= 0 ? '+' : ''
      return `${sign}${change.toFixed(1)}%`
    }

    // Format date in Spanish
    const reportDateFormatted = data.reportDate.toLocaleDateString('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      timeZone: data.venueTimezone,
    })

    const reportDateCapitalized = reportDateFormatted.charAt(0).toUpperCase() + reportDateFormatted.slice(1)

    // Calculate average order
    const avgOrder = data.metrics.transactionCount > 0 ? data.metrics.netSales / data.metrics.transactionCount : 0

    // Previous period values
    const _prevNetSales = data.previousPeriod?.netSales || 0
    const prevAvgOrder = data.previousPeriod?.avgOrder || 0

    // Format weekly change
    const weeklyChangeFormatted = weeklyChange !== 0 ? `${weeklyChange >= 0 ? '+' : ''}${weeklyChange.toFixed(1)}%` : 'n/a'
    const _weeklyChangeColor = weeklyChange >= 0 ? '#22c55e' : '#ef4444'

    const subject = `${reportDateCapitalized} - Resumen de ventas - ${data.venueName}`

    // Logo URL (hosted on avoqado.io)
    const logoUrl = 'https://avoqado.io/isotipo.svg'

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resumen de ventas - ${data.venueName}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header with Logo -->
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <!-- Title Section -->
    <div style="padding-bottom: 16px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000; line-height: 1.2;">${reportDateCapitalized}, ${data.venueName}</h1>
      <p style="margin: 0 0 8px 0; font-size: 14px; color: #000;">
        ${reportDateFormatted} ${data.businessHoursStart} - ${reportDateFormatted} ${data.businessHoursEnd} CST
      </p>
      <p style="margin: 0 0 8px 0; font-size: 14px; color: #666;">
        Este informe solo considera los pedidos cerrados y las ventas realizadas durante el horario comercial.
      </p>
      <p style="margin: 0; font-size: 14px; color: #666;">
        Consulta el <a href="${data.dashboardUrl}/reports" style="color: #1a73e8; text-decoration: none;">informe de conciliacion</a> para obtener mas informacion sobre los pagos y las transferencias anteriores.
      </p>
      <p style="margin: 16px 0 0 0;">
        <a href="${data.dashboardUrl}" style="color: #1a73e8; text-decoration: none; font-size: 14px;">Abrir Dashboard</a>
      </p>
    </div>

    <!-- Key Metrics Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; margin: 24px 0; overflow: hidden;">
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 24px; border-right: 1px solid #e0e0e0; width: 50%; vertical-align: top;">
            <div style="font-size: 14px; color: #666; margin-bottom: 8px;">Ventas netas</div>
            <div style="font-size: 36px; font-weight: 400; color: #000; margin-bottom: 4px;">${formatCurrency(data.metrics.netSales)}</div>
            <div style="font-size: 14px; color: #666;">${weeklyChangeFormatted} semanal</div>
            <div style="font-size: 14px; color: #666;">n/a anual</div>
          </td>
          <td style="padding: 24px; width: 50%; vertical-align: top;">
            <div style="font-size: 14px; color: #666; margin-bottom: 8px;">Pedido promedio</div>
            <div style="font-size: 36px; font-weight: 400; color: #000; margin-bottom: 4px;">${formatCurrency(avgOrder)}</div>
            <div style="font-size: 14px; color: #666;">${formatChange(avgOrder, prevAvgOrder)} semanal</div>
            <div style="font-size: 14px; color: #666;">n/a anual</div>
          </td>
        </tr>
      </table>
    </div>

    <!-- Sales Section -->
    <div style="margin: 32px 0;">
      <table cellpadding="0" cellspacing="0" style="width: 100%; margin-bottom: 16px;">
        <tr>
          <td><h2 style="margin: 0; font-size: 24px; font-weight: 400; color: #000;">Ventas<sup style="font-size: 12px;">1</sup></h2></td>
          <td style="text-align: right;">
            <a href="${data.dashboardUrl}/reports/sales" style="color: #1a73e8; text-decoration: none; font-size: 14px;">Mostrar mas &rarr;</a>
          </td>
        </tr>
      </table>

      <table cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse;">
        <tr style="border-bottom: 1px solid #e0e0e0;">
          <td style="padding: 12px 0; font-size: 14px; font-weight: 600; color: #000;">Descripcion</td>
          <td style="padding: 12px 0; font-size: 14px; font-weight: 600; color: #000; text-align: right;">Monto</td>
          <td style="padding: 12px 0; font-size: 14px; font-weight: 600; color: #000; text-align: right;">Semanal</td>
        </tr>
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0; font-size: 15px; font-weight: 600; color: #000;">Ventas brutas</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.metrics.grossSales)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: #666; text-align: right;">n/a</td>
        </tr>
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0 16px 24px; font-size: 15px; color: #000;">Ventas de articulos</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.metrics.items)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: #666; text-align: right;">n/a</td>
        </tr>
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0 16px 24px; font-size: 15px; color: #000;">Cobro por servicio</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.metrics.serviceCosts)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: #22c55e; text-align: right;">+0.0%</td>
        </tr>
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0; font-size: 15px; color: #000;">Devoluciones</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.metrics.refunds)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: #22c55e; text-align: right;">+0.0%</td>
        </tr>
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0; font-size: 15px; color: #000;">Descuentos y cortesias</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.metrics.discounts)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: #22c55e; text-align: right;">+0.0%</td>
        </tr>
        <tr style="border-bottom: 1px solid #e0e0e0;">
          <td style="padding: 16px 0; font-size: 15px; font-weight: 600; color: #000;">Ventas netas</td>
          <td style="padding: 16px 0; font-size: 15px; font-weight: 600; color: #000; text-align: right;">${formatCurrency(data.metrics.netSales)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: #666; text-align: right;">n/a</td>
        </tr>
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0; font-size: 15px; color: #000;">Impuestos</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.metrics.taxes)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: #22c55e; text-align: right;">+0.0%</td>
        </tr>
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0; font-size: 15px; color: #000;">Propinas</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.metrics.tips)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: #22c55e; text-align: right;">+0.0%</td>
        </tr>
        <tr style="border-bottom: 1px solid #e0e0e0;">
          <td style="padding: 16px 0; font-size: 15px; font-weight: 600; color: #000;">Total en ventas</td>
          <td style="padding: 16px 0; font-size: 15px; font-weight: 600; color: #000; text-align: right;">${formatCurrency(data.metrics.totalCollected)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: #666; text-align: right;">n/a</td>
        </tr>
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0; font-size: 15px; color: #000;">
            <a href="${data.dashboardUrl}/settings/billing" style="color: #1a73e8; text-decoration: none;">Comisiones<sup style="font-size: 10px;">2</sup> &rarr;</a>
          </td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.metrics.platformFees)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: #666; text-align: right;"></td>
        </tr>
      </table>
    </div>

    <!-- Category Breakdown -->
    ${
      data.categoryBreakdown.length > 0
        ? `
    <div style="margin: 32px 0;">
      <h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 400; color: #000;">Desglose de ventas</h2>

      <table cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse;">
        <tr style="border-bottom: 1px solid #e0e0e0;">
          <td style="padding: 12px 0; font-size: 14px; font-weight: 600; color: #000;">Categoria</td>
          <td style="padding: 12px 0; font-size: 14px; font-weight: 600; color: #000; text-align: right;">Articulos vendidos</td>
          <td style="padding: 12px 0; font-size: 14px; font-weight: 600; color: #000; text-align: right;">Ventas netas</td>
        </tr>
        ${data.categoryBreakdown
          .map(
            cat => `
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0; font-size: 15px; color: #000;">${cat.name}</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${cat.itemsSold}</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(cat.netSales)}<br><span style="font-size: 13px; color: #666;">n/a</span></td>
        </tr>
        `,
          )
          .join('')}
      </table>
    </div>
    `
        : ''
    }

    <!-- Order Sources -->
    ${
      data.orderSources.length > 0
        ? `
    <div style="margin: 32px 0;">
      <table cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse;">
        <tr style="border-bottom: 1px solid #e0e0e0;">
          <td style="padding: 12px 0; font-size: 14px; font-weight: 600; color: #000;">Origen del pedido</td>
          <td style="padding: 12px 0; font-size: 14px; font-weight: 600; color: #000; text-align: right;">Pedidos</td>
          <td style="padding: 12px 0; font-size: 14px; font-weight: 600; color: #000; text-align: right;">Ventas netas</td>
          <td style="padding: 12px 0; font-size: 14px; font-weight: 600; color: #000; text-align: right;">Pedido promedio</td>
        </tr>
        ${data.orderSources
          .map(
            src => `
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0; font-size: 15px; color: #000;">${src.source}</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${src.orders}</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(src.netSales)}</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(src.avgOrder)}</td>
        </tr>
        `,
          )
          .join('')}
      </table>
    </div>
    `
        : ''
    }

    <!-- Separator -->
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 40px 0;">

    <!-- Footer -->
    <div style="padding-top: 24px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0 0 16px 0; font-size: 14px; color: #000;">
        Avoqado Technologies S.A. de C.V.<br>
        Ciudad de Mexico, Mexico
      </p>
      <p style="margin: 0 0 8px 0; font-size: 12px; color: #666;">
        <sup>1</sup>No incluye transferencias, pagos o reembolsos parciales, incompletos o pendientes, ni ventas que se hayan tramitado sin conexion a Internet
      </p>
      <p style="margin: 0 0 24px 0; font-size: 12px; color: #666;">
        <sup>2</sup>Incluye tarifas de procesamiento de Avoqado y tarifas de cualquier tercero (p.ej. tarifas de envio)
      </p>
      <p style="margin: 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">Politica de Privacidad</a>
      </p>
      <p style="margin: 8px 0 0 0; font-size: 14px;">
        <a href="${data.dashboardUrl}/settings/notifications" style="color: #000; text-decoration: none; font-weight: 600;">Cancelar la suscripcion o administrar tus preferencias</a>
      </p>
    </div>

  </div>
</body>
</html>
    `

    const text = `
Resumen de ventas - ${data.venueName}
${reportDateCapitalized}
${reportDateFormatted} ${data.businessHoursStart} - ${data.businessHoursEnd} CST

METRICAS CLAVE
--------------
Ventas netas: ${formatCurrency(data.metrics.netSales)}
Pedido promedio: ${formatCurrency(avgOrder)}
Transacciones: ${data.metrics.transactionCount}

DESGLOSE DE VENTAS
------------------
Ventas brutas: ${formatCurrency(data.metrics.grossSales)}
Descuentos: ${formatCurrency(data.metrics.discounts)}
Devoluciones: ${formatCurrency(data.metrics.refunds)}
Ventas netas: ${formatCurrency(data.metrics.netSales)}
Impuestos: ${formatCurrency(data.metrics.taxes)}
Propinas: ${formatCurrency(data.metrics.tips)}
Total: ${formatCurrency(data.metrics.totalCollected)}
Comisiones: ${formatCurrency(data.metrics.platformFees)}

Ver mas detalles en: ${data.dashboardUrl}

---
Avoqado Technologies S.A. de C.V.
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
