/**
 * 🔴 MEDIO-1 (full-testing, 15-oct-2026; decisión «A» del founder): en la TPV, «agregar cliente» a una venta YA pagada daba el
 * sello y los puntos a cualquiera con `orders:update`. Un KITCHEN (que no cobra) ligó a un cliente a una venta cobrada y le
 * dio su sello (evidencia `C2q-kitchen-tpv-attach.http`: 201 + `stamped: true`).
 *
 * Ahora el sello tardío desde la TPV exige el MISMO permiso que el «Agregar cliente» del POS
 * (`POST /mobile/venues/:venueId/payments/:paymentId/customer` → `payments:create`), resuelto con el resolvedor EFECTIVO de
 * siempre (`tienePermisoEnVenue`: el de `checkPermission`, con las personalizaciones del negocio y los conjuntos de permisos).
 * Sin el permiso la liga queda EXACTAMENTE como antes (`orders:update`), pero no se reabre la lealtad, no se llama al sello y
 * `loyalty` sale `null`.
 *
 * Controller + servicio REALES, con el resolvedor de permisos real; sólo la base (prismaMock) y la lealtad están simuladas.
 */
const mockLate = jest.fn()
const mockReabrir = jest.fn()
const mockAuditSinPermiso = jest.fn()
jest.mock('@/services/shared/loyaltyOnLateCustomer', () => ({
  awardLoyaltyForLateCustomer: (...a: unknown[]) => mockLate(...a),
  reabrirLealtadSiAplica: (...a: unknown[]) => mockReabrir(...a),
  auditarLigaSinPermisoDeCobro: (...a: unknown[]) => mockAuditSinPermiso(...a),
}))

import type { NextFunction, Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import {
  addCustomerToOrder,
  createAndAddCustomerToOrder,
  removeCustomerFromOrder,
  updateGuestInfo,
} from '@/controllers/tpv/order.tpv.controller'
import * as orderTpvService from '@/services/tpv/order.tpv.service'
import { checkPermission } from '@/middlewares/checkPermission.middleware'

const VENUE = 'v1'
const ORDER = 'o1'
const STAFF = 'staff-1'
const LISTA = [{ id: 'oc-1', orderId: ORDER, customerId: 'cust-1', isPrimary: true, customer: { id: 'cust-1' } }]
const SELLO = { stampsEnabled: true, stamped: true, reason: null, stampsEarned: 1, stampsRequired: 3, rewardReady: false }
/**
 * Quitarle `payments:create` a un CASHIER desde el editor de roles: también hay que quitar lo que lo IMPLICA, o vuelve
 * (`getEffectiveRolePermissions`, decisión del founder del 18-ago: «lo incluido no se quita por separado»).
 */
const SIN_COBRAR = ['payments:create', 'area-tickets:checkout', 'tpv-payments:pay-later']

interface Rol {
  rol: string | null
  /** `VenueRolePermission` del negocio para ese rol (lo que agrega / lo que QUITA). */
  personalizado?: { permissions?: string[]; deniedPermissions?: string[] }
  /** Conjunto de permisos propio del empleado (`StaffVenue.permissionSet`): reemplaza a los del rol. */
  conjunto?: string[]
}

/** Quién liga, en la base: la persona activa, su fila en ESTE negocio y lo que el negocio personalizó de su rol. */
function quienLiga({ rol, personalizado, conjunto }: Rol) {
  prismaMock.staff.findUnique.mockResolvedValue({ active: true } as any)
  prismaMock.staffVenue.findFirst.mockResolvedValue(null) // no es superadmin
  prismaMock.staffVenue.findUnique.mockResolvedValue(
    rol
      ? ({
          role: rol,
          active: true,
          permissionSetId: conjunto ? 'ps-1' : null,
          permissionSet: conjunto ? { permissions: conjunto } : null,
        } as any)
      : null,
  )
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(
    personalizado
      ? ({ permissions: personalizado.permissions ?? [], deniedPermissions: personalizado.deniedPermissions ?? [] } as any)
      : null,
  )
  prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' } as any)
  prismaMock.staffOrganization.findUnique.mockResolvedValue(null)
}

let reabrioDentro: boolean | null = null
let enTransaccion = false

beforeEach(() => {
  reabrioDentro = null
  prismaMock.$transaction.mockImplementation(async (cb: any) => {
    enTransaccion = true
    try {
      return await cb(prismaMock)
    } finally {
      enTransaccion = false
    }
  })
  // La venta YA pagada (lectura previa y la de DENTRO de la transacción).
  prismaMock.order.findUnique.mockResolvedValue({ id: ORDER, orderNumber: 'ORD-1' } as any)
  prismaMock.order.findFirst.mockResolvedValue({ paymentStatus: 'PAID' } as any)
  // F1 (ronda 1): el candado canónico de la venta y el primario vigente, dentro de la transacción.
  prismaMock.$queryRaw.mockReset()
  prismaMock.$queryRaw.mockResolvedValue([{ id: ORDER }] as never)
  prismaMock.orderCustomer.findUnique.mockReset()
  prismaMock.orderCustomer.findUnique.mockResolvedValue(null)
  prismaMock.orderCustomer.findFirst.mockReset()
  prismaMock.orderCustomer.findFirst.mockResolvedValue(null)
  prismaMock.orderCustomer.create.mockResolvedValue({ id: 'oc-1' } as any)
  mockAuditSinPermiso.mockResolvedValue(undefined)
  prismaMock.orderCustomer.findMany.mockResolvedValue(LISTA as any)
  mockLate.mockResolvedValue(SELLO)
  mockReabrir.mockImplementation(async () => {
    reabrioDentro = enTransaccion
    return true
  })
})

function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r as Response & { json: jest.Mock; status: jest.Mock }
}

