jest.unmock('@/services/dashboard/activity-log.service')

import prisma from '@/utils/prismaClient'
import {
  archivePromotion,
  createPromotion,
  deletePromotion,
  getPromotions,
  publishPromotion,
  unarchivePromotion,
  updatePromotion,
} from '@/services/dashboard/promotion.dashboard.service'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

const prismaMock = prisma as any

const filaPromo = (over: Record<string, any> = {}) => ({
  id: 'promo-1',
  venueId: 'venue-1',
  name: 'Combo del día',
  description: null,
  imageUrl: null,
  type: 'BUNDLE',
  pricingMode: 'FIXED_TOTAL',
  priceCents: 9900,
  status: 'DRAFT',
  displayOrder: 0,
  validFrom: null,
  validUntil: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  createdAt: new Date('2026-08-14T00:00:00Z'),
  updatedAt: new Date('2026-08-14T00:00:00Z'),
  groups: [
    {
      id: 'g1',
      name: 'Plato',
      displayOrder: 0,
      minSelect: 1,
      maxSelect: 1,
      options: [{ id: 'o1', productId: 'p1', quantity: 1, chargedQuantity: 1, priceDeltaCents: 0, displayOrder: 0 }],
    },
  ],
  ...over,
})

const crearBody = (over: Record<string, any> = {}) => ({
  name: 'Combo del día',
  type: 'BUNDLE' as const,
  pricingMode: 'FIXED_TOTAL' as const,
  price: 99,
  displayOrder: 0,
  daysOfWeek: [],
  groups: [{ name: 'Plato', options: [{ productId: 'p1', quantity: 1, chargedQuantity: 1, priceDelta: 0 }] }],
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction = jest.fn((cb: any) => cb(prismaMock))
  prismaMock.promotion.findFirst.mockResolvedValue(filaPromo())
  prismaMock.promotion.findMany.mockResolvedValue([filaPromo()])
  prismaMock.promotion.count.mockResolvedValue(1)
  prismaMock.promotion.create.mockResolvedValue(filaPromo())
  prismaMock.promotion.update.mockResolvedValue(filaPromo())
  prismaMock.promotion.updateMany.mockResolvedValue({ count: 1 }) // CAS de estado
  prismaMock.promotion.delete.mockResolvedValue({})
  prismaMock.promotionGroup.deleteMany.mockResolvedValue({ count: 1 })
  prismaMock.orderPromotion.count.mockResolvedValue(0)
  prismaMock.product.findMany.mockResolvedValue([{ id: 'p1', venueId: 'venue-1', active: true, name: 'Hamburguesa' }])
  prismaMock.activityLog.create.mockResolvedValue({})
})

