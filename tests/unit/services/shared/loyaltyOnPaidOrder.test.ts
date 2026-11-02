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
    orderItem: { findFirst: jest.fn() },
    // Cambio de producto: por default la venta no es la nueva de un cambio ni tiene cobros con crédito de cambio.
    payment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }) },
    exchange: { findUnique: jest.fn().mockResolvedValue(null) },
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

  it('regresión H4 tercera ola: en el COBRO (sin beneficiario) el orden de siempre — visita primero, luego puntos — y otroCliente no rompe nada', async () => {
    orderCustomerFindMany.mockResolvedValue([
      { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: 'Ana', lastName: null } },
    ])
    await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90 })
    expect(metricsMock.mock.invocationCallOrder[0]).toBeLessThan(earnPointsMock.mock.invocationCallOrder[0])

    earnPointsMock.mockResolvedValue({ pointsEarned: 0, newBalance: 0, otroCliente: true })
    const r = await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90 })
    expect(r).toEqual({ complete: true, errors: [], otroCliente: true })
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

  // ── H4, segunda ola (recheck de Codex, 15-oct-2026): acredita SÓLO al beneficiario que el envoltorio validó ───────────
  describe('🔴 H4: { beneficiario } — nunca vuelve a resolver un cliente distinto del validado', () => {
    const conPrimario = (id: string) =>
      orderCustomerFindMany.mockResolvedValue([{ customerId: id, isPrimary: true, customer: { id, firstName: null, lastName: null } }])

    it('🔴 el primario CAMBIÓ entre la comprobación y la lealtad: no acredita a nadie (ni visita) y la venta queda pendiente', async () => {
      conPrimario('cust-B') // el envoltorio validó a A; la TPV puso a B en medio
      const r = await awardLoyaltyForPaidOrder(
        { venueId: VENUE, orderId: ORDER, orderTotal: 50 },
        { cerrar: false, beneficiario: 'cust-A' },
      )
      expect(earnPointsMock).not.toHaveBeenCalled()
      expect(metricsMock).not.toHaveBeenCalled()
      expect(r.complete).toBe(false)
      expect(r.errors).toEqual([expect.stringContaining('beneficiario')])
      // Ni cierre ni nada que la saque de la cola: sólo el error (que no pisa la marca).
      expect(orderUpdateMany).toHaveBeenCalledTimes(1)
      expect(orderUpdateMany.mock.calls[0][0].data).toEqual({ loyaltyLastError: expect.stringContaining('beneficiario') })
    })

    it('el primario es el validado: acredita a ése, como siempre', async () => {
      conPrimario('cust-A')
      const r = await awardLoyaltyForPaidOrder(
        { venueId: VENUE, orderId: ORDER, orderTotal: 50 },
        { cerrar: false, beneficiario: 'cust-A' },
      )
      expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-A', 50, ORDER, undefined)
      expect(r).toEqual({ complete: true, errors: [], leyoSinCliente: false })
    })

    it('sin OrderCustomer: el heredado es el validado ⇒ lo acredita; otro heredado ⇒ nadie', async () => {
      orderCustomerFindMany.mockResolvedValue([])
      const legacy = { id: 'cust-L', firstName: null, lastName: null }
      await awardLoyaltyForPaidOrder(
        { venueId: VENUE, orderId: ORDER, orderTotal: 50, legacyCustomer: legacy },
        { cerrar: false, beneficiario: 'cust-L' },
      )
      expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-L', 50, ORDER, undefined)
      earnPointsMock.mockClear()
      const r = await awardLoyaltyForPaidOrder(
        { venueId: VENUE, orderId: ORDER, orderTotal: 50, legacyCustomer: legacy },
        { cerrar: false, beneficiario: 'cust-OTRO' },
      )
      expect(earnPointsMock).not.toHaveBeenCalled()
      expect(r.complete).toBe(false)
    })

    it('validó «sin cliente» y ahora hay un cliente (una liga en medio): no lo acredita aquí; la liga reabrió y lo hará', async () => {
      conPrimario('cust-X')
      const r = await awardLoyaltyForPaidOrder(
        { venueId: VENUE, orderId: ORDER, orderTotal: 50, legacyCustomer: null },
        { cerrar: false, beneficiario: null },
      )
      expect(earnPointsMock).not.toHaveBeenCalled()
      expect(r.complete).toBe(false)
    })

    it('validó «sin cliente» y sigue sin cliente: la corrida «sin cliente» de siempre (leyoSinCliente)', async () => {
      orderCustomerFindMany.mockResolvedValue([])
      const r = await awardLoyaltyForPaidOrder(
        { venueId: VENUE, orderId: ORDER, orderTotal: 50, legacyCustomer: null },
        { cerrar: false, beneficiario: null },
      )
      expect(r).toEqual({ complete: true, errors: [], leyoSinCliente: true })
    })

    // ── H4, tercera ola (recheck 2 de Codex): earnPoints dice que OTRO cliente ya ganó la venta (dos intentos a la vez) ─────
    it('🔴 con beneficiario: earnPoints dice otroCliente ⇒ ni visita ni error; el resultado lo dice y la venta se puede cerrar', async () => {
      conPrimario('cust-B')
      earnPointsMock.mockResolvedValue({ pointsEarned: 0, newBalance: 0, otroCliente: true })
      const r = await awardLoyaltyForPaidOrder(
        { venueId: VENUE, orderId: ORDER, orderTotal: 50 },
        { cerrar: false, beneficiario: 'cust-B' },
      )
      expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-B', 50, ORDER, undefined)
      expect(metricsMock).not.toHaveBeenCalled() // B no suma la visita de una venta que ganó otro
      expect(r).toEqual({ complete: true, errors: [], leyoSinCliente: false, otroCliente: true })
    })

    it('con beneficiario: primero se acredita y DESPUÉS la visita (así otroCliente no deja visita)', async () => {
      conPrimario('cust-A')
      await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50 }, { cerrar: false, beneficiario: 'cust-A' })
      expect(earnPointsMock.mock.invocationCallOrder[0]).toBeLessThan(metricsMock.mock.invocationCallOrder[0])
    })

    it('dos primarios (dato raro): sólo acredita al validado', async () => {
      orderCustomerFindMany.mockResolvedValue([
        { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: null, lastName: null } },
        { customerId: 'cust-B', isPrimary: true, customer: { id: 'cust-B', firstName: null, lastName: null } },
      ])
      await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 50 }, { cerrar: false, beneficiario: 'cust-A' })
      expect(earnPointsMock).toHaveBeenCalledTimes(1)
      expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-A', 50, ORDER, undefined)
    })
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
          // F1 (ronda 1): «sin cliente» = sin PRIMARIO. Un acompañante ligado sin permiso a la venta cobrada no la detiene.
          orderCustomers: { none: { isPrimary: true } },
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
  // ── F1 (ronda 1 post-QA, P1 de Codex; decisión «A»): una liga SIN permiso a una venta cobrada entra como ACOMPAÑANTE (no
  // primaria). Para la lealtad las ligas sin primario no cuentan: el resultado es el de la venta sin esas ligas.
  describe('🔴 F1: ligas SIN primario (acompañantes de una venta cobrada) no hacen beneficiario a nadie', () => {
    const ACOMPANANTE = { customerId: 'cust-K', isPrimary: false, customer: { id: 'cust-K', firstName: 'Kev', lastName: null } }

    it('🔴 sólo un acompañante y sin heredado: ni puntos/sello ni visita; la corrida lee «sin cliente» y cierra con la guarda del primario', async () => {
      orderCustomerFindMany.mockResolvedValue([ACOMPANANTE])
      const result = await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90, legacyCustomer: null })
      expect(earnPointsMock).not.toHaveBeenCalled()
      expect(metricsMock).not.toHaveBeenCalled()
      expect(result).toEqual({ complete: true, errors: [] })
      expect(orderUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ orderCustomers: { none: { isPrimary: true } } }) }),
      )
    })

    it('sólo un acompañante y CON heredado: se acredita al heredado, como si la liga no existiera', async () => {
      orderCustomerFindMany.mockResolvedValue([ACOMPANANTE])
      await awardLoyaltyForPaidOrder({
        venueId: VENUE,
        orderId: ORDER,
        orderTotal: 90,
        legacyCustomer: { id: 'cust-L', firstName: 'Leo', lastName: null },
      })
      expect(earnPointsMock).toHaveBeenCalledTimes(1)
      expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-L', 90, ORDER, undefined)
      expect(metricsMock).toHaveBeenCalledWith('cust-L', 90, ORDER, VENUE)
      expect(metricsMock).not.toHaveBeenCalledWith('cust-K', expect.anything(), expect.anything(), expect.anything())
    })

    it('con beneficiario validado «sin cliente» (el envoltorio) y sólo un acompañante: no acredita y lee «sin cliente»', async () => {
      orderCustomerFindMany.mockResolvedValue([ACOMPANANTE])
      const result = await awardLoyaltyForPaidOrder(
        { venueId: VENUE, orderId: ORDER, orderTotal: 90, legacyCustomer: null },
        { cerrar: false, beneficiario: null },
      )
      expect(earnPointsMock).not.toHaveBeenCalled()
      expect(metricsMock).not.toHaveBeenCalled()
      expect(result).toEqual({ complete: true, errors: [], leyoSinCliente: true })
    })

    it('regresión: con primario, el acompañante sigue contando su visita (la de siempre)', async () => {
      orderCustomerFindMany.mockResolvedValue([
        { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: 'Ana', lastName: null } },
        ACOMPANANTE,
      ])
      await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90 })
      expect(metricsMock).toHaveBeenCalledWith('cust-K', 90, ORDER, VENUE)
      expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-A', 90, ORDER, undefined)
    })
  })

  // ── F2 (ronda 1): el resultado dice si ESTA corrida otorgó el sello o los puntos (la auditoría de una re-liga lo necesita) ─
  describe('F2: `otorgado` — lo que ESTA corrida creó', () => {
    const PRIMARIO = { customerId: 'cust-A', isPrimary: true, customer: { id: 'cust-A', firstName: 'Ana', lastName: null } }

    it('🔴 earnPoints dice que esta llamada creó el sello: el resultado lo trae', async () => {
      orderCustomerFindMany.mockResolvedValue([PRIMARIO])
      earnPointsMock.mockResolvedValue({ pointsEarned: 0, newBalance: 0, otorgado: { sello: true, puntos: false } })
      const result = await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90 }, { cerrar: false })
      expect(result).toEqual({ complete: true, errors: [], leyoSinCliente: false, otorgado: { sello: true, puntos: false } })
    })

    it('🔴 R3-1: earnPoints truena DESPUÉS de otorgar (trae el hecho en el error): el resultado conserva `otorgado`', async () => {
      orderCustomerFindMany.mockResolvedValue([PRIMARIO])
      earnPointsMock.mockRejectedValue(Object.assign(new Error('sello'), { otorgadoAntesDelFallo: { sello: false, puntos: true } }))
      const result = await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90 }, { cerrar: false })
      expect(result).toMatchObject({ complete: false, errors: ['loyalty:cust-A'], otorgado: { sello: false, puntos: true } })
    })

    it('🔴 R4-1: carrera H4 — ESTA llamada selló y luego otro intento ganó los puntos (otroCliente): el resultado conserva `otorgado`', async () => {
      orderCustomerFindMany.mockResolvedValue([PRIMARIO])
      earnPointsMock.mockResolvedValue({ pointsEarned: 0, newBalance: 0, otroCliente: true, otorgado: { sello: true, puntos: false } })
      const result = await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90 }, { cerrar: false })
      expect(result).toMatchObject({ otroCliente: true, otorgado: { sello: true, puntos: false } })
    })

    it('un reintento idempotente (nada nuevo): sin `otorgado`', async () => {
      orderCustomerFindMany.mockResolvedValue([PRIMARIO])
      earnPointsMock.mockResolvedValue({ pointsEarned: 50, newBalance: 7 })
      const result = await awardLoyaltyForPaidOrder({ venueId: VENUE, orderId: ORDER, orderTotal: 90 })
      expect(result).toEqual({ complete: true, errors: [] })
    })
  })
})
