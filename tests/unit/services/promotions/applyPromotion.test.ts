import prisma from '@/utils/prismaClient'
import { applyPromotionToOrder } from '@/services/promotions/promotion.service'

const prismaMock = prisma as any

const promocionEnBase = () => ({
  id: 'promo-1',
  venueId: 'venue-1',
  name: 'Combo del día',
  type: 'BUNDLE',
  pricingMode: 'FIXED_TOTAL',
  priceCents: 9900,
  status: 'PUBLISHED',
  validFrom: null,
  validUntil: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  groups: [
    {
      id: 'g1',
      name: 'Plato',
      options: [
        {
          id: 'o1',
          productId: 'hamburguesa',
          quantity: 1,
          chargedQuantity: 1,
          priceDeltaCents: 0,
          product: { price: 80, venueId: 'venue-1', name: 'Hamburguesa', sku: 'HAM-01', category: { name: 'Cocina' } },
        },
      ],
    },
    {
      id: 'g2',
      name: 'Bebida',
      options: [
        {
          id: 'o2',
          productId: 'refresco',
          quantity: 1,
          chargedQuantity: 1,
          priceDeltaCents: 0,
          product: { price: 40, venueId: 'venue-1', name: 'Refresco', sku: null, category: null },
        },
      ],
    },
  ],
})

const params = (over: Record<string, unknown> = {}) => ({
  venueId: 'venue-1',
  orderId: 'order-1',
  promotionId: 'promo-1',
  instanceId: 'inst-abc',
  selections: [
    { groupId: 'g1', optionId: 'o1' },
    { groupId: 'g2', optionId: 'o2' },
  ],
  soldAt: new Date('2026-08-12T18:00:00Z'),
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction = jest.fn((cb: any) => cb(prismaMock))
  // Candado canónico de la orden (Plan3b): la orden existe en este venue.
  prismaMock.$queryRaw.mockResolvedValue([{ id: 'order-1' }])
  prismaMock.promotion.findFirst.mockResolvedValue(promocionEnBase())
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  prismaMock.orderPromotion.findUnique.mockResolvedValue(null)
  prismaMock.orderPromotion.create.mockResolvedValue({ id: 'op-1' })
  prismaMock.orderItem.createMany.mockResolvedValue({ count: 2 })
  // La orden viva del venue, y lo que el recálculo de totales lee dentro de la tx.
  prismaMock.order.findFirst.mockResolvedValue({ paymentStatus: 'PENDING', status: 'CONFIRMED', discountAmount: 0, paidAmount: 0 })
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.orderDiscount.findMany.mockResolvedValue([])
  prismaMock.orderServiceCharge.findMany.mockResolvedValue([])
  prismaMock.order.update.mockResolvedValue({})
})

