// tests/integration/fiscal/sellosIva.test.ts
//
// IVA por producto, plan 3, Tarea 5: sellar (congelar el tratamiento de un renglón al facturarlo
// + registrar qué CFDI lo usó) y liberar (deshacer ese registro cuando el CFDI ya no cuenta —
// cancelación, fallo confirmado). Una sola función para cada cosa; ver global-constraints.md.
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { sellarRenglones, liberarSellosDe, renglonesSellados } from '@/services/fiscal/sellosIva'

// Antes de registrar cualquier siembra o limpieza: nunca aceptar la base compartida.
const testDatabase = new URL(process.env.TEST_DATABASE_URL ?? '')
// La base fiscal de esta Mac o la desechable de CI (ci-cd.yml adopta ese nombre en vez de relajar la guarda): nunca otra.
if (
  !['localhost', '127.0.0.1'].includes(testDatabase.hostname) ||
  !['/av_db_25_iva_test', '/av_db_25_iva_test_b3c', '/avoqado_h1a_test_20260808'].includes(testDatabase.pathname)
) {
  throw new Error('Esta suite exige la base local av_db_25_iva_test o la desechable de CI avoqado_h1a_test_20260808.')
}

describe('sellarRenglones / liberarSellosDe / renglonesSellados (integración)', () => {
  const fixture = `sellos-iva-${randomUUID().slice(0, 8)}`
  let productId: string
  let venueId: string
  let fiscalEmisorId: string

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' },
    })
    venueId = (await prisma.venue.create({ data: { id: fixture, organizationId: org.id, name: fixture, slug: fixture } })).id
    const category = await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })
    productId = (
      await prisma.product.create({
        data: { venueId, categoryId: category.id, name: fixture, sku: fixture, price: 116 },
      })
    ).id
    fiscalEmisorId = (
      await prisma.fiscalEmisor.create({
        data: {
          venueId,
          rfc: 'AAA010101AAA',
          legalName: fixture,
          regimenFiscal: '601',
          lugarExpedicion: '01000',
        },
      })
    ).id
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.orderItemSelloIva.deleteMany({ where: { orderItem: { order: { venueId } } } })
    await prisma.cfdi.deleteMany({ where: { venueId } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: fixture } })
    await prisma.$disconnect()
  })

  /** Una orden mínima con `n` renglones de $100, todos sin sellar (ivaTratamiento NULL). */
  async function nuevaOrdenConRenglones(n: number) {
    const orden = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `${fixture}-${randomUUID().slice(0, 8)}`,
        subtotal: new Prisma.Decimal(100 * n),
        taxAmount: new Prisma.Decimal(16 * n),
        total: new Prisma.Decimal(116 * n),
      } as Prisma.OrderUncheckedCreateInput,
    })
    for (let i = 0; i < n; i++) {
      await prisma.orderItem.create({
        data: {
          orderId: orden.id,
          productId,
          productName: `Artículo ${i + 1}`,
          quantity: 1,
          unitPrice: new Prisma.Decimal(100),
          taxAmount: new Prisma.Decimal(16),
          total: new Prisma.Decimal(116),
        } as Prisma.OrderItemUncheckedCreateInput,
      })
    }
    const items = await prisma.orderItem.findMany({ where: { orderId: orden.id }, select: { id: true }, orderBy: { id: 'asc' } })
    return { ...orden, itemIds: items.map(i => i.id) }
  }

  /** Un CFDI mínimo, individual, ligado a `orderId` (o suelto si no se pasa). */
  async function nuevoCfdi(orderId?: string) {
    return prisma.cfdi.create({
      data: {
        venueId,
        fiscalEmisorId,
        flow: 'STAFF_B',
        orderId: orderId ?? null,
        // D21: una heredada (sin protocoloIva) sólo puede existir terminada; este CFDI en DRAFT es de la ruta nueva.
        protocoloIva: 1,
        receptorRfc: 'XAXX010101000',
        receptorNombre: 'PÚBLICO EN GENERAL',
        receptorRegimen: '616',
        receptorCp: '01000',
        usoCfdi: 'S01',
        formaPago: '01',
        metodoPago: 'PUE',
        subtotalCents: 10000,
        taxCents: 1600,
        totalCents: 11600,
      } as Prisma.CfdiUncheckedCreateInput,
    })
  }

  async function tratamientoDe(orderItemId: string) {
    return (await prisma.orderItem.findUniqueOrThrow({ where: { id: orderItemId }, select: { ivaTratamiento: true } })).ivaTratamiento
  }

  async function sellosDe(orderItemId: string) {
    return prisma.orderItemSelloIva.findMany({ where: { orderItemId } })
  }

  it('1-5: sellar con A, idempotencia, sustituir con B, liberar A (sigue sellado), liberar B (vuelve a NULL)', async () => {
    const orden = await nuevaOrdenConRenglones(2)
    const [item1, item2] = orden.itemIds
    const cfdiA = await nuevoCfdi(orden.id)
    const cfdiB = await nuevoCfdi(orden.id)

    // 1. sellar con A ⇒ los 2 renglones quedan con tratamiento y 1 CFDI cada uno.
    await prisma.$transaction(tx =>
      sellarRenglones(tx, {
        cfdiId: cfdiA.id,
        intento: 1,
        renglones: [
          { orderItemId: item1, tratamiento: 'IVA_16' },
          { orderItemId: item2, tratamiento: 'IVA_0' },
        ],
      }),
    )
    expect(await tratamientoDe(item1)).toBe('IVA_16')
    expect(await tratamientoDe(item2)).toBe('IVA_0')
    expect(await sellosDe(item1)).toEqual([expect.objectContaining({ cfdiId: cfdiA.id, intento: 1 })])
    expect(await sellosDe(item2)).toHaveLength(1)

    // 2. sellar otra vez con A ⇒ idempotente (sigue 1 sello cada uno, mismo tratamiento).
    await prisma.$transaction(tx =>
      sellarRenglones(tx, {
        cfdiId: cfdiA.id,
        intento: 1,
        renglones: [
          { orderItemId: item1, tratamiento: 'IVA_16' },
          { orderItemId: item2, tratamiento: 'IVA_0' },
        ],
      }),
    )
    expect(await tratamientoDe(item1)).toBe('IVA_16')
    expect(await sellosDe(item1)).toHaveLength(1)
    expect(await sellosDe(item2)).toHaveLength(1)

    // 3. sellar con B (sustituta, mismo tratamiento) ⇒ 2 CFDI por renglón.
    await prisma.$transaction(tx =>
      sellarRenglones(tx, {
        cfdiId: cfdiB.id,
        intento: 1,
        renglones: [
          { orderItemId: item1, tratamiento: 'IVA_16' },
          { orderItemId: item2, tratamiento: 'IVA_0' },
        ],
      }),
    )
    expect(await tratamientoDe(item1)).toBe('IVA_16')
    expect(await sellosDe(item1)).toHaveLength(2)
    expect(await sellosDe(item2)).toHaveLength(2)

    const sellados = await prisma.$transaction(tx => renglonesSellados(tx, orden.id))
    expect(sellados).toEqual(
      expect.arrayContaining([
        { orderItemId: item1, tratamiento: 'IVA_16', cfdis: 2 },
        { orderItemId: item2, tratamiento: 'IVA_0', cfdis: 2 },
      ]),
    )

    // 4. liberar A ⇒ los renglones SIGUEN sellados (queda B).
    const liberadosA = await prisma.$transaction(tx => liberarSellosDe(tx, cfdiA.id))
    expect(liberadosA).toEqual({ liberados: 2 })
    expect(await tratamientoDe(item1)).toBe('IVA_16')
    expect(await tratamientoDe(item2)).toBe('IVA_0')
    expect(await sellosDe(item1)).toHaveLength(1)
    expect(await sellosDe(item2)).toHaveLength(1)

    // 5. liberar B ⇒ ivaTratamiento vuelve a NULL.
    const liberadosB = await prisma.$transaction(tx => liberarSellosDe(tx, cfdiB.id))
    expect(liberadosB).toEqual({ liberados: 2 })
    expect(await tratamientoDe(item1)).toBeNull()
    expect(await tratamientoDe(item2)).toBeNull()
    expect(await sellosDe(item1)).toHaveLength(0)
    expect(await sellosDe(item2)).toHaveLength(0)
  })

  it('6: sellar con una entrada cuyo tratamiento difiere del ya sellado ⇒ SELLO_DIVERGENTE y nada cambia (revierte)', async () => {
    const orden = await nuevaOrdenConRenglones(2)
    const [itemYaSellado, itemNuevo] = orden.itemIds
    const cfdiOriginal = await nuevoCfdi(orden.id)
    const cfdiNuevo = await nuevoCfdi(orden.id)

    // Deja itemYaSellado sellado con IVA_16 de antemano.
    await prisma.$transaction(tx =>
      sellarRenglones(tx, {
        cfdiId: cfdiOriginal.id,
        intento: 1,
        renglones: [{ orderItemId: itemYaSellado, tratamiento: 'IVA_16' }],
      }),
    )
    expect(await tratamientoDe(itemYaSellado)).toBe('IVA_16')

    // itemNuevo va PRIMERO en el arreglo (para probar que su escritura, que sola sí prosperaría,
    // se revierte porque el renglón que le sigue diverge dentro de la MISMA transacción).
    await expect(
      prisma.$transaction(tx =>
        sellarRenglones(tx, {
          cfdiId: cfdiNuevo.id,
          intento: 1,
          renglones: [
            { orderItemId: itemNuevo, tratamiento: 'IVA_16' },
            { orderItemId: itemYaSellado, tratamiento: 'IVA_0' }, // diverge: ya está sellado en IVA_16
          ],
        }),
      ),
    ).rejects.toThrow('SELLO_DIVERGENTE')

    // Nada cambió: ni el renglón que iba a sellarse de nuevo, ni el que ya estaba sellado.
    expect(await tratamientoDe(itemYaSellado)).toBe('IVA_16')
    expect(await sellosDe(itemYaSellado)).toHaveLength(1)
    expect(await tratamientoDe(itemNuevo)).toBeNull()
    expect(await sellosDe(itemNuevo)).toHaveLength(0)
  })

  it('la liberación revierte junto con la transacción y no toca otro CFDI ni el producto', async () => {
    const orden = await nuevaOrdenConRenglones(2)
    const [item1, item2] = orden.itemIds
    const cfdiA = await nuevoCfdi(orden.id)
    const cfdiB = await nuevoCfdi(orden.id)
    for (const [cfdiId, orderItemId] of [
      [cfdiA.id, item1],
      [cfdiB.id, item2],
    ]) {
      await prisma.$transaction(tx =>
        sellarRenglones(tx, {
          cfdiId,
          intento: 2,
          renglones: [{ orderItemId, tratamiento: 'IVA_16' }],
        }),
      )
    }
    const antes = await prisma.$transaction(tx => renglonesSellados(tx, orden.id))
    await expect(
      prisma.$transaction(async tx => {
        expect(await liberarSellosDe(tx, cfdiA.id)).toEqual({ liberados: 1 })
        expect(await renglonesSellados(tx, orden.id)).toContainEqual({ orderItemId: item1, tratamiento: null, cfdis: 0 })
        throw new Error('ROLLBACK_DE_PRUEBA')
      }),
    ).rejects.toThrow('ROLLBACK_DE_PRUEBA')
    expect(await prisma.$transaction(tx => renglonesSellados(tx, orden.id))).toEqual(antes)
    await prisma.$transaction(tx => liberarSellosDe(tx, cfdiA.id))
    expect(await tratamientoDe(item2)).toBe('IVA_16')
    expect(await sellosDe(item2)).toEqual([expect.objectContaining({ cfdiId: cfdiB.id, intento: 2 })])
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).ivaTratamiento).toBe('IVA_16')
  })

  it('7: liberar un cfdiId sin filas ⇒ { liberados: 0 }, sin error', async () => {
    const resultado = await prisma.$transaction(tx => liberarSellosDe(tx, `cfdi-inexistente-${randomUUID()}`))
    expect(resultado).toEqual({ liberados: 0 })
    expect(await prisma.$transaction(tx => renglonesSellados(tx, `orden-inexistente-${randomUUID()}`))).toEqual([])
  })
})
