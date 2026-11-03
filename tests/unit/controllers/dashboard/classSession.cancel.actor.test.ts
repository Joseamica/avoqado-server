// Cancelar una clase audita a quien canceló (spec fase 3 §7.2): el controller pasa el userId del token al service.
jest.mock('@/services/dashboard/classSession.dashboard.service', () => ({ cancelClassSession: jest.fn(), removeAttendee: jest.fn() }))

import { cancelClassSession, removeAttendee } from '@/controllers/dashboard/classSession.dashboard.controller'
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

it('removeAttendee pasa el userId del token al service y sigue contestando 204', async () => {
  const removeMock = classSessionService.removeAttendee as jest.MockedFunction<typeof classSessionService.removeAttendee>
  removeMock.mockResolvedValue({ id: 'res-1' } as any)
  const req = { params: { venueId: 'venue-1', sessionId: 'sess-1', reservationId: 'res-1' }, authContext: { userId: 'staff-1' } } as any
  const res = { status: jest.fn().mockReturnThis(), send: jest.fn() } as any
  const next = jest.fn()

  await removeAttendee(req, res, next)

  expect(next).not.toHaveBeenCalled()
  expect(removeMock).toHaveBeenCalledWith('venue-1', 'sess-1', 'res-1', 'staff-1')
  expect(res.status).toHaveBeenCalledWith(204)
  expect(res.send).toHaveBeenCalledWith()
})
