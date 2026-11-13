/**
 * API del panel de promociones de lealtad (Task 9) contra Postgres real: el tope de 10 vivas bajo el candado del negocio (dos altas a
 * la vez con 9 → sólo una pasa), los filtros de estado del listado y que los productos de otro negocio se rechacen.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { ConflictError, BadRequestError } from '@/errors/AppError'
import {
  createLoyaltyPromotion,
  endLoyaltyPromotion,
  listLoyaltyPromotions,
  updateLoyaltyPromotion,
} from '@/services/loyalty/promotions/loyaltyPromotion.service'

// La bitácora es fire-and-forget: sin esto escribiría después de la limpieza.
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
let orgId: string | undefined
const venueIds: string[] = []
let n = 0

async function negocio() {
  const v = await prisma.venue.create({
    data: {
      name: `itest-lpromo-${sello}-${++n}`,
      slug: `itest-lpromo-${sello}-${n}`,
      organizationId: orgId!,
      timezone: 'America/Mexico_City',
    },
  })
  venueIds.push(v.id)
  return v.id
}

const DIA = 24 * 3600 * 1000
const enDias = (d: number) => new Date(Date.now() + d * DIA)
const diaDelNegocio = (d: number) => enDias(d).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
const nueva = (o: Record<string, unknown> = {}) => ({
  name: 'Sello doble',
  kind: 'MULTIPLY' as const,
  multiplier: 2,
  startDate: diaDelNegocio(3),
  ...o,
})

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ITEST LPromo ${sello}`, email: `itest-lpromo-${sello}@test.com`, phone: '5550000000' },
    })
  ).id
})

afterAll(async () => {
  // 🔴 Sin fixture no se limpia NADA: un filtro vacío borraría tablas enteras.
  if (!orgId) return
  for (const venueId of venueIds) {
    if (!venueId) continue
    await prisma.loyaltyPromotion.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('promociones de lealtad del panel (Postgres real)', () => {
  it('🔴 con 9 vivas, dos altas a la vez: sólo una pasa (candado del negocio)', async () => {
    const venueId = await negocio()
    // 9 vivas: programadas, activas y una sin fin; más una terminada que NO cuenta.
    for (let i = 0; i < 9; i++)
      await prisma.loyaltyPromotion.create({
        data: {
          venueId,
          name: `Viva ${i}`,
          kind: 'MULTIPLY',
          multiplier: 2,
          startsAt: enDias(i % 2 ? 1 : -1),
          endsAt: i === 0 ? null : enDias(5),
        },
      })
    await prisma.loyaltyPromotion.create({
      data: { venueId, name: 'Terminada', kind: 'MULTIPLY', multiplier: 2, startsAt: enDias(-3), endedAt: enDias(-1) },
    })

    const r = await Promise.allSettled([
      createLoyaltyPromotion(venueId, nueva({ name: 'A' }), null),
      createLoyaltyPromotion(venueId, nueva({ name: 'B' }), null),
    ])

    expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    const rechazo = r.find(x => x.status === 'rejected') as PromiseRejectedResult
    expect(rechazo.reason).toBeInstanceOf(ConflictError)
    expect(await prisma.loyaltyPromotion.count({ where: { venueId, endedAt: null } })).toBe(10)
  })

  it('el listado separa programadas, activas y terminadas en la base', async () => {
    const venueId = await negocio()
    const programada = await createLoyaltyPromotion(venueId, nueva({ name: 'Programada', endDate: diaDelNegocio(6) }), null)
    const activa = await createLoyaltyPromotion(
      venueId,
      nueva({ name: 'Activa', startDate: diaDelNegocio(0), limit: 'ONCE_PER_DAY' }),
      null,
    )
    const terminada = await createLoyaltyPromotion(venueId, nueva({ name: 'Terminada', startDate: diaDelNegocio(0) }), null)
    expect((await endLoyaltyPromotion(venueId, terminada.id, null)).status).toBe('ENDED')

    const ids = async (status: 'ACTIVE' | 'SCHEDULED' | 'ENDED') => (await listLoyaltyPromotions(venueId, { status })).items.map(p => p.id)
    expect(await ids('SCHEDULED')).toEqual([programada.id])
    expect(await ids('ACTIVE')).toEqual([activa.id])
    expect(await ids('ENDED')).toEqual([terminada.id])
    const todas = await listLoyaltyPromotions(venueId, { pageSize: 500 })
    expect(todas).toMatchObject({ total: 3, pageSize: 100 })
    expect(todas.items.find(p => p.id === activa.id)).toMatchObject({ limit: 'ONCE_PER_DAY', status: 'ACTIVE' })

    // Activa: sólo la fecha de fin.
    await expect(updateLoyaltyPromotion(venueId, activa.id, { name: 'Otra' }, null)).rejects.toBeInstanceOf(ConflictError)
    expect((await updateLoyaltyPromotion(venueId, activa.id, { endDate: diaDelNegocio(0) }, null)).endDate).toBe(diaDelNegocio(0))
  })

  it('rechaza productos de otro negocio y acepta los propios con su nombre', async () => {
    const [mio, ajeno] = [await negocio(), await negocio()]
    const producto = async (venueId: string, name: string) => {
      const cat = await prisma.menuCategory.create({ data: { venueId, name: `Cat ${name}`, slug: `cat-${sello}-${++n}` } })
      return (await prisma.product.create({ data: { venueId, sku: `SKU-${sello}-${++n}`, name, categoryId: cat.id, price: 50 } })).id
    }
    const propio = await producto(mio, 'Manicure')
    const deOtro = await producto(ajeno, 'Pedicure')

    await expect(createLoyaltyPromotion(mio, nueva({ productIds: [propio, deOtro] }), null)).rejects.toBeInstanceOf(BadRequestError)
    const ok = await createLoyaltyPromotion(mio, nueva({ productIds: [propio] }), null)
    expect(ok.products).toEqual([{ id: propio, name: 'Manicure' }])
  })
})
