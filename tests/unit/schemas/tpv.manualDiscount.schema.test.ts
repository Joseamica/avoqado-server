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

// D21 (hz:e82938e1:D21): la llave del envío es opcional y viaja hasta el controlador (sin ella en el esquema, zod la tiraba).
describe('D21: llave de envío en los descuentos de la TPV', () => {
  const { applyPredefinedDiscountSchema } = jest.requireActual('@/schemas/tpv.schema')
  const manual = { type: 'FIXED_AMOUNT', value: 10, reason: 'x' }

  it('acepta y conserva la llave en manual y en catálogo', () => {
    const m = applyManualDiscountSchema.safeParse({ params, body: { ...manual, idempotencyKey: '3f2a9c1e-1d2b-4c5d-8e9f-0a1b2c3d4e5f' } })
    expect(m.success && m.data.body.idempotencyKey).toBe('3f2a9c1e-1d2b-4c5d-8e9f-0a1b2c3d4e5f')
    const c = applyPredefinedDiscountSchema.safeParse({
      params,
      body: { discountId: 'cjld2cyuq0000t3rmniod1fox', idempotencyKey: 'llave-0002' },
    })
    expect(c.success && c.data.body.idempotencyKey).toBe('llave-0002')
  })

  it('sin llave, sigue valiendo (TPV vieja)', () => {
    expect(applyManualDiscountSchema.safeParse({ params, body: manual }).success).toBe(true)
  })

  it('rechaza una llave vacía o de más de 64 caracteres', () => {
    expect(applyManualDiscountSchema.safeParse({ params, body: { ...manual, idempotencyKey: 'corta' } }).success).toBe(false)
    expect(applyManualDiscountSchema.safeParse({ params, body: { ...manual, idempotencyKey: 'x'.repeat(65) } }).success).toBe(false)
  })
})
