import { putReceiptLayout } from '@/services/dashboard/receiptLayout/receiptLayout.service'
import { CANONICAL_LAYOUT } from '@/services/shared/receiptLayout'
import prisma from '@/utils/prismaClient'

const raw = () => JSON.parse(JSON.stringify(CANONICAL_LAYOUT)) as unknown[]

describe('CAS de la receta contra Postgres real', () => {
  let venueId: string

  beforeAll(async () => {
    const venue = await prisma.venue.findFirst({ select: { id: true } })
    if (!venue) throw new Error('la base de pruebas no tiene ningún venue')
    venueId = venue.id
  })

  afterEach(async () => {
    await prisma.receiptLayout.deleteMany({ where: { venueId } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('🔴 dos CREACIONES simultáneas: una gana, la otra recibe 409 — y queda UNA sola fila', async () => {
    const resultados = await Promise.allSettled([
      putReceiptLayout({ venueId, blocks: raw(), expectedRevision: 0 }),
      putReceiptLayout({ venueId, blocks: raw(), expectedRevision: 0 }),
    ])
    expect(resultados.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const ko = resultados.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    expect(ko).toHaveLength(1)
    expect(ko[0].reason.code).toBe('RECEIPT_LAYOUT_STALE')
    expect(await prisma.receiptLayout.count({ where: { venueId } })).toBe(1)
  })

  it('🔴 dos ACTUALIZACIONES desde la misma revisión: una gana y la revisión sube UNA vez', async () => {
    await putReceiptLayout({ venueId, blocks: raw(), expectedRevision: 0 })
    const resultados = await Promise.allSettled([
      putReceiptLayout({ venueId, blocks: raw(), expectedRevision: 1 }),
      putReceiptLayout({ venueId, blocks: raw(), expectedRevision: 1 }),
    ])
    expect(resultados.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(resultados.filter(r => r.status === 'rejected')).toHaveLength(1)
    const fila = await prisma.receiptLayout.findUnique({ where: { venueId }, select: { revision: true } })
    expect(fila?.revision).toBe(2) // NO 3: el perdedor no escribió
  })

  it('una revisión vieja sobre una fila que ya avanzó recibe 409 con la vigente', async () => {
    await putReceiptLayout({ venueId, blocks: raw(), expectedRevision: 0 })
    await putReceiptLayout({ venueId, blocks: raw(), expectedRevision: 1 })
    const err = await putReceiptLayout({ venueId, blocks: raw(), expectedRevision: 1 }).catch(e => e)
    expect(err.code).toBe('RECEIPT_LAYOUT_STALE')
    expect(err.details).toMatchObject({ currentRevision: 2 })
  })
})
