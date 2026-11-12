/**
 * Descuento del cliente (fase 1): la venta LEE la autorización del PIN (`descuento-cliente:<customerId>:<discountId>`) sin
 * gastarla, para guardar al gerente en `OrderDiscount.authorizedById`. Nunca hace fallar la venta: lo que no sirve es `null`.
 */
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import {
  autorizadorDelDescuentoDelCliente,
  leerAutorizacionDelDescuentoConTope,
} from '@/services/mobile/permission-override.mobile.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { permissionOverride: { findFirst: jest.fn(), updateMany: jest.fn(), update: jest.fn() } },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const findFirst = prisma.permissionOverride.findFirst as jest.Mock
const AHORA = new Date('2026-11-11T18:00:00.000Z')
const leer = (o: Record<string, any> = {}) =>
  autorizadorDelDescuentoDelCliente({ venueId: 'venue-1', token: 'tok-1', customerId: 'cust-1', discountId: 'disc-1', ahora: AHORA, ...o })

beforeEach(() => jest.clearAllMocks())

describe('autorizadorDelDescuentoDelCliente', () => {
  it('token válido ⇒ el gerente, buscando por token, negocio, permiso, llave y vigencia; sin gastarlo', async () => {
    findFirst.mockResolvedValue({ authorizedById: 'sv-gerente' })

    await expect(leer()).resolves.toBe('sv-gerente')
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        token: 'tok-1',
        venueId: 'venue-1',
        permission: 'discounts:apply',
        operationKey: 'descuento-cliente:cust-1:disc-1',
        expiresAt: { gt: AHORA },
      },
      select: { authorizedById: true },
    })
    expect(prisma.permissionOverride.updateMany).not.toHaveBeenCalled()
    expect(prisma.permissionOverride.update).not.toHaveBeenCalled()
  })

  it.each([null, undefined, '', '   '])('token %p ⇒ null sin consultar ni avisar', async token => {
    await expect(leer({ token })).resolves.toBeNull()
    expect(findFirst).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('sin cliente ⇒ null sin consultar, con aviso (vino token y no sirvió)', async () => {
    await expect(leer({ customerId: null })).resolves.toBeNull()
    expect(findFirst).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('llave distinta (no hay fila que cuadre) ⇒ null con aviso', async () => {
    findFirst.mockResolvedValue(null)
    await expect(leer({ discountId: 'disc-2' })).resolves.toBeNull()
    expect(findFirst.mock.calls[0][0].where.operationKey).toBe('descuento-cliente:cust-1:disc-2')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('si la base falla ⇒ null (la venta nunca se cae por la autorización)', async () => {
    findFirst.mockRejectedValue(new Error('se cayó la base'))
    await expect(leer()).resolves.toBeNull()
  })
})

describe('leerAutorizacionDelDescuentoConTope', () => {
  const leerTope = (o: { token?: string; customerId?: string; discountId?: string } = {}) =>
    leerAutorizacionDelDescuentoConTope(
      'venue-1',
      'token' in o ? o.token : 'tok-1',
      o.customerId ?? 'cust-1',
      o.discountId ?? 'disc-1',
      AHORA,
    )

  it('llave con tope ⇒ gerente y tope; busca por token, negocio, permiso, prefijo y vigencia; sin gastar', async () => {
    findFirst.mockResolvedValue({ authorizedById: 'sv-gerente', operationKey: 'descuento-cliente:cust-1:disc-1:1000' })
    await expect(leerTope()).resolves.toEqual({ autorizadoPor: 'sv-gerente', topeCents: 1000 })
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        token: 'tok-1',
        venueId: 'venue-1',
        permission: 'discounts:apply',
        operationKey: { startsWith: 'descuento-cliente:cust-1:disc-1:' },
        expiresAt: { gt: AHORA },
      },
      select: { authorizedById: true, operationKey: true },
    })
    await leerTope() // leer dos veces
    expect(prisma.permissionOverride.updateMany).not.toHaveBeenCalled()
    expect(prisma.permissionOverride.update).not.toHaveBeenCalled()
  })

  it('tope 0 es válido', async () => {
    findFirst.mockResolvedValue({ authorizedById: 'sv-g', operationKey: 'descuento-cliente:cust-1:disc-1:0' })
    await expect(leerTope()).resolves.toEqual({ autorizadoPor: 'sv-g', topeCents: 0 })
  })

  it('sin fila (otro cliente, descuento, negocio, vencido u otro permiso) ⇒ null', async () => {
    findFirst.mockResolvedValue(null)
    await expect(leerTope({ customerId: 'cust-2' })).resolves.toBeNull()
  })

  it.each([
    'descuento-cliente:cust-1:disc-1:',
    'descuento-cliente:cust-1:disc-1:abc',
    'descuento-cliente:cust-1:disc-1:-5',
    'descuento-cliente:cust-1:disc-1:1.5',
  ])('llave %s ⇒ null', async operationKey => {
    findFirst.mockResolvedValue({ authorizedById: 'sv-g', operationKey })
    await expect(leerTope()).resolves.toBeNull()
  })

  it('la llave de la fase 1 (sin sufijo) no acredita tope ⇒ null', async () => {
    // el prefijo con ":" final no la encuentra en la base; si un mock la devolviera, tampoco tiene sufijo
    findFirst.mockResolvedValue({ authorizedById: 'sv-g', operationKey: 'descuento-cliente:cust-1:disc-1' })
    await expect(leerTope()).resolves.toBeNull()
  })

  it.each([undefined, '', '  '])('token %p ⇒ null sin consultar', async token => {
    await expect(leerTope({ token })).resolves.toBeNull()
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('regresión TPV: el lector viejo sigue buscando la llave EXACTA sin sufijo', async () => {
    findFirst.mockResolvedValue(null)
    await leer()
    expect(findFirst.mock.calls[0][0].where.operationKey).toBe('descuento-cliente:cust-1:disc-1')
  })
})
