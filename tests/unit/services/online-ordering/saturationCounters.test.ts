import { OnlineOrderStatus } from '@prisma/client'
import { awaitingAcceptanceWhere, unpaidFoliosWhere } from '@/services/online-ordering/constants'

describe('ayudantes de saturación', () => {
  it('awaitingAcceptanceWhere: sólo lo que espera a «Mi equipo»', () => {
    expect(awaitingAcceptanceWhere('v1')).toEqual({ venueId: 'v1', status: OnlineOrderStatus.PENDING_ACCEPTANCE, requiresAcceptance: true })
  })
  it('unpaidFoliosWhere: folios sin un peso pagado (R18)', () => {
    expect(unpaidFoliosWhere('v1')).toEqual({
      venueId: 'v1',
      status: OnlineOrderStatus.PENDING_ACCEPTANCE,
      requiresAcceptance: false,
      order: { paymentStatus: 'PENDING' },
    })
  })
})
