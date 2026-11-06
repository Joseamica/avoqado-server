import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

/**
 * D4 — un paquete vendido en el POS se entrega UNA vez. La app manda una llave por entrega: si se pierde la respuesta y la
 * cola reintenta, el servidor contesta la misma compra en vez de crear otra con sus clases.
 */
describe('Venta en persona con llave de entrega', () => {
  const pack = {
    id: 'pack-1',
    venueId: 'venue-1',
    price: 1500,
    active: true,
    validityDays: null,
    maxPerCustomer: null as number | null,
    items: [{ id: 'item-1', productId: 'prod-1', quantity: 10 }],
  }
  const compra = { id: 'purchase-1', venueId: 'venue-1', creditPackId: 'pack-1', customerId: 'cust-1', deliveryKey: 'llave-1' }

  function makeTx() {
    return {
      creditPackPurchase: { count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({ id: 'purchase-1' }) },
      creditItemBalance: { create: jest.fn().mockResolvedValue({ id: 'bal-1' }) },
      creditTransaction: { create: jest.fn().mockResolvedValue({}) },
      customer: { update: jest.fn().mockResolvedValue({}) },
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'prod-1' }]) },
    }
  }

  let tx: ReturnType<typeof makeTx>

  beforeEach(() => {
    jest.clearAllMocks()
    tx = makeTx()
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(tx))
    prismaMock.creditPack.findUnique.mockResolvedValue({ ...pack } as any)
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'cust-1', venueId: 'venue-1' } as any)
    prismaMock.creditPackPurchase.findUnique.mockResolvedValue(null as any)
    prismaMock.product.findMany.mockResolvedValue([{ id: 'prod-1' }] as any)
  })

  const vender = async (opts?: Record<string, unknown>) => {
    const { sellPackInPerson } = await import('@/services/mobile/creditPack.mobile.service')
    return sellPackInPerson('venue-1', 'pack-1', 'cust-1', 'staff-1', opts as any)
  }

  // 🔴 D17 (hz:433063d4:D17): vendido desde el CARRITO, el cobro de la orden ya sumó al «Total gastado» del cliente; la entrega
  // no lo vuelve a sumar ($1,700 cobrados marcaban $3,400). Desde la ficha la cajera cobra a mano, sin orden: ahí sí suma.
  it('🔴 D17: con cobradoEnOrden la entrega no vuelve a sumar al total gastado', async () => {
    await vender({ deliveryKey: 'llave-1', cobradoEnOrden: true })

    expect(tx.creditPackPurchase.create).toHaveBeenCalled()
    expect(tx.customer.update).not.toHaveBeenCalled()
  })

  it('D17: sin cobradoEnOrden (ficha del cliente, apps viejas, MCP) suma como siempre', async () => {
    await vender({ deliveryKey: 'llave-1' })

    expect(tx.customer.update.mock.calls[0][0].data).toEqual({ totalSpent: { increment: expect.anything() } })
  })

  it('🔴 guarda la llave en la compra', async () => {
    await vender({ deliveryKey: 'llave-1' })

    expect(tx.creditPackPurchase.create.mock.calls[0][0].data.deliveryKey).toBe('llave-1')
  })

  it('🔴 la misma llave contesta la misma compra y no crea otra', async () => {
    prismaMock.creditPackPurchase.findUnique.mockResolvedValue(compra as any)

    const r = await vender({ deliveryKey: 'llave-1' })

    expect(r).toMatchObject({ id: 'purchase-1' })
    expect(tx.creditPackPurchase.create).not.toHaveBeenCalled()
    expect(prismaMock.creditPackPurchase.findUnique.mock.calls[0][0].where).toEqual({
      venueId_deliveryKey: { venueId: 'venue-1', deliveryKey: 'llave-1' },
    })
  })

  it('🔴 el reintento gana aunque el paquete ya esté apagado o el cliente ya no se encuentre', async () => {
    prismaMock.creditPackPurchase.findUnique.mockResolvedValue(compra as any)
    prismaMock.creditPack.findUnique.mockResolvedValue({ ...pack, active: false } as any)
    prismaMock.customer.findFirst.mockResolvedValue(null as any)

    await expect(vender({ deliveryKey: 'llave-1' })).resolves.toMatchObject({ id: 'purchase-1' })
  })

  it('🔴 la llave de OTRO paquete o de OTRO cliente es un conflicto, no una compra ajena', async () => {
    prismaMock.creditPackPurchase.findUnique.mockResolvedValue({ ...compra, customerId: 'otra' } as any)

    await expect(vender({ deliveryKey: 'llave-1' })).rejects.toMatchObject({ statusCode: 409 })
    expect(tx.creditPackPurchase.create).not.toHaveBeenCalled()
  })

  it('🔴 dos a la vez: la perdedora contesta la compra de la ganadora (P2002)', async () => {
    const { Prisma } = await import('@prisma/client')
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )
    prismaMock.creditPackPurchase.findUnique.mockResolvedValueOnce(null as any).mockResolvedValueOnce(compra as any)

    await expect(vender({ deliveryKey: 'llave-1' })).resolves.toMatchObject({ id: 'purchase-1' })
  })

  it('🔴 dos a la vez: también si la perdedora tropieza con el tope que ya cuenta a la ganadora', async () => {
    const { BadRequestError } = await import('@/errors/AppError')
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValue(new BadRequestError('tope'))
    prismaMock.creditPackPurchase.findUnique.mockResolvedValueOnce(null as any).mockResolvedValueOnce(compra as any)

    await expect(vender({ deliveryKey: 'llave-1' })).resolves.toMatchObject({ id: 'purchase-1' })
  })

  it('un error real sin compra de la llave sube tal cual: la app lo enseña a una persona', async () => {
    const { BadRequestError } = await import('@/errors/AppError')
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValue(new BadRequestError('tope'))

    await expect(vender({ deliveryKey: 'llave-1' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('paquete apagado sin foto: rechazo de siempre', async () => {
    prismaMock.creditPack.findUnique.mockResolvedValue({ ...pack, active: false } as any)

    await expect(vender({ deliveryKey: 'llave-1' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('cliente inexistente: rechazo de siempre', async () => {
    prismaMock.customer.findFirst.mockResolvedValue(null as any)

    await expect(vender({ deliveryKey: 'llave-1' })).rejects.toMatchObject({ statusCode: 404 })
  })

  describe('apps viejas (sin llave): como hoy', () => {
    it('no busca llave y cada llamada crea una compra', async () => {
      await vender()
      await vender()

      const porLlave = prismaMock.creditPackPurchase.findUnique.mock.calls.filter((c: any[]) => 'venueId_deliveryKey' in c[0].where)
      expect(porLlave).toHaveLength(0)
      expect(tx.creditPackPurchase.create).toHaveBeenCalledTimes(2)
      expect(tx.creditPackPurchase.create.mock.calls[0][0].data).not.toHaveProperty('deliveryKey')
    })

    it('sigue cobrando el precio de lista', async () => {
      await vender()

      expect(Number(tx.creditPackPurchase.create.mock.calls[0][0].data.amountPaid)).toBe(1500)
    })
  })

  describe('entrega desde la foto de lo vendido', () => {
    const foto = {
      v: 1 as const,
      creditPackId: 'pack-1',
      name: '10 clases',
      price: '1200.00',
      currency: 'MXN',
      validityDays: 30,
      items: [{ productId: 'prod-1', quantity: 8 }],
    }

    it('🔴 entrega y registra lo vendido, no lo vigente', async () => {
      await vender({ deliveryKey: 'llave-1', foto })

      const creada = tx.creditPackPurchase.create.mock.calls[0][0].data
      expect(Number(creada.amountPaid)).toBe(1200)
      expect(creada.expiresAt).toBeInstanceOf(Date)
      const saldo = tx.creditItemBalance.create.mock.calls[0][0].data
      expect(saldo).toMatchObject({ productId: 'prod-1', originalQuantity: 8, creditPackItemId: null })
    })

    it('🔴 entrega aunque el paquete ya esté apagado: ya se cobró', async () => {
      prismaMock.creditPack.findUnique.mockResolvedValue({ ...pack, active: false } as any)

      await expect(vender({ deliveryKey: 'llave-1', foto })).resolves.toBeTruthy()
      expect(tx.creditPackPurchase.create).toHaveBeenCalled()
    })

    it('🔴 el tope por cliente se sigue respetando', async () => {
      prismaMock.creditPack.findUnique.mockResolvedValue({ ...pack, maxPerCustomer: 1 } as any)
      tx.creditPackPurchase.count.mockResolvedValue(1)

      await expect(vender({ deliveryKey: 'llave-1', foto })).rejects.toMatchObject({ statusCode: 400 })
    })

    it('🔴 un producto de la foto que ya no es del negocio se rechaza con su motivo, no con un 500', async () => {
      prismaMock.product.findMany.mockResolvedValue([] as any)

      await expect(vender({ deliveryKey: 'llave-1', foto })).rejects.toMatchObject({ statusCode: 400 })
      expect(tx.creditPackPurchase.create).not.toHaveBeenCalled()
    })

    it('🔴 la foto de OTRO paquete se ignora: se usa el vigente', async () => {
      await vender({ deliveryKey: 'llave-1', foto: { ...foto, creditPackId: 'otro' } })

      expect(Number(tx.creditPackPurchase.create.mock.calls[0][0].data.amountPaid)).toBe(1500)
    })
  })
})
