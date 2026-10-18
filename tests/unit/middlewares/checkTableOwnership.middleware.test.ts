/**
 * checkTableOwnership Middleware Tests
 *
 * Propiedad de mesa ("Solo el propietario puede modificar sus mesas"):
 * 1. Switch apagado → no-op
 * 2. Dueño de la orden → pasa
 * 3. Otro mesero sin override → 403 TABLE_OWNED_BY_OTHER
 * 4. Override con 'tables:manage-all' → pasa
 * 5. Venta de mostrador (sin mesa) → la regla no aplica
 * 6. source='table': mesa libre pasa; mesa ocupada por otro se bloquea
 */

import { Request, Response, NextFunction } from 'express'
import { checkTableOwnership } from '@/middlewares/checkTableOwnership.middleware'
import * as permissionsLib from '@/lib/permissions'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    // La persona existe y está ACTIVA (H2: sin eso el resolutor niega). Función normal: sobrevive a los reset de mocks.
    staff: { findUnique: async () => ({ active: true }) },
    venueSettings: { findUnique: jest.fn() },
    order: { findFirst: jest.fn(), findMany: jest.fn() },
    staffVenue: { findFirst: jest.fn(), findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
    // Con una fila menor que OWNER, el resolutor pregunta en UNA consulta si es dueña de la org del venue (P2-6).
    staffOrganization: { findUnique: jest.fn(), findFirst: jest.fn(async () => null) },
    venueRolePermission: { findUnique: jest.fn() },
  },
}))

