/**
 * La «devolución sin venta» y el candado «primer-sobre» (spec 2026-10-30-saldo-a-favor §5.5, tarea S6; Codex plan r1 h10, r2 h4/h5, r3 h2).
 *
 * El rechazo de afuera (`refund.mobile.service.ts`, antes de la transacción) es sólo una salida rápida: una devolución puede empezar sin
 * sobres y, mientras tanto, otra caja da el primer saldo a favor. Por eso la transacción toma el candado como su PRIMERA sentencia (antes
 * del turno, de Orders y de Payments) y repite la comprobación ya con él. Aquí se prueba el ORDEN y la repetición con mocks; que de verdad
 * se serialicen contra un saldo que se escribe a la vez lo prueba la integración
 * (`tests/integration/storeCredit/devolucionSinVentaCandado.integration.test.ts`).
 */
import { createRefund } from '@/services/mobile/refund.mobile.service'
import { tomarCandadoPrimerSobreEnTx } from '@/services/storeCredit/primerSobreLock'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/storeCredit/primerSobreLock', () => ({
  tomarCandadoPrimerSobreEnTx: jest.fn(),
  tomarCandadoPrimerSobreSiHaceFaltaEnTx: jest.fn(),
}))

const VENUE = 'venue-1'
const STAFF = 'staff-1'
const DONDE_SE_ACTIVO = { where: { venueId: VENUE, activatedAt: { not: null } }, select: { id: true } }

/** Lo que va pasando, en el orden en que pasa: ahí se ve que el candado sea lo PRIMERO de la transacción. */
let orden: string[]

