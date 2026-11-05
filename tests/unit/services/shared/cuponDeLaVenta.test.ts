/** D5: el cierre cuenta el cupón una sola vez y los textos que ve la caja salen en español. */
import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import { apartarCupon, cuponDeLaVenta, finalizeCouponsForOrder, montoDelCupon, textoDeRechazoDeCupon } from '@/services/shared/cuponDeLaVenta'

const fila = {
  id: 'od-1',
  orderId: 'o-1',
  couponCodeId: 'cup-1',
  amount: new Prisma.Decimal(10),
  couponCode: { id: 'cup-1', code: 'DESC10', discountId: 'd-1' },
}

describe('finalizeCouponsForOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    prismaMock.orderDiscount.findMany.mockResolvedValue([fila] as any)
    prismaMock.order.findFirst.mockResolvedValue({ customerId: 'c-1', paymentStatus: 'PAID' } as any)
    prismaMock.couponRedemption.findUnique.mockResolvedValue(null)
  })

  it('pagada y sin canje: crea el canje con su cliente y sube los dos contadores en una transacción', async () => {
    await finalizeCouponsForOrder('v-1', 'o-1')
    expect(prismaMock.couponRedemption.create).toHaveBeenCalledWith({
      data: { couponCodeId: 'cup-1', orderId: 'o-1', customerId: 'c-1', amountSaved: new Prisma.Decimal(10) },
    })
    expect(prismaMock.couponCode.update).toHaveBeenCalledWith({ where: { id: 'cup-1' }, data: { currentUses: { increment: 1 } } })
    expect(prismaMock.discount.update).toHaveBeenCalledWith({ where: { id: 'd-1' }, data: { currentUses: { increment: 1 } } })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('sin pagar no cuenta: el hook puede llegar con la cuenta abierta o cancelada', async () => {
    prismaMock.order.findFirst.mockResolvedValue({ customerId: null, paymentStatus: 'PENDING' } as any)
    await finalizeCouponsForOrder('v-1', 'o-1')
    expect(prismaMock.couponRedemption.create).not.toHaveBeenCalled()
  })

  it('ya contada: no toca nada', async () => {
    prismaMock.couponRedemption.findUnique.mockResolvedValue({ id: 'r-1', orderId: 'o-1' } as any)
    await finalizeCouponsForOrder('v-1', 'o-1')
    expect(prismaMock.couponRedemption.create).not.toHaveBeenCalled()
    expect(prismaMock.couponCode.update).not.toHaveBeenCalled()
  })

  it('dos cierres a la vez: el perdedor del índice único no lanza ni cuenta', async () => {
    prismaMock.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('único', { code: 'P2002', clientVersion: 'x', meta: { target: ['orderId'] } }),
    )
    await expect(finalizeCouponsForOrder('v-1', 'o-1')).resolves.toBeUndefined()
  })

  it('otro error de la base sí sube: lo registra quien lo llama', async () => {
    prismaMock.$transaction.mockRejectedValue(new Error('se cayó'))
    await expect(finalizeCouponsForOrder('v-1', 'o-1')).rejects.toThrow('se cayó')
  })

  it('sin cupón no pregunta nada más', async () => {
    prismaMock.orderDiscount.findMany.mockResolvedValue([])
    await finalizeCouponsForOrder('v-1', 'o-1')
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled()
  })
})

describe('textoDeRechazoDeCupon', () => {
  it.each([
    [{ errorCode: 'NOT_FOUND' }, 'No encontramos ese código de cupón.'],
    [{ errorCode: 'INACTIVE' }, 'Este cupón está inactivo.'],
    [{ errorCode: 'NOT_STARTED' }, 'Este cupón todavía no está vigente.'],
    [{ errorCode: 'EXPIRED' }, 'Este cupón ya venció.'],
    [{ errorCode: 'USAGE_LIMIT' }, 'Este cupón ya alcanzó su límite de usos.'],
    [{ errorCode: 'MIN_PURCHASE', limite: 150 }, 'Este cupón pide una compra mínima de $150.00.'],
    [{ errorCode: 'CUSTOMER_LIMIT', limite: 1 }, 'Este cliente ya usó este cupón 1 vez.'],
    [{ errorCode: 'CUSTOMER_LIMIT', limite: 3 }, 'Este cliente ya usó este cupón 3 veces.'],
    [{}, 'Este cupón no es válido.'],
  ])('%j', (r, texto) => {
    expect(textoDeRechazoDeCupon(r as any)).toBe(texto)
  })
})

