import { Resend } from 'resend'
import logger from '../config/logger'

// Initialize Resend client
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const FROM_EMAIL = process.env.EMAIL_FROM || 'Avoqado <noreply@avoqado.io>'

interface EmailAttachment {
  filename: string
  content: Buffer | string
  contentType?: string
}

interface EmailOptions {
  to: string
  subject: string
  html?: string
  text?: string
  attachments?: EmailAttachment[]
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
  locale?: 'es' | 'en' // optional; defaults to 'es' so legacy à-la-carte Feature callers keep working
}

interface PaymentFailedEmailData {
  venueName: string
  featureName: string
  attemptCount: number
  amountDue: number
  currency: string
  billingPortalUrl: string
  last4?: string // Last 4 digits of card
  locale?: 'es' | 'en' // optional; defaults to 'es'
}

interface SubscriptionSuspendedEmailData {
  venueName: string
  featureName: string
  suspendedAt: Date
  gracePeriodEndsAt: Date
  billingPortalUrl: string
  locale?: 'es' | 'en' // optional; defaults to 'es'
}

interface SubscriptionCanceledEmailData {
  venueName: string
  featureName: string
  canceledAt: Date
  suspendedAt: Date
  locale?: 'es' | 'en' // optional; defaults to 'es'
}

interface TrialExpiredEmailData {
  venueName: string
  featureName: string
  expiredAt: Date
  locale?: 'es' | 'en' // optional; defaults to 'es'
}

export interface PlanConfirmationEmailData {
  locale: 'es' | 'en'
  venueName: string
  payNow: boolean // true = paid today, false = trial
  interval: 'monthly' | 'annual'
  firstChargeDate: Date // trial end (trial) OR next renewal (pay-now)
  firstChargeAmountCents: number // gross IVA-inclusive (115884 monthly / 1158840 annual)
  introAmountCents?: number // pay-now first charge (69484 = $694.84) when applicable
  billingPortalUrl: string
}

export interface PlanRenewalReminderEmailData {
  locale: 'es' | 'en'
  venueName: string
  interval: 'monthly' | 'annual'
  renewalDate: Date
  amountCents: number
  billingPortalUrl: string
}

export interface PlanWinbackEmailData {
  locale: 'es' | 'en'
  venueName: string
  reactivateUrl: string
}

export interface PlanCancellationEmailData {
  locale: 'es' | 'en'
  venueName: string
  /** When the plan actually ends (end of the paid period the venue already paid for). */
  accessUntil: Date
  /** Win-back: deadline to redeem the offer (e.g. now + 7 days). */
  redeemBy: Date
  /** Win-back: promo code to redeem (when a Stripe promotion code was minted); falls back to a generic message. */
  winbackCode?: string
  /** Win-back: discount percent surfaced in the copy (e.g. 30). */
  winbackPercentOff: number
  /** CTA → reactivate/billing page (carries ?winback=1). */
  reactivateUrl: string
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

export interface TerminalOrderEmailItem {
  productName: string
  brand: string
  model: string
  quantity: number
  unitPriceCents: number
  namePrefix: string
}

export interface TerminalOrderEmailData {
  order: {
    id: string
    orderNumber: string
    venueId: string
    contactName: string
    contactEmail: string
    contactPhone: string
    shippingAddress: string
    shippingAddress2: string | null
    shippingCity: string
    shippingState: string
    shippingZip: string
    shippingCountry: string
    paymentMethod: 'CARD_STRIPE' | 'SPEI'
    subtotalCents: number
    taxCents: number
    totalCents: number
    currency: string
    stripeReceiptUrl?: string | null
    createdAt: Date | string
  }
  items: TerminalOrderEmailItem[]
}

export interface TerminalOrderShippedEmailData extends TerminalOrderEmailData {
  terminals: Array<{
    id: string
    name: string
    serialNumber: string | null
    activationCode: string | null
    brand: string
    model: string
  }>
}

export interface SpeiInstructionsEmailData extends TerminalOrderEmailData {
  speiRecipient: {
    beneficiary: string
    clabe: string
    rfc: string
    bank: string
  }
  orderDetailUrl: string
}

export interface SpeiProofForSalesEmailData extends TerminalOrderEmailData {
  proofUrl: string
  proofMimeType: string
  approveUrl: string
  rejectUrl: string
  adminUiUrl: string
  isResubmit?: boolean
}

export interface SpeiRejectedEmailData extends TerminalOrderEmailData {
  reason: string
  orderDetailUrl: string
}

export interface SpeiReminderEmailData extends TerminalOrderEmailData {
  daysSinceCreation: number // 3 or 7
  daysRemaining: number // 11 or 7 (14-day SPEI expiry minus daysSinceCreation)
  orderDetailUrl: string
  speiRecipient: {
    beneficiary: string
    clabe: string
    rfc: string
    bank: string
  }
}

export interface SerialAssignmentRequestEmailData extends TerminalOrderEmailData {
  serialAssignmentUrl: string
  adminUiUrl: string
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

interface ReservationRescheduledEmailData {
  customerName: string
  venueName: string
  serviceName?: string
  oldDateTime: string // pre-formatted "16 de marzo de 2026, 11:00"
  newDateTime: string
  confirmationCode: string
  customMessage?: string
}

class EmailService {
  private isAvailable: boolean = false

  constructor() {
    this.initialize()
  }

  private initialize() {
    if (!resend) {
      logger.warn('📧 Resend not configured (missing RESEND_API_KEY). Email functionality will be disabled.')
      return
    }

    this.isAvailable = true
    logger.info('📧 Email service initialized with Resend (from: ' + FROM_EMAIL + ')')
  }

  async sendEmail(options: EmailOptions): Promise<boolean> {
    if (!resend || !this.isAvailable) {
      logger.warn('📧 Email service not available. Skipping email send.')
      return false
    }

    try {
      // Build email payload - Resend requires at least html or text
      const emailPayload: Parameters<typeof resend.emails.send>[0] = {
        from: FROM_EMAIL,
        to: options.to,
        subject: options.subject,
        html: options.html || undefined,
        text: options.text || 'Please view this email in an HTML-compatible email client.',
        ...(options.attachments?.length && {
          attachments: options.attachments.map(a => ({
            filename: a.filename,
            content: a.content instanceof Buffer ? a.content : Buffer.from(a.content as string, 'utf-8'),
            ...(a.contentType && { content_type: a.contentType }),
          })),
        }),
      }

      const result = await resend.emails.send(emailPayload)

      if (result.error) {
        logger.error('📧 Failed to send email:', result.error)
        return false
      }

      logger.info('📧 Email sent successfully:', { id: result.data?.id, to: options.to })
      return true
    } catch (error) {
      logger.error('📧 Failed to send email:', error)
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
        Servicios Tecnologicos Avo S.A. de C.V.<br>
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
    const locale = data.locale ?? 'es'
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const trialEndDateFormatted = data.trialEndDate.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-MX', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })

    const t =
      locale === 'en'
        ? {
            subject: `Your free trial of ${data.featureName} is ending soon - ${data.venueName}`,
            htmlTitle: 'Your free trial is ending soon',
            title: 'Your free trial is ending soon',
            greeting: 'Hi,',
            intro: `We're writing to remind you that your <strong>free trial of ${data.featureName}</strong> is ending on <strong>${trialEndDateFormatted}</strong>.`,
            importantLabel: 'Important',
            importantBody: `After this date, the feature will be deactivated automatically if you don't update your payment method. To keep using ${data.featureName} without interruptions, update your payment method now.`,
            cta: 'Go to Billing',
            footerCompanyLine: 'Servicios Tecnologicos Avo S.A. de C.V.<br>Mexico City, Mexico',
            footerHelp: 'Need help? Contact us anytime.',
            privacy: 'Privacy Policy',
            textIntro: `Your free trial of ${data.featureName} is ending on ${trialEndDateFormatted}.`,
            textImportant:
              "IMPORTANT: After this date, the feature will be deactivated automatically if you don't update your payment method.",
            textCallToAction: `To keep using ${data.featureName} without interruptions, update your payment method now:`,
            textHelp: 'Need help? Contact us anytime.',
            textSignoff: 'The Avoqado Team',
          }
        : {
            subject: `Tu prueba gratuita de ${data.featureName} esta por terminar - ${data.venueName}`,
            htmlTitle: 'Tu prueba gratuita esta por terminar',
            title: 'Tu prueba gratuita esta por terminar',
            greeting: 'Hola,',
            intro: `Te escribimos para recordarte que tu <strong>prueba gratuita de ${data.featureName}</strong> esta por terminar el <strong>${trialEndDateFormatted}</strong>.`,
            importantLabel: 'Importante',
            importantBody: `Despues de esta fecha, la funcion sera desactivada automaticamente si no actualizas tu metodo de pago. Para continuar usando ${data.featureName} sin interrupciones, actualiza tu metodo de pago ahora.`,
            cta: 'Ir a Facturacion',
            footerCompanyLine: 'Servicios Tecnologicos Avo S.A. de C.V.<br>Ciudad de Mexico, Mexico',
            footerHelp: 'Necesitas ayuda? Contactanos en cualquier momento.',
            privacy: 'Politica de Privacidad',
            textIntro: `Tu prueba gratuita de ${data.featureName} esta por terminar el ${trialEndDateFormatted}.`,
            textImportant:
              'IMPORTANTE: Despues de esta fecha, la funcion sera desactivada automaticamente si no actualizas tu metodo de pago.',
            textCallToAction: `Para continuar usando ${data.featureName} sin interrupciones, actualiza tu metodo de pago ahora:`,
            textHelp: 'Necesitas ayuda? Contactanos en cualquier momento.',
            textSignoff: 'Equipo de Avoqado',
          }

    const subject = t.subject

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t.htmlTitle}</title>
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
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">${t.title}</h1>
      <p style="margin: 0; font-size: 14px; color: #666;">${data.venueName}</p>
    </div>

    <!-- Content -->
    <div style="padding-bottom: 24px;">
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">${t.greeting}</p>

      <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
        ${t.intro}
      </p>

      <!-- Warning Box -->
      <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="font-size: 15px; margin: 0 0 8px 0; color: #000; font-weight: 600;">${t.importantLabel}</p>
        <p style="font-size: 14px; margin: 0; color: #666;">
          ${t.importantBody}
        </p>
      </div>
    </div>

    <!-- CTA Button -->
    <div style="padding: 32px 0; text-align: center;">
      <a href="${data.billingPortalUrl}" style="background: #000; color: #fff; padding: 14px 32px; text-decoration: none; border-radius: 4px; font-weight: 600; font-size: 14px; display: inline-block;">
        ${t.cta}
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
        ${t.footerCompanyLine}
      </p>
      <p style="margin: 0; font-size: 12px; color: #666;">
        ${t.footerHelp}
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">${t.privacy}</a>
      </p>
    </div>

  </div>
</body>
</html>
    `

    const text = `
${t.greeting}

${t.textIntro}

${t.textImportant}

${t.textCallToAction}

${data.billingPortalUrl}

${t.textHelp}

${t.textSignoff}
    `

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  async sendPaymentFailedEmail(email: string, data: PaymentFailedEmailData): Promise<boolean> {
    const locale = data.locale ?? 'es'
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const amountFormatted = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-MX', {
      style: 'currency',
      currency: data.currency.toUpperCase(),
    }).format(data.amountDue / 100)

    const t =
      locale === 'en'
        ? {
            subject: `Payment problem with ${data.featureName} - ${data.venueName}`,
            htmlTitle: 'Payment problem',
            title: 'Payment problem',
            greeting: 'Hi,',
            intro: `We couldn't process the payment of <strong>${amountFormatted}</strong> for your <strong>${data.featureName}</strong> subscription.`,
            cardEndingIn: (last4: string) => `Card ending in <strong>${last4}</strong>`,
            reasonsLabel: 'Common reasons for decline',
            reasons: ['Insufficient funds on the card', 'Card expired or about to expire', 'Credit limit reached', 'Temporary bank block'],
            cta: 'Update Payment Method',
            footerCompanyLine: 'Servicios Tecnologicos Avo S.A. de C.V.<br>Mexico City, Mexico',
            footerHelp: 'Need help? Contact us anytime or check with your bank.',
            privacy: 'Privacy Policy',
            attempt1: {
              level: 'Attempt 1 of 3',
              steps: "We'll try to charge again over the next few days. Please update your payment method as soon as possible.",
            },
            attempt2: {
              level: 'Attempt 2 of 3 - Action Required',
              steps: 'This is the second failed attempt. If the next attempt also fails, your subscription will be canceled automatically.',
            },
            attempt3: {
              level: 'LAST ATTEMPT - Urgent Action',
              steps: "This is the last attempt. If you don't update your payment method immediately, your subscription will be canceled.",
            },
            textIntro: `We couldn't process the payment of ${amountFormatted} for your ${data.featureName} subscription.`,
            textCardEndingIn: (last4: string) => `Card ending in ${last4}`,
            textCallToAction: 'Update your payment method now:',
            textReasonsLabel: 'Common reasons for decline:',
            textHelp: 'Need help? Contact us anytime or check with your bank.',
            textSignoff: 'The Avoqado Team',
          }
        : {
            subject: `Problema con el pago de ${data.featureName} - ${data.venueName}`,
            htmlTitle: 'Problema con el pago',
            title: 'Problema con el pago',
            greeting: 'Hola,',
            intro: `No pudimos procesar el pago de <strong>${amountFormatted}</strong> para tu suscripcion de <strong>${data.featureName}</strong>.`,
            cardEndingIn: (last4: string) => `Tarjeta terminada en <strong>${last4}</strong>`,
            reasonsLabel: 'Razones comunes de rechazo',
            reasons: [
              'Fondos insuficientes en la tarjeta',
              'Tarjeta vencida o cerca de vencer',
              'Limite de credito alcanzado',
              'Bloqueo temporal del banco',
            ],
            cta: 'Actualizar Metodo de Pago',
            footerCompanyLine: 'Servicios Tecnologicos Avo S.A. de C.V.<br>Ciudad de Mexico, Mexico',
            footerHelp: 'Necesitas ayuda? Contactanos en cualquier momento o verifica con tu banco.',
            privacy: 'Politica de Privacidad',
            attempt1: {
              level: 'Intento 1 de 3',
              steps: 'Intentaremos cobrar nuevamente en los proximos dias. Por favor, actualiza tu metodo de pago lo antes posible.',
            },
            attempt2: {
              level: 'Intento 2 de 3 - Accion Requerida',
              steps:
                'Este es el segundo intento fallido. Si el proximo intento tambien falla, tu suscripcion sera cancelada automaticamente.',
            },
            attempt3: {
              level: 'ULTIMO INTENTO - Accion Urgente',
              steps: 'Este es el ultimo intento. Si no actualizas tu metodo de pago inmediatamente, tu suscripcion sera cancelada.',
            },
            textIntro: `No pudimos procesar el pago de ${amountFormatted} para tu suscripcion de ${data.featureName}.`,
            textCardEndingIn: (last4: string) => `Tarjeta terminada en ${last4}`,
            textCallToAction: 'Actualiza tu metodo de pago ahora:',
            textReasonsLabel: 'Razones comunes de rechazo:',
            textHelp: 'Necesitas ayuda? Contactanos en cualquier momento o verifica con tu banco.',
            textSignoff: 'Equipo de Avoqado',
          }

