/**
 * Referral WhatsApp Service
 *
 * Phase 4 of the customer referral program. Generates wa.me deep links the
 * customer (or a venue staff member) can tap to open WhatsApp with the
 * message body pre-filled. We use deep links — NOT the Meta Cloud API
 * sendTemplateMessage path — because every business-initiated WhatsApp send
 * requires a pre-approved Meta utility template in es_MX, and no template
 * for the referral flow has been registered yet (V2 work).
 *
 * Until that template is approved, customers share their referral code via
 * the "Compartir por WhatsApp" CTA in their welcome email (Plan 3) and the
 * dashboard surfaces the same link through the share-link endpoint defined
 * in referrals.controller.ts.
 *
 * Deep link spec: https://faq.whatsapp.com/5913398998672934
 *   - `https://wa.me/?text=…`              → opens a generic share sheet
 *   - `https://wa.me/<phone>?text=…`       → opens chat with that recipient
 *   - `<phone>` must be digits-only E.164 (no +). We strip non-digit chars
 *     defensively because the incoming string may come from form input.
 */

/**
 * Input for the welcome share link — used when a customer shares their own
 * code with a friend. `phone` is optional: when omitted the link opens the
 * generic share sheet so the customer can pick any contact.
 */
export interface ReferralWhatsAppDeepLinkInput {
  venueName: string
  referralCode: string
  newCustomerDiscountPercent: number
  /** Optional E.164 phone (with or without +). When omitted, returns a generic share URL. */
  phone?: string
}

/**
 * Build the message body shared with a friend. Kept as a named helper so the
 * controller can also surface the raw text (e.g. for a "copy text" button in
 * the dashboard) without re-deriving the wording.
 */
export function buildWelcomeShareMessage(
  input: Pick<ReferralWhatsAppDeepLinkInput, 'venueName' | 'referralCode' | 'newCustomerDiscountPercent'>,
): string {
  return `¡Te recomiendo ${input.venueName}! Usa mi código *${input.referralCode}* y te dan ${input.newCustomerDiscountPercent}% en tu primera compra.`
}

/**
 * Build a wa.me deep link the customer can tap to share their referral code.
 *
 * When `phone` is supplied, returns a 1:1 chat link with the recipient
 * pre-filled (digits-only). When `phone` is omitted, returns a generic
 * share URL that opens WhatsApp's contact picker.
 */
export function buildWelcomeShareDeepLink(input: ReferralWhatsAppDeepLinkInput): string {
  const text = encodeURIComponent(buildWelcomeShareMessage(input))
  if (input.phone && input.phone.trim().length > 0) {
    const digits = input.phone.replace(/\D/g, '')
    return `https://wa.me/${digits}?text=${text}`
  }
  return `https://wa.me/?text=${text}`
}

/**
 * Input for the tier-up admin share link. Used by a manager who wants to
 * congratulate a customer in WhatsApp without manually typing the coupon
 * details.
 */
export interface ReferralTierUpWhatsAppInput {
  /** E.164 of the referrer (the customer being congratulated). */
  customerPhone: string
  customerName: string
  venueName: string
  tier: 'TIER_1' | 'TIER_2' | 'TIER_3'
  tierLabel: string
  rewardPercent: number
  couponCode: string
  validDays: number
}

export function buildTierUpAdminShareMessage(
  input: Pick<ReferralTierUpWhatsAppInput, 'customerName' | 'venueName' | 'tierLabel' | 'rewardPercent' | 'couponCode' | 'validDays'>,
): string {
  return `¡${input.customerName}, lograste el ${input.tierLabel} en ${input.venueName}! 🎉\nTu premio: ${input.rewardPercent}% de descuento. Código: ${input.couponCode}. Válido ${input.validDays} días.`
}

/**
 * Build a wa.me link the manager taps to open WhatsApp with the customer
 * pre-selected and a celebratory tier-up message ready to send.
 */
export function buildTierUpAdminShareLink(input: ReferralTierUpWhatsAppInput): string {
  const digits = input.customerPhone.replace(/\D/g, '')
  const text = encodeURIComponent(buildTierUpAdminShareMessage(input))
  return `https://wa.me/${digits}?text=${text}`
}
