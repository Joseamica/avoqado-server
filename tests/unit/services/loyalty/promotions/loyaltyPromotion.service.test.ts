/**
 * API del panel de promociones de lealtad (plan 2026-11-12-promo-de-lealtad, Task 9): fechas del negocio a instantes UTC (regla 15:
 * nunca empieza antes de crearse), «activa = sólo fecha de fin», tope de 10 vivas bajo candado, productos del mismo negocio,
 * ActivityLog y listado acotado. Correr también con `TZ=UTC` (el código no debe depender de la zona del proceso).
 * La concurrencia real del tope (dos altas a la vez con 9) vive en tests/integration/loyalty/loyaltyPromotion.integration.test.ts.
 */
import { prismaMock } from '../../../../__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  createLoyaltyPromotion,
  endLoyaltyPromotion,
  listLoyaltyPromotions,
  updateLoyaltyPromotion,
} from '@/services/loyalty/promotions/loyaltyPromotion.service'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import logger from '@/config/logger'
import { CreateLoyaltyPromotionSchema, ListLoyaltyPromotionsSchema } from '@/schemas/dashboard/loyaltyPromotion.schema'

const V = 'cvenue0000000000000000001'
const STAFF = 'cstaff0000000000000000001'
const P = 'cpromo0000000000000000001'

const relojEn = (iso: string) =>
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: [
      'nextTick',
      'setImmediate',
      'queueMicrotask',
      'setTimeout',
      'setInterval',
      'clearTimeout',
      'clearInterval',
      'clearImmediate',
    ],
  })

const fila = (o: Record<string, unknown> = {}) => ({
  id: P,
  venueId: V,
  name: 'Buen Fin sello doble',
  kind: 'MULTIPLY',
  multiplier: 2,
  extraStamps: null,
  extraPoints: null,
  startsAt: new Date('2026-11-13T06:00:00.000Z'),
  endsAt: new Date('2026-11-18T05:59:59.999Z'),
  endedAt: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  productIds: [],
  categoryIds: [],
  categoryProductIds: [],
  minSpend: null,
  limit: 'NONE',
  createdById: 'csv',
  createdAt: new Date('2026-11-12T12:00:00.000Z'),
  updatedAt: new Date('2026-11-12T12:00:00.000Z'),
  ...o,
})

const base = { name: 'Buen Fin sello doble', kind: 'MULTIPLY' as const, multiplier: 2, startDate: '2026-11-13', endDate: '2026-11-17' }

beforeEach(() => {
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  prismaMock.staffVenue.findUnique.mockResolvedValue({ id: 'csv' })
  prismaMock.loyaltyPromotion.count.mockResolvedValue(0)
  prismaMock.loyaltyPromotion.findMany.mockResolvedValue([])
  prismaMock.loyaltyPromotion.create.mockImplementation(async ({ data }: any) => fila({ ...data }))
  prismaMock.loyaltyPromotion.update.mockImplementation(async ({ data }: any) => fila({ ...data }))
  prismaMock.product.count.mockResolvedValue(0)
  prismaMock.product.findMany.mockResolvedValue([])
  prismaMock.menuCategory.count.mockResolvedValue(0)
  prismaMock.menuCategory.findMany.mockResolvedValue([])
})

afterEach(() => jest.useRealTimers())

