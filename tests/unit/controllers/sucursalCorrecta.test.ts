/**
 * Cada pantalla usa la sucursal correcta (19-oct-2026, hallazgos de la revisión de FriedBros y de Codex r1).
 *
 * - Google Calendar: ver o desconectar una conexión por id revisaba el permiso en la sucursal del token, pero nunca que la
 *   conexión fuera de esa sucursal: un ADMIN del negocio A veía y desconectaba la de B.
 * - Bitácora y paquetes de créditos (rutas `/venues/:venueId/...`): usaban la sucursal del TOKEN, no la de la URL. Con dos
 *   pestañas en sucursales distintas la cookie es una sola: la pestaña de A leía (y en paquetes ESCRIBÍA) en B. El candado
 *   `checkPermission` ya autoriza la sucursal de la URL.
 */
import { NextFunction, Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/access/access.service', () => ({
  __esModule: true,
  getUserAccess: jest.fn(async () => ({})),
  hasPermission: jest.fn(() => true),
  createAccessCache: jest.fn(() => new Map()),
}))
jest.mock('@/services/google-calendar/connection.service', () => ({ __esModule: true }))
jest.mock('@/services/google-calendar/encryption.service', () => ({ __esModule: true, decryptToken: jest.fn(() => 'tok') }))
jest.mock('@/services/google-calendar/oauth-session.service', () => ({ __esModule: true }))
jest.mock('@/services/google-calendar/watch-channel.service', () => ({ __esModule: true, stopChannel: jest.fn() }))
jest.mock('@/services/google-calendar/oauth.service', () => ({ __esModule: true }))
jest.mock('@/services/dashboard/creditPack.dashboard.service')
// El arranque común de las pruebas simula este módulo sólo con `logAction`: aquí se agregan las lecturas de la bitácora.
jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn(),
  queryVenueActivityLogs: jest.fn(),
  getVenueDistinctActions: jest.fn(),
  getVenueDistinctEntities: jest.fn(),
  countVenueActivityLogsForExport: jest.fn(),
  fetchVenueActivityLogsForExport: jest.fn(),
}))

import { getConnectionDetail, disconnectConnection } from '@/controllers/google-calendar.controller'
import { listBusyBlocks } from '@/controllers/dashboard/googleCalendarStatus.controller'
import { validateRequest } from '@/middlewares/validation'
import { packIdParamsSchema } from '@/schemas/dashboard/creditPack.schema'
import * as creditPackController from '@/controllers/dashboard/creditPack.dashboard.controller'
import * as activityLogController from '@/controllers/dashboard/activityLog.dashboard.controller'
import * as creditPackService from '@/services/dashboard/creditPack.dashboard.service'
import * as activityLogService from '@/services/dashboard/activity-log.service'

const res = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
  end: jest.fn().mockReturnThis(),
  setHeader: jest.fn(),
})

/** Una persona parada en la sucursal A (token), pidiendo lo que dice la URL. */
const req = (extra: Record<string, unknown> = {}, venueDelToken = 'venue_A') =>
  ({
    authContext: { userId: 'user_1', orgId: 'org_1', venueId: venueDelToken, role: 'ADMIN' },
    query: {},
    params: {},
    body: {},
    ...extra,
  }) as unknown as Request

async function correr(handler: (r: Request, s: Response, n: NextFunction) => unknown, r: Request) {
  const s = res()
  const next = jest.fn()
  await handler(r, s as unknown as Response, next as NextFunction)
  return { s, error: next.mock.calls[0]?.[0] as { statusCode?: number } | undefined }
}

