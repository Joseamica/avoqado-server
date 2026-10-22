/**
 * Provider ↔ Device-brand compatibility helpers
 *
 * Spec: §3.1 + §4.4 (AngelPay SDK 1.0.5 multi-merchant migration)
 *
 * The TPV runtime is hardware-bound:
 *   - Blumon SDK only initializes on PAX terminals
 *   - AngelPay app-to-app intents only resolve on Nexgo terminals
 *
 * The backend therefore must refuse to provision a `MerchantAccount` for a
 * given provider if the venue has no compatible hardware. This module owns:
 *   1. The canonical catalog (`PROVIDER_DEVICE_COMPATIBILITY`)
 *   2. A cheap synchronous predicate (`isProviderCompatibleWithBrand`)
 *   3. A DB-aware guard that throws on no-go (`assertVenueHasCompatibleTerminal`)
 *
 * Wired into `createMerchantAccount` (Task 10), `assignTerminal` (Task 11),
 * and terminal brand change (Task 12/13).
 */

import type { PrismaClient, Prisma } from '@prisma/client'
import prismaDefault from '@/utils/prismaClient'
import { ConflictError, IncompatibleDeviceError } from '@/errors/AppError'

type Tx = PrismaClient | Prisma.TransactionClient

/**
 * Canonical mapping: provider code → list of compatible Terminal.brand values.
 *
 * Providers NOT listed here are treated as unconstrained (e.g. STRIPE, B4BIT
 * — they don't care which hardware the venue runs). Adding a new entry here
 * is the single place that activates a compatibility constraint.
 *
 * Values must match the canonical brand set produced by migration
 * `20260518011942_normalize_terminal_brand` (`PAX | NEXGO | INGENICO | VERIFONE`).
 */
export const PROVIDER_DEVICE_COMPATIBILITY: Record<string, string[]> = {
  BLUMON: ['PAX'],
  ANGELPAY: ['NEXGO'],
}

/**
 * Canonical `Terminal.brand` values FOR PAYMENT HARDWARE. Not an exhaustive
 * list of every valid `Terminal.brand` — printers/KDS/tablets legitimately use
 * other values (e.g. "Epson", "Apple", "Star Micronics") that are irrelevant to
 * `PROVIDER_DEVICE_COMPATIBILITY`. Do NOT turn this into a strict allowlist on
 * the create/update route schemas — use `normalizeTerminalBrand` instead, which
 * only fixes casing on these four and leaves everything else untouched.
 */
export const TERMINAL_BRANDS = ['PAX', 'NEXGO', 'INGENICO', 'VERIFONE'] as const
export type TerminalBrand = (typeof TERMINAL_BRANDS)[number]

/**
 * Normalizes a `brand` string to its canonical case when it matches one of
 * `TERMINAL_BRANDS` case-insensitively (e.g. `"Nexgo"` → `"NEXGO"`,
 * `"verifone"` → `"VERIFONE"`) — this is what the case-mismatch bug needed.
 * Anything else (printer/tablet brands, typos of non-canonical values) passes
 * through unchanged (trimmed), since `brand` isn't exclusive to payment
 * hardware and rejecting unknown values would break legitimate terminal types.
 */
export function normalizeTerminalBrand(brand: string | null | undefined): string | null | undefined {
  if (!brand) return brand
  const trimmed = brand.trim()
  const canonical = TERMINAL_BRANDS.find(b => b.toLowerCase() === trimmed.toLowerCase())
  return canonical ?? trimmed
}

/**
 * Cheap synchronous predicate — no DB call.
 *
 * Permissive on unknown providers and null brands:
 *   - Unknown provider → not in catalog → no constraint → true
 *   - Null brand → terminal not yet activated → can't reject yet → true
 *
 * Use this for UI hints / fast path checks. For authoritative
 * provisioning decisions, use `assertVenueHasCompatibleTerminal` (which
 * counts ACTIVE terminals at the venue).
 */
export function isProviderCompatibleWithBrand(providerCode: string, brand: string | null): boolean {
  const compatible = PROVIDER_DEVICE_COMPATIBILITY[providerCode]
  if (!compatible?.length || !brand) return true
  return compatible.includes(brand)
}

/**
 * Asserts that the given venue has at least one ACTIVE terminal whose `brand`
 * is in the provider's compatible set. Throws `IncompatibleDeviceError` (HTTP
 * 409, code `INCOMPATIBLE_DEVICE`) otherwise.
 *
 * No-op for unconstrained providers (those not in the catalog).
 *
 * Accepts an optional `tx` so it can be called inside `prisma.$transaction()`
 * — e.g., from `createMerchantAccount` where the merchant insert and the
 * compat check must succeed/fail together.
 */
