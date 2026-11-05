import { isAnnouncementEmailOn, setAnnouncementEmailOn } from '../../../../src/services/announcements/announcementEmailPreference.service'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: jest.fn(), updateMany: jest.fn() },
    notificationPreference: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}))

import prisma from '../../../../src/utils/prismaClient'

const findStaff = prisma.staff.findUnique as jest.Mock
const updateMany = prisma.staff.updateMany as jest.Mock

beforeEach(() => jest.clearAllMocks())

describe('preferencia global de anuncios por correo', () => {
  it('sin baja el correo está prendido', async () => {
    findStaff.mockResolvedValue({ announcementEmailOptOutAt: null })
    expect(await isAnnouncementEmailOn('s1')).toBe(true)
  })

  it('una fila de NotificationPreference ANNOUNCEMENT sin EMAIL (global o de negocio) NO apaga', async () => {
    findStaff.mockResolvedValue({ announcementEmailOptOutAt: null })
    ;(prisma.notificationPreference.findMany as jest.Mock).mockResolvedValue([{ type: 'ANNOUNCEMENT', channels: ['IN_APP'] }])
    ;(prisma.notificationPreference.findFirst as jest.Mock).mockResolvedValue({ type: 'ANNOUNCEMENT', channels: ['IN_APP'] })
    expect(await isAnnouncementEmailOn('s1')).toBe(true)
    expect(prisma.notificationPreference.findMany).not.toHaveBeenCalled()
    expect(prisma.notificationPreference.findFirst).not.toHaveBeenCalled()
  })

  it('con announcementEmailOptOutAt apaga', async () => {
    findStaff.mockResolvedValue({ announcementEmailOptOutAt: new Date() })
    expect(await isAnnouncementEmailOn('s1')).toBe(false)
  })

  it('persona inexistente: apagado (no se le escribe)', async () => {
    findStaff.mockResolvedValue(null)
    expect(await isAnnouncementEmailOn('s1')).toBe(false)
  })

  it('set(false) sólo escribe si estaba null (conserva la primera fecha)', async () => {
    updateMany.mockResolvedValue({ count: 1 })
    await setAnnouncementEmailOn('s1', false)
    const arg = updateMany.mock.calls[0][0]
    expect(arg.where).toEqual({ id: 's1', announcementEmailOptOutAt: null })
    expect(arg.data.announcementEmailOptOutAt).toBeInstanceOf(Date)
    updateMany.mockResolvedValue({ count: 0 })
    await expect(setAnnouncementEmailOn('s1', false)).resolves.toBeUndefined()
  })

  it('set(true) la borra', async () => {
    updateMany.mockResolvedValue({ count: 1 })
    await setAnnouncementEmailOn('s1', true)
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 's1', announcementEmailOptOutAt: { not: null } },
      data: { announcementEmailOptOutAt: null },
    })
  })
})
