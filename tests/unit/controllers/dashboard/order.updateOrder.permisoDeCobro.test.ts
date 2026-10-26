/**
 * Controller real y resolvedor efectivo: transporta actor actual, autoridad histórica
 * y permiso de recibo por separado. No confía en rol viejo del JWT ni en staffId del body.
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

describe('PUT del panel — actor y permisos efectivos de atribución', () => {
  it('🔴 KITCHEN (sin payments:create): el servicio recibe puedeCambiarClienteEnVentaCobrada: false', async () => {
    quienEdita('KITCHEN')
    const { status, next } = await editar({ customerId: 'cust-K' })
    expect(next).not.toHaveBeenCalled()
    expect(status).toBe(200)
    expect(espia).toHaveBeenCalledWith(
      VENUE,
      ORDER,
      { customerId: 'cust-K' },
      {
        puedeCambiarClienteEnVentaCobrada: false,
        staffId: STAFF,
        customerAttribution: { staffId: STAFF, canAssignHistorical: false, canAttachAtReceipt: false },
      },
    )
  })

  it.each([['CASHIER'], ['MANAGER']])('%s: recibo permitido y autoridad histórica sólo para gerente', async rol => {
    quienEdita(rol)
    await editar({ customerId: 'cust-K' }, rol)
    expect(espia).toHaveBeenCalledWith(
      VENUE,
      ORDER,
      { customerId: 'cust-K' },
      {
        puedeCambiarClienteEnVentaCobrada: true,
        staffId: STAFF,
        customerAttribution: { staffId: STAFF, canAssignHistorical: rol === 'MANAGER', canAttachAtReceipt: true },
      },
    )
  })

  it('🔴 el negocio le QUITÓ payments:create al CASHIER (editor de roles) ⇒ false: manda el resolvedor efectivo', async () => {
    quienEdita('CASHIER', { deniedPermissions: SIN_COBRAR })
    await editar({ customerId: 'cust-K' }, 'CASHIER')
    expect(espia).toHaveBeenCalledWith(VENUE, ORDER, expect.any(Object), {
      puedeCambiarClienteEnVentaCobrada: false,
      staffId: STAFF,
      customerAttribution: { staffId: STAFF, canAssignHistorical: false, canAttachAtReceipt: false },
    })
  })

  it('falla la resolución: propaga el error sin invocar una escritura sin autoridad', async () => {
    quienEdita('CASHIER')
    const error = new Error('se cayó la base')
    prismaMock.staffVenue.findUnique.mockRejectedValue(error)
    const { next, status } = await editar({ customerId: 'cust-K' }, 'CASHIER')
    expect(status).toBeUndefined()
    expect(next).toHaveBeenCalledWith(error)
    expect(espia).not.toHaveBeenCalled()
  })

  it('CASHIER con permiso nuevo explícito no alcanza el piso de gerente', async () => {
    quienEdita('CASHIER', { permissions: ['orders:attach-customer'] })
    await editar({ customerId: 'cust-K', staffId: 'manager-spoof' }, 'MANAGER')
    expect(espia).toHaveBeenCalledWith(
      VENUE,
      ORDER,
      expect.any(Object),
      expect.objectContaining({
        staffId: STAFF,
        customerAttribution: { staffId: STAFF, canAssignHistorical: false, canAttachAtReceipt: true },
      }),
    )
  })

  it('MANAGER con el permiso histórico quitado tampoco obtiene autoridad', async () => {
    quienEdita('MANAGER', { deniedPermissions: ['orders:attach-customer'] })
    await editar({ customerId: 'cust-K' }, 'MANAGER')
    expect(espia).toHaveBeenCalledWith(
      VENUE,
      ORDER,
      expect.any(Object),
      expect.objectContaining({
        customerAttribution: { staffId: STAFF, canAssignHistorical: false, canAttachAtReceipt: true },
      }),
    )
  })

  it('una petición SIN customerId no consulta permisos de más (como hoy)', async () => {
    quienEdita('KITCHEN')
    await editar({ customerName: 'Kev', status: 'COMPLETED' })
    // D2 (vales): quien edita siempre viaja (`staffId`), para firmar la bitácora si cancelar suelta los vales de la venta.
    expect(espia).toHaveBeenCalledWith(VENUE, ORDER, { customerName: 'Kev', status: 'COMPLETED' }, { staffId: STAFF })
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