export async function assertVenueHasCompatibleTerminal(
  venueId: string,
  providerCode: string,
  tx: Tx = prismaDefault as unknown as Tx,
): Promise<void> {
  const compatible = PROVIDER_DEVICE_COMPATIBILITY[providerCode]
  if (!compatible?.length) return

  const count = await tx.terminal.count({
    where: { venueId, brand: { in: compatible }, status: 'ACTIVE' },
  })

  if (count === 0) {
    throw new IncompatibleDeviceError(
      `Provider ${providerCode} requires at least one ACTIVE ${compatible.join(' or ')} terminal in this venue`,
    )
  }
}

/**
 * Validation point #2 (spec §3.1 point 2b, §4.4): guard for terminal ↔ merchant
 * assignment writes. Call this BEFORE pushing a `merchantAccountId` onto a
 * `Terminal.assignedMerchantIds` array.
 *
 * Loads the terminal's `brand` and the merchant's `provider.code`, then runs
 * the synchronous predicate. Throws `IncompatibleDeviceError` (HTTP 409, code
 * `INCOMPATIBLE_DEVICE`) on mismatch — e.g. attempting to assign an ANGELPAY
 * merchant to a PAX terminal, or a BLUMON merchant to a NEXGO terminal.
 *
 * Permissive cases (no-op):
 *   - Unknown provider not in the catalog (STRIPE, MENTA, etc.)
 *   - Terminal brand is null (PENDING_ACTIVATION) — accept and re-validate on
 *     activation. See `isProviderCompatibleWithBrand` contract.
 *
 * Bulk variant: see `assertMerchantsTerminalCompatible` which emits a single
 * error listing all incompatible merchant ids for operator UX.
 *
 * Accepts an optional `tx` so callers inside a `$transaction` reuse the same
 * client.
 */
export async function assertMerchantTerminalCompatible(
  terminalId: string,
  merchantAccountId: string,
  tx: Tx = prismaDefault as unknown as Tx,
): Promise<void> {
  const [terminal, merchant] = await Promise.all([
    tx.terminal.findUnique({
      where: { id: terminalId },
      select: { id: true, brand: true, venueId: true },
    }),
    tx.merchantAccount.findUnique({
      where: { id: merchantAccountId },
      select: { id: true, provider: { select: { code: true } } },
    }),
  ])

  if (!terminal) {
    throw new IncompatibleDeviceError(`Terminal ${terminalId} not found`)
  }
  if (!merchant) {
    throw new IncompatibleDeviceError(`MerchantAccount ${merchantAccountId} not found`)
  }

  if (!isProviderCompatibleWithBrand(merchant.provider.code, terminal.brand)) {
    throw new IncompatibleDeviceError(
      `Cannot assign ${merchant.provider.code} merchant ${merchantAccountId} to ${terminal.brand} terminal ${terminalId}`,
    )
  }
  await assertAngelPayLoginsInVenue(terminal.venueId, [merchantAccountId], tx)
}

/**
 * Bulk variant of `assertMerchantTerminalCompatible` for set/replace flows
 * (e.g. dashboard "edit terminal assignments"). Loads the terminal + all
 * merchants in 2 queries, collects every incompatible merchant, and throws a
 * single `IncompatibleDeviceError` listing all offenders. This keeps the
 * operator UI honest — no "fix one, discover the next" loop.
 *
 * No-op when `merchantAccountIds` is empty.
 *
 * `servingVenueId`: the venue the terminal will serve with these merchants. Defaults to its current venue; a migration
 * passes the DESTINATION, because the AngelPay login has to live where the terminal is going.
 */
export async function assertMerchantsTerminalCompatible(
  terminalId: string,
  merchantAccountIds: string[],
  tx: Tx = prismaDefault as unknown as Tx,
  servingVenueId?: string,
): Promise<void> {
  if (!merchantAccountIds.length) return

  const [terminal, merchants] = await Promise.all([
    tx.terminal.findUnique({
      where: { id: terminalId },
      select: { id: true, brand: true, venueId: true },
    }),
    tx.merchantAccount.findMany({
      where: { id: { in: merchantAccountIds } },
      select: { id: true, provider: { select: { code: true } } },
    }),
  ])

  if (!terminal) {
    throw new IncompatibleDeviceError(`Terminal ${terminalId} not found`)
  }

  const incompatible = merchants.filter(m => !isProviderCompatibleWithBrand(m.provider.code, terminal.brand))
  if (incompatible.length > 0) {
    const summary = incompatible.map(m => `${m.id} (${m.provider.code})`).join(', ')
    throw new IncompatibleDeviceError(`Cannot assign incompatible merchants to ${terminal.brand} terminal ${terminalId}: ${summary}`)
  }
  await assertAngelPayLoginsInVenue(servingVenueId ?? terminal.venueId, merchantAccountIds, tx)
}

