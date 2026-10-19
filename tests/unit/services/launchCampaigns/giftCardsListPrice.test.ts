import { LISTABLE_FEATURE_CODES } from '@/services/launchCampaigns/hybridListPrice.service'

describe('precio suelto de las tarjetas de regalo', () => {
  it('GIFT_CARDS se captura en la pantalla «Precios» de superadmin (CONFIGURABLE con código)', () => {
    expect(LISTABLE_FEATURE_CODES).toContain('GIFT_CARDS')
  })
})
