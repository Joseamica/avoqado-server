import { prismaMock } from '@tests/__helpers__/setup'
import { hasHistoricalCustomerAuthority, isCustomerAssignableSale, ownsRecentReceipt } from '@/services/shared/customerAttributionPolicy'
import { assertCustomerAttributionUnderLock } from '@/services/shared/ligaDeClienteEnVenta'

const now = Date.UTC(2026, 0, 10, 12)
const actor = { staffId: 'cashier', canAttachAtReceipt: true }
const payment = { status: 'COMPLETED', type: null, processedById: 'cashier', createdAt: new Date(now) }

describe('autoridad histórica y recibo inmediato', () => {
  it.each([
    ['MANAGER', true, true],
    ['ADMIN', true, true],
    ['OWNER', true, true],
    ['SUPERADMIN', true, true],
    ['MANAGER', false, false],
    ['CASHIER', true, false],
    ['WAITER', true, false],
    [undefined, true, false],
  ])('rol %s permiso %s ⇒ autoridad %s', (role, allowed, expected) => {
    expect(hasHistoricalCustomerAuthority(role as string | undefined, allowed as boolean)).toBe(expected)
  })

  it.each([
    [0, true],
    [15 * 60_000, true],
    [15 * 60_000 + 1, false],
    [-1, false],
  ])('edad %s ⇒ recibo autorizado %s', (age, expected) => {
    expect(ownsRecentReceipt({ ...payment, createdAt: new Date(now - Number(age)) }, actor, now)).toBe(expected)
  })

  it('no confía en la identidad del cajero, permiso ausente o fecha inválida', () => {
    expect(ownsRecentReceipt(payment, { ...actor, staffId: 'other' }, now)).toBe(false)
    expect(ownsRecentReceipt(payment, { staffId: 'cashier' }, now)).toBe(false)
    expect(ownsRecentReceipt({ ...payment, createdAt: new Date('invalid') }, actor, now)).toBe(false)
  })

  it.each([
    ['COMPLETED', null, 'PAID', 'COMPLETED', true],
    ['FAILED', null, 'PAID', 'COMPLETED', false],
    ['COMPLETED', 'REFUND', 'PAID', 'COMPLETED', false],
    ['COMPLETED', null, 'REFUNDED', 'COMPLETED', false],
    ['COMPLETED', null, 'PAID', 'CANCELLED', false],
    ['COMPLETED', null, 'PARTIAL', 'PENDING', false],
  ])('GET y POST: pago %s/%s venta %s/%s ⇒ elegible %s', (status, type, paymentStatus, orderStatus, expected) => {
    expect(isCustomerAssignableSale({ status, type } as any, { status: orderStatus, paymentStatus } as any)).toBe(expected)
  })
})

describe('decisión bajo el candado de la venta', () => {
  beforeEach(() => {
    prismaMock.order.findFirst.mockResolvedValue({ customerId: null, status: 'COMPLETED', paymentStatus: 'PAID' } as any)
    prismaMock.orderCustomer.findFirst.mockResolvedValue(null)
    prismaMock.payment.findFirst.mockResolvedValue({ ...payment, createdAt: new Date() } as any)
  })
  const args = { venueId: 'venue-1', orderId: 'order-1', customerId: 'customer-1' }

  it('una ruta histórica no acepta la excepción del recibo ni permisos inferidos', async () => {
    await expect(assertCustomerAttributionUnderLock(prismaMock, { ...args, actor, historicalOnly: true })).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('gerencia puede ligar una venta antigua sin reemplazar cliente', async () => {
    prismaMock.payment.findFirst.mockResolvedValue({ ...payment, createdAt: new Date(now) } as any)
    await expect(
      assertCustomerAttributionUnderLock(prismaMock, {
        ...args,
        actor: { staffId: 'manager', canAssignHistorical: true },
        historicalOnly: true,
      }),
    ).resolves.toBeUndefined()
  })

  it('ni gerencia puede quitar el primario o elegir entre anclajes contradictorios', async () => {
    prismaMock.orderCustomer.findFirst.mockResolvedValue({ customerId: 'other' } as any)
    await expect(assertCustomerAttributionUnderLock(prismaMock, { ...args, actor: { canAssignHistorical: true } })).rejects.toMatchObject({
      statusCode: 409,
    })
    await expect(
      assertCustomerAttributionUnderLock(prismaMock, { ...args, customerId: null, actor: { canAssignHistorical: true } }),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('un reintento del mismo cliente no convierte una respuesta perdida en error', async () => {
    prismaMock.orderCustomer.findFirst.mockResolvedValue({ customerId: args.customerId } as any)
    await expect(assertCustomerAttributionUnderLock(prismaMock, args)).resolves.toBeUndefined()
  })

  it('la evidencia durable acredita sólo el cliente y la venta originales', async () => {
    prismaMock.payment.findFirst.mockResolvedValue({ ...payment, createdAt: new Date(now) } as any)
    const original = { originalCustomer: { orderId: 'order-1', customerId: 'customer-1' } }
    await expect(assertCustomerAttributionUnderLock(prismaMock, { ...args, actor: original })).resolves.toBeUndefined()
    await expect(
      assertCustomerAttributionUnderLock(prismaMock, { ...args, customerId: 'customer-2', actor: original }),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      assertCustomerAttributionUnderLock(prismaMock, {
        ...args,
        actor: { originalCustomer: { orderId: 'other-order', customerId: args.customerId } },
      }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})
