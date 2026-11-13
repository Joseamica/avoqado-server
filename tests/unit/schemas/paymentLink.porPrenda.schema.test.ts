/**
 * Liga por prenda: la familia y la talla son registros que YA existen. IQ (13-oct) tiene productos con ids históricos que no
 * empiezan con «c»; `.cuid()` los rechazaba con un 400. Se validan con `existingId()` (forma), y el servicio revisa que existan
 * en el negocio.
 */
import {
  createPaymentLinkBodySchema,
  publicStripePaymentIntentSchema,
  updatePaymentLinkBodySchema,
} from '@/schemas/dashboard/paymentLink.schema'

const HISTORICO = 'k9QzR4tLm2vXb7Hn'
const prenda = { title: 'Blusa', amountType: 'FIXED' as const, purpose: 'ITEM' as const, isReusable: true }

describe('liga por prenda: ids de familia y talla existentes', () => {
  it.each([HISTORICO, 'cjld2cjxh0000qzrmn831i7rn', '0f9c2b1e-5d1a-4c3b-9e2f-1a2b3c4d5e6f'])('crear con la familia %p', id => {
    expect(createPaymentLinkBodySchema.safeParse({ ...prenda, productGroupId: id }).success).toBe(true)
  })

  it('editar confirmando una familia con id histórico', () => {
    expect(updatePaymentLinkBodySchema.safeParse({ productGroupId: HISTORICO }).success).toBe(true)
  })

  it('abrir el cobro con una talla de id histórico', () => {
    const r = publicStripePaymentIntentSchema.safeParse({
      params: { shortCode: 'abc12345' },
      body: { productId: HISTORICO, browserToken: 'tok_abcdefghijklmnop' },
    })
    expect(r.success).toBe(true)
  })

  it.each(['', 'con espacio', "x'; drop", 'a/b'])('rechaza una familia o talla mal formada (%p)', id => {
    expect(createPaymentLinkBodySchema.safeParse({ ...prenda, productGroupId: id }).success).toBe(false)
    expect(updatePaymentLinkBodySchema.safeParse({ productGroupId: id }).success).toBe(false)
    expect(
      publicStripePaymentIntentSchema.safeParse({
        params: { shortCode: 'abc12345' },
        body: { productId: id, browserToken: 'tok_abcdefghijklmnop' },
      }).success,
    ).toBe(false)
  })

  it('regresión: sin familia ni talla sigue igual (ligas de siempre)', () => {
    expect(createPaymentLinkBodySchema.safeParse({ title: 'Pago', amountType: 'FIXED', amount: 100 }).success).toBe(true)
    expect(updatePaymentLinkBodySchema.safeParse({ productGroupId: null }).success).toBe(true)
  })
})
