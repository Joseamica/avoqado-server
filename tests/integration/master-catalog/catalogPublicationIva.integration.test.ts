/**
 * IVA por producto · D15 (spec planes 6-7 §4.7 y §11): el catálogo maestro ya no administra el IVA. Publicar un artículo cuyo
 * `taxRate` cambió, o revertir una publicación, NO toca el IVA del producto del negocio, en ninguna situación: bandera apagada,
 * organización con contabilidad, producto con ajuste de delivery (regla C, también en plena carrera con la conciliación), o
 * negocio encendido con el producto al 0 % y sin publicación previa (H11). Todo con la vista previa, el confirm y la reversión
 * REALES contra Postgres.
 *
 * Hasta el bloque B4a este archivo probaba que esa publicación chocaba con la barrera de IVA del trigger de `Product` (R12, plan 4).
 * Esa premisa ya no existe. El mapeo R12 se conserva como defensa y lo siguen probando las unitarias de
 * `catalogPublicationConfirmation.service.test.ts` (describe «R12 · IVA por producto…»).
 *
 * Cada caso usa una organización NUEVA (Ruling PF7): la marca de IVA mixto nunca se regresa a falso.
 */
import { DeliveryProvider, OrderSource, Prisma } from '@prisma/client'

import { CatalogPublicationWatchdogJob } from '@/jobs/catalog-publication-watchdog.job'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { reconcileDeliveryOrderFromProvider } from '@/services/delivery-channels/core/deliveryReconciliation.service'
import type { NormalizedDeliveryOrder, NormalizedDeliveryPayment } from '@/services/delivery-channels/core/types'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'
import { acquireCatalogMutationLock } from '@/services/master-catalog/catalogMutationLock.service'
import type { CatalogCommandContext } from '@/types/master-catalog'
import prisma from '@/utils/prismaClient'
import * as reintento from '@/utils/serializableRetry'
import { apagarIvaPorProducto } from '@tests/__helpers__/iva-por-producto'
import { desenlace, hastaQue, marcada, nuevoRfc, polizaSuelta, retener } from '../fiscal/exclusionContable.fixtures'
import {
  assertDisposableCatalogPublicationDatabase,
  cleanupCatalogPublicationFixture,
  createCatalogPublicationFixture,
  createCatalogPublicationIntegrationHarness,
  type CatalogPublicationFixture,
  type CatalogPublicationIntegrationHarness,
} from './catalogPublicationIntegrationHarness'

jest.setTimeout(240_000)

const MASCARA_V2 = ['cost', 'description', 'imageUrl', 'name', 'satProductKey', 'satUnitKey', 'type', 'unit']
const MENSAJE: Record<string, string> = { CATALOG_PUBLICATION_ATTEMPT_EXPIRED: 'El intento de publicación expiró.' }

let harness: CatalogPublicationIntegrationHarness | null = null
const fixtures: CatalogPublicationFixture[] = []
const h = () => {
  if (!harness) throw new Error('El arnés del catálogo no se inició')
  return harness
}
const sinCron = () => ({ start: jest.fn(), stop: jest.fn() }) as never

/** Lo que `isRetryableDbError` vio: prueba que un 40001 llegó y se trató como choque. */
const errores: unknown[] = []
const huboUn40001 = () =>
  errores.some(
    e =>
      (e as any)?.code === 'P2034' || /40001/.test(JSON.stringify({ c: (e as any)?.code, m: (e as any)?.meta, msg: (e as any)?.message })),
  )

beforeAll(async () => {
  assertDisposableCatalogPublicationDatabase()
  harness = await createCatalogPublicationIntegrationHarness('iva-catalogo')
})
beforeEach(() => {
  errores.length = 0
  const original = reintento.isRetryableDbError
  jest.spyOn(reintento, 'isRetryableDbError').mockImplementation(e => (errores.push(e), original(e)))
})
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  try {
    for (const f of fixtures) {
      await h().primary.journalEntry.deleteMany({ where: { organizationId: f.organizationId } })
      await h().primary.ledgerAccount.deleteMany({ where: { organizationId: f.organizationId } })
      await cleanupCatalogPublicationFixture(h().primary, f)
    }
  } finally {
    await harness?.disconnect()
  }
})

