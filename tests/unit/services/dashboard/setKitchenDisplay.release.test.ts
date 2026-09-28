/** Después de la puerta de calidad (fase 3.6): prender exige Pro; apagar nunca; prender sella la cuenta nueva. */
jest.mock('@/services/kds/kitchenDisplayRelease', () => ({ PANTALLA_ABIERTA_A_CLIENTES: true }))
const superMock = jest.fn()
jest.mock('@/mcp/scope', () => ({ isActiveSuperAdmin: (...a: unknown[]) => superMock(...a) }))
const planMock = jest.fn()
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: (...a: unknown[]) => planMock(...a) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { prismaMock } from '../../../__helpers__/setup'
import { ForbiddenError } from '@/errors/AppError'
import { setKitchenDisplay } from '@/services/dashboard/printStation.dashboard.service'

beforeEach(() => {
  jest.clearAllMocks()
  superMock.mockResolvedValue(false)
  prismaMock.printStation.update.mockImplementation(async (a: any) => ({ id: 's1', ...a.data }) as any)
})

it('prender SIN Pro ⇒ 403 KITCHEN_DISPLAY_REQUIRES_PRO y no escribe', async () => {
  prismaMock.printStation.findFirst.mockResolvedValue({ id: 's1', hasKitchenDisplay: false } as any)
  planMock.mockResolvedValue(false)
  const error: any = await setKitchenDisplay('v1', 's1', true, 'dueno-1').catch(e => e)
  expect(error).toBeInstanceOf(ForbiddenError)
  expect(error.errorCode ?? error.code).toBe('KITCHEN_DISPLAY_REQUIRES_PRO')
  expect(prismaMock.printStation.update).not.toHaveBeenCalled()
})

it('prender CON Pro ⇒ prende y sella kitchenDisplaySince', async () => {
  prismaMock.printStation.findFirst.mockResolvedValue({ id: 's1', hasKitchenDisplay: false } as any)
  planMock.mockResolvedValue(true)
  await setKitchenDisplay('v1', 's1', true, 'dueno-1')
  expect(prismaMock.printStation.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: { hasKitchenDisplay: true, kitchenDisplaySince: expect.any(Date) } }),
  )
})

it('apagar sin Pro siempre se puede, y no toca la cuenta nueva', async () => {
  prismaMock.printStation.findFirst.mockResolvedValue({ id: 's1', hasKitchenDisplay: true } as any)
  planMock.mockResolvedValue(false)
  await setKitchenDisplay('v1', 's1', false, 'dueno-1')
  expect(prismaMock.printStation.update).toHaveBeenCalledWith(expect.objectContaining({ data: { hasKitchenDisplay: false } }))
  expect(planMock).not.toHaveBeenCalled()
})
