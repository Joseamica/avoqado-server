/**
 * El job del menú también sincroniza el horario de la tienda (Tarea 19), DESPUÉS del menú y aislado por canal: que el
 * horario de un negocio truene no deja viejo el menú de ese negocio ni el de ningún otro.
 */
jest.mock('@/utils/retry', () => ({
  __esModule: true,
  retry: jest.fn((fn: () => Promise<any>) => fn()),
  shouldRetryDbConnectionError: jest.fn(),
}))

jest.mock('@/services/delivery-channels/core/menuSync.service', () => ({
  syncChannelMenu: jest.fn(),
  syncChannelAvailability: jest.fn(),
  syncableLinksWhere: jest.fn(() => ({ status: 'ACTIVE', autoSyncMenu: true })),
}))

jest.mock('@/services/delivery-channels/core/hoursSync.service', () => ({
  syncChannelHours: jest.fn(),
}))

jest.mock('@/services/delivery-channels/core/injectionRate.service', () => ({
  calcularTasaInyeccion: jest.fn(async () => ({ estado: 'OK', porcentaje: 100, aceptados: 0, recibidos: 0, fallidos: [] })),
  UMBRAL_OBJETIVO: 99.9,
}))

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { syncChannelAvailability, syncChannelMenu } from '@/services/delivery-channels/core/menuSync.service'
import { syncChannelHours } from '@/services/delivery-channels/core/hoursSync.service'
import { DeliveryMenuSyncJob } from '@/jobs/delivery-menu-sync.job'

const mockedFindMany = (prisma as any).deliveryChannelLink.findMany as jest.Mock
const mockedMenu = syncChannelMenu as jest.Mock
const mockedAvailability = syncChannelAvailability as jest.Mock
const mockedHours = syncChannelHours as jest.Mock

const L1: any = { id: 'link1', venueId: 'v1', provider: 'RAPPI', externalLocationId: 's1' }
const L2: any = { id: 'link2', venueId: 'v2', provider: 'UBER_EATS', externalLocationId: 's2' }

describe('DeliveryMenuSyncJob — el horario va junto al menú, aislado por canal', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedFindMany.mockResolvedValue([L1, L2])
    mockedMenu.mockImplementation(async (link: any) => ({ outcome: 'PUBLISHED', linkId: link.id }))
    mockedAvailability.mockResolvedValue({ agotados: 0, revividos: 0 })
    mockedHours.mockImplementation(async () => ({ outcome: 'UNCHANGED' }))
  })

  it('sincroniza el horario de cada canal DESPUÉS de su menú', async () => {
    await new DeliveryMenuSyncJob().runOnce()

    expect(mockedHours).toHaveBeenCalledTimes(2)
    expect(mockedHours).toHaveBeenNthCalledWith(1, L1)
    expect(mockedHours).toHaveBeenNthCalledWith(2, L2)
    expect(mockedMenu.mock.invocationCallOrder[0]).toBeLessThan(mockedHours.mock.invocationCallOrder[0])
    expect(mockedMenu.mock.invocationCallOrder[1]).toBeLessThan(mockedHours.mock.invocationCallOrder[1])
  })

  it('🔴 un horario que TRUENA no tumba el menú ni a los demás canales', async () => {
    mockedHours.mockRejectedValueOnce(new Error('boom del horario'))

    const r = await new DeliveryMenuSyncJob().runOnce()

    // El segundo canal hizo todo: menú, disponibilidad y horario.
    expect(mockedMenu).toHaveBeenCalledWith(L2)
    expect(mockedAvailability).toHaveBeenCalledWith(L2)
    expect(mockedHours).toHaveBeenCalledWith(L2)
    // Y la cuenta del menú no se enteró del horario.
    expect(r).toEqual({ publicados: 2, sinCambio: 0, fallidos: 0 })
  })

  // ── Ronda de arreglo 1: una pasada a la vez ─────────────────────────────────────────────
  it('🔴 dos pasadas a la vez ⇒ la segunda se SALTA (aviso sin 🚨) y no llama al menú ni al horario', async () => {
    let soltar!: (links: unknown[]) => void
    mockedFindMany.mockReturnValueOnce(new Promise(r => (soltar = r)))
    const job = new DeliveryMenuSyncJob()

    const primera = job.runOnce()
    const segunda = await job.runOnce()

    expect(segunda).toEqual({ publicados: 0, sinCambio: 0, fallidos: 0 })
    expect(mockedFindMany).toHaveBeenCalledTimes(1)
    expect(mockedMenu).not.toHaveBeenCalled()
    expect(mockedHours).not.toHaveBeenCalled()
    const salto = (logger.warn as jest.Mock).mock.calls.find(([m]) => String(m).includes('sigue corriendo'))
    expect(salto).toBeDefined()
    expect(String(salto![0])).not.toMatch(/🚨/)

    soltar([L1, L2])
    await primera
    expect(mockedMenu).toHaveBeenCalledTimes(2)
    expect(mockedHours).toHaveBeenCalledTimes(2)
  })

  it('🔴 el candado se SUELTA aunque la pasada LANCE (si no, el job quedaría muerto para siempre)', async () => {
    // `pasada()` atrapa casi todo, así que se fuerza a que lance: sin el `finally`, la siguiente pasada se saltaría.
    const espia = jest.spyOn(DeliveryMenuSyncJob.prototype as any, 'pasada').mockRejectedValueOnce(new Error('x'))
    const job = new DeliveryMenuSyncJob()

    await expect(job.runOnce()).rejects.toThrow('x')
    await job.runOnce()

    expect(espia).toHaveBeenCalledTimes(2)
    expect(mockedFindMany).toHaveBeenCalledTimes(1) // la segunda sí corrió (la primera no llegó a leer)
    expect(mockedMenu).toHaveBeenCalledTimes(2)
    espia.mockRestore()
  })
})