/** Alguien de `app` espera un candado que retiene `pid`, con una consulta como `like`; devuelve su pid. */
const esperaDetrasDe = (pid: number, like: string, descripcion: string, plazoMs = 4_000, app?: string) =>
  hastaQue(
    h().observer,
    descripcion,
    plazoMs,
    Prisma.sql`SELECT a.pid FROM pg_stat_activity a
      WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
        AND ${pid}::int = ANY(pg_blocking_pids(a.pid)) AND a.query LIKE ${like}
        AND (${app ?? null}::text IS NULL OR a.application_name = ${app ?? null}::text)
      LIMIT 1`,
  )

/** Organización nueva con su artículo vinculado y sin publicación previa; `publicar` y `revertir` usan los servicios REALES. */
async function negocioConCatalogo(suite: string, { bandera = true, productTaxRate = '0.1600' } = {}) {
  const f = await createCatalogPublicationFixture(h().primary, suite, { productTaxRate })
  fixtures.push(f)
  if (!bandera) await apagarIvaPorProducto(f.venueId, h().primary)
  const { createCatalogPublicationPreviewService } = await import('@/services/master-catalog/catalogPublicationPreview.service')
  const { createCatalogPublicationConfirmationService } = await import('@/services/master-catalog/catalogPublicationConfirmation.service')
  const { createCatalogPublicationReversionPreviewService } = await import('@/services/master-catalog/catalogPublicationReversion.service')
  const context: CatalogCommandContext = {
    organizationId: f.organizationId,
    actor: { type: 'HUMAN', staffId: f.staffId, impersonating: false },
    orgRole: 'OWNER',
  }
  const confirmar = (preview: { publicationBatchId: string; previewToken: string }, idempotencyKey: string) =>
    createCatalogPublicationConfirmationService({ prisma: h().writerOne as never }).confirm(context, {
      publicationBatchId: preview.publicationBatchId,
      previewToken: preview.previewToken,
      idempotencyKey,
      confirm: true,
    })
  /** El artículo pasa a `taxRate` y se publica al negocio (vista previa nueva, key nueva). */
  const publicar = async (taxRate: string, etiqueta: string) => {
    await h().primary.catalogItem.update({
      where: { id: f.catalogItemId },
      data: { taxRate, revision: { increment: 1 }, updatedById: f.staffId },
    })
    const idempotencyKey = `iva-catalogo-${etiqueta}-${f.key}`
    const preview = await createCatalogPublicationPreviewService({ prisma: h().primary as never }).preview(context, {
      operation: 'CATALOG_FIELDS_PUBLISH',
      idempotencyKey,
      targets: [{ catalogItemId: f.catalogItemId, venueId: f.venueId, productId: f.productId }],
    })
    expect(preview.canConfirm).toBe(true)
    return { batchId: preview.publicationBatchId, idempotencyKey, preview, confirmar: () => confirmar(preview, idempotencyKey) }
  }
  /** Revierte la línea APLICADA del lote `batchId` con la reversión REAL. */
  const revertir = async (batchId: string, etiqueta: string) => {
    const fuente = await h().observer.catalogPublicationLine.findFirstOrThrow({ where: { batchId }, select: { id: true } })
    const idempotencyKey = `iva-catalogo-revertir-${etiqueta}-${f.key}`
    const preview = await createCatalogPublicationReversionPreviewService({ prisma: h().primary as never }).preview(context, {
      operation: 'CATALOG_FIELDS_REVERSION',
      idempotencyKey,
      targets: [{ catalogItemId: f.catalogItemId, venueId: f.venueId, productId: f.productId, sourceLineId: fuente.id }],
    })
    expect(preview.canConfirm).toBe(true)
    return confirmar(preview, idempotencyKey)
  }
  return { f, publicar, revertir }
}

const lote = (batchId: string) =>
  h().observer.catalogPublicationBatch.findUniqueOrThrow({
    where: { id: batchId },
    select: { state: true, attemptId: true, leaseExpiresAt: true, failureCode: true },
  })

