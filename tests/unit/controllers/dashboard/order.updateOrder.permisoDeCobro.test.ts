/**
 * 🔴 R4-2 (ronda 4 post-QA de sellos tardíos; decisión «A» del founder): el PUT del panel
 * (`PUT /dashboard/venues/:venueId/orders/:orderId`, `orders:update`) resuelve `payments:create` de quien edita — con el
 * resolvedor EFECTIVO de siempre (`tienePermisoEnVenue`: el de `checkPermission`, con personalizaciones del negocio y conjuntos
 * de permisos), cerrado ante falla — y se lo pasa al servicio, que decide bajo el candado de la venta. Sólo cuando la petición
 * trae `customerId`: editar el nombre o el estado no cuesta una consulta de permisos de más.
 *
 * Controller REAL con el resolvedor real; la base es el prismaMock y el servicio se espía.
 */
import type { NextFunction, Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import { updateOrder } from '@/controllers/dashboard/order.dashboard.controller'
import * as orderDashboardService from '@/services/dashboard/order.dashboard.service'

const VENUE = 'v1'
const ORDER = 'o1'
const STAFF = 'staff-1'
/** Quitarle `payments:create` a un CASHIER desde el editor de roles: también lo que lo IMPLICA, o vuelve. */
const SIN_COBRAR = ['payments:create', 'area-tickets:checkout', 'tpv-payments:pay-later']

function quienEdita(rol: string | null, personalizado?: { permissions?: string[]; deniedPermissions?: string[] }) {
  prismaMock.staff.findUnique.mockResolvedValue({ active: true } as any)
  prismaMock.staffVenue.findFirst.mockResolvedValue(null) // no es superadmin
  prismaMock.staffVenue.findUnique.mockResolvedValue(
    rol ? ({ role: rol, active: true, permissionSetId: null, permissionSet: null } as any) : null,
  )
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(
    personalizado
      ? ({ permissions: personalizado.permissions ?? [], deniedPermissions: personalizado.deniedPermissions ?? [] } as any)
      : null,
  )
  prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' } as any)
  prismaMock.staffOrganization.findUnique.mockResolvedValue(null)
}

function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r as Response & { json: jest.Mock; status: jest.Mock }
}

async function editar(body: Record<string, unknown>, role = 'KITCHEN') {
  const r = res()
  const next = jest.fn()
  const req = {
    params: { venueId: VENUE, orderId: ORDER },
    body,
    headers: {},
    query: {},
    method: 'PUT',
    originalUrl: `/api/v1/dashboard/venues/${VENUE}/orders/${ORDER}`,
    authContext: { userId: STAFF, venueId: VENUE, orgId: 'org-1', role },
  } as unknown as Request<{ venueId: string; orderId: string }>
  await updateOrder(req, r, next as unknown as NextFunction)
  return { status: r.status.mock.calls[0]?.[0], next }
}

let espia: jest.SpyInstance
beforeEach(() => {
  espia = jest.spyOn(orderDashboardService, 'updateOrder').mockResolvedValue({ id: ORDER } as any)
})
afterEach(() => espia.mockRestore())

describe('🔴 R4-2: el PUT del panel resuelve payments:create de quien cambia el cliente', () => {
  it('🔴 KITCHEN (sin payments:create): el servicio recibe puedeCambiarClienteEnVentaCobrada: false', async () => {
    quienEdita('KITCHEN')
    const { status, next } = await editar({ customerId: 'cust-K' })
    expect(next).not.toHaveBeenCalled()
    expect(status).toBe(200)
    expect(espia).toHaveBeenCalledWith(VENUE, ORDER, { customerId: 'cust-K' }, { puedeCambiarClienteEnVentaCobrada: false })
  })

  it.each([['CASHIER'], ['MANAGER']])('%s (con payments:create): el servicio recibe puedeCambiarClienteEnVentaCobrada: true', async rol => {
    quienEdita(rol)
    await editar({ customerId: 'cust-K' }, rol)
    expect(espia).toHaveBeenCalledWith(VENUE, ORDER, { customerId: 'cust-K' }, { puedeCambiarClienteEnVentaCobrada: true })
  })

  it('🔴 el negocio le QUITÓ payments:create al CASHIER (editor de roles) ⇒ false: manda el resolvedor efectivo', async () => {
    quienEdita('CASHIER', { deniedPermissions: SIN_COBRAR })
    await editar({ customerId: 'cust-K' }, 'CASHIER')
    expect(espia).toHaveBeenCalledWith(VENUE, ORDER, expect.any(Object), { puedeCambiarClienteEnVentaCobrada: false })
  })

  it('🔴 si el permiso no se puede resolver (falla la base) ⇒ CERRADO: false, y la petición sigue al servicio', async () => {
    quienEdita('CASHIER')
    prismaMock.staffVenue.findUnique.mockRejectedValue(new Error('se cayó la base'))
    const { next } = await editar({ customerId: 'cust-K' }, 'CASHIER')
    expect(next).not.toHaveBeenCalled()
    expect(espia).toHaveBeenCalledWith(VENUE, ORDER, expect.any(Object), { puedeCambiarClienteEnVentaCobrada: false })
  })

  it('una petición SIN customerId no consulta permisos de más (como hoy)', async () => {
    quienEdita('KITCHEN')
    await editar({ customerName: 'Kev', status: 'COMPLETED' })
    expect(espia).toHaveBeenCalledWith(VENUE, ORDER, { customerName: 'Kev', status: 'COMPLETED' }, {})
    expect(prismaMock.staffVenue.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.venueRolePermission.findUnique).not.toHaveBeenCalled()
  })

  it('el 403 del servicio llega al manejador de errores (no se traga)', async () => {
    quienEdita('KITCHEN')
    const prohibido = Object.assign(new Error('Para cambiar el cliente…'), { statusCode: 403 })
    espia.mockRejectedValueOnce(prohibido)
    const { next, status } = await editar({ customerId: 'cust-K' })
    expect(status).toBeUndefined()
    expect(next).toHaveBeenCalledWith(prohibido)
  })
})
