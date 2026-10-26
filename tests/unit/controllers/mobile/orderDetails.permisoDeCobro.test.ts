/**
 * Ambos caminos del controller (directo y operación HTTP) transportan la autoridad
 * efectiva histórica separada del permiso de recibo. Si falla la DB, no escriben.
 */
const mockExecute = jest.fn()
jest.mock('@/services/mobile/http-operation.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/http-operation.mobile.service'),
  executeHttpOperation: (...a: unknown[]) => mockExecute(...a),
}))
jest.mock('@/controllers/mobile/http-operation.mobile.controller', () => ({
  sendHttpOperationReply: jest.fn((res: any) => res.status(200).json({ ok: true })),
}))

import type { NextFunction, Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import { updateOrderDetails } from '@/controllers/mobile/order.mobile.controller'
import * as orderMobileService from '@/services/mobile/order.mobile.service'

const VENUE = 'v1'
const ORDER = 'o1'
const STAFF = 'staff-1'

function quienEdita(rol: string) {
  prismaMock.staff.findUnique.mockResolvedValue({ active: true } as any)
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockResolvedValue({ role: rol, active: true, permissionSetId: null, permissionSet: null } as any)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' } as any)
  prismaMock.staffOrganization.findUnique.mockResolvedValue(null)
}

function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r as Response & { json: jest.Mock; status: jest.Mock }
}

async function editar(body: Record<string, unknown>, role: string) {
  const r = res()
  const next = jest.fn()
  const req = {
    params: { venueId: VENUE, orderId: ORDER },
    body,
    headers: {},
    query: {},
    method: 'POST',
    originalUrl: `/api/v1/mobile/venues/${VENUE}/orders/${ORDER}/details`,
    authContext: { userId: STAFF, venueId: VENUE, orgId: 'org-1', role },
  } as unknown as Request
  await updateOrderDetails(req, r, next as unknown as NextFunction)
  return { r, next }
}

let directo: jest.SpyInstance
let enTransaccion: jest.SpyInstance
beforeEach(() => {
  directo = jest.spyOn(orderMobileService, 'updateOrderDetails').mockResolvedValue({ customerId: 'cust-K' } as any)
  enTransaccion = jest
    .spyOn(orderMobileService, 'updateOrderDetailsInTransaction')
    .mockResolvedValue({ data: { customerId: 'cust-K' }, affectedServiceChargeIds: [] } as any)
  mockExecute.mockReset().mockImplementation(async (_i: unknown, mutate: (tx: unknown) => Promise<unknown>) => {
    await mutate({})
    return { kind: 'TERMINAL', envelope: {}, appliedNow: true }
  })
})
afterEach(() => {
  directo.mockRestore()
  enTransaccion.mockRestore()
})

describe('detalle POS — autoridad efectiva para atribución del cliente', () => {
  it('🔴 KITCHEN (camino directo): el servicio recibe puedeCambiarClienteEnVentaCobrada: false', async () => {
    quienEdita('KITCHEN')
    const { next } = await editar({ customerId: 'cust-K' }, 'KITCHEN')
    expect(next).not.toHaveBeenCalled()
    expect(directo).toHaveBeenCalledWith(VENUE, ORDER, expect.objectContaining({ customerId: 'cust-K' }), {
      puedeCambiarClienteEnVentaCobrada: false,
      customerAttribution: { staffId: STAFF, canAssignHistorical: false, canAttachAtReceipt: false },
    })
  })

  it('CASHIER (camino directo): puedeCambiarClienteEnVentaCobrada: true', async () => {
    quienEdita('CASHIER')
    await editar({ customerId: 'cust-K' }, 'CASHIER')
    expect(directo).toHaveBeenCalledWith(VENUE, ORDER, expect.any(Object), {
      puedeCambiarClienteEnVentaCobrada: true,
      customerAttribution: { staffId: STAFF, canAssignHistorical: false, canAttachAtReceipt: true },
    })
  })

  it('🔴 KITCHEN por la operación HTTP idempotente: la transacción recibe puedeCambiarClienteEnVentaCobrada: false', async () => {
    quienEdita('KITCHEN')
    const op = { version: 1, id: '0b6f1c1e-2f6a-4a51-9d0f-4c1f2b7a9e11', deviceId: '7d3b2a10-5c4e-4f6a-8b9c-1a2b3c4d5e6f' }
    const { next } = await editar({ customerId: 'cust-K', httpOperation: op }, 'KITCHEN')
    expect(next).not.toHaveBeenCalled()
    expect(enTransaccion).toHaveBeenCalledWith({}, VENUE, ORDER, expect.objectContaining({ customerId: 'cust-K' }), {
      puedeCambiarClienteEnVentaCobrada: false,
      customerAttribution: { staffId: STAFF, canAssignHistorical: false, canAttachAtReceipt: false },
    })
  })

  it('MANAGER transmite autoridad histórica efectiva además del recibo', async () => {
    quienEdita('MANAGER')
    await editar({ customerId: 'cust-K' }, 'MANAGER')
    expect(directo).toHaveBeenCalledWith(VENUE, ORDER, expect.any(Object), {
      puedeCambiarClienteEnVentaCobrada: true,
      customerAttribution: { staffId: STAFF, canAssignHistorical: true, canAttachAtReceipt: true },
    })
  })

  it('rol alto en JWT no vence al CASHIER actual, aun con permiso explícito', async () => {
    quienEdita('CASHIER')
    prismaMock.venueRolePermission.findUnique.mockResolvedValue({ permissions: ['orders:attach-customer'], deniedPermissions: [] } as any)
    await editar({ customerId: 'cust-K', staffId: 'manager-spoof' }, 'OWNER')
    expect(directo).toHaveBeenCalledWith(VENUE, ORDER, expect.any(Object), {
      puedeCambiarClienteEnVentaCobrada: true,
      customerAttribution: { staffId: STAFF, canAssignHistorical: false, canAttachAtReceipt: true },
    })
  })

  it('falla la resolución: no invoca el servicio ni la operación HTTP', async () => {
    quienEdita('CASHIER')
    const error = new Error('se cayó la base')
    prismaMock.staffVenue.findUnique.mockRejectedValue(error)
    const { next } = await editar({ customerId: 'cust-K' }, 'CASHIER')
    expect(next).toHaveBeenCalledWith(error)
    expect(directo).not.toHaveBeenCalled()
    expect(enTransaccion).not.toHaveBeenCalled()
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it.each([[{ name: 'Mesa 4' }], [{ name: 'Mesa 4', customerId: null }]])(
    'sin un customerId que cambie algo (%j) no consulta permisos de más',
    async body => {
      quienEdita('KITCHEN')
      await editar(body, 'KITCHEN')
      expect(directo).toHaveBeenCalledWith(VENUE, ORDER, expect.any(Object), {})
      expect(prismaMock.staffVenue.findUnique).not.toHaveBeenCalled()
    },
  )
})
