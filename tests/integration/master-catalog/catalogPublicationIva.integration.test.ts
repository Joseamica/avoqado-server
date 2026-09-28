/**
 * IVA por producto, plan 4 · Tarea 4 (Ruling R12) — una publicación de catálogo que choca con la barrera de IVA del trigger de
 * `Product` termina EN ESE MOMENTO, con su motivo: el lote y su registro de idempotencia pasan a `FAILED` (el mismo CAS doble
 * del watchdog), se CONFIRMA, y sólo después el confirm responde 409 con el código. Un choque de concurrencia en el paso de
 * aplicar se reintenta mientras la reserva siga vigente. Todo con la vista previa y el confirm REALES contra Postgres; las
 * carreras se pausan con un bloqueador y la espera se prueba en `pg_stat_activity` antes de soltar.
 *
 * Cada caso usa una organización NUEVA (Ruling PF7): la marca de IVA mixto nunca se regresa a falso.
 */
import { Prisma } from '@prisma/client'

import { ConflictError } from '@/errors/AppError'
import { CatalogPublicationWatchdogJob } from '@/jobs/catalog-publication-watchdog.job'
import { seedBaseChart } from '@/services/fiscal/chartOfAccounts.service'
import { createManualEntry } from '@/services/fiscal/journalEntry.service'
import { acquireCatalogMutationLock } from '@/services/master-catalog/catalogMutationLock.service'
import type { CatalogCommandContext } from '@/types/master-catalog'
import prisma from '@/utils/prismaClient'
import * as reintento from '@/utils/serializableRetry'
import { apagarIvaPorProducto } from '@tests/__helpers__/iva-por-producto'
import { desenlace, hastaQue, lineasDeVenta, marcada, nuevoRfc, polizaSuelta, retener } from '../fiscal/exclusionContable.fixtures'
import {
  assertDisposableCatalogPublicationDatabase,
  cleanupCatalogPublicationFixture,
  createCatalogPublicationFixture,
  createCatalogPublicationIntegrationHarness,
  type CatalogPublicationFixture,
  type CatalogPublicationIntegrationHarness,
} from './catalogPublicationIntegrationHarness'

jest.setTimeout(240_000)

const MENSAJE: Record<string, string> = {
  IVA_POR_PRODUCTO_APAGADO:
    'El IVA por producto no está activado para este negocio. Todos los productos se venden con IVA 16 %. Pídele a Avoqado que lo active.',
  IVA_CONTABILIDAD_CON_HISTORIA:
    'Este negocio ya lleva contabilidad en Avoqado (pólizas o periodos cerrados) y la contabilidad todavía no maneja IVA distinto de 16 %. Por eso este producto se queda en IVA 16 %. Escríbenos a hola@avoqado.io si lo necesitas.',
  CATALOG_PUBLICATION_ATTEMPT_EXPIRED: 'El intento de publicación expiró.',
}

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

/** Organización SIN marca (producto al 16 %) con su artículo corporativo ya vinculado; `publicar` usa la vista previa REAL. */
async function negocioConCatalogo(suite: string, { bandera = true } = {}) {
  const f = await createCatalogPublicationFixture(h().primary, suite, { productTaxRate: '0.1600' })
  fixtures.push(f)
  if (!bandera) await apagarIvaPorProducto(f.venueId, h().primary)
  const { createCatalogPublicationPreviewService } = await import('@/services/master-catalog/catalogPublicationPreview.service')
  const { createCatalogPublicationConfirmationService } = await import('@/services/master-catalog/catalogPublicationConfirmation.service')
  const context: CatalogCommandContext = {
    organizationId: f.organizationId,
    actor: { type: 'HUMAN', staffId: f.staffId, impersonating: false },
    orgRole: 'OWNER',
  }
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
    return {
      batchId: preview.publicationBatchId,
      idempotencyKey,
      confirmar: () =>
        createCatalogPublicationConfirmationService({ prisma: h().writerOne as never }).confirm(context, {
          publicationBatchId: preview.publicationBatchId,
          previewToken: preview.previewToken,
          idempotencyKey,
          confirm: true,
        }),
    }
  }
  return { f, publicar }
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

const producto = (f: CatalogPublicationFixture) =>
  h().observer.product.findUniqueOrThrow({ where: { id: f.productId }, select: { ivaTratamiento: true, name: true } })

