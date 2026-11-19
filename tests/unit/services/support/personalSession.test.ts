import 'express-async-errors'
import express, { type Request, type Response, type NextFunction } from 'express'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import prisma from '@/utils/prismaClient'

/** What the token says; a test changes a field and `beforeEach` puts it back. */
const mockAuthContext: Record<string, unknown> = {}
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    req.authContext = { userId: 'staff', sid: 'session', orgId: 'org', venueId: 'pending', role: 'VIEWER', ...mockAuthContext } as any
    next()
  },
  requireVersionedSession: (_req: Request, _res: Response, next: NextFunction) => {
    next()
  },
}))
jest.mock('@/controllers/supportWhatsapp.controller', () => {
  const ok = (_req: Request, res: Response) => {
    res.json({ reachedController: true })
  }
  return { status: ok, challenge: ok, verify: ok, unlinkPhone: ok, venues: ok, dataAccess: ok, grantData: ok }
})
import routes from '@/routes/supportWhatsapp.routes'
const db = prisma as any
const app = express()
app.use(express.json(), cookieParser(), routes)
app.use((err: { statusCode?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.statusCode ?? 500).json({ code: err.code })
})
const ask = () =>
  request(app)
    .post('/challenge')
    .set('X-Support-Staff-Id', 'staff')
    .set('Origin', 'https://dashboard.avoqado.io')
    .set('Cookie', 'accessToken=harness-only')
    .send({ phone: '+525511112222', operationKey: 'session-proof', personalPhone: true })
beforeEach(() => {
  for (const key of Object.keys(mockAuthContext)) delete mockAuthContext[key]
  db.session.findUnique.mockResolvedValue({
    id: 'session',
    staffId: 'staff',
    venueId: 'pending',
    authMethod: 'PASSWORD',
    deviceId: null,
    revokedAt: null,
    strongAuthAt: new Date(Date.now() - 1_000),
  })
  db.staff.findUnique.mockResolvedValue({ active: true, lastPasswordReset: null, sessionsRevokedAt: null })
})
it('a historical PASSWORD label without proof cannot reach the link writer', async () => {
  db.session.findUnique.mockResolvedValueOnce({
    id: 'session',
    staffId: 'staff',
    authMethod: 'PASSWORD',
    revokedAt: null,
    deviceId: null,
    strongAuthAt: null,
  })
  expect((await ask()).status).toBe(403)
})
it('rechecks the original strong-auth time against the current credential cut', async () => {
  db.staff.findUnique.mockResolvedValue({ active: true, lastPasswordReset: new Date(), sessionsRevokedAt: null })
  expect((await ask()).status).toBe(403)
})
it('an accredited personal session reaches the writer while a PIN does not', async () => {
  expect((await ask()).body).toEqual({ reachedController: true })
  db.session.findUnique.mockResolvedValueOnce({
    id: 'session',
    staffId: 'staff',
    authMethod: 'PIN',
    revokedAt: null,
    strongAuthAt: new Date(),
  })
  expect((await ask()).status).toBe(403)
})
it.each(['GET', 'POST'])('a replay under another browser identity cannot read or mutate its support link via %s', async method => {
  const result =
    method === 'GET'
      ? await request(app).get('/status').set('X-Support-Staff-Id', 'previous-person')
      : await request(app)
          .post('/unlink')
          .set('X-Support-Staff-Id', 'previous-person')
          .set('Origin', 'https://dashboard.avoqado.io')
          .send({})
  expect(result.status).toBe(403)
  expect(result.body).toEqual({ code: 'SUPPORT_IDENTITY_CHANGED' })
})

describe('POST /data-access (the only writer of the data permission) asks for the same fresh personal session', () => {
  const personalSession = {
    id: 'session',
    staffId: 'staff',
    venueId: 'pending',
    authMethod: 'PASSWORD',
    deviceId: null,
    revokedAt: null,
    strongAuthAt: new Date(Date.now() - 1_000),
  }
  const body = { venueId: 'c'.padEnd(25, 'a'), noticeHash: 'a'.repeat(64), acceptNotice: true }
  const grant = (headers: Record<string, string> = {}, sent: Record<string, unknown> = body) =>
    request(app)
      .post('/data-access')
      .set({
        'X-Support-Staff-Id': 'staff',
        Origin: 'https://dashboard.avoqado.io',
        Cookie: 'accessToken=harness-only',
        ...headers,
      })
      .send(sent)
  const session = (change: Record<string, unknown>) => () => db.session.findUnique.mockResolvedValue({ ...personalSession, ...change })
  const token = (change: Record<string, unknown>) => () => Object.assign(mockAuthContext, change)
  it.each<[string, () => unknown, Record<string, string>]>([
    ['without strongAuthAt', session({ strongAuthAt: null }), {}],
    ['with a PIN session', session({ authMethod: 'PIN' }), {}],
    ['with a device session', session({ deviceId: 'device' }), {}],
    ['with a revoked session', session({ revokedAt: new Date() }), {}],
    ['while impersonating', token({ isImpersonating: true }), {}],
    ['from a terminal', token({ terminalSerialNumber: 'PAX-1' }), {}],
    ['from the POS', token({ origen: 'POS' }), {}],
    ['inside the live demo', () => undefined, { Cookie: 'accessToken=harness-only; liveDemoSessionId=demo' }],
    ['from another origin', () => undefined, { Origin: 'https://evil.example' }],
    ['for another person in the browser', () => undefined, { 'X-Support-Staff-Id': 'previous-person' }],
  ])('%s is refused before the controller', async (_label, arrange, headers) => {
    arrange()
    const result = await grant(headers)
    expect(result.status).toBe(403)
    expect(result.body).not.toEqual({ reachedController: true })
  })
  it('the strong personal session of the panel reaches the controller', async () => {
    expect((await grant()).body).toEqual({ reachedController: true })
    expect((await grant({}, { ...body, acceptNotice: false })).body).toEqual({ reachedController: true })
  })
  // T-B37: the body says whether the tap is «Aceptar» in the notice dialog; without it the server cannot tell.
  it.each<[string, Record<string, unknown>]>([
    ['without acceptNotice', { venueId: body.venueId, noticeHash: body.noticeHash }],
    ['with acceptNotice as text', { ...body, acceptNotice: 'true' }],
  ])('a body %s is refused before the controller', async (_label, sent) => {
    const result = await grant({}, sent)
    expect(result.status).toBe(400)
    expect(result.body).not.toEqual({ reachedController: true })
  })
})