jest.mock('@/lib/permissions', () => ({
  hasPermission: jest.fn(),
  evaluatePermissionList: jest.fn(),
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const JUAN = 'staff-juan'
const ALBERTO = 'staff-alberto'
const VENUE = 'venue-1'

describe('checkTableOwnership Middleware', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const setEnforced = (on: boolean) =>
    (prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue(
      on ? { enforceTableOwnership: true } : { enforceTableOwnership: false },
    )

  /** La orden de mesa 1 es de Juan. */
  const setOrderOwnedByJuan = () =>
    (prisma.order.findFirst as jest.Mock).mockResolvedValue({
      tableId: 'table-1',
      servedById: JUAN,
      servedBy: { firstName: 'Juan', lastName: 'Pérez' },
    })

  /** Rol WAITER sin permission set ni custom permissions para el caller. */
  const setCallerRoleWaiter = (canManageAll: boolean) => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(null) // no SUPERADMIN
    ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue({
      role: 'WAITER',
      active: true,
      permissionSetId: null,
      permissionSet: null,
    })
    ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue(null)
    ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(canManageAll)
  }

  beforeEach(() => {
    jest.clearAllMocks()
    jsonMock = jest.fn()
    statusMock = jest.fn().mockReturnValue({ json: jsonMock })
    mockRes = { status: statusMock as any }
    mockNext = jest.fn()
    mockReq = {
      params: { venueId: VENUE, orderId: 'order-1' },
    }
    ;(mockReq as any).authContext = { userId: ALBERTO, venueId: VENUE, role: 'WAITER' }
  })

  it('switch apagado → next() sin consultar la orden', async () => {
    setEnforced(false)
    await checkTableOwnership('order')(mockReq as Request, mockRes as Response, mockNext)
    expect(mockNext).toHaveBeenCalled()
    expect(prisma.order.findFirst).not.toHaveBeenCalled()
  })

  it('el dueño de la orden pasa', async () => {
    setEnforced(true)
    setOrderOwnedByJuan()
    ;(mockReq as any).authContext.userId = JUAN
    await checkTableOwnership('order')(mockReq as Request, mockRes as Response, mockNext)
    expect(mockNext).toHaveBeenCalled()
    expect(statusMock).not.toHaveBeenCalled()
  })

  it('otro mesero sin override → 403 TABLE_OWNED_BY_OTHER con nombre del dueño', async () => {
    setEnforced(true)
    setOrderOwnedByJuan()
    setCallerRoleWaiter(false)
    await checkTableOwnership('order')(mockReq as Request, mockRes as Response, mockNext)
    expect(mockNext).not.toHaveBeenCalled()
    expect(statusMock).toHaveBeenCalledWith(403)
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'TABLE_OWNED_BY_OTHER',
        ownerId: JUAN,
        ownerName: 'Juan Pérez',
        message: expect.stringContaining('Juan Pérez'),
      }),
    )
  })

  it("override con 'tables:manage-all' pasa", async () => {
    setEnforced(true)
    setOrderOwnedByJuan()
    setCallerRoleWaiter(true)
    await checkTableOwnership('order')(mockReq as Request, mockRes as Response, mockNext)
    expect(permissionsLib.hasPermission).toHaveBeenCalledWith('WAITER', null, 'tables:manage-all', null)
    expect(mockNext).toHaveBeenCalled()
  })

  it('venta de mostrador (orden sin mesa) → la regla no aplica', async () => {
    setEnforced(true)
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({
      tableId: null,
      servedById: JUAN,
      servedBy: { firstName: 'Juan', lastName: 'Pérez' },
    })
    await checkTableOwnership('order')(mockReq as Request, mockRes as Response, mockNext)
    expect(mockNext).toHaveBeenCalled()
  })

  it("source='table': mesa libre (sin órdenes abiertas) pasa", async () => {
    setEnforced(true)
    mockReq.params = { venueId: VENUE, tableId: 'table-1' }
    ;(prisma.order.findMany as jest.Mock).mockResolvedValue([])
    await checkTableOwnership('table')(mockReq as Request, mockRes as Response, mockNext)
    expect(mockNext).toHaveBeenCalled()
  })

  it("source='table': mesa ocupada por otro sin override → 403", async () => {
    setEnforced(true)
    mockReq.params = { venueId: VENUE, tableId: 'table-1' }
    ;(prisma.order.findMany as jest.Mock).mockResolvedValue([{ servedById: JUAN, servedBy: { firstName: 'Juan', lastName: 'Pérez' } }])
    setCallerRoleWaiter(false)
    await checkTableOwnership('table')(mockReq as Request, mockRes as Response, mockNext)
    expect(statusMock).toHaveBeenCalledWith(403)
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ code: 'TABLE_OWNED_BY_OTHER' }))
  })

  it('orden sin dueño registrado (servedById null) → pasa', async () => {
    setEnforced(true)
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({
      tableId: 'table-1',
      servedById: null,
      servedBy: null,
    })
    await checkTableOwnership('order')(mockReq as Request, mockRes as Response, mockNext)
    expect(mockNext).toHaveBeenCalled()
  })

  /**
   * 🔴 R2-6 (founder 3-oct: el dinero capturado nunca se rechaza ni se pierde). La propiedad de mesa decide quién INICIA un cobro, no
   * quién REGISTRA dinero ya capturado: Ana cobró $100 sin red, un encargado pasó la mesa a Juan, y al volver la red la cola de Ana
   * (`isOfflineReplay`) recibía 403 con el dinero ya en el cajón. Sólo la ruta de cobro lo pide (`dineroCapturado`).
   */
  describe('R2-6: dinero ya capturado en una mesa ajena', () => {
    const conLocals = () => {
      ;(mockRes as any).locals = {}
      return mockRes as Response
    }

    it('🔴 cola sin red (isOfflineReplay) en la ruta de cobro ⇒ pasa y deja la mesa ajena para el rastro', async () => {
      setEnforced(true)
      setOrderOwnedByJuan()
      setCallerRoleWaiter(false)
      mockReq.body = { isOfflineReplay: true }
      const res = conLocals()
      await checkTableOwnership('order', ['tables:manage-all', 'tables:pay-any'], { dineroCapturado: true })(
        mockReq as Request,
        res,
        mockNext,
      )
      expect(mockNext).toHaveBeenCalled()
      expect(statusMock).not.toHaveBeenCalled()
      expect((res as any).locals.mesaAjena).toEqual({ ownerId: JUAN, ownerName: 'Juan Pérez' })
    })

    it('el cobro EN VIVO en la ruta de cobro sigue con 403', async () => {
      setEnforced(true)
      setOrderOwnedByJuan()
      setCallerRoleWaiter(false)
      mockReq.body = { amount: 10000 }
      await checkTableOwnership('order', ['tables:manage-all', 'tables:pay-any'], { dineroCapturado: true })(
        mockReq as Request,
        conLocals(),
        mockNext,
      )
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('🔴 una ruta que EDITA la mesa no se exime aunque el cuerpo diga isOfflineReplay', async () => {
      setEnforced(true)
      setOrderOwnedByJuan()
      setCallerRoleWaiter(false)
      mockReq.body = { isOfflineReplay: true }
      await checkTableOwnership('order')(mockReq as Request, conLocals(), mockNext)
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(mockNext).not.toHaveBeenCalled()
    })
  })
})
