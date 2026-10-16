/**
 * `scripts/sembrar-funcion-tarjetas-de-regalo.ts` contra Postgres real (base desechable). Stripe NO es lo que se mide: la
 * preparación de una publicación sólo le estampa ids falsos (molde: hybrid-plan-list-seed.integration.test.ts).
 */
import prisma from '@/utils/prismaClient'
jest.mock('@/services/launchCampaigns/hybridPrices', () => ({
  ensureHybridPublicationPrices: jest.fn(async (id: string) =>
    require('@/utils/prismaClient').default.hybridOfferPublication.update({
      where: { id },
      data: { stripeProductId: `prod_gc_${id}`, stripePriceId: `price_gc_${id}` },
    }),
  ),
}))
import { hybridOfferDefinition } from '@/services/launchCampaigns/hybridOffer.schema'
import { ensureHybridPublicationPrices } from '@/services/launchCampaigns/hybridPrices'
import { saveListPrice } from '@/services/launchCampaigns/hybridListPrice.service'
import {
  NegativaDeSiembra,
  PRECIO_SUELTO,
  PRODUCTO,
  sembrarFuncionTarjetasDeRegalo,
} from '../../../scripts/sembrar-funcion-tarjetas-de-regalo'

const stamp = `${Date.now()}${process.pid}`
const host = new URL(process.env.TEST_DATABASE_URL!).hostname
const dbName = new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1)
let staffId: string
let aparcadas: Array<{ id: string; listProductKey: string | null; code: string; slug: string }> = []
let featureExistia = false

const lista = () => prisma.hybridCampaign.findFirst({ where: { purpose: 'LIST', listProductKey: PRODUCTO } })
const terminosDe = async (publicationId: string | null) =>
  hybridOfferDefinition.parse((await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: publicationId! } })).definition).terms
async function correr(o: { apply: boolean; confirmHost?: string; confirmDb?: string }) {
  const lineas: string[] = []
  const reporte = await sembrarFuncionTarjetasDeRegalo({ ...o, staffId }, l => lineas.push(l))
  return { reporte, texto: lineas.join('\n') }
}

/** Las listas nunca se borran (sus publicaciones no pueden): se libera la llave de producto, el código y el slug. */
async function retirarListas() {
  const filas = await prisma.hybridCampaign.findMany({
    where: { purpose: 'LIST', OR: [{ listProductKey: PRODUCTO }, { code: 'L_GIFT_CARDS' }] },
    select: { id: true },
    take: 10,
  })
  for (const { id } of filas)
    await prisma.hybridCampaign.update({
      where: { id },
      data: { listProductKey: `FEATURE:RETIRED_${id}`, code: `RETIRED_${id}`, slug: `retired-${id}`, status: 'PAUSED' },
    })
}

beforeAll(async () => {
  if (!/test/i.test(dbName)) throw new Error('Se requiere la base desechable (su nombre lleva «test»)')
  aparcadas = await prisma.hybridCampaign.findMany({
    where: { purpose: 'LIST', OR: [{ listProductKey: PRODUCTO }, { code: 'L_GIFT_CARDS' }, { slug: 'lista-gift-cards' }] },
    select: { id: true, listProductKey: true, code: true, slug: true },
    take: 10,
  })
  for (const { id } of aparcadas)
    await prisma.hybridCampaign.update({
      where: { id },
      data: { listProductKey: `FEATURE:PARKED_${id}`, code: `PARKED_${id}`, slug: `parked-${id}` },
    })
  const antes = await prisma.feature.findUnique({ where: { code: 'GIFT_CARDS' }, select: { id: true } })
  featureExistia = !!antes
  if (antes) await prisma.feature.update({ where: { code: 'GIFT_CARDS' }, data: { active: false } })
  staffId = (await prisma.staff.create({ data: { email: `gc-seed-${stamp}@example.test`, firstName: 'Semilla', lastName: 'Tarjetas' } })).id
})

afterAll(async () => {
  await retirarListas()
  for (const { id, listProductKey, code, slug } of aparcadas)
    await prisma.hybridCampaign.update({ where: { id }, data: { listProductKey, code, slug } })
})

