// tests/integration/mobile/precioQueVioElCliente.historial.test.ts
import prisma from '@/utils/prismaClient'
import { preciosQueFueronVigentes, ventanaDeLaLinea } from '@/services/mobile/precioQueVioElCliente'

/**
 * La búsqueda del «precio que vio el cliente» en `ProductPriceHistory` (lo escriben los disparadores diferidos de la
 * migración 20261017150000). Contra Postgres real: la consulta, la zona de la sesión y la hora del disparador no se
 * pueden simular con un mock.
 */
describe('preciosQueFueronVigentes (historial de precio)', () => {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let otroVenueId: string
  let categoryId: string
  let otraCategoryId: string

  const crear = (data: Record<string, unknown> = {}) =>
    prisma.product.create({
      data: { venueId, categoryId, sku: `SKU-${Math.random()}`, name: `P ${Math.random()}`, price: 45, ...data } as any,
    })
  const espera = (ms: number) => new Promise(r => setTimeout(r, ms))
  const enMinutos = (m: number) => new Date(Date.now() + m * 60_000)

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `Vio ${s}`, email: `vio-${s}@example.com`, phone: '5555555555' } })
    organizationId = org.id
    const venue = await prisma.venue.create({ data: { organizationId, name: `Vio ${s}`, slug: `vio-${s}`, seatCapExempt: true } })
    venueId = venue.id
    const otro = await prisma.venue.create({ data: { organizationId, name: `Vio2 ${s}`, slug: `vio2-${s}`, seatCapExempt: true } })
    otroVenueId = otro.id
    categoryId = (await prisma.menuCategory.create({ data: { venueId, name: `Cat ${s}`, slug: `cat-${s}` } as any })).id
    otraCategoryId = (await prisma.menuCategory.create({ data: { venueId: otroVenueId, name: `Cat2 ${s}`, slug: `cat2-${s}` } as any })).id
  })

  afterAll(async () => {
    if (!venueId || !otroVenueId || !organizationId) return // sin fixture, un deleteMany sin filtro borraría la tabla entera
    await prisma.product.deleteMany({ where: { venueId: { in: [venueId, otroVenueId] } } }) // el historial se va en cascada
    await prisma.menuCategory.deleteMany({ where: { venueId: { in: [venueId, otroVenueId] } } })
    await prisma.venue.deleteMany({ where: { id: { in: [venueId, otroVenueId] } } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
  })

  it('lo que mostró la tablet se reconoce; lo que nunca existió, lo posterior a la venta y lo de otro negocio no', async () => {
    const p = await crear({ price: 45 })
    const ajeno = await prisma.product.create({
      data: { venueId: otroVenueId, categoryId: otraCategoryId, sku: `SKU-${Math.random()}`, name: `Ajeno ${s}`, price: 45 } as any,
    })
    const catalogAt = new Date()
    await prisma.product.update({ where: { id: p.id }, data: { price: 50 } })
    const ventana = ventanaDeLaLinea(catalogAt, new Date())

    expect(
      await preciosQueFueronVigentes(venueId, [
        { productId: p.id, mostradoCents: 4500, ...ventana },
        { productId: p.id, mostradoCents: 4000, ...ventana },
        { productId: p.id, mostradoCents: 4500, desde: enMinutos(2), hasta: enMinutos(3) },
        { productId: ajeno.id, mostradoCents: 4500, ...ventana },
      ]),
    ).toEqual([true, false, false, false])
  })

  // Intervalos [validFrom, validTo): el precio que terminó en T no estaba vigente en T; el que empezó en T, sí.
  it('los bordes de la ventana respetan los intervalos semiabiertos', async () => {
    const p = await crear({ price: 45 })
    await prisma.product.update({ where: { id: p.id }, data: { price: 50 } })
    const cerrada = await prisma.productPriceHistory.findFirst({
      where: { productId: p.id, validTo: { not: null } },
      select: { validTo: true },
    })
    const t = cerrada!.validTo!.getTime()
    const en = (ms: number) => new Date(t + ms)

    expect(
      await preciosQueFueronVigentes(venueId, [
        { productId: p.id, mostradoCents: 4500, desde: en(0), hasta: en(60_000) },
        { productId: p.id, mostradoCents: 4500, desde: en(-1), hasta: en(60_000) },
        { productId: p.id, mostradoCents: 5000, desde: en(-60_000), hasta: en(0) },
        { productId: p.id, mostradoCents: 5000, desde: en(-60_000), hasta: en(-1) },
      ]),
    ).toEqual([false, true, true, false])
  })

  it('catálogo leído EN MEDIO de una transacción larga ⇒ el precio viejo se reconoce', async () => {
    const p = await crear({ price: 45 })
    const cambio = prisma.$transaction(
      async tx => {
        await tx.product.update({ where: { id: p.id }, data: { price: 50 } })
        await espera(1_500)
      },
      { timeout: 10_000 },
    )
    await espera(500)
    const leido = await prisma.product.findUnique({ where: { id: p.id }, select: { price: true } })
    const catalogAt = new Date()
    await cambio
    expect(Number(leido!.price)).toBe(45) // la tablet vio 45: el cambio aún no se confirmaba
    // Sin holgura, para que no tape una hora del disparador anterior a la lectura.
    expect(
      await preciosQueFueronVigentes(venueId, [{ productId: p.id, mostradoCents: 4500, desde: catalogAt, hasta: new Date() }]),
    ).toEqual([true])
  })

  it('un producto saturado no tapa a otro', async () => {
    const desde = new Date(Date.now() - 60_000)
    const b = await crear({ price: 30 }) // su coincidencia es la fila MÁS VIEJA del negocio en esta prueba
    const a = await crear({ price: 10 })
    for (let k = 1; k <= 150; k++) await prisma.product.update({ where: { id: a.id }, data: { price: 10 + k } }) // 11…160
    await prisma.product.update({ where: { id: b.id }, data: { price: 31 } })
    const hasta = new Date()

    expect(
      await preciosQueFueronVigentes(venueId, [
        { productId: a.id, mostradoCents: 15500, desde, hasta },
        { productId: b.id, mostradoCents: 3000, desde, hasta },
      ]),
    ).toEqual([true, true])

    // 250 candidatas = 3 bloques (100 + 100 + 50): cada respuesta en su lugar. Pares: precios que sí tuvo A (10…134);
    // nones: precios que nunca tuvo.
    const candidatas = Array.from({ length: 250 }, (_, k) => ({
      productId: a.id,
      mostradoCents: k % 2 === 0 ? (10 + k / 2) * 100 : 900_000 + k,
      desde,
      hasta,
    }))
    const esperado = candidatas.map((_, k) => k % 2 === 0)
    expect(await preciosQueFueronVigentes(venueId, candidatas)).toEqual(esperado)
  }, 60_000)

  it('no depende de la zona de la sesión', async () => {
    const p = await crear({ price: 45 })
    const catalogAt = new Date()
    await prisma.product.update({ where: { id: p.id }, data: { price: 50 } })
    const ventana = ventanaDeLaLinea(catalogAt, new Date())
    const candidatas = [
      { productId: p.id, mostradoCents: 4500, ...ventana },
      { productId: p.id, mostradoCents: 4500, desde: enMinutos(2), hasta: enMinutos(3) },
    ]
    const conZona = (zona: string) =>
      prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zona}'`)
        return preciosQueFueronVigentes(venueId, candidatas, tx)
      })

    expect(await conZona('UTC')).toEqual([true, false])
    expect(await conZona('America/Mexico_City')).toEqual([true, false])
  })

  it('sin candidatas no consulta nada', async () => {
    let consultas = 0
    const db = { $queryRaw: async () => (consultas++, []) } as any
    expect(await preciosQueFueronVigentes(venueId, [], db)).toEqual([])
    expect(consultas).toBe(0)
  })
})