describe('crear', () => {
  it('crea con fechas del negocio y guarda instantes UTC correctos (TZ=UTC)', async () => {
    relojEn('2026-11-12T12:00:00.000Z') // 06:00 del 12 en CDMX

    const r = await createLoyaltyPromotion(V, base, STAFF)

    const data = prismaMock.loyaltyPromotion.create.mock.calls[0][0].data
    expect(data.startsAt).toEqual(new Date('2026-11-13T06:00:00.000Z')) // 13-nov 00:00 CDMX
    expect(data.endsAt).toEqual(new Date('2026-11-18T05:59:59.999Z')) // 17-nov 23:59:59.999 CDMX
    expect(data).toMatchObject({ venueId: V, createdById: 'csv', kind: 'MULTIPLY', multiplier: 2, limit: 'NONE' })
    expect(r).toMatchObject({ id: P, status: 'SCHEDULED', startDate: '2026-11-13', endDate: '2026-11-17' })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOYALTY_PROMOTION_CREATED', entity: 'LoyaltyPromotion', entityId: P, staffId: STAFF, venueId: V }),
    )
  })

  it('«desde hoy» creada a las 15:00 guarda startsAt = 15:00 (Review Focus 4, regla 15)', async () => {
    relojEn('2026-11-12T21:00:00.000Z') // 15:00 CDMX

    const r = await createLoyaltyPromotion(V, { ...base, startDate: '2026-11-12' }, STAFF)

    expect(prismaMock.loyaltyPromotion.create.mock.calls[0][0].data.startsAt).toEqual(new Date('2026-11-12T21:00:00.000Z'))
    expect(r.status).toBe('ACTIVE')
  })

  it('regla 15: startsAt nunca es anterior al momento de guardar, aunque el candado haya hecho esperar (fix r1 #1)', async () => {
    relojEn('2026-11-12T21:00:00.000Z') // 15:00 CDMX: se valida y se precalcula aquí
    prismaMock.$transaction.mockImplementationOnce(async (cb: any) => {
      jest.setSystemTime(new Date('2026-11-12T21:00:05.000Z')) // otra alta tenía el candado 5 s
      return cb(prismaMock)
    })

    await createLoyaltyPromotion(V, { ...base, startDate: '2026-11-12' }, STAFF)

    expect(prismaMock.loyaltyPromotion.create.mock.calls[0][0].data.startsAt).toEqual(new Date('2026-11-12T21:00:05.000Z'))
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ startsAt: '2026-11-12T21:00:05.000Z' }) }),
    )
  })

  it('gasto mínimo: tope de Decimal(12,2) y 2 decimales, en el servicio y en el zod (fix r1 #2)', async () => {
    relojEn('2026-11-12T12:00:00.000Z')
    for (const minSpend of [10_000_000, 1.005])
      await expect(createLoyaltyPromotion(V, { ...base, minSpend }, STAFF)).rejects.toThrow(BadRequestError)
    expect(prismaMock.loyaltyPromotion.create).not.toHaveBeenCalled()
    await createLoyaltyPromotion(V, { ...base, minSpend: 9_999_999.99 }, STAFF)
    expect(prismaMock.loyaltyPromotion.create.mock.calls[0][0].data.minSpend.toFixed(2)).toBe('9999999.99')

    const zod = (minSpend: number) => CreateLoyaltyPromotionSchema.safeParse({ params: { venueId: V }, body: { ...base, minSpend } })
    expect(zod(19.99).success).toBe(true)
    expect(zod(9_999_999.99).success).toBe(true)
    for (const malo of [10_000_000, 1.005, -1]) {
      const r = zod(malo)
      expect(r.success).toBe(false)
      expect(JSON.stringify((r as any).error.issues)).toMatch(/gasto mínimo/)
    }
  })

  it('rechaza inicio de ayer; «hoy» es el día del NEGOCIO aunque en UTC ya sea mañana', async () => {
    relojEn('2026-11-13T03:00:00.000Z') // 21:00 del 12 en CDMX

    await expect(createLoyaltyPromotion(V, { ...base, startDate: '2026-11-11' }, STAFF)).rejects.toThrow(BadRequestError)
    await expect(createLoyaltyPromotion(V, { ...base, startDate: '2026-11-11' }, STAFF)).rejects.toThrow('antes de hoy')
    expect(prismaMock.loyaltyPromotion.create).not.toHaveBeenCalled()

    await createLoyaltyPromotion(V, { ...base, startDate: '2026-11-12' }, STAFF)
    expect(prismaMock.loyaltyPromotion.create.mock.calls[0][0].data.startsAt).toEqual(new Date('2026-11-13T03:00:00.000Z'))
  })

  it('rechaza extraStamps 10 (ruling 6: 1–9)', async () => {
    relojEn('2026-11-12T12:00:00.000Z')
    const sumar = (extraStamps: number) => createLoyaltyPromotion(V, { ...base, kind: 'ADD', multiplier: null, extraStamps }, STAFF)

    await expect(sumar(10)).rejects.toThrow(BadRequestError)
    expect(prismaMock.loyaltyPromotion.create).not.toHaveBeenCalled()
    await sumar(9)
    expect(prismaMock.loyaltyPromotion.create).toHaveBeenCalledTimes(1)
  })

  it('rechaza la 11ª: cuenta las vivas DESPUÉS de tomar el candado del negocio', async () => {
    relojEn('2026-11-12T12:00:00.000Z')
    prismaMock.loyaltyPromotion.count.mockResolvedValue(10)

    await expect(createLoyaltyPromotion(V, base, STAFF)).rejects.toThrow(ConflictError)
    expect(prismaMock.loyaltyPromotion.create).not.toHaveBeenCalled()

    const candado = prismaMock.$executeRaw.mock.invocationCallOrder[0]
    expect(candado).toBeLessThan(prismaMock.loyaltyPromotion.count.mock.invocationCallOrder[0])
    expect(prismaMock.$executeRaw.mock.calls[0][0].join('?')).toContain('pg_advisory_xact_lock')
    expect(prismaMock.loyaltyPromotion.count.mock.calls[0][0].where).toEqual({
      venueId: V,
      endedAt: null,
      OR: [{ endsAt: null }, { endsAt: { gte: expect.any(Date) } }],
    })
  })

  it('rechaza productos de otro negocio', async () => {
    relojEn('2026-11-12T12:00:00.000Z')
    prismaMock.product.count.mockResolvedValue(1) // de 2 pedidos, sólo 1 es de este negocio

    await expect(createLoyaltyPromotion(V, { ...base, productIds: ['cprod1', 'cprod2'] }, STAFF)).rejects.toThrow(BadRequestError)
    expect(prismaMock.product.count).toHaveBeenCalledWith({ where: { venueId: V, id: { in: ['cprod1', 'cprod2'] } } })
    expect(prismaMock.loyaltyPromotion.create).not.toHaveBeenCalled()
  })

  it.each<[string, Record<string, unknown>]>([
    ['multiplicador 1', { multiplier: 1 }],
    ['multiplicador 11', { multiplier: 11 }],
    ['multiplicador no entero', { multiplier: 2.5 }],
    ['multiplica con sellos extra', { extraStamps: 1 }],
    ['suma sin nada', { kind: 'ADD', multiplier: null }],
    ['suma con multiplicador', { kind: 'ADD', extraPoints: 50 }],
    ['puntos extra 10,001', { kind: 'ADD', multiplier: null, extraPoints: 10001 }],
    ['productos y categorías a la vez', { productIds: ['cprod1'], categoryIds: ['ccat1'] }],
    ['hora de inicio sin la de fin', { timeFrom: '16:00' }],
    ['hora 25:00', { timeFrom: '25:00', timeUntil: '26:00' }],
    ['día 7', { daysOfWeek: [7] }],
    ['gasto mínimo negativo', { minSpend: -1 }],
    ['fin antes del inicio', { startDate: '2026-11-15', endDate: '2026-11-14' }],
    ['nombre vacío', { name: '   ' }],
    ['nombre de 81', { name: 'x'.repeat(81) }],
    ['fecha que no existe', { startDate: '2026-11-31' }],
    ['límite desconocido', { limit: 'WEEKLY' }],
  ])('rechaza: %s', async (_caso, cambio) => {
    relojEn('2026-11-12T12:00:00.000Z')
    await expect(createLoyaltyPromotion(V, { ...base, ...cambio } as any, STAFF)).rejects.toThrow(BadRequestError)
    expect(prismaMock.loyaltyPromotion.create).not.toHaveBeenCalled()
  })
})

