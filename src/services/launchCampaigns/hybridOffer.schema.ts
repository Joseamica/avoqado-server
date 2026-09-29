import { z } from 'zod'
import { Decimal } from '@prisma/client/runtime/library'
import { featureCatalogQuery } from './featureCatalog.service'

const errorMap: z.ZodErrorMap = () => ({ message: 'Valor requerido o formato no válido' })
const featureCode = z
  .string({ errorMap })
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'Código de función no válido')
const codes = z.array(featureCode, { errorMap }).max(100, 'Se permiten hasta 100 funciones')
// These new preview contracts use pesos, including MCP. No implicit rounding of an authored price.
const price = z
  .number({ errorMap })
  .finite('El precio debe ser finito')
  .min(10, 'El precio mínimo es $10.00 MXN')
  .max(100_000, 'El precio máximo es $100,000.00 MXN')
  .refine(value => new Decimal(value).decimalPlaces() <= 2, 'El precio admite hasta dos decimales')

const terms = z
  .object(
    {
      currency: z.literal('MXN', { errorMap }),
      interval: z.literal('MONTHLY', { errorMap }),
      price,
      taxIncluded: z.literal(true, { errorMap }),
      promotionCycles: z
        .number({ errorMap })
        .int('Los ciclos deben ser enteros')
        .min(1, 'Se requiere al menos un ciclo')
        .max(24, 'Máximo 24 ciclos')
        .nullable(),
      renewal: z.discriminatedUnion(
        'kind',
        [
          z.object({ kind: z.literal('SAME_PRICE', { errorMap }) }, { errorMap }).strict('Campo de renovación no admitido'),
          z.object({ kind: z.literal('REPRICE', { errorMap }), price }, { errorMap }).strict('Campo de renovación no admitido'),
          z.object({ kind: z.literal('END', { errorMap }) }, { errorMap }).strict('Campo de renovación no admitido'),
        ],
        { errorMap },
      ),
    },
    { errorMap },
  )
  .strict('Condición comercial no admitida')

const common = { schemaVersion: z.literal(1, { errorMap }), terms }
export const hybridOfferDefinition = z.discriminatedUnion(
  'kind',
  [
    z
      .object({ ...common, kind: z.literal('PLAN', { errorMap }), planTier: z.enum(['PRO', 'PREMIUM'], { errorMap }) }, { errorMap })
      .strict('Campo de oferta no admitido'),
    z
      .object(
        { ...common, kind: z.literal('FEATURES', { errorMap }), featureCodes: codes.min(1, 'Selecciona al menos una función') },
        { errorMap },
      )
      .strict('Campo de oferta no admitido'),
    z
      .object(
        {
          ...common,
          kind: z.literal('CHOICE_BUNDLE', { errorMap }),
          eligibleFeatureCodes: codes.min(1, 'Selecciona al menos una función elegible'),
          choiceCount: z
            .number({ errorMap })
            .int('La cantidad debe ser entera')
            .min(1, 'La cantidad mínima es 1')
            .max(100, 'La cantidad máxima es 100'),
        },
        { errorMap },
      )
      .strict('Campo de oferta no admitido'),
  ],
  { errorMap },
)

/** Superadmin simulation only. A customer's entitlements must never be accepted from this body at purchase time. */
export const hybridOfferPreviewBody = z
  .object(
    {
      offer: hybridOfferDefinition,
      selectedFeatureCodes: codes.default([]),
      scenario: z
        .object(
          {
            planTier: z.enum(['FREE', 'PRO', 'PREMIUM'], { errorMap }).default('FREE'),
            grantedFeatureCodes: codes.default([]),
          },
          { errorMap },
        )
        .strict('Campo de escenario no admitido')
        .default({}),
      catalog: featureCatalogQuery.default({}),
      expectedDefinitionHash: z
        .string({ errorMap })
        .regex(/^[a-f0-9]{64}$/, 'Versión de definición no válida')
        .optional(),
    },
    { errorMap },
  )
  .strict('Campo de vista previa no admitido')

export type HybridOfferDefinition = z.infer<typeof hybridOfferDefinition>
