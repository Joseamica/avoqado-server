/**
 * Lealtad al quedar PAGADA una orden — UNA regla, compartida por todos los canales.
 *
 * Nació de un defecto real (2026-09-01, Testarudo Cafe): el sello de la tarjeta
 * digital sólo subía cuando la orden se cobraba en la PAX. El MISMO café pagado en
 * efectivo desde el Sunmi (`payCashOrder`) no daba sello ni puntos, porque ese
 * camino nunca llamó a `earnPoints`. La regla vivía copiada dentro de
 * `payment.tpv.service.ts` y nadie más la tenía.
 *
 * Contrato que fijan estas pruebas:
 *   · métricas de visita para TODOS los clientes de la orden;
 *   · puntos/sellos SÓLO para el primario (o el `customerId` heredado si no hay
 *     `OrderCustomer`);
 *   · `LoyaltyTransaction.createdById` es un StaffVenue.id, así que el Staff.id se
 *     traduce aquí y no en cada llamador;
 *   · NUNCA lanza: corre después de que el dinero ya entró.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { findFirst: jest.fn() },
    orderCustomer: { findMany: jest.fn() },
    order: { updateMany: jest.fn() },
  },
}))

jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({
  earnPoints: jest.fn(),
}))

jest.mock('@/services/dashboard/customer.dashboard.service', () => ({
  updateCustomerMetrics: jest.fn(),
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { Prisma } from '@prisma/client'
import { tablaDeUnaVenta, type FilaDeLealtad } from '@tests/__helpers__/ordenConMarcasDeLealtad'
import prisma from '@/utils/prismaClient'
import { earnPoints } from '@/services/dashboard/loyalty.dashboard.service'
import { updateCustomerMetrics } from '@/services/dashboard/customer.dashboard.service'
import { awardLoyaltyForPaidOrder } from '@/services/shared/loyaltyOnPaidOrder'

const staffVenueFindFirst = prisma.staffVenue.findFirst as jest.Mock
const orderCustomerFindMany = prisma.orderCustomer.findMany as jest.Mock
const orderUpdateMany = prisma.order.updateMany as jest.Mock
const earnPointsMock = earnPoints as jest.Mock
const metricsMock = updateCustomerMetrics as jest.Mock

const VENUE = 'venue-1'
const ORDER = 'order-1'
/** La marca de fila que deja la liga tardía al reabrir (`reabrirLealtadSiAplica`). Texto EXACTO del ruling. */
const MARCA = 'REABIERTA: cliente ligado después del cobro'

describe('awardLoyaltyForPaidOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    staffVenueFindFirst.mockResolvedValue({ id: 'sv-1' })
    earnPointsMock.mockResolvedValue({ pointsEarned: 0, newBalance: 0 })
    metricsMock.mockResolvedValue(undefined)
    orderUpdateMany.mockResolvedValue({ count: 1 })
  })

  it('métricas para TODOS los clientes de la orden, puntos SÓLO para el primario', async () => {
    orderCustomerFindMany.mockResolvedValue([
      { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: 'Ana', lastName: null } },
      { customerId: 'cust-B', isPrimary: false, customer: { id: 'cust-B', firstName: 'Beto', lastName: null } },
    ])

    await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90, staffId: 'staff-1' })

    expect(metricsMock).toHaveBeenCalledTimes(2)
    expect(metricsMock).toHaveBeenCalledWith('cust-A', 90, ORDER, VENUE)
    expect(metricsMock).toHaveBeenCalledWith('cust-B', 90, ORDER, VENUE)

    expect(earnPointsMock).toHaveBeenCalledTimes(1)
    expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-A', 90, ORDER, 'sv-1')
  })

  it('marks the paid order processed only after every loyalty step succeeds', async () => {
    orderCustomerFindMany.mockResolvedValue([
      { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: 'Ana', lastName: null } },
    ])

    const result = await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90 })

    expect(result).toEqual({ complete: true, errors: [] })
    expect(orderUpdateMany).toHaveBeenCalledWith({
      where: { id: ORDER, venueId: VENUE, loyaltyEligibleAt: { not: null }, loyaltyProcessedAt: null },
      data: { loyaltyProcessedAt: expect.any(Date), loyaltyProcessingAt: null, loyaltyLastError: null },
    })
  })

  it('el Staff.id se traduce a StaffVenue.id del MISMO venue — es lo que espera createdById', async () => {
    orderCustomerFindMany.mockResolvedValue([
      { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: null, lastName: null } },
    ])

    await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50, staffId: 'staff-1' })

    expect(staffVenueFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ staffId: 'staff-1', venueId: VENUE }) }),
    )
    expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-A', 50, ORDER, 'sv-1')
  })

  it('sin staff no se consulta StaffVenue y el sello sale sin autor', async () => {
    orderCustomerFindMany.mockResolvedValue([
      { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: null, lastName: null } },
    ])

    await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50 })

    expect(staffVenueFindFirst).not.toHaveBeenCalled()
    expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-A', 50, ORDER, undefined)
  })

  it('sin OrderCustomer cae al customerId heredado de la orden', async () => {
    orderCustomerFindMany.mockResolvedValue([])

    await awardLoyaltyForPaidOrder({
      venueId: VENUE,
      orderId: ORDER,
      orderTotal: 120,
      staffId: 'staff-1',
      legacyCustomer: { id: 'cust-L', firstName: 'Lucía', lastName: 'Ríos' },
    })

    expect(metricsMock).toHaveBeenCalledWith('cust-L', 120, ORDER, VENUE)
    expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-L', 120, ORDER, 'sv-1')
  })

  it('una orden sin cliente no toca lealtad ni métricas', async () => {
    orderCustomerFindMany.mockResolvedValue([])

    await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 120, staffId: 'staff-1', legacyCustomer: null })

    expect(metricsMock).not.toHaveBeenCalled()
    expect(earnPointsMock).not.toHaveBeenCalled()
  })

  it('🔴 NUNCA lanza: si earnPoints truena, el cobro (que ya entró) no se entera', async () => {
    orderCustomerFindMany.mockResolvedValue([
      { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: null, lastName: null } },
    ])
    earnPointsMock.mockRejectedValue(new Error('Loyalty program not enabled'))

    await expect(awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50, staffId: 'staff-1' })).resolves.toEqual(
      expect.objectContaining({ complete: false }),
    )
    expect(metricsMock).toHaveBeenCalledWith('cust-A', 50, ORDER, VENUE)
    expect(orderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: ORDER, loyaltyProcessedAt: null }),
        data: { loyaltyLastError: expect.stringContaining('loyalty:cust-A') },
      }),
    )
  })

  it('🔴 NUNCA lanza: si falla la consulta de clientes, tampoco', async () => {
    orderCustomerFindMany.mockRejectedValue(new Error('connection reset'))

    await expect(awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50, staffId: 'staff-1' })).resolves.toEqual(
      expect.objectContaining({ complete: false }),
    )
    expect(earnPointsMock).not.toHaveBeenCalled()
  })

  it('un fallo de métricas de un cliente no le quita el sello al primario', async () => {
    orderCustomerFindMany.mockResolvedValue([
      { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: null, lastName: null } },
    ])
    metricsMock.mockRejectedValue(new Error('deadlock'))

    await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50, staffId: 'staff-1' })

    expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-A', 50, ORDER, 'sv-1')
  })

  // ── H1 (auditoría de Codex del código, 15-oct-2026): el envoltorio de reembolsos es quien CIERRA ─────────────────────
  it('🔴 H1: con { cerrar: false } NO marca loyaltyProcessedAt y devuelve leyoSinCliente para cerrar con la misma guarda', async () => {
    orderCustomerFindMany.mockResolvedValue([
      { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: 'Ana', lastName: null } },
    ])
    expect(await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90 }, { cerrar: false })).toEqual({
      complete: true,
      errors: [],
      leyoSinCliente: false,
    })
    expect(orderUpdateMany).not.toHaveBeenCalled()

    orderCustomerFindMany.mockResolvedValue([])
    expect(
      await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90, legacyCustomer: null }, { cerrar: false }),
    ).toEqual({ complete: true, errors: [], leyoSinCliente: true })
    expect(orderUpdateMany).not.toHaveBeenCalled()
  })

  it('H1: con { cerrar: false } una corrida que FALLA sí deja su error (no es un cierre)', async () => {
    orderCustomerFindMany.mockResolvedValue([
      { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: 'Ana', lastName: null } },
    ])
    earnPointsMock.mockRejectedValue(new Error('P1001'))
    const r = await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90 }, { cerrar: false })
    expect(r.complete).toBe(false)
    expect(orderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { loyaltyLastError: expect.stringContaining('loyalty:cust-A') } }),
    )
  })

  /**
   * 🔴 B1 (auditoría de Codex, ronda B, 14-oct-2026). El cobro corre su lealtad en el instante; el barista liga al cliente
   * en «Cobro exitoso» y esa liga REABRE la lealtad en su transacción. Si la corrida del cobro ya había leído «sin cliente»
   * y cierra DESPUÉS de la reapertura, borra la recuperación: si además falla el intento de la liga, el reconciliador ya
   * no ve la venta y el sello se pierde otra vez, en silencio.
   */
  describe('🔴 B1: una corrida que leyó «sin cliente» no cierra la venta si mientras tanto se ligó un cliente', () => {
    /** La fila de la orden y un `updateMany` que SÍ evalúa la guarda de clientes. */
    function ordenConClientes() {
      const fila = { loyaltyProcessedAt: null as Date | null, clientes: 0 }
      orderUpdateMany.mockImplementation(async ({ where, data }: any) => {
        const sinClientes = where.orderCustomers?.none ? fila.clientes === 0 : true
        if (where.loyaltyProcessedAt !== null || fila.loyaltyProcessedAt !== null || !sinClientes) return { count: 0 }
        if ('loyaltyProcessedAt' in data) fila.loyaltyProcessedAt = data.loyaltyProcessedAt
        return { count: 1 }
      })
      return fila
    }

    it('lee «sin cliente» → se crea un OrderCustomer → intenta cerrar ⇒ loyaltyProcessedAt sigue null', async () => {
      const fila = ordenConClientes()
      orderCustomerFindMany.mockImplementation(async () => {
        fila.clientes = 1 // la liga tardía entra justo después de esta lectura
        return []
      })

      const result = await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90, legacyCustomer: null })

      expect(result).toEqual({ complete: true, errors: [] })
      expect(fila.loyaltyProcessedAt).toBeNull()
      expect(orderUpdateMany).toHaveBeenCalledWith({
        where: {
          id: ORDER,
          venueId: VENUE,
          loyaltyEligibleAt: { not: null },
          loyaltyProcessedAt: null,
          orderCustomers: { none: {} },
          OR: [{ loyaltyLastError: null }, { loyaltyLastError: { not: MARCA } }],
        },
        data: { loyaltyProcessedAt: expect.any(Date), loyaltyProcessingAt: null, loyaltyLastError: null },
      })
    })

    it('control: sin liga de por medio, la venta sin cliente se cierra como hoy', async () => {
      const fila = ordenConClientes()
      orderCustomerFindMany.mockResolvedValue([])

      await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90, legacyCustomer: null })

      expect(fila.loyaltyProcessedAt).toBeInstanceOf(Date)
    })

    it('la corrida que SÍ vio un cliente (el heredado) cierra sin la guarda, como hoy', async () => {
      orderCustomerFindMany.mockResolvedValue([])

      await awardLoyaltyForPaidOrder({
        venueId: VENUE,
        orderId: ORDER,
        orderTotal: 90,
        legacyCustomer: { id: 'cust-L', firstName: 'Lucía', lastName: null },
      })

      expect(orderUpdateMany).toHaveBeenCalledWith({
        where: { id: ORDER, venueId: VENUE, loyaltyEligibleAt: { not: null }, loyaltyProcessedAt: null },
        data: { loyaltyProcessedAt: expect.any(Date), loyaltyProcessingAt: null, loyaltyLastError: null },
      })
    })
  })

  /**
   * 🔴 Cruce EXACTO de B1 (medido por S3b contra Postgres, 14-oct): el cierre «sin cliente» llega mientras la transacción de
   * la liga tiene el candado de la fila de la orden. Al soltarse, Postgres (READ COMMITTED) relee SÓLO las columnas de la
   * fila; la subconsulta `orderCustomers none` sigue con su foto vieja y dice «sin clientes». Por eso la reapertura deja una
   * MARCA en `loyaltyLastError` y este cierre exige que no esté. Aquí el doble reproduce esa foto vieja con `clientes: 0`.
   */
  describe('🔴 marca de reapertura: el cierre «sin cliente» no cierra una venta que una liga reabrió', () => {
    function fila(over: Partial<FilaDeLealtad> = {}): FilaDeLealtad {
      return {
        id: ORDER,
        venueId: VENUE,
        total: new Prisma.Decimal(50),
        tipAmount: new Prisma.Decimal(0),
        loyaltyEligibleAt: new Date('2026-10-14T17:59:00.000Z'),
        loyaltyProcessedAt: null,
        loyaltyProcessingAt: null,
        loyaltyLastError: null,
        loyaltyAttempts: 0,
        loyaltyStaffId: null,
        customer: null,
        clientes: 0, // la foto vieja de la subconsulta: no ve el OrderCustomer que llegó después
        ...over,
      }
    }

    it('🔴 la fila trae la marca (la liga reabrió) y la subconsulta no ve al cliente ⇒ NO cierra: el reconciliador la ve', async () => {
      const venta = fila({ loyaltyLastError: MARCA })
      orderUpdateMany.mockImplementation(tablaDeUnaVenta(venta).updateMany)
      orderCustomerFindMany.mockResolvedValue([])

      const result = await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50, legacyCustomer: null })

      expect(result).toEqual({ complete: true, errors: [] })
      expect(venta.loyaltyProcessedAt).toBeNull()
      expect(venta.loyaltyLastError).toBe(MARCA)
    })

    it('regresión: venta de mostrador sin cliente y sin marca (null) se cierra como hoy', async () => {
      const venta = fila()
      orderUpdateMany.mockImplementation(tablaDeUnaVenta(venta).updateMany)
      orderCustomerFindMany.mockResolvedValue([])

      await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50, legacyCustomer: null })

      expect(venta.loyaltyProcessedAt).toBeInstanceOf(Date)
    })

    it('regresión: un error VIEJO de otra corrida (no la marca) no detiene el cierre de una venta sin cliente, y se limpia', async () => {
      const venta = fila({ loyaltyLastError: 'query:P1001' })
      orderUpdateMany.mockImplementation(tablaDeUnaVenta(venta).updateMany)
      orderCustomerFindMany.mockResolvedValue([])

      await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50, legacyCustomer: null })

      expect(venta.loyaltyProcessedAt).toBeInstanceOf(Date)
      expect(venta.loyaltyLastError).toBeNull()
    })

    // ── H2 (auditoría de Codex del código + revisión final Minor 3, 15-oct-2026) ─────────────────────────────────────────
    it('🔴 H2: una corrida que FALLA no pisa la marca con su error (si la pisara, el cierre «sin cliente» que espera detrás ya no la vería)', async () => {
      const venta = fila({ loyaltyLastError: MARCA, clientes: 1 })
      orderUpdateMany.mockImplementation(tablaDeUnaVenta(venta).updateMany)
      orderCustomerFindMany.mockResolvedValue([
        { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: 'Dany', lastName: null } },
      ])
      earnPointsMock.mockRejectedValue(new Error('P1001'))

      const result = await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50, legacyCustomer: null })

      expect(result.complete).toBe(false)
      expect(venta.loyaltyProcessedAt).toBeNull()
      expect(venta.loyaltyLastError).toBe(MARCA)
      // La condición va en la MISMA sentencia (Postgres la relee al soltarse un candado): null, o distinto de la marca.
      expect(orderUpdateMany).toHaveBeenCalledWith({
        where: {
          id: ORDER,
          venueId: VENUE,
          loyaltyEligibleAt: { not: null },
          loyaltyProcessedAt: null,
          OR: [{ loyaltyLastError: null }, { loyaltyLastError: { not: MARCA } }],
        },
        data: { loyaltyLastError: expect.stringContaining('loyalty:cust-A') },
      })
    })

    it('regresión H2: sin marca, la corrida que falla SÍ deja su error (también sobre un error viejo)', async () => {
      const venta = fila({ loyaltyLastError: 'query:P1001', clientes: 1 })
      orderUpdateMany.mockImplementation(tablaDeUnaVenta(venta).updateMany)
      orderCustomerFindMany.mockResolvedValue([
        { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: 'Dany', lastName: null } },
      ])
      earnPointsMock.mockRejectedValue(new Error('P1001'))

      await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50, legacyCustomer: null })

      expect(venta.loyaltyLastError).toBe('loyalty:cust-A')
    })

    it('la corrida que SÍ vio al cliente cierra aunque la fila traiga la marca, y la borra (lealtad completa)', async () => {
      const venta = fila({ loyaltyLastError: MARCA, clientes: 1 })
      orderUpdateMany.mockImplementation(tablaDeUnaVenta(venta).updateMany)
      orderCustomerFindMany.mockResolvedValue([
        { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: 'Dany', lastName: null } },
      ])

      const result = await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50, legacyCustomer: null })

      expect(result).toEqual({ complete: true, errors: [] })
      expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-A', 50, ORDER, undefined)
      expect(venta.loyaltyProcessedAt).toBeInstanceOf(Date)
      expect(venta.loyaltyLastError).toBeNull()
    })
  })
})
