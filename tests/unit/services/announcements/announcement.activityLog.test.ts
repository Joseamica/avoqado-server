import { PlatformAnnouncementStatus } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import {
  createAnnouncement,
  updateAnnouncement,
  scheduleAnnouncement,
  archiveAnnouncement,
} from '../../../../src/services/announcements/announcement.service'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    platformAnnouncement: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    notification: { createMany: jest.fn() },
    platformAnnouncementDelivery: { createMany: jest.fn(), count: jest.fn() },
  },
}))
jest.mock('../../../../src/services/announcements/audience.service', () => ({ resolveAudience: jest.fn() }))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const mockFind = prisma.platformAnnouncement.findUnique as unknown as jest.Mock
const mockCreate = prisma.platformAnnouncement.create as unknown as jest.Mock
const mockUpdate = prisma.platformAnnouncement.update as unknown as jest.Mock
const mockLog = logAction as unknown as jest.Mock

const base = {
  id: 'a1',
  title: 'Terminal nueva',
  body: 'Ya disponible',
  status: PlatformAnnouncementStatus.DRAFT,
  deliveredAt: null,
  expiresAt: null,
}

const entrada = {
  title: 'Terminal nueva',
  body: 'Ya disponible',
  priority: 'HIGH' as never,
  audienceRoles: [] as never[],
  targetPlanTiers: [] as never[],
  targetCategories: [] as string[],
  targetVenueIds: [] as string[],
  showAsBanner: true,
  showAsModal: false,
}

/**
 * La regla del repo es explícita: una mutación sin `ActivityLog` está INCOMPLETA.
 * Publicar un anuncio a cientos de negocios es exactamente lo que un dueño audita
 * después ("¿quién mandó esto y cuándo?"), y hasta hoy no dejaba ningún rastro.
 */
describe('bitácora de los anuncios de plataforma', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFind.mockResolvedValue(base)
    mockCreate.mockResolvedValue(base)
    mockUpdate.mockResolvedValue(base)
  })

  it('crear deja rastro, con quién lo creó', async () => {
    await createAnnouncement(entrada, 'staff-1', 'Jose')
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PLATFORM_ANNOUNCEMENT_CREATED',
        entity: 'PlatformAnnouncement',
        entityId: 'a1',
        staffId: 'staff-1',
      }),
    )
  })

  it('editar deja rastro con los campos que cambiaron', async () => {
    await updateAnnouncement('a1', { title: 'Otro título' }, 'staff-2')
    const registro = mockLog.mock.calls[0][0]
    expect(registro.action).toBe('PLATFORM_ANNOUNCEMENT_UPDATED')
    expect(registro.staffId).toBe('staff-2')
    expect(registro.data.campos).toContain('title')
  })

  it('programar deja rastro con la fecha', async () => {
    const cuando = new Date('2026-09-01T10:00:00Z')
    await scheduleAnnouncement('a1', cuando, 'staff-3')
    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PLATFORM_ANNOUNCEMENT_SCHEDULED', staffId: 'staff-3' }))
  })

  it('archivar deja rastro', async () => {
    await archiveAnnouncement('a1', 'staff-4')
    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PLATFORM_ANNOUNCEMENT_ARCHIVED', staffId: 'staff-4' }))
  })

  it('sin actor humano (el job que publica lo programado) el rastro NO se pierde', async () => {
    await archiveAnnouncement('a1')
    const registro = mockLog.mock.calls[0][0]
    expect(registro.action).toBe('PLATFORM_ANNOUNCEMENT_ARCHIVED')
    expect(registro.staffId ?? null).toBeNull()
  })

  /**
   * 🔴 La bitácora NUNCA puede tumbar la operación: se registra después de que el
   * cambio ya ocurrió y sin await encadenado. Si `logAction` truena, el anuncio
   * igual queda archivado.
   */
  it('si la bitácora falla, la operación NO falla', async () => {
    mockLog.mockRejectedValueOnce(new Error('la base se cayó'))
    await expect(archiveAnnouncement('a1', 'staff-5')).resolves.toBeDefined()
  })

  it('un anuncio que no existe NO deja rastro (no pasó nada que auditar)', async () => {
    mockFind.mockResolvedValue(null)
    await expect(archiveAnnouncement('a1', 'staff-6')).rejects.toThrow()
    expect(mockLog).not.toHaveBeenCalled()
  })
})
