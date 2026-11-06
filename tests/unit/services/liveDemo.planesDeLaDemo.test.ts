/**
 * 🔴 D21 (5-nov, video de la demo): la demo en vivo prendía TODAS las funciones, también PLAN_PRO y PLAN_PREMIUM a la vez.
 * Dos planes de cortesía vigentes es un estado que el resto del servidor no admite («no se concede un plan encima de otro»):
 * el menú (el de más acceso) decía Premium y «Tu plan» (una sola fila, la más reciente) decía Pro. La demo lleva UN plan:
 * Premium, que ya incluye todo.
 */
import prisma from '@/utils/prismaClient'
import { enableAllFeaturesForLiveDemo } from '@/services/liveDemo.service'

describe('enableAllFeaturesForLiveDemo', () => {
  it('🔴 prende Premium y las funciones, pero nunca Pro encima de Premium', async () => {
    ;(prisma.feature.findMany as jest.Mock).mockResolvedValue([
      { id: 'f-pro', code: 'PLAN_PRO' },
      { id: 'f-premium', code: 'PLAN_PREMIUM' },
      { id: 'f-lealtad', code: 'LOYALTY_PROGRAM' },
    ])
    ;(prisma.venueFeature.create as jest.Mock).mockResolvedValue({})

    await enableAllFeaturesForLiveDemo('v-demo')

    const prendidas = (prisma.venueFeature.create as jest.Mock).mock.calls.map(([arg]) => arg.data.featureId)
    expect(prendidas).toEqual(['f-premium', 'f-lealtad'])
  })
})
