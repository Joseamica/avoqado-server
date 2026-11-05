/** La campana del POS no cambia en este trabajo: sigue pidiendo todo, sin negocio. */
import { getUserNotifications, markAllAsRead } from '@/controllers/mobile/notification.mobile.controller'
import * as notificationService from '@/services/dashboard/notification.dashboard.service'

jest.mock('@/services/dashboard/notification.dashboard.service', () => ({
  getUserNotifications: jest.fn(async () => ({ notifications: [], total: 0, unreadCount: 0 })),
  markAllNotificationsAsRead: jest.fn(async () => ({ count: 0 })),
}))

const req = () => ({ query: {}, headers: { 'x-venue-id': 'cvenue00000000000000000' }, authContext: { userId: 'u1', venueId: 'cvenue00000000000000000' } }) as any

describe('campana del POS (móvil)', () => {
  it('sigue llamando sin negocio', async () => {
    const res: any = { json: jest.fn(), status: jest.fn(() => res) }
    await getUserNotifications(req(), res, jest.fn())
    expect((notificationService.getUserNotifications as jest.Mock).mock.calls[0][1]).toBeUndefined()
    await markAllAsRead(req(), res, jest.fn())
    expect((notificationService.markAllNotificationsAsRead as jest.Mock).mock.calls[0][1]).toBeUndefined()
  })
})
