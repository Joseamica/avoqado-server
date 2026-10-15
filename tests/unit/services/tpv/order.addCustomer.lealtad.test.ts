/**
 * La TPV también liga clientes (`orders/:orderId/customers` y `.../customers/create`). Si la venta ya está pagada, la regla
 * del sello tardío aplica igual que en el POS: cualquier camino que ligue un cliente a una venta pagada sella.
 */
const mockLate = jest.fn()
const mockReabrir = jest.fn()
jest.mock('@/services/shared/loyaltyOnLateCustomer', () => ({
  awardLoyaltyForLateCustomer: (...a: unknown[]) => mockLate(...a),
  reabrirLealtadSiAplica: (...a: unknown[]) => mockReabrir(...a),
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { addCustomerToOrder, createAndAddCustomerToOrder } from '@/services/tpv/order.tpv.service'

const VENUE = 'venue-1'
const LISTA = [{ id: 'oc-1', orderId: 'order-1', customerId: 'cust-1', isPrimary: true, customer: { id: 'cust-1' } }]
const SELLO = { stampsEnabled: true, stamped: true, reason: null, stampsEarned: 1, stampsRequired: 7, rewardReady: false }

let enTransaccion = false
let reabrioDentro: boolean | null = null

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
  prismaMock.order.findUnique.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1', paymentStatus: 'PAID' } as any)
  prismaMock.orderCustomer.findUnique.mockResolvedValue(null)
  prismaMock.orderCustomer.count.mockResolvedValue(0)
  prismaMock.orderCustomer.create.mockResolvedValue({ id: 'oc-1' } as any)
  prismaMock.orderCustomer.findMany.mockResolvedValue(LISTA as any)
  mockLate.mockResolvedValue(SELLO)
  mockReabrir.mockImplementation(async () => {
    reabrioDentro = enTransaccion
    return true
  })
})

describe('TPV addCustomerToOrder', () => {
  beforeEach(() => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'cust-1', venueId: VENUE, firstName: 'Dany', lastName: null } as any)
  })

  it('🔴 liga, llama al helper con el actor y conserva la lista de siempre', async () => {
    const r = await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1')
    expect(mockLate).toHaveBeenCalledWith({ venueId: VENUE, orderId: 'order-1', customerId: 'cust-1', staffId: 'staff-1' })
    expect(r).toEqual({ orderCustomers: LISTA, loyalty: SELLO })
  })

  it('helper que lanza no rompe la liga: loyalty null', async () => {
    mockLate.mockRejectedValue(new Error('boom'))
    expect((await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1')).loyalty).toBeNull()
  })

  it('helper devuelve null (cuenta abierta, lo normal en la TPV): loyalty null y la lista de siempre', async () => {
    mockLate.mockResolvedValue(null)
    expect(await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1')).toEqual({ orderCustomers: LISTA, loyalty: null })
  })

  it('sin actor (llamador viejo del servicio): staffId null', async () => {
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1')
    expect(mockLate).toHaveBeenCalledWith(expect.objectContaining({ staffId: null }))
    expect(mockReabrir).toHaveBeenCalledWith(prismaMock, expect.objectContaining({ staffId: null }))
  })

  it('regresión: cliente ya ligado ⇒ 400 y sin lealtad', async () => {
    prismaMock.orderCustomer.findUnique.mockResolvedValue({ id: 'oc-1' } as any)
    await expect(addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1')).rejects.toThrow('Customer already added to this order')
    expect(mockLate).not.toHaveBeenCalled()
    expect(mockReabrir).not.toHaveBeenCalled()
  })

  it('regresión: cliente de otro negocio ⇒ 404, ni liga ni lealtad', async () => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'cust-1', venueId: 'otro', firstName: 'Dany', lastName: null } as any)
    await expect(addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1')).rejects.toThrow('Customer not found')
    expect(prismaMock.orderCustomer.create).not.toHaveBeenCalled()
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(mockLate).not.toHaveBeenCalled()
  })

  it('🔴 el primer cliente (primario) reabre la lealtad DENTRO de la transacción, antes del intento inmediato (auditoría A #1)', async () => {
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1')
    expect(mockReabrir).toHaveBeenCalledWith(prismaMock, { venueId: VENUE, orderId: 'order-1', customerId: 'cust-1', staffId: 'staff-1' })
    expect(reabrioDentro).toBe(true)
    expect(mockReabrir.mock.invocationCallOrder[0]).toBeLessThan(mockLate.mock.invocationCallOrder[0])
  })

  it('🔴 la reapertura es la ÚLTIMA escritura de la transacción: después de crear el OrderCustomer', async () => {
    // Ruling tras S3b/S4: la reapertura deja una MARCA en la fila de la orden. Un cierre «sin cliente» que espera el candado
    // de esa fila sólo relee sus columnas al soltarse; la marca tiene que ser lo último que se escribe antes del commit.
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1')
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'cust-1', isPrimary: true } })
    expect(mockReabrir.mock.invocationCallOrder[0]).toBeGreaterThan(prismaMock.orderCustomer.create.mock.invocationCallOrder[0])
  })

  it('si reabrir falla, la liga falla entera (misma transacción) y no se intenta la lealtad: el cajero reintenta', async () => {
    mockReabrir.mockRejectedValue(new Error('P1001'))
    await expect(addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1')).rejects.toThrow('P1001')
    expect(mockLate).not.toHaveBeenCalled()
  })

  it('un segundo cliente (no primario) no reabre nada', async () => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'cust-2', venueId: VENUE, firstName: 'Beto', lastName: null } as any)
    prismaMock.orderCustomer.count.mockResolvedValue(1)
    await addCustomerToOrder(VENUE, 'order-1', 'cust-2', 'staff-1')
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'cust-2', isPrimary: false } })
    expect(mockReabrir).not.toHaveBeenCalled()
  })

  // ── F1 (revisión final Minor 1, 15-oct-2026) ─────────────────────────────────────────────────────────────────────────
  it.each(['PENDING', 'PARTIAL'])(
    '🔴 F1: cuenta %s (lo normal en la TPV): NO se llama a la reapertura (no ensancha la lectura Serializable de una cuenta abierta)',
    async paymentStatus => {
      prismaMock.order.findUnique.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1', paymentStatus } as any)
      mockLate.mockResolvedValue(null) // cuenta abierta: el helper no pinta nada
      const r = await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1')
      expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'cust-1', isPrimary: true } })
      expect(mockReabrir).not.toHaveBeenCalled()
      expect(r).toEqual({ orderCustomers: LISTA, loyalty: null })
    },
  )

  it('F1: la lectura previa a la transacción pide paymentStatus (y sigue filtrando por negocio)', async () => {
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1')
    expect(prismaMock.order.findUnique).toHaveBeenCalledWith({
      where: { id: 'order-1', venueId: VENUE },
      select: { id: true, orderNumber: true, paymentStatus: true },
    })
  })

  it('camino de rescate por P2002 (otro quedó primario a la vez): lo liga NO primario y no reabre', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1')
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'cust-1', isPrimary: false } })
    expect(mockReabrir).not.toHaveBeenCalled()
  })
})

