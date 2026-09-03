jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import { createPrivacyNoticeVersion, getCurrentPrivacyNotice } from '@/services/customer/privacyNotice.service'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import crypto from 'crypto'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    privacyNoticeVersion: {
      create: jest.fn().mockResolvedValue({ id: 'not1' }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
  },
}))

// `tests/__helpers__/setup.ts` mockea logAction GLOBALMENTE como no-op (fire-and-forget) —
// aquí SÍ nos importa verificar qué se le manda, así que se asertan sus llamadas.

beforeEach(() => {
  jest.clearAllMocks()
})

describe('createPrivacyNoticeVersion', () => {
  it('crea versión nueva con hash sha256 del contenido y venueId dueño', async () => {
    await createPrivacyNoticeVersion('venueA', 'Aviso v1', 'es', 'staff1')
    const esperado = crypto.createHash('sha256').update('Aviso v1', 'utf8').digest('hex')
    expect(prisma.privacyNoticeVersion.create as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ venueId: 'venueA', contentHash: esperado, language: 'es' }) }),
    )
  })

  it('rechaza contenido vacío', async () => {
    await expect(createPrivacyNoticeVersion('venueA', '   ', 'es', 'staff1')).rejects.toThrow()
  })

  it('rechaza contenido vacío SIN llamar a prisma.create (falla-antes-de-escribir)', async () => {
    await expect(createPrivacyNoticeVersion('venueA', '', 'es', 'staff1')).rejects.toThrow()
    expect(prisma.privacyNoticeVersion.create).not.toHaveBeenCalled()
  })

  it('guarda el contenido TRIMEADO, no el crudo (el hash y el contenido deben coincidir)', async () => {
    await createPrivacyNoticeVersion('venueA', '  Aviso con espacios  ', 'es', 'staff1')
    const esperado = crypto.createHash('sha256').update('Aviso con espacios', 'utf8').digest('hex')
    expect(prisma.privacyNoticeVersion.create as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ content: 'Aviso con espacios', contentHash: esperado }),
      }),
    )
  })

  it('dos contenidos distintos producen hashes distintos (no hay colisión trivial)', async () => {
    await createPrivacyNoticeVersion('venueA', 'Aviso v1', 'es', 'staff1')
    const hash1 = (prisma.privacyNoticeVersion.create as jest.Mock).mock.calls[0][0].data.contentHash
    ;(prisma.privacyNoticeVersion.create as jest.Mock).mockClear()
    await createPrivacyNoticeVersion('venueA', 'Aviso v2', 'es', 'staff1')
    const hash2 = (prisma.privacyNoticeVersion.create as jest.Mock).mock.calls[0][0].data.contentHash
    expect(hash1).not.toEqual(hash2)
  })

  it('llama a logAction (fire-and-forget) con el venue, el actor y el id de la versión nueva', async () => {
    await createPrivacyNoticeVersion('venueA', 'Aviso v1', 'es', 'staff1')
    expect(logAction as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staff1',
        venueId: 'venueA',
        entity: 'PrivacyNoticeVersion',
        entityId: 'not1',
      }),
    )
  })
})

describe('getCurrentPrivacyNotice (re-exportado de consent.service, NO reimplementado)', () => {
  it('delega en la MISMA función de consent.service', async () => {
    const consentService = await import('@/services/customer/consent.service')
    expect(getCurrentPrivacyNotice).toBe(consentService.getCurrentPrivacyNotice)
  })
})
