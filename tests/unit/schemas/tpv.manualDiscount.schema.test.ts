/**
 * D1 (hz:f34960c5:D1, Codex r2 #1): la cortesía manual ya no exige `authorizedById` del cliente. Si el esquema la rechazara con
 * 400, nunca llegaría a `checkCortesiaEnDescuento` y la TPV no podría ofrecer el PIN de gerente (403 `overridable`).
 */
import { applyManualDiscountSchema } from '@/schemas/tpv.schema'

const params = { venueId: 'cjld2cjxh0000qzrmn831i7rn', orderId: 'cjld2cyuq0000t3rmniod1foy' }

describe('applyManualDiscountSchema', () => {
  it('acepta una cortesía sin authorizedById', () => {
    expect(applyManualDiscountSchema.safeParse({ params, body: { type: 'COMP', value: 100, reason: 'Invitación' } }).success).toBe(true)
  })
  it('sigue rechazando un porcentaje fuera de 1-100', () => {
    expect(applyManualDiscountSchema.safeParse({ params, body: { type: 'PERCENTAGE', value: 150, reason: 'x' } }).success).toBe(false)
  })
})
