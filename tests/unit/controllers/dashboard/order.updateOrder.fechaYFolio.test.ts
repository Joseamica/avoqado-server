/**
 * D70 (encargo a49c3e): la fecha (`createdAt`) y el folio (`orderNumber`) de una venta sólo los cambia un SUPERADMIN de
 * verdad (fila activa en la base, sin impersonar). `orders:update` lo traen de fábrica WAITER, CASHIER y KITCHEN: con
 * sólo eso, por API, un mesero podía fechar una venta en otro día o turno (reportes, cortes, comisiones, y la mesa sin red
 * que vuelve a unirse a la cuenta de otra visita: Codex r3 del D51). El diálogo del DASHBOARD ya era sólo de SUPERADMIN.
 */
import type { NextFunction, Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import { updateOrder } from '@/controllers/dashboard/order.dashboard.controller'
import * as orderDashboardService from '@/services/dashboard/order.dashboard.service'
import { ForbiddenError } from '@/errors/AppError'

const VENUE = 'v1'
const ORDER = 'o1'
const STAFF = 'staff-1'

function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r as Response & { json: jest.Mock; status: jest.Mock }
}

async function editar(body: Record<string, unknown>, ctx: Record<string, unknown>) {
  const r = res()
  const next = jest.fn()
  const req = {
    params: { venueId: VENUE, orderId: ORDER },
    body,
    headers: {},
    query: {},
    method: 'PUT',
    originalUrl: `/api/v1/dashboard/venues/${VENUE}/orders/${ORDER}`,
    authContext: { userId: STAFF, venueId: VENUE, orgId: 'org-1', ...ctx },
  } as unknown as Request<{ venueId: string; orderId: string }>
  await updateOrder(req, r, next as unknown as NextFunction)
  return { status: r.status.mock.calls[0]?.[0], next }
}

let espia: jest.SpyInstance
beforeEach(() => {
  espia = jest.spyOn(orderDashboardService, 'updateOrder').mockResolvedValue({ id: ORDER } as any)
})
afterEach(() => espia.mockRestore())

describe('PUT de la venta — fecha y folio sólo SUPERADMIN (D70)', () => {
  it.each([
    ['WAITER', { createdAt: '2026-11-01T10:00:00.000Z' }],
    ['CASHIER', { orderNumber: 'ORD-1' }],
    ['MANAGER', { createdAt: '2026-11-01T10:00:00.000Z', customerName: 'Ana' }],
    ['OWNER', { orderNumber: 'ORD-2' }],
  ])('🔴 %s no puede cambiar fecha ni folio: 403 y no se escribe nada', async (role, body) => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null) // no es superadmin en la base
    const { next } = await editar(body, { role })
    expect(espia).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError))
  })

  it('🔴 un token que DICE SUPERADMIN pero sin fila activa en la base: 403', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    const { next } = await editar({ createdAt: '2026-11-01T10:00:00.000Z' }, { role: 'SUPERADMIN' })
    expect(espia).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError))
  })

  it('🔴 un superadmin IMPERSONANDO a un mesero tampoco (la sesión actúa como el mesero): 403', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-super' } as any)
    const { next } = await editar(
      { orderNumber: 'ORD-3' },
      { role: 'WAITER', isImpersonating: true, realUserId: 'super-1', realRole: 'SUPERADMIN' },
    )
    expect(espia).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError))
  })

  it('SUPERADMIN de verdad sí cambia fecha y folio', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-super' } as any)
    const body = { createdAt: '2026-11-01T10:00:00.000Z', orderNumber: 'ORD-4' }
    const { status, next } = await editar(body, { role: 'SUPERADMIN' })
    expect(next).not.toHaveBeenCalled()
    expect(status).toBe(200)
    expect(espia).toHaveBeenCalledWith(VENUE, ORDER, body, expect.objectContaining({ staffId: STAFF }))
  })

  it('sin fecha ni folio, el resto sigue como hoy (un mesero cambia el nombre del cliente) y no consulta de más', async () => {
    const { status } = await editar({ customerName: 'Ana' }, { role: 'WAITER' })
    expect(status).toBe(200)
    expect(espia).toHaveBeenCalled()
    expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
  })

  it('falla la consulta de la base: no escribe y el error llega al manejador (falla cerrado)', async () => {
    prismaMock.staffVenue.findFirst.mockRejectedValue(new Error('db caída'))
    const { next } = await editar({ createdAt: '2026-11-01T10:00:00.000Z' }, { role: 'SUPERADMIN' })
    expect(espia).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
  })
})
