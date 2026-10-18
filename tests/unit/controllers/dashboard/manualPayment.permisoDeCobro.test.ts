/**
 * El pago manual del panel (`POST /dashboard/venues/:venueId/payments/manual`, `payment:create-manual`).
 *
 * 🔴 R8-3a (ronda 8 post-QA de sellos tardíos; Codex recheck-12 P3): el controller YA NO resuelve `payments:create`. Lo hacía para
 * la regla R5-1 (cambiar el cliente de una venta cobrada pide el permiso de cobrar), que quedó muerta con R7-1: el servicio rechaza
 * la venta PAID/REFUNDED para todos antes de esa regla, y en cualquier otro estado la regla no exigía nada. Una consulta que no
 * decidía nada.
 *
 * Controller REAL; la base es el prismaMock y el servicio se espía.
 */
import type { NextFunction, Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import { createManualPayment, getEligibleWaiters, getExternalSources } from '@/controllers/dashboard/manualPayment.controller'
import * as manualPaymentService from '@/services/dashboard/manualPayment.service'

const VENUE = 'v1'
const STAFF = 'staff-1'
/** Quitarle `payments:create` a un rol desde el editor de roles: también lo que lo IMPLICA, o vuelve. */
const SIN_COBRAR = ['payments:create', 'area-tickets:checkout', 'tpv:create', 'tpv-payments:pay-later']
const LIGAR = { orderId: 'o1', customerId: 'cust-K', amount: '20.00', method: 'CASH', source: 'POS' }

function quienRegistra(rol: string | null, personalizado?: { permissions?: string[]; deniedPermissions?: string[] }) {
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

function peticion(body: Record<string, unknown>, role: string) {
  return {
    params: { venueId: VENUE },
    body,
    headers: {},
    query: {},
    method: 'POST',
    originalUrl: `/api/v1/dashboard/venues/${VENUE}/payments/manual`,
    authContext: { userId: STAFF, venueId: VENUE, orgId: 'org-1', role },
  } as unknown as Request
}

async function registrar(body: Record<string, unknown>, role = 'ADMIN') {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  const next = jest.fn()
  await createManualPayment(peticion(body, role), r as Response, next as unknown as NextFunction)
  return { status: r.status.mock.calls[0]?.[0], next }
}

let espia: jest.SpyInstance
beforeEach(() => {
  espia = jest.spyOn(manualPaymentService, 'createManualPayment').mockResolvedValue({ id: 'pay-1' } as any)
})
afterEach(() => espia.mockRestore())

describe('🔴 R8-3a: el pago manual del panel ya no pregunta payments:create', () => {
  it('🔴 ligar un cliente a una venta ⇒ el servicio recibe (venueId, staffId, body) y NO se consulta ningún permiso de más', async () => {
    quienRegistra('ADMIN', { deniedPermissions: SIN_COBRAR })
    const { status, next } = await registrar(LIGAR)
    expect(next).not.toHaveBeenCalled()
    expect(status).toBe(201)
    expect(espia.mock.calls[0]).toEqual([VENUE, STAFF, LIGAR])
    expect(prismaMock.staffVenue.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.venueRolePermission.findUnique).not.toHaveBeenCalled()
  })

  it('el rechazo del servicio (400 ORDER_ALREADY_PAID) llega al manejador de errores (no se traga)', async () => {
    quienRegistra('OWNER')
    const rechazo = Object.assign(new Error('Esta venta ya está cobrada. Para cobrar algo extra, registra una venta nueva.'), {
      statusCode: 400,
      code: 'ORDER_ALREADY_PAID',
    })
    espia.mockRejectedValueOnce(rechazo)
    const { next, status } = await registrar(LIGAR, 'OWNER')
    expect(status).toBeUndefined()
    expect(next).toHaveBeenCalledWith(rechazo)
  })
})

/**
 * 🔴 R6-2 (ronda 6 post-QA de sellos tardíos; Codex recheck-10 P2): UNA sola sucursal por operación — la de la URL, la misma que
 * evalúa `checkPermission('payment:create-manual')`. Antes el servicio recibía la del TOKEN: con sesión
 * de A y URL de B, el permiso se comprobaba en B y se escribía en A.
 */
describe('🔴 R6-2: los tres handlers del pago manual operan en la sucursal de la URL, no en la del token', () => {
  /** Sesión de la sucursal A (token) pidiendo la URL de la sucursal B. */
  const cruzada = (body: Record<string, unknown> = {}, query: Record<string, unknown> = {}) =>
    ({
      params: { venueId: 'venue-B' },
      body,
      headers: {},
      query,
      method: 'POST',
      originalUrl: '/api/v1/dashboard/venues/venue-B/payments/manual',
      authContext: { userId: STAFF, venueId: 'venue-A', orgId: 'org-1', role: 'ADMIN' },
    }) as unknown as Request
  const respuesta = () => {
    const r: any = {}
    r.status = jest.fn(() => r)
    r.json = jest.fn(() => r)
    return r as Response
  }

  it('🔴 crear: el servicio recibe la sucursal de la URL (B)', async () => {
    quienRegistra('ADMIN')
    const next = jest.fn()
    await createManualPayment(cruzada(LIGAR), respuesta(), next as unknown as NextFunction)
    expect(next).not.toHaveBeenCalled()
    expect(espia.mock.calls[0]).toEqual(['venue-B', STAFF, LIGAR])
  })

  it('fuentes externas y meseros: también la sucursal de la URL', async () => {
    const fuentes = jest.spyOn(manualPaymentService, 'getExternalSources').mockResolvedValue([] as any)
    const meseros = jest.spyOn(manualPaymentService, 'getEligibleWaiters').mockResolvedValue([] as any)
    try {
      await getExternalSources(cruzada({}, { limit: '5' }), respuesta(), jest.fn() as unknown as NextFunction)
      await getEligibleWaiters(cruzada(), respuesta(), jest.fn() as unknown as NextFunction)
      expect(fuentes).toHaveBeenCalledWith('venue-B', 5)
      expect(meseros).toHaveBeenCalledWith('venue-B')
    } finally {
      fuentes.mockRestore()
      meseros.mockRestore()
    }
  })

  it('regresión: sesión y URL de la MISMA sucursal ⇒ como hoy', async () => {
    quienRegistra('ADMIN')
    await registrar(LIGAR)
    expect(espia.mock.calls[0]).toEqual([VENUE, STAFF, LIGAR])
  })
})
