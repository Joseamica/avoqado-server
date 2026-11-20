/**
 * «Anular producto» en la cuenta de MESA del POS (ANDROID y WINDOWS; Flautas Coyoacán, 20-nov-2026).
 * POST /mobile/venues/:venueId/orders/:orderId/items/:itemId/void reusa `voidItems` de la TPV con los candados de la cortesía de
 * renglón, pero `orders:void`; el autor es la sesión; nada con pagos ni el último renglón (bajo el candado, en `voidItems`).
 */
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => {
  const real = jest.requireActual('@/middlewares/checkFeatureAccess.middleware')
  return { ...real, checkFeatureAccess: (code: string) => Object.assign(real.checkFeatureAccess(code), { featureCode: code }) }
})
jest.mock('@/middlewares/checkTableOwnership.middleware', () => {
  const real = jest.requireActual('@/middlewares/checkTableOwnership.middleware')
  return { ...real, checkTableOwnership: (...a: any[]) => Object.assign(real.checkTableOwnership(...a), { ownership: a[0] ?? 'order' }) }
})
jest.mock('@/services/tpv/order.tpv.service', () => ({
  ...jest.requireActual('@/services/tpv/order.tpv.service'),
  voidItems: jest.fn(),
}))

import { StaffRole } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'
import mobileRouter from '@/routes/mobile.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { hasPermission } from '@/lib/permissions'
import prisma from '@/utils/prismaClient'
import { voidItems } from '@/services/tpv/order.tpv.service'
import { voidOrderItem } from '@/services/mobile/void-item.mobile.service'
import { voidOrderItem as voidOrderItemController } from '@/controllers/mobile/order.mobile.controller'
import { voidOrderItemSchema } from '@/schemas/mobile/voidOrderItem.mobile.schema'

const PATH = '/venues/:venueId/orders/:orderId/items/:itemId/void'
const COMP = '/venues/:venueId/orders/:orderId/items/:itemId/comp'

const capa = (path: string) => (mobileRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post)
const handles = (path: string): any[] => capa(path).route.stack.map((l: any) => l.handle)

describe('Ruta POST …/items/:itemId/void', () => {
  it('existe, con sesión, TABLE_SERVICE, orders:void y dueño de la mesa, como la cortesía de renglón', () => {
    expect(capa(PATH)).toBeDefined()
    const h = handles(PATH)
    expect(h[0]).toBe(authenticateTokenMiddleware)
    expect(h.map(x => x.featureCode).filter(Boolean)).toEqual(['TABLE_SERVICE'])
    expect(h.map(x => x.requiredPermission).filter(Boolean)).toEqual(['orders:void'])
    expect(h.map(x => x.ownership).filter(Boolean)).toEqual(['order'])
    // La cortesía de renglón trae los mismos candados, con su permiso.
    expect(
      handles(COMP)
        .map(x => x.featureCode)
        .filter(Boolean),
    ).toEqual(['TABLE_SERVICE'])
    expect(
      handles(COMP)
        .map(x => x.ownership)
        .filter(Boolean),
    ).toEqual(['order'])
  })

  it('el permiso va antes que el dueño de la mesa (el 403 `overridable` abre el PIN del gerente)', () => {
    const h = handles(PATH)
    expect(h.findIndex(x => x.requiredPermission)).toBeLessThan(h.findIndex(x => x.ownership))
  })

  it('de fábrica: mesero, cajero y cocina no anulan (piden el PIN); gerente para arriba sí; el dueño se lo puede dar a un mesero', () => {
    for (const role of [StaffRole.WAITER, StaffRole.CASHIER, StaffRole.KITCHEN, StaffRole.HOST]) {
      expect(hasPermission(role, null, 'orders:void')).toBe(false)
    }
    for (const role of [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]) {
      expect(hasPermission(role, null, 'orders:void')).toBe(true)
    }
    expect(hasPermission(StaffRole.WAITER, ['tpv-orders:void'], 'orders:void')).toBe(true)
  })
})

describe('Esquema: el motivo es obligatorio y la versión opcional', () => {
  const p = { venueId: 'v', orderId: 'o', itemId: 'i' }
  it('sin motivo o en blanco ⇒ 400 en español', () => {
    for (const body of [{}, { reason: '   ' }]) {
      const r = voidOrderItemSchema.safeParse({ params: p, body })
      expect(r.success).toBe(false)
      expect(r.success ? [] : r.error.errors.map(e => e.message)).toEqual(['Elige el motivo para anular el producto'])
    }
  })
  it('con motivo; versión ausente, null o un entero', () => {
    for (const expectedVersion of [undefined, null, 3]) {
      expect(voidOrderItemSchema.safeParse({ params: p, body: { reason: 'Error de entrada', expectedVersion } }).success).toBe(true)
    }
  })
})

