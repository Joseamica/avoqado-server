import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { BadRequestError } from '@/errors/AppError'
import { aCentavos } from '@/services/shared/repartoDescuento'
import {
  cortesiaPendienteInputSchema,
  type CortesiaPendienteReply,
  type CortesiaPendienteSnapshot,
} from './cortesia-pendiente.mobile.service'

/** Mensajes locales: el SDK valida estos campos ANTES de entrar al callback de la tool. */
function fieldErrors(field: string): { errorMap: z.ZodErrorMap } {
  return {
    errorMap: issue => ({
      message:
        issue.code === z.ZodIssueCode.invalid_type && issue.received === z.ZodParsedType.undefined
          ? `El campo ${field} es requerido.`
          : `El campo ${field} contiene datos inválidos.`,
    }),
  }
}
const originalId = (field: string) => z.string(fieldErrors(field)).min(1).max(256)
const cuidId = (field: string) => z.string(fieldErrors(field)).cuid()
export const courtesyReviewVenueIdSchema = z.string(fieldErrors('venueId')).min(1)

/** Una sola frontera de PESOS; conserva los límites internos y se reconfirma con su parser completo al convertir. */
export const courtesyReviewPublicInputSchema = z
  .object(
    {
      originalPaymentKey: originalId('originalPaymentKey'),
      externalId: originalId('externalId'),
      expectedAmount: z.literal(0, fieldErrors('expectedAmount')),
      expectedTip: z.literal(0, fieldErrors('expectedTip')),
      lines: z
        .array(
          z
            .object(
              {
                externalId: originalId('lines.externalId'),
                productId: cuidId('productId'),
                quantity: z.number(fieldErrors('quantity')).int().positive().safe(),
                modifierIds: z.array(cuidId('modifierIds'), fieldErrors('modifierIds')).max(100),
                isCortesia: z.literal(true, fieldErrors('isCortesia')),
                cortesiaReason: z.string(fieldErrors('cortesiaReason')).max(500).trim().min(1),
              },
              fieldErrors('lines'),
            )
            .strict(),
          fieldErrors('lines'),
        )
        .min(1)
        .max(100),
      confirm: z.boolean(fieldErrors('confirm')).default(false),
      expected: z.unknown().optional(),
    },
    fieldErrors('revisión'),
  )
  .strict()
const headerMoney = {
  subtotal: 'subtotalCents',
  discountAmount: 'discountCents',
  taxAmount: 'taxCents',
  serviceChargeAmount: 'serviceChargeCents',
  deliveryFeeAmount: 'deliveryFeeCents',
  tipAmount: 'tipCents',
  total: 'totalCents',
  paidAmount: 'paidAmountCents',
  remainingBalance: 'remainingBalanceCents',
} as const
const lineMoney = { unitPrice: 'unitPriceCents', total: 'totalCents', discountAmount: 'discountCents', taxAmount: 'taxCents' } as const
const modifierMoney = { price: 'priceCents' } as const
type MoneyFields = Readonly<Record<string, string>>

function invalid(): never {
  throw new BadRequestError(
    'Datos inválidos: envía la captura y la foto completas, con importes en pesos y centavos exactos.',
    'COURTESY_REVIEW_INVALID_INPUT',
  )
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function boundedArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 100) invalid()
  return value
}
function exactCents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid()
  const pesos = new Prisma.Decimal(value),
    cents = pesos.mul(100)
  if (!cents.isInteger() || !Number.isSafeInteger(cents.toNumber())) invalid()
  // El helper compartido puede redondear; aquí ya se acreditó que no hay fracción que redondear.
  return aCentavos(pesos)
}
function readMoney(value: unknown, fields: MoneyFields): Record<string, unknown> {
  const source = object(value),
    result = { ...source }
  for (const [publicName, internalName] of Object.entries(fields)) {
    if (Object.prototype.hasOwnProperty.call(source, internalName)) invalid()
    result[internalName] = exactCents(source[publicName])
    delete result[publicName]
  }
  return result
}
function readSnapshot(value: unknown): Record<string, unknown> {
  const source = object(value)
  return {
    ...readMoney(source, headerMoney),
    lines: boundedArray(source.lines).map(value => {
      const line = object(value)
      return { ...readMoney(line, lineMoney), modifiers: boundedArray(line.modifiers).map(value => readMoney(value, modifierMoney)) }
    }),
  }
}
export function parseCourtesyReviewPublicInput(value: unknown): z.output<typeof cortesiaPendienteInputSchema> {
  const parsed = courtesyReviewPublicInputSchema.safeParse(value)
  if (!parsed.success) invalid()
  const { expectedAmount, expectedTip, expected, ...original } = parsed.data
  if (original.confirm && expected === undefined) invalid()
  const internal = cortesiaPendienteInputSchema.safeParse({
    ...original,
    expectedAmountCents: exactCents(expectedAmount),
    expectedTipCents: exactCents(expectedTip),
    ...(expected !== undefined ? { expected: readSnapshot(expected) } : {}),
  })
  if (!internal.success) invalid()
  return internal.data
}
function writeMoney(value: object, fields: MoneyFields): Record<string, unknown> {
  const result = { ...value } as Record<string, unknown>
  for (const [publicName, internalName] of Object.entries(fields)) {
    const cents = result[internalName]
    if (typeof cents !== 'number' || !Number.isSafeInteger(cents)) invalid()
    result[publicName] = new Prisma.Decimal(cents).div(100).toNumber()
    delete result[internalName]
  }
  return result
}
function writeSnapshot(snapshot: CortesiaPendienteSnapshot): Record<string, unknown> {
  return {
    ...writeMoney(snapshot, headerMoney),
    lines: snapshot.lines.map(line => ({
      ...writeMoney(line, lineMoney),
      modifiers: line.modifiers.map(modifier => writeMoney(modifier, modifierMoney)),
    })),
  }
}
export function toCourtesyReviewPublicReply(reply: CortesiaPendienteReply) {
  return { outcome: reply.outcome, originalPaymentKey: reply.originalPaymentKey, snapshot: writeSnapshot(reply.snapshot) }
}