describe('promotion.dashboard.service', () => {
  describe('getPromotions', () => {
    it('pagina, filtra por venue y devuelve el precio en PESOS', async () => {
      const result = await getPromotions('venue-1', 1, 20)

      expect(prismaMock.promotion.findMany.mock.calls[0][0].where).toMatchObject({ venueId: 'venue-1' })
      expect(result.data[0].price).toBe(99)
      expect(result.meta).toMatchObject({ totalCount: 1, currentPage: 1 })
    })

    it('filtra por status cuando se pide', async () => {
      await getPromotions('venue-1', 1, 20, 'PUBLISHED')

      expect(prismaMock.promotion.findMany.mock.calls[0][0].where).toMatchObject({ venueId: 'venue-1', status: 'PUBLISHED' })
    })
  })

  describe('createPromotion', () => {
    it('crea SIEMPRE en DRAFT, convirtiendo pesos → centavos', async () => {
      await createPromotion('venue-1', crearBody({ price: 99.5 }) as any, 'staff-1')

      const data = prismaMock.promotion.create.mock.calls[0][0].data
      expect(data.status).toBe('DRAFT')
      expect(data.priceCents).toBe(9950)
      expect(data.groups.create[0].options.create[0].priceDeltaCents).toBe(0)
    })

    it('🔴 un producto de OTRO venue no entra ni en DRAFT', async () => {
      prismaMock.product.findMany.mockResolvedValue([]) // el where con venueId no lo encontró

      await expect(createPromotion('venue-1', crearBody() as any, 'staff-1')).rejects.toThrow(/no pertenece|no existe/i)
      expect(prismaMock.promotion.create).not.toHaveBeenCalled()
    })

    it('audita la creación con el actor', async () => {
      await createPromotion('venue-1', crearBody() as any, 'staff-1')
      await new Promise(setImmediate)

      expect(prismaMock.activityLog.create).toHaveBeenCalled()
      const log = prismaMock.activityLog.create.mock.calls[0][0].data
      expect(log).toMatchObject({ action: 'PROMOTION_CREATED', entity: 'Promotion', staffId: 'staff-1', venueId: 'venue-1' })
    })
  })

  describe('updatePromotion', () => {
    it('si vienen groups, REEMPLAZA la estructura completa en una transacción', async () => {
      await updatePromotion('venue-1', 'promo-1', crearBody() as any, 'staff-1')

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
      expect(prismaMock.promotionGroup.deleteMany).toHaveBeenCalledWith({ where: { promotionId: 'promo-1' } })
      expect(prismaMock.promotion.update).toHaveBeenCalled()
    })

    it('sin groups en el body, NO toca la estructura', async () => {
      await updatePromotion('venue-1', 'promo-1', { name: 'Nuevo nombre' } as any, 'staff-1')

      expect(prismaMock.promotionGroup.deleteMany).not.toHaveBeenCalled()
    })

    it('🔴 una promoción de otro venue no se edita', async () => {
      prismaMock.promotion.findFirst.mockResolvedValue(null)

      await expect(updatePromotion('venue-ajeno', 'promo-1', { name: 'x' } as any)).rejects.toThrow(NotFoundError)
    })
  })

  describe('publishPromotion', () => {
    it('🔴 publica con CAS de estado SÓLO si validatePromotionForPublish pasa', async () => {
      await publishPromotion('venue-1', 'promo-1', 'staff-1')

      expect(prismaMock.product.findMany).toHaveBeenCalled()
      expect(prismaMock.promotion.updateMany).toHaveBeenCalledWith({
        where: { id: 'promo-1', venueId: 'venue-1', status: 'DRAFT' },
        data: { status: 'PUBLISHED' },
      })
    })

    it('🔴 si el validador reprueba, devuelve TODOS los errores y NO publica', async () => {
      prismaMock.product.findMany.mockResolvedValue([{ id: 'p1', venueId: 'venue-1', active: false, name: 'Hamburguesa' }])

      await expect(publishPromotion('venue-1', 'promo-1')).rejects.toMatchObject({
        // BadRequestError cuyo message trae los errores unidos — el controller los expone como errors[]
        message: expect.stringMatching(/desactivado/i),
      })
      expect(prismaMock.promotion.updateMany).not.toHaveBeenCalled()
    })

    it('re-publicar una PUBLISHED es no-op idempotente, sin auditoría falsa', async () => {
      prismaMock.promotion.findFirst.mockResolvedValue(filaPromo({ status: 'PUBLISHED' }))

      const result = await publishPromotion('venue-1', 'promo-1')

      expect(result.status).toBe('PUBLISHED')
      expect(prismaMock.promotion.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    })

    it('🔴 si el estado cambió entre validar y publicar (CAS count 0), truena claro', async () => {
      prismaMock.promotion.updateMany.mockResolvedValue({ count: 0 })

      await expect(publishPromotion('venue-1', 'promo-1')).rejects.toThrow(/cambió de estado/i)
    })

    it('una ARCHIVED no se publica directo: primero se desarchiva (regla de estados)', async () => {
      prismaMock.promotion.findFirst.mockResolvedValue(filaPromo({ status: 'ARCHIVED' }))

      await expect(publishPromotion('venue-1', 'promo-1')).rejects.toThrow(/archivada/i)
    })
  })

  describe('archive / unarchive / delete', () => {
    it('archivar una PUBLISHED la saca del POS sin tocar lo vendido (CAS)', async () => {
      prismaMock.promotion.findFirst.mockResolvedValue(filaPromo({ status: 'PUBLISHED' }))

      await archivePromotion('venue-1', 'promo-1', 'staff-1')

      expect(prismaMock.promotion.updateMany).toHaveBeenCalledWith({
        where: { id: 'promo-1', venueId: 'venue-1', status: { in: ['DRAFT', 'PUBLISHED'] } },
        data: { status: 'ARCHIVED' },
      })
    })

    it('desarchivar regresa a DRAFT (nunca directo a PUBLISHED) (CAS)', async () => {
      prismaMock.promotion.findFirst.mockResolvedValue(filaPromo({ status: 'ARCHIVED' }))

      await unarchivePromotion('venue-1', 'promo-1')

      expect(prismaMock.promotion.updateMany).toHaveBeenCalledWith({
        where: { id: 'promo-1', venueId: 'venue-1', status: 'ARCHIVED' },
        data: { status: 'DRAFT' },
      })
    })

    it('🔴 borrar sólo aplica a DRAFT sin ventas', async () => {
      prismaMock.promotion.findFirst.mockResolvedValue(filaPromo({ status: 'PUBLISHED' }))

      await expect(deletePromotion('venue-1', 'promo-1')).rejects.toThrow(/borrador|archívala/i)
      expect(prismaMock.promotion.delete).not.toHaveBeenCalled()
    })

    it('🔴 un DRAFT que ya tuvo ventas (histórico raro) tampoco se borra', async () => {
      prismaMock.orderPromotion.count.mockResolvedValue(3)

      await expect(deletePromotion('venue-1', 'promo-1')).rejects.toThrow(/ventas/i)
    })
  })
})