describe('voidOrderItem (servicio de la mesa del POS)', () => {
  const findFirst = prisma.order.findFirst as jest.Mock
  beforeEach(() => {
    jest.clearAllMocks()
    findFirst.mockResolvedValue({ version: 7, items: [{ id: 'i1' }] })
    ;(voidItems as jest.Mock).mockResolvedValue({
      id: 'o1',
      version: 8,
      subtotal: 50,
      total: 50,
      remainingBalance: 50,
    })
  })
  const base = { venueId: 'v1', orderId: 'o1', itemId: 'i1', reason: '  El cliente cambió de parecer ', actorId: 'mesero' }

  it('anula UN renglón con las guardas de la mesa; firma la sesión; la versión de la lectura si el POS no manda', async () => {
    const r = await voidOrderItem(base)
    expect(voidItems).toHaveBeenCalledWith('v1', 'o1', {
      itemIds: ['i1'],
      reason: 'El cliente cambió de parecer',
      staffId: 'mesero',
      actorId: 'mesero',
      expectedVersion: 7,
      soloSinCobros: true,
      sinCancelarLaCuenta: true,
    })
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'o1', venueId: 'v1' } }))
    expect(r).toEqual({
      id: 'o1',
      itemId: 'i1',
      reason: 'El cliente cambió de parecer',
      version: 8,
      subtotal: 50,
      total: 50,
      remainingBalance: 50,
    })
  })

  it('la versión que manda el POS gana (un cambio de otro aparato da 409)', async () => {
    await voidOrderItem({ ...base, expectedVersion: 5 })
    expect(voidItems).toHaveBeenCalledWith('v1', 'o1', expect.objectContaining({ expectedVersion: 5 }))
  })

  it('sin motivo ⇒ 400 sin tocar nada', async () => {
    await expect(voidOrderItem({ ...base, reason: '  ' })).rejects.toMatchObject({ statusCode: 400 })
    expect(voidItems).not.toHaveBeenCalled()
  })

  it('cuenta de otro negocio o que no existe ⇒ 404', async () => {
    findFirst.mockResolvedValue(null)
    await expect(voidOrderItem(base)).rejects.toMatchObject({ statusCode: 404 })
    expect(voidItems).not.toHaveBeenCalled()
  })

  it('el renglón ya no está en la cuenta ⇒ 404 en español, sin tocar nada', async () => {
    findFirst.mockResolvedValue({ version: 7, items: [] })
    await expect(voidOrderItem(base)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Ese producto ya no está en la cuenta. Vuelve a abrirla.',
    })
    expect(voidItems).not.toHaveBeenCalled()
  })
})

describe('Controlador: el autor es la sesión', () => {
  const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() }) as unknown as Response
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ version: 2, items: [{ id: 'i1' }] })
    ;(voidItems as jest.Mock).mockResolvedValue({ id: 'o1', version: 3, subtotal: 0, total: 0, remainingBalance: 0 })
  })

  it('sin sesión ⇒ 401, sin anular', async () => {
    const next = jest.fn() as unknown as NextFunction
    await voidOrderItemController({ params: { venueId: 'v1', orderId: 'o1', itemId: 'i1' }, body: { reason: 'x' } } as any, res(), next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }))
    expect(voidItems).not.toHaveBeenCalled()
  })

  it('con sesión ⇒ la sesión firma y responde la versión nueva', async () => {
    const r = res()
    const next = jest.fn() as unknown as NextFunction
    const req = {
      params: { venueId: 'v1', orderId: 'o1', itemId: 'i1' },
      body: { reason: 'Error de entrada', expectedVersion: null },
      authContext: { userId: 'gerente' },
    } as unknown as Request
    await voidOrderItemController(req, r, next)
    expect(next).not.toHaveBeenCalled()
    expect(voidItems).toHaveBeenCalledWith(
      'v1',
      'o1',
      expect.objectContaining({ staffId: 'gerente', actorId: 'gerente', expectedVersion: 2 }),
    )
    expect(r.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ id: 'o1', version: 3 }) })
  })
})
