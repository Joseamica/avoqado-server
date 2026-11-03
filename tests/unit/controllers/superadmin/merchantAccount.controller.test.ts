/**
 * MerchantAccount superadmin controller — venueId wire-through tests
 * (Task 17 — Phase 2).
 *
 * Narrow scope: verify that `createMerchantAccount` (the HTTP handler)
 * forwards `req.body.venueId` to the service, and that omitting it stays
 * backward-compatible (no `venueId` reaches the service, so the Task 10
 * device-compat guard remains dormant for legacy Blumon flows).
 *
 * The service itself is mocked — Task 10 tests already cover the guard
 * behavior end-to-end against the real Prisma layer.
 *
 * Spec ref: §3.2, §4.4.
 */

import type { NextFunction, Request, Response } from 'express'

import { createMerchantAccount, registerAngelPayWebhook, verifyAngelPayApiKey } from '@/controllers/superadmin/merchantAccount.controller'
import { registrarAvisoAngelPay } from '@/services/superadmin/angelpayWebhookRegistration.service'
import * as merchantAccountService from '@/services/superadmin/merchantAccount.service'
import { angelPayIntegrationsApiClient, AngelPayIntegrationsApiError } from '@/services/integrations/angelpay-integrations-api.client'

jest.mock('@/services/superadmin/merchantAccount.service', () => ({
  createMerchantAccount: jest.fn(),
}))

// Keep the REAL AngelPayIntegrationsApiError class (the controller does
// `instanceof` checks on it) — only the client functions are mocked.
jest.mock('@/services/integrations/angelpay-integrations-api.client', () => ({
  ...jest.requireActual('@/services/integrations/angelpay-integrations-api.client'),
  angelPayIntegrationsApiClient: {
    auth: jest.fn(),
    registerWebhook: jest.fn(),
  },
}))

jest.mock('@/services/superadmin/angelpayWebhookRegistration.service', () => ({
  registrarAvisoAngelPay: jest.fn(),
}))

const mockedCreate = merchantAccountService.createMerchantAccount as jest.Mock
const mockedRegistrar = registrarAvisoAngelPay as jest.Mock
const mockedAuth = angelPayIntegrationsApiClient.auth as jest.Mock

interface FakeRes extends Response {
  __status: number
  __json: any
}

function makeRes(): FakeRes {
  const res: any = {}
  res.__status = 200
  res.__json = undefined
  res.status = jest.fn((code: number) => {
    res.__status = code
    return res
  })
  res.json = jest.fn((body: any) => {
    res.__json = body
    return res
  })
  res.end = jest.fn(() => res)
  return res as FakeRes
}

function makeReq(body: Record<string, any>): Request {
  return {
    params: {},
    query: {},
    body,
    user: { uid: 'admin-staff-1' },
  } as unknown as Request
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedCreate.mockResolvedValue({ id: 'acct-new', providerId: 'prov-1' })
})

describe('POST /superadmin/merchant-accounts — venueId forwarding (Task 17)', () => {
  it('forwards req.body.venueId to createMerchantAccount when present (AngelPay path)', async () => {
    const req = makeReq({
      providerId: 'prov-angelpay',
      externalMerchantId: '9814275',
      displayName: 'AngelPay Sucursal Centro',
      venueId: 'venue-xyz',
      credentials: { merchantId: 'placeholder', apiKey: 'placeholder' },
    })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await createMerchantAccount(req, res, next)

    expect(mockedCreate).toHaveBeenCalledTimes(1)
    const arg = mockedCreate.mock.calls[0][0]
    expect(arg).toMatchObject({
      providerId: 'prov-angelpay',
      externalMerchantId: '9814275',
      venueId: 'venue-xyz',
    })
    expect(res.__status).toBe(201)
    expect(next).not.toHaveBeenCalled()
  })

  it('does NOT pass a truthy venueId when absent — backward compat for Blumon callers', async () => {
    const req = makeReq({
      providerId: 'prov-blumon',
      externalMerchantId: 'blumon_2841548417',
      blumonSerialNumber: '2841548417',
      // intentionally NO venueId — legacy Blumon manual creation flow
    })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await createMerchantAccount(req, res, next)

    expect(mockedCreate).toHaveBeenCalledTimes(1)
    const arg = mockedCreate.mock.calls[0][0]
    // Either omitted entirely or explicitly undefined — both must keep the
    // service's `if (data.venueId)` guard dormant. Asserting falsy covers both.
    expect(arg.venueId).toBeFalsy()
    expect(arg).toMatchObject({
      providerId: 'prov-blumon',
      externalMerchantId: 'blumon_2841548417',
      blumonSerialNumber: '2841548417',
    })
    expect(next).not.toHaveBeenCalled()
  })
})