describe('applyPromotionToOrder', () => {
  it('crea la instancia y sus líneas con los netos exactos', async () => {
    const result = await applyPromotionToOrder(params())

    expect(result).toMatchObject({ orderPromotionId: 'op-1', netCents: 9900 })
    const lineas = prismaMock.orderItem.createMany.mock.calls[0][0].data
    expect(lineas).toHaveLength(2)
    expect(lineas.reduce((s: number, l: any) => s + Math.round(Number(l.total) * 100), 0)).toBe(9900)
    expect(lineas.every((l: any) => l.orderPromotionId === 'op-1')).toBe(true)
  })

  it('🔴 todo va dentro de UNA transacción — no puede quedar media promoción', async () => {
    await applyPromotionToOrder(params())

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('un replay del mismo instanceId no duplica: devuelve el existente', async () => {
    prismaMock.orderPromotion.findUnique.mockResolvedValue({ id: 'op-previo', netCents: 9900 })

    const result = await applyPromotionToOrder(params())

    expect(result).toMatchObject({ orderPromotionId: 'op-previo' })
    expect(prismaMock.orderPromotion.create).not.toHaveBeenCalled()
    expect(prismaMock.orderItem.createMany).not.toHaveBeenCalled()
  })

  it('🔴 una promoción de OTRO venue no se aplica', async () => {
    prismaMock.promotion.findFirst.mockResolvedValue(null)

    await expect(applyPromotionToOrder(params({ venueId: 'venue-ajeno' }))).rejects.toThrow(/no encontr/i)
    expect(prismaMock.orderPromotion.create).not.toHaveBeenCalled()
  })

  it('una promoción en DRAFT no se aplica', async () => {
    prismaMock.promotion.findFirst.mockResolvedValue({ ...promocionEnBase(), status: 'DRAFT' })

    await expect(applyPromotionToOrder(params())).rejects.toThrow(/no está publicada/i)
  })

  it('una opción que no pertenece al grupo se rechaza', async () => {
    await expect(applyPromotionToOrder(params({ selections: [{ groupId: 'g1', optionId: 'o2' }] }))).rejects.toThrow(/opción/i)
    expect(prismaMock.orderPromotion.create).not.toHaveBeenCalled()
  })

  it('faltar un grupo por elegir se rechaza — no se arma media promoción', async () => {
    await expect(applyPromotionToOrder(params({ selections: [{ groupId: 'g1', optionId: 'o1' }] }))).rejects.toThrow(/elegir/i)
  })

  it('🔴 fuera de horario, la venta ENTRA pero a precio de lista y marcada', async () => {
    // Un 2x1 de 18:00 a 20:00, vendido offline a las 22:00 y sincronizado ahora.
    prismaMock.promotion.findFirst.mockResolvedValue({ ...promocionEnBase(), timeFrom: '18:00', timeUntil: '20:00' })

    const result = await applyPromotionToOrder(params({ soldAt: new Date('2026-08-13T04:00:00Z') }))

    expect(result.netCents).toBe(12000) // bruto: 80 + 40
    const creada = prismaMock.orderPromotion.create.mock.calls[0][0].data
    expect(creada).toMatchObject({ needsReview: true })
    expect(creada.reviewReason).toMatch(/vigencia/i)
  })

  it('🔴 vencida por FECHA (validUntil pasado), la venta ENTRA pero a precio de lista y marcada', async () => {
    // Audit max 2026-08-13: la vigencia solo checaba días/horas — una promo con
    // validUntil vencido pero aún PUBLISHED se aplicaba a precio de promo desde
    // un catálogo cacheado o un intent offline re-aplicado.
    prismaMock.promotion.findFirst.mockResolvedValue({ ...promocionEnBase(), validUntil: new Date('2026-08-01T23:59:59Z') })

    const result = await applyPromotionToOrder(params({ soldAt: new Date('2026-08-12T18:00:00Z') }))

    expect(result.netCents).toBe(12000) // precio de lista, no los 9900 de la promo
    const creada = prismaMock.orderPromotion.create.mock.calls[0][0].data
    expect(creada).toMatchObject({ needsReview: true })
  })

  it('aún no iniciada (validFrom futuro) también entra a precio de lista y marcada', async () => {
    prismaMock.promotion.findFirst.mockResolvedValue({ ...promocionEnBase(), validFrom: new Date('2026-09-01T00:00:00Z') })

    const result = await applyPromotionToOrder(params({ soldAt: new Date('2026-08-12T18:00:00Z') }))

    expect(result.netCents).toBe(12000)
    expect(prismaMock.orderPromotion.create.mock.calls[0][0].data.needsReview).toBe(true)
  })

  it('dentro de fechas válidas la promo aplica normal (regresión)', async () => {
    prismaMock.promotion.findFirst.mockResolvedValue({
      ...promocionEnBase(),
      validFrom: new Date('2026-08-01T00:00:00Z'),
      validUntil: new Date('2026-08-31T23:59:59Z'),
    })

    const result = await applyPromotionToOrder(params({ soldAt: new Date('2026-08-12T18:00:00Z') }))

    expect(result.netCents).toBe(9900)
    expect(prismaMock.orderPromotion.create.mock.calls[0][0].data.needsReview).toBe(false)
  })

  it('el snapshot guarda lo que se cobró, para que editar la promo no cambie el histórico', async () => {
    await applyPromotionToOrder(params())

    const creada = prismaMock.orderPromotion.create.mock.calls[0][0].data
    expect(creada.snapshotJson).toMatchObject({ name: 'Combo del día', pricingMode: 'FIXED_TOTAL', priceCents: 9900 })
  })

  it('🔴 aplicar recalcula los totales de la orden DENTRO de la transacción', async () => {
    // Audit 2026-08-13: sin esto, una ronda de puras promociones ACKeaba con el
    // total viejo y el combo salía de cocina sin cobrarse.
    await applyPromotionToOrder(params())

    expect(prismaMock.order.update).toHaveBeenCalled()
    const data = prismaMock.order.update.mock.calls[0][0].data
    expect(data).toHaveProperty('subtotal')
    expect(data).toHaveProperty('total')
  })

  it('🔴 a una cuenta PAGADA no se le agregan promociones', async () => {
    prismaMock.order.findFirst.mockResolvedValue({ paymentStatus: 'PAID', status: 'CONFIRMED', discountAmount: 0, paidAmount: 199 })

    await expect(applyPromotionToOrder(params())).rejects.toThrow(/pagada/i)
    expect(prismaMock.orderPromotion.create).not.toHaveBeenCalled()
  })

  it('a una cuenta cancelada tampoco', async () => {
    prismaMock.order.findFirst.mockResolvedValue({ paymentStatus: 'PENDING', status: 'CANCELLED', discountAmount: 0, paidAmount: 0 })

    await expect(applyPromotionToOrder(params())).rejects.toThrow(/cerrada/i)
  })

  it('🔴 una orden de OTRO venue no existe para esta promoción', async () => {
    prismaMock.order.findFirst.mockResolvedValue(null)

    await expect(applyPromotionToOrder(params())).rejects.toThrow(/cuenta/i)
    expect(prismaMock.orderPromotion.create).not.toHaveBeenCalled()
  })

  it('🔴 ARCHIVADA: la venta ENTRA a precio de lista y marcada — no se rechaza mercancía entregada', async () => {
    // Un 2x1 vendido offline a las 19:59 y archivado a las 20:05 sincroniza a
    // las 20:10: rechazar el intent lo mandaba a cuarentena para siempre.
    prismaMock.promotion.findFirst.mockResolvedValue({ ...promocionEnBase(), status: 'ARCHIVED' })

    const result = await applyPromotionToOrder(params())

    expect(result.netCents).toBe(12000) // precio de lista
    const creada = prismaMock.orderPromotion.create.mock.calls[0][0].data
    expect(creada).toMatchObject({ needsReview: true })
    expect(creada.reviewReason).toMatch(/archivada/i)
  })

  it('en DRAFT se sigue rechazando: nunca fue visible para un POS legítimo', async () => {
    prismaMock.promotion.findFirst.mockResolvedValue({ ...promocionEnBase(), status: 'DRAFT' })

    await expect(applyPromotionToOrder(params())).rejects.toThrow(/no está publicada/i)
  })

  it('🔴 un producto de OTRO venue dentro de la promoción se rechaza', async () => {
    const promo = promocionEnBase()
    promo.groups[0].options[0].product.venueId = 'venue-ajeno'
    prismaMock.promotion.findFirst.mockResolvedValue(promo)

    await expect(applyPromotionToOrder(params())).rejects.toThrow(/no pertenece/i)
    expect(prismaMock.orderPromotion.create).not.toHaveBeenCalled()
  })

  it('🔴 un chargedQuantity corrupto (negativo) en la definición se rechaza', async () => {
    const promo = promocionEnBase()
    promo.groups[0].options[0].chargedQuantity = -1
    prismaMock.promotion.findFirst.mockResolvedValue(promo)

    await expect(applyPromotionToOrder(params())).rejects.toThrow(/mal configurada/i)
  })

  it('🔴 la carrera del replay (P2002) devuelve al ganador, no truena', async () => {
    // Dos intents con el mismo instanceId pasan ambos el pre-read; el unique
    // detiene al segundo. Eso es "ya está aplicado", no un error del negocio.
    prismaMock.orderPromotion.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))
    prismaMock.orderPromotion.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'op-ganador', netCents: 9900 })

    const result = await applyPromotionToOrder(params())

    expect(result).toMatchObject({ orderPromotionId: 'op-ganador', netCents: 9900, created: false })
  })

  it('las líneas llevan el nombre del producto denormalizado (contrato Toast/Square)', async () => {
    await applyPromotionToOrder(params())

    const lineas = prismaMock.orderItem.createMany.mock.calls[0][0].data
    expect(lineas.map((l: any) => l.productName)).toEqual(['Hamburguesa', 'Refresco'])
    expect(lineas[0].productSku).toBe('HAM-01')
    expect(lineas[0].categoryName).toBe('Cocina')
  })

  it('🔴 las líneas de promoción NUNCA traen impuesto propio', async () => {
    // El motor de descuentos estima 16% fijo y lo resta de Order.taxAmount, que
    // en POS suele ser 0 porque el IVA va incluido — eso deja el impuesto en
    // negativo. Las promociones no juegan ese juego: el CFDI deriva el IVA del
    // neto por línea.
    await applyPromotionToOrder(params())

    const lineas = prismaMock.orderItem.createMany.mock.calls[0][0].data
    expect(lineas.every((l: any) => Number(l.taxAmount) === 0)).toBe(true)
  })
})

