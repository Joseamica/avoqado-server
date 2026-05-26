/**
 * Shared branding primitives for payment-link and reservation branding.
 * Single source of truth for the brand-accent fallback rule and the font
 * whitelist so both surfaces stay consistent.
 */

/** Whitelisted fonts offered by every branding editor. Keep in sync with the
 *  dashboard catalog (payment-link-fonts.ts). */
export const BRANDING_FONT_IDS = [
  'DM Sans',
  'Inter',
  'Roboto',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Poppins',
  'Nunito',
  'Work Sans',
  'Raleway',
  'Playfair Display',
  'Merriweather',
  'Lora',
  'PT Serif',
  'Bebas Neue',
  'Oswald',
  'Anton',
  'Archivo Black',
  'Alfa Slab One',
  'Fjalla One',
  'Russo One',
  'Caveat',
  'Pacifico',
  'Dancing Script',
  'Sacramento',
  'Fira Code',
  'JetBrains Mono',
  'Roboto Mono',
] as const

/**
 * Resolve the brand accent fallback. When a surface has no explicit color set,
 * inherit the venue's `primaryColor` (the same field the booking widget uses as
 * `--avq-accent`); fall back to the legacy blue only when primaryColor is unset
 * or not a CSS color. Resolved at READ time and never persisted — so changing
 * primaryColor keeps propagating (live inheritance).
 */
export function resolveBrandFallbackColor(primaryColor?: string | null, legacyDefault = '#006aff'): string {
  const trimmed = typeof primaryColor === 'string' ? primaryColor.trim() : ''
  return /^(#[0-9a-fA-F]{3,8}|rgb|hsl|oklch|color\()/.test(trimmed) ? trimmed : legacyDefault
}
