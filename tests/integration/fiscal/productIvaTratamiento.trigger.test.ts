// tests/integration/fiscal/productIvaTratamiento.trigger.test.ts
import prisma from '@/utils/prismaClient'

/**
 * La barrera de IVA en `Product` (migración `20260926000000_iva_tratamiento_columnas`) es la
 * cerca para los ~34 escritores de Product (pods viejos, apps viejas, SQL directo del catálogo
 * maestro). No es UN trigger: por el Ruling R5 son TRES, compartiendo la misma función
 * `productIvaTratamientoGuard`, porque plpgsql no puede leer la lista SET de un UPDATE y sólo un
 * trigger columnar («BEFORE UPDATE OF <columnas>») dispara por ser OBJETIVO del SET:
 *   - "Product_ivaTratamiento_ins"          BEFORE INSERT
 *   - "Product_ivaTratamiento_1_explicito"  BEFORE UPDATE OF "ivaTratamiento"  (el enum manda)
 *   - "Product_ivaTratamiento_2_tupla"      BEFORE UPDATE OF "taxRate","objetoImp" (deriva o revalida)
 * Se prueba contra Postgres real: un mock no puede ejecutar plpgsql.
 */
describe('Barrera de IVA en Product (triggers)', () => {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let categoryId: string

  const crear = (data: Record<string, unknown> = {}) =>
    prisma.product.create({
      data: { venueId, categoryId, sku: `SKU-${Math.random()}`, name: `P ${Math.random()}`, price: 480, ...data } as any,
    })
  const encender = () => prisma.venueIvaPorProducto.create({ data: { venueId } })

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `IVA ${s}`, email: `iva-${s}@example.com`, phone: '5555555555' } })
    organizationId = org.id
    const venue = await prisma.venue.create({ data: { organizationId, name: `IVA ${s}`, slug: `iva-${s}`, seatCapExempt: true } })
    venueId = venue.id
    const cat = await prisma.menuCategory.create({ data: { venueId, name: `Cat ${s}`, slug: `cat-${s}` } as any })
    categoryId = cat.id
  })

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.venueIvaPorProducto.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
  })

  afterEach(() => prisma.venueIvaPorProducto.deleteMany({ where: { venueId } }))

  it('un escritor que no conoce la columna crea IVA_16 sin error', async () => {
    const p = await crear()
    expect(p.ivaTratamiento).toBe('IVA_16')
    expect(Number(p.taxRate)).toBe(0.16)
    expect(p.objetoImp).toBe('02')
  })

  it('bandera apagada: poner taxRate 0 (toggle «Exento» de una app vieja) se rechaza', async () => {
    const p = await crear()
    await expect(prisma.product.update({ where: { id: p.id }, data: { taxRate: 0 } })).rejects.toThrow(/IVA_POR_PRODUCTO_APAGADO/)
  })

  it('bandera apagada: crear un producto con objetoImp 04 se rechaza (no es heredado de ESA fila)', async () => {
    await expect(crear({ objetoImp: '04' })).rejects.toThrow(/IVA_POR_PRODUCTO_APAGADO/)
  })

  it('bandera apagada: el SQL directo del catálogo maestro también queda bloqueado', async () => {
    const p = await crear()
    await expect(prisma.$executeRawUnsafe(`UPDATE "Product" SET "taxRate" = 0 WHERE "id" = $1`, p.id)).rejects.toThrow(
      /IVA_POR_PRODUCTO_APAGADO/,
    )
  })

  it('tasa que el SAT no admite con objeto 02 es contradicción', async () => {
    const p = await crear()
    await expect(prisma.product.update({ where: { id: p.id }, data: { taxRate: 0.1 } })).rejects.toThrow(/IVA_TRATAMIENTO_CONTRADICTORIO/)
  })

  it('bandera encendida: elegir EXENTO deja la tupla (0, 02) y marca la organización', async () => {
    await encender()
    const p = await crear()
    const u = await prisma.product.update({ where: { id: p.id }, data: { ivaTratamiento: 'EXENTO' } })
    expect(u.ivaTratamiento).toBe('EXENTO')
    expect(Number(u.taxRate)).toBe(0)
    expect(u.objetoImp).toBe('02')
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })
    expect(org.ivaMixtoAlgunaVez).toBe(true)
  })

  it('una app vieja que edita el nombre y reenvía taxRate 0 NO degrada un EXENTO a IVA_0', async () => {
    await encender()
    const p = await crear({ ivaTratamiento: 'EXENTO' })
    const u = await prisma.product.update({ where: { id: p.id }, data: { name: 'Café en grano', taxRate: 0 } })
    expect(u.ivaTratamiento).toBe('EXENTO')
  })

  it('actualizar un producto sin tocar el IVA no dispara la barrera aunque la bandera esté apagada', async () => {
    await encender()
    const p = await crear({ ivaTratamiento: 'IVA_0' })
    await prisma.venueIvaPorProducto.deleteMany({ where: { venueId } }) // se apaga
    const u = await prisma.product.update({ where: { id: p.id }, data: { price: 500 } })
    expect(u.ivaTratamiento).toBe('IVA_0')
  })

  // Ruling R6 (casos A, B y C de la revisión de la Tarea 2): el enum explícito manda y la tupla debe cuadrar.
  it('A · elegir EXENTO y mandar una tasa distinta a la actual e incoherente (0.08) se rechaza', async () => {
    await encender()
    const p = await crear()
    await expect(
      prisma.product.update({ where: { id: p.id }, data: { ivaTratamiento: 'EXENTO', taxRate: 0.08, objetoImp: '02' } }),
    ).rejects.toThrow(/IVA_TRATAMIENTO_CONTRADICTORIO/)
  })

  it('A-límite (Ruling R7) · enum explícito + tupla IGUAL a la actual de la fila ⇒ gana el enum', async () => {
    await encender()
    const p = await crear()
    const u = await prisma.product.update({ where: { id: p.id }, data: { ivaTratamiento: 'EXENTO', taxRate: 0.16, objetoImp: '02' } })
    expect(u.ivaTratamiento).toBe('EXENTO')
    expect(Number(u.taxRate)).toBe(0)
  })

  it('B · re-enviar EXENTO (sin cambio) con taxRate 0.16 se rechaza; NO reclasifica a IVA_16', async () => {
    await encender()
    const p = await crear({ ivaTratamiento: 'EXENTO' })
    await expect(prisma.product.update({ where: { id: p.id }, data: { ivaTratamiento: 'EXENTO', taxRate: 0.16 } })).rejects.toThrow(
      /IVA_TRATAMIENTO_CONTRADICTORIO/,
    )
    const sigue = await prisma.product.findUniqueOrThrow({ where: { id: p.id } })
    expect(sigue.ivaTratamiento).toBe('EXENTO')
  })

  it('C · elegir BLOQUEADO_03 y mandar objetoImp 01 se rechaza', async () => {
    await encender()
    const p = await crear()
    await expect(prisma.product.update({ where: { id: p.id }, data: { ivaTratamiento: 'BLOQUEADO_03', objetoImp: '01' } })).rejects.toThrow(
      /IVA_TRATAMIENTO_CONTRADICTORIO/,
    )
  })

  it('elegir un tratamiento y mandar una tupla que lo contradice se rechaza', async () => {
    await encender()
    const p = await crear()
    // 0.08 (no 0.16, el default del producto recién creado): mandar la tasa ACTUAL de la fila junto
    // con el enum cae en la excepción del Ruling R7 (A-límite) — el enum gana porque la tupla no
    // "cambió". Aquí la tupla SÍ cambia (0.16 → 0.08) y no cuadra con IVA_0 (exige 0), así que es
    // una contradicción real. Mismo ajuste que el caso "A" de este archivo, por la misma razón.
    await expect(prisma.product.update({ where: { id: p.id }, data: { ivaTratamiento: 'IVA_0', taxRate: 0.08 } })).rejects.toThrow(
      /IVA_TRATAMIENTO_CONTRADICTORIO/,
    )
  })
})