// Codex código r1 #2 (ruling): foto de los productos de las categorías al guardar. Una venta sin red de un producto que después
// cambió de categoría sigue calificando por lo que el producto era cuando el dueño armó la promo.
describe('foto de los productos de las categorías', () => {
  const cats = ['ccat1', 'ccat2']

  it('al crear con categorías guarda los productos que hoy están en ellas (consulta acotada y ordenada por id)', async () => {
    relojEn('2026-11-12T12:00:00.000Z')
    prismaMock.menuCategory.count.mockResolvedValue(2)
    prismaMock.product.findMany.mockResolvedValue([{ id: 'cprod1' }, { id: 'cprod2' }])

    await createLoyaltyPromotion(V, { ...base, categoryIds: cats }, STAFF)

    expect(prismaMock.product.findMany).toHaveBeenCalledWith({
      where: { venueId: V, categoryId: { in: cats } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 5001,
    })
    expect(prismaMock.loyaltyPromotion.create.mock.calls[0][0].data).toMatchObject({
      categoryIds: cats,
      categoryProductIds: ['cprod1', 'cprod2'],
    })
  })

  it('más de 5,000 productos: guarda los primeros 5,000 por id y avisa en el log', async () => {
    relojEn('2026-11-12T12:00:00.000Z')
    prismaMock.menuCategory.count.mockResolvedValue(2)
    const muchos = Array.from({ length: 5001 }, (_, i) => ({ id: `cprod${String(i).padStart(5, '0')}` }))
    prismaMock.product.findMany.mockResolvedValue(muchos)

    await createLoyaltyPromotion(V, { ...base, categoryIds: cats }, STAFF)

    const guardados = prismaMock.loyaltyPromotion.create.mock.calls[0][0].data.categoryProductIds
    expect(guardados).toHaveLength(5000)
    expect(guardados[4999]).toBe('cprod04999')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('5,000'), expect.objectContaining({ venueId: V }))
  })

  it('sin categorías no consulta productos y la foto queda vacía', async () => {
    relojEn('2026-11-12T12:00:00.000Z')

    await createLoyaltyPromotion(V, base, STAFF)

    expect(prismaMock.product.findMany).not.toHaveBeenCalled()
    expect(prismaMock.loyaltyPromotion.create.mock.calls[0][0].data.categoryProductIds).toEqual([])
  })

  it('programada: editar las categorías vuelve a tomar la foto; editar otro campo no la toca', async () => {
    relojEn('2026-11-12T12:00:00.000Z')
    prismaMock.loyaltyPromotion.findFirst.mockResolvedValue(fila({ categoryIds: ['ccat1'], categoryProductIds: ['cviejo'] }))
    prismaMock.menuCategory.count.mockResolvedValue(1)
    prismaMock.product.findMany.mockResolvedValue([{ id: 'cnuevo' }])

    await updateLoyaltyPromotion(V, P, { categoryIds: ['ccat2'] }, STAFF)
    expect(prismaMock.loyaltyPromotion.update.mock.calls[0][0].data).toMatchObject({
      categoryIds: ['ccat2'],
      categoryProductIds: ['cnuevo'],
    })

    prismaMock.product.findMany.mockClear()
    await updateLoyaltyPromotion(V, P, { name: 'Otro nombre' }, STAFF)
    expect(prismaMock.product.findMany).not.toHaveBeenCalled()
    expect(prismaMock.loyaltyPromotion.update.mock.calls[1][0].data).not.toHaveProperty('categoryProductIds')
  })

  it('programada: pasar de categorías a productos limpia la foto', async () => {
    relojEn('2026-11-12T12:00:00.000Z')
    prismaMock.loyaltyPromotion.findFirst.mockResolvedValue(fila({ categoryIds: ['ccat1'], categoryProductIds: ['cviejo'] }))
    prismaMock.product.count.mockResolvedValue(1)

    await updateLoyaltyPromotion(V, P, { categoryIds: [], productIds: ['cprod1'] }, STAFF)

    expect(prismaMock.loyaltyPromotion.update.mock.calls[0][0].data).toMatchObject({ productIds: ['cprod1'], categoryProductIds: [] })
  })
})