describe('TPV createAndAddCustomerToOrder', () => {
  beforeEach(() => {
    prismaMock.customer.findUnique.mockResolvedValue(null) // sin duplicados de correo/teléfono
    prismaMock.customer.create.mockResolvedValue({ id: 'nuevo' } as any)
  })

  it('🔴 crea, liga y llama al helper con el id del cliente NUEVO', async () => {
    const r = await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany', phone: '5543453965' }, 'staff-1')
    expect(mockLate).toHaveBeenCalledWith({ venueId: VENUE, orderId: 'order-1', customerId: 'nuevo', staffId: 'staff-1' })
    expect(r).toEqual({ orderCustomers: LISTA, loyalty: SELLO })
  })

  it('el cliente nuevo y primario también reabre la lealtad dentro de la transacción', async () => {
    await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1')
    expect(mockReabrir).toHaveBeenCalledWith(prismaMock, { venueId: VENUE, orderId: 'order-1', customerId: 'nuevo', staffId: 'staff-1' })
    expect(reabrioDentro).toBe(true)
    expect(mockReabrir.mock.invocationCallOrder[0]).toBeLessThan(mockLate.mock.invocationCallOrder[0])
  })

  it('🔴 la reapertura es la ÚLTIMA escritura: después de crear el cliente y el OrderCustomer', async () => {
    await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1')
    const reapertura = mockReabrir.mock.invocationCallOrder[0]
    expect(reapertura).toBeGreaterThan(prismaMock.customer.create.mock.invocationCallOrder[0])
    expect(reapertura).toBeGreaterThan(prismaMock.orderCustomer.create.mock.invocationCallOrder[0])
  })

  it('🔴 F1: cuenta abierta: el cliente nuevo queda primario pero NO se llama a la reapertura', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1', paymentStatus: 'PENDING' } as any)
    await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1')
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'nuevo', isPrimary: true } })
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(prismaMock.order.findUnique).toHaveBeenCalledWith({
      where: { id: 'order-1', venueId: VENUE },
      select: { id: true, orderNumber: true, paymentStatus: true },
    })
  })

  it('cuenta que ya tenía primario: el cliente nuevo entra NO primario y no reabre', async () => {
    prismaMock.orderCustomer.count.mockResolvedValue(1)
    await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1')
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(mockLate).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'nuevo' }))
  })

  it('helper que lanza no rompe el alta: loyalty null', async () => {
    mockLate.mockRejectedValue(new Error('boom'))
    expect(await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1')).toEqual({
      orderCustomers: LISTA,
      loyalty: null,
    })
  })

  it('regresión: teléfono repetido ⇒ 400, sin alta ni lealtad', async () => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'ya-existe' } as any)
    await expect(createAndAddCustomerToOrder(VENUE, 'order-1', { phone: '5543453965' }, 'staff-1')).rejects.toThrow(
      'Ya existe un cliente con ese teléfono en este venue',
    )
    expect(prismaMock.customer.create).not.toHaveBeenCalled()
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(mockLate).not.toHaveBeenCalled()
  })
})
