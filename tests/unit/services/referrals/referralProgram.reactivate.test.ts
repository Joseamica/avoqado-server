/**
 * D28 (hz:be99f328:D28): reactivar el programa de referidos.
 *
 * Antes el DASHBOARD reactivaba con el formulario de la primera activación: mandaba los números de fábrica y un cupón de %
 * por nivel, y `activateReferralProgram` los escribía encima de lo guardado (un producto gratis se volvía cupón). Reactivar
 * ahora sólo prende la fila que está en pausa: no reescribe el premio, los niveles, la vigencia ni los premios de cada nivel.
 * Es un CAS (`updateMany ... active: false`): dos pestañas a la vez prenden una sola vez y «Activo desde» no se mueve dos veces.
 */
import prisma from '@/utils/prismaClient'
import { reactivateReferralProgram } from '@/services/referrals/referralProgram.service'

const flush = () => new Promise(resolve => setImmediate(resolve))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    referralProgramConfig: { updateMany: jest.fn(), findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
    referralTierReward: { create: jest.fn(), updateMany: jest.fn() },
    venue: { findUnique: jest.fn() },
    customer: { findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    activityLog: { create: jest.fn() },
  },
}))

jest.mock('@/services/referrals/referralCode.service', () => ({
  generateReferralCode: jest.fn().mockResolvedValue('TESTMF-TEST123'),
}))

const p = prisma as unknown as {
  $transaction: jest.Mock
  referralProgramConfig: { updateMany: jest.Mock; findUnique: jest.Mock; upsert: jest.Mock; update: jest.Mock }
  referralTierReward: { create: jest.Mock; updateMany: jest.Mock }
  venue: { findUnique: jest.Mock }
  customer: { findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock }
  activityLog: { create: jest.Mock }
}

