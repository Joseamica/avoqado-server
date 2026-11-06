import prisma from '@/utils/prismaClient'
import { createEstimate, crearConNumeroDeCotizacion } from '@/services/mobile/estimate.mobile.service'
import { Decimal } from '@prisma/client/runtime/library'

// D12: el consecutivo `EST-<fecha>-NNN` es de cada negocio; antes el índice único era de toda la base y el
// segundo negocio del día no podía cotizar (P2002). La carrera dentro de un negocio la resuelve el candado.
describe('Número de cotización por negocio', () => {
  const venueIds: string[] = []
  const orgIds: string[] = []

  async function negocio() {
    const sufijo = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const org = await prisma.organization.create({
      data: { name: `Cot Numero ${sufijo}`, email: `cot-numero-${sufijo}@avoqado.test`, phone: '5550000000', type: 'RESTAURANT' },
    })
    orgIds.push(org.id)
    const venue = await prisma.venue.create({
      data: {
        organizationId: org.id,
        name: `Cot Numero ${sufijo}`,
        slug: `cot-numero-${sufijo}`,
        timezone: 'America/Mexico_City',
        currency: 'MXN',
      },
    })
    venueIds.push(venue.id)
    return venue.id
  }

  const crear = (venueId: string) =>
    createEstimate({
      venueId,
      staffId: 'SYSTEM',
      staffName: 'Cajera',
      items: [{ productName: 'Corte', quantity: 1, unitPrice: 100 }],
    })

  const filaCruda = (venueId: string, estimateNumber: string) =>
    prisma.estimate.create({
      data: { venueId, estimateNumber, subtotal: new Decimal(0), total: new Decimal(0), createdByName: 'x' },
    })

  const consecutivo = (numero: string) => numero.split('-')[2]
  const deUnoA = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1).padStart(3, '0'))

  afterEach(async () => {
    if (venueIds.length > 0) {
      await prisma.estimate.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.activityLog.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
    }
    if (orgIds.length > 0) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
    venueIds.length = 0
    orgIds.length = 0
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('🔴 dos negocios el mismo día arrancan cada uno en -001', async () => {
    const [a, b] = [await negocio(), await negocio()]

    const deA = await crear(a)
    const deB = await crear(b)
    const segundaDeB = await crear(b)

    expect(deA.estimateNumber).toMatch(/^EST-\d{8}-001$/)
    expect(deB.estimateNumber).toBe(deA.estimateNumber)
    expect(deB.number).toBe(deB.estimateNumber)
    expect(consecutivo(segundaDeB.estimateNumber)).toBe('002')
  })

  it('🔴 12 cotizaciones a la vez en un negocio: todas pasan, sin repetidos ni hoyos', async () => {
    const n = await negocio()

    const resultados = await Promise.allSettled(Array.from({ length: 12 }, () => crear(n)))

    expect(resultados.filter(r => r.status === 'rejected')).toEqual([])
    const filas = await prisma.estimate.findMany({ where: { venueId: n }, select: { estimateNumber: true } })
    expect(filas.map(f => consecutivo(f.estimateNumber)).sort()).toEqual(deUnoA(12))
  })

  it('🔴 esperar el candado más de 5 s no hace fallar la cotización', async () => {
    const n = await negocio()
    let avisar!: () => void
    const candadoTomado = new Promise<void>(resolve => (avisar = resolve))
    const otra = prisma.$transaction(
      async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`estimate-number:${n}`}, 0))`
        avisar()
        await new Promise(resolve => setTimeout(resolve, 6_000))
      },
      { timeout: 10_000 },
    )
    await candadoTomado

    const cotizacion = await crear(n)
    await otra

    expect(consecutivo(cotizacion.estimateNumber)).toBe('001')
  })

  it('🔴 de -999 y -1000 sigue -1001: el consecutivo se compara como número', async () => {
    const n = await negocio()
    const prefijo = (await crear(n)).estimateNumber.slice(0, -'001'.length)
    for (const numero of ['999', '1000']) await filaCruda(n, `${prefijo}${numero}`)

    expect(consecutivo((await crear(n)).estimateNumber)).toBe('1001')
  })

  it('una cotización que falla no gasta número', async () => {
    const n = await negocio()

    await expect(
      crearConNumeroDeCotizacion(n, async (tx, estimateNumber) => {
        await tx.estimate.create({
          data: { venueId: n, estimateNumber, subtotal: new Decimal(0), total: new Decimal(0), createdByName: 'x' },
        })
        throw new Error('falló a media creación')
      }),
    ).rejects.toThrow('falló a media creación')

    expect(consecutivo((await crear(n)).estimateNumber)).toBe('001')
  })

  it('la base permite el mismo número en dos negocios y lo rechaza dentro de uno', async () => {
    const [a, b] = [await negocio(), await negocio()]

    await filaCruda(a, 'EST-20261105-777')
    await expect(filaCruda(b, 'EST-20261105-777')).resolves.toBeTruthy()
    await expect(filaCruda(a, 'EST-20261105-777')).rejects.toMatchObject({ code: 'P2002' })
  })
})