export const ANGELPAY_LOGIN_EN_OTRO_NEGOCIO = 'ANGELPAY_LOGIN_EN_OTRO_NEGOCIO'

/**
 * Un comercio de AngelPay sólo cobra en un negocio que tenga su llave (`AngelPayUserAccount`): la configuración de la
 * terminal sólo manda las llaves de SU negocio. Si la llave del comercio vive en otro, la terminal recibe la
 * configuración sin credenciales y no cobra («Faltan credenciales de AngelPay»). Pasó en IQ el 20-oct-2026: se le
 * asignó «IQ T», cuya llave seguía en Amaena, y el panel dijo «guardado».
 *
 * Mover una llave de negocio no tiene pantalla (founder, 21-oct: «dile a tu IA que lo haga manual»): el mensaje lo dice.
 * Los comercios sin llave ligada (legacy) y los que no son de AngelPay pasan.
 */
export async function assertAngelPayLoginsInVenue(
  venueId: string,
  merchantAccountIds: Array<string | null | undefined>,
  tx: Tx = prismaDefault as unknown as Tx,
): Promise<void> {
  const ids = [...new Set(merchantAccountIds.filter((id): id is string => !!id))]
  if (!ids.length) return

  const ajenos = await tx.merchantAccount.findMany({
    where: { id: { in: ids }, angelpayUserAccount: { venueId: { not: venueId } } },
    select: { displayName: true, externalMerchantId: true, angelpayUserAccount: { select: { venue: { select: { name: true } } } } },
    take: ids.length,
  })
  if (!ajenos.length) return

  const detalle = ajenos
    .map(m => `«${m.displayName ?? m.externalMerchantId}» (su llave está en ${m.angelpayUserAccount?.venue.name ?? 'otro negocio'})`)
    .join(', ')
  throw new ConflictError(
    `La llave de AngelPay de ${detalle} es de otro negocio, así que la terminal no podría cobrar. ` +
      'Pídele a tu IA que mueva esa llave a este negocio a mano y vuelve a intentarlo.',
    ANGELPAY_LOGIN_EN_OTRO_NEGOCIO,
  )
}

/**
 * El lado inverso: cambiar la llave de un comercio que YA cobra en terminales o cuentas de un negocio. Si la llave nueva
 * es de otro negocio, esas terminales dejan de recibir credenciales (Codex r1 del 21-oct-2026, hallazgo 3).
 */
export async function assertNuevaLlaveEnLosNegociosDelComercio(
  merchantAccountId: string,
  angelpayUserAccountId: string,
  tx: Tx = prismaDefault as unknown as Tx,
): Promise<void> {
  const login = await tx.angelPayUserAccount.findUnique({
    where: { id: angelpayUserAccountId },
    select: { venueId: true, venue: { select: { name: true } } },
  })
  if (!login) return // la llave inexistente la rechaza la llave foránea, como antes

  const [terminal, cuentas] = await Promise.all([
    tx.terminal.findFirst({
      where: { assignedMerchantIds: { has: merchantAccountId }, venueId: { not: login.venueId } },
      select: { venue: { select: { name: true } } },
    }),
    tx.venuePaymentConfig.findFirst({
      where: {
        venueId: { not: login.venueId },
        OR: [{ primaryAccountId: merchantAccountId }, { secondaryAccountId: merchantAccountId }, { tertiaryAccountId: merchantAccountId }],
      },
      select: { venue: { select: { name: true } } },
    }),
  ])
  const otro = terminal?.venue.name ?? cuentas?.venue.name
  if (!otro) return

  throw new ConflictError(
    `Este comercio cobra en «${otro}», pero la llave de AngelPay elegida es de «${login.venue.name}», así que esas terminales ` +
      'dejarían de cobrar. Pídele a tu IA que lo acomode a mano.',
    ANGELPAY_LOGIN_EN_OTRO_NEGOCIO,
  )
}
