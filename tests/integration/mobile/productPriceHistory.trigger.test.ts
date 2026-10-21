// tests/integration/mobile/productPriceHistory.trigger.test.ts
import prisma from '@/utils/prismaClient'

/**
 * Historial de `Product.price` (migración `20261017150000_historial_de_precio_de_producto`). Lo escriben SÓLO dos
 * disparadores DIFERIDOS ("Product_zz_historial_de_precio_ins" / "_upd") con la función `productPriceHistoryWriter`:
 * cubren a todo escritor (Prisma, SQL directo, importaciones) y fechan el cambio AL CONFIRMARSE la transacción, en UTC.
 * Con eso el servidor decide si el precio que vio el cliente fue real (spec 2026-10-17-precio-que-vio-el-cliente).
 * Se prueba contra Postgres real: un mock no puede ejecutar plpgsql.
 */
describe('Historial de precio de Product (disparadores diferidos)', () => {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let otroVenueId: string
  let categoryId: string

  const crear = (data: Record<string, unknown> = {}) =>
    prisma.product.create({
      data: { venueId, categoryId, sku: `SKU-${Math.random()}`, name: `P ${Math.random()}`, price: 45, ...data } as any,
    })
  const historial = (productId: string) =>
    prisma.productPriceHistory.findMany({ where: { productId }, orderBy: [{ validFrom: 'asc' }, { id: 'asc' }] })
  const abiertas = (productId: string) => prisma.productPriceHistory.findMany({ where: { productId, validTo: null } })
  const espera = (ms: number) => new Promise(r => setTimeout(r, ms))

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `Hist ${s}`, email: `hist-${s}@example.com`, phone: '5555555555' } })
    organizationId = org.id
    const venue = await prisma.venue.create({ data: { organizationId, name: `Hist ${s}`, slug: `hist-${s}`, seatCapExempt: true } })
    venueId = venue.id
    const otro = await prisma.venue.create({ data: { organizationId, name: `Hist2 ${s}`, slug: `hist2-${s}`, seatCapExempt: true } })
    otroVenueId = otro.id
    const cat = await prisma.menuCategory.create({ data: { venueId, name: `Cat ${s}`, slug: `cat-${s}` } as any })
    categoryId = cat.id
  })

  afterAll(async () => {
    if (!venueId || !otroVenueId || !organizationId) return // sin fixture, un deleteMany sin filtro borraría la tabla entera
    await prisma.product.deleteMany({ where: { venueId: { in: [venueId, otroVenueId] } } }) // el historial se va en cascada
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: { in: [venueId, otroVenueId] } } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
  })

  it('crear un producto abre su precio', async () => {
    const p = await crear({ price: 45 })
    const filas = await historial(p.id)
    expect(filas).toHaveLength(1)
    expect([Number(filas[0].price), filas[0].validTo, filas[0].venueId]).toEqual([45, null, venueId])
  })

  it('cambiar el precio cierra el anterior justo donde abre el nuevo', async () => {
    const p = await crear({ price: 45 })
    await prisma.product.update({ where: { id: p.id }, data: { price: 50 } })
    const [viejo, nuevo] = await historial(p.id)
    expect([Number(viejo.price), Number(nuevo.price), nuevo.validTo]).toEqual([45, 50, null])
    expect(viejo.validTo!.getTime()).toBe(nuevo.validFrom.getTime())
  })

  it('se fecha al CONFIRMAR, no al UPDATE (importación larga)', async () => {
    const p = await crear({ price: 45 })
    let antesDeConfirmar = 0
    await prisma.$transaction(
      async tx => {
        await tx.product.update({ where: { id: p.id }, data: { price: 50 } })
        await espera(1_500)
        antesDeConfirmar = Date.now()
      },
      { timeout: 10_000 },
    )
    expect((await historial(p.id))[0].validTo!.getTime()).toBeGreaterThanOrEqual(antesDeConfirmar - 50)
  })

  it('la hora es UTC aunque la sesión tenga otra zona', async () => {
    const p = await crear({ price: 45 })
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'America/Mexico_City'`)
      await tx.product.update({ where: { id: p.id }, data: { price: 50 } })
    })
    expect(Math.abs((await historial(p.id))[1].validFrom.getTime() - Date.now())).toBeLessThan(5_000)
  })

  it('cambiar otra columna o poner el mismo precio no escribe', async () => {
    const p = await crear({ price: 45 })
    await prisma.product.update({ where: { id: p.id }, data: { name: `Otro ${Math.random()}` } })
    await prisma.product.update({ where: { id: p.id }, data: { price: 45 } })
    expect(await historial(p.id)).toHaveLength(1)
  })

  // Un precio intermedio que nunca se confirmó no se publicó: no puede quedar fila suya (con «el más bajo», un pedido
  // armado a mano podría cobrarlo).
  it('dos cambios en la misma transacción: el anterior cerrado y el último abierto, sin fila del intermedio', async () => {
    const p = await crear({ price: 45 })
    await prisma.$transaction(async tx => {
      await tx.product.update({ where: { id: p.id }, data: { price: 50 } })
      await tx.product.update({ where: { id: p.id }, data: { price: 55 } })
    })
    const [viejo, nuevo, ...resto] = await historial(p.id)
    expect(resto).toHaveLength(0)
    expect([Number(viejo.price), Number(nuevo.price), nuevo.validTo]).toEqual([45, 55, null])
    expect(viejo.validTo!.getTime()).toBe(nuevo.validFrom.getTime())
  })

  it('crear y cambiar el precio en la misma transacción deja una sola fila, la del nuevo', async () => {
    let id = ''
    await prisma.$transaction(async tx => {
      const p = await tx.product.create({
        data: { venueId, categoryId, sku: `SKU-${Math.random()}`, name: `P ${Math.random()}`, price: 45 } as any,
      })
      id = p.id
      await tx.product.update({ where: { id }, data: { price: 50 } })
    })
    const filas = await historial(id)
    expect(filas.map(f => [Number(f.price), f.validTo])).toEqual([[50, null]])
  })

  // La FK compuesta (productId, venueId) arrastra el historial al negocio nuevo; el disparador lee el negocio VIGENTE.
  // Y la fila abierta que reescribe la cascada no nació en esta transacción: el precio anterior tiene que quedar cerrado.
  it('cambiar el precio y luego el negocio en la misma transacción confirma y la abierta queda en el negocio nuevo', async () => {
    const p = await crear({ price: 45 })
    await prisma.$transaction(async tx => {
      await tx.product.update({ where: { id: p.id }, data: { price: 50 } })
      await tx.product.update({ where: { id: p.id }, data: { venueId: otroVenueId } })
    })
    const filas = await historial(p.id)
    expect(filas.map(f => [Number(f.price), f.validTo === null, f.venueId])).toEqual([
      [45, false, otroVenueId],
      [50, true, otroVenueId],
    ])
  })

  // La cascada le pone a la fila abierta vieja el xmin de ESTA transacción; si además su hora queda adelante (reloj
  // adelantado, o empate en el ms), una regla por xmin + hora la tomaría como propia y sobrescribiría un precio confirmado.
  it('con la abierta adelantada en el reloj, cambiar negocio y precio en una transacción no pierde el precio anterior', async () => {
    const p = await crear({ price: 45 })
    const futuro = new Date(Date.now() + 60 * 60 * 1000)
    await prisma.productPriceHistory.updateMany({ where: { productId: p.id, validTo: null }, data: { validFrom: futuro } })
    await prisma.$transaction(async tx => {
      await tx.product.update({ where: { id: p.id }, data: { venueId: otroVenueId } })
      await tx.product.update({ where: { id: p.id }, data: { price: 50 } })
    })
    const filas = await historial(p.id)
    expect(filas.map(f => [Number(f.price), f.validTo === null, f.venueId])).toEqual([
      [45, false, otroVenueId],
      [50, true, otroVenueId],
    ])
  })

  it('si el reloj retrocede, el intervalo cerrado nunca queda negativo', async () => {
    const p = await crear({ price: 45 })
    const futuro = new Date(Date.now() + 60 * 60 * 1000) // la abierta «nació» una hora en el futuro
    await prisma.productPriceHistory.updateMany({ where: { productId: p.id, validTo: null }, data: { validFrom: futuro } })
    await prisma.product.update({ where: { id: p.id }, data: { price: 50 } })
    const [viejo, nuevo] = await historial(p.id)
    expect(viejo.validTo!.getTime()).toBeGreaterThanOrEqual(viejo.validFrom.getTime())
    expect(nuevo.validFrom.getTime()).toBe(viejo.validTo!.getTime())
  })

  it('el SQL directo también queda registrado', async () => {
    const p = await crear({ price: 45 })
    await prisma.$executeRawUnsafe(`UPDATE "Product" SET "price" = 55 WHERE "id" = $1`, p.id)
    const filas = await historial(p.id)
    expect(filas.map(f => Number(f.price))).toEqual([45, 55])
  })

  it('createMany abre una fila por producto', async () => {
    const skus = [`SKU-${Math.random()}`, `SKU-${Math.random()}`]
    await prisma.product.createMany({
      data: [
        { venueId, categoryId, sku: skus[0], name: `P ${Math.random()}`, price: 45 },
        { venueId, categoryId, sku: skus[1], name: `P ${Math.random()}`, price: 60.5 },
      ] as any,
    })
    const productos = await prisma.product.findMany({ where: { venueId, sku: { in: skus } }, orderBy: { price: 'asc' } })
    const filas = await Promise.all(productos.map(p => historial(p.id)))
    expect(filas.map(f => f.map(h => [Number(h.price), h.validTo]))).toEqual([[[45, null]], [[60.5, null]]])
  })

  // Regresión: el disparador corre al confirmar, cuando el producto ya puede no existir. Sin la guarda, el INSERT del
  // historial choca con la llave foránea y la transacción ENTERA de quien escribe truena al confirmar.
  it('cambiar el precio y borrar el producto en la misma transacción confirma sin error', async () => {
    const p = await crear({ price: 45 })
    await prisma.$transaction(async tx => {
      await tx.product.update({ where: { id: p.id }, data: { price: 50 } })
      await tx.product.delete({ where: { id: p.id } })
    })
    expect(await prisma.product.findUnique({ where: { id: p.id } })).toBeNull()
    expect(await historial(p.id)).toHaveLength(0)
  })

  it('no puede haber dos precios abiertos del mismo producto', async () => {
    const p = await crear({ price: 45 })
    await expect(
      prisma.productPriceHistory.create({ data: { venueId, productId: p.id, price: 99, validFrom: new Date() } }),
    ).rejects.toMatchObject({ code: 'P2002' })
    expect(await abiertas(p.id)).toHaveLength(1)
  })
})