describe('editar y terminar', () => {
  const activa = () => fila({ startsAt: new Date('2026-11-13T06:00:00.000Z') }) // empezó el 13; fin 17

  it('activa: rechaza fin de ayer, acepta fin de hoy', async () => {
    relojEn('2026-11-14T18:00:00.000Z') // 12:00 del 14 en CDMX
    prismaMock.loyaltyPromotion.findFirst.mockResolvedValue(activa())

    await expect(updateLoyaltyPromotion(V, P, { endDate: '2026-11-13' }, STAFF)).rejects.toThrow(BadRequestError)
    expect(prismaMock.loyaltyPromotion.update).not.toHaveBeenCalled()

    await updateLoyaltyPromotion(V, P, { endDate: '2026-11-14' }, STAFF)
    expect(prismaMock.loyaltyPromotion.update).toHaveBeenCalledWith({
      where: { id: P, venueId: V },
      data: { endsAt: new Date('2026-11-15T05:59:59.999Z') },
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOYALTY_PROMOTION_UPDATED', entity: 'LoyaltyPromotion', entityId: P, staffId: STAFF, venueId: V }),
    )
  })

  it('activa: sólo cambia endDate (otro campo → 409)', async () => {
    relojEn('2026-11-14T18:00:00.000Z')
    prismaMock.loyaltyPromotion.findFirst.mockResolvedValue(activa())

    await expect(updateLoyaltyPromotion(V, P, { name: 'Otro nombre' }, STAFF)).rejects.toThrow(ConflictError)
    await expect(updateLoyaltyPromotion(V, P, { multiplier: 3, endDate: '2026-11-20' }, STAFF)).rejects.toThrow(ConflictError)
    expect(prismaMock.loyaltyPromotion.update).not.toHaveBeenCalled()
  })

  it('programada: edita todo y recalcula startsAt con la regla 15', async () => {
    relojEn('2026-11-12T12:00:00.000Z')
    prismaMock.loyaltyPromotion.findFirst.mockResolvedValue(fila())

    await updateLoyaltyPromotion(V, P, { kind: 'ADD', multiplier: null, extraPoints: 50, startDate: '2026-11-12' }, STAFF)

    const data = prismaMock.loyaltyPromotion.update.mock.calls[0][0].data
    expect(data).toMatchObject({ kind: 'ADD', multiplier: null, extraPoints: 50, name: 'Buen Fin sello doble' })
    expect(data.startsAt).toEqual(new Date('2026-11-12T12:00:00.000Z')) // hoy desde las 06:00 → desde ahora
    expect(data.endsAt).toEqual(new Date('2026-11-18T05:59:59.999Z')) // el fin guardado se conserva
  })

  it('terminada: no se edita', async () => {
    relojEn('2026-11-14T18:00:00.000Z')
    prismaMock.loyaltyPromotion.findFirst.mockResolvedValue(fila({ endedAt: new Date('2026-11-14T17:00:00.000Z') }))
    await expect(updateLoyaltyPromotion(V, P, { endDate: '2026-11-20' }, STAFF)).rejects.toThrow(ConflictError)
  })

  it('promo de otro negocio → no encontrada', async () => {
    prismaMock.loyaltyPromotion.findFirst.mockResolvedValue(null)
    await expect(updateLoyaltyPromotion(V, P, { endDate: '2026-11-20' }, STAFF)).rejects.toThrow(NotFoundError)
    await expect(endLoyaltyPromotion(V, P, STAFF)).rejects.toThrow(NotFoundError)
    expect(prismaMock.loyaltyPromotion.findFirst).toHaveBeenCalledWith({ where: { id: P, venueId: V } })
  })

  it('terminar guarda endedAt y escribe ActivityLog', async () => {
    relojEn('2026-11-14T18:00:00.000Z')
    prismaMock.loyaltyPromotion.findFirst.mockResolvedValue(activa())

    const r = await endLoyaltyPromotion(V, P, STAFF)

    expect(prismaMock.loyaltyPromotion.update).toHaveBeenCalledWith({
      where: { id: P, venueId: V },
      data: { endedAt: new Date('2026-11-14T18:00:00.000Z') },
    })
    expect(r.status).toBe('ENDED')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOYALTY_PROMOTION_ENDED', entity: 'LoyaltyPromotion', entityId: P, staffId: STAFF, venueId: V }),
    )
  })

  it('terminar una ya terminada no cambia nada ni audita de nuevo (doble clic)', async () => {
    relojEn('2026-11-14T18:00:00.000Z')
    prismaMock.loyaltyPromotion.findFirst.mockResolvedValue(fila({ endedAt: new Date('2026-11-14T17:00:00.000Z') }))

    expect((await endLoyaltyPromotion(V, P, STAFF)).status).toBe('ENDED')
    expect(prismaMock.loyaltyPromotion.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
})

describe('listar', () => {
  it('página: el zod rechaza más de 10,000 y el servicio la recorta (sin desbordar el skip, fix r1 #3)', async () => {
    const q = (page: string) => ListLoyaltyPromotionsSchema.safeParse({ params: { venueId: V }, query: { page } })
    expect(q('10000').success).toBe(true)
    const r = q('10001')
    expect(r.success).toBe(false)
    expect(JSON.stringify((r as any).error.issues)).toMatch(/página/)

    await listLoyaltyPromotions(V, { page: 1e15, pageSize: 100 })
    expect(prismaMock.loyaltyPromotion.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 9999 * 100, take: 100 }))
  })

  it('listado con pageSize 500 se recorta a 100 y trae total', async () => {
    relojEn('2026-11-14T18:00:00.000Z')
    prismaMock.loyaltyPromotion.count.mockResolvedValue(237)
    prismaMock.loyaltyPromotion.findMany.mockResolvedValue([fila({ productIds: ['cprod1'] })])
    prismaMock.product.findMany.mockResolvedValue([{ id: 'cprod1', name: 'Manicure' }])

    const r = await listLoyaltyPromotions(V, { pageSize: 500 })

    expect(r).toMatchObject({ total: 237, page: 1, pageSize: 100 })
    expect(prismaMock.loyaltyPromotion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: V }, skip: 0, take: 100, orderBy: [{ startsAt: 'desc' }, { id: 'desc' }] }),
    )
    expect(r.items[0]).toMatchObject({ status: 'ACTIVE', products: [{ id: 'cprod1', name: 'Manicure' }] })
    expect(prismaMock.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: V, id: { in: ['cprod1'] } } }))
  })

  it('filtra por estado en la base y pagina con el default 50', async () => {
    const ahora = new Date('2026-11-14T18:00:00.000Z')
    relojEn(ahora.toISOString())

    await listLoyaltyPromotions(V, { status: 'SCHEDULED', page: 3 })
    expect(prismaMock.loyaltyPromotion.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { venueId: V, endedAt: null, OR: [{ endsAt: null }, { endsAt: { gte: ahora } }], startsAt: { gt: ahora } },
        skip: 100,
        take: 50,
      }),
    )

    await listLoyaltyPromotions(V, { status: 'ENDED' })
    expect(prismaMock.loyaltyPromotion.count).toHaveBeenLastCalledWith({
      where: { venueId: V, OR: [{ endedAt: { not: null } }, { endsAt: { lt: ahora } }] },
    })
  })
})
