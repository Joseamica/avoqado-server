/**
 * 🔴 Un solo 🚨 de horario por pasada (Tarea 19, ronda 1).
 *
 * El menú y el horario de la tienda resuelven las MISMAS horas en la misma pasada del job. Si nadie configuró horario, el
 * menú avisa con 🚨 (como siempre) y el horario NO repite el aviso, ni publica el estimado al proveedor. Aquí corren de verdad
 * el job, el sincronizador del menú, el del horario y la cascada de horas; sólo se simulan la base, el snapshot y el adaptador.
 */
jest.mock('@/utils/retry', () => ({
  __esModule: true,
  retry: jest.fn((fn: () => Promise<any>) => fn()),
  shouldRetryDbConnectionError: jest.fn(),
}))

jest.mock('@/services/delivery-channels/core/menuSnapshot.service', () => ({
  buildMenuSnapshot: jest.fn(async () => ({ venueId: 'v1', generatedAt: 'x', categories: [] })),
}))

jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(async () => false),
}))

jest.mock('@/services/delivery-channels/core/injectionRate.service', () => ({
  calcularTasaInyeccion: jest.fn(async () => ({ estado: 'OK', porcentaje: 100, aceptados: 0, recibidos: 0, fallidos: [] })),
  UMBRAL_OBJETIVO: 99.9,
}))

jest.mock('@/services/delivery-channels/core/adapterRegistry', () => ({
  hasAdapter: jest.fn(() => true),
  adapterFor: jest.fn(),
}))

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { adapterFor } from '@/services/delivery-channels/core/adapterRegistry'
import { DeliveryMenuSyncJob } from '@/jobs/delivery-menu-sync.job'

const LINK: any = { id: 'link1', venueId: 'v1', provider: 'RAPPI', externalLocationId: 's1', config: null, lastMenuHash: null }

describe('DeliveryMenuSyncJob — sin horario configurado, un solo 🚨 por pasada y nada se publica a la tienda', () => {
  const publishStoreHours = jest.fn(async () => ({ ok: true, status: 200, raw: '' }))

  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma as any).deliveryChannelLink.findMany.mockResolvedValue([LINK])
    ;(prisma as any).deliveryChannelLink.update.mockResolvedValue({})
    ;(prisma as any).reservationSettings.findUnique.mockResolvedValue(null)
    ;(adapterFor as jest.Mock).mockReturnValue({
      buildMenuPayload: jest.fn(() => ({ items: [] })),
      publishMenu: jest.fn(async () => ({ ok: true, status: 200, raw: '' })),
      mapHours: jest.fn(() => ({})),
      publishStoreHours,
    })
  })

  it('🔴 con el ESTIMADO, la pasada deja UN solo 🚨 de horario (el del menú) y no toca el horario de la tienda', async () => {
    await new DeliveryMenuSyncJob().runOnce()

    const avisosDeHorario = (logger.warn as jest.Mock).mock.calls.filter(
      ([m]) => /🚨/.test(String(m)) && /\[DeliveryHours\]/.test(String(m)),
    )
    expect(avisosDeHorario).toHaveLength(1)
    expect(publishStoreHours).not.toHaveBeenCalled()
    // Ni un 🚨 propio del horario (el estimado no es una falla: es «todavía no hay horario»).
    expect((logger.error as jest.Mock).mock.calls.filter(([m]) => /HoursSync/.test(String(m)))).toHaveLength(0)
  })
})
