// tests/unit/services/online-ordering/card/merchant.cardReady.test.ts
/**
 * Sólo se anuncia tarjeta si de verdad se puede cobrar: `chargesEnabled` con su cuenta conectada. La edición del comercio acepta
 * `providerCredentials: {}` sin apagar `chargesEnabled`, y sin cuenta el borrador rechaza el pedido (Codex S1b r1 #3).
 */
import { cardMerchantStatus, findCardMerchant } from '@/services/online-ordering/card/merchant'

const stripe = (over: object) => ({ id: 'm1', chargesEnabled: true, providerCredentials: { connectAccountId: 'acct_1' }, provider: { code: 'STRIPE_CONNECT' }, ...over })
const db = (...merchants: object[]) => ({ ecommerceMerchant: { findMany: jest.fn(async () => merchants) } }) as any

describe('la cuenta de Stripe que puede cobrar un pedido', () => {
  it('cobrable y con cuenta conectada: sirve y está lista', async () => {
    await expect(findCardMerchant(db(stripe({})), 'v1')).resolves.toMatchObject({ id: 'm1' })
    await expect(cardMerchantStatus(db(stripe({})), 'v1')).resolves.toBe('READY')
  })

  it.each([
    ['credenciales vacías', {}],
    ['cuenta vacía', { connectAccountId: '' }],
    ['cuenta que no es texto', { connectAccountId: 7 }],
    ['sin credenciales', null],
  ])('%s: no sirve aunque chargesEnabled siga prendido, y el panel dice que no puede cobrar', async (_nombre, providerCredentials) => {
    await expect(findCardMerchant(db(stripe({ providerCredentials })), 'v1')).resolves.toBeNull()
    await expect(cardMerchantStatus(db(stripe({ providerCredentials })), 'v1')).resolves.toBe('NOT_CHARGEABLE')
  })

  it('si la más nueva perdió su cuenta, usa la siguiente que sí cobra', async () => {
    const buena = stripe({ id: 'm2' })
    await expect(findCardMerchant(db(stripe({ providerCredentials: {} }), buena), 'v1')).resolves.toMatchObject({ id: 'm2' })
    await expect(cardMerchantStatus(db(stripe({ providerCredentials: {} }), buena), 'v1')).resolves.toBe('READY')
  })
})