describe('extras de las piezas', () => {
  const grupoTermino = { id: 'g-termino', name: 'Término', required: false, allowMultiple: false, minSelections: 0, maxSelections: null }
  const conExtras = (extraIds: string[] = ['queso']) =>
    params({
      selections: [
        { groupId: 'g1', optionId: 'o1', modifierIds: extraIds },
        { groupId: 'g2', optionId: 'o2' },
      ],
    })

  beforeEach(() => {
    prismaMock.orderItem.create.mockResolvedValue({ id: 'oi-1' })
    prismaMock.productModifierGroup.findMany.mockResolvedValue([{ productId: 'hamburguesa', group: grupoTermino }])
    prismaMock.modifier.findMany.mockResolvedValue([{ id: 'queso', name: 'Queso', price: 15, groupId: 'g-termino' }])
  })

  const totalBase = async () => {
    jest.clearAllMocks()
    await applyPromotionToOrder(params())
    const lineas = prismaMock.orderItem.createMany.mock.calls[0][0].data
    const ham = lineas.find((l: any) => l.productId === 'hamburguesa')
    return { total: Number(ham.total), descuento: Number(ham.discountAmount) }
  }

  it('FIXED_TOTAL $99 + queso $15: el extra va encima, el combo no cambia', async () => {
    const base = await totalBase()
    jest.clearAllMocks()
    prismaMock.orderItem.create.mockResolvedValue({ id: 'oi-1' })
    prismaMock.productModifierGroup.findMany.mockResolvedValue([{ productId: 'hamburguesa', group: grupoTermino }])
    prismaMock.modifier.findMany.mockResolvedValue([{ id: 'queso', name: 'Queso', price: 15, groupId: 'g-termino' }])
    prismaMock.orderPromotion.findUnique.mockResolvedValue(null)
    prismaMock.orderPromotion.create.mockResolvedValue({ id: 'op-1' })

    await applyPromotionToOrder(conExtras())

    const ham = prismaMock.orderItem.create.mock.calls[0][0].data
    expect(ham.productId).toBe('hamburguesa')
    expect(Number(ham.total)).toBeCloseTo(base.total + 15, 2)
    expect(Number(ham.discountAmount)).toBeCloseTo(base.descuento, 2)
    expect(ham.modifiers.create).toEqual([{ modifierId: 'queso', name: 'Queso', quantity: 1, price: 15 }])
    // El refresco sigue por createMany, sin extras.
    expect(prismaMock.orderItem.createMany.mock.calls[0][0].data.map((l: any) => l.productId)).toEqual(['refresco'])
    const op = prismaMock.orderPromotion.create.mock.calls[0][0].data
    expect(op).toMatchObject({ netCents: 9900, needsReview: false, reviewReason: null })
    expect(op.snapshotJson.selections[0].extras).toEqual([{ modifierId: 'queso', name: 'Queso', priceCents: 1500 }])
  })

  it('PER_UNIT: el mismo extra suma $15 encima', async () => {
    prismaMock.promotion.findFirst.mockResolvedValue({ ...promocionEnBase(), pricingMode: 'PER_UNIT', priceCents: 0 })

    await applyPromotionToOrder(conExtras())

    const ham = prismaMock.orderItem.create.mock.calls[0][0].data
    expect(Number(ham.total)).toBeCloseTo(80 + 15, 2)
    expect(prismaMock.orderPromotion.create.mock.calls[0][0].data.netCents).toBe(12000)
  })

  it('fuera de vigencia: lista + $15, la razón de vigencia se conserva y se añaden las de extras', async () => {
    prismaMock.promotion.findFirst.mockResolvedValue({ ...promocionEnBase(), validUntil: new Date('2026-01-01T00:00:00Z') })
    prismaMock.productModifierGroup.findMany.mockResolvedValue([{ productId: 'hamburguesa', group: { ...grupoTermino, required: true } }])

    await applyPromotionToOrder(conExtras([]))

    const op = prismaMock.orderPromotion.create.mock.calls[0][0].data
    expect(op.needsReview).toBe(true)
    expect(op.reviewReason).toMatch(/vigencia/i)
    expect(op.reviewReason).toContain('Faltó elegir «Término» de Hamburguesa.')

    jest.clearAllMocks()
    prismaMock.orderPromotion.findUnique.mockResolvedValue(null)
    prismaMock.orderPromotion.create.mockResolvedValue({ id: 'op-1' })
    prismaMock.orderItem.create.mockResolvedValue({ id: 'oi-1' })
    prismaMock.productModifierGroup.findMany.mockResolvedValue([{ productId: 'hamburguesa', group: grupoTermino }])
    prismaMock.modifier.findMany.mockResolvedValue([{ id: 'queso', name: 'Queso', price: 15, groupId: 'g-termino' }])
    await applyPromotionToOrder(conExtras())
    expect(Number(prismaMock.orderItem.create.mock.calls[0][0].data.total)).toBeCloseTo(80 + 15, 2)
  })

  it('obligatorio faltante no lanza: needsReview con la razón', async () => {
    prismaMock.productModifierGroup.findMany.mockResolvedValue([{ productId: 'hamburguesa', group: { ...grupoTermino, required: true } }])

    await expect(applyPromotionToOrder(conExtras([]))).resolves.toMatchObject({ created: true })

    const op = prismaMock.orderPromotion.create.mock.calls[0][0].data
    expect(op.needsReview).toBe(true)
    expect(op.reviewReason).toContain('Faltó elegir «Término» de Hamburguesa.')
    expect(prismaMock.orderItem.create).not.toHaveBeenCalled()
  })

  it('sin llave no consulta modificadores', async () => {
    await applyPromotionToOrder(params())

    expect(prismaMock.productModifierGroup.findMany).not.toHaveBeenCalled()
    expect(prismaMock.modifier.findMany).not.toHaveBeenCalled()
    expect(prismaMock.orderItem.create).not.toHaveBeenCalled()
    expect(prismaMock.orderItem.createMany.mock.calls[0][0].data).toHaveLength(2)
    expect(prismaMock.orderPromotion.create.mock.calls[0][0].data).toMatchObject({ needsReview: false, reviewReason: null })
  })

  it('reintento con el mismo instanceId: no crea renglones ni filas', async () => {
    prismaMock.orderPromotion.findUnique.mockResolvedValue({ id: 'op-previo', netCents: 9900 })

    await applyPromotionToOrder(conExtras())

    expect(prismaMock.orderItem.create).not.toHaveBeenCalled()
    expect(prismaMock.orderItem.createMany).not.toHaveBeenCalled()
  })

  it('las consultas llevan tope y llegar al tope de grupos marca revisión', async () => {
    const liga = { productId: 'hamburguesa', group: grupoTermino }
    prismaMock.productModifierGroup.findMany.mockResolvedValue(Array.from({ length: 50 }, () => liga))

    await applyPromotionToOrder(conExtras())

    expect(prismaMock.productModifierGroup.findMany.mock.calls[0][0].take).toBe(50)
    expect(prismaMock.modifier.findMany.mock.calls[0][0].take).toBe(1)
    const op = prismaMock.orderPromotion.create.mock.calls[0][0].data
    expect(op.needsReview).toBe(true)
    expect(op.reviewReason).toContain('No se revisaron todos los grupos de modificadores')
  })

  it('modificador de otro venue se omite: la consulta filtra por venueId', async () => {
    prismaMock.modifier.findMany.mockResolvedValue([])

    await applyPromotionToOrder(conExtras(['ajeno']))

    expect(prismaMock.modifier.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['ajeno'] }, group: { venueId: 'venue-1' } })
    expect(prismaMock.productModifierGroup.findMany.mock.calls[0][0].where).toMatchObject({ group: { venueId: 'venue-1', active: true } })
    expect(prismaMock.orderItem.create).not.toHaveBeenCalled()
    const op = prismaMock.orderPromotion.create.mock.calls[0][0].data
    expect(op.needsReview).toBe(true)
    expect(op.reviewReason).toContain('ya no existe')
  })
})
