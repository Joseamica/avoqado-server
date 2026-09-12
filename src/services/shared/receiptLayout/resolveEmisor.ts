import type { ReceiptVenueInfo } from './types'

export interface ResolvedEmisor {
  legalName: string | null
  rfc: string | null
  lugarExpedicion: string | null
  source: 'merchant' | 'principal' | 'legacy'
}

/**
 * Hoy hay TRES respuestas a «¿qué RFC va en el ticket?» (auditoría 2-sep): la PAX usa las
 * columnas legacy de Venue, Android/iOS el primer emisor, y nadie mira el emisor de la cuenta
 * que cobró. Ésta es la única regla, en este orden (spec § 5.6). Pura: sin Prisma, sin reloj.
 */
export function resolveEmisor(venue: ReceiptVenueInfo, merchantAccountId?: string | null): ResolvedEmisor | null {
  const byMerchant = merchantAccountId ? venue.fiscalEmisors.find(e => e.merchantAccountIds.includes(merchantAccountId)) : undefined
  if (byMerchant)
    return { legalName: byMerchant.legalName, rfc: byMerchant.rfc, lugarExpedicion: byMerchant.lugarExpedicion, source: 'merchant' }

  const principal = (venue.principalEmisorId && venue.fiscalEmisors.find(e => e.id === venue.principalEmisorId)) || venue.fiscalEmisors[0]
  if (principal)
    return { legalName: principal.legalName, rfc: principal.rfc, lugarExpedicion: principal.lugarExpedicion, source: 'principal' }

  if (venue.legacy.legalName || venue.legacy.rfc) {
    return { legalName: venue.legacy.legalName, rfc: venue.legacy.rfc, lugarExpedicion: null, source: 'legacy' }
  }
  return null
}
