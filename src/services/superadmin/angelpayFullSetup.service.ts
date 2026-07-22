/**
 * fullSetupAngelPayMerchant — one-shot AngelPay account setup.
 *
 * Creates, in a SINGLE Prisma interactive transaction (all-or-nothing):
 *   1. AngelPay login (AngelPayUserAccount) — new, or an existing ACTIVE one
 *   2. MerchantAccount (provider ANGELPAY), linked to the login
 *   3. VenuePaymentConfig slot assignment (fill an empty slot or replace one)
 *   4. Terminal → merchant links (optional)
 *   5. ProviderCostStructure — what the processor charges us (optional)
 *   6. VenuePricingStructure — what we charge the venue (optional)
 *   7. SettlementConfiguration per main card type (optional)
 *
 * Writes are inline (not via the per-entity service helpers) so the whole
 * thing is one transaction — some helpers open their own $transaction and
 * cannot be nested. See specs/2026-05-21-angelpay-merchant-wizard-design.md §7.
 *
 * No external/network calls happen inside the transaction.
 */
import prisma from '../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError, ValidationError } from '../../errors/AppError'
import logger from '../../config/logger'
import { BASE_URL } from '../../config/env'
import { isNumericMerchantId } from '../../lib/angelpayValidators'
import { encryptCredentials } from './merchantAccount.service'
import { angelPayIntegrationsApiClient, type AngelPayEnvironment } from '../integrations/angelpay-integrations-api.client'
import type { FullSetupAngelPayInput } from '../../schemas/dashboard/angelpay-full-setup.schema'

// BASE_URL is `.optional()` in env.ts (unset in local dev). Same fallback
// pattern as `cfdi.public.controller.ts` — never build the AngelPay webhook
// URL against a literal "undefined/api/v1/...".
const PUBLIC_BASE_URL = BASE_URL || 'https://api.avoqado.io'

// Registered on every AngelPay webhook — see angelpay-integrations-api.client.ts header.
const ANGELPAY_WEBHOOK_EVENTS = ['send_transaction', 'offline_event', 'canceled_transaction']

const SLOT_COLUMN = {
  PRIMARY: 'primaryAccountId',
  SECONDARY: 'secondaryAccountId',
  TERTIARY: 'tertiaryAccountId',
} as const

// Settlement configs are created per card type. OTHER is intentionally skipped.
const SETTLEMENT_CARD_TYPES = ['DEBIT', 'CREDIT', 'AMEX', 'INTERNATIONAL'] as const

export interface FullSetupAngelPayResult {
  merchantAccountId: string
  angelpayUserAccountId: string
  venuePaymentConfigUpdated: boolean
  terminalIds: string[]
  costStructureId?: string
  pricingStructureId?: string
  settlementIds: string[]
  /** True only when `input.apiKey` was provided AND the webhook was registered
   * AND the returned secret was persisted. False (never throws) on any
   * failure in that chain — see the soft-fail block below. */
  webhookRegistered: boolean
}