describe('POST /superadmin/merchant-accounts/verify-apikey', () => {
  it('200s with the flat {merchantId} shape on a valid apiKey', async () => {
    mockedAuth.mockResolvedValue({ accessToken: 'jwt-token', merchantId: '990' })
    const req = makeReq({ apiKey: 'valid-key', environment: 'QA' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await verifyAngelPayApiKey(req, res, next)

    expect(mockedAuth).toHaveBeenCalledWith('valid-key', 'QA')
    expect(res.__status).toBe(200)
    expect(res.__json).toEqual({ merchantId: '990' })
    expect(next).not.toHaveBeenCalled()
  })

  it('401s with a generic message when AngelPay rejects the apiKey (status 401)', async () => {
    mockedAuth.mockRejectedValue(
      new AngelPayIntegrationsApiError('AngelPay: fallo autenticando apiKey: invalid', 401, { message: 'invalid' }),
    )
    const req = makeReq({ apiKey: 'bad-key', environment: 'QA' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await verifyAngelPayApiKey(req, res, next)

    expect(res.__status).toBe(401)
    expect(res.__json).toEqual({ error: 'apiKey inválida o de otro ambiente' })
    expect(next).not.toHaveBeenCalled()
  })

  it('401s on status 422 too (AngelPay validation rejection)', async () => {
    mockedAuth.mockRejectedValue(new AngelPayIntegrationsApiError('AngelPay: fallo autenticando apiKey: unprocessable', 422, {}))
    const req = makeReq({ apiKey: 'bad-key', environment: 'PROD' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await verifyAngelPayApiKey(req, res, next)

    expect(res.__status).toBe(401)
    expect(res.__json).toEqual({ error: 'apiKey inválida o de otro ambiente' })
  })

  it('502s on a network/timeout failure (status undefined) without leaking internals', async () => {
    mockedAuth.mockRejectedValue(
      new AngelPayIntegrationsApiError('AngelPay: fallo autenticando apiKey: timeout of 15000ms exceeded', undefined, undefined),
    )
    const req = makeReq({ apiKey: 'any-key', environment: 'PROD' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await verifyAngelPayApiKey(req, res, next)

    expect(res.__status).toBe(502)
    expect(res.__json).toEqual({ error: 'No se pudo verificar la apiKey con AngelPay' })
    expect(next).not.toHaveBeenCalled()
  })

  it('502s on an unexpected upstream status (e.g. 500) without leaking internals', async () => {
    mockedAuth.mockRejectedValue(
      new AngelPayIntegrationsApiError('AngelPay: fallo autenticando apiKey: server error', 500, { stack: 'leak-me-not' }),
    )
    const req = makeReq({ apiKey: 'any-key', environment: 'PROD' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await verifyAngelPayApiKey(req, res, next)

    expect(res.__status).toBe(502)
    expect(res.__json).toEqual({ error: 'No se pudo verificar la apiKey con AngelPay' })
  })

  it('forwards zod validation failures (missing apiKey) to next() instead of calling AngelPay', async () => {
    const req = makeReq({ environment: 'QA' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await verifyAngelPayApiKey(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(mockedAuth).not.toHaveBeenCalled()
  })

  it('forwards zod validation failures (bad environment enum) to next() instead of calling AngelPay', async () => {
    const req = makeReq({ apiKey: 'x', environment: 'STAGING' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await verifyAngelPayApiKey(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(mockedAuth).not.toHaveBeenCalled()
  })
})

describe('POST /superadmin/merchant-accounts/:id/angelpay/webhook (D11)', () => {
  const ID = 'ckz9d11cuenta0000000000001'
  const LLAVE = 'llave-de-prueba-no-real'

  function reqDeRegistro(body: Record<string, unknown>, id = ID) {
    return {
      params: { id },
      query: {},
      body,
      ip: '10.0.0.1',
      headers: { 'user-agent': 'prueba' },
      authContext: { userId: 'ckz9d11staff00000000000001', role: 'SUPERADMIN' },
    } as unknown as Request
  }

  it('200 con la forma acordada; el actor sale de authContext y el secreto no aparece en ningún lado', async () => {
    mockedRegistrar.mockResolvedValue({ alreadyRegistered: false })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await registerAngelPayWebhook(reqDeRegistro({ apiKey: LLAVE, environment: 'QA' }), res, next)

    expect(mockedRegistrar).toHaveBeenCalledWith({
      merchantAccountId: ID,
      apiKey: LLAVE,
      environment: 'QA',
      actor: { staffId: 'ckz9d11staff00000000000001', ipAddress: '10.0.0.1', userAgent: 'prueba' },
    })
    expect(res.__status).toBe(200)
    expect(res.__json).toEqual({
      success: true,
      data: { merchantAccountId: ID, webhookRegistered: true, alreadyRegistered: false },
    })
    expect(JSON.stringify(res.__json)).not.toContain(LLAVE)
    expect(next).not.toHaveBeenCalled()
  })

  it('una cuenta que ya tenía aviso también contesta 200, sin rotar nada', async () => {
    mockedRegistrar.mockResolvedValue({ alreadyRegistered: true })
    const res = makeRes()

    await registerAngelPayWebhook(reqDeRegistro({ apiKey: LLAVE }), res, jest.fn() as unknown as NextFunction)

    expect(res.__status).toBe(200)
    expect(res.__json.data).toEqual({ merchantAccountId: ID, webhookRegistered: true, alreadyRegistered: true })
  })

  it.each([
    ['sin llave', {}, ID, 'La llave de API es requerida'],
    ['llave vacía', { apiKey: '   ' }, ID, 'La llave de API es requerida'],
    ['llave enorme', { apiKey: 'x'.repeat(2049) }, ID, 'La llave de API es demasiado larga'],
    ['llave que no es texto', { apiKey: 123 }, ID, 'La llave de API es requerida'],
    ['ambiente inventado', { apiKey: LLAVE, environment: 'STAGING' }, ID, 'El ambiente debe ser QA o PROD'],
    ['id que no es cuid', { apiKey: LLAVE }, 'no-es-un-cuid', 'Id de cuenta inválido'],
  ])('%s: 400 en español y el servicio ni se entera', async (_caso, body, id, mensaje) => {
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await registerAngelPayWebhook(reqDeRegistro(body as Record<string, unknown>, id as string), res, next)

    expect(mockedRegistrar).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: mensaje }))
  })

  it('recorta la llave antes de usarla (pegarla con un espacio es lo normal)', async () => {
    mockedRegistrar.mockResolvedValue({ alreadyRegistered: false })

    await registerAngelPayWebhook(reqDeRegistro({ apiKey: `  ${LLAVE}\n` }), makeRes(), jest.fn() as unknown as NextFunction)

    expect(mockedRegistrar).toHaveBeenCalledWith(expect.objectContaining({ apiKey: LLAVE }))
  })

  it('los errores del registro siguen al manejador global tal cual', async () => {
    const error = new Error('fallo del registro')
    mockedRegistrar.mockRejectedValue(error)
    const next = jest.fn() as unknown as NextFunction

    await registerAngelPayWebhook(reqDeRegistro({ apiKey: LLAVE }), makeRes(), next)

    expect(next).toHaveBeenCalledWith(error)
  })
})
