/**
 * Request schema for POST /api/v1/dashboard/superadmin/merchant-accounts/full-setup-angelpay
 *
 * Messages are in Spanish — Zod validation errors surface to dashboard users raw
 * (see validation middleware). Shape mirrors the wizard design spec §7.1.
 */
import { z } from 'zod'

const rateFields = {
  debitRate: z.number().min(0).max(1),
  creditRate: z.number().min(0).max(1),
  amexRate: z.number().min(0).max(1),
  internationalRate: z.number().min(0).max(1),
  includesTax: z.boolean(),
  taxRate: z.number().min(0).max(1),
  effectiveFrom: z.string().datetime({ message: 'effectiveFrom debe ser una fecha ISO' }),
}

export const fullSetupAngelPaySchema = z
  .object({
    // Optional client-generated UUID — traceability only. The real
    // duplicate-protection is the DB unique constraints on MerchantAccount
    // (providerId, externalMerchantId, angelpayUserAccountId) and
    // AngelPayUserAccount (venueId, email), plus the conditional slot guard.
    idempotencyKey: z.string().uuid({ message: 'idempotencyKey inválido' }).optional(),
    venueId: z.string().min(1, 'venueId es requerido'),
    // Optional payment aggregator (e.g. "Externo") the merchant routes through.
    // Only applied when creating a new merchant.
    aggregatorId: z.string().optional(),
    login: z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('existing'),
        angelpayUserAccountId: z.string().min(1, 'Cuenta AngelPay requerida'),
      }),
      z.object({
        mode: z.literal('new'),
        email: z.string().email('Correo inválido'),
        pin: z.string().regex(/^\d{6}$/, 'El PIN debe tener 6 dígitos'),
        environment: z.enum(['QA', 'PROD']),
      }),
    ]),
    // Either create a brand-new merchant, or reuse one already linked to the
    // chosen AngelPay login (e.g. discovered earlier via the TPV).
    merchant: z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('create'),
        externalMerchantId: z.string().regex(/^\d+$/, 'El ID del merchant debe ser numérico'),
        name: z.string().min(1, 'Nombre del merchant requerido'),
        affiliation: z.string().min(1, 'Afiliación requerida'),
        displayName: z.string().min(1, 'Nombre para mostrar requerido'),
      }),
      z.object({
        mode: z.literal('existing'),
        merchantAccountId: z.string().min(1, 'merchantAccountId requerido'),
      }),
    ]),
    slot: z.object({
      accountType: z.enum(['PRIMARY', 'SECONDARY', 'TERTIARY']),
      mode: z.enum(['fill', 'replace']),
      replacedAccountId: z.string().optional(),
      // Cross-slot move: when the merchant already occupies `fromSlot`, the
      // operator chose what happens to it — 'swap' (the displaced account from
      // the new slot moves into fromSlot) or 'vacate' (fromSlot is emptied).
      fromSlot: z.enum(['PRIMARY', 'SECONDARY', 'TERTIARY']).optional(),
      moveStrategy: z.enum(['swap', 'vacate']).optional(),
    }),
    terminalIds: z.array(z.string()).optional(),
    cost: z
      .object({
        ...rateFields,
        fixedCostPerTransaction: z.number().min(0).optional(),
        monthlyFee: z.number().min(0).optional(),
      })
      .optional(),
    pricing: z
      .object({
        ...rateFields,
        fixedFeePerTransaction: z.number().min(0).optional(),
        monthlyServiceFee: z.number().min(0).optional(),
      })
      .optional(),
    settlement: z
      .object({
        // Scalar legacy: aplica como default cuando un tipo de tarjeta NO tiene
        // override en `settlementDaysByCard`. Sigue obligatorio para no romper
        // clientes que solo manden este campo.
        settlementDays: z.number().int().min(0, 'Los días de liquidación no pueden ser negativos'),
        /**
         * Override per-card. Cada campo opcional; el backend hace
         * `byCard[type] ?? scalar` al crear cada SettlementConfiguration row.
         * Permite casos típicos como débito/crédito T+1 + AMEX/Internacional T+3
         * sin tener que llamar 4 endpoints separados.
         */
        settlementDaysByCard: z
          .object({
            DEBIT: z.number().int().min(0).optional(),
            CREDIT: z.number().int().min(0).optional(),
            AMEX: z.number().int().min(0).optional(),
            INTERNATIONAL: z.number().int().min(0).optional(),
          })
          .optional(),
        settlementDayType: z.enum(['BUSINESS_DAYS', 'CALENDAR_DAYS']),
        cutoffTime: z.string().min(1, 'Hora de corte requerida'),
        cutoffTimezone: z.string().min(1, 'Zona horaria de corte requerida'),
        effectiveFrom: z.string().datetime({ message: 'effectiveFrom debe ser una fecha ISO' }),
      })
      .optional(),
  })
  .refine(d => d.slot.mode !== 'replace' || !!d.slot.replacedAccountId, {
    message: 'replacedAccountId es requerido al reemplazar un slot',
    path: ['slot', 'replacedAccountId'],
  })
  .refine(d => d.slot.mode !== 'replace' || !!d.pricing, {
    message: 'El pricing es obligatorio al reemplazar un slot',
    path: ['pricing'],
  })

export type FullSetupAngelPayInput = z.infer<typeof fullSetupAngelPaySchema>