/** El lote y su registro terminaron FAILED con este motivo, sin intento ni reserva. */
async function terminado(f: CatalogPublicationFixture, pub: { batchId: string; idempotencyKey: string }, failureCode: string) {
  const [batch, record] = await Promise.all([
    h().observer.catalogPublicationBatch.findUniqueOrThrow({ where: { id: pub.batchId } }),
    h().observer.catalogIdempotencyRecord.findUniqueOrThrow({
      where: {
        organizationId_operation_idempotencyKey: {
          organizationId: f.organizationId,
          operation: 'CATALOG_FIELDS_PUBLISH',
          idempotencyKey: pub.idempotencyKey,
        },
      },
    }),
  ])
  for (const fila of [batch, record]) {
    expect(fila).toMatchObject({
      state: 'FAILED',
      failureCode,
      failureMessage: MENSAJE[failureCode],
      attemptId: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      completedAt: expect.any(Date),
    })
  }
}

const producto = async (f: CatalogPublicationFixture) => {
  const p = await h().observer.product.findUniqueOrThrow({
    where: { id: f.productId },
    select: { ivaTratamiento: true, taxRate: true, name: true, ajusteDeliveryAlgunaVez: true },
  })
  return { ivaTratamiento: p.ivaTratamiento, taxRate: p.taxRate.toFixed(4), name: p.name, ajuste: p.ajusteDeliveryAlgunaVez }
}

/** Un ajuste de delivery sobre el producto, como lo deja la conciliación: la venta, el REFUND PROVIDER_ADJUSTMENT y la marca. */
const ajusteDeDelivery = (f: CatalogPublicationFixture) =>
  h().primary.$transaction(async tx => {
    const orden = await tx.order.create({
      data: { venueId: f.venueId, orderNumber: `4B-CAT-${f.key}`, subtotal: 100, taxAmount: 0, total: 100 },
    })
    await tx.orderItem.create({
      data: { orderId: orden.id, productId: f.productId, productName: 'Café', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 },
    })
    await tx.payment.create({
      data: {
        venueId: f.venueId,
        orderId: orden.id,
        amount: -50,
        tipAmount: 0,
        netAmount: -50,
        method: 'OTHER',
        status: 'COMPLETED',
        type: 'REFUND',
        splitType: 'FULLPAYMENT',
        source: 'TPV',
        feePercentage: 0,
        feeAmount: 0,
        processorData: {
          provenance: 'PROVIDER_ADJUSTMENT',
          generation: 1,
          fiscalByRateCents: { v: 2, porTratamiento: { IVA_16: { baseCents: 4310, ivaCents: 690 } } },
        },
      },
    })
    await tx.$executeRaw`UPDATE "Product" SET "ajusteDeliveryAlgunaVez" = true WHERE id = ${f.productId} AND NOT "ajusteDeliveryAlgunaVez"`
    return orden.id
  })
const borrarOrden = async (orderId: string) => {
  await h().primary.payment.deleteMany({ where: { orderId } })
  await h().primary.orderItem.deleteMany({ where: { orderId } })
  await h().primary.order.delete({ where: { id: orderId } })
}

/** Un pedido de Uber REAL (la ingesta de siempre) en el negocio del catálogo; su renglón `a` vende el producto del catálogo.
 *  `retirar()` hace que el proveedor conteste sin el renglón `b`. */
async function pedidoDeUber(f: CatalogPublicationFixture) {
  const link = await prisma.deliveryChannelLink.create({
    data: { venueId: f.venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: `store-4b-${f.key}`, webhookSecret: 'x' },
  })
  const pago = (venta: string): NormalizedDeliveryPayment => ({
    currency: 'MXN',
    saleAmount: venta,
    merchantFees: '0.00',
    discountAmount: '0.00',
    tipAmount: '0.00',
    externallyPaidSale: venta,
    externallyPaidTip: '0.00',
    cashDueSale: '0.00',
    cashDueTip: '0.00',
  })
  const renglon = (linea: string) => ({
    externalId: `${linea}-${f.key}`,
    lineId: linea,
    name: `${linea} ${f.key}`,
    quantity: 1,
    unitPrice: '100.00',
    total: '100.00',
  })
  const pedido: NormalizedDeliveryOrder = {
    externalId: `4b-cat-${f.key}`,
    displayId: '4B',
    source: OrderSource.UBER_EATS,
    items: [renglon('a'), renglon('b')],
    payment: pago('200.00'),
    customer: { name: 'Cliente plan 4b' },
    raw: { fuente: 'test' },
    placedAt: new Date(),
  }
  const { order } = await ingestDeliveryOrder(pedido, link)
  await prisma.orderItem.updateMany({ where: { orderId: order.id, externalLineId: 'a' }, data: { productId: f.productId } })
  const retirar = () => {
    jest.spyOn(uberAdapter, 'fetchOrder').mockResolvedValue({ ...pedido, items: [renglon('a')], payment: pago('100.00') })
    jest.spyOn(uberAdapter, 'normalizeOrder').mockImplementation(raw => raw as NormalizedDeliveryOrder)
  }
  return { orderId: order.id, retirar }
}

