/** TEST_DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/product-variants/singleWriter.trigger.integration.test.ts */
import prisma from '@/utils/prismaClient'
import { apagarIvaPorProducto, encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'
import { isGroupWriterViolation } from '@/services/product-variants/variantErrors'

const marcar = (tx: any) => tx.$queryRaw`SELECT set_config('avoqado.product_group_writer', 'on', true)`

describe('Trigger del escritor único de variantes', () => {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string,
    venueId: string,
    categoryId: string,
    otraCategoriaId: string,
    groupId: string,
    varianteId: string,
    sueltoId: string

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `Trg ${s}`, email: `trg-${s}@example.com`, phone: '5555555555' } })
    organizationId = org.id
    venueId = (await prisma.venue.create({ data: { organizationId, name: `Trg ${s}`, slug: `trg-${s}`, seatCapExempt: true } })).id
    categoryId = (await prisma.menuCategory.create({ data: { venueId, name: `A ${s}`, slug: `a-${s}` } as any })).id
    otraCategoriaId = (await prisma.menuCategory.create({ data: { venueId, name: `B ${s}`, slug: `b-${s}` } as any })).id
    groupId = (await prisma.productGroup.create({ data: { venueId, name: 'Playera', categoryId } })).id
    varianteId = await prisma.$transaction(async tx => {
      await marcar(tx)
      return (
        await tx.product.create({
          data: { venueId, categoryId, sku: `V-${s}`, name: 'Playera · M', price: 10, productGroupId: groupId, variantKey: 'k' } as any,
        })
      ).id
    })
    sueltoId = (await prisma.product.create({ data: { venueId, categoryId, sku: `L-${s}`, name: 'Suelto', price: 10 } as any })).id
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.productGroup.deleteMany({ where: { venueId } })
    await prisma.printStation.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
  })

  it('cambiar el nombre de una variante sin el motor se rechaza (Prisma)', async () => {
    await expect(prisma.product.update({ where: { id: varianteId }, data: { name: 'Otro' } })).rejects.toThrow(
      /PRODUCT_GROUP_FIELD_OWNED_BY_PARENT/,
    )
  })

  it('cambiar la categoría por SQL directo también se rechaza', async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "Product" SET "categoryId" = $1 WHERE id = $2`, otraCategoriaId, varianteId),
    ).rejects.toThrow(/PRODUCT_GROUP_FIELD_OWNED_BY_PARENT/)
  })

  it('Postgres dispara los triggers por nombre: el del escritor único va al FINAL de los BEFORE, después de los del IVA', async () => {
    // Sólo los BEFORE (tgtype & 2): los AFTER (p. ej. el historial de precio) corren después del guardado y no compiten.
    const filas = await prisma.$queryRaw<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger WHERE tgrelid = '"Product"'::regclass AND NOT tgisinternal AND (tgtype & 2) = 2 ORDER BY tgname`
    const nombres = filas.map(f => f.tgname)
    expect(nombres.some(t => t.startsWith('Product_ivaTratamiento'))).toBe(true)
    expect(nombres[nombres.length - 1]).toBe('Product_zz_grupo_escritor_unico')
  })

  it('cambiar el IVA por la tupla vieja (taxRate) también se rechaza: el trigger corre DESPUÉS de los del IVA', async () => {
    // Con la bandera de IVA por producto encendida, taxRate 0.08 lo deriva el trigger del IVA a IVA_8; el nuestro ve ese cambio.
    await encenderIvaPorProducto(venueId)
    try {
      await expect(prisma.product.update({ where: { id: varianteId }, data: { taxRate: 0.08 } })).rejects.toThrow(
        /PRODUCT_GROUP_FIELD_OWNED_BY_PARENT/,
      )
    } finally {
      await apagarIvaPorProducto(venueId)
    }
  })

  it('precio, SKU y activo de una variante se editan libres', async () => {
    await expect(
      prisma.product.update({ where: { id: varianteId }, data: { price: 20, sku: `V2-${s}`, active: false } }),
    ).resolves.toBeTruthy()
  })

  it('poner productGroupId a un suelto sin el motor se rechaza', async () => {
    await expect(prisma.product.update({ where: { id: sueltoId }, data: { productGroupId: groupId, variantKey: 'k2' } })).rejects.toThrow(
      /PRODUCT_GROUP_FIELD_OWNED_BY_PARENT/,
    )
  })

  it('con la bandera del motor sí se puede', async () => {
    await expect(
      prisma.$transaction(async tx => {
        await marcar(tx)
        return tx.product.update({ where: { id: varianteId }, data: { name: 'Playera · L' } })
      }),
    ).resolves.toMatchObject({ name: 'Playera · L' })
  })

  it('un producto suelto se edita como siempre', async () => {
    await expect(
      prisma.product.update({ where: { id: sueltoId }, data: { name: 'Suelto 2', categoryId: otraCategoriaId } }),
    ).resolves.toBeTruthy()
  })

  it('isGroupWriterViolation reconoce el error real del trigger por Prisma y por SQL directo, y no otros', async () => {
    const porPrisma = await prisma.product.update({ where: { id: varianteId }, data: { name: 'X' } }).catch(e => e)
    const porSql = await prisma.$executeRawUnsafe(`UPDATE "Product" SET "name" = 'X' WHERE id = $1`, varianteId).catch(e => e)
    expect(isGroupWriterViolation(porPrisma)).toBe(true)
    expect(isGroupWriterViolation(porSql)).toBe(true)
    expect(isGroupWriterViolation(new Error('otro'))).toBe(false)
    expect(isGroupWriterViolation(undefined)).toBe(false)
  })

  describe('estación de impresión de una variante', () => {
    const conEstacion = async (printStationId: string | null) =>
      prisma.$transaction(async tx => {
        await marcar(tx)
        await tx.product.update({ where: { id: varianteId }, data: { printStationId } })
      })

    it('borrar la estación la pone en null sola (ON DELETE SET NULL) sin chocar con el trigger', async () => {
      const estacion = await prisma.printStation.create({ data: { venueId, name: `Cocina ${s}` } })
      await conEstacion(estacion.id)
      await expect(prisma.printStation.delete({ where: { id: estacion.id } })).resolves.toBeTruthy()
      const v = await prisma.product.findUniqueOrThrow({ where: { id: varianteId }, select: { printStationId: true } })
      expect(v.printStationId).toBeNull()
    })

    it('sin el motor, cambiarla a OTRA estación se rechaza', async () => {
      const a = await prisma.printStation.create({ data: { venueId, name: `Barra A ${s}` } })
      const b = await prisma.printStation.create({ data: { venueId, name: `Barra B ${s}` } })
      await conEstacion(a.id)
      await expect(prisma.product.update({ where: { id: varianteId }, data: { printStationId: b.id } })).rejects.toThrow(
        /PRODUCT_GROUP_FIELD_OWNED_BY_PARENT/,
      )
    })

    it('sin el motor, quitarla (null) mientras la estación existe se rechaza', async () => {
      const c = await prisma.printStation.create({ data: { venueId, name: `Barra C ${s}` } })
      await conEstacion(c.id)
      await expect(prisma.product.update({ where: { id: varianteId }, data: { printStationId: null } })).rejects.toThrow(
        /PRODUCT_GROUP_FIELD_OWNED_BY_PARENT/,
      )
    })
  })
})