    const subject = t.subject

    let urgencyLevel = ''
    let nextSteps = ''

    if (data.attemptCount === 1) {
      urgencyLevel = t.attempt1.level
      nextSteps = t.attempt1.steps
    } else if (data.attemptCount === 2) {
      urgencyLevel = t.attempt2.level
      nextSteps = t.attempt2.steps
    } else {
      urgencyLevel = t.attempt3.level
      nextSteps = t.attempt3.steps
    }

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t.htmlTitle}</title>
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
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">${t.title}</h1>
      <p style="margin: 0; font-size: 14px; color: #666;">${data.venueName}</p>
    </div>

    <!-- Content -->
    <div style="padding-bottom: 24px;">
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">${t.greeting}</p>

      <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
        ${t.intro}
      </p>

      <!-- Alert Box -->
      <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="font-size: 15px; margin: 0 0 8px 0; color: #000; font-weight: 600;">${urgencyLevel}</p>
        ${data.last4 ? `<p style="font-size: 14px; margin: 0 0 8px 0; color: #666;">${t.cardEndingIn(data.last4)}</p>` : ''}
        <p style="font-size: 14px; margin: 0; color: #666;">${nextSteps}</p>
      </div>

      <!-- Info Box -->
      <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="font-size: 15px; margin: 0 0 12px 0; color: #000; font-weight: 600;">${t.reasonsLabel}</p>
        <ul style="font-size: 14px; margin: 0; padding-left: 20px; color: #666;">
          ${t.reasons.map(r => `<li style="margin-bottom: 4px;">${r}</li>`).join('\n          ')}
        </ul>
      </div>
    </div>

    <!-- CTA Button -->
    <div style="padding: 32px 0; text-align: center;">
      <a href="${data.billingPortalUrl}" style="background: #000; color: #fff; padding: 14px 32px; text-decoration: none; border-radius: 4px; font-weight: 600; font-size: 14px; display: inline-block;">
        ${t.cta}
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
        ${t.footerCompanyLine}
      </p>
      <p style="margin: 0; font-size: 12px; color: #666;">
        ${t.footerHelp}
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">${t.privacy}</a>
      </p>
    </div>

  </div>
</body>
</html>
    `

    const text = `
${t.greeting}

${t.textIntro}

${urgencyLevel}
${data.last4 ? t.textCardEndingIn(data.last4) : ''}

${nextSteps}

${t.textCallToAction}
${data.billingPortalUrl}

${t.textReasonsLabel}
${t.reasons.map(r => `- ${r}`).join('\n')}

${t.textHelp}

${t.textSignoff}
    `

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  async sendSubscriptionSuspendedEmail(email: string, data: SubscriptionSuspendedEmailData): Promise<boolean> {
    const locale = data.locale ?? 'es'
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const dateLocale = locale === 'en' ? 'en-US' : 'es-MX'
    const suspendedDateFormatted = data.suspendedAt.toLocaleDateString(dateLocale, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    const cancellationDateFormatted = data.gracePeriodEndsAt.toLocaleDateString(dateLocale, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })

    const t =
      locale === 'en'
        ? {
            subject: `Your ${data.featureName} subscription has been suspended - ${data.venueName}`,
            htmlTitle: 'Subscription suspended',
            title: 'Subscription Suspended',
            greeting: 'Hi,',
            intro: `Your <strong>${data.featureName}</strong> subscription has been suspended due to multiple failed payment attempts.`,
            currentStatusLabel: 'Current status',
            currentStatusValue: `Access blocked since ${suspendedDateFormatted}`,
            cancellationLabel: 'Final cancellation date',
            warning: `If you don't update your payment method before ${cancellationDateFormatted}, your subscription will be canceled permanently.`,
            meaningLabel: 'What this means:',
            meaning: [
              `Your access to ${data.featureName} is currently blocked`,
              'Your data remains safe and saved',
              'You can reactivate your subscription by updating your payment method',
              `After ${cancellationDateFormatted}, the subscription will be canceled`,
            ],
            cta: 'Update Payment Method',
            footerHelp: 'Need help? Contact us anytime.',
            privacy: 'Privacy Policy',
            textSuspendedHeadline: `Your ${data.featureName} subscription has been SUSPENDED due to multiple failed payment attempts.`,
            textCurrentStatus: `Current status: Access blocked since ${suspendedDateFormatted}`,
            textCancellation: `Final cancellation date: ${cancellationDateFormatted}`,
            textMeaningLabel: 'What this means:',
            textCallToAction: 'Reactivate your subscription now:',
            textHelp: 'Need help? Contact us anytime.',
            textSignoff: 'The Avoqado Team',
          }
        : {
            subject: `Tu suscripcion de ${data.featureName} ha sido suspendida - ${data.venueName}`,
            htmlTitle: 'Suscripcion suspendida',
            title: 'Suscripcion Suspendida',
            greeting: 'Hola,',
            intro: `Tu suscripcion de <strong>${data.featureName}</strong> ha sido suspendida debido a multiples intentos de pago fallidos.`,
            currentStatusLabel: 'Estado actual',
            currentStatusValue: `Acceso bloqueado desde ${suspendedDateFormatted}`,
            cancellationLabel: 'Fecha de cancelacion definitiva',
            warning: `Si no actualizas tu metodo de pago antes del ${cancellationDateFormatted}, tu suscripcion sera cancelada permanentemente.`,
            meaningLabel: 'Que significa esto:',
            meaning: [
              `Tu acceso a ${data.featureName} esta actualmente bloqueado`,
              'Tus datos permanecen seguros y guardados',
              'Puedes reactivar tu suscripcion actualizando tu metodo de pago',
              `Despues del ${cancellationDateFormatted}, la suscripcion sera cancelada`,
            ],
            cta: 'Actualizar Metodo de Pago',
            footerHelp: 'Necesitas ayuda? Contactanos en cualquier momento.',
            privacy: 'Politica de Privacidad',
            textSuspendedHeadline: `Tu suscripcion de ${data.featureName} ha sido SUSPENDIDA debido a multiples intentos de pago fallidos.`,
            textCurrentStatus: `Estado actual: Acceso bloqueado desde ${suspendedDateFormatted}`,
            textCancellation: `Fecha de cancelacion definitiva: ${cancellationDateFormatted}`,
            textMeaningLabel: 'Que significa esto:',
            textCallToAction: 'Reactiva tu suscripcion ahora:',
            textHelp: 'Necesitas ayuda? Contactanos en cualquier momento.',
            textSignoff: 'Equipo de Avoqado',
          }

    const subject = t.subject

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t.htmlTitle}</title>
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
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">${t.title}</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">${data.venueName}</p>
    </div>

    <!-- Content -->
    <div style="padding-bottom: 24px;">
      <p style="font-size: 16px; color: #000; margin: 0 0 16px 0;">${t.greeting}</p>
      <p style="font-size: 15px; color: #000; margin: 0 0 24px 0;">
        ${t.intro}
      </p>
    </div>

    <!-- Status Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">${t.currentStatusLabel}</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${t.currentStatusValue}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">${t.cancellationLabel}</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${cancellationDateFormatted}</td>
        </tr>
      </table>
    </div>

    <!-- Warning -->
    <div style="background: #fef3c7; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <p style="font-size: 14px; color: #92400e; margin: 0;">
        ${t.warning}
      </p>
    </div>

    <!-- Info Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <p style="font-size: 14px; font-weight: 600; color: #000; margin: 0 0 12px 0;">${t.meaningLabel}</p>
      <ul style="font-size: 14px; margin: 0; padding-left: 20px; color: #000;">
        ${t.meaning.map(m => `<li style="margin-bottom: 8px;">${m}</li>`).join('\n        ')}
      </ul>
    </div>

    <!-- CTA Button -->
    <div style="padding: 24px 0; text-align: center;">
      <a href="${data.billingPortalUrl}" style="background: #000; color: #fff; padding: 14px 32px; text-decoration: none; border-radius: 4px; font-weight: 600; font-size: 14px; display: inline-block;">
        ${t.cta}
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
        ${t.footerHelp}
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">${t.privacy}</a>
      </p>
    </div>

  </div>
</body>
</html>
    `

    const text = `
${t.greeting}

${t.textSuspendedHeadline}

${t.textCurrentStatus}
${t.textCancellation}

${t.textMeaningLabel}
${t.meaning.map(m => `- ${m}`).join('\n')}

${t.textCallToAction}
${data.billingPortalUrl}

${t.textHelp}

${t.textSignoff}
    `

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  async sendSubscriptionCanceledEmail(email: string, data: SubscriptionCanceledEmailData): Promise<boolean> {
    const locale = data.locale ?? 'es'
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const dateLocale = locale === 'en' ? 'en-US' : 'es-MX'
    const canceledDateFormatted = data.canceledAt.toLocaleDateString(dateLocale, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    const suspendedDateFormatted = data.suspendedAt.toLocaleDateString(dateLocale, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })

    const t =
      locale === 'en'
        ? {
            subject: `Your ${data.featureName} subscription has been canceled - ${data.venueName}`,
            htmlTitle: 'Subscription canceled',
            title: 'Subscription Canceled',
            greeting: 'Hi,',
            intro: `Your <strong>${data.featureName}</strong> subscription has been permanently canceled on ${canceledDateFormatted} due to unresolved payment issues.`,
            suspensionLabel: 'Suspension date',
            cancellationLabel: 'Cancellation date',
            accessDeactivated: `Your access to ${data.featureName} has been completely deactivated.`,
            reactivateLabel: `Want to reactivate ${data.featureName}?`,
            reactivateBody:
              'You can reactivate your subscription at any time. Your previous data remains safe and you can regain access immediately after setting up your payment method.',
            ctaPrompt: 'Ready to come back?',
            ctaLink: 'Contact us to reactivate your subscription',
            footerNote: "We're sorry to see you go. If you need help or have questions, we're here for you.",
            privacy: 'Privacy Policy',
            textCanceledHeadline: `Your ${data.featureName} subscription has been PERMANENTLY CANCELED on ${canceledDateFormatted} due to unresolved payment issues.`,
            textSuspension: `Suspension date: ${suspendedDateFormatted}`,
            textCancellation: `Cancellation date: ${canceledDateFormatted}`,
            textAccessDeactivated: `Your access to ${data.featureName} has been completely deactivated.`,
            textReactivateLabel: `Want to reactivate ${data.featureName}?`,
            textReactivateBody:
              'You can reactivate your subscription at any time. Your previous data remains safe and you can regain access immediately after setting up your payment method.',
            textContact: 'Contact us if you need help: hola@avoqado.io',
            textFooterNote: "We're sorry to see you go. If you need help or have questions, we're here for you.",
            textSignoff: 'The Avoqado Team',
          }
        : {
            subject: `Tu suscripcion de ${data.featureName} ha sido cancelada - ${data.venueName}`,
            htmlTitle: 'Suscripcion cancelada',
            title: 'Suscripcion Cancelada',
            greeting: 'Hola,',
            intro: `Tu suscripcion de <strong>${data.featureName}</strong> ha sido cancelada permanentemente el ${canceledDateFormatted} debido a problemas de pago no resueltos.`,
            suspensionLabel: 'Fecha de suspension',
            cancellationLabel: 'Fecha de cancelacion',
            accessDeactivated: `Tu acceso a ${data.featureName} ha sido completamente desactivado.`,
            reactivateLabel: `Quieres volver a activar ${data.featureName}?`,
            reactivateBody:
              'Puedes reactivar tu suscripcion en cualquier momento. Tus datos previos permanecen seguros y podras recuperar el acceso inmediatamente despues de configurar tu metodo de pago.',
            ctaPrompt: 'Listo para volver?',
            ctaLink: 'Contactanos para reactivar tu suscripcion',
            footerNote: 'Lamentamos verte partir. Si necesitas ayuda o tienes preguntas, estamos aqui para ti.',
            privacy: 'Politica de Privacidad',
            textCanceledHeadline: `Tu suscripcion de ${data.featureName} ha sido CANCELADA PERMANENTEMENTE el ${canceledDateFormatted} debido a problemas de pago no resueltos.`,
            textSuspension: `Fecha de suspension: ${suspendedDateFormatted}`,
            textCancellation: `Fecha de cancelacion: ${canceledDateFormatted}`,
            textAccessDeactivated: `Tu acceso a ${data.featureName} ha sido completamente desactivado.`,
            textReactivateLabel: `Quieres volver a activar ${data.featureName}?`,
            textReactivateBody:
              'Puedes reactivar tu suscripcion en cualquier momento. Tus datos previos permanecen seguros y podras recuperar el acceso inmediatamente despues de configurar tu metodo de pago.',
            textContact: 'Contactanos si necesitas ayuda: hola@avoqado.io',
            textFooterNote: 'Lamentamos verte partir. Si necesitas ayuda o tienes preguntas, estamos aqui para ti.',
            textSignoff: 'Equipo de Avoqado',
          }

    const subject = t.subject

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t.htmlTitle}</title>
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
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">${t.title}</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">${data.venueName}</p>
    </div>

    <!-- Content -->
    <div style="padding-bottom: 24px;">
      <p style="font-size: 16px; color: #000; margin: 0 0 16px 0;">${t.greeting}</p>
      <p style="font-size: 15px; color: #000; margin: 0 0 24px 0;">
        ${t.intro}
      </p>
    </div>

    <!-- Status Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">${t.suspensionLabel}</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${suspendedDateFormatted}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">${t.cancellationLabel}</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${canceledDateFormatted}</td>
        </tr>
      </table>
      <p style="font-size: 14px; color: #666; margin: 16px 0 0 0;">
        ${t.accessDeactivated}
      </p>
    </div>

    <!-- Info Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <p style="font-size: 14px; font-weight: 600; color: #000; margin: 0 0 12px 0;">${t.reactivateLabel}</p>
      <p style="font-size: 14px; color: #000; margin: 0;">
        ${t.reactivateBody}
      </p>
    </div>

    <!-- CTA -->
    <div style="padding: 16px 0 24px 0; text-align: center;">
      <p style="font-size: 15px; color: #000; margin: 0 0 16px 0;">${t.ctaPrompt}</p>
      <a href="mailto:hola@avoqado.io" style="color: #1a73e8; text-decoration: none; font-weight: 600; font-size: 14px;">
        ${t.ctaLink}
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
        ${t.footerNote}
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">${t.privacy}</a>
      </p>
    </div>

  </div>
</body>
</html>
    `

    const text = `
${t.greeting}

${t.textCanceledHeadline}

${t.textSuspension}
${t.textCancellation}

${t.textAccessDeactivated}

${t.textReactivateLabel}
${t.textReactivateBody}

${t.textContact}

${t.textFooterNote}

${t.textSignoff}
    `

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  async sendTrialExpiredEmail(email: string, data: TrialExpiredEmailData): Promise<boolean> {
    const locale = data.locale ?? 'es'
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const expiredDateFormatted = data.expiredAt.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-MX', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })

    const t =
      locale === 'en'
        ? {
            subject: `Your ${data.featureName} trial has ended - ${data.venueName}`,
            htmlTitle: 'Trial period ended',
            title: 'Trial Period Ended',
            greeting: 'Hi,',
            intro: `Your <strong>${data.featureName}</strong> trial period ended on ${expiredDateFormatted}.`,
            expirationLabel: 'Expiration date',
            statusLabel: 'Status',
            statusValue: 'Access temporarily deactivated',
            likedLabel: `Did you like ${data.featureName}?`,
            likedBody:
              'You can subscribe at any time to keep enjoying all the features. Your data is safe and access will be restored immediately.',
            ctaPrompt: 'Ready to subscribe?',
            ctaBody: 'Visit the billing section in your dashboard to activate your subscription.',
            footerNote: `Thanks for trying ${data.featureName}. If you have questions, we're here to help.`,
            privacy: 'Privacy Policy',
            textExpiredHeadline: `Your ${data.featureName} trial period has ENDED on ${expiredDateFormatted}.`,
            textExpiration: `Expiration date: ${expiredDateFormatted}`,
            textAccess: `Your access to ${data.featureName} has been temporarily deactivated.`,
            textLikedLabel: `Did you like ${data.featureName}?`,
            textLikedBody:
              'You can subscribe at any time to keep enjoying all the features. Your data is safe and access will be restored immediately.',
            textCallToAction: 'Visit the billing section in your dashboard to activate your subscription.',
            textFooterNote: `Thanks for trying ${data.featureName}. If you have questions, we're here to help.`,
            textSignoff: 'The Avoqado Team',
          }
        : {
            subject: `Tu periodo de prueba de ${data.featureName} ha terminado - ${data.venueName}`,
            htmlTitle: 'Periodo de prueba terminado',
            title: 'Periodo de Prueba Terminado',
            greeting: 'Hola,',
            intro: `Tu periodo de prueba de <strong>${data.featureName}</strong> ha terminado el ${expiredDateFormatted}.`,
            expirationLabel: 'Fecha de expiracion',
            statusLabel: 'Estado',
            statusValue: 'Acceso desactivado temporalmente',
            likedLabel: `Te gusto ${data.featureName}?`,
            likedBody:
              'Puedes suscribirte en cualquier momento para continuar disfrutando de todas las funcionalidades. Tus datos estan seguros y el acceso se reactivara inmediatamente.',
            ctaPrompt: 'Listo para suscribirte?',
            ctaBody: 'Visita la seccion de facturacion en tu dashboard para activar tu suscripcion.',
            footerNote: `Gracias por probar ${data.featureName}. Si tienes preguntas, estamos aqui para ayudarte.`,
            privacy: 'Politica de Privacidad',
            textExpiredHeadline: `Tu periodo de prueba de ${data.featureName} ha TERMINADO el ${expiredDateFormatted}.`,
            textExpiration: `Fecha de expiracion: ${expiredDateFormatted}`,
            textAccess: `Tu acceso a ${data.featureName} ha sido desactivado temporalmente.`,
            textLikedLabel: `Te gusto ${data.featureName}?`,
            textLikedBody:
              'Puedes suscribirte en cualquier momento para continuar disfrutando de todas las funcionalidades. Tus datos estan seguros y el acceso se reactivara inmediatamente.',
            textCallToAction: 'Visita la seccion de facturacion en tu dashboard para activar tu suscripcion.',
            textFooterNote: `Gracias por probar ${data.featureName}. Si tienes preguntas, estamos aqui para ayudarte.`,
            textSignoff: 'Equipo de Avoqado',
          }

    const subject = t.subject

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t.htmlTitle}</title>
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
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">${t.title}</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">${data.venueName}</p>
    </div>

    <!-- Content -->
    <div style="padding-bottom: 24px;">
      <p style="font-size: 16px; color: #000; margin: 0 0 16px 0;">${t.greeting}</p>
      <p style="font-size: 15px; color: #000; margin: 0 0 24px 0;">
        ${t.intro}
      </p>
    </div>

    <!-- Status Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">${t.expirationLabel}</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${expiredDateFormatted}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #666;">${t.statusLabel}</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${t.statusValue}</td>
        </tr>
      </table>
    </div>

    <!-- Info Box -->
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <p style="font-size: 14px; font-weight: 600; color: #000; margin: 0 0 12px 0;">${t.likedLabel}</p>
      <p style="font-size: 14px; color: #000; margin: 0;">
        ${t.likedBody}
      </p>
    </div>

    <!-- CTA -->
    <div style="padding: 16px 0 24px 0; text-align: center;">
      <p style="font-size: 15px; color: #000; margin: 0 0 16px 0;">${t.ctaPrompt}</p>
      <p style="font-size: 14px; color: #666; margin: 0;">
        ${t.ctaBody}
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
        ${t.footerNote}
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">${t.privacy}</a>
      </p>
    </div>

  </div>