describe('sembrar la función GIFT_CARDS ($249 al mes con IVA)', () => {
  it('sin --apply imprime la base y no escribe nada', async () => {
    const { reporte, texto } = await correr({ apply: false })
    expect(texto.split('\n')[0]).toContain(host)
    expect(texto.split('\n')[0]).toContain(dbName)
    expect(reporte.feature).toBe(featureExistia ? 'REACTIVATE' : 'CREATE')
    expect(reporte.listPrice.outcome).toBe('CREATE')
    expect(reporte.contracts).toBeNull()
    expect(await lista()).toBeNull()
    const feature = await prisma.feature.findUnique({ where: { code: 'GIFT_CARDS' }, select: { active: true } })
    expect(feature?.active ?? false).toBe(false)
  })

  it('--apply sin repetir host y base exactos no escribe nada', async () => {
    await expect(correr({ apply: true })).rejects.toBeInstanceOf(NegativaDeSiembra)
    await expect(correr({ apply: true, confirmHost: host, confirmDb: 'av-db-25' })).rejects.toThrow(
      `--confirm-host ${host} --confirm-db ${dbName}`,
    )
    expect(await lista()).toBeNull()
  })

  it('si Stripe falla nada queda en venta; la siguiente corrida lo termina', async () => {
    jest.mocked(ensureHybridPublicationPrices).mockRejectedValueOnce(new Error('Stripe no contestó'))
    await expect(correr({ apply: true, confirmHost: host, confirmDb: dbName })).rejects.toMatchObject({ code: 'HYBRID_LIST_PREPARING' })
    expect(await lista()).toMatchObject({ status: 'DRAFT', currentPublicationId: null })
    expect((await correr({ apply: false })).reporte.listPrice.outcome).toBe('PENDING')
    const { reporte, texto } = await correr({ apply: true, confirmHost: host, confirmDb: dbName })
    expect(reporte.listPrice.outcome).toBe('PENDING')
    expect(texto).toMatch(/precio pendiente terminado a \$249\.00/)
  })

  it('deja la función activa y su precio de lista en venta a $249 con IVA, por mes', async () => {
    const feature = await prisma.feature.findUniqueOrThrow({ where: { code: 'GIFT_CARDS' } })
    expect(feature.active).toBe(true)
    if (!featureExistia) {
      expect(feature).toMatchObject({ name: 'Tarjetas de regalo', category: 'MARKETING' })
      expect(Number(feature.monthlyPrice)).toBe(PRECIO_SUELTO)
    }
    const l = await lista()
    expect(l).toMatchObject({ status: 'ACTIVE', pendingPublicationId: null, createdById: staffId })
    expect(await terminosDe(l!.currentPublicationId)).toMatchObject({ price: 249, taxIncluded: true, interval: 'MONTHLY', currency: 'MXN' })
  })

  it('volver a correrlo no crea otra publicación ni cambia nada', async () => {
    const campaignId = (await lista())!.id
    const antes = await prisma.hybridOfferPublication.count({ where: { campaignId } })
    const { reporte, texto } = await correr({ apply: true, confirmHost: host, confirmDb: dbName })
    expect(reporte.feature).toBe('EXISTS')
    expect(reporte.listPrice.outcome).toBe('EXISTS')
    expect(texto).toMatch(/ya existe a \$249\.00/)
    expect(await prisma.hybridOfferPublication.count({ where: { campaignId } })).toBe(antes)
  })

  it('un precio que superadmin ya cambió NO se pisa', async () => {
    const l = (await lista())!
    await saveListPrice({ productKey: PRODUCTO, price: 299, expectedRevision: l.revision }, staffId)
    const { reporte } = await correr({ apply: true, confirmHost: host, confirmDb: dbName })
    expect(reporte.listPrice).toMatchObject({ outcome: 'DIFFERENT_PRICE', current: 299 })
    expect(await terminosDe((await lista())!.currentPublicationId)).toMatchObject({ price: 299 })
  })

  it('con --apply pone al día los contratos de plan vivos y reporta qué falta republicar', async () => {
    const { reporte } = await correr({ apply: true, confirmHost: host, confirmDb: dbName })
    expect(reporte.contracts).toMatchObject({
      contracts: expect.any(Number),
      grants: expect.any(Number),
      skippedContracts: expect.any(Array),
      inFlightPurchases: expect.any(Array),
    })
    expect(Array.isArray(reporte.staleCampaigns)).toBe(true)
  })
})
