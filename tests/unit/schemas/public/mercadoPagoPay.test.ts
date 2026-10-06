import { payRequestSchema, paymentLinkMpPaySchema } from '@/schemas/public/mercadoPagoPaymentIntent.schema'
import { venueMpPaySchema } from '@/schemas/public/venueCheckout.schema'

const body = {
  sessionId: 'cs-1',
  paymentMethodId: 'visa',
  token: 'card-token',
  installments: 1,
  issuerId: '310',
  payer: { email: 'buyer@example.com', firstName: 'Ana', lastName: 'Pérez', identification: { type: 'CURP', number: 'ABC' } },
}

for (const [name, schema, params] of [
  ['liga', paymentLinkMpPaySchema, { shortCode: 'link1' }],
  ['venue', venueMpPaySchema, { venueSlug: 'venue1' }],
] as const) {
  describe(`mp-pay ${name}`, () => {
    it.each(['oxxo', 'clabe'])('admite %s sin token', paymentMethodId => {
      const offline = { ...body, token: undefined }
      expect(schema.parse({ params, body: { ...offline, paymentMethodId } }).body).toEqual({ ...offline, paymentMethodId })
    })
    it('conserva todos los campos de tarjeta y el cuerpo compartido', () => {
      expect(schema.parse({ params, body }).body).toEqual(body)
      expect(payRequestSchema.parse(body)).toEqual(body)
    })
    it.each(['visa', 'master', 'arbitrario', 'OXXO', 'Clabe'])('rechaza %s sin token', paymentMethodId => {
      const input = { ...body, token: undefined }
      expect(schema.safeParse({ params, body: { ...input, paymentMethodId } }).success).toBe(false)
    })
    it.each([
      { token: '' },
      { token: '', paymentMethodId: 'oxxo' },
      { token: '', paymentMethodId: 'clabe' },
      { sessionId: '' },
      { paymentMethodId: '' },
      { installments: 0 },
      { installments: -1 },
      { installments: 1.5 },
      { payer: { email: 'invalid' } },
    ])('rechaza campos inválidos %j', invalid => {
      expect(schema.safeParse({ params, body: { ...body, ...invalid } }).success).toBe(false)
    })
    it('rechaza params vacíos y sesión ausente', () => {
      expect(schema.safeParse({ params: Object.fromEntries(Object.keys(params).map(key => [key, ''])), body }).success).toBe(false)
      const input = { ...body, sessionId: undefined }
      expect(schema.safeParse({ params, body: input }).success).toBe(false)
    })
  })
}