describe('createRefund (móvil) — el candado «primer-sobre» de la devolución sin venta', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    orden = []
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    }
    ;(prismaMock as any).cashDrawerEvent = { create: jest.fn(), createMany: jest.fn().mockResolvedValue({ count: 1 }) }
    prismaMock.order.create.mockImplementation((async () => {
      orden.push('order.create')
      return { id: 'order-ref-1', orderNumber: 'REF-1' }
    }) as any)
    prismaMock.payment.create.mockImplementation(async (args: any) => ({
      id: 'payment-ref-1',
      createdAt: new Date('2026-10-31T12:00:00.000Z'),
      ...args.data,
    }))
    prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' } as any)
    prismaMock.activityLog.create.mockResolvedValue({ id: 'audit-1' } as any)
    prismaMock.staff = { findUnique: jest.fn().mockResolvedValue(null) } as any
    prismaMock.shift.updateMany.mockResolvedValue({ count: 1 } as any)
    // mockReset (no sólo clear): una cola de «una vez» que sobra de otra prueba no debe contaminar a la siguiente.
    prismaMock.shift.findFirst.mockReset()
    prismaMock.giftCard.findFirst.mockReset()
    prismaMock.shift.findFirst.mockImplementation((async () => {
      orden.push('turno')
      return null
    }) as any)
    prismaMock.giftCard.findFirst.mockImplementation((async () => {
      orden.push('comprueba')
      return null
    }) as any)
    ;(tomarCandadoPrimerSobreEnTx as jest.Mock).mockImplementation(async () => {
      orden.push('candado')
    })
  })

  const devolver = () => createRefund({ venueId: VENUE, amount: 5000, reason: 'Producto defectuoso', method: 'CASH', staffId: STAFF })

  it('con un sobre ya activado se rechaza GIFT_CARD_UNLINKED_REFUND_BLOCKED y no se escribe nada', async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue({ id: 'sobre-1' } as any)

    await expect(devolver()).rejects.toMatchObject({
      code: 'GIFT_CARD_UNLINKED_REFUND_BLOCKED',
      statusCode: 409,
      // S10 (minor 3): también explica bien la causa en un negocio que sólo dio saldo a favor (no vende tarjetas).
      message:
        'En un negocio con tarjetas de regalo o saldo a favor, la devolución se hace desde su venta, para que ese saldo nunca se devuelva en efectivo.',
    })

    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.venueTransaction.create).not.toHaveBeenCalled()
  })

  it('la comprobación se repite dentro de la transacción después del candado', async () => {
    // Afuera todavía no hay ninguno (otra caja está dando el primer saldo); ya con el candado, sí.
    prismaMock.giftCard.findFirst
      .mockImplementationOnce((async () => {
        orden.push('comprueba-afuera')
        return null
      }) as any)
      .mockImplementationOnce((async () => {
        orden.push('comprueba-adentro')
        return { id: 'sobre-recien-activado' }
      }) as any)

    await expect(devolver()).rejects.toMatchObject({ code: 'GIFT_CARD_UNLINKED_REFUND_BLOCKED', statusCode: 409 })

    // El candado es lo PRIMERO de la transacción: antes de la comprobación de adentro, del turno y de cualquier escritura.
    expect(orden).toEqual(['comprueba-afuera', 'candado', 'comprueba-adentro'])
    expect(tomarCandadoPrimerSobreEnTx).toHaveBeenCalledTimes(1)
    expect(tomarCandadoPrimerSobreEnTx).toHaveBeenCalledWith(prismaMock, VENUE)
    expect(prismaMock.giftCard.findFirst).toHaveBeenCalledTimes(2)
    expect(prismaMock.giftCard.findFirst).toHaveBeenNthCalledWith(2, DONDE_SE_ACTIVO)
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.venueTransaction.create).not.toHaveBeenCalled()
  })

  it('sin sobres activados la devolución sigue su camino: candado, comprobación de adentro, y sólo después el turno y las escrituras', async () => {
    await expect(devolver()).resolves.toMatchObject({ refundId: 'payment-ref-1', amount: 5000 })

    expect(orden).toEqual(['comprueba', 'candado', 'comprueba', 'turno', 'order.create'])
  })

  describe('sin turno también toma el candado (las ramas que no frena el turno)', () => {
    it.each([
      ['NO_SHIFT', null],
      ['SHIFT_NOT_OPEN', { id: 'turno-cerrando', status: 'CLOSING' }],
    ])('%s: el candado va antes que la búsqueda del turno, y la devolución se rechaza si adentro ya hay un sobre', async (_rama, turno) => {
      prismaMock.shift.findFirst.mockImplementation((async () => {
        orden.push('turno')
        return turno
      }) as any)
      prismaMock.giftCard.findFirst
        .mockImplementationOnce((async () => {
          orden.push('comprueba-afuera')
          return null
        }) as any)
        .mockImplementationOnce((async () => {
          orden.push('comprueba-adentro')
          return { id: 'sobre-recien-activado' }
        }) as any)

      await expect(devolver()).rejects.toMatchObject({ code: 'GIFT_CARD_UNLINKED_REFUND_BLOCKED' })

      // Rechazada en la comprobación de adentro: ni siquiera llega a buscar el turno.
      expect(orden).toEqual(['comprueba-afuera', 'candado', 'comprueba-adentro'])
      expect(prismaMock.order.create).not.toHaveBeenCalled()
    })

    it.each([
      ['NO_SHIFT', null],
      ['SHIFT_NOT_OPEN', { id: 'turno-cerrando', status: 'CLOSING' }],
    ])('%s: sin sobres la devolución se hace igual, con el candado tomado antes del turno', async (_rama, turno) => {
      prismaMock.shift.findFirst.mockImplementation((async () => {
        orden.push('turno')
        return turno
      }) as any)

      await expect(devolver()).resolves.toMatchObject({ refundId: 'payment-ref-1' })

      expect(orden.indexOf('candado')).toBeGreaterThanOrEqual(0)
      expect(orden.indexOf('candado')).toBeLessThan(orden.indexOf('turno'))
      expect(orden.indexOf('candado')).toBeLessThan(orden.indexOf('order.create'))
      expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    })
  })
})