function req(body: Record<string, unknown>): Request<any, any, any> {
  return {
    params: { venueId: VENUE, orderId: ORDER },
    body,
    headers: {},
    query: {},
    method: 'POST',
    originalUrl: `/api/v1/tpv/venues/${VENUE}/orders/${ORDER}/customers`,
    authContext: { userId: STAFF, venueId: VENUE, orgId: 'org-1', role: 'CASHIER' },
  } as unknown as Request<any, any, any>
}

/** ¿El «Agregar cliente» del POS (`checkPermission('payments:create')`, la ruta móvil) dejaría pasar a ESTA persona? */
async function elPosLoDejaria(): Promise<boolean> {
  let paso = false
  await checkPermission('payments:create')(req({}) as unknown as Request, res(), (() => {
    paso = true
  }) as NextFunction)
  return paso
}

async function ligarExistente(): Promise<{ status: number; cuerpo: any; next: jest.Mock }> {
  prismaMock.customer.findUnique.mockResolvedValue({ id: 'cust-1', venueId: VENUE, firstName: 'Diego', lastName: null } as any)
  const r = res()
  const next = jest.fn()
  await addCustomerToOrder(req({ customerId: 'cust-1' }), r, next as unknown as NextFunction)
  return { status: r.status.mock.calls[0]?.[0], cuerpo: r.json.mock.calls[0]?.[0], next }
}

