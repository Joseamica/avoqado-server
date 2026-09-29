/**
 * IVA por producto, plan 4b · REGLA C en la base (opción C del founder, 29-sep; mecanismo: marca pegajosa, auditoría de Codex),
 * contra Postgres REAL: un producto con la marca `ajusteDeliveryAlgunaVez` —la enciende la conciliación de Uber en la misma
 * transacción que escribe el ajuste (Tarea 5)— no cambia de IVA en ninguna dirección, en ningún nivel de aislamiento; se crea un
 * producto nuevo. La impone el trigger de `Product` para dashboard, móvil, SQL directo y catálogo (su suite). Un alta nunca se
 * bloquea y una edición que no cambia el tratamiento sigue pasando (Review Focus 4). Organización NUEVA por caso.
 */
import { readFileSync } from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import type { Request, Response } from 'express'

import * as movil from '@/controllers/mobile/product.mobile.controller'
import { createProduct, updateProduct, type CreateProductDto } from '@/services/dashboard/product.dashboard.service'
import prisma from '@/utils/prismaClient'
import { apagarIvaPorProducto } from '@tests/__helpers__/iva-por-producto'
import { conProducto, desenlace, limpiarNegocios, nuevoNegocio, type Negocio } from './exclusionContable.fixtures'

jest.setTimeout(120_000)

const AJUSTE = {
  statusCode: 409,
  code: 'IVA_PRODUCTO_CON_AJUSTE_DE_DELIVERY',
  message: 'Este producto ya tuvo ajustes de delivery (Uber). Para venderlo con otro IVA, crea un producto nuevo con el IVA correcto.',
}

let staffId = ''
const actor = () => ({ type: 'HUMAN' as const, staffId, impersonating: false })
const tratamiento = async (id: string) =>
  (await prisma.product.findUniqueOrThrow({ where: { id }, select: { ivaTratamiento: true } })).ivaTratamiento
/** Un choque de foto de Postgres (40001), venga como P2034 de Prisma o con el SQLSTATE en el mensaje. */
const choqueDeFoto = (e: unknown) =>
  (e as { code?: unknown })?.code === 'P2034' || /40001|could not serialize access/.test(String((e as { message?: unknown })?.message))

/** El controlador móvil REAL, sin HTTP (el mismo arnés del plan 4): el error que pasó a `next` o `{ ok: cuerpo }`. */
async function movilLlama(
  handler: (req: Request, res: Response, next: (e?: unknown) => void) => Promise<unknown>,
  params: object,
  body: object,
) {
  let error: unknown = null
  let cuerpo: unknown = null
  const res = { status: () => res, json: (b: unknown) => ((cuerpo = b), res) } as unknown as Response
  await handler({ params, body, authContext: { userId: staffId } } as unknown as Request, res, e => (error = e))
  return error ?? { ok: cuerpo }
}

/**
 * Una venta del producto con un reembolso ya confirmado. El del PROVEEDOR llega como lo deja la conciliación (Tarea 5): el
 * REFUND PROVIDER_ADJUSTMENT y la marca del producto en la MISMA transacción (`marcar: false` = un ajuste escrito antes de
 * que existiera la marca). El manual no marca nada.
 */
async function conReembolso(
  x: Negocio,
  productId: string,
  {
    provenance = 'PROVIDER_ADJUSTMENT',
    marcar = provenance === 'PROVIDER_ADJUSTMENT',
    db = prisma,
  }: { provenance?: 'PROVIDER_ADJUSTMENT' | 'MANUAL'; marcar?: boolean; db?: PrismaClient } = {},
) {
  await db.$transaction(async tx => {
    const orden = await tx.order.create({
      data: { venueId: x.venueId, orderNumber: `4B-C-${productId}-${provenance}`, subtotal: 100, taxAmount: 0, total: 100 },
    })
    await tx.orderItem.create({
      data: { orderId: orden.id, productId, productName: 'Café', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 },
    })
    const base = {
      venueId: x.venueId,
      orderId: orden.id,
      tipAmount: 0,
      method: 'OTHER' as const,
      status: 'COMPLETED' as const,
      splitType: 'FULLPAYMENT' as const,
      source: 'TPV' as const,
      feePercentage: 0,
      feeAmount: 0,
    }
    const venta = await tx.payment.create({ data: { ...base, amount: 100, netAmount: 100, type: 'REGULAR' } })
    await tx.payment.create({
      data: {
        ...base,
        amount: -50,
        netAmount: -50,
        type: 'REFUND',
        processorData:
          provenance === 'PROVIDER_ADJUSTMENT'
            ? {
                provenance,
                originalPaymentId: venta.id,
                generation: 1,
                fiscalByRateCents: { v: 2, porTratamiento: { IVA_16: { baseCents: 4310, ivaCents: 690 } } },
              }
            : { provenance, originalPaymentId: venta.id },
      },
    })
    if (marcar)
      await tx.$executeRaw`UPDATE "Product" SET "ajusteDeliveryAlgunaVez" = true WHERE id = ${productId} AND NOT "ajusteDeliveryAlgunaVez"`
  })
}

