export const COMMERCIAL_SCHEMA_VERSION_V2 = 2 as const
export const COMMERCIAL_CONTRACT_VERSION_V2 = '2.0.0' as const
export const COMMERCIAL_MARKET_V2 = 'MX' as const
export const COMMERCIAL_CURRENCY_V2 = 'MXN' as const

export const COMMERCIAL_MONEY_V2_PATTERN = /^(0|[1-9][0-9]{0,16})\.[0-9]{2}$/
export const COMMERCIAL_CODE_V2_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/
export const COMMERCIAL_SHA256_HEX_V2_PATTERN = /^[0-9a-f]{64}$/

export const MAX_COMMERCIAL_MONEY_MINOR = 9_223_372_036_854_775_807n
export const MAX_UNIT_AMOUNT_MINOR = 999_999_999_999n
export const MAX_QUANTITY = 1_000
export const MAX_LINE_LIST_SUBTOTAL_MINOR = 999_999_999_999_000n
export const MAX_QUOTE_LINES = 50
export const MAX_QUOTE_LIST_SUBTOTAL_MINOR = 49_999_999_999_950_000n
export const MAX_QUOTE_DISCOUNT_MINOR = MAX_QUOTE_LIST_SUBTOTAL_MINOR
export const MAX_QUOTE_TAX_MINOR = 7_999_999_999_992_000n
export const MAX_QUOTE_TOTAL_MINOR = 57_999_999_999_942_000n
export const MIN_STRIPE_NON_ZERO_AMOUNT_MINOR = 1_000n
export const MAX_STRIPE_AMOUNT_MINOR = 99_999_999n

export const COMMERCIAL_JSON_TEXT_V2_MAX_BYTES = 1_048_576
export const COMMERCIAL_JSON_TEXT_V2_MAX_DEPTH = 128

export const COMMERCIAL_V2_DOMAINS = Object.freeze({
  CATALOG_SNAPSHOT: 'avoqado.commercial.catalog-snapshot@2\0',
  CAMPAIGN_SNAPSHOT: 'avoqado.commercial.campaign-snapshot@2\0',
  QUOTE: 'avoqado.commercial.quote@2\0',
  QUOTE_SELECTION: 'avoqado.commercial.quote-selection@2\0',
  STRIPE_CHECKOUT_REQUEST: 'avoqado.commercial.stripe-checkout-request@2\0',
  CONTRACT_CATALOG: 'avoqado.commercial.contract.catalog@2\0',
  CONTRACT_CAMPAIGN: 'avoqado.commercial.contract.campaign@2\0',
  CONTRACT_QUOTE: 'avoqado.commercial.contract.quote@2\0',
  CONTRACT_ENTITLEMENTS: 'avoqado.commercial.contract.entitlements@2\0',
  CONTRACT_LIFECYCLE: 'avoqado.commercial.contract.lifecycle@2\0',
  CONTRACT_BUNDLE: 'avoqado.commercial.contract.bundle@2\0',
} as const)

export type CommercialV2Domain = (typeof COMMERCIAL_V2_DOMAINS)[keyof typeof COMMERCIAL_V2_DOMAINS]

export const COMMERCIAL_V2_DOMAIN_VALUES: readonly CommercialV2Domain[] = Object.freeze(Object.values(COMMERCIAL_V2_DOMAINS))