describe('🔴 MEDIO-1: TPV orders/:orderId/customers — el sello tardío exige payments:create', () => {
  it('🔴 KITCHEN (sólo orders:update): liga a la venta PAGADA (201, la lista de siempre) como ACOMPAÑANTE: no reabre, no sella, loyalty null, y audita', async () => {
    quienLiga({ rol: 'KITCHEN' })
    const { status, cuerpo, next } = await ligarExistente()
    expect(next).not.toHaveBeenCalled()
    expect(status).toBe(201)
    expect(cuerpo).toEqual({ success: true, data: LISTA, loyalty: null, message: 'Customer added to order successfully' })
    // F1 (ronda 1): nunca primaria de una venta ya cobrada sin `payments:create` ⇒ el cobro en curso y el reconciliador no la ven.
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: ORDER, customerId: 'cust-1', isPrimary: false } })
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(mockLate).not.toHaveBeenCalled()
    // F2: la liga que crea audita también sin permiso.
    expect(mockAuditSinPermiso).toHaveBeenCalledWith({
      venueId: VENUE,
      orderId: ORDER,
      customerId: 'cust-1',
      staffId: STAFF,
      orderNumber: 'ORD-1',
    })
    expect(await elPosLoDejaria()).toBe(false) // el mismo criterio que la ruta del POS
  })

  it.each(['CASHIER', 'WAITER', 'MANAGER', 'OWNER'])('%s (tiene payments:create): reabre DENTRO de la transacción y sella', async rol => {
    quienLiga({ rol })
    const { status, cuerpo } = await ligarExistente()
    expect(status).toBe(201)
    expect(cuerpo.loyalty).toEqual(SELLO)
    expect(cuerpo.data).toEqual(LISTA)
    expect(mockReabrir).toHaveBeenCalledWith(prismaMock, { venueId: VENUE, orderId: ORDER, customerId: 'cust-1', staffId: STAFF })
    expect(reabrioDentro).toBe(true)
    expect(mockLate).toHaveBeenCalledWith(expect.objectContaining({ venueId: VENUE, orderId: ORDER, customerId: 'cust-1', staffId: STAFF }))
    expect(await elPosLoDejaria()).toBe(true)
  })

  it('🔴 el negocio le QUITÓ payments:create al CASHIER (VenueRolePermission.deniedPermissions): liga, pero sin sello', async () => {
    quienLiga({ rol: 'CASHIER', personalizado: { deniedPermissions: SIN_COBRAR } })
    const { status, cuerpo } = await ligarExistente()
    expect(status).toBe(201)
    expect(cuerpo.loyalty).toBeNull()
    expect(cuerpo.data).toEqual(LISTA)
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(mockLate).not.toHaveBeenCalled()
    expect(await elPosLoDejaria()).toBe(false)
  })

  it('regresión de la regla del resolvedor: quitar SÓLO payments:create no lo quita mientras el rol conserve lo que lo implica — sella, igual que el POS', async () => {
    quienLiga({ rol: 'CASHIER', personalizado: { deniedPermissions: ['payments:create'] } })
    const { cuerpo } = await ligarExistente()
    expect(cuerpo.loyalty).toEqual(SELLO)
    expect(await elPosLoDejaria()).toBe(true)
  })

  it('el negocio le DIO payments:create al KITCHEN (personalización que agrega): sí sella', async () => {
    quienLiga({ rol: 'KITCHEN', personalizado: { permissions: ['payments:create'] } })
    const { cuerpo } = await ligarExistente()
    expect(cuerpo.loyalty).toEqual(SELLO)
    expect(mockLate).toHaveBeenCalled()
    expect(await elPosLoDejaria()).toBe(true)
  })

  it('conjunto de permisos propio del empleado SIN payments:create (aunque su rol lo tenga): sin sello', async () => {
    quienLiga({ rol: 'CASHIER', conjunto: ['orders:read', 'orders:update'] })
    const { cuerpo } = await ligarExistente()
    expect(cuerpo.loyalty).toBeNull()
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(mockLate).not.toHaveBeenCalled()
    expect(await elPosLoDejaria()).toBe(false)
  })

  it('🔴 si el permiso no se puede resolver (la base truena): falla CERRADO — la liga sale igual, sin sello', async () => {
    quienLiga({ rol: 'CASHIER' })
    prismaMock.venueRolePermission.findUnique.mockRejectedValue(new Error('P1001'))
    const { status, cuerpo, next } = await ligarExistente()
    expect(next).not.toHaveBeenCalled()
    expect(status).toBe(201)
    expect(cuerpo.loyalty).toBeNull()
    expect(cuerpo.data).toEqual(LISTA)
    expect(mockLate).not.toHaveBeenCalled()
  })

  it('regresión: cuenta ABIERTA y KITCHEN: la liga de siempre (primario), loyalty null', async () => {
    quienLiga({ rol: 'KITCHEN' })
    prismaMock.order.findFirst.mockResolvedValue({ paymentStatus: 'PENDING' } as any)
    const { status, cuerpo } = await ligarExistente()
    expect(status).toBe(201)
    expect(cuerpo.loyalty).toBeNull()
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: ORDER, customerId: 'cust-1', isPrimary: true } })
    expect(mockAuditSinPermiso).not.toHaveBeenCalled() // cuenta abierta: no es una venta cobrada
  })
})

