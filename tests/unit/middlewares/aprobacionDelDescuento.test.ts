/**
 * D4 (hz:f34960c5:D4): un % o fijo de catálogo con «Requiere aprobación» lo aplica quien tiene `tpv-orders:discount` o un gerente
 * con su PIN (`checkPermission`, que consume `X-Permission-Override` o contesta el 403 `overridable`). El middleware sólo acredita
 * ESTE request; el servicio vuelve a mirar bajo su candado.
 */
import type { NextFunction, Request, Response } from 'express'
import { aprobacionDelDescuento, checkAprobacionDelDescuento } from '@/middlewares/cortesiaPidePermiso.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import prisma from '@/utils/prismaClient'

let mockPermissionResult: 'granted' | 'denied' = 'granted'
let mockPinConsumido: string | undefined

jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: jest.fn(() => (req: Request, res: Response, next: NextFunction) => {
    if (mockPermissionResult === 'denied') return res.status(403).json({ error: 'Forbidden', overridable: true })
    if (mockPinConsumido) (req as any).authContext.overrideAuthorizedBy = mockPinConsumido
    return next()
  }),
}))
jest.mock('@/middlewares/permissionFlag.middleware', () => ({ tienePermisoEnVenue: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { discount: { findFirst: jest.fn() }, order: { findUnique: jest.fn() } },
}))

const findDiscount = prisma.discount.findFirst as jest.Mock
const findOrder = prisma.order.findUnique as jest.Mock
const permisoPropio = tienePermisoEnVenue as jest.Mock

function request(body: Record<string, unknown>, params: Record<string, string> = {}): Request {
  return { params: { venueId: 'venue-1', ...params }, authContext: { userId: 'cajera-1' }, body } as unknown as Request
}