describe('Google Calendar: una conexión de otra sucursal no se ve ni se desconecta', () => {
  beforeEach(() => {
    prismaMock.calendarSyncOutbox.count.mockResolvedValue(0)
    prismaMock.googleCalendarChannel.findFirst.mockResolvedValue(null)
    prismaMock.$transaction.mockResolvedValue([] as any)
  })

  it('🔴 ver el detalle de la conexión del negocio B desde A → 404, sin contar nada de ella', async () => {
    prismaMock.googleCalendarConnection.findUnique.mockResolvedValue({ id: 'c1', scope: 'VENUE', venueId: 'venue_B', staffId: null } as any)

    const { error } = await correr(getConnectionDetail, req({ params: { id: 'c1' } }))

    expect(error?.statusCode).toBe(404)
    expect(prismaMock.calendarSyncOutbox.count).not.toHaveBeenCalled()
  })

  it('ver el detalle de la conexión de MI negocio sigue funcionando', async () => {
    prismaMock.googleCalendarConnection.findUnique.mockResolvedValue({ id: 'c1', scope: 'VENUE', venueId: 'venue_A', staffId: null } as any)

    const { s, error } = await correr(getConnectionDetail, req({ params: { id: 'c1' } }))

    expect(error).toBeUndefined()
    expect(s.status).toHaveBeenCalledWith(200)
  })

  it('🔴 la conexión personal de alguien que NO trabaja en mi sucursal → 404', async () => {
    prismaMock.googleCalendarConnection.findUnique.mockResolvedValue({ id: 'c2', scope: 'STAFF_PERSONAL', venueId: null, staffId: 'otro' } as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)

    const { error } = await correr(getConnectionDetail, req({ params: { id: 'c2' } }))

    expect(error?.statusCode).toBe(404)
    expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ staffId: 'otro', venueId: 'venue_A', active: true }) }),
    )
  })

  it('🔴 desconectar la conexión personal de alguien de otro negocio → 404 y no se toca nada', async () => {
    prismaMock.googleCalendarConnection.findUnique.mockResolvedValue({
      id: 'c2',
      scope: 'STAFF_PERSONAL',
      venueId: null,
      staffId: 'otro',
      channels: [],
    } as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)

    const { error } = await correr(disconnectConnection, req({ params: { id: 'c2' } }))

    expect(error?.statusCode).toBe(404)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('desconectar la personal de alguien que SÍ trabaja en mi sucursal sigue funcionando', async () => {
    prismaMock.googleCalendarConnection.findUnique.mockResolvedValue({
      id: 'c2',
      scope: 'STAFF_PERSONAL',
      venueId: null,
      staffId: 'otro',
      channels: [],
    } as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv1' } as any)

    const { s, error } = await correr(disconnectConnection, req({ params: { id: 'c2' } }))

    expect(error).toBeUndefined()
    expect(s.status).toHaveBeenCalledWith(204)
  })

  it('mi PROPIA conexión personal la puedo desconectar aunque mi sesión sea la del alta (pending)', async () => {
    prismaMock.googleCalendarConnection.findUnique.mockResolvedValue({
      id: 'c3',
      scope: 'STAFF_PERSONAL',
      venueId: null,
      staffId: 'user_1',
      channels: [],
    } as any)

    const { s, error } = await correr(disconnectConnection, req({ params: { id: 'c3' } }, 'pending'))

    expect(error).toBeUndefined()
    expect(s.status).toHaveBeenCalledWith(204)
  })
})

describe('Bitácora y paquetes de créditos usan la sucursal de la URL, no la del token', () => {
  const deB = (extra: Record<string, unknown> = {}) => req({ ...extra, params: { venueId: 'venue_B', ...((extra.params as object) ?? {}) } })

  beforeEach(() => {
    prismaMock.staffVenue.findUnique.mockResolvedValue({ id: 'sv_B' } as any)
  })

  it.each([
    ['getActivityLog', () => activityLogService.queryVenueActivityLogs, (m: jest.Mock) => m.mock.calls[0][0].venueId],
    ['getActivityLogActions', () => activityLogService.getVenueDistinctActions, (m: jest.Mock) => m.mock.calls[0][0]],
    ['getActivityLogEntities', () => activityLogService.getVenueDistinctEntities, (m: jest.Mock) => m.mock.calls[0][0]],
  ] as const)('🔴 bitácora %s lee la sucursal B', async (handler, servicio, sucursalUsada) => {
    const mock = servicio() as unknown as jest.Mock
    mock.mockResolvedValue([])

    await correr((activityLogController as any)[handler], deB())

    expect(sucursalUsada(mock)).toBe('venue_B')
  })

  it.each([
    ['getCreditPacks', 'getCreditPacks', {}],
    ['getCreditPackById', 'getCreditPackById', { params: { packId: 'p1' } }],
    ['createCreditPack', 'createCreditPack', { body: { name: 'x' } }],
    ['updateCreditPack', 'updateCreditPack', { params: { packId: 'p1' } }],
    ['deactivateCreditPack', 'deactivateCreditPack', { params: { packId: 'p1' } }],
    ['getPurchases', 'getCustomerPurchases', {}],
    ['getCustomerPurchases', 'getCustomerPurchases', { params: { customerId: 'cu1' } }],
    ['getTransactions', 'getTransactionHistory', {}],
    ['redeemItem', 'redeemItemManually', { params: { balanceId: 'b1' } }],
    ['adjustBalance', 'adjustItemBalance', { params: { balanceId: 'b1' }, body: { quantity: 1, reason: 'x' } }],
    ['refundPurchase', 'refundPurchase', { params: { purchaseId: 'pu1' }, body: { reason: 'x' } }],
  ] as const)('🔴 paquetes %s trabaja sobre la sucursal B', async (handler, metodo, extra) => {
    const mock = (creditPackService as any)[metodo] as jest.Mock
    mock.mockResolvedValue({})

    await correr((creditPackController as any)[handler], deB(extra as Record<string, unknown>))

    expect(mock.mock.calls[0][0]).toBe('venue_B')
  })

  it('🔴 quien canjea/ajusta/reembolsa se busca en la sucursal B (su StaffVenue de B)', async () => {
    ;(creditPackService.redeemItemManually as jest.Mock).mockResolvedValue({})

    await correr(creditPackController.redeemItem, deB({ params: { balanceId: 'b1' } }))

    expect(prismaMock.staffVenue.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { staffId_venueId: { staffId: 'user_1', venueId: 'venue_B' } } }),
    )
  })
})