beforeAll(async () => {
  staffId = (await prisma.staff.create({ data: { email: `4b-c-${Date.now()}@example.test`, firstName: 'IVA', lastName: 'Plan 4b' } })).id
})

afterAll(async () => {
  await limpiarNegocios()
  await prisma.activityLog.deleteMany({ where: { OR: [{ staffId }, { actorStaffId: staffId }] } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
})

describe('regla C: un producto con la marca de ajuste de delivery no cambia de IVA', () => {
  it('dashboard y móvil: 409 IVA_PRODUCTO_CON_AJUSTE_DE_DELIVERY con el mensaje exacto; el producto sigue IVA_16', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { productId } = await conProducto(x)
    await conReembolso(x, productId)
    expect(await desenlace(updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_0' }, actor()))).toMatchObject(AJUSTE)
    expect(await movilLlama(movil.updateProduct, { venueId: x.venueId, productId }, { ivaTratamiento: 'EXENTO' })).toMatchObject(AJUSTE)
    expect(await tratamiento(productId)).toBe('IVA_16')
  })

  it('en cualquier dirección: un producto en tasa 0 con la marca no regresa a 16 %', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { productId } = await conProducto(x)
    expect(await desenlace(updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_0' }, actor()))).toHaveProperty('ok') // sin marca: pasa
    await conReembolso(x, productId)
    expect(await desenlace(updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_16' }, actor()))).toMatchObject(AJUSTE)
    expect(await tratamiento(productId)).toBe('IVA_0')
  })

  it('SQL directo (READ COMMITTED), por el tratamiento o por la tupla: el trigger lo rechaza', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { productId } = await conProducto(x)
    await conReembolso(x, productId)
    await expect(prisma.$executeRaw`UPDATE "Product" SET "ivaTratamiento" = 'IVA_0' WHERE id = ${productId}`).rejects.toThrow(
      /IVA_PRODUCTO_CON_AJUSTE_DE_DELIVERY/,
    )
    await expect(prisma.$executeRaw`UPDATE "Product" SET "taxRate" = 0 WHERE id = ${productId}`).rejects.toThrow(
      /IVA_PRODUCTO_CON_AJUSTE_DE_DELIVERY/,
    )
    expect(await tratamiento(productId)).toBe('IVA_16')
  })

  // Regresar a IVA_16 en REPEATABLE READ es justo lo que el plan 4 deja pasar (su barrera sólo mira ≠ 16): sólo la marca lo
  // detiene, y como vive en la fila que el UPDATE escribe, ninguna foto vieja la esconde (Ruling 4b-R6).
  it('4b-R6 · SQL directo en REPEATABLE READ: con la foto anterior a la marca choca (40001); con foto nueva, la regla C', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { productId } = await conProducto(x)
    expect(await desenlace(updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_0' }, actor()))).toHaveProperty('ok') // sin marca: pasa
    const otro = new PrismaClient()
    try {
      const conFotoVieja = await prisma
        .$transaction(
          async tx => {
            await tx.$queryRaw`SELECT 1` // la foto de REPEATABLE READ nace aquí
            await conReembolso(x, productId, { db: otro }) // el ajuste y su marca confirman DESPUÉS de la foto
            await tx.$executeRaw`UPDATE "Product" SET "ivaTratamiento" = 'IVA_16' WHERE id = ${productId}`
          },
          { isolationLevel: 'RepeatableRead' },
        )
        .then(
          () => 'pasó',
          (e: unknown) => e,
        )
      expect(choqueDeFoto(conFotoVieja)).toBe(true)
      await expect(
        prisma.$transaction(tx => tx.$executeRaw`UPDATE "Product" SET "ivaTratamiento" = 'IVA_16' WHERE id = ${productId}`, {
          isolationLevel: 'RepeatableRead',
        }),
      ).rejects.toThrow(/IVA_PRODUCTO_CON_AJUSTE_DE_DELIVERY/)
      expect(await tratamiento(productId)).toBe('IVA_0')
    } finally {
      await otro.$disconnect()
    }
  })

  it('con sólo un reembolso MANUAL (sin ajuste del proveedor, sin marca) el cambio pasa', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { productId } = await conProducto(x)
    await conReembolso(x, productId, { provenance: 'MANUAL' })
    expect(await desenlace(updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_0' }, actor()))).toHaveProperty('ok')
    expect(await tratamiento(productId)).toBe('IVA_0')
  })

  // Pasa también HOY: vigila que la regla no se implemente de más.
  it('Review Focus 4 · con la marca, lo que NO cambia el tratamiento sigue pasando', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { productId } = await conProducto(x)
    await conReembolso(x, productId)
    expect(await desenlace(updateProduct(x.venueId, productId, { name: 'Café de olla', price: 120 }, actor()))).toHaveProperty('ok')
    expect(await desenlace(updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_16' }, actor()))).toHaveProperty('ok')
    expect(
      await movilLlama(movil.updateProduct, { venueId: x.venueId, productId }, { taxRate: 0.16, objetoImp: '02', name: 'Café móvil' }),
    ).toHaveProperty('ok')
    await prisma.$executeRaw`UPDATE "Product" SET "taxRate" = "taxRate", "objetoImp" = "objetoImp", name = 'Café crudo' WHERE id = ${productId}`
    expect(await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { name: true, ivaTratamiento: true } })).toEqual({
      name: 'Café crudo',
      ivaTratamiento: 'IVA_16',
    })
  })

  // Pasa también HOY.
  it('un alta nunca se bloquea: «Bolsa de café 2» nace con otro IVA en el mismo negocio', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { categoryId, productId } = await conProducto(x)
    await conReembolso(x, productId)
    const alta = {
      name: 'Bolsa de café 2',
      price: 480,
      type: 'REGULAR',
      sku: `B2-${x.rfc}`,
      categoryId,
      ivaTratamiento: 'IVA_0',
    } as CreateProductDto
    expect(await desenlace(createProduct(x.venueId, alta, actor()))).toHaveProperty('ok')
    expect(await prisma.product.count({ where: { venueId: x.venueId, ivaTratamiento: 'IVA_0' } })).toBe(1)
  })

  // Pasa también HOY (la regla C va después de la barrera ≠ IVA_16).
  it('con la bandera apagada manda IVA_POR_PRODUCTO_APAGADO, también en SQL directo', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { productId } = await conProducto(x)
    await conReembolso(x, productId)
    await apagarIvaPorProducto(x.venueId)
    expect(await desenlace(updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_0' }, actor()))).toMatchObject({
      statusCode: 409,
      code: 'IVA_POR_PRODUCTO_APAGADO',
    })
    await expect(prisma.$executeRaw`UPDATE "Product" SET "ivaTratamiento" = 'IVA_0' WHERE id = ${productId}`).rejects.toThrow(
      /IVA_POR_PRODUCTO_APAGADO/,
    )
  })

  // Prueba de la migración 1 (no hay rojo previo posible: la columna nace con ella). Discrimina con un caso de cada lado.
  it('la marca inicial de la migración enciende SÓLO los productos con un ajuste del proveedor ya escrito', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { categoryId, productId: viejo } = await conProducto(x)
    const manual = (
      await prisma.product.create({ data: { venueId: x.venueId, categoryId, sku: `M-${x.rfc}`, name: 'Manual', price: 100 } })
    ).id
    await conReembolso(x, viejo, { marcar: false }) // un ajuste escrito ANTES de que existiera la marca
    await conReembolso(x, manual, { provenance: 'MANUAL' })
    const migracion = path.join(__dirname, '../../../prisma/migrations/20260929000000_producto_ajuste_de_delivery/migration.sql')
    const marcaInicial = readFileSync(migracion, 'utf8').split('-- marca-inicial:inicio')[1].split('-- marca-inicial:fin')[0]
    const REVERTIR = new Error('revertir la marca inicial')
    await expect(
      prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(marcaInicial)
        const marcas = await tx.product.findMany({
          where: { id: { in: [viejo, manual] } },
          select: { id: true, ajusteDeliveryAlgunaVez: true },
        })
        expect(Object.fromEntries(marcas.map(m => [m.id, m.ajusteDeliveryAlgunaVez]))).toEqual({ [viejo]: true, [manual]: false })
        throw REVERTIR // la marca inicial recorre TODA la base: se revierte, no deja rastro en otras suites
      }),
    ).rejects.toBe(REVERTIR)
  })
})
