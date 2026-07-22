interface ReservationReturnUrlOptions {
  venueWebsite?: string | null
  nodeEnv?: string
}

const LOCAL_DEVELOPMENT_HOSTNAMES = new Set(['localhost', '127.0.0.1'])
const STRIPE_CHECKOUT_SESSION_PLACEHOLDER = '{CHECKOUT_SESSION_ID}'

function hostnameFromWebsite(website?: string | null): string | null {
  if (!website) return null

  try {
    return new URL(website).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Return a caller-provided booking redirect only when it belongs to an origin
 * controlled by Avoqado or the venue. Invalid input is intentionally ignored:
 * a malformed widget override must not turn a valid reservation into a 400.
 */
export function sanitizeReservationReturnUrl(candidate: unknown, options: ReservationReturnUrlOptions = {}): string | undefined {
  if (typeof candidate !== 'string' || candidate.length === 0) return undefined

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return undefined
  }

  if (parsed.username || parsed.password) return undefined

  const hostname = parsed.hostname.toLowerCase()
  const isLocalDevelopmentHost = LOCAL_DEVELOPMENT_HOSTNAMES.has(hostname)
  if (isLocalDevelopmentHost) {
    const isDevelopment = (options.nodeEnv ?? process.env.NODE_ENV) === 'development'
    if (!isDevelopment || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return undefined
    return candidate
  }

  if (parsed.protocol !== 'https:') return undefined

  const isAvoqadoHostname = hostname === 'avoqado.io' || hostname.endsWith('.avoqado.io')
  const venueHostname = hostnameFromWebsite(options.venueWebsite)
  if (!isAvoqadoHostname && hostname !== venueHostname) return undefined

  return candidate
}

/** Add or overwrite server-owned return parameters without string concatenation. */
export function buildReservationReturnUrl(baseUrl: string, params: Record<string, string>): string {
  const url = new URL(baseUrl)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

  // URLSearchParams correctly escapes every value, but Stripe requires this
  // one documented template token to remain literal for post-checkout expansion.
  return url.toString().replace(encodeURIComponent(STRIPE_CHECKOUT_SESSION_PLACEHOLDER), STRIPE_CHECKOUT_SESSION_PLACEHOLDER)
}

interface ReservationCheckoutReturnUrlsInput extends ReservationReturnUrlOptions {
  bookingPublicUrl: string
  venueSlug: string
  requestedSuccessUrl?: unknown
  requestedCancelUrl?: unknown
  reservationId: string
}

export function buildReservationCheckoutReturnUrls(input: ReservationCheckoutReturnUrlsInput): {
  successUrl: string
  cancelUrl: string
} {
  const defaultReturnUrl = `${input.bookingPublicUrl.replace(/\/+$/, '')}/${encodeURIComponent(input.venueSlug)}`
  const policy = { venueWebsite: input.venueWebsite, nodeEnv: input.nodeEnv }
  const baseSuccess = sanitizeReservationReturnUrl(input.requestedSuccessUrl, policy) ?? defaultReturnUrl
  const baseCancel = sanitizeReservationReturnUrl(input.requestedCancelUrl, policy) ?? baseSuccess

  return {
    successUrl: buildReservationReturnUrl(baseSuccess, {
      payment: 'success',
      reservationId: input.reservationId,
      session_id: STRIPE_CHECKOUT_SESSION_PLACEHOLDER,
    }),
    cancelUrl: buildReservationReturnUrl(baseCancel, {
      payment: 'cancelled',
      reservationId: input.reservationId,
    }),
  }
}
