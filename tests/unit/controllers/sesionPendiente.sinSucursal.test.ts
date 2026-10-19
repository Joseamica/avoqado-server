/**
 * Endpoints que toman la sucursal SÓLO del token: con `venueId = 'pending'` (la sesión del alta) o sin sucursal
 * contestan 409 en español («Elige tu sucursal para continuar»), nunca 500 (monitor de producción, 19-oct).
 *
 * Antes: `/dashboard/tokens/*` intentaba crear el presupuesto con la sucursal 'pending' (P2003 → 500) y
 * `/google-calendar/oauth/init` y `/me/access` pedían el acceso de la sucursal 'pending' («Venue pending not
 * found» → 500).
 */
import { NextFunction, Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/access/access.service', () => ({
  __esModule: true,
  getUserAccess: jest.fn(),
  hasPermission: jest.fn(() => true),
  createAccessCache: jest.fn(() => new Map()),
}))
jest.mock('@/services/google-calendar/connection.service', () => ({ __esModule: true }))
jest.mock('@/services/google-calendar/encryption.service', () => ({ __esModule: true }))
jest.mock('@/services/google-calendar/oauth-session.service', () => ({ __esModule: true }))
jest.mock('@/services/google-calendar/watch-channel.service', () => ({ __esModule: true }))
jest.mock('@/services/google-calendar/oauth.service', () => ({
  __esModule: true,
  signState: jest.fn(() => 'state'),
  buildAuthUrl: jest.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?state=state'),
}))

import * as tokenBudgetController from '@/controllers/dashboard/token-budget.dashboard.controller'
import { tokenBudgetService } from '@/services/dashboard/token-budget.service'
import { oauthInit, disconnectConnection } from '@/controllers/google-calendar.controller'
import { getUserAccess } from '@/services/access/access.service'
import meRouter from '@/routes/me.routes'

const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), setHeader: jest.fn() })

const req = (venueId: string | undefined, extra: Record<string, unknown> = {}) =>
  ({
    authContext: { userId: 'user_1', orgId: 'org_1', venueId, role: 'OWNER' },
    query: {},
    params: {},
    body: {},
    ...extra,
  }) as unknown as Request

/** El error que llegó a `next`, o el status que se contestó directo. */
async function correr(handler: (r: Request, s: Response, n: NextFunction) => unknown, r: Request) {
  const s = res()
  const next = jest.fn()
  await handler(r, s as unknown as Response, next as NextFunction)
  return { s, error: next.mock.calls[0]?.[0] as { statusCode?: number; message?: string; code?: string } | undefined }
}

const esSinSucursal = (error: { statusCode?: number; message?: string } | undefined) => {
  expect(error?.statusCode).toBe(409)
  expect(error?.message).toBe('Elige tu sucursal para continuar.')
}

// El handler de `/me/access` vive dentro del router: se toma la última capa de la ruta (después del middleware de auth).
const meAccess = (meRouter as any).stack.find((l: any) => l.route?.path === '/access').route.stack.at(-1).handle

describe.each(['pending', undefined])('token sin sucursal real (venueId = %s)', venueId => {
  it.each([
    ['GET /dashboard/tokens/status', tokenBudgetController.getStatus],
    ['GET /dashboard/tokens/history', tokenBudgetController.getHistory],
    ['GET /dashboard/tokens/analytics', tokenBudgetController.getAnalytics],
    ['PUT /dashboard/tokens/auto-recharge', tokenBudgetController.updateAutoRecharge],
    ['POST /dashboard/tokens/purchase', tokenBudgetController.purchase],
  ])('%s → 409 en español y no toca el presupuesto', async (_ruta, handler) => {
    const { error } = await correr(handler as any, req(venueId))
    esSinSucursal(error)
    expect(prismaMock.chatbotTokenBudget.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.chatbotTokenBudget.create).not.toHaveBeenCalled()
  })

  it('GET /google-calendar/oauth/init → 409 y no pide el acceso de una sucursal inexistente', async () => {
    const { error } = await correr(oauthInit, req(venueId, { query: { intent: 'staff_personal' } }))
    esSinSucursal(error)
    expect(getUserAccess).not.toHaveBeenCalled()
  })

  it('DELETE /google-calendar/connections/:id → 409', async () => {
    prismaMock.googleCalendarConnection.findUnique.mockResolvedValue({ id: 'c1', scope: 'VENUE', venueId: 'v1', channels: [] })
    const { error } = await correr(disconnectConnection, req(venueId, { params: { id: 'c1' } }))
    esSinSucursal(error)
    expect(getUserAccess).not.toHaveBeenCalled()
  })

  it('GET /me/access sin ?venueId → 409', async () => {
    const { error } = await correr(meAccess, req(venueId))
    esSinSucursal(error)
    expect(getUserAccess).not.toHaveBeenCalled()
  })
})

describe('con sucursal real, nada cambia', () => {
  it('GET /me/access usa la sucursal del token', async () => {
    ;(getUserAccess as jest.Mock).mockResolvedValue({ venueId: 'venue_real' })
    const { s, error } = await correr(meAccess, req('venue_real'))
    expect(error).toBeUndefined()
    expect(getUserAccess).toHaveBeenCalledWith('user_1', 'venue_real', expect.anything(), undefined)
    expect(s.json).toHaveBeenCalledWith({ venueId: 'venue_real' })
  })

  it('GET /me/access con ?venueId explícito no mira el token (la sesión del alta puede pedirlo)', async () => {
    ;(getUserAccess as jest.Mock).mockResolvedValue({ venueId: 'venue_real' })
    const { error } = await correr(meAccess, req('pending', { query: { venueId: 'venue_real' } }))
    expect(error).toBeUndefined()
    expect(getUserAccess).toHaveBeenCalledWith('user_1', 'venue_real', expect.anything(), undefined)
  })
})

describe('tokenBudgetService.getOrCreateBudget', () => {
  it('no intenta crear el presupuesto de una sucursal que no existe (antes: P2003 → 500)', async () => {
    prismaMock.chatbotTokenBudget.findUnique.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue(null)

    await expect(tokenBudgetService.getOrCreateBudget('venue_borrada')).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.chatbotTokenBudget.create).not.toHaveBeenCalled()
  })

  it('con la sucursal existente lo crea como siempre', async () => {
    prismaMock.chatbotTokenBudget.findUnique.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ id: 'venue_real' })
    prismaMock.chatbotTokenBudget.create.mockResolvedValue({
      id: 'b1',
      venueId: 'venue_real',
      monthlyFreeTokens: 1000,
      currentPeriodEnd: new Date(Date.now() + 86400000),
    })

    await expect(tokenBudgetService.getOrCreateBudget('venue_real')).resolves.toMatchObject({ id: 'b1' })
    expect(prismaMock.chatbotTokenBudget.create).toHaveBeenCalledWith({ data: expect.objectContaining({ venueId: 'venue_real' }) })
  })
})