</body>
</html>
    `

    const text = `
${t.greeting}

${t.textExpiredHeadline}

${t.textExpiration}

${t.textAccess}

${t.textLikedLabel}
${t.textLikedBody}

${t.textCallToAction}

${t.textFooterNote}

${t.textSignoff}
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
   * Send payment confirmation email to customer after a TPV Shop order is paid.
   * Sent to order.contactEmail after the Stripe checkout.session.completed webhook (or SPEI confirmation) flips the order to PAID.
   */
  async sendTerminalOrderPaymentConfirmed(data: TerminalOrderEmailData): Promise<boolean> {
    const { order, items } = data
    const subject = `✅ Pago confirmado ${order.orderNumber}`
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const fmtMx = (cents: number) =>
      `$${(cents / 100).toLocaleString('es-MX', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} ${order.currency}`

    const itemsRows = items
      .map(
        i => `
        <tr>
          <td style="padding: 8px 0; font-size: 14px; color: #000;">${i.productName} × ${i.quantity}</td>
          <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${fmtMx(i.unitPriceCents * i.quantity)}</td>
        </tr>`,
      )
      .join('')

    const receiptLink = order.stripeReceiptUrl
      ? `<p style="margin: 16px 0 0 0; font-size: 14px;"><a href="${order.stripeReceiptUrl}" style="color: #1a73e8; text-decoration: none;">Ver recibo de Stripe →</a></p>`
      : ''

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Pago confirmado ${order.orderNumber}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">Pago confirmado</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">Pedido ${order.orderNumber}</p>
    </div>
    <div style="background: #ecfdf5; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <p style="font-size: 14px; color: #065f46; margin: 0;">
        Recibimos tu pago. Te avisamos cuando enviemos los terminales con sus números de serie.
      </p>
    </div>
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #000;">Resumen</h3>
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        ${itemsRows}
        <tr><td style="padding: 8px 0; font-size: 14px; color: #666;">Subtotal</td><td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${fmtMx(order.subtotalCents)}</td></tr>
        <tr><td style="padding: 8px 0; font-size: 14px; color: #666;">IVA (16%)</td><td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${fmtMx(order.taxCents)}</td></tr>
        <tr style="border-top: 1px solid #e0e0e0;"><td style="padding: 16px 0 0 0; font-size: 16px; font-weight: 600;">Total</td><td style="padding: 16px 0 0 0; font-size: 16px; font-weight: 600; text-align: right;">${fmtMx(order.totalCents)}</td></tr>
      </table>
      ${receiptLink}
    </div>
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0; font-size: 14px; color: #666;">Correo automático enviado por Avoqado Dashboard</p>
    </div>
  </div>
</body></html>`

    const text =
      `Pago confirmado — ${order.orderNumber}\n\n` +
      items.map(i => `${i.productName} × ${i.quantity}: ${fmtMx(i.unitPriceCents * i.quantity)}`).join('\n') +
      `\n\nSubtotal: ${fmtMx(order.subtotalCents)}\nIVA (16%): ${fmtMx(order.taxCents)}\nTotal: ${fmtMx(order.totalCents)}\n` +
      (order.stripeReceiptUrl ? `\nRecibo: ${order.stripeReceiptUrl}\n` : '') +
      `\nTe avisamos cuando enviemos los terminales.\n\nAvoqado`

    return this.sendEmail({ to: order.contactEmail, subject, html, text })
  }

  /**
   * Send serial-assignment request to the sales team after a TPV Shop order is paid.
   * Sent to ORDER_NOTIFICATIONS_EMAIL — sales clicks the link, signs in to /superadmin, and assigns serials.
   */
  async sendTerminalOrderSerialAssignmentRequest(data: SerialAssignmentRequestEmailData): Promise<boolean> {
    const adminEmail = process.env.ORDER_NOTIFICATIONS_EMAIL
    if (!adminEmail) {
      logger.warn('ORDER_NOTIFICATIONS_EMAIL not configured — skipping serial-assignment notification')
      return false
    }

    const { order, items, serialAssignmentUrl, adminUiUrl } = data
    const subject = `💰 Asigna números de serie — ${order.orderNumber}`
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const fmtMx = (cents: number) =>
      `$${(cents / 100).toLocaleString('es-MX', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} ${order.currency}`

    const itemsRows = items
      .map(
        i => `
      <tr>
        <td style="padding: 8px 0; font-size: 14px; color: #000;">${i.productName}</td>
        <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${i.quantity} unidad${i.quantity === 1 ? '' : 'es'}</td>
      </tr>`,
      )
      .join('')

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Asigna serials ${order.orderNumber}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 400;">Pedido pagado — Asigna serials</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">${order.orderNumber} · ${order.contactName}</p>
    </div>
    <div style="background: #fef3c7; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <p style="font-size: 14px; color: #92400e; margin: 0;"><strong>Acción requerida:</strong> Asigna los números de serie de los dispositivos a enviar y se notifica automáticamente al cliente.</p>
    </div>
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600;">Items a asignar</h3>
      <table cellpadding="0" cellspacing="0" style="width: 100%;">${itemsRows}</table>
      <p style="margin: 16px 0 0 0; font-size: 14px; color: #666;">Total cobrado: <strong style="color: #000;">${fmtMx(order.totalCents)}</strong></p>
    </div>
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600;">Envío a</h3>
      <p style="font-size: 14px; margin: 0;"><strong>${order.contactName}</strong><br>${order.shippingAddress}${order.shippingAddress2 ? `, ${order.shippingAddress2}` : ''}<br>${order.shippingCity}, ${order.shippingState} ${order.shippingZip}<br>${order.shippingCountry}<br><br>Teléfono: ${order.contactPhone}<br>Email: ${order.contactEmail}</p>
    </div>
    <div style="text-align: center; margin-bottom: 24px;">
      <a href="${serialAssignmentUrl}" style="display: inline-block; background: #000; color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">Asignar números de serie</a>
    </div>
    <div style="text-align: center; margin-bottom: 32px;">
      <a href="${adminUiUrl}" style="font-size: 13px; color: #666; text-decoration: none;">Ver en admin UI (login requerido) →</a>
    </div>
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <p style="margin: 0; font-size: 14px; color: #666;">Avoqado · Notificación de pedido pagado</p>
    </div>
  </div>
</body></html>`

    const text =
      `Pedido pagado — ${order.orderNumber}\n\n` +
      items.map(i => `${i.productName} × ${i.quantity}`).join('\n') +
      `\n\nTotal: ${fmtMx(order.totalCents)}\nCliente: ${order.contactName} <${order.contactEmail}>\nTeléfono: ${order.contactPhone}\n\nEnvío: ${order.shippingAddress}, ${order.shippingCity}, ${order.shippingState}, ${order.shippingZip}\n\nAsignar serials: ${serialAssignmentUrl}\nAdmin UI:        ${adminUiUrl}\n`

    return this.sendEmail({ to: adminEmail, subject, html, text })
  }

  /**
   * Notify the customer that their terminals have been assigned and are shipping.
   * Sent to order.contactEmail after sales assigns serial numbers + activation codes.
   */
  async sendTerminalOrderTerminalsShipped(data: TerminalOrderShippedEmailData): Promise<boolean> {
    const { order, terminals } = data
    const subject = `📦 Tu pedido ${order.orderNumber} está en camino`
    const logoUrl = 'https://avoqado.io/isotipo.svg'

    const termRows = terminals
      .map(
        t => `
      <tr style="background: #f5f5f5;">
        <td style="padding: 12px 8px; font-size: 14px; color: #000;"><strong>${t.name}</strong><br><span style="font-size: 12px; color: #666;">${t.brand} ${t.model}</span></td>
        <td style="padding: 12px 8px; font-size: 13px; color: #000; font-family: monospace;">${t.serialNumber ?? '—'}</td>
        <td style="padding: 12px 8px; font-size: 16px; color: #000; font-family: monospace; font-weight: 600; text-align: center;">${t.activationCode ?? '—'}</td>
      </tr>`,
      )
      .join('')

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Tu pedido está en camino</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400;">📦 Tu pedido está en camino</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">Pedido ${order.orderNumber}</p>
    </div>
    <div style="background: #ecfdf5; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <p style="font-size: 14px; color: #065f46; margin: 0;">Tus terminales fueron asignados y se enviarán pronto. Cuando los recibas, usa los códigos de activación para encenderlos.</p>
    </div>
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600;">Terminales asignados</h3>
      <table cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse;">
        <thead><tr><th style="padding: 8px; text-align: left; font-size: 12px; color: #666; text-transform: uppercase;">Nombre / Modelo</th><th style="padding: 8px; text-align: left; font-size: 12px; color: #666; text-transform: uppercase;">Serial</th><th style="padding: 8px; text-align: center; font-size: 12px; color: #666; text-transform: uppercase;">Código activación</th></tr></thead>
        <tbody>${termRows}</tbody>
      </table>
    </div>
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600;">Cómo activarlos</h3>
      <ol style="font-size: 14px; margin: 0; padding-left: 20px; color: #000;">
        <li style="margin-bottom: 8px;">Enciende el dispositivo físico (PAX A910S, NexGo N62 o N86).</li>
        <li style="margin-bottom: 8px;">Abre la app Avoqado TPV.</li>
        <li style="margin-bottom: 8px;">Ingresa el código de activación de 6 caracteres correspondiente.</li>
        <li>El terminal queda listo para procesar pagos.</li>
      </ol>
      <p style="font-size: 13px; color: #92400e; background: #fef3c7; padding: 12px; border-radius: 6px; margin: 16px 0 0 0;">⚠️ Los códigos de activación expiran a los 30 días. Activa cuanto antes.</p>
    </div>
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <p style="margin: 0; font-size: 14px; color: #666;">Avoqado · Pedido enviado</p>
    </div>
  </div>
</body></html>`

    const text =
      `Tu pedido ${order.orderNumber} está en camino\n\n` +
      terminals
        .map(t => `${t.name} (${t.brand} ${t.model}) — Serial: ${t.serialNumber ?? '—'} — Código activación: ${t.activationCode ?? '—'}`)
        .join('\n') +
      `\n\nLos códigos expiran a los 30 días.\n\nAvoqado`

    return this.sendEmail({ to: order.contactEmail, subject, html, text })
  }

  /**
   * SPEI Email #1: SPEI payment instructions sent to the customer
   * Sent right after createOrder when paymentMethod = SPEI
   */
  async sendTerminalOrderSpeiInstructions(data: SpeiInstructionsEmailData): Promise<boolean> {
    const { order, items, speiRecipient, orderDetailUrl } = data
    const subject = `Datos para completar tu pedido ${order.orderNumber}`
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const fmtMx = (cents: number) =>
      `$${(cents / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${order.currency}`

    const itemsRows = items
      .map(
        i => `
      <tr>
        <td style="padding: 8px 0; font-size: 14px; color: #000;">${i.productName} × ${i.quantity}</td>
        <td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${fmtMx(i.unitPriceCents * i.quantity)}</td>
      </tr>`,
      )
      .join('')

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>SPEI ${order.orderNumber}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 400; color: #000;">Completa tu pago por SPEI</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">Pedido ${order.orderNumber}</p>
    </div>
    <div style="background: #eff6ff; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <p style="font-size: 14px; color: #1e3a8a; margin: 0;">
        Haz la transferencia SPEI con estos datos y sube el comprobante en tu dashboard.
        Verificamos el depósito en 1-2 días hábiles.
      </p>
    </div>
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #000;">Datos para la transferencia</h3>
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        <tr><td style="padding: 8px 0; font-size: 14px; color: #666;">Beneficiario</td><td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${speiRecipient.beneficiary}</td></tr>
        <tr style="background: #f5f5f5;"><td style="padding: 12px 8px; font-size: 14px; color: #666;">CLABE</td><td style="padding: 12px 8px; font-size: 16px; color: #000; text-align: right; font-family: monospace; font-weight: 600;">${speiRecipient.clabe}</td></tr>
        <tr><td style="padding: 8px 0; font-size: 14px; color: #666;">Banco</td><td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${speiRecipient.bank}</td></tr>
        <tr><td style="padding: 8px 0; font-size: 14px; color: #666;">RFC</td><td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right; font-family: monospace;">${speiRecipient.rfc}</td></tr>
        <tr style="background: #fef3c7;"><td style="padding: 12px 8px; font-size: 14px; color: #666;">Monto exacto</td><td style="padding: 12px 8px; font-size: 18px; font-weight: 700; color: #000; text-align: right;">${fmtMx(order.totalCents)}</td></tr>
        <tr style="background: #fef3c7;"><td style="padding: 12px 8px; font-size: 14px; color: #666;">Concepto</td><td style="padding: 12px 8px; font-size: 16px; color: #000; text-align: right; font-family: monospace; font-weight: 600;">${order.orderNumber}</td></tr>
      </table>
    </div>
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600;">Resumen de tu pedido</h3>
      <table cellpadding="0" cellspacing="0" style="width: 100%;">
        ${itemsRows}
        <tr><td style="padding: 8px 0; font-size: 14px; color: #666;">Subtotal</td><td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${fmtMx(order.subtotalCents)}</td></tr>
        <tr><td style="padding: 8px 0; font-size: 14px; color: #666;">IVA (16%)</td><td style="padding: 8px 0; font-size: 14px; color: #000; text-align: right;">${fmtMx(order.taxCents)}</td></tr>
        <tr style="border-top: 1px solid #e0e0e0;"><td style="padding: 16px 0 0 0; font-size: 16px; font-weight: 600;">Total</td><td style="padding: 16px 0 0 0; font-size: 16px; font-weight: 600; text-align: right;">${fmtMx(order.totalCents)}</td></tr>
      </table>
    </div>
    <div style="text-align: center; margin-bottom: 32px;">
      <a href="${orderDetailUrl}" style="display: inline-block; background: #000; color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">Subir comprobante</a>
      <p style="margin: 12px 0 0 0; font-size: 12px; color: #666;">Una vez que hagas la transferencia, sube el comprobante (PDF o imagen) en tu dashboard.</p>
    </div>
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <p style="margin: 0; font-size: 14px; color: #666;">Avoqado · Notificación de pedido</p>
    </div>
  </div>
</body></html>`

    const text =
      `Datos SPEI — ${order.orderNumber}\n\n` +
      `Beneficiario: ${speiRecipient.beneficiary}\n` +
      `CLABE: ${speiRecipient.clabe}\n` +
      `Banco: ${speiRecipient.bank}\n` +
      `RFC: ${speiRecipient.rfc}\n` +
      `Monto exacto: ${fmtMx(order.totalCents)}\n` +
      `Concepto: ${order.orderNumber}\n\n` +
      `Sube tu comprobante en: ${orderDetailUrl}\n\nAvoqado`

    return this.sendEmail({ to: order.contactEmail, subject, html, text })
  }

  /**
   * SPEI Email #2: SPEI proof notification to sales with attachment + magic links
   * Sent when the customer uploads a payment proof. Includes approve/reject token URLs.
   */
  async sendTerminalOrderSpeiProofForSales(data: SpeiProofForSalesEmailData): Promise<boolean> {
    const adminEmail = process.env.ORDER_NOTIFICATIONS_EMAIL
    if (!adminEmail) {
      logger.warn('ORDER_NOTIFICATIONS_EMAIL not configured — skipping SPEI-proof notification')
      return false
    }

    const { order, items, proofUrl, proofMimeType, approveUrl, rejectUrl, adminUiUrl, isResubmit } = data
    const subject = isResubmit ? `🔁 Re-aprobar SPEI — ${order.orderNumber}` : `⏳ Aprobar SPEI — ${order.orderNumber}`
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const fmtMx = (cents: number) =>
      `$${(cents / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${order.currency}`

    const itemsRows = items
      .map(
        i => `
      <tr>
        <td style="padding: 8px 0; font-size: 14px;">${i.productName}</td>
        <td style="padding: 8px 0; font-size: 14px; text-align: right;">${i.quantity} u.</td>
      </tr>`,
      )
      .join('')

    // Try to fetch the proof file and attach. If too large (>5MB), fall back to URL only.
    let attachments: EmailAttachment[] | undefined
    try {
      const res = await fetch(proofUrl)
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        const MAX_ATTACH = 5 * 1024 * 1024
        if (buf.byteLength <= MAX_ATTACH) {
          const ext =
            proofMimeType === 'application/pdf'
              ? 'pdf'
              : proofMimeType === 'image/png'
                ? 'png'
                : proofMimeType === 'image/webp'
                  ? 'webp'
                  : 'jpg'
          attachments = [{ filename: `comprobante-${order.orderNumber}.${ext}`, content: buf, contentType: proofMimeType }]
        } else {
          logger.warn('SPEI proof too large for attachment, falling back to link only', {
            orderId: order.id,
            size: buf.byteLength,
          })
        }
      }
    } catch (err) {
      logger.warn('Could not fetch SPEI proof for attachment', {
        orderId: order.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 26px; font-weight: 400;">${isResubmit ? 'Comprobante re-subido' : 'Comprobante SPEI recibido'}</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">${order.orderNumber} · ${order.contactName} · ${fmtMx(order.totalCents)}</p>
    </div>
    <div style="background: #fef3c7; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <p style="font-size: 14px; color: #92400e; margin: 0;"><strong>Acción requerida:</strong> Verifica en el banco que llegó el SPEI por ${fmtMx(order.totalCents)} con concepto <strong>${order.orderNumber}</strong>, después aprueba o rechaza.</p>
    </div>
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600;">Items</h3>
      <table cellpadding="0" cellspacing="0" style="width: 100%;">${itemsRows}</table>
    </div>
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600;">Comprobante</h3>
      <p style="font-size: 14px; margin: 0;">
        ${attachments ? 'Adjunto en este correo' : 'No se pudo adjuntar (demasiado grande o no disponible)'}.
      </p>
      <p style="font-size: 13px; margin: 8px 0 0 0;">
        <a href="${proofUrl}" style="color: #1a73e8; text-decoration: none;">Ver comprobante online →</a>
      </p>
    </div>
    <div style="text-align: center; margin-bottom: 24px;">
      <a href="${approveUrl}" style="display: inline-block; background: #059669; color: #fff; padding: 14px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; margin-right: 12px;">✅ Aprobar pedido</a>
      <a href="${rejectUrl}" style="display: inline-block; background: #dc2626; color: #fff; padding: 14px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">❌ Rechazar pago</a>
    </div>
    <div style="text-align: center; margin-bottom: 32px;">
      <a href="${adminUiUrl}" style="font-size: 13px; color: #666; text-decoration: none;">Ver en admin UI (login requerido) →</a>
    </div>
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <p style="margin: 0; font-size: 14px; color: #666;">Los botones expiran a los 7 días. Token único, single-use.</p>
    </div>
  </div>
</body></html>`

    const text =
      `${subject}\n\n` +
      `Cliente: ${order.contactName} <${order.contactEmail}>\n` +
      `Monto: ${fmtMx(order.totalCents)}\n` +
      `Concepto SPEI: ${order.orderNumber}\n\n` +
      `Comprobante: ${proofUrl}\n\n` +
      `Aprobar: ${approveUrl}\n` +
      `Rechazar: ${rejectUrl}\n` +
      `Admin UI: ${adminUiUrl}\n`

    return this.sendEmail({
      to: adminEmail,
      subject,
      html,
      text,
      attachments,
    })
  }

  /**
   * SPEI Email #3: SPEI proof rejected — sent to the customer with a reason and a link
   * back to the order detail page so they can re-upload.
   */
  async sendTerminalOrderSpeiRejected(data: SpeiRejectedEmailData): Promise<boolean> {
    const { order, reason, orderDetailUrl } = data
    const subject = `Necesitamos verificar tu pago ${order.orderNumber}`
    const logoUrl = 'https://avoqado.io/isotipo.svg'

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 26px; font-weight: 400;">Necesitamos verificar tu pago</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">Pedido ${order.orderNumber}</p>
    </div>
    <div style="background: #fef3c7; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <p style="font-size: 14px; color: #92400e; margin: 0 0 8px 0;"><strong>No pudimos confirmar tu pago.</strong></p>
      <p style="font-size: 14px; color: #92400e; margin: 0;">Motivo: ${reason}</p>
    </div>
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <p style="margin: 0 0 12px 0; font-size: 14px;">Por favor verifica los datos del comprobante (monto exacto, concepto = <strong>${order.orderNumber}</strong>) y vuelve a subirlo desde tu dashboard.</p>
    </div>
    <div style="text-align: center; margin-bottom: 32px;">
      <a href="${orderDetailUrl}" style="display: inline-block; background: #000; color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">Volver a subir comprobante</a>
    </div>
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <p style="margin: 0; font-size: 14px; color: #666;">Si tienes dudas, escríbenos a sales@avoqado.io.</p>
    </div>
  </div>
</body></html>`

    const text =
      `Necesitamos verificar tu pago ${order.orderNumber}\n\n` +
      `Motivo: ${reason}\n\n` +
      `Vuelve a subir el comprobante: ${orderDetailUrl}\n\nAvoqado`

    return this.sendEmail({ to: order.contactEmail, subject, html, text })
  }

  async sendTerminalOrderSpeiReminder(data: SpeiReminderEmailData): Promise<boolean> {
    const { order, daysSinceCreation, daysRemaining, orderDetailUrl, speiRecipient } = data
    const subject = `Recordatorio: pago pendiente ${order.orderNumber}`
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const fmtMx = (cents: number) =>
      `$${(cents / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${order.currency}`

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 26px; font-weight: 400;">Recordatorio de pago</h1>
      <p style="margin: 0; font-size: 16px; color: #666;">Pedido ${order.orderNumber} · creado hace ${daysSinceCreation} día${daysSinceCreation === 1 ? '' : 's'}</p>
    </div>
    <div style="background: #fef3c7; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      <p style="font-size: 14px; color: #92400e; margin: 0;">
        Aún no recibimos tu comprobante SPEI. Tu pedido expira en <strong>${daysRemaining} día${daysRemaining === 1 ? '' : 's'}</strong>.
      </p>
    </div>
    <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600;">Datos para tu transferencia</h3>
      <p style="font-size: 14px; margin: 0;">
        Beneficiario: <strong>${speiRecipient.beneficiary}</strong><br>
        CLABE: <strong style="font-family: monospace;">${speiRecipient.clabe}</strong><br>
        Banco: ${speiRecipient.bank}<br>
        Monto: <strong>${fmtMx(order.totalCents)}</strong><br>
        Concepto: <strong style="font-family: monospace;">${order.orderNumber}</strong>
      </p>
    </div>
    <div style="text-align: center; margin-bottom: 32px;">
      <a href="${orderDetailUrl}" style="display: inline-block; background: #000; color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">Subir comprobante</a>
    </div>
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 0;">
    <div style="padding-top: 24px;">
      <p style="margin: 0; font-size: 14px; color: #666;">Avoqado</p>
    </div>
  </div>
</body></html>`

    const text =
      `Recordatorio — ${order.orderNumber}\n\n` +
      `Aún no recibimos tu comprobante SPEI. Tu pedido expira en ${daysRemaining} días.\n\n` +
      `Beneficiario: ${speiRecipient.beneficiary}\n` +
      `CLABE: ${speiRecipient.clabe}\n` +
      `Monto: ${fmtMx(order.totalCents)}\n` +
      `Concepto: ${order.orderNumber}\n\n` +
      `Sube tu comprobante en: ${orderDetailUrl}\n\nAvoqado`

    return this.sendEmail({ to: order.contactEmail, subject, html, text })
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
      // Last week's metrics for weekly comparison column
      lastWeekMetrics?: {
        grossSales: number
        items: number
        serviceCosts: number
        discounts: number
        refunds: number
        netSales: number
        taxes: number
        tips: number
        totalCollected: number
        platformFees: number
        transactionCount: number
      }
    },
    _weeklyChange: number = 0,
  ): Promise<boolean> {
    const currency = data.venueCurrency || 'MXN'

    // Format weekly change for a specific metric
    const weeklyChangeFor = (current: number, lastWeek: number | undefined): string => {
      if (lastWeek === undefined || lastWeek === 0) return 'n/a'
      const change = ((current - lastWeek) / lastWeek) * 100
      const sign = change >= 0 ? '+' : ''
      return `${sign}${change.toFixed(1)}%`
    }

    const weeklyColorFor = (current: number, lastWeek: number | undefined): string => {
      if (lastWeek === undefined || lastWeek === 0) return '#666'
      return current >= lastWeek ? '#22c55e' : '#ef4444'
    }

    const lw = data.lastWeekMetrics

    // Format currency
    const formatCurrency = (amount: number) => {
      return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(amount)
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

    // Weekly average order for comparison
    const lastWeekAvgOrder = lw && lw.transactionCount > 0 ? lw.netSales / lw.transactionCount : 0

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
      ${
        data.businessHoursStart && data.businessHoursEnd
          ? `<p style="margin: 0 0 8px 0; font-size: 14px; color: #000;">
        ${reportDateFormatted} ${data.businessHoursStart} - ${reportDateFormatted} ${data.businessHoursEnd} (${data.venueTimezone})
      </p>`
          : ''
      }
      <p style="margin: 0 0 8px 0; font-size: 14px; color: #666;">
        Este informe solo considera los pedidos cerrados y las ventas realizadas durante el horario comercial.
      </p>
      <p style="margin: 0; font-size: 14px; color: #666;">
        Consulta el <a href="${data.dashboardUrl}/reports/sales-summary" style="color: #1a73e8; text-decoration: none;">informe de conciliacion</a> para obtener mas informacion sobre los pagos y las transferencias anteriores.
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
            <div style="font-size: 14px; color: ${weeklyColorFor(data.metrics.netSales, lw?.netSales)};">${weeklyChangeFor(data.metrics.netSales, lw?.netSales)} semanal</div>
          </td>
          <td style="padding: 24px; width: 50%; vertical-align: top;">
            <div style="font-size: 14px; color: #666; margin-bottom: 8px;">Pedido promedio</div>
            <div style="font-size: 36px; font-weight: 400; color: #000; margin-bottom: 4px;">${formatCurrency(avgOrder)}</div>
            <div style="font-size: 14px; color: ${weeklyColorFor(avgOrder, lastWeekAvgOrder)};">${weeklyChangeFor(avgOrder, lastWeekAvgOrder)} semanal</div>
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
            <a href="${data.dashboardUrl}/reports/sales-summary" style="color: #1a73e8; text-decoration: none; font-size: 14px;">Mostrar mas &rarr;</a>
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
          <td style="padding: 16px 0; font-size: 14px; color: ${weeklyColorFor(data.metrics.grossSales, lw?.grossSales)}; text-align: right;">${weeklyChangeFor(data.metrics.grossSales, lw?.grossSales)}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0 16px 24px; font-size: 15px; color: #000;">Ventas de articulos</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.metrics.items)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: ${weeklyColorFor(data.metrics.items, lw?.items)}; text-align: right;">${weeklyChangeFor(data.metrics.items, lw?.items)}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0 16px 24px; font-size: 15px; color: #000;">Cobro por servicio</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.metrics.serviceCosts)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: ${weeklyColorFor(data.metrics.serviceCosts, lw?.serviceCosts)}; text-align: right;">${weeklyChangeFor(data.metrics.serviceCosts, lw?.serviceCosts)}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0; font-size: 15px; color: #000;">Devoluciones</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.metrics.refunds)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: ${weeklyColorFor(data.metrics.refunds, lw?.refunds)}; text-align: right;">${weeklyChangeFor(data.metrics.refunds, lw?.refunds)}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0; font-size: 15px; color: #000;">Descuentos y cortesias</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.metrics.discounts)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: ${weeklyColorFor(data.metrics.discounts, lw?.discounts)}; text-align: right;">${weeklyChangeFor(data.metrics.discounts, lw?.discounts)}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e0e0e0;">
          <td style="padding: 16px 0; font-size: 15px; font-weight: 600; color: #000;">Ventas netas</td>
          <td style="padding: 16px 0; font-size: 15px; font-weight: 600; color: #000; text-align: right;">${formatCurrency(data.metrics.netSales)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: ${weeklyColorFor(data.metrics.netSales, lw?.netSales)}; text-align: right;">${weeklyChangeFor(data.metrics.netSales, lw?.netSales)}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0; font-size: 15px; color: #000;">Impuestos</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.metrics.taxes)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: ${weeklyColorFor(data.metrics.taxes, lw?.taxes)}; text-align: right;">${weeklyChangeFor(data.metrics.taxes, lw?.taxes)}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 16px 0; font-size: 15px; color: #000;">Propinas</td>
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(data.metrics.tips)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: ${weeklyColorFor(data.metrics.tips, lw?.tips)}; text-align: right;">${weeklyChangeFor(data.metrics.tips, lw?.tips)}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e0e0e0;">
          <td style="padding: 16px 0; font-size: 15px; font-weight: 600; color: #000;">Total en ventas</td>
          <td style="padding: 16px 0; font-size: 15px; font-weight: 600; color: #000; text-align: right;">${formatCurrency(data.metrics.totalCollected)}</td>
          <td style="padding: 16px 0; font-size: 14px; color: ${weeklyColorFor(data.metrics.totalCollected, lw?.totalCollected)}; text-align: right;">${weeklyChangeFor(data.metrics.totalCollected, lw?.totalCollected)}</td>
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
          <td style="padding: 16px 0; font-size: 15px; color: #000; text-align: right;">${formatCurrency(cat.netSales)}</td>
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
        Servicios Tecnologicos Avo S.A. de C.V.<br>
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
        <a href="${data.dashboardUrl}/notifications/preferences" style="color: #000; text-decoration: none; font-weight: 600;">Administrar preferencias de notificaciones</a>
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
Servicios Tecnologicos Avo S.A. de C.V.
    `

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  /**
   * Send low stock digest email (similar to Square's "Alertas de bajas existencias")
   */
  async sendLowStockDigestEmail(
    email: string,
    data: {
      venueName: string
      items: Array<{
        name: string
        category: string | null
        currentStock: number
        reorderPoint: number
        unit: string
        isOutOfStock: boolean
      }>
      dashboardUrl: string
      preferencesUrl: string
    },
  ): Promise<boolean> {
    const now = new Date()
    const dateFormatted = now.toLocaleDateString('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'America/Mexico_City',
    })
    const dateCapitalized = dateFormatted.charAt(0).toUpperCase() + dateFormatted.slice(1)

    const outOfStockCount = data.items.filter(i => i.isOutOfStock).length

    const subject = `Alertas de bajas existencias en ${data.venueName}`
    const logoUrl = 'https://avoqado.io/isotipo.svg'

    // Build table rows
    const tableRows = data.items
      .map(item => {
        const statusLabel = item.isOutOfStock ? 'Sin stock' : 'Stock bajo'
        const statusColor = item.isOutOfStock ? '#dc2626' : '#f59e0b'
        const stockColor = item.isOutOfStock ? '#dc2626' : '#000'

        return `
          <tr>
            <td style="padding: 12px 16px; border-bottom: 1px solid #e5e7eb;">
              <div style="font-size: 14px; font-weight: 500; color: #000;">${item.name}</div>
              <div style="font-size: 12px; color: #666;">${item.category || 'Sin categorizar'}</div>
            </td>
            <td style="padding: 12px 16px; border-bottom: 1px solid #e5e7eb; text-align: right;">
              <span style="font-size: 14px; font-weight: 600; color: ${stockColor};">${item.currentStock}</span>
              <span style="font-size: 12px; color: #666;"> ${item.unit}</span>
            </td>
            <td style="padding: 12px 16px; border-bottom: 1px solid #e5e7eb; text-align: right;">
              <span style="font-size: 14px; color: #666;">${item.reorderPoint}</span>
              <span style="font-size: 12px; color: #666;"> ${item.unit}</span>
            </td>
            <td style="padding: 12px 16px; border-bottom: 1px solid #e5e7eb; text-align: center;">
              <span style="font-size: 13px; font-weight: 600; color: ${statusColor};">${statusLabel}</span>
            </td>
          </tr>`
      })
      .join('')

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

    <!-- Header with Logo -->
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <!-- Title Section -->
    <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 400; color: #000; line-height: 1.2;">
      Alertas de bajas existencias en ${data.venueName}
    </h1>
    <p style="margin: 0 0 24px 0; font-size: 14px; color: #666;">
      ${dateCapitalized}
    </p>

    <!-- Summary -->
    <p style="margin: 0 0 24px 0; font-size: 14px; color: #000;">
      ${data.items.length} ${data.items.length === 1 ? 'ingrediente requiere' : 'ingredientes requieren'} tu atenci&oacute;n${outOfStockCount > 0 ? ` (${outOfStockCount} sin stock)` : ''}.
    </p>

    <!-- Items Table -->
    <table cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
      <thead>
        <tr style="background-color: #f9fafb;">
          <th style="padding: 10px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; border-bottom: 2px solid #e5e7eb;">Art&iacute;culo</th>
          <th style="padding: 10px 16px; text-align: right; font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; border-bottom: 2px solid #e5e7eb;">Disponible</th>
          <th style="padding: 10px 16px; text-align: right; font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; border-bottom: 2px solid #e5e7eb;">M&iacute;nimo</th>
          <th style="padding: 10px 16px; text-align: center; font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; border-bottom: 2px solid #e5e7eb;">Estado</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>

    <!-- CTA Button (black, per EMAIL_STANDARDS) -->
    <div style="margin: 32px 0; text-align: left;">
      <a href="${data.dashboardUrl}" style="display: inline-block; background-color: #000000; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600;">
        Administrar inventario
      </a>
    </div>

    <!-- Divider -->
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />

    <!-- Footer -->
    <div style="padding-top: 8px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 14px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 6px;">Avoqado</span>
      </div>
      <p style="margin: 0 0 8px 0; font-size: 12px; color: #999;">
        Servicios Tecnologicos Avo S.A. de C.V.
      </p>
      <p style="margin: 0; font-size: 12px; color: #999;">
        <a href="${data.preferencesUrl}" style="color: #666; text-decoration: underline;">Administra tus preferencias de notificaciones</a>
      </p>
    </div>

  </div>
</body>
</html>`

    const text = `Alertas de bajas existencias en ${data.venueName}
${dateCapitalized}

${data.items.length} ingrediente(s) requieren tu atencion.

${data.items.map(i => `- ${i.name}: ${i.currentStock} ${i.unit} (minimo: ${i.reorderPoint} ${i.unit}) - ${i.isOutOfStock ? 'SIN STOCK' : 'STOCK BAJO'}`).join('\n')}

Administrar inventario: ${data.dashboardUrl}

---
Servicios Tecnologicos Avo S.A. de C.V.`

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  async sendReservationRescheduledEmail(email: string, data: ReservationRescheduledEmailData): Promise<boolean> {
    const subject = `Tu reservacion en ${data.venueName} cambio de horario`
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const serviceLine = data.serviceName ? `<p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">${data.serviceName}</p>` : ''
    const customMessageBlock = data.customMessage
      ? `
    <div style="padding: 16px 20px; background-color: #f5f5f5; border-radius: 8px; margin-bottom: 24px;">
      <p style="font-size: 13px; font-weight: 600; color: #666; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px;">Nota de ${data.venueName}</p>
      <p style="font-size: 15px; margin: 0; color: #000; white-space: pre-wrap;">${data.customMessage}</p>
    </div>`
      : ''

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reservacion reagendada</title>
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
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">Cambio de horario</h1>
      <p style="font-size: 15px; color: #666; margin: 0;">Reservacion ${data.confirmationCode}</p>
    </div>

    <!-- Greeting -->
    <div style="padding-bottom: 16px;">
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hola ${data.customerName},</p>
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">
        Tu reservacion en <strong>${data.venueName}</strong> se cambio a un nuevo horario.
      </p>
      ${serviceLine}
    </div>

    ${customMessageBlock}

    <!-- Old vs New -->
    <table cellpadding="0" cellspacing="0" border="0" style="width: 100%; margin-bottom: 32px; border-collapse: collapse;">
      <tr>
        <td style="padding: 16px 20px; background-color: #f5f5f5; border-radius: 8px; vertical-align: top;">
          <p style="font-size: 13px; font-weight: 600; color: #666; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 0.5px;">Original</p>
          <p style="font-size: 16px; color: #666; margin: 0; text-decoration: line-through;">${data.oldDateTime}</p>
        </td>
      </tr>
      <tr><td style="height: 12px;"></td></tr>
      <tr>
        <td style="padding: 16px 20px; background-color: #ecfdf5; border-radius: 8px; border-left: 4px solid #1f9d55; vertical-align: top;">
          <p style="font-size: 13px; font-weight: 600; color: #1f9d55; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 0.5px;">Nuevo horario</p>
          <p style="font-size: 18px; font-weight: 600; color: #000; margin: 0;">${data.newDateTime}</p>
        </td>
      </tr>
    </table>

    <p style="font-size: 14px; color: #666; margin: 0 0 24px 0;">
      Si tienes preguntas, contacta directamente con ${data.venueName}.
    </p>

    <!-- Footer -->
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 40px 0 24px 0;">
    <div>
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 16px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
      </div>
      <p style="margin: 0 0 16px 0; font-size: 14px; color: #000;">
        Servicios Tecnologicos Avo S.A. de C.V.<br>
        Ciudad de Mexico, Mexico
      </p>
      <p style="margin: 0; font-size: 12px; color: #666;">
        Recibiste este correo porque tienes una reservacion activa en ${data.venueName}.
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
Hola ${data.customerName},

Tu reservacion en ${data.venueName} (${data.confirmationCode}) se cambio a un nuevo horario.

${data.serviceName ? `Servicio: ${data.serviceName}\n` : ''}${data.customMessage ? `Nota de ${data.venueName}:\n${data.customMessage}\n\n` : ''}Original: ${data.oldDateTime}
Nuevo horario: ${data.newDateTime}

Si tienes preguntas, contacta directamente con ${data.venueName}.

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

  async sendReservationConfirmedEmail(
    email: string,
    data: {
      customerName: string
      venueName: string
      venueSlug: string
      confirmationCode: string
      cancelSecret: string | null
      /** "Martes, 13 de mayo de 2026" */
      dateLong: string
      /** "12:45" */
      time: string
      /** Service names to show in the summary card (max 5).
       *  DEPRECATED for new callers — prefer `services` (richer, includes modifiers). */
      serviceNames?: string[]
      /** Services with optional picked modifiers. When provided, replaces
       *  serviceNames-only rendering and shows "Extras" sub-rows under each
       *  service (e.g. "Esmalte de color +$150"). */
      services?: Array<{
        name: string
        modifiers?: Array<{ name: string; quantity: number; price: number }>
      }>
      /** Charged via Stripe at booking time. */
      depositPaidMxn?: number | null
      /** Owed by the customer when they arrive (pay-at-venue policy). */
      owedAtVenueMxn?: number | null
      /** Currency code, defaults to MXN. */
      currency?: string
    },
  ): Promise<boolean> {
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const bookingHost = process.env.BOOKING_PUBLIC_URL || 'https://book.avoqado.io'
    const manageUrl = data.cancelSecret
      ? `${bookingHost}/${data.venueSlug}?manage=${encodeURIComponent(data.cancelSecret)}`
      : `${bookingHost}/${data.venueSlug}`
    const currency = data.currency || 'MXN'
    const fmt = (n: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(n)
    const subject = `Reservación confirmada: ${data.venueName} – ${data.dateLong} ${data.time}`

    // Prefer the rich `services` shape (with modifiers); fall back to flat
    // serviceNames for legacy callers.
    const richServices =
      data.services && data.services.length > 0
        ? data.services.slice(0, 5)
        : data.serviceNames && data.serviceNames.length > 0
          ? data.serviceNames.slice(0, 5).map(name => ({ name, modifiers: [] as { name: string; quantity: number; price: number }[] }))
          : []
    const servicesBlock =
      richServices.length > 0
        ? `
    <div style="padding: 16px 20px; background-color: #f5f5f5; border-radius: 8px; margin-bottom: 24px;">
      <p style="font-size: 13px; font-weight: 600; color: #666; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px;">${richServices.length === 1 ? 'Servicio' : 'Servicios'}</p>
      ${richServices
        .map(svc => {
          const mods = (svc.modifiers ?? [])
            .map(m => {
              const qtyLabel = m.quantity > 1 ? ` × ${m.quantity}` : ''
              const lineTotal = m.price * m.quantity
              const priceLabel = lineTotal > 0 ? ` (${fmt(lineTotal)})` : ''
              return `<p style="font-size: 13px; color: #666; margin: 2px 0 0 12px;">• ${m.name}${qtyLabel}${priceLabel}</p>`
            })
            .join('')
          return `<div style="margin: 0 0 6px 0;"><p style="font-size: 15px; color: #000; margin: 0;">${svc.name}</p>${mods}</div>`
        })
        .join('')}
    </div>`
        : ''

    const depositRow =
      data.depositPaidMxn != null && data.depositPaidMxn > 0
        ? `<tr><td style="padding: 6px 0; font-size: 14px; color: #666;">Pagado hoy</td><td style="padding: 6px 0; font-size: 14px; color: #1f9d55; text-align: right; font-weight: 600;">${fmt(data.depositPaidMxn)}</td></tr>`
        : ''
    const owedRow =
      data.owedAtVenueMxn != null && data.owedAtVenueMxn > 0
        ? `<tr><td style="padding: 6px 0; font-size: 14px; color: #666;">A pagar en el lugar</td><td style="padding: 6px 0; font-size: 14px; color: #000; text-align: right; font-weight: 600;">${fmt(data.owedAtVenueMxn)}</td></tr>`
        : ''
    const paymentBlock =
      depositRow || owedRow
        ? `
    <table cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
      ${depositRow}
      ${owedRow}
    </table>`
        : ''

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
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000; line-height: 1.2;">¡Tu reservación está confirmada!</h1>
      <p style="font-size: 15px; color: #666; margin: 0;">${data.venueName} · ${data.confirmationCode}</p>
    </div>

    <div style="padding-bottom: 16px;">
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hola ${data.customerName},</p>
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Tu cita en <strong>${data.venueName}</strong> quedó agendada. Te esperamos.</p>
    </div>

    <div style="padding: 20px 24px; background-color: #ecfdf5; border-radius: 8px; border-left: 4px solid #1f9d55; margin-bottom: 24px;">
      <p style="font-size: 13px; font-weight: 600; color: #1f9d55; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px;">Tu cita</p>
      <p style="font-size: 20px; font-weight: 600; color: #000; margin: 0 0 4px 0;">${data.dateLong}</p>
      <p style="font-size: 20px; font-weight: 600; color: #000; margin: 0;">${data.time} hrs</p>
    </div>

    ${servicesBlock}

    <div style="padding: 16px 20px; background-color: #f5f5f5; border-radius: 8px; margin-bottom: 24px;">
      <p style="font-size: 13px; font-weight: 600; color: #666; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 0.5px;">Código de confirmación</p>
      <p style="font-size: 18px; font-weight: 600; color: #000; margin: 0; font-family: 'SFMono-Regular', Menlo, Monaco, monospace;">${data.confirmationCode}</p>
    </div>

    ${paymentBlock}

    <div style="margin: 0 0 32px 0;">
      <a href="${manageUrl}" style="display: inline-block; background-color: #000; color: #fff; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600;">
        Ver mi reservación
      </a>
    </div>

    <p style="font-size: 14px; color: #666; margin: 0 0 24px 0;">
      Te enviaremos un recordatorio antes de tu cita. Si necesitas cancelar o reagendar, hazlo desde el enlace de arriba o contacta directamente con ${data.venueName}.
    </p>

    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />

    <div style="padding-top: 8px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 14px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 6px;">Avoqado</span>
      </div>
      <p style="margin: 0 0 8px 0; font-size: 12px; color: #999;">
        Servicios Tecnologicos Avo S.A. de C.V.
      </p>
      <p style="margin: 0; font-size: 12px; color: #999;">
        Recibiste este correo porque hiciste una reservación en ${data.venueName}.
      </p>
    </div>

  </div>
</body>
</html>`

    const text = `¡Tu reservación está confirmada!
${data.venueName} · ${data.confirmationCode}

Hola ${data.customerName},

Tu cita en ${data.venueName} quedó agendada:
${data.dateLong} a las ${data.time} hrs
${data.serviceNames && data.serviceNames.length ? `\n${data.serviceNames.length === 1 ? 'Servicio' : 'Servicios'}: ${data.serviceNames.join(', ')}\n` : ''}
Código de confirmación: ${data.confirmationCode}
${data.depositPaidMxn ? `\nPagado hoy: ${fmt(data.depositPaidMxn)}` : ''}${data.owedAtVenueMxn ? `\nA pagar en el lugar: ${fmt(data.owedAtVenueMxn)}` : ''}

Ver mi reservación: ${manageUrl}

Te enviaremos un recordatorio antes de tu cita.

---
Servicios Tecnologicos Avo S.A. de C.V.`

    return this.sendEmail({ to: email, subject, html, text })
  }

  async sendReservationCancelledEmail(
    email: string,
    data: {
      customerName: string
      venueName: string
      venueSlug: string
      confirmationCode: string
      /** "Martes, 13 de mayo de 2026" */
      dateLong: string
      /** "12:45" */
      time: string
      /** Optional reason from the cancel request body. */
      reason?: string | null
      /** Who triggered the cancellation — used to soften the copy. */
      cancelledBy?: 'CUSTOMER' | 'STAFF' | 'SYSTEM'
    },
  ): Promise<boolean> {
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const bookingHost = process.env.BOOKING_PUBLIC_URL || 'https://book.avoqado.io'
    const bookAgainUrl = `${bookingHost}/${data.venueSlug}/appointments`
    const subject = `Reservación cancelada: ${data.venueName} – ${data.confirmationCode}`

    const intro =
      data.cancelledBy === 'STAFF'
        ? `${data.venueName} canceló tu reservación.`
        : data.cancelledBy === 'SYSTEM'
          ? 'Tu reservación fue cancelada automáticamente.'
          : 'Tu reservación fue cancelada exitosamente.'

    const reasonBlock = data.reason
      ? `
    <div style="padding: 16px 20px; background-color: #f5f5f5; border-radius: 8px; margin-bottom: 24px;">
      <p style="font-size: 13px; font-weight: 600; color: #666; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px;">Motivo</p>
      <p style="font-size: 15px; color: #000; margin: 0; white-space: pre-wrap;">${data.reason}</p>
    </div>`
      : ''

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
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000; line-height: 1.2;">Reservación cancelada</h1>
      <p style="font-size: 15px; color: #666; margin: 0;">${data.venueName} · ${data.confirmationCode}</p>
    </div>

    <div style="padding-bottom: 16px;">
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hola ${data.customerName},</p>
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">${intro}</p>
    </div>

    <div style="padding: 20px 24px; background-color: #fef2f2; border-radius: 8px; border-left: 4px solid #dc2626; margin-bottom: 24px;">
      <p style="font-size: 13px; font-weight: 600; color: #dc2626; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px;">Horario cancelado</p>
      <p style="font-size: 18px; font-weight: 600; color: #000; margin: 0 0 4px 0; text-decoration: line-through;">${data.dateLong}</p>
      <p style="font-size: 18px; font-weight: 600; color: #000; margin: 0; text-decoration: line-through;">${data.time} hrs</p>
    </div>

    ${reasonBlock}

    <div style="margin: 0 0 32px 0;">
      <a href="${bookAgainUrl}" style="display: inline-block; background-color: #000; color: #fff; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600;">
        Reservar nuevo horario
      </a>
    </div>

    <p style="font-size: 14px; color: #666; margin: 0 0 24px 0;">
      Si esto fue un error o tienes preguntas, contacta directamente con ${data.venueName}.
    </p>

    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />

    <div style="padding-top: 8px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 14px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 6px;">Avoqado</span>
      </div>
      <p style="margin: 0 0 8px 0; font-size: 12px; color: #999;">
        Servicios Tecnologicos Avo S.A. de C.V.
      </p>
      <p style="margin: 0; font-size: 12px; color: #999;">
        Recibiste este correo porque tenías una reservación en ${data.venueName}.
      </p>
    </div>

  </div>
</body>
</html>`

    const text = `Reservación cancelada
${data.venueName} · ${data.confirmationCode}

Hola ${data.customerName},

${intro}

Horario cancelado: ${data.dateLong} a las ${data.time} hrs
${data.reason ? `\nMotivo: ${data.reason}\n` : ''}
Reservar nuevo horario: ${bookAgainUrl}

Si esto fue un error o tienes preguntas, contacta directamente con ${data.venueName}.

---
Servicios Tecnologicos Avo S.A. de C.V.`

    return this.sendEmail({ to: email, subject, html, text })
  }

  async sendCreditPackPurchaseEmail(
    email: string,
    data: {
      customerName: string
      venueName: string
      venueSlug: string
      packName: string
      /** Pack items breakdown: ["5 sesiones de Iyashi", "5 clases de Lagree"]. */
      itemLines: string[]
      amountPaid: number
      currency?: string
      /** ISO date string for "Válido hasta DD/MM/YYYY". Null = no expiry. */
      validUntilIso: string | null
      /** Confirmation code for the purchase (CreditPackPurchase.id or similar). */
      purchaseRef: string
    },
  ): Promise<boolean> {
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const bookingHost = process.env.BOOKING_PUBLIC_URL || 'https://book.avoqado.io'
    const portalUrl = `${bookingHost}/${data.venueSlug}`
    const currency = data.currency || 'MXN'
    const fmt = (n: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(n)
    const subject = `Compra exitosa: ${data.packName} – ${data.venueName}`

    const validityText = data.validUntilIso
      ? (() => {
          const d = new Date(data.validUntilIso)
          return `Válido hasta ${d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })}`
        })()
      : 'Sin fecha de vencimiento'

    const itemsHtml = data.itemLines.map(line => `<li style="font-size: 15px; color: #000; margin: 0 0 6px 0;">${line}</li>`).join('')

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
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000; line-height: 1.2;">¡Compra exitosa!</h1>
      <p style="font-size: 15px; color: #666; margin: 0;">${data.venueName} · ${data.purchaseRef}</p>
    </div>

    <div style="padding-bottom: 16px;">
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hola ${data.customerName},</p>
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Gracias por tu compra en <strong>${data.venueName}</strong>. Tus créditos ya están disponibles para reservar.</p>
    </div>

    <div style="padding: 20px 24px; background-color: #ecfdf5; border-radius: 8px; border-left: 4px solid #1f9d55; margin-bottom: 24px;">
      <p style="font-size: 13px; font-weight: 600; color: #1f9d55; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px;">Paquete adquirido</p>
      <p style="font-size: 20px; font-weight: 600; color: #000; margin: 0 0 12px 0;">${data.packName}</p>
      ${itemsHtml ? `<ul style="margin: 0 0 8px 0; padding: 0 0 0 20px;">${itemsHtml}</ul>` : ''}
      <p style="font-size: 13px; color: #666; margin: 8px 0 0 0;">${validityText}</p>
    </div>

    <div style="padding: 16px 20px; background-color: #f5f5f5; border-radius: 8px; margin-bottom: 24px;">
      <table cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="font-size: 14px; color: #666;">Total pagado</td>
          <td style="font-size: 18px; font-weight: 700; color: #000; text-align: right;">${fmt(data.amountPaid)}</td>
        </tr>
      </table>
    </div>

    <div style="margin: 0 0 32px 0;">
      <a href="${portalUrl}" style="display: inline-block; background-color: #000; color: #fff; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600;">
        Reservar mi primera sesión
      </a>
    </div>

    <p style="font-size: 14px; color: #666; margin: 0 0 24px 0;">
      Puedes ver el saldo de tus créditos y reservar sesiones en cualquier momento desde tu cuenta en ${data.venueName}.
    </p>

    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />

    <div style="padding-top: 8px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 14px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 6px;">Avoqado</span>
      </div>
      <p style="margin: 0 0 8px 0; font-size: 12px; color: #999;">
        Servicios Tecnologicos Avo S.A. de C.V.
      </p>
      <p style="margin: 0; font-size: 12px; color: #999;">
        Este correo confirma tu compra de un paquete de créditos en ${data.venueName}.
      </p>
    </div>

  </div>
</body>
</html>`

    const text = `¡Compra exitosa!
${data.venueName} · ${data.purchaseRef}

Hola ${data.customerName},

Gracias por tu compra en ${data.venueName}. Tus créditos ya están disponibles para reservar.

Paquete: ${data.packName}
${data.itemLines.map(l => `- ${l}`).join('\n')}
${validityText}

Total pagado: ${fmt(data.amountPaid)}

Reservar mi primera sesión: ${portalUrl}

---
Servicios Tecnologicos Avo S.A. de C.V.`

    return this.sendEmail({ to: email, subject, html, text })
  }

  async sendPaymentLinkPaidEmail(
    email: string,
    data: {
      recipientName: string
      venueName: string
      linkTitle: string
      linkShortCode: string
      customerEmail?: string | null
      customerName?: string | null
      amountPaid: number
      tipAmount?: number | null
      currency?: string
      cardLast4?: string | null
      paidAtLong: string
      dashboardUrl: string
    },
  ): Promise<boolean> {
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const currency = data.currency || 'MXN'
    const fmt = (n: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(n)
    const subject = `Pago recibido: ${fmt(data.amountPaid)} en ${data.linkTitle}`

    const customerLine =
      data.customerName || data.customerEmail
        ? `<p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Pagado por <strong>${data.customerName ?? data.customerEmail}</strong>${data.customerName && data.customerEmail ? ` (${data.customerEmail})` : ''}.</p>`
        : ''
    const tipRow =
      data.tipAmount && data.tipAmount > 0
        ? `<tr><td style="padding: 6px 0; font-size: 14px; color: #666;">Propina</td><td style="padding: 6px 0; font-size: 14px; color: #1f9d55; text-align: right; font-weight: 600;">${fmt(data.tipAmount)}</td></tr>`
        : ''
    const cardRow = data.cardLast4
      ? `<tr><td style="padding: 6px 0; font-size: 14px; color: #666;">Tarjeta</td><td style="padding: 6px 0; font-size: 14px; color: #000; text-align: right;">···· ${data.cardLast4}</td></tr>`
      : ''

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
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000; line-height: 1.2;">Pago recibido</h1>
      <p style="font-size: 15px; color: #666; margin: 0;">${data.venueName} · ${data.linkShortCode}</p>
    </div>
    <div style="padding-bottom: 16px;">
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hola ${data.recipientName},</p>
      ${customerLine}
    </div>
    <div style="padding: 20px 24px; background-color: #ecfdf5; border-radius: 8px; border-left: 4px solid #1f9d55; margin-bottom: 24px;">
      <p style="font-size: 13px; font-weight: 600; color: #1f9d55; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px;">Monto cobrado</p>
      <p style="font-size: 28px; font-weight: 700; color: #000; margin: 0;">${fmt(data.amountPaid)}</p>
      <p style="font-size: 13px; color: #666; margin: 4px 0 0 0;">${data.paidAtLong}</p>
    </div>
    <div style="padding: 16px 20px; background-color: #f5f5f5; border-radius: 8px; margin-bottom: 24px;">
      <p style="font-size: 13px; font-weight: 600; color: #666; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px;">Liga de pago</p>
      <p style="font-size: 16px; color: #000; margin: 0;">${data.linkTitle}</p>
    </div>
    ${tipRow || cardRow ? `<table cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">${tipRow}${cardRow}</table>` : ''}
    <div style="margin: 0 0 32px 0;">
      <a href="${data.dashboardUrl}" style="display: inline-block; background-color: #000; color: #fff; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600;">
        Ver detalles en el dashboard
      </a>
    </div>
    <p style="font-size: 14px; color: #666; margin: 0 0 24px 0;">
      Recibes este correo porque tu negocio tiene activadas las notificaciones de pagos por liga. Puedes desactivarlas en Ligas de Pago → Ajustes.
    </p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
    <div style="padding-top: 8px;">
      <div style="margin-bottom: 16px;"><img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;"><span style="font-size: 14px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 6px;">Avoqado</span></div>
      <p style="margin: 0 0 8px 0; font-size: 12px; color: #999;">Servicios Tecnologicos Avo S.A. de C.V.</p>
    </div>
  </div>
</body>
</html>`

    const text = `Pago recibido
${data.venueName} · ${data.linkShortCode}

Hola ${data.recipientName},
${data.customerName ? `Pagado por ${data.customerName}${data.customerEmail ? ` (${data.customerEmail})` : ''}.\n` : ''}
Monto cobrado: ${fmt(data.amountPaid)}
${data.paidAtLong}

Liga: ${data.linkTitle}
${data.tipAmount && data.tipAmount > 0 ? `Propina: ${fmt(data.tipAmount)}\n` : ''}${data.cardLast4 ? `Tarjeta: ···· ${data.cardLast4}\n` : ''}
Ver detalles: ${data.dashboardUrl}

---
Servicios Tecnologicos Avo S.A. de C.V.`

    return this.sendEmail({ to: email, subject, html, text })
  }

  async sendReservationReminderEmail(
    email: string,
    data: {
      customerName: string
      venueName: string
      venueSlug: string
      confirmationCode: string
      cancelSecret: string | null
      /** Already-formatted in venue timezone, e.g. "Martes, 13 de mayo de 2026" */
      dateLong: string
      /** Already-formatted in venue timezone, e.g. "12:45" */
      time: string
      /** Minutes-before-start the reminder fires at (1440 = 24h, 120 = 2h). */
      offsetMinutes: number
    },
  ): Promise<boolean> {
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const bookingHost = process.env.BOOKING_PUBLIC_URL || 'https://book.avoqado.io'
    // Link straight into the widget's Manage Booking flow if we have a cancel
    // secret. The host page reads ?manage=<secret> and opens the widget there.
    const manageUrl = data.cancelSecret
      ? `${bookingHost}/${data.venueSlug}?manage=${encodeURIComponent(data.cancelSecret)}`
      : `${bookingHost}/${data.venueSlug}`

    // Subject mirrors the WhatsApp template — short and scannable.
    const subject = `Recordatorio: ${data.venueName} – ${data.dateLong} ${data.time}`

    // Human leadline: "tu cita es mañana" vs "tu cita es en 2 horas". Default
    // to "próxima" if we get something off-grid.
    let leadline = 'Te recordamos tu próxima cita.'
    if (data.offsetMinutes >= 60 * 20 && data.offsetMinutes <= 60 * 28) {
      leadline = 'Tu cita es mañana.'
    } else if (data.offsetMinutes <= 60 * 3 && data.offsetMinutes >= 60) {
      leadline = `Tu cita es en ${Math.round(data.offsetMinutes / 60)} horas.`
    } else if (data.offsetMinutes < 60) {
      leadline = `Tu cita es en ${data.offsetMinutes} minutos.`
    }

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

    <!-- Header with Logo -->
    <div style="padding-bottom: 32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <!-- Title -->
    <div style="padding-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000; line-height: 1.2;">Recordatorio de tu cita</h1>
      <p style="font-size: 15px; color: #666; margin: 0;">${data.venueName} · ${data.confirmationCode}</p>
    </div>

    <!-- Greeting -->
    <div style="padding-bottom: 16px;">
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hola ${data.customerName},</p>
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">${leadline}</p>
    </div>

    <!-- Highlight card with date/time -->
    <div style="padding: 20px 24px; background-color: #ecfdf5; border-radius: 8px; border-left: 4px solid #1f9d55; margin-bottom: 24px;">
      <p style="font-size: 13px; font-weight: 600; color: #1f9d55; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px;">Tu cita</p>
      <p style="font-size: 20px; font-weight: 600; color: #000; margin: 0 0 4px 0;">${data.dateLong}</p>
      <p style="font-size: 20px; font-weight: 600; color: #000; margin: 0;">${data.time} hrs</p>
    </div>

    <!-- Confirmation code block -->
    <div style="padding: 16px 20px; background-color: #f5f5f5; border-radius: 8px; margin-bottom: 32px;">
      <p style="font-size: 13px; font-weight: 600; color: #666; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 0.5px;">Código de confirmación</p>
      <p style="font-size: 18px; font-weight: 600; color: #000; margin: 0; font-family: 'SFMono-Regular', Menlo, Monaco, monospace;">${data.confirmationCode}</p>
    </div>

    <!-- CTA Button -->
    <div style="margin: 0 0 32px 0;">
      <a href="${manageUrl}" style="display: inline-block; background-color: #000; color: #fff; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600;">
        Ver mi reservación
      </a>
    </div>

    <p style="font-size: 14px; color: #666; margin: 0 0 24px 0;">
      ¿Necesitas cancelar o reagendar? Puedes hacerlo desde el enlace de arriba o contactando directamente con ${data.venueName}.
    </p>

    <!-- Divider -->
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />

    <!-- Footer -->
    <div style="padding-top: 8px;">
      <div style="margin-bottom: 16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 14px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 6px;">Avoqado</span>
      </div>
      <p style="margin: 0 0 8px 0; font-size: 12px; color: #999;">
        Servicios Tecnologicos Avo S.A. de C.V.
      </p>
      <p style="margin: 0; font-size: 12px; color: #999;">
        Recibiste este correo porque tienes una reservación activa en ${data.venueName}.
      </p>
    </div>

  </div>
</body>
</html>`

    const text = `Hola ${data.customerName},

${leadline}

Tu cita en ${data.venueName}:
${data.dateLong} a las ${data.time} hrs
Código de confirmación: ${data.confirmationCode}

Ver mi reservación: ${manageUrl}

¿Necesitas cancelar o reagendar? Puedes hacerlo desde el enlace de arriba o contactando directamente con ${data.venueName}.

---
Servicios Tecnologicos Avo S.A. de C.V.`

    return this.sendEmail({
      to: email,
      subject,
      html,
      text,
    })
  }

  /**
   * Shared HTML shell for the subscription-lifecycle plan emails (confirmation, renewal reminder,
   * win-back). Mirrors the `sendPaymentFailedEmail` structure: white bg, isotipo in header + footer,
   * black CTA button. Keeps the 3 plan-email methods DRY. Locale only varies the footer chrome;
   * the title/body/CTA strings are passed pre-localized by each method.
   */
  private buildPlanEmailHtml(opts: {
    locale: 'es' | 'en'
    title: string
    venueName: string
    bodyHtml: string // inner content blocks (already localized + escaped where needed)
    ctaLabel: string
    ctaUrl: string
  }): string {
    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const footer =
      opts.locale === 'en'
        ? {
            help: 'Need help? Contact us anytime.',
            privacy: 'Privacy Policy',
          }
        : {
            help: 'Necesitas ayuda? Contactanos en cualquier momento.',
            privacy: 'Politica de Privacidad',
          }

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${opts.title}</title>
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
      <h1 style="margin: 0 0 8px 0; font-size: 32px; font-weight: 400; color: #000;">${opts.title}</h1>
      <p style="margin: 0; font-size: 14px; color: #666;">${opts.venueName}</p>
    </div>

    <!-- Content -->
    <div style="padding-bottom: 24px;">
      ${opts.bodyHtml}
    </div>

    <!-- CTA Button -->
    <div style="padding: 32px 0; text-align: center;">
      <a href="${opts.ctaUrl}" style="background-color: #000000; color: #fff; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block;">
        ${opts.ctaLabel}
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
        Servicios Tecnologicos Avo S.A. de C.V.<br>
        Ciudad de Mexico, Mexico
      </p>
      <p style="margin: 0; font-size: 12px; color: #666;">
        ${footer.help}
      </p>
      <p style="margin: 16px 0 0 0; font-size: 14px;">
        <a href="https://avoqado.io/privacy" style="color: #000; text-decoration: none; font-weight: 600;">${footer.privacy}</a>
      </p>
    </div>

  </div>
</body>
</html>
    `
  }

  /**
   * Plan confirmation email (Phase 1.5). Sent right after PLAN_PRO is enabled in onboarding.
   * Two variants: trial (payNow=false) and pay-now (payNow=true, with intro price for the first
   * 3 months on monthly). Money formatted via Intl.NumberFormat (es-MX/en-US, currency MXN).
   */
  async sendPlanConfirmationEmail(email: string, data: PlanConfirmationEmailData): Promise<boolean> {
    const fmt = (cents: number) =>
      new Intl.NumberFormat(data.locale === 'en' ? 'en-US' : 'es-MX', {
        style: 'currency',
        currency: 'MXN',
      }).format(cents / 100)
    const dateFormatted = data.firstChargeDate.toLocaleDateString(data.locale === 'en' ? 'en-US' : 'es-MX', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    const intervalLabel =
      data.locale === 'en' ? (data.interval === 'annual' ? 'year' : 'month') : data.interval === 'annual' ? 'año' : 'mes'

    const firstAmount = fmt(data.firstChargeAmountCents)
    const introAmount = data.introAmountCents != null ? fmt(data.introAmountCents) : null

    let subject: string
    let greeting: string
    let bodyHtml: string
    let ctaLabel: string
    let text: string

    if (data.payNow) {
      // Pay-now variant
      subject = data.locale === 'en' ? 'Welcome to Avoqado Pro!' : '¡Bienvenido a Avoqado Pro!'
      ctaLabel = data.locale === 'en' ? 'View billing' : 'Ver facturación'
      if (data.locale === 'en') {
        greeting = 'Hi,'
        const introClause = introAmount
          ? `We received your payment of <strong>${introAmount}</strong>. You'll keep paying ${introAmount} for the first 3 months, then ${firstAmount}/${intervalLabel}.`
          : `We received your payment of <strong>${firstAmount}</strong>. Your plan renews at ${firstAmount}/${intervalLabel}.`
        bodyHtml = `
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">${greeting}</p>
      <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
        Your <strong>Avoqado Pro</strong> plan for ${data.venueName} is active. ${introClause}
      </p>
      <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="font-size: 14px; margin: 0; color: #666;">Next renewal: <strong>${dateFormatted}</strong> · <strong>${firstAmount}</strong>/${intervalLabel}.</p>
      </div>`
        text = `Hi,

Your Avoqado Pro plan for ${data.venueName} is active. ${
          introAmount
            ? `We received your payment of ${introAmount}. You'll keep paying ${introAmount} for the first 3 months, then ${firstAmount}/${intervalLabel}.`
            : `We received your payment of ${firstAmount}. Your plan renews at ${firstAmount}/${intervalLabel}.`
        }

Next renewal: ${dateFormatted} · ${firstAmount}/${intervalLabel}.

View billing: ${data.billingPortalUrl}

Avoqado Team`
      } else {
        greeting = 'Hola,'
        const introClause = introAmount
          ? `Recibimos tu pago de <strong>${introAmount}</strong>. Seguirás con ${introAmount} los primeros 3 meses, luego ${firstAmount}/${intervalLabel}.`
          : `Recibimos tu pago de <strong>${firstAmount}</strong>. Tu plan se renueva en ${firstAmount}/${intervalLabel}.`
        bodyHtml = `
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">${greeting}</p>
      <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
        Tu plan <strong>Avoqado Pro</strong> para ${data.venueName} está activo. ${introClause}
      </p>
      <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="font-size: 14px; margin: 0; color: #666;">Próxima renovación: <strong>${dateFormatted}</strong> · <strong>${firstAmount}</strong>/${intervalLabel}.</p>
      </div>`
        text = `Hola,

Tu plan Avoqado Pro para ${data.venueName} está activo. ${
          introAmount
            ? `Recibimos tu pago de ${introAmount}. Seguirás con ${introAmount} los primeros 3 meses, luego ${firstAmount}/${intervalLabel}.`
            : `Recibimos tu pago de ${firstAmount}. Tu plan se renueva en ${firstAmount}/${intervalLabel}.`
        }

Próxima renovación: ${dateFormatted} · ${firstAmount}/${intervalLabel}.

Ver facturación: ${data.billingPortalUrl}

Equipo de Avoqado`
      }
    } else {
      // Trial variant
      subject = data.locale === 'en' ? 'Your Avoqado Pro trial has started' : 'Tu prueba de Avoqado Pro empezó'
      ctaLabel = data.locale === 'en' ? 'View billing' : 'Ver facturación'
      if (data.locale === 'en') {
        greeting = 'Hi,'
        bodyHtml = `
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">${greeting}</p>
      <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
        Your 30-day trial is active. Your first charge of <strong>${firstAmount}</strong> is on <strong>${dateFormatted}</strong>.
      </p>`
        text = `Hi,

Your 30-day trial is active. Your first charge of ${firstAmount} is on ${dateFormatted}.

View billing: ${data.billingPortalUrl}

Avoqado Team`
      } else {
        greeting = 'Hola,'
        bodyHtml = `
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">${greeting}</p>
      <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
        Tu prueba de 30 días está activa. Tu primer cobro será de <strong>${firstAmount}</strong> el <strong>${dateFormatted}</strong>.
      </p>`
        text = `Hola,

Tu prueba de 30 días está activa. Tu primer cobro será de ${firstAmount} el ${dateFormatted}.

Ver facturación: ${data.billingPortalUrl}

Equipo de Avoqado`
      }
    }

    const html = this.buildPlanEmailHtml({
      locale: data.locale,
      title: subject,
      venueName: data.venueName,
      bodyHtml,
      ctaLabel,
      ctaUrl: data.billingPortalUrl,
    })

    return this.sendEmail({ to: email, subject, html, text })
  }

  /**
   * Plan renewal reminder (Phase 1.5). Sent ~3 days before the next billing period by a daily cron.
   */
  async sendPlanRenewalReminderEmail(email: string, data: PlanRenewalReminderEmailData): Promise<boolean> {
    const amount = new Intl.NumberFormat(data.locale === 'en' ? 'en-US' : 'es-MX', {
      style: 'currency',
      currency: 'MXN',
    }).format(data.amountCents / 100)
    const dateFormatted = data.renewalDate.toLocaleDateString(data.locale === 'en' ? 'en-US' : 'es-MX', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })

    const subject = data.locale === 'en' ? 'Your plan renews soon' : 'Tu plan se renueva pronto'
    const ctaLabel = data.locale === 'en' ? 'Manage plan' : 'Administrar plan'

    let bodyHtml: string
    let text: string
    if (data.locale === 'en') {
      bodyHtml = `
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hi,</p>
      <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
        Your Avoqado Pro plan will renew on <strong>${dateFormatted}</strong> for <strong>${amount}</strong>. You don't need to do anything; it charges your card automatically.
      </p>`
      text = `Hi,

Your Avoqado Pro plan will renew on ${dateFormatted} for ${amount}. You don't need to do anything; it charges your card automatically.

Manage plan: ${data.billingPortalUrl}

Avoqado Team`
    } else {
      bodyHtml = `
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hola,</p>
      <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
        Tu plan Avoqado Pro se renovará el <strong>${dateFormatted}</strong> por <strong>${amount}</strong>. No necesitas hacer nada; se cobra automáticamente a tu tarjeta.
      </p>`
      text = `Hola,

Tu plan Avoqado Pro se renovará el ${dateFormatted} por ${amount}. No necesitas hacer nada; se cobra automáticamente a tu tarjeta.

Administrar plan: ${data.billingPortalUrl}

Equipo de Avoqado`
    }

    const html = this.buildPlanEmailHtml({
      locale: data.locale,
      title: subject,
      venueName: data.venueName,
      bodyHtml,
      ctaLabel,
      ctaUrl: data.billingPortalUrl,
    })

    return this.sendEmail({ to: email, subject, html, text })
  }

  /**
   * Win-back email (Phase 1.5). Sent once ~3 days after a PLAN_PRO subscription is suspended,
   * offering the first month free (WINBACK_FIRST_MONTH_FREE coupon).
   */
  async sendPlanWinbackEmail(email: string, data: PlanWinbackEmailData): Promise<boolean> {
    const subject =
      data.locale === 'en' ? 'Come back to Avoqado Pro — your first month is free' : 'Vuelve a Avoqado Pro — tu primer mes es gratis'
    const ctaLabel = data.locale === 'en' ? 'Reactivate — 1 month free' : 'Reactivar con 1 mes gratis'

    let bodyHtml: string
    let text: string
    if (data.locale === 'en') {
      bodyHtml = `
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hi,</p>
      <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
        We miss you. Reactivate Avoqado Pro and your first month is free. Your data is intact and access turns back on instantly.
      </p>`
      text = `Hi,

We miss you. Reactivate Avoqado Pro and your first month is free. Your data is intact and access turns back on instantly.

Reactivate — 1 month free: ${data.reactivateUrl}

Avoqado Team`
    } else {
      bodyHtml = `
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hola,</p>
      <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
        Te extrañamos. Reactiva Avoqado Pro y tu primer mes es gratis. Tus datos siguen intactos y el acceso se reactiva al instante.
      </p>`
      text = `Hola,

Te extrañamos. Reactiva Avoqado Pro y tu primer mes es gratis. Tus datos siguen intactos y el acceso se reactiva al instante.

Reactivar con 1 mes gratis: ${data.reactivateUrl}

Equipo de Avoqado`
    }

    const html = this.buildPlanEmailHtml({
      locale: data.locale,
      title: subject,
      venueName: data.venueName,
      bodyHtml,
      ctaLabel,
      ctaUrl: data.reactivateUrl,
    })

    return this.sendEmail({ to: email, subject, html, text })
  }

  /**
   * Plan cancellation confirmation email. Sent right after a merchant schedules cancellation
   * (cancel_at_period_end). Confirms when access ends AND carries a time-limited win-back
   * offer (a % discount that must be redeemed before `redeemBy`) to nudge a reconsider.
   * Mirrors the other plan emails' structure (buildPlanEmailHtml shell, es/en).
   */
  async sendPlanCancellationEmail(email: string, data: PlanCancellationEmailData): Promise<boolean> {
    const dateOpts = { year: 'numeric', month: 'long', day: 'numeric' } as const
    const accessUntilFormatted = data.accessUntil.toLocaleDateString(data.locale === 'en' ? 'en-US' : 'es-MX', dateOpts)
    const redeemByFormatted = data.redeemBy.toLocaleDateString(data.locale === 'en' ? 'en-US' : 'es-MX', dateOpts)
    const pct = `${data.winbackPercentOff}%`

    const subject = data.locale === 'en' ? 'Your Avoqado plan cancellation is scheduled' : 'Programamos la cancelación de tu plan Avoqado'
    const ctaLabel = data.locale === 'en' ? `Reconsider — ${pct} off` : `Reconsiderar — ${pct} de descuento`

    // Win-back line: prefer the concrete promo code, else a generic "use this offer" message.
    const codeLineEn = data.winbackCode
      ? `Use code <strong>${data.winbackCode}</strong> for <strong>${pct} off</strong> when you come back — but hurry, it expires <strong>${redeemByFormatted}</strong>.`
      : `Come back before <strong>${redeemByFormatted}</strong> and get <strong>${pct} off</strong>.`
    const codeLineEs = data.winbackCode
      ? `Usa el código <strong>${data.winbackCode}</strong> y obtén <strong>${pct} de descuento</strong> al regresar — pero apúrate, vence el <strong>${redeemByFormatted}</strong>.`
      : `Regresa antes del <strong>${redeemByFormatted}</strong> y obtén <strong>${pct} de descuento</strong>.`

    let bodyHtml: string
    let text: string
    if (data.locale === 'en') {
      bodyHtml = `
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hi,</p>
      <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
        We've scheduled the cancellation of your Avoqado plan for ${data.venueName}. You'll keep full access until <strong>${accessUntilFormatted}</strong> — nothing changes before then.
      </p>
      <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="font-size: 14px; margin: 0; color: #666;">Changed your mind? ${codeLineEn}</p>
      </div>`
      text = `Hi,

We've scheduled the cancellation of your Avoqado plan for ${data.venueName}. You'll keep full access until ${accessUntilFormatted} — nothing changes before then.

Changed your mind? ${
        data.winbackCode
          ? `Use code ${data.winbackCode} for ${pct} off when you come back — it expires ${redeemByFormatted}.`
          : `Come back before ${redeemByFormatted} and get ${pct} off.`
      }

Reconsider — ${pct} off: ${data.reactivateUrl}

Avoqado Team`
    } else {
      bodyHtml = `
      <p style="font-size: 16px; margin: 0 0 16px 0; color: #000;">Hola,</p>
      <p style="font-size: 16px; margin: 0 0 24px 0; color: #000;">
        Programamos la cancelación de tu plan Avoqado para ${data.venueName}. Conservarás el acceso completo hasta el <strong>${accessUntilFormatted}</strong> — nada cambia antes de esa fecha.
      </p>
      <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="font-size: 14px; margin: 0; color: #666;">¿Cambiaste de opinión? ${codeLineEs}</p>
      </div>`
      text = `Hola,

Programamos la cancelación de tu plan Avoqado para ${data.venueName}. Conservarás el acceso completo hasta el ${accessUntilFormatted} — nada cambia antes de esa fecha.

¿Cambiaste de opinión? ${
        data.winbackCode
          ? `Usa el código ${data.winbackCode} y obtén ${pct} de descuento al regresar — vence el ${redeemByFormatted}.`
          : `Regresa antes del ${redeemByFormatted} y obtén ${pct} de descuento.`
      }

Reconsiderar — ${pct} de descuento: ${data.reactivateUrl}

Equipo de Avoqado`
    }

    const html = this.buildPlanEmailHtml({
      locale: data.locale,
      title: subject,
      venueName: data.venueName,
      bodyHtml,
      ctaLabel,
      ctaUrl: data.reactivateUrl,
    })

    return this.sendEmail({ to: email, subject, html, text })
  }

  async sendOtpCodeEmail(email: string, code: string): Promise<boolean> {
    return this.sendEmail({
      to: email,
      subject: `${code} es tu código de acceso`,
      html: `<p>Tu código de acceso es <strong style="font-size:20px">${code}</strong>.</p><p>Vence en 10 minutos. Si no lo pediste, ignora este correo.</p>`,
      text: `Tu código de acceso es ${code}. Vence en 10 minutos.`,
    })
  }

  async verifyConnection(): Promise<boolean> {
    if (!resend || !this.isAvailable) {
      return false
    }

    // Resend doesn't have a verify method, just check if client is available
    logger.info('📧 Email service (Resend) is available')
    return true
  }
}

export default new EmailService()

// ===========================
// Referral Program Emails
// ===========================
//
// Two transactional emails for the customer referral program:
//
//   1. sendReferralWelcomeEmail — fires once when a Customer gets a
//      referralCode for the first time. Includes a generated PNG card
//      so the customer can save+share by screenshot, plus a WhatsApp
//      deep link as the primary CTA.
//   2. sendReferralTierUpEmail — fires when a Customer crosses a tier
//      threshold (TIER_1/2/3). Surfaces the coupon code they just
//      unlocked + a tier-up celebration card.
//
// Both functions follow the same fire-and-forget contract as the rest
// of this file: they return `false` on any error so the caller can
// keep moving without losing the parent operation (customer creation,
// order qualification). Callers MUST wrap the call in try/catch as
// well — defense in depth, since a thrown error from satori/resvg
// upstream of `await resend.emails.send(...)` would still propagate.
//
// PNG cards are attached as binary attachments referenced via CID
// (`<img src="cid:tu-codigo-referido.png">`). Most modern clients
// (Gmail web/app, Apple Mail, Outlook 365, Resend's preview) render
// these correctly. Older Outlook desktops fall back to showing the
// attachment as a download — the textual code + WhatsApp CTA still
// work.

/**
 * Locally-scoped HTML escape so we don't depend on the inner
 * `escapeHtml` declared inside `sendNewVenueOnboardingDigest`.
 */
function escapeHtmlForReferralEmail(value: string | null | undefined): string {
  if (!value) return ''
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export interface SendReferralWelcomeEmailInput {
  to: string
  customerName: string
  venueName: string
  referralCode: string
  newCustomerDiscountPercent: number
  /** Pre-generated welcome PNG (1080x1080). */
  cardPng: Buffer
}

export async function sendReferralWelcomeEmail(input: SendReferralWelcomeEmailInput): Promise<boolean> {
  if (!resend) {
    logger.warn('[referral-email] Resend not configured — skipping welcome email')
    return false
  }
  try {
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: input.to,
      subject: `¡Bienvenida a ${input.venueName}! Tu código de referido está listo`,
      html: buildWelcomeReferralHtml(input),
      attachments: [
        {
          filename: 'tu-codigo-referido.png',
          content: input.cardPng,
        },
      ],
    })

    if (result.error) {
      logger.error('[referral-email] Failed to send welcome email', { to: input.to, err: result.error })
      return false
    }

    logger.info('[referral-email] Welcome email sent', { to: input.to, resendId: result?.data?.id })
    return true
  } catch (err) {
    logger.error('[referral-email] Failed to send welcome email', { to: input.to, err })
    return false
  }
}

function buildWelcomeReferralHtml(input: SendReferralWelcomeEmailInput): string {
  // Pre-compose the WhatsApp share message so the CTA can pre-fill it.
  // wa.me reads the `text` query param; URL-encoded UTF-8 ensures
  // accents survive across clients.
  const waMessage = encodeURIComponent(
    `¡Te recomiendo ${input.venueName}! Usa mi código *${input.referralCode}* y te dan ${input.newCustomerDiscountPercent}% en tu primera compra.`,
  )
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:600px;">
        <tr><td style="padding:40px 40px 0 40px;text-align:center;">
          <h1 style="margin:0 0 10px 0;font-size:28px;color:#10b981;">¡Bienvenida, ${escapeHtmlForReferralEmail(input.customerName)}!</h1>
          <p style="margin:0 0 30px 0;font-size:16px;line-height:1.5;color:#555;">Ya eres parte de ${escapeHtmlForReferralEmail(input.venueName)}. Aquí tienes tu código de referido para compartir con amigas y familia.</p>
        </td></tr>
        <tr><td align="center" style="padding:0 40px;">
          <img src="cid:tu-codigo-referido.png" alt="Tu código de referido" width="320" style="display:block;width:320px;max-width:320px;height:auto;border-radius:12px;" />
        </td></tr>
        <tr><td style="padding:30px 40px 0 40px;text-align:center;">
          <div style="font-size:14px;color:#888;margin-bottom:8px;">Tu código</div>
          <div style="font-family:monospace;font-size:24px;font-weight:bold;letter-spacing:2px;background:#f0fdf4;padding:16px;border-radius:8px;color:#10b981;">${escapeHtmlForReferralEmail(input.referralCode)}</div>
        </td></tr>
        <tr><td style="padding:30px 40px 40px 40px;text-align:center;">
          <a href="https://wa.me/?text=${waMessage}" style="display:inline-block;background:#25d366;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;">Compartir por WhatsApp</a>
        </td></tr>
        <tr><td style="padding:0 40px 40px 40px;">
          <p style="margin:0;font-size:14px;line-height:1.5;color:#888;text-align:center;">Cuando una persona use tu código en su primera compra, recibirá ${input.newCustomerDiscountPercent}% de descuento y tú acumulas un referido hacia tus premios.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

export interface SendReferralTierUpEmailInput {
  to: string
  customerName: string
  venueName: string
  tier: 'TIER_1' | 'TIER_2' | 'TIER_3'
  tierLabel: string
  referralCount: number
  rewardPercent: number
  couponCode: string
  validDays: number
  /** Pre-generated tier-up PNG (1080x1080). */
  cardPng: Buffer
}

export async function sendReferralTierUpEmail(input: SendReferralTierUpEmailInput): Promise<boolean> {
  if (!resend) {
    logger.warn('[referral-email] Resend not configured — skipping tier-up email')
    return false
  }
  try {
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: input.to,
      subject: `¡Lograste ${input.tierLabel} en ${input.venueName}! Aquí está tu premio`,
      html: buildTierUpReferralHtml(input),
      attachments: [
        {
          filename: 'premio-referido.png',
          content: input.cardPng,
        },
      ],
    })

    if (result.error) {
      logger.error('[referral-email] Failed to send tier-up email', { to: input.to, err: result.error })
      return false
    }

    logger.info('[referral-email] Tier-up email sent', { to: input.to, tier: input.tier, resendId: result?.data?.id })
    return true
  } catch (err) {
    logger.error('[referral-email] Failed to send tier-up email', { to: input.to, err })
    return false
  }
}

function buildTierUpReferralHtml(input: SendReferralTierUpEmailInput): string {
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:600px;">
        <tr><td style="padding:40px 40px 0 40px;text-align:center;">
          <h1 style="margin:0 0 10px 0;font-size:28px;color:#10b981;">¡Lograste ${escapeHtmlForReferralEmail(input.tierLabel)}!</h1>
          <p style="margin:0 0 30px 0;font-size:16px;line-height:1.5;color:#555;">${escapeHtmlForReferralEmail(input.customerName)}, refiriste a ${input.referralCount} personas a ${escapeHtmlForReferralEmail(input.venueName)}. Aquí tu premio.</p>
        </td></tr>
        <tr><td align="center" style="padding:0 40px;">
          <img src="cid:premio-referido.png" alt="Tu premio de tier" width="320" style="display:block;width:320px;max-width:320px;height:auto;border-radius:12px;" />
        </td></tr>
        <tr><td style="padding:30px 40px 0 40px;text-align:center;">
          <div style="font-size:14px;color:#888;margin-bottom:8px;">Tu cupón</div>
          <div style="font-family:monospace;font-size:22px;font-weight:bold;letter-spacing:2px;background:#f0fdf4;padding:16px;border-radius:8px;color:#10b981;">${escapeHtmlForReferralEmail(input.couponCode)}</div>
          <p style="margin:16px 0 0 0;font-size:14px;color:#888;">${input.rewardPercent}% de descuento · válido ${input.validDays} días</p>
        </td></tr>
        <tr><td style="padding:30px 40px 40px 40px;">
          <p style="margin:0;font-size:14px;line-height:1.5;color:#888;text-align:center;">Menciónalo en tu próxima visita o úsalo en tu próxima reserva. ¡Gracias por confiar en nosotros y por traer a tus amigas!</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}