describe('montoDelCupon: al centavo, como calculan las apps', () => {
  const pct = (v: number) => ({ type: 'PERCENTAGE', value: new Prisma.Decimal(v), maxDiscountAmount: null })
  it('10 % de $21.35 son $2.14 (el 2.135 en flotante daba $2.13)', () => expect(montoDelCupon(pct(10), 21.35)).toBe(2.14))
  it('15 % de $33.30 son $5.00', () => expect(montoDelCupon(pct(15), 33.3)).toBe(5))
  it('respeta el tope', () => expect(montoDelCupon({ ...pct(50), maxDiscountAmount: new Prisma.Decimal(20) }, 100)).toBe(20))
  it('fijo nunca pasa de la base', () => expect(montoDelCupon({ type: 'FIXED_AMOUNT', value: new Prisma.Decimal(50) }, 30)).toBe(30))
  it('COMP regala la base', () => expect(montoDelCupon({ type: 'COMP', value: new Prisma.Decimal(0) }, 30)).toBe(30))
})

describe('cuponDeLaVenta', () => {
  const cuponDb = (extra: Record<string, unknown> = {}, discount: Record<string, unknown> = {}) => ({
    id: 'cup-1',
    code: 'DESC10',
    active: true,
    maxUses: null,
    maxUsesPerCustomer: null,
    currentUses: 0,
    minPurchaseAmount: null,
    validFrom: null,
    validUntil: null,
    discount: { id: 'd-1', name: 'Diez', type: 'PERCENTAGE', value: 10, scope: 'ORDER', maxDiscountAmount: null, active: true, ...discount },
    ...extra,
  })

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.discount.findFirst.mockResolvedValue({ id: 'd-1', name: 'Diez', type: 'PERCENTAGE', value: 10, venueId: 'v-1' } as any)
  })

  it('normaliza el código y devuelve el descuento completo del negocio', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue(cuponDb() as any)
    const c = await cuponDeLaVenta(prismaMock as any, 'v-1', ' desc10 ', 100, null)
    expect(prismaMock.couponCode.findFirst.mock.calls[0][0]?.where).toMatchObject({ code: 'DESC10', discount: { venueId: 'v-1' } })
    expect(c).toMatchObject({ id: 'cup-1', code: 'DESC10', discount: { id: 'd-1', venueId: 'v-1' } })
  })

  it('un cupón por producto o categoría se rechaza: no se reparte a toda la cuenta', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue(cuponDb({}, { scope: 'ITEM' }) as any)
    await expect(cuponDeLaVenta(prismaMock as any, 'v-1', 'DESC10', 100, null)).rejects.toMatchObject({
      statusCode: 400,
      message: 'Este cupón sólo aplica a ciertos productos y todavía no se puede usar en caja.',
    })
  })

  it('vencido por el descuento padre, sin fecha propia: se rechaza', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue(cuponDb({}, { validUntil: new Date(Date.now() - 1000) }) as any)
    await expect(cuponDeLaVenta(prismaMock as any, 'v-1', 'DESC10', 100, null)).rejects.toMatchObject({ message: 'Este cupón ya venció.' })
  })

  it('la fecha propia del cupón manda sobre la del padre', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue(
      cuponDb({ validUntil: new Date(Date.now() + 60_000) }, { validUntil: new Date(Date.now() - 1000) }) as any,
    )
    await expect(cuponDeLaVenta(prismaMock as any, 'v-1', 'DESC10', 100, null)).resolves.toMatchObject({ id: 'cup-1' })
  })

  it('límite total del descuento padre agotado: se rechaza', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue(cuponDb({}, { maxTotalUses: 2, currentUses: 2 }) as any)
    await expect(cuponDeLaVenta(prismaMock as any, 'v-1', 'DESC10', 100, null)).rejects.toMatchObject({
      message: 'Este cupón ya alcanzó su límite de usos.',
    })
  })

  it('compra mínima del padre cuando el cupón no trae la suya', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue(cuponDb({}, { minPurchaseAmount: 150 }) as any)
    await expect(cuponDeLaVenta(prismaMock as any, 'v-1', 'DESC10', 100, null)).rejects.toMatchObject({
      message: 'Este cupón pide una compra mínima de $150.00.',
    })
  })
})

