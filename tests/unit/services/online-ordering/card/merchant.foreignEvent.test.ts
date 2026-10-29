// r2 R3: el modo (real/prueba) de un aviso de Stripe se compara con el modo REAL del proveedor (la llave del servidor), no con
// `merchantSnapshot.sandboxMode`, que StripeConnectProvider no usa para nada y que se puede editar.
import { prismaMock } from '@tests/__helpers__/setup'
import { isForeignStripeEvent } from '@/services/online-ordering/card/merchant'

const charge = (sandboxMode: boolean) => ({
  id: 'ch1',
  venueId: 'v1',
  merchantSnapshot: { connectAccountId: 'acct_1', sandboxMode, providerCode: 'STRIPE_CONNECT' },
})
const event = (livemode: boolean, account = 'acct_1') => ({ id: 'evt_1', type: 'payment_intent.canceled', account, livemode })

const original = process.env.STRIPE_SECRET_KEY
afterEach(() => {
  process.env.STRIPE_SECRET_KEY = original
  jest.clearAllMocks()
})

describe('isForeignStripeEvent — modo del proveedor', () => {
  it('servidor con llave live: un aviso livemode=true es nuestro aunque la foto diga sandboxMode=true', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_server'
    await expect(isForeignStripeEvent(event(true), charge(true))).resolves.toBe(false)
    expect(prismaMock.moneyAnomaly.createMany).not.toHaveBeenCalled()
  })

  it('servidor con llave live: un aviso de prueba (livemode=false) sigue rechazado con anomalía', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_server'
    await expect(isForeignStripeEvent(event(false), charge(false))).resolves.toBe(true)
    expect(prismaMock.moneyAnomaly.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ category: 'ONLINE_ORDER_STRIPE_EVENT_FOREIGN' })] }),
    )
  })

  it('servidor con llave de prueba: un aviso livemode=true se rechaza aunque la foto diga sandboxMode=false', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_server'
    await expect(isForeignStripeEvent(event(true), charge(false))).resolves.toBe(true)
    await expect(isForeignStripeEvent(event(false), charge(false))).resolves.toBe(false)
  })

  it('otra cuenta conectada sigue rechazada', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_server'
    await expect(isForeignStripeEvent(event(false, 'acct_otro'), charge(true))).resolves.toBe(true)
  })
})
