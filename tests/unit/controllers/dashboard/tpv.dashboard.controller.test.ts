import type { NextFunction, Request, Response } from 'express'

const updateTpvMock = jest.fn()
const logActionMock = jest.fn()

jest.mock('@/services/dashboard/tpv.dashboard.service', () => ({
  updateTpv: (...args: unknown[]) => updateTpvMock(...args),
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: (...args: unknown[]) => logActionMock(...args),
}))

import { updateTpv } from '@/controllers/dashboard/tpv.dashboard.controller'

function makeReq(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return {
    params: { venueId: 'venue-1', tpvId: 'terminal-1' },
    body,
    headers,
    authContext: { userId: 'staff-1' },
  } as unknown as Request
}

function makeRes(): Response & { body?: unknown; statusCode?: number } {
  const res: any = {}
  res.status = jest.fn((statusCode: number) => {
    res.statusCode = statusCode
    return res
  })
  res.json = jest.fn((body: unknown) => {
    res.body = body
    return res
  })
  return res
}

beforeEach(() => {
  jest.clearAllMocks()
  updateTpvMock.mockResolvedValue({ id: 'terminal-1', customerDisplayInverted: true, name: 'Caja principal' })
  logActionMock.mockResolvedValue(undefined)
})

describe('updateTpv legacy display-mode telemetry', () => {
  it('records LEGACY_DISPLAY_MODE_UPDATE_USED after success without changing the legacy response', async () => {
    const req = makeReq({ customerDisplayInverted: true, name: 'Caja principal' }, { 'x-app-version': '  dashboard/2.8.0\n<script>  ' })
    const res = makeRes()
    const next = jest.fn() as NextFunction

    await updateTpv(req as any, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(updateTpvMock).toHaveBeenCalledWith('venue-1', 'terminal-1', req.body)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ id: 'terminal-1', customerDisplayInverted: true, name: 'Caja principal' })
    expect(logActionMock).toHaveBeenCalledWith({
      action: 'LEGACY_DISPLAY_MODE_UPDATE_USED',
      entity: 'Terminal',
      entityId: 'terminal-1',
      staffId: 'staff-1',
      venueId: 'venue-1',
      data: { appVersion: 'dashboard/2.8.0 <script>' },
    })
    expect(logActionMock.mock.calls[0][0].data).not.toHaveProperty('body')
    expect(logActionMock.mock.calls[0][0].data).not.toHaveProperty('customerDisplayInverted')
  })

  it('does not emit the compatibility metric for unrelated updates', async () => {
    const res = makeRes()

    await updateTpv(makeReq({ name: 'Nueva caja' }) as any, res, jest.fn() as NextFunction)

    expect(res.statusCode).toBe(200)
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('does not claim legacy usage when the mutation failed', async () => {
    updateTpvMock.mockRejectedValue(new Error('write failed'))
    const next = jest.fn() as NextFunction

    await updateTpv(makeReq({ customerDisplayInverted: false }) as any, makeRes(), next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'write failed' }))
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('bounds fallback user-agent metadata and removes control characters', async () => {
    const noisyUserAgent = ` Avoqado Dashboard\r\n${'x'.repeat(300)} `

    await updateTpv(
      makeReq({ customerDisplayInverted: false }, { 'user-agent': noisyUserAgent }) as any,
      makeRes(),
      jest.fn() as NextFunction,
    )

    const data = logActionMock.mock.calls[0][0].data
    expect(data).toEqual({ userAgent: expect.any(String) })
    expect(data.userAgent).not.toMatch(/[\r\n]/)
    expect(data.userAgent.length).toBeLessThanOrEqual(128)
  })
})