/** El 409 del IVA, con su código y el mensaje al cliente, como ConflictError (nunca un P2010 crudo). */
function esElDeIva(r: unknown, code: string) {
  expect(r).toMatchObject({ statusCode: 409, code, message: MENSAJE[code] })
  expect(r).toBeInstanceOf(ConflictError)
}

describe('una publicación de catálogo rechazada por IVA termina en ese momento, con su motivo (R12)', () => {
  it.each([
    { caso: 'bandera apagada', bandera: false, historia: false, code: 'IVA_POR_PRODUCTO_APAGADO' },
    { caso: 'bandera encendida y la organización ya tiene pólizas', bandera: true, historia: true, code: 'IVA_CONTABILIDAD_CON_HISTORIA' },
  ])(
    '$caso: 409 $code, lote y registro FAILED; al regresar el artículo a 16 % se publica de inmediato',
    async ({ bandera, historia, code }) => {
      const { f, publicar } = await negocioConCatalogo(historia ? 'iva-historia' : 'iva-apagada', { bandera })
      if (historia) await polizaSuelta(f.organizationId, nuevoRfc(), f.venueId)

      const a0 = await publicar('0.0000', 'a0')
      esElDeIva(await desenlace(a0.confirmar()), code)
      await terminado(f, a0, code)
      expect(await producto(f)).toEqual({ ivaTratamiento: 'IVA_16', name: 'Local name' })
      expect(await marcada(f.organizationId)).toBe(false)

      // Sin esperar los 120 s de la reserva: una vista previa y un confirm NUEVOS funcionan ya.
      const a16 = await publicar('0.1600', 'a16')
      await expect(a16.confirmar()).resolves.toMatchObject({ state: 'APPLIED' })
      expect(await producto(f)).toEqual({ ivaTratamiento: 'IVA_16', name: 'Corporate name' })
    },
  )

  it('contra un posteo: la póliza confirma después de la foto de la aplicación; ésta choca (40001), reintenta, ve la póliza y sale 409 IVA_CONTABILIDAD_CON_HISTORIA', async () => {
    const { f, publicar } = await negocioConCatalogo('iva-posteo')
    const rfc = nuevoRfc()
    await prisma.venue.update({ where: { id: f.venueId }, data: { rfc } })
    await seedBaseChart(f.venueId, { staffId: null })
    const lines = await lineasDeVenta(f.organizationId, rfc)
    const a0 = await publicar('0.0000', 'posteo')

    // La aplicación toma el candado de intento (y con él su foto) y se deja formada justo antes de Organization: su candado
    // de catálogo lo retiene otra transacción. El posteo toma Organization FOR SHARE y se queda esperando su cuenta.
    const antesala = await retener(h().writerTwo, tx => acquireCatalogMutationLock(tx, f.organizationId))
    const cuenta = await retener(
      h().blocker,
      tx => tx.$queryRaw`SELECT id FROM "LedgerAccount" WHERE id = ${lines[0].ledgerAccountId} FOR UPDATE`,
    )
    let publicacion: Promise<unknown> = Promise.resolve()
    let posteo: Promise<unknown> = Promise.resolve()
    try {
      publicacion = desenlace(a0.confirmar())
      await esperaDetrasDe(
        antesala.pid,
        '%pg_advisory_xact_lock%',
        'la aplicación, con su foto ya fijada, formada antes de Organization',
        60_000,
        h().names.writerOne,
      )
      posteo = desenlace(
        createManualEntry(f.venueId, { date: '2026-06-15', concept: 'Póliza contra el catálogo', lines }, { staffId: null }),
      )
      const pidPosteo = await esperaDetrasDe(
        cuenta.pid,
        '%INSERT INTO "public"."JournalLine"%',
        'el posteo, ya con Organization FOR SHARE, esperando la cuenta retenida',
      )
      await antesala.soltar()
      await esperaDetrasDe(
        pidPosteo,
        '%FROM "Organization"%FOR NO KEY UPDATE%',
        'la aplicación esperando la organización que retiene el posteo',
        4_000,
        h().names.writerOne,
      )
    } finally {
      await antesala.soltar()
      await cuenta.soltar()
    }

    const [p, q] = [await publicacion, await posteo]
    expect(q).toMatchObject({ ok: { totalDebitCents: 11_600 } })
    esElDeIva(p, 'IVA_CONTABILIDAD_CON_HISTORIA')
    await terminado(f, a0, 'IVA_CONTABILIDAD_CON_HISTORIA')
    expect(await producto(f)).toEqual({ ivaTratamiento: 'IVA_16', name: 'Local name' })
    expect(await marcada(f.organizationId)).toBe(false)
    expect(await prisma.journalEntry.count({ where: { organizationId: f.organizationId } })).toBe(1)
    expect(huboUn40001()).toBe(true) // la aplicación chocó con la póliza confirmada tras su foto y se repitió
  })

  it('contra el watchdog: el watchdog termina antes el intento vencido; el cierre del confirm cambia 0/0 filas y responde el 409 de IVA sin 500', async () => {
    const { f, publicar } = await negocioConCatalogo('iva-watchdog', { bandera: false })
    const a0 = await publicar('0.0000', 'watchdog')
    // Fuera de la ventana: el watchdog con el reloj real barre intentos vencidos de corridas viejas.
    await new CatalogPublicationWatchdogJob({ prisma: h().writerTwo as never, cron: sinCron() }).runNow()

    const articulo = await retener(h().blocker, tx => tx.$queryRaw`SELECT id FROM "CatalogItem" WHERE id = ${f.catalogItemId} FOR UPDATE`)
    let fila: Awaited<ReturnType<typeof retener>> | null = null
    let publicacion: Promise<unknown> = Promise.resolve()
    let vigilancia: Promise<unknown> = Promise.resolve()
    try {
      publicacion = desenlace(a0.confirmar())
      const pidAplicacion = await esperaDetrasDe(
        articulo.pid,
        '%FROM "CatalogItem"%',
        'la aplicación, con el candado de intento, esperando el artículo retenido',
        60_000,
        h().names.writerOne,
      )
      const { leaseExpiresAt } = await lote(a0.batchId)
      // La fila del lote retenida: el watchdog, ya con el candado de intento, se detiene antes de confirmar su FAILED.
      fila = await retener(h().primary, tx => tx.$queryRaw`SELECT id FROM "CatalogPublicationBatch" WHERE id = ${a0.batchId} FOR UPDATE`)
      // El watchdog REAL con su reloj un milisegundo después del vencimiento, en vez de esperar los 120 s.
      const watchdog = new CatalogPublicationWatchdogJob({
        prisma: h().writerTwo as never,
        cron: sinCron(),
        now: () => new Date((leaseExpiresAt as Date).getTime() + 1),
      })
      vigilancia = desenlace(watchdog.runNow())
      const pidWatchdog = await esperaDetrasDe(
        pidAplicacion,
        '%pg_advisory_xact_lock%',
        'el watchdog esperando el candado de intento que tiene la aplicación',
        4_000,
        h().names.writerTwo,
      )
      await articulo.soltar()
      await esperaDetrasDe(
        fila.pid,
        '%CatalogPublicationBatch%',
        'el watchdog, ya con el candado de intento, esperando la fila del lote',
        4_000,
        h().names.writerTwo,
      )
      await esperaDetrasDe(
        pidWatchdog,
        '%pg_advisory_xact_lock%',
        'el cierre del confirm, con su foto ya fijada, esperando el candado de intento que tiene el watchdog',
        4_000,
        h().names.writerOne,
      )
    } finally {
      await articulo.soltar()
      await fila?.soltar()
    }

    const [p, w] = [await publicacion, await vigilancia]
    expect(w).toMatchObject({ ok: { errors: 0 } })
    expect((w as { ok: { failed: number } }).ok.failed).toBeGreaterThanOrEqual(1)
    esElDeIva(p, 'IVA_POR_PRODUCTO_APAGADO')
    await terminado(f, a0, 'CATALOG_PUBLICATION_ATTEMPT_EXPIRED') // ganó el watchdog; el confirm no pisó su motivo
    expect(await producto(f)).toEqual({ ivaTratamiento: 'IVA_16', name: 'Local name' })
    expect(huboUn40001()).toBe(true) // el cierre del confirm chocó con el FAILED del watchdog y se repitió
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
