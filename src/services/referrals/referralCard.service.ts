/**
 * Referral Card PNG service
 * --------------------------------------------------------------
 * Renders share-ready 1080x1080 PNG cards for the customer referral
 * program. Two variants exist today:
 *
 *   1. Welcome card  — sent when a Customer is first issued a
 *                      `referralCode`. The card embeds the code so the
 *                      customer can share by screenshot.
 *   2. Tier-up card  — sent when a Customer crosses a tier threshold
 *                      (TIER_1/2/3) and unlocks a reward coupon.
 *
 * Stack: Satori (HTML -> SVG) + resvg-js (SVG -> PNG). No headless
 * Chromium. Fonts are bundled in `src/assets/fonts/` and loaded once
 * at module level. The font loader walks a list of candidate paths so
 * the service works from both source (tsx watch) and `dist/` builds.
 */

// satori + satori-html are pure ESM. We load them dynamically so this
// file can stay CommonJS-compatible (the rest of the server compiles
// to CJS via ts-jest / tsc and importing them statically would force
// the entire transform pipeline into ESM mode). resvg-js is
// CommonJS-friendly, so a plain require is fine.
import { Resvg } from '@resvg/resvg-js'
import * as fs from 'fs'
import * as path from 'path'

type SatoriModule = typeof import('satori')
type SatoriHtmlModule = typeof import('satori-html')

let satoriPromise: Promise<SatoriModule> | null = null
let satoriHtmlPromise: Promise<SatoriHtmlModule> | null = null

async function loadSatori(): Promise<SatoriModule> {
  if (!satoriPromise) satoriPromise = import('satori')
  return satoriPromise
}

async function loadSatoriHtml(): Promise<SatoriHtmlModule> {
  if (!satoriHtmlPromise) satoriHtmlPromise = import('satori-html')
  return satoriHtmlPromise
}

// --- Font loading ---------------------------------------------------
// Satori needs raw TTF/OTF buffers. We bundle Inter-Regular and
// Inter-Bold in `src/assets/fonts/` and look up both at first use. If
// the bundled Inter files are missing (e.g. someone deleted them),
// fall back to system Helvetica so dev environments don't crash —
// the card looks duller but still renders.

let cachedRegular: Buffer | null = null
let cachedBold: Buffer | null = null

/**
 * Try several candidate locations for a bundled font. Order:
 *   1. Path relative to this file's compiled location
 *      (works for `dist/` after a build copies assets)
 *   2. Path relative to this file in source
 *      (works during `tsx watch` / tests)
 *   3. macOS system fallback (Helvetica)
 *
 * Returns the first existing buffer or throws if nothing is found.
 */
function loadFontByCandidates(filenames: string[]): Buffer {
  // Walk up from __dirname trying common asset locations.
  const baseDirs = [
    path.join(__dirname, '../../assets/fonts'),
    path.join(__dirname, '../../../src/assets/fonts'),
    path.join(__dirname, '../../../../src/assets/fonts'),
    path.join(process.cwd(), 'src/assets/fonts'),
    path.join(process.cwd(), 'dist/src/assets/fonts'),
  ]

  for (const dir of baseDirs) {
    for (const name of filenames) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate)
      }
    }
  }

  // Fallback to a guaranteed system font on macOS / most Linux Docker
  // images. Satori accepts TTC bundles.
  const systemFallbacks = ['/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial.ttf']
  for (const f of systemFallbacks) {
    if (fs.existsSync(f)) return fs.readFileSync(f)
  }

  throw new Error(
    `[referralCard] No system font available for card generation. Bundle Inter-Regular.ttf at src/assets/fonts/.`,
  )
}

function getRegularFont(): Buffer {
  if (cachedRegular) return cachedRegular
  cachedRegular = loadFontByCandidates(['Inter-Regular.ttf', 'Inter-Regular.otf'])
  return cachedRegular
}

function getBoldFont(): Buffer {
  if (cachedBold) return cachedBold
  // If bundled bold is missing, satori can synthesize bold from the
  // regular weight, so we tolerate the bold lookup failing silently.
  try {
    cachedBold = loadFontByCandidates(['Inter-Bold.ttf', 'Inter-Bold.otf'])
    return cachedBold
  } catch {
    cachedBold = getRegularFont()
    return cachedBold
  }
}

// --- Card markup ----------------------------------------------------

export interface WelcomeCardInput {
  customerName: string
  venueName: string
  referralCode: string
  newCustomerDiscountPercent: number
}

export interface TierUpCardInput {
  customerName: string
  venueName: string
  tier: 'TIER_1' | 'TIER_2' | 'TIER_3'
  tierLabel: string // e.g., "Nivel 1"
  referralCount: number
  rewardPercent: number
  couponCode: string
  validDays: number
}

// Brand color used as card background. Kept here as a single constant
// so we can later swap to per-venue theming without touching the
// markup builders.
const CARD_BG = '#10b981'