describe('🔴 MEDIO-1: TPV orders/:orderId/customers/create — lo mismo con el cliente NUEVO', () => {
  async function crear() {
    prismaMock.customer.findUnique.mockResolvedValue(null) // sin duplicados de correo/teléfono
    prismaMock.customer.create.mockResolvedValue({ id: 'nuevo' } as any)
    const r = res()
    const next = jest.fn()
    await createAndAddCustomerToOrder(req({ firstName: 'Nueva' }), r, next as unknown as NextFunction)
    return { status: r.status.mock.calls[0]?.[0], cuerpo: r.json.mock.calls[0]?.[0], next }
  }

  it('🔴 KITCHEN: crea y liga al cliente (201) como ACOMPAÑANTE de la venta pagada: sin sello, y audita', async () => {
    quienLiga({ rol: 'KITCHEN' })
    const { status, cuerpo, next } = await crear()
    expect(next).not.toHaveBeenCalled()
    expect(status).toBe(201)
    expect(cuerpo).toEqual({ success: true, data: LISTA, loyalty: null, message: 'Customer created and added to order successfully' })
    expect(prismaMock.customer.create).toHaveBeenCalled()
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: ORDER, customerId: 'nuevo', isPrimary: false } })
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(mockLate).not.toHaveBeenCalled()
    expect(mockAuditSinPermiso).toHaveBeenCalledWith({
      venueId: VENUE,
      orderId: ORDER,
      customerId: 'nuevo',
      staffId: STAFF,
      orderNumber: 'ORD-1',
    })
  })

  it('CASHIER: crea, liga y sella al cliente NUEVO', async () => {
    quienLiga({ rol: 'CASHIER' })
    const { cuerpo } = await crear()
    expect(cuerpo.loyalty).toEqual(SELLO)
    expect(mockReabrir).toHaveBeenCalledWith(prismaMock, { venueId: VENUE, orderId: ORDER, customerId: 'nuevo', staffId: STAFF })
    expect(mockLate).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'nuevo', staffId: STAFF }))
  })

  it('🔴 override que QUITA payments:create: sin sello', async () => {
    quienLiga({ rol: 'CASHIER', personalizado: { deniedPermissions: SIN_COBRAR } })
    const { cuerpo } = await crear()
    expect(cuerpo.loyalty).toBeNull()
    expect(mockLate).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 Ronda 2: quitar al PRIMARIO de una venta cobrada promueve al siguiente SÓLO si quien quita tiene `payments:create` (el
 * mismo resolvedor efectivo, falla cerrado). La ruta sigue exigiendo `orders:update`.
 */
describe('🔴 Ronda 2: TPV DELETE orders/:orderId/customers/:customerId — promover en una venta cobrada exige payments:create', () => {
  beforeEach(() => {
    prismaMock.orderCustomer.findUnique.mockResolvedValue({ id: 'oc-P', orderId: ORDER, customerId: 'cust-P', isPrimary: true } as any)
    prismaMock.orderCustomer.delete.mockResolvedValue({ id: 'oc-P' } as any)
    prismaMock.orderCustomer.findFirst.mockResolvedValue({ id: 'oc-C', orderId: ORDER, customerId: 'cust-C', isPrimary: false } as any)
    prismaMock.orderCustomer.update.mockResolvedValue({ id: 'oc-C' } as any)
  })

  async function quitar() {
    const r = res()
    const next = jest.fn()
    const q = { ...req({}), params: { venueId: VENUE, orderId: ORDER, customerId: 'cust-P' }, method: 'DELETE' }
    await removeCustomerFromOrder(q as unknown as Request<any>, r, next as unknown as NextFunction)
    return { status: r.status.mock.calls[0]?.[0], cuerpo: r.json.mock.calls[0]?.[0], next }
  }

  it('🔴 KITCHEN quita al primario de una venta PAGADA: 200, pero NADIE queda primario', async () => {
    quienLiga({ rol: 'KITCHEN' })
    const { status, next } = await quitar()
    expect(next).not.toHaveBeenCalled()
    expect(status).toBe(200)
    expect(prismaMock.orderCustomer.delete).toHaveBeenCalled()
    expect(prismaMock.orderCustomer.update).not.toHaveBeenCalled()
    expect(await elPosLoDejaria()).toBe(false)
  })

  it('CASHIER (tiene payments:create): promueve al siguiente, como siempre', async () => {
    quienLiga({ rol: 'CASHIER' })
    await quitar()
    expect(prismaMock.orderCustomer.update).toHaveBeenCalledWith({ where: { id: 'oc-C' }, data: { isPrimary: true } })
  })

  it('🔴 override que QUITA payments:create al CASHIER: no promueve', async () => {
    quienLiga({ rol: 'CASHIER', personalizado: { deniedPermissions: SIN_COBRAR } })
    await quitar()
    expect(prismaMock.orderCustomer.update).not.toHaveBeenCalled()
  })

  it('🔴 si el permiso no se puede resolver: falla CERRADO (quita, sin promover)', async () => {
    quienLiga({ rol: 'CASHIER' })
    prismaMock.venueRolePermission.findUnique.mockRejectedValue(new Error('P1001'))
    const { status } = await quitar()
    expect(status).toBe(200)
    expect(prismaMock.orderCustomer.update).not.toHaveBeenCalled()
  })

  it('regresión: cuenta ABIERTA y KITCHEN: promueve como siempre', async () => {
    quienLiga({ rol: 'KITCHEN' })
    prismaMock.order.findFirst.mockResolvedValue({ paymentStatus: 'PENDING' } as any)
    await quitar()
    expect(prismaMock.orderCustomer.update).toHaveBeenCalledWith({ where: { id: 'oc-C' }, data: { isPrimary: true } })
  })
})

/**
 * 🔴 R3-4 (ronda 3): editar los datos del invitado en una venta cobrada no fija `Order.customerId` sin `payments:create`. Como
 * hoy, el controller NO reenvía el `customerId` del body (la TPV lo manda; la ruta nunca lo escribió): el candado del servicio
 * protege a cualquier otro llamador.
 *
 * R4-3 (ronda 4, minor del revisor): el controller ya NO resuelve `payments:create` en cada edición — nunca reenvía
 * `customerId`, así que la respuesta no decidía nada y costaba una consulta de permisos por edición. La guarda del servicio
 * queda con su default CERRADO (sin la opción, no fija el cliente en una venta cobrada).
 */
describe('🔴 R3-4: TPV PATCH orders/:orderId/guest — Order.customerId en una venta cobrada exige payments:create', () => {
  let espia: jest.SpyInstance
  beforeEach(() => {
    espia = jest.spyOn(orderTpvService, 'updateGuestInfo')
    prismaMock.order.findUnique.mockResolvedValue({ id: ORDER, orderNumber: 'ORD-1', paymentStatus: 'PAID' } as any)
    prismaMock.order.update.mockResolvedValue({
      id: ORDER,
      orderNumber: 'ORD-1',
      tableId: null,
      items: [],
      payments: [],
      table: null,
    } as any)
  })
  afterEach(() => espia.mockRestore())

  async function editar() {
    const r = res()
    const next = jest.fn()
    const q = { ...req({ customerName: 'Kev', customerId: 'cust-K' }), method: 'PATCH' }
    await updateGuestInfo(q as unknown as Request<any>, r, next as unknown as NextFunction)
    return { status: r.status.mock.calls[0]?.[0], next }
  }

  it.each([['KITCHEN'], ['CASHIER']])(
    '🔴 R4-3 %s: el controller NO consulta permisos; el servicio queda con su default cerrado y Order.customerId NO se toca',
    async rol => {
      quienLiga({ rol })
      const { status, next } = await editar()
      expect(next).not.toHaveBeenCalled()
      expect(status).toBe(200)
      // Sin opciones (default cerrado) y, como hoy, sin reenviar el customerId del body.
      expect(espia).toHaveBeenCalledWith(VENUE, ORDER, expect.not.objectContaining({ customerId: expect.anything() }))
      expect(espia.mock.calls[0]).toHaveLength(3)
      expect(prismaMock.staffVenue.findUnique).not.toHaveBeenCalled()
      expect(prismaMock.venueRolePermission.findUnique).not.toHaveBeenCalled()
      expect((prismaMock.order.update.mock.calls[0] as any)[0].data).toEqual({ customerName: 'Kev' })
    },
  )
})
