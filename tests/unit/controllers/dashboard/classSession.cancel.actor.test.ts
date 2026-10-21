// Cancelar una clase audita a quien canceló (spec fase 3 §7.2): el controller pasa el userId del token al service.
jest.mock('@/services/dashboard/classSession.dashboard.service', () => ({ cancelClassSession: jest.fn() }))

import { cancelClassSession } from '@/controllers/dashboard/classSession.dashboard.controller'
import * as classSessionService from '@/services/dashboard/classSession.dashboard.service'

const serviceMock = classSessionService.cancelClassSession as jest.MockedFunction<typeof classSessionService.cancelClassSession>

it('cancelClassSession pasa el userId del token como actorStaffId al service', async () => {
  const cancelada = { id: 'sess-1', status: 'CANCELLED' }
  serviceMock.mockResolvedValue(cancelada as any)
  const req = { params: { venueId: 'venue-1', sessionId: 'sess-1' }, authContext: { userId: 'staff-1' } } as any
  const res = { json: jest.fn() } as any
  const next = jest.fn()

  await cancelClassSession(req, res, next)

  expect(next).not.toHaveBeenCalled()
  expect(serviceMock).toHaveBeenCalledWith('venue-1', 'sess-1', 'staff-1')
  expect(res.json).toHaveBeenCalledWith(cancelada)
})