describe('cuponDeLaVenta: el límite por cliente del descuento padre (Codex r1 #2)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.discount.findFirst.mockResolvedValue({ id: 'd-1', venueId: 'v-1' } as any)
  })

  it('el código no trae límite propio: cuentan los canjes del cliente con cualquier código del descuento', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue({
      id: 'cup-1',
      code: 'DESC10',
      active: true,
      maxUses: null,
      maxUsesPerCustomer: null,
      currentUses: 0,
      minPurchaseAmount: null,
      validFrom: null,
      validUntil: null,
      discount: { id: 'd-1', name: 'Diez', type: 'PERCENTAGE', value: 10, scope: 'ORDER', active: true, maxUsesPerCustomer: 1 },
    } as any)
    prismaMock.couponRedemption.count.mockResolvedValue(1)
    await expect(cuponDeLaVenta(prismaMock as any, 'v-1', 'DESC10', 100, 'c-1')).rejects.toMatchObject({
      message: 'Este cliente ya usó este cupón 1 vez.',
    })
    expect(prismaMock.couponRedemption.count).toHaveBeenCalledWith({ where: { couponCode: { discountId: 'd-1' }, customerId: 'c-1' } })
  })
})

describe('apartarCupon: el último uso no se gasta dos veces (Codex r1 #1)', () => {
  const cupon = { id: 'cup-1', code: 'DESC10', discount: { id: 'd-1' }, minimo: null }
  const fresco = (extra: Record<string, unknown> = {}, discount: Record<string, unknown> = {}) => ({
    currentUses: 0,
    maxUses: null,
    maxUsesPerCustomer: null,
    discount: { id: 'd-1', currentUses: 0, maxTotalUses: null, maxUsesPerCustomer: null, ...discount },
    ...extra,
  })

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.orderDiscount.count.mockResolvedValue(0)
    prismaMock.couponRedemption.count.mockResolvedValue(0)
  })

  it('toma el candado del cupón antes de contar', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue(fresco() as any)
    await apartarCupon(prismaMock as any, 'v-1', cupon, null)
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    // Sin límites no cuenta nada: una venta sin límite no paga consultas.
    expect(prismaMock.orderDiscount.count).not.toHaveBeenCalled()
  })

  it('un uso libre, pero otra venta sin cobrar ya lo trae: agotado', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue(fresco({ maxUses: 1 }) as any)
    prismaMock.orderDiscount.count.mockResolvedValue(1)
    await expect(apartarCupon(prismaMock as any, 'v-1', cupon, null)).rejects.toMatchObject({
      statusCode: 400,
      message: 'Este cupón ya alcanzó su límite de usos.',
    })
    expect(prismaMock.orderDiscount.count).toHaveBeenCalledWith({
      where: {
        couponCodeId: 'cup-1',
        order: { venueId: 'v-1', paymentStatus: { in: ['PENDING', 'PARTIAL'] }, status: { notIn: ['CANCELLED', 'DELETED'] } },
      },
    })
  })

  it('el límite total del descuento padre también cuenta lo apartado', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue(fresco({}, { maxTotalUses: 3, currentUses: 2 }) as any)
    prismaMock.orderDiscount.count.mockResolvedValue(1)
    await expect(apartarCupon(prismaMock as any, 'v-1', cupon, null)).rejects.toMatchObject({ message: 'Este cupón ya alcanzó su límite de usos.' })
  })

  it('por cliente: un canje más una venta suya sin cobrar llenan un límite de 2', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue(fresco({ maxUsesPerCustomer: 2 }) as any)
    prismaMock.couponRedemption.count.mockResolvedValue(1)
    prismaMock.orderDiscount.count.mockResolvedValue(1)
    await expect(apartarCupon(prismaMock as any, 'v-1', cupon, 'c-1')).rejects.toMatchObject({ message: 'Este cliente ya usó este cupón 2 veces.' })
  })

  it('con cupo: no lanza', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue(fresco({ maxUses: 2 }) as any)
    prismaMock.orderDiscount.count.mockResolvedValue(1)
    await expect(apartarCupon(prismaMock as any, 'v-1', cupon, null)).resolves.toBeUndefined()
  })
})