export async function fullSetupAngelPayMerchant(input: FullSetupAngelPayInput, createdBy?: string): Promise<FullSetupAngelPayResult> {
  // Fast-fail validation before opening the transaction.
  if (input.merchant.mode === 'create' && !isNumericMerchantId(input.merchant.externalMerchantId)) {
    throw new ValidationError('El ID del merchant debe ser numérico')
  }
  if (input.slot.mode === 'replace') {
    if (!input.slot.replacedAccountId) {
      throw new ValidationError('replacedAccountId es requerido al reemplazar un slot')
    }
    if (!input.pricing) {
      throw new ValidationError('El pricing es obligatorio al reemplazar un slot')
    }
  }
  // PRIMARY is a required column — it can never be left empty.
  if (input.slot.moveStrategy === 'vacate' && input.slot.fromSlot === 'PRIMARY') {
    throw new ValidationError('No se puede vaciar el slot PRIMARY')
  }

  const angelpayProvider = await prisma.paymentProvider.findUnique({ where: { code: 'ANGELPAY' } })
  if (!angelpayProvider) {
    throw new NotFoundError('PaymentProvider ANGELPAY no encontrado — ¿se corrió el seed?')
  }

  const slotColumn = SLOT_COLUMN[input.slot.accountType]

  try {
    const result = await prisma.$transaction(
      async tx => {
        // ---- 1. Login ----
        let angelpayUserAccountId: string
        if (input.login.mode === 'new') {
          const newLogin = input.login
          // Reuse a soft-deleted (venueId, email) row if one exists — a plain
          // create would otherwise hit the (venueId, email) unique constraint.
          const existingLogin = await tx.angelPayUserAccount.findUnique({
            where: { venueId_email: { venueId: input.venueId, email: newLogin.email } },
          })
          if (existingLogin) {
            if (existingLogin.status !== 'DELETED') {
              throw new ConflictError('Ya existe una cuenta AngelPay con ese correo en este venue')
            }
            const reactivated = await tx.angelPayUserAccount.update({
              where: { id: existingLogin.id },
              data: {
                pin: newLogin.pin,
                environment: newLogin.environment,
                status: 'ACTIVE',
                statusChangedAt: new Date(),
                statusChangedBy: createdBy ?? null,
                statusReason: null,
                lastValidationErr: null,
              },
            })
            angelpayUserAccountId = reactivated.id
          } else {
            const login = await tx.angelPayUserAccount.create({
              data: {
                venueId: input.venueId,
                email: newLogin.email,
                pin: newLogin.pin,
                environment: newLogin.environment,
                status: 'ACTIVE',
                statusChangedAt: new Date(),
                statusChangedBy: createdBy ?? null,
                createdBy: createdBy ?? null,
              },
            })
            angelpayUserAccountId = login.id
          }
        } else {
          const login = await tx.angelPayUserAccount.findUnique({
            where: { id: input.login.angelpayUserAccountId },
          })
          if (!login) throw new NotFoundError('Cuenta AngelPay no encontrada')
          if (login.venueId !== input.venueId) {
            throw new ValidationError('La cuenta AngelPay pertenece a otro venue')
          }
          if (login.status !== 'ACTIVE') {
            throw new ValidationError('La cuenta AngelPay seleccionada no está activa')
          }
          if (login.lastValidationErr) {
            throw new ValidationError('La cuenta AngelPay tiene un error de validación pendiente')
          }
          angelpayUserAccountId = login.id
        }

        // ---- 2. Merchant account — create a new one, or reuse an existing ----
        let merchantAccount: { id: string }
        if (input.merchant.mode === 'existing') {
          const existing = await tx.merchantAccount.findUnique({
            where: { id: input.merchant.merchantAccountId },
            include: { provider: true },
          })
          if (!existing) throw new NotFoundError('Cuenta de comercio no encontrada')
          if (existing.provider.code !== 'ANGELPAY') {
            throw new ValidationError('La cuenta de comercio seleccionada no es de AngelPay')
          }
          if (existing.angelpayUserAccountId !== angelpayUserAccountId) {
            throw new ValidationError('La cuenta de comercio pertenece a otra cuenta AngelPay')
          }
          // A discovered merchant lands inactive (PENDING_REVIEW) — activate it
          // so it can route payments once wired into the slot.
          if (!existing.active) {
            await tx.merchantAccount.update({ where: { id: existing.id }, data: { active: true } })
          }
          merchantAccount = { id: existing.id }
        } else {
          // credentialsEncrypted is a required Json column; AngelPay auth lives
          // on the login, so we store an encrypted empty placeholder.
          merchantAccount = await tx.merchantAccount.create({
            data: {
              providerId: angelpayProvider.id,
              externalMerchantId: input.merchant.externalMerchantId,
              displayName: input.merchant.displayName,
              angelpayMerchantName: input.merchant.name,
              angelpayAffiliation: input.merchant.affiliation,
              angelpayUserAccountId,
              aggregatorId: input.aggregatorId ?? null,
              active: true,
              credentialsEncrypted: encryptCredentials({}),
            },
          })
        }

        // ---- 3. Venue payment config slot ----
        const existingConfig = await tx.venuePaymentConfig.findUnique({
          where: { venueId: input.venueId },
        })
        if (!existingConfig) {
          if (input.slot.accountType !== 'PRIMARY') {
            throw new BadRequestError('El venue no tiene configuración de pagos — el primer slot debe ser PRIMARY')
          }
          await tx.venuePaymentConfig.create({
            data: {
              venueId: input.venueId,
              primaryAccountId: merchantAccount.id,
              routingRules: {},
              preferredProcessor: 'AUTO',
            },
          })
        } else {
          const occupant = (existingConfig as Record<string, unknown>)[slotColumn] as string | null | undefined
          if (input.slot.mode === 'replace') {
            // Conditional guard — the slot must still hold the account the
            // operator saw when they chose to replace it.
            if (occupant !== input.slot.replacedAccountId) {
              throw new ConflictError('El slot cambió desde que lo viste, reintenta')
            }
          } else if (occupant) {
            throw new ConflictError(`El slot ${input.slot.accountType} ya está ocupado`)
          }
          // Point the target slot at the merchant. When the merchant is being
          // MOVED from another slot, also resolve that old slot in the SAME
          // update so the merchant never lands in two slots at once.
          const data: Record<string, string | null> = { [slotColumn]: merchantAccount.id }
          if (input.slot.fromSlot && input.slot.fromSlot !== input.slot.accountType) {
            const fromColumn = SLOT_COLUMN[input.slot.fromSlot]
            data[fromColumn] = input.slot.moveStrategy === 'swap' ? (input.slot.replacedAccountId ?? null) : null
          }
          await tx.venuePaymentConfig.update({ where: { venueId: input.venueId }, data })
        }

        // ---- 4. Terminals ----
        const terminalIds: string[] = []
        if (input.terminalIds && input.terminalIds.length > 0) {
          for (const terminalId of new Set(input.terminalIds)) {
            const terminal = await tx.terminal.findUnique({
              where: { id: terminalId },
              select: { id: true, venueId: true, assignedMerchantIds: true },
            })
            if (!terminal) throw new BadRequestError(`Terminal ${terminalId} no encontrada`)
            if (terminal.venueId !== input.venueId) {
              throw new BadRequestError(`La terminal ${terminalId} no pertenece a este venue`)
            }
            const current = terminal.assignedMerchantIds ?? []
            if (!current.includes(merchantAccount.id)) {
              await tx.terminal.update({
                where: { id: terminalId },
                data: { assignedMerchantIds: { set: [...current, merchantAccount.id] } },
              })
            }
            terminalIds.push(terminalId)
          }
        }

        // ---- 5. Cost structure (processor → us) ----
        let costStructureId: string | undefined
        if (input.cost) {
          const cost = await tx.providerCostStructure.create({
            data: {
              providerId: angelpayProvider.id,
              merchantAccountId: merchantAccount.id,
              debitRate: input.cost.debitRate,
              creditRate: input.cost.creditRate,
              amexRate: input.cost.amexRate,
              internationalRate: input.cost.internationalRate,
              includesTax: input.cost.includesTax,
              taxRate: input.cost.taxRate,
              fixedCostPerTransaction: input.cost.fixedCostPerTransaction ?? null,
              monthlyFee: input.cost.monthlyFee ?? null,
              effectiveFrom: new Date(input.cost.effectiveFrom),
              active: true,
            },
          })
          costStructureId = cost.id
        }

        // ---- 6. Venue pricing (us → venue) ----
        let pricingStructureId: string | undefined
        if (input.pricing) {
          // Deactivate any current pricing for this venue + accountType so the
          // new merchant in this slot does not inherit stale pricing.
          await tx.venuePricingStructure.updateMany({
            where: { venueId: input.venueId, accountType: input.slot.accountType, active: true },
            data: { active: false },
          })
          const pricing = await tx.venuePricingStructure.create({
            data: {
              venueId: input.venueId,
              accountType: input.slot.accountType,
              debitRate: input.pricing.debitRate,
              creditRate: input.pricing.creditRate,
              amexRate: input.pricing.amexRate,
              internationalRate: input.pricing.internationalRate,
              includesTax: input.pricing.includesTax,
              taxRate: input.pricing.taxRate,
              fixedFeePerTransaction: input.pricing.fixedFeePerTransaction ?? null,
              monthlyServiceFee: input.pricing.monthlyServiceFee ?? null,
              effectiveFrom: new Date(input.pricing.effectiveFrom),
              active: true,
            },
          })
          pricingStructureId = pricing.id
        }

        // ---- 7. Settlement (one config per main card type) ----
        //
        // El cliente PUEDE pasar `settlementDaysByCard` con un valor por tipo de
        // tarjeta — caso típico: débito/crédito T+1, AMEX/Internacional T+3.
        // Para cada cardType, primero busca el override en `settlementDaysByCard`;
        // si no hay, cae al scalar `settlementDays` (compat hacia atrás).
        const settlementIds: string[] = []
        if (input.settlement) {
          const byCard = input.settlement.settlementDaysByCard ?? {}
          for (const cardType of SETTLEMENT_CARD_TYPES) {
            const daysForThisCard = byCard[cardType] ?? input.settlement.settlementDays
            const s = await tx.settlementConfiguration.create({
              data: {
                merchantAccountId: merchantAccount.id,
                cardType,
                settlementDays: daysForThisCard,
                settlementDayType: input.settlement.settlementDayType,
                cutoffTime: input.settlement.cutoffTime,
                cutoffTimezone: input.settlement.cutoffTimezone,
                effectiveFrom: new Date(input.settlement.effectiveFrom),
                createdBy: createdBy ?? null,
              },
            })
            settlementIds.push(s.id)
          }
        }

        return {
          merchantAccountId: merchantAccount.id,
          angelpayUserAccountId,
          venuePaymentConfigUpdated: true,
          terminalIds,
          costStructureId,
          pricingStructureId,
          settlementIds,
          webhookRegistered: false,
        }
      },
      { timeout: 10_000 },
    )

    // ---- Post-transaction: AngelPay webhook auto-registration (soft-fail) ----
    // Deliberately OUTSIDE prisma.$transaction — this file's header comment
    // promises no network calls happen inside the tx. A failure here must
    // NEVER roll back or delete the merchant just created/reused above: the
    // webhook RECEIVER (angelpay-webhook.tpv.controller.ts) already returns
    // 503 for any merchant with no `angelpayWebhookSecret`, so an unregistered
    // webhook is a safe, retryable degraded state — not a setup failure.
    if (input.apiKey) {
      try {
        const env: AngelPayEnvironment = input.environment ?? (input.login.mode === 'new' ? input.login.environment : 'PROD')
        const { accessToken } = await angelPayIntegrationsApiClient.auth(input.apiKey, env)
        const url = `${PUBLIC_BASE_URL}/api/v1/webhooks/angelpay/${result.merchantAccountId}`
        const { endpointId, secret } = await angelPayIntegrationsApiClient.registerWebhook(accessToken, env, {
          url,
          events: ANGELPAY_WEBHOOK_EVENTS,
          description: 'Avoqado ' + (input.merchant.mode === 'create' ? input.merchant.displayName : ''),
        })
        await prisma.merchantAccount.update({
          where: { id: result.merchantAccountId },
          data: { angelpayWebhookSecret: secret, angelpayWebhookEndpointId: endpointId },
        })
        result.webhookRegistered = true
      } catch (err: unknown) {
        logger.warn('AngelPay webhook registration failed — merchant created OK; receiver returns 503 until provisioned', {
          merchantAccountId: result.merchantAccountId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    logger.info('AngelPay full setup completed', {
      event: 'angelpay.full_setup',
      venueId: input.venueId,
      merchantAccountId: result.merchantAccountId,
      slot: input.slot.accountType,
      slotMode: input.slot.mode,
      webhookRegistered: result.webhookRegistered,
    })
    return result
  } catch (err: unknown) {
    // P2002 = unique constraint violation — duplicate merchant (providerId,
    // externalMerchantId, angelpayUserAccountId) or duplicate login (venueId, email).
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
      throw new ConflictError('Ya existe una cuenta con esos datos (merchant o login duplicado)')
    }
    throw err
  }
}
