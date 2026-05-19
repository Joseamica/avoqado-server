import { venueChatAuth } from '@/middlewares/venueChatAuth.middleware'
import { generateAccessToken, hashAccessToken } from '@/utils/sessionToken'

import { prismaMock } from '../../__helpers__/setup'

const SESSION_ID = 'sess-123'

function makeReq(authHeader: string, params: Record<string, string> = { id: SESSION_ID }) {
  return {
    header: (h: string) => (h === 'Authorization' ? authHeader : ''),
    params,
  } as unknown as Parameters<typeof venueChatAuth>[0]
}

function makeRes() {
  return { sendStatus: jest.fn() } as unknown as Parameters<typeof venueChatAuth>[1]
}

describe('venueChatAuth middleware', () => {
  it('passes through with valid Bearer token', async () => {
    const token = generateAccessToken()
    prismaMock.venueChatSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      accessTokenHash: hashAccessToken(token),
      status: 'OPEN',
    })
    const req = makeReq(`Bearer ${token}`)
    const res = makeRes()
    const next = jest.fn()

    await venueChatAuth(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(res.sendStatus as jest.Mock).not.toHaveBeenCalled()
  })

  it('rejects missing Authorization with 401', async () => {
    const res = makeRes()
    const next = jest.fn()
    await venueChatAuth(makeReq(''), res, next)
    expect(res.sendStatus).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects Authorization without Bearer prefix with 401', async () => {
    const res = makeRes()
    const next = jest.fn()
    await venueChatAuth(makeReq('Basic abc'), res, next)
    expect(res.sendStatus).toHaveBeenCalledWith(401)
  })

  it('rejects missing sessionId param with 400', async () => {
    const res = makeRes()
    const next = jest.fn()
    await venueChatAuth(makeReq('Bearer xxx', {}), res, next)
    expect(res.sendStatus).toHaveBeenCalledWith(400)
  })

  it('rejects unknown sessionId with 404', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue(null)
    const res = makeRes()
    const next = jest.fn()
    await venueChatAuth(makeReq('Bearer anything'), res, next)
    expect(res.sendStatus).toHaveBeenCalledWith(404)
  })

  it('rejects wrong token with 401 (constant-time comparison)', async () => {
    const realToken = generateAccessToken()
    prismaMock.venueChatSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      accessTokenHash: hashAccessToken(realToken),
      status: 'OPEN',
    })
    const res = makeRes()
    const next = jest.fn()
    await venueChatAuth(makeReq('Bearer wrong-token-value'), res, next)
    expect(res.sendStatus).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
})
