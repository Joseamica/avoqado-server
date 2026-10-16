/**
 * 🔴 R5-1 (ronda 5 post-QA de sellos tardíos; Codex recheck-9 P2; decisión «A» del founder): el pago manual del panel
 * (`POST /dashboard/venues/:venueId/payments/manual`, `payment:create-manual`) resuelve `payments:create` de quien registra — con
 * el resolvedor EFECTIVO de siempre (`tienePermisoEnVenue`: el de `checkPermission`, con personalizaciones del negocio y conjuntos
 * de permisos), cerrado ante falla — y se lo pasa al servicio, que decide bajo el candado de la venta. Sólo cuando la petición
 * trae `customerId` Y `orderId` (ligar a una venta existente): un pago sin cliente o una orden sombra no cuestan una consulta de más.
 *
 * Controller REAL con el resolvedor real; la base es el prismaMock y el servicio se espía.
 */
import type { NextFunction, Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import { createManualPayment } from '@/controllers/dashboard/manualPayment.controller'
import * as manualPaymentService from '@/services/dashboard/manualPayment.service'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'

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

describe('🔴 R5-1: el pago manual del panel resuelve payments:create de quien liga un cliente a una venta', () => {
  it('🔴 ADMIN al que el negocio le QUITÓ payments:create (conserva payment:create-manual) ⇒ false', async () => {
    quienRegistra('ADMIN', { deniedPermissions: SIN_COBRAR })
    // Precondición: es justo el actor de Codex — puede registrar pagos manuales y NO puede cobrar.
    expect(await tienePermisoEnVenue(peticion(LIGAR, 'ADMIN'), 'payment:create-manual')).toBe(true)
    expect(await tienePermisoEnVenue(peticion(LIGAR, 'ADMIN'), 'payments:create')).toBe(false)
    const { status, next } = await registrar(LIGAR)
    expect(next).not.toHaveBeenCalled()
    expect(status).toBe(201)
    expect(espia).toHaveBeenCalledWith(VENUE, STAFF, LIGAR, { puedeCambiarClienteEnVentaCobrada: false })
  })

  it.each([['OWNER'], ['ADMIN']])('%s con sus permisos de siempre ⇒ true', async rol => {
    quienRegistra(rol)
    await registrar(LIGAR, rol)
    expect(espia).toHaveBeenCalledWith(VENUE, STAFF, LIGAR, { puedeCambiarClienteEnVentaCobrada: true })
  })

  it('🔴 si el permiso no se puede resolver (falla la base) ⇒ CERRADO: false, y la petición sigue al servicio', async () => {
    quienRegistra('OWNER')
    prismaMock.staffVenue.findUnique.mockRejectedValue(new Error('se cayó la base'))
    const { next } = await registrar(LIGAR, 'OWNER')
    expect(next).not.toHaveBeenCalled()
    expect(espia).toHaveBeenCalledWith(VENUE, STAFF, LIGAR, { puedeCambiarClienteEnVentaCobrada: false })
  })

  it('un pago SIN customerId no consulta permisos de más (como hoy)', async () => {
    quienRegistra('ADMIN')
    const sinCliente = { ...LIGAR, customerId: undefined }
    await registrar(sinCliente)
    expect(espia).toHaveBeenCalledWith(VENUE, STAFF, sinCliente, {})
    expect(prismaMock.staffVenue.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.venueRolePermission.findUnique).not.toHaveBeenCalled()
  })

  it('una orden SOMBRA (sin orderId) con cliente no consulta permisos: es una venta nueva', async () => {
    quienRegistra('ADMIN')
    const sombra = { ...LIGAR, orderId: undefined }
    await registrar(sombra)
    expect(espia).toHaveBeenCalledWith(VENUE, STAFF, sombra, {})
    expect(prismaMock.staffVenue.findUnique).not.toHaveBeenCalled()
  })

  it('el 403 del servicio llega al manejador de errores (no se traga)', async () => {
    quienRegistra('ADMIN', { deniedPermissions: SIN_COBRAR })
    const prohibido = Object.assign(new Error('Para cambiar el cliente…'), { statusCode: 403 })
    espia.mockRejectedValueOnce(prohibido)
    const { next, status } = await registrar(LIGAR)
    expect(status).toBeUndefined()
    expect(next).toHaveBeenCalledWith(prohibido)
  })
})
