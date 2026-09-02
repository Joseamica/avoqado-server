import type { NextFunction, Request, Response } from 'express'
import { requireActiveSuperadmin } from '@/middlewares/requireActiveSuperadmin.middleware'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { staffVenue: { findFirst: jest.fn() } },
}))

function response() {
  const json = jest.fn()
  const status = jest.fn().mockReturnValue({ json })
  return { res: { status } as unknown as Response, status, json }
}

describe('requireActiveSuperadmin', () => {
  beforeEach(() => jest.clearAllMocks())

  it('requires both an active SUPERADMIN assignment and an active Staff account', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'membership-root' })
    const req = { authContext: { userId: 'staff-root', isImpersonating: false } } as Request
    const { res } = response()
    const next = jest.fn() as NextFunction

    await requireActiveSuperadmin(req, res, next)

    expect(prisma.staffVenue.findFirst).toHaveBeenCalledWith({
      where: {
        staffId: 'staff-root',
        role: 'SUPERADMIN',
        active: true,
        staff: { active: true },
      },
      select: { id: true },
    })
    expect(next).toHaveBeenCalledWith()
  })

  it('returns 403 when database authority is absent or revoked', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(null)
    const req = { authContext: { userId: 'staff-revoked', isImpersonating: false } } as Request
    const { res, status } = response()
    const next = jest.fn() as NextFunction

    await requireActiveSuperadmin(req, res, next)

    expect(status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('never uses physical SUPERADMIN authority while impersonating', async () => {
    const req = { authContext: { userId: 'staff-root', isImpersonating: true } } as Request
    const { res, status } = response()
    const next = jest.fn() as NextFunction

    await requireActiveSuperadmin(req, res, next)

    expect(status).toHaveBeenCalledWith(403)
    expect(prisma.staffVenue.findFirst).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
})
