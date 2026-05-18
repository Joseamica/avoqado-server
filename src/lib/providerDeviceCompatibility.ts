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
import { IncompatibleDeviceError } from '@/errors/AppError'

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
      select: { id: true, brand: true },
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
}

/**
 * Bulk variant of `assertMerchantTerminalCompatible` for set/replace flows
 * (e.g. dashboard "edit terminal assignments"). Loads the terminal + all
 * merchants in 2 queries, collects every incompatible merchant, and throws a
 * single `IncompatibleDeviceError` listing all offenders. This keeps the
 * operator UI honest — no "fix one, discover the next" loop.
 *
 * No-op when `merchantAccountIds` is empty.
 */
export async function assertMerchantsTerminalCompatible(
  terminalId: string,
  merchantAccountIds: string[],
  tx: Tx = prismaDefault as unknown as Tx,
): Promise<void> {
  if (!merchantAccountIds.length) return

  const [terminal, merchants] = await Promise.all([
    tx.terminal.findUnique({
      where: { id: terminalId },
      select: { id: true, brand: true },
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
    throw new IncompatibleDeviceError(
      `Cannot assign incompatible merchants to ${terminal.brand} terminal ${terminalId}: ${summary}`,
    )
  }
}
