import { prismaMock } from '../../../__helpers__/setup'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { debeMarcarCocina, assertPreparationAuthoringAccess } from '@/services/kds/kitchenDisplayStations'

jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))

describe('preparation authoring without a kitchen screen', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.printStation.findFirst.mockResolvedValue(null)
    prismaMock.orderItem.findFirst.mockResolvedValue(null)
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
  })
  it('authors a negotiated table round even when the station only prints paper', async () => {
    expect(await debeMarcarCocina('venue-a', { hasPreparation: true })).toBe(true)
  })
  it('checks a paid counter order by exact order and venue before marking it', async () => {
    prismaMock.orderItem.findFirst.mockResolvedValue({ id: 'item-a' })
    expect(await debeMarcarCocina('venue-a', { orderId: 'order-a' })).toBe(true)
    expect(prismaMock.orderItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orderId: 'order-a', order: { venueId: 'venue-a' } }),
        select: { id: true },
      }),
    )
  })
  it('keeps the legacy no-screen behavior and denies new preparation without Pro', async () => {
    expect(await debeMarcarCocina('venue-a')).toBe(false)
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    expect(await debeMarcarCocina('venue-a', { hasPreparation: true })).toBe(false)
  })
  // hz:ce654971:D5 (Codex r4 B12): antes devolvía false y la venta se confirmaba sin marca ni aviso: se perdía el único aviso a
  // cocina. «En duda, manda»: la marca queda y el autor decide cuando la base conteste (sin pantalla, la limpia sin armar nada).
  it('does not fail the financial operation if the capability lookup fails, and keeps the kitchen mark («en duda, manda»)', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockRejectedValue(new Error('network'))
    expect(await debeMarcarCocina('venue-a', { hasPreparation: true })).toBe(true)
    prismaMock.printStation.findFirst.mockRejectedValue(new Error('pool timeout'))
    expect(await debeMarcarCocina('venue-a')).toBe(true)
  })
  it('blocks negotiated normal or combo snapshots before order creation for Free', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    await expect(assertPreparationAuthoringAccess('venue-a', [{ serviceCourse: { preparationVersion: 1 } }])).rejects.toMatchObject({
      statusCode: 403,
    })
    await expect(
      assertPreparationAuthoringAccess('venue-a', [{ promotionRef: { selections: [{ serviceCourse: { preparationVersion: 1 } }] } }]),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
  it('preserves legacy courses and checks only the existing Pro capability for new snapshots', async () => {
    await assertPreparationAuthoringAccess('venue-a', [{ serviceCourse: { kind: 'STANDARD' } }])
    expect(venueHasFeatureAccess).not.toHaveBeenCalled()
    await assertPreparationAuthoringAccess('venue-a', [{ serviceCourse: { preparationVersion: 1 } }])
    expect(venueHasFeatureAccess).toHaveBeenCalledWith('venue-a', 'KITCHEN_DISPLAY')
  })
})