async function run(req: Request) {
  const res: any = { statusCode: null }
  res.status = jest.fn((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn(() => res)
  const next = jest.fn()
  await checkAprobacionDelDescuento(req, res, next)
  return { res, next }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPermissionResult = 'granted'
  mockPinConsumido = undefined
  findDiscount.mockResolvedValue(null)
  findOrder.mockResolvedValue(null)
  permisoPropio.mockResolvedValue(false)
})

describe('D4: % o fijo con «Requiere aprobación» pide tpv-orders:discount', () => {
  it('Mesas (discountId) que pide aprobación: pide el permiso y acredita el request', async () => {
    findDiscount.mockResolvedValue({ id: 'disc-gerente' })
    const req = request({ discountId: 'disc-gerente' })
    const { next } = await run(req)
    expect(findDiscount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: 'venue-1',
          requiresApproval: true,
          type: { not: 'COMP' },
          OR: [{ id: { in: ['disc-gerente'] } }],
        }),
      }),
    )
    expect(checkPermission).toHaveBeenCalledWith('tpv-orders:discount')
    expect(next).toHaveBeenCalledWith()
    expect(aprobacionDelDescuento(req)).toEqual({})
  })

  it('el PIN que consumió ESTE check queda como aprobador', async () => {
    findDiscount.mockResolvedValue({ id: 'disc-gerente' })
    mockPinConsumido = 'sv-gerente'
    const req = request({ discountId: 'disc-gerente' })
    await run(req)
    expect(aprobacionDelDescuento(req)).toEqual({ porPin: 'sv-gerente' })
  })

  it('un PIN previo de otro permiso no se registra como aprobador', async () => {
    findDiscount.mockResolvedValue({ id: 'disc-gerente' })
    const req = request({ discountId: 'disc-gerente' })
    ;(req as any).authContext.overrideAuthorizedBy = 'sv-gerente-de-cortesias'
    await run(req)
    expect(aprobacionDelDescuento(req)).toEqual({})
  })

  it('Codex r2 #3: el MISMO gerente que ya autorizó otra cosa del request (cortesía) también queda como aprobador', async () => {
    findDiscount.mockResolvedValue({ id: 'disc-gerente' })
    mockPinConsumido = 'sv-gerente'
    const req = request({ discountId: 'disc-gerente' })
    ;(req as any).authContext.overrideAuthorizedBy = 'sv-gerente'
    await run(req)
    expect(aprobacionDelDescuento(req)).toEqual({ porPin: 'sv-gerente' })
  })

  it('sin PIN propio, el autorizador de antes se conserva para quien lo lea después', async () => {
    findDiscount.mockResolvedValue({ id: 'disc-gerente' })
    const req = request({ discountId: 'disc-gerente' })
    ;(req as any).authContext.overrideAuthorizedBy = 'sv-gerente-de-cortesias'
    await run(req)
    expect((req as any).authContext.overrideAuthorizedBy).toBe('sv-gerente-de-cortesias')
  })

  it('sin el permiso: 403 de checkPermission, no sigue ni acredita', async () => {
    findDiscount.mockResolvedValue({ id: 'disc-gerente' })
    mockPermissionResult = 'denied'
    const req = request({ discountId: 'disc-gerente' })
    const { res, next } = await run(req)
    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
    expect(aprobacionDelDescuento(req)).toBeUndefined()
  })

  it('venta de Mostrador: mira el de cuenta, los de renglón y el cupón en línea en UNA consulta', async () => {
    findDiscount.mockResolvedValue({ id: 'disc-gerente' })
    const req = request({
      orderDiscountId: 'disc-cuenta',
      couponCode: ' gerente10 ',
      items: [
        { productId: 'p1', discountId: 'disc-renglon' },
        { productId: 'p2', discountId: 'disc-cuenta' },
      ],
    })
    await run(req)
    expect(findDiscount).toHaveBeenCalledTimes(1)
    expect(findDiscount.mock.calls[0][0].where.OR).toEqual([
      { id: { in: ['disc-cuenta', 'disc-renglon'] } },
      { couponCodes: { some: { code: 'GERENTE10' } } },
    ])
    expect(checkPermission).toHaveBeenCalledWith('tpv-orders:discount')
  })

  it('en una venta de la cola el cupón se ignora (como el servicio): sólo los ids', async () => {
    const req = request({ isOfflineReplay: true, couponCode: 'GERENTE10', items: [{ productId: 'p1', discountId: 'disc-renglon' }] })
    await run(req)
    expect(findDiscount.mock.calls[0][0].where.OR).toEqual([{ id: { in: ['disc-renglon'] } }])
  })

  it('la venta ya existe con esa llave (reintento tras respuesta perdida): no pide nada, el servicio devuelve la que ya está', async () => {
    findDiscount.mockResolvedValue({ id: 'disc-gerente' })
    findOrder.mockResolvedValue({ id: 'order-1' })
    mockPermissionResult = 'denied'
    const req = request({ externalId: ' venta-1 ', isOfflineReplay: true, items: [{ productId: 'p1', discountId: 'disc-gerente' }] })
    const { next } = await run(req)
    expect(findOrder).toHaveBeenCalledWith({
      where: { venueId_externalId: { venueId: 'venue-1', externalId: 'venta-1' } },
      select: { id: true },
    })
    expect(checkPermission).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith()
    expect(aprobacionDelDescuento(req)).toBeUndefined()
  })

  it('la base falla: error (500), nunca 403 ni «tiene permiso»', async () => {
    findDiscount.mockRejectedValue(new Error('P1001'))
    const req = request({ discountId: 'disc-gerente' })
    const { res, next } = await run(req)
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(res.statusCode).toBeNull()
    expect(checkPermission).not.toHaveBeenCalled()
  })

  // Regresión: lo que no pide aprobación sigue exactamente igual.
  it('un % sin «Requiere aprobación» (o una COMP): no pide nada ni acredita', async () => {
    const req = request({ discountId: 'disc-10' })
    const { next } = await run(req)
    expect(checkPermission).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith()
    expect(aprobacionDelDescuento(req)).toBeUndefined()
  })

  it('una venta sin descuentos de catálogo ni cupón no consulta la base', async () => {
    const { next } = await run(request({ items: [{ productId: 'p1' }], discount: 500 }))
    expect(findDiscount).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith()
  })

  it('la acreditación es del request, la sesión y el negocio: otra sesión no la hereda', async () => {
    findDiscount.mockResolvedValue({ id: 'disc-gerente' })
    const req = request({ discountId: 'disc-gerente' })
    await run(req)
    ;(req as any).authContext.userId = 'otra-sesion'
    expect(aprobacionDelDescuento(req)).toBeUndefined()
  })

  // D4 r5 (Codex, apps viejas antes de publicar): la venta de la cola YA se cobró. Rechazarla dejaba el efectivo sin venta.
  describe('venta de la cola (isOfflineReplay): nunca se rechaza por esto (como el cupón, D5)', () => {
    const deLaCola = () => request({ isOfflineReplay: true, items: [{ productId: 'p1', discountId: 'disc-gerente' }] })

    it('sin el permiso: no pide nada, no contesta 403 ni acredita (el servicio la registra sin aprobador)', async () => {
      findDiscount.mockResolvedValue({ id: 'disc-gerente' })
      mockPermissionResult = 'denied'
      const req = deLaCola()
      const { res, next } = await run(req)
      expect(checkPermission).not.toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledWith()
      expect(aprobacionDelDescuento(req)).toBeUndefined()
    })

    it('con el permiso propio de la sesión: queda aprobada sin PIN', async () => {
      findDiscount.mockResolvedValue({ id: 'disc-gerente' })
      permisoPropio.mockResolvedValue(true)
      const req = deLaCola()
      const { next } = await run(req)
      expect(permisoPropio).toHaveBeenCalledWith(req, 'tpv-orders:discount')
      expect(checkPermission).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledWith()
      expect(aprobacionDelDescuento(req)).toEqual({})
    })

    it('regresión: en Mesas (`:orderId`, sin dinero cobrado) `isOfflineReplay` no cambia nada: sigue el 403 con PIN', async () => {
      findDiscount.mockResolvedValue({ id: 'disc-gerente' })
      mockPermissionResult = 'denied'
      const { res, next } = await run(request({ isOfflineReplay: true, discountId: 'disc-gerente' }, { orderId: 'order-1' }))
      expect(res.statusCode).toBe(403)
      expect(next).not.toHaveBeenCalled()
      expect(permisoPropio).not.toHaveBeenCalled()
    })
  })
})