/** Lo que deja un pedido de Uber en el negocio (la limpieza del arnés no lo cubre): la lista de `reconciliacionDinero.test.ts`. */
async function borrarReparto(venueId: string) {
  const pagos = (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id)
  await prisma.deliveryLineAction.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.venueTransaction.deleteMany({ where: { venueId } })
  await prisma.paymentEffect.deleteMany({ where: { paymentId: { in: pagos } } })
  await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: pagos } } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } })
  await prisma.kdsOrder.deleteMany({ where: { venueId } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
  await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId } })
  await prisma.venueTenderType.deleteMany({ where: { venueId } })
}

describe('D15 · el catálogo maestro no toca el IVA del producto', () => {
  it.each([
    {
      caso: 'bandera apagada',
      suite: 'iva-apagada',
      opciones: { bandera: false, productTaxRate: '0.1600' },
      historia: false,
      ajuste: false,
      articulo: '0.0000',
      esperado: { ivaTratamiento: 'IVA_16', taxRate: '0.1600', ajuste: false },
    },
    {
      caso: 'organización con pólizas',
      suite: 'iva-historia',
      opciones: { bandera: true, productTaxRate: '0.1600' },
      historia: true,
      ajuste: false,
      articulo: '0.0000',
      esperado: { ivaTratamiento: 'IVA_16', taxRate: '0.1600', ajuste: false },
    },
    {
      caso: 'producto con ajuste de delivery (regla C)',
      suite: 'iva-ajuste-delivery',
      opciones: { bandera: true, productTaxRate: '0.1600' },
      historia: false,
      ajuste: true,
      articulo: '0.0000',
      esperado: { ivaTratamiento: 'IVA_16', taxRate: '0.1600', ajuste: true },
    },
    {
      caso: 'negocio encendido, producto al 0 % y sin publicación previa (H11)',
      suite: 'iva-h11',
      opciones: { bandera: true, productTaxRate: '0.0000' },
      historia: false,
      ajuste: false,
      articulo: '0.1600',
      esperado: { ivaTratamiento: 'IVA_0', taxRate: '0.0000', ajuste: false },
    },
  ])(
    '$caso: APPLIED, el nombre se publica y el IVA del producto queda igual',
    async ({ suite, opciones, historia, ajuste, articulo, esperado }) => {
      const { f, publicar } = await negocioConCatalogo(suite, opciones)
      if (historia) await polizaSuelta(f.organizationId, nuevoRfc(), f.venueId)
      const orden = ajuste ? await ajusteDeDelivery(f) : null
      try {
        const marcaAntes = await marcada(f.organizationId)
        const a = await publicar(articulo, suite)
        expect(a.preview.lines[0].fields.map(field => field.field)).toEqual(MASCARA_V2)

        await expect(a.confirmar()).resolves.toMatchObject({ state: 'APPLIED' })
        expect(await producto(f)).toEqual({ ...esperado, name: 'Corporate name' })
        expect(await marcada(f.organizationId)).toBe(marcaAntes)
        const linea = await h().observer.catalogPublicationLine.findFirstOrThrow({
          where: { batchId: a.batchId },
          select: { fieldMask: true },
        })
        expect(linea.fieldMask).toEqual(MASCARA_V2)
      } finally {
        if (orden) await borrarOrden(orden)
      }
    },
  )

  // Review Focus de 4b (Ruling 4b-R6), conservado: la aplicación fijó su foto ANTES del primer ajuste, y ese ajuste lo escribe la
  // conciliación REAL. La fila del producto cambia después de la foto: la publicación choca (40001), reintenta desde una foto
  // nueva y, como ya no escribe IVA, se APLICA.
  it('carrera D: la conciliación confirma el primer ajuste después de la foto de la publicación; ésta choca (40001), reintenta y se aplica sin tocar el IVA ni la marca', async () => {
    const { f, publicar } = await negocioConCatalogo('iva-ajuste-foto-vieja')
    let publicacion: Promise<unknown> = Promise.resolve()
    try {
      const pedido = await pedidoDeUber(f)
      const a0 = await publicar('0.0000', 'ajuste-foto-vieja')
      // La aplicación toma su intento (y con él su foto) y se forma detrás del candado de catálogo que retiene otra transacción.
      const antesala = await retener(h().writerTwo, tx => acquireCatalogMutationLock(tx, f.organizationId))
      try {
        publicacion = desenlace(a0.confirmar())
        await esperaDetrasDe(
          antesala.pid,
          '%pg_advisory_xact_lock%',
          'la aplicación, con su foto ya fijada, formada detrás del candado de catálogo',
          60_000,
          h().names.writerOne,
        )
        // La conciliación REAL: la aplicación todavía no tiene el producto; aquí se toma, se escribe el ajuste y se marca.
        pedido.retirar()
        expect(await reconcileDeliveryOrderFromProvider(pedido.orderId, { trigger: 'ROUTE' })).toMatchObject({ outcome: 'REFUNDED' })
        expect((await prisma.product.findUniqueOrThrow({ where: { id: f.productId } })).ajusteDeliveryAlgunaVez).toBe(true)
      } finally {
        await antesala.soltar()
      }
      expect(await publicacion).toMatchObject({ ok: { state: 'APPLIED' } })
      expect(await producto(f)).toEqual({ ivaTratamiento: 'IVA_16', taxRate: '0.1600', name: 'Corporate name', ajuste: true })
      expect(huboUn40001()).toBe(true) // la fila del producto cambió después de su foto: chocó y se repitió
    } finally {
      await publicacion // ninguna aplicación queda viva detrás de la limpieza, ni con el rojo
      await borrarReparto(f.venueId)
    }
  })

  it('revertir tampoco toca el IVA: el negocio pasó el producto a 0 % después de publicar y la reversión regresa sólo el nombre', async () => {
    const { f, publicar, revertir } = await negocioConCatalogo('iva-revertir')
    const a = await publicar('0.1600', 'revertir')
    await expect(a.confirmar()).resolves.toMatchObject({ state: 'APPLIED' })
    await h().primary.product.update({ where: { id: f.productId }, data: { ivaTratamiento: 'IVA_0' } })

    await expect(revertir(a.batchId, 'revertir')).resolves.toMatchObject({ state: 'APPLIED' })
    expect(await producto(f)).toEqual({ ivaTratamiento: 'IVA_0', taxRate: '0.0000', name: 'Local name', ajuste: false })
    const binding = await h().observer.catalogVenueBinding.findUniqueOrThrow({
      where: { id: f.bindingId },
      select: { managedFieldMask: true },
    })
    expect(binding.managedFieldMask).toEqual(MASCARA_V2)
  })

  it('regresión: otro error al aplicar sigue como hoy (queda APPLYING); el watchdog no toca el intento vivo y pasa a FAILED el vencido', async () => {
    const { f, publicar } = await negocioConCatalogo('iva-regresion')
    const a16 = await publicar('0.1600', 'regresion')
    // El artículo cambia DESPUÉS de la vista previa: la aplicación la encuentra vieja.
    await h().primary.catalogItem.update({ where: { id: f.catalogItemId }, data: { revision: { increment: 1 }, updatedById: f.staffId } })

    expect(await desenlace(a16.confirmar())).toMatchObject({ statusCode: 409, code: 'STALE_PREVIEW' })
    const vivo = await lote(a16.batchId)
    expect(vivo).toMatchObject({ state: 'APPLYING', attemptId: expect.any(String), leaseExpiresAt: expect.any(Date), failureCode: null })

    await new CatalogPublicationWatchdogJob({ prisma: h().writerTwo as never, cron: sinCron() }).runNow()
    expect(await lote(a16.batchId)).toEqual(vivo)

    const vencido = await new CatalogPublicationWatchdogJob({
      prisma: h().writerTwo as never,
      cron: sinCron(),
      now: () => new Date((vivo.leaseExpiresAt as Date).getTime() + 1),
    }).runNow()
    expect(vencido).toMatchObject({ errors: 0 })
    expect(vencido.failed).toBeGreaterThanOrEqual(1)
    await terminado(f, a16, 'CATALOG_PUBLICATION_ATTEMPT_EXPIRED')
  })
})