describe('Codex r1 de este trabajo', () => {
  it('🔴 el validador de la ruta conserva la sucursal de la URL (antes la tiraba y el controlador se quedaba sin ella)', async () => {
    ;(creditPackService.getCreditPackById as jest.Mock).mockResolvedValue({})
    const r = req({ params: { venueId: 'venue_B', packId: 'p1' } })
    const next = jest.fn()

    await validateRequest(packIdParamsSchema)(r, res() as unknown as Response, next)
    expect(next).toHaveBeenCalledWith()
    expect(r.params).toEqual({ venueId: 'venue_B', packId: 'p1' })

    await correr(creditPackController.getCreditPackById, r)
    expect((creditPackService.getCreditPackById as jest.Mock).mock.calls[0]).toEqual(['venue_B', 'p1'])
  })

  it('🔴 busy-blocks: el calendario personal de alguien que no trabaja en la sucursal → 404, sin leer bloques', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    const r = req({ params: { venueId: 'venue_A' }, query: { staffId: 'de_otro_negocio', from: '2026-10-20T00:00:00Z', to: '2026-10-21T00:00:00Z' } })

    const { error } = await correr(listBusyBlocks, r)

    expect(error?.statusCode).toBe(404)
    expect(prismaMock.externalBusyBlock.findMany).not.toHaveBeenCalled()
  })

  it('busy-blocks: los de alguien que SÍ trabaja aquí, o los míos, salen como siempre', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv' } as any)
    prismaMock.externalBusyBlock.findMany.mockResolvedValue([])
    const de = (staffId: string) =>
      req({ params: { venueId: 'venue_A' }, query: { staffId, from: '2026-10-20T00:00:00Z', to: '2026-10-21T00:00:00Z' } })

    expect((await correr(listBusyBlocks, de('companero'))).error).toBeUndefined()
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    expect((await correr(listBusyBlocks, de('user_1'))).error).toBeUndefined() // los propios no piden fila
  })

  it.each([['pending'], [undefined]])(
    '🔴 sin sucursal elegida (%s), el detalle de una conexión ajena también es 404 (no 409)',
    async venueDelToken => {
      prismaMock.googleCalendarConnection.findUnique.mockResolvedValue({ id: 'c1', scope: 'VENUE', venueId: 'venue_B', staffId: null } as any)

      const { error } = await correr(getConnectionDetail, req({ params: { id: 'c1' } }, venueDelToken as any))

      expect(error?.statusCode).toBe(404)
    },
  )

  it('🔴 quien no está dado de alta en la sucursal recibe un aviso claro (403), no un 500 ni un movimiento sin autor', async () => {
    // Sin autor, el panel mostraría el canje como «Cliente (reserva)» (Codex r2).
    prismaMock.staffVenue.findUnique.mockResolvedValue(null)

    const { error } = await correr(creditPackController.redeemItem, req({ params: { venueId: 'venue_B', balanceId: 'b1' } }))

    expect(error?.statusCode).toBe(403)
    expect(creditPackService.redeemItemManually).not.toHaveBeenCalled()
  })
})
