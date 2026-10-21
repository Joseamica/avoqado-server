import { generateOrderNumber } from '@/services/online-ordering/orderNumber'

describe('generateOrderNumber', () => {
  it('«W» + 4 caracteres sin ambiguos (sin O, 0, I, 1, L)', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateOrderNumber()).toMatch(/^W[A-HJKMNP-Z2-9]{4}$/)
    }
  })
})
