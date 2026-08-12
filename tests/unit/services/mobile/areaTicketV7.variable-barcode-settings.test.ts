jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(),
}))

import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { getAreaTicketSettings } from '@/services/mobile/areaTicketV7.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

describe('getAreaTicketSettings — etiquetas externas de peso', () => {
  beforeEach(() => {
    ;(venueHasFeatureAccess as jest.Mock).mockImplementation(async (_venueId: string, code: string) =>
      ['AREA_TICKETS', 'VARIABLE_WEIGHT_BARCODE'].includes(code),
    )
    prismaMock.venueAreaTicketSettings.findUnique.mockResolvedValue(null)
    prismaMock.venueScaleSettings.findUnique.mockResolvedValue({
      enabled: false,
      variableBarcodeEnabled: true,
      variableBarcodePrefix: '21',
    })
    prismaMock.terminal.findFirst.mockResolvedValue({
      id: 'terminal-caja',
      name: 'Caja',
      fulfillmentAreaId: null,
      canIssueAreaTickets: false,
      canCheckoutAreaTickets: true,
      canDeliverAreaTickets: false,
      defaultWorkspace: 'AREA_OPERATIONS',
      scaleProfile: null,
      fulfillmentArea: null,
    })
  })

  it('returns an independent enabled EAN-13 PLU+grams contract', async () => {
    const settings = await getAreaTicketSettings('venue-creamery', 'device-caja')

    expect(settings.variableWeightBarcode).toEqual({
      entitled: true,
      enabled: true,
      format: 'EAN13_PLU5_WEIGHT5',
      prefix: '21',
    })
    expect(settings.scaleIntegration.enabled).toBe(false)
  })
})
