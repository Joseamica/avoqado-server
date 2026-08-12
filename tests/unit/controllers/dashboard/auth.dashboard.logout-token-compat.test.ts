/**
 * Regression: dashboard login tokens and dashboard logout must use compatible verification.
 *
 * The web login signs through `jwt.service.ts`. Verifying that token through the TPV-oriented
 * helper in `security.ts` rejects it because that helper requires issuer/audience claims that
 * dashboard tokens deliberately do not carry. The observable break is a successful logout
 * with no STAFF_LOGOUT audit row.
 */

import { StaffRole } from '@prisma/client'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import { generateAccessToken } from '@/jwt.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { dashboardLogoutController } from '@/controllers/dashboard/auth.dashboard.controller'

const mockedLogAction = logAction as jest.Mock

function fakeResponse() {
  const response: Record<string, unknown> = {}
  response.clearCookie = jest.fn().mockReturnValue(response)
  response.status = jest.fn().mockReturnValue(response)
  response.json = jest.fn().mockReturnValue(response)
  return response as never
}

beforeEach(() => jest.clearAllMocks())

it('records STAFF_LOGOUT for the real token format emitted by dashboard login', async () => {
  const token = generateAccessToken('staff-real', 'org-real', 'venue-real', StaffRole.ADMIN)
  const request = {
    cookies: { accessToken: token },
    headers: {},
    ip: '127.0.0.1',
    get: (header: string) => (header.toLowerCase() === 'user-agent' ? 'Jest real JWT' : undefined),
  } as never

  await dashboardLogoutController(request, fakeResponse())

  expect(mockedLogAction).toHaveBeenCalledWith(
    expect.objectContaining({
      staffId: 'staff-real',
      venueId: 'venue-real',
      action: 'STAFF_LOGOUT',
      ipAddress: '127.0.0.1',
      userAgent: 'Jest real JWT',
    }),
  )
})
