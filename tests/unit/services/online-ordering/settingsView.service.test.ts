import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/online-ordering/presence.service', () => ({
  __esModule: true,
  getAcceptingStatus: jest.fn(async () => ({ status: 'OPEN', reason: null, config: {} })),
  storeView: jest.fn(() => ({ status: 'OPEN' })),
}))
jest.mock('@/services/online-ordering/settings.service', () => ({
  __esModule: true,
  getSettings: jest.fn(),
  storeRequirements: jest.fn(async () => ({ address: true, phone: true, privacyNotice: true })),
}))

import { getSettings } from '@/services/online-ordering/settings.service'
import { settingsView } from '@/services/online-ordering/settingsView.service'

const SETTINGS = { enabled: true, acceptsCardOnline: true, lastInboxPollAt: null }
const M = (o: Record<string, unknown> = {}) => ({
  id: 'em1',
  chargesEnabled: true,
  providerCredentials: { connectAccountId: 'acct_1' },
  provider: { code: 'STRIPE_CONNECT' },
  ...o,
})

beforeEach(() => (getSettings as jest.Mock).mockResolvedValue(SETTINGS))

describe('settingsView.card', () => {
  it('sin ningún comercio Stripe Connect: NOT_CONNECTED', async () => {
    prismaMock.ecommerceMerchant.findMany.mockResolvedValue([])
    expect((await settingsView('v1')).card).toEqual({ enabled: true, merchantStatus: 'NOT_CONNECTED' })
  })

  it('hay comercio pero ninguno cobra (chargesEnabled false): NOT_CHARGEABLE', async () => {
    prismaMock.ecommerceMerchant.findMany.mockResolvedValue([M({ chargesEnabled: false })] as any)
    expect((await settingsView('v1')).card.merchantStatus).toBe('NOT_CHARGEABLE')
  })

  it('al menos uno cobrable: READY, con UNA sola consulta acotada', async () => {
    prismaMock.ecommerceMerchant.findMany.mockResolvedValue([M({ chargesEnabled: false }), M({ id: 'em2' })] as any)
    expect((await settingsView('v1')).card.merchantStatus).toBe('READY')
    expect(prismaMock.ecommerceMerchant.findMany).toHaveBeenCalledTimes(1)
    expect((prismaMock.ecommerceMerchant.findMany.mock.calls[0][0] as any).take).toBeGreaterThan(0)
  })

  it('card.enabled refleja el switch aunque el comercio ya no cobre', async () => {
    prismaMock.ecommerceMerchant.findMany.mockResolvedValue([])
    expect((await settingsView('v1')).card).toEqual({ enabled: true, merchantStatus: 'NOT_CONNECTED' })
    ;(getSettings as jest.Mock).mockResolvedValue({ ...SETTINGS, acceptsCardOnline: false })
    expect((await settingsView('v1')).card.enabled).toBe(false)
  })
})
