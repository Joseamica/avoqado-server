jest.mock('@/services/access/basePlan.service', () => ({
  __esModule: true,
  venueHasFeatureAccess: jest.fn(),
}))

import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { getScaleSettings } from '@/services/mobile/areaTicketV7.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const accessMock = venueHasFeatureAccess as jest.MockedFunction<typeof venueHasFeatureAccess>

const profile = {
  id: 'scale-justa',
  name: 'Justa CEDIS',
  location: 'CEDIS',
  model: 'LP7516',
  allowedContexts: ['STOCK_COUNT'],
  transport: 'ANDROID_USB_SERIAL',
  vendorId: 1659,
  productId: 8963,
  baudRate: 9600,
  dataBits: 8,
  parity: 'NONE',
  stopBits: 1,
  frameParser: { type: 'JUSTA_LP7516_ASCII', mode: 'REQUEST' },
  stableIndicator: 'ST',
  unit: 'KILOGRAM',
  active: true,
}

describe('mobile scale settings', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.terminal.findFirst.mockResolvedValue({
      id: 'terminal-cedis',
      name: 'CEDIS',
      fulfillmentAreaId: null,
      canIssueAreaTickets: false,
      canCheckoutAreaTickets: false,
      canDeliverAreaTickets: false,
      defaultWorkspace: 'INVENTORY',
      scaleProfile: profile,
      fulfillmentArea: null,
    } as any)
    prismaMock.venueScaleSettings.findUnique.mockResolvedValue({
      venueId: 'venue-1',
      enabled: true,
    } as any)
  })

  it('returns the active CEDIS profile without depending on area ticket settings', async () => {
    accessMock.mockResolvedValue(true)

    await expect(getScaleSettings('venue-1', 'device-1')).resolves.toEqual({
      entitled: true,
      enabled: true,
      profile,
      manualFallbackAllowed: true,
    })
    expect(prismaMock.venueAreaTicketSettings.findUnique).not.toHaveBeenCalled()
  })

  it('keeps manual fallback and hides the profile when rollout is disabled', async () => {
    accessMock.mockResolvedValue(true)
    prismaMock.venueScaleSettings.findUnique.mockResolvedValue({
      venueId: 'venue-1',
      enabled: false,
    } as any)

    await expect(getScaleSettings('venue-1', 'device-1')).resolves.toEqual({
      entitled: true,
      enabled: false,
      profile: null,
      manualFallbackAllowed: true,
    })
  })
})