describe('reactivateReferralProgram', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Igual que en activate: la transacción no puede tocar clientes (incidente del 29-may, 5 s de tope).
    p.$transaction.mockImplementation(async (fn: any) => fn({ referralProgramConfig: p.referralProgramConfig, activityLog: p.activityLog }))
    p.customer.findMany.mockResolvedValue([])
  })

  it('prende sólo la fila en pausa y no reescribe nada de lo guardado', async () => {
    p.referralProgramConfig.updateMany.mockResolvedValue({ count: 1 })
    p.referralProgramConfig.findUnique.mockResolvedValue({ id: 'cfg_1', codePrefix: 'TESTMF' })

    const result = await reactivateReferralProgram({ venueId: 'venue_1', staffId: 'staff_1' })
    await flush()

    expect(result).toEqual({ reactivated: true })
    expect(p.referralProgramConfig.updateMany).toHaveBeenCalledTimes(1)
    const call = p.referralProgramConfig.updateMany.mock.calls[0][0]
    expect(call.where).toEqual({ venueId: 'venue_1', active: false })
    expect(Object.keys(call.data).sort()).toEqual(['activatedAt', 'active'])
    expect(call.data.active).toBe(true)
    expect(call.data.activatedAt).toBeInstanceOf(Date)
    // Ni upsert ni update de la config, ni premios de nivel.
    expect(p.referralProgramConfig.upsert).not.toHaveBeenCalled()
    expect(p.referralProgramConfig.update).not.toHaveBeenCalled()
    expect(p.referralTierReward.create).not.toHaveBeenCalled()
    expect(p.referralTierReward.updateMany).not.toHaveBeenCalled()
  })

  it('deja rastro con quién lo reactivó', async () => {
    p.referralProgramConfig.updateMany.mockResolvedValue({ count: 1 })
    p.referralProgramConfig.findUnique.mockResolvedValue({ id: 'cfg_1', codePrefix: 'TESTMF' })

    await reactivateReferralProgram({ venueId: 'venue_1', staffId: 'staff_1' })
    await flush()

    expect(p.activityLog.create).toHaveBeenCalledTimes(1)
    expect(p.activityLog.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        staffId: 'staff_1',
        venueId: 'venue_1',
        action: 'REFERRAL_PROGRAM_ACTIVATED',
        entity: 'ReferralProgramConfig',
        entityId: 'cfg_1',
        data: expect.objectContaining({ reactivated: true }),
      }),
    )
  })

  it('da código a los clientes que se dieron de alta durante la pausa', async () => {
    p.referralProgramConfig.updateMany.mockResolvedValue({ count: 1 })
    p.referralProgramConfig.findUnique.mockResolvedValue({ id: 'cfg_1', codePrefix: 'TESTMF' })
    p.customer.findMany.mockResolvedValueOnce([{ id: 'cust_1', firstName: 'Ana', lastName: null }]).mockResolvedValue([])
    p.$transaction.mockImplementation(async (fn: any) =>
      fn({ referralProgramConfig: p.referralProgramConfig, activityLog: p.activityLog, customer: p.customer }),
    )

    p.customer.updateMany.mockResolvedValue({ count: 1 })

    await reactivateReferralProgram({ venueId: 'venue_1' })
    await flush()
    await flush()
    await flush()

    expect(p.customer.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'venue_1', referralCode: null } }))
    expect(p.customer.updateMany).toHaveBeenCalledWith({
      where: { id: 'cust_1', referralCode: null },
      data: { referralCode: 'TESTMF-TEST123' },
    })
  })

  // Codex r2 #5 y r3 #5: el prefijo se resuelve ANTES de escribir. Si esa lectura falla, no se prende nada y la persona ve
  // el error y puede volver a tocar «Reactivar»; nunca «falló» con el programa ya prendido, ni «listo» sin repartir.
  it('si falla la búsqueda del prefijo, no prende nada (se puede reintentar)', async () => {
    p.referralProgramConfig.updateMany.mockResolvedValue({ count: 1 })
    p.referralProgramConfig.findUnique.mockResolvedValue({ id: 'cfg_1', codePrefix: null })
    p.venue.findUnique.mockRejectedValue(new Error('P1001 db blip'))

    await expect(reactivateReferralProgram({ venueId: 'venue_1' })).rejects.toThrow('P1001 db blip')
    expect(p.referralProgramConfig.updateMany).not.toHaveBeenCalled()
    expect(p.activityLog.create).not.toHaveBeenCalled()
  })

  it('sin prefijo propio usa el slug del negocio para los códigos nuevos', async () => {
    p.referralProgramConfig.updateMany.mockResolvedValue({ count: 1 })
    p.referralProgramConfig.findUnique.mockResolvedValue({ id: 'cfg_1', codePrefix: null })
    p.venue.findUnique.mockResolvedValue({ slug: 'mi-negocio' })
    p.customer.findMany.mockResolvedValueOnce([{ id: 'cust_1', firstName: 'Ana', lastName: null }]).mockResolvedValue([])
    p.customer.updateMany.mockResolvedValue({ count: 1 })
    p.$transaction.mockImplementation(async (fn: any) =>
      fn({ referralProgramConfig: p.referralProgramConfig, activityLog: p.activityLog, customer: p.customer }),
    )
    const { generateReferralCode } = require('@/services/referrals/referralCode.service')

    await reactivateReferralProgram({ venueId: 'venue_1' })
    await flush()
    await flush()

    expect(generateReferralCode).toHaveBeenCalledWith(expect.objectContaining({ venuePrefix: 'mi-negocio' }))
  })

  it('si ya estaba activo vuelve a intentar dar los códigos que falten (idempotente)', async () => {
    p.referralProgramConfig.updateMany.mockResolvedValue({ count: 0 })
    p.referralProgramConfig.findUnique.mockResolvedValue({ id: 'cfg_1', codePrefix: 'TESTMF' })

    await reactivateReferralProgram({ venueId: 'venue_1' })
    await flush()
    await flush()

    expect(p.customer.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'venue_1', referralCode: null } }))
  })

  it('si ya estaba activo (otra pestaña ganó) no escribe ni deja rastro', async () => {
    p.referralProgramConfig.updateMany.mockResolvedValue({ count: 0 })
    p.referralProgramConfig.findUnique.mockResolvedValue({ id: 'cfg_1', codePrefix: 'TESTMF' })

    const result = await reactivateReferralProgram({ venueId: 'venue_1', staffId: 'staff_1' })

    expect(result).toEqual({ reactivated: false })
    expect(p.activityLog.create).not.toHaveBeenCalled()
  })

  it('sin configuración guardada no inventa una: REFERRAL_PROGRAM_NOT_CONFIGURED', async () => {
    p.referralProgramConfig.updateMany.mockResolvedValue({ count: 0 })
    p.referralProgramConfig.findUnique.mockResolvedValue(null)

    await expect(reactivateReferralProgram({ venueId: 'venue_1' })).rejects.toThrow('REFERRAL_PROGRAM_NOT_CONFIGURED')
    expect(p.referralProgramConfig.updateMany).not.toHaveBeenCalled()
    expect(p.activityLog.create).not.toHaveBeenCalled()
  })
})