function escapeForJsx(s: string): string {
  // satori-html parses HTML strings, so we must escape `<`, `>`, `&`
  // and the JSX-significant `{`, `}` to keep user-supplied content safe.
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/{/g, '&#123;')
    .replace(/}/g, '&#125;')
}

function buildWelcomeMarkup(input: WelcomeCardInput): string {
  const name = escapeForJsx(input.customerName)
  const venue = escapeForJsx(input.venueName)
  const code = escapeForJsx(input.referralCode)
  return `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 1080px; height: 1080px; background: ${CARD_BG}; color: white; font-family: Inter, Helvetica, sans-serif; padding: 80px;">
      <div style="display: flex; font-size: 32px; opacity: 0.85; margin-bottom: 40px;">${venue}</div>
      <div style="display: flex; font-size: 72px; font-weight: 700; margin-bottom: 60px; text-align: center;">¡Bienvenida, ${name}!</div>
      <div style="display: flex; font-size: 28px; opacity: 0.9; margin-bottom: 30px;">Tu código de referido:</div>
      <div style="display: flex; font-size: 56px; font-weight: 700; background: rgba(255,255,255,0.15); padding: 30px 60px; border-radius: 24px; margin-bottom: 60px; font-family: monospace; letter-spacing: 2px;">${code}</div>
      <div style="display: flex; font-size: 28px; opacity: 0.9; text-align: center; max-width: 800px;">Comparte y tus amigas reciben ${input.newCustomerDiscountPercent}% en su primera compra.</div>
    </div>
  `
}

function buildTierUpMarkup(input: TierUpCardInput): string {
  // Star count communicates tier level without translating numeric
  // tier IDs — they read the same in any language.
  const stars = input.tier === 'TIER_1' ? '★' : input.tier === 'TIER_2' ? '★ ★' : '★ ★ ★'
  const name = escapeForJsx(input.customerName)
  const venue = escapeForJsx(input.venueName)
  const tierLabel = escapeForJsx(input.tierLabel)
  const coupon = escapeForJsx(input.couponCode)
  return `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 1080px; height: 1080px; background: ${CARD_BG}; color: white; font-family: Inter, Helvetica, sans-serif; padding: 80px;">
      <div style="display: flex; font-size: 32px; opacity: 0.85; margin-bottom: 30px;">${venue}</div>
      <div style="display: flex; font-size: 96px; margin-bottom: 30px; letter-spacing: 8px;">${stars}</div>
      <div style="display: flex; font-size: 72px; font-weight: 700; margin-bottom: 40px; text-align: center;">¡Lograste el ${tierLabel}!</div>
      <div style="display: flex; font-size: 36px; margin-bottom: 50px;">${name}</div>
      <div style="display: flex; font-size: 28px; opacity: 0.9; margin-bottom: 60px;">${input.referralCount} personas trajiste a ${venue}</div>
      <div style="display: flex; font-size: 28px; opacity: 0.9; margin-bottom: 20px;">Tu premio:</div>
      <div style="display: flex; font-size: 56px; font-weight: 700; margin-bottom: 40px;">${input.rewardPercent}% en tu próxima compra</div>
      <div style="display: flex; font-size: 32px; font-weight: 700; background: rgba(255,255,255,0.15); padding: 24px 48px; border-radius: 20px; margin-bottom: 30px; font-family: monospace; letter-spacing: 2px;">${coupon}</div>
      <div style="display: flex; font-size: 22px; opacity: 0.85;">Válido ${input.validDays} días</div>
    </div>
  `
}

// --- PNG pipeline ---------------------------------------------------

async function renderToPng(markup: string): Promise<Buffer> {
  const [{ default: satori }, { html: satoriHtml }] = await Promise.all([loadSatori(), loadSatoriHtml()])
  const root = satoriHtml(markup) as any
  const svg = await satori(root, {
    width: 1080,
    height: 1080,
    fonts: [
      { name: 'Inter', data: getRegularFont(), weight: 400, style: 'normal' },
      { name: 'Inter', data: getBoldFont(), weight: 700, style: 'normal' },
    ],
  })
  const resvg = new Resvg(svg, { background: 'transparent' })
  const pngData = resvg.render()
  return pngData.asPng()
}

export async function generateWelcomeCard(input: WelcomeCardInput): Promise<Buffer> {
  return renderToPng(buildWelcomeMarkup(input))
}

export async function generateTierUpCard(input: TierUpCardInput): Promise<Buffer> {
  return renderToPng(buildTierUpMarkup(input))
}

/**
 * Convert a PNG buffer to a base64 data URI. Useful when embedding
 * directly inline (e.g. `<img src="data:...">` in chat previews).
 * The email path uses CID attachments instead of data URIs because
 * many email clients drop large base64-encoded images.
 */
export function pngBufferToBase64DataUri(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString('base64')}`
}
