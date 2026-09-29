/**
 * IVA por producto, plan 4 · Tarea 2 — la BASE impone la inversa, contra Postgres REAL.
 *
 * Una organización —o un negocio— con contabilidad (una póliza, o cualquier `AccountingPeriodLock`) no puede tener un
 * producto ≠ IVA_16: el trigger de `Product` lo rechaza con `IVA_CONTABILIDAD_CON_HISTORIA` y los cuatro caminos que
 * escriben IVA lo traducen a 409. Un renglón que SELLA ≠ IVA_16 marca a su organización, la marca no se apaga, y la
 * migración de inicialización la enciende desde productos y sellos viejos. Los endpoints toman `Organization` ANTES del
 * cerco del catálogo: las carreras de abajo lo prueban con las funciones REALES, pausadas por un bloqueador y mirando la
 * espera en `pg_stat_activity` antes de soltar.
 *
 * Cada caso usa una organización NUEVA (Ruling PF7). El estado viejo —un producto ≠ 16 % en una organización sin marca— se
 * siembra con `session_replication_role = replica` sólo dentro de la transacción de la siembra. Corre en la base H1
 * desechable (la exige el arnés del catálogo de la carrera (e)).
 */
import fs from 'fs'
import path from 'path'
import { Client } from 'pg'
import { JournalEntrySource, Prisma, type IvaTratamiento } from '@prisma/client'
import type { Request, Response } from 'express'

import * as movil from '@/controllers/mobile/product.mobile.controller'
import { ConflictError } from '@/errors/AppError'
import { createProduct, updateProduct, type CreateProductDto } from '@/services/dashboard/product.dashboard.service'
import { closePeriod } from '@/services/fiscal/accountingPeriodLock.service'
import { generatePoliciesForVenue } from '@/services/fiscal/autoPosting.service'
import { createManualEntry, postJournalEntry } from '@/services/fiscal/journalEntry.service'
import { liberarSellosDe, sellarRenglones } from '@/services/fiscal/sellosIva'
import { acquireCatalogMutationLock } from '@/services/master-catalog/catalogMutationLock.service'
import type { CatalogCommandContext } from '@/types/master-catalog'
import prisma from '@/utils/prismaClient'
import * as reintento from '@/utils/serializableRetry'
import {
  assertDisposableCatalogPublicationDatabase,
  cleanupCatalogPublicationFixture,
  createCatalogPublicationFixture,
  createCatalogPublicationIntegrationHarness,
  type CatalogPublicationFixture,
  type CatalogPublicationIntegrationHarness,
} from '../master-catalog/catalogPublicationIntegrationHarness'
import {
  cobroConTarjeta,
  conProducto,
  debePausarse,
  desenlace,
  hastaQue,
  limpiarNegocios,
  lineasDeVenta,
  marcada,
  nuevoNegocio,
  ordenConCfdi,
  PAUSA,
  polizas,
  polizaSuelta,
  retener,
  sinTriggers,
  type Negocio,
} from './exclusionContable.fixtures'

jest.setTimeout(240_000)

const HISTORIA = {
  statusCode: 409,
  code: 'IVA_CONTABILIDAD_CON_HISTORIA',
  message:
    'Este negocio ya lleva contabilidad en Avoqado (pólizas o periodos cerrados) y la contabilidad todavía no maneja IVA distinto de 16 %. Por eso este producto se queda en IVA 16 %. Escríbenos a hola@avoqado.io si lo necesitas.',
}
const marcaInicial = () =>
  fs.readFileSync(path.join(__dirname, '../../../prisma/migrations/20260928000100_iva_contabilidad_marca_inicial/migration.sql'), 'utf8')

let staffId = ''
const actor = (id = staffId) => ({ type: 'HUMAN' as const, staffId: id, impersonating: false })

/** Producto ≠ 16 % heredado, sembrado sin triggers: la organización NO queda marcada. */
const productoViejo = (x: Negocio, categoryId: string, sku: string) =>
  sinTriggers(tx =>
    tx.product.create({
      data: { venueId: x.venueId, categoryId, sku, name: 'Grano', price: 480, taxRate: 0, objetoImp: '02', ivaTratamiento: 'IVA_0' },
    }),
  )

const tratamiento = async (id: string) =>
  (await prisma.product.findUniqueOrThrow({ where: { id }, select: { ivaTratamiento: true } })).ivaTratamiento
/** El controlador móvil REAL, sin HTTP: devuelve el error que pasó a `next` o el cuerpo de la respuesta. */
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

const sellar = (cfdiId: string, orderItemId: string, trat: IvaTratamiento) => (tx: Prisma.TransactionClient) =>
  sellarRenglones(tx, { cfdiId, intento: 1, renglones: [{ orderItemId, tratamiento: trat }] })

beforeAll(async () => {
  assertDisposableCatalogPublicationDatabase()
  staffId = (await prisma.staff.create({ data: { email: `t2-${Date.now()}@example.test`, firstName: 'IVA', lastName: 'Tarea 2' } })).id
})

afterAll(async () => {
  await limpiarNegocios()
  await prisma.activityLog.deleteMany({ where: { OR: [{ staffId }, { actorStaffId: staffId }] } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
})

describe('la base impone la inversa: con contabilidad no hay productos ≠ IVA_16', () => {
  it('una póliza en la organización: dashboard y móvil, alta y edición, salen 409 IVA_CONTABILIDAD_CON_HISTORIA y nada cambia', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { categoryId, productId } = await conProducto(x)
    await polizaSuelta(x.organizationId, x.rfc, null)

    const alta = { name: 'Grano', price: 480, type: 'REGULAR', sku: `A-${x.rfc}`, categoryId, ivaTratamiento: 'IVA_0' } as CreateProductDto
    const resultados = [
      await desenlace(updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_0' }, actor())),
      await movilLlama(movil.updateProduct, { venueId: x.venueId, productId }, { ivaTratamiento: 'IVA_0' }),
      await desenlace(createProduct(x.venueId, alta, actor())),
      await movilLlama(movil.createProduct, { venueId: x.venueId }, { name: 'Grano móvil', categoryId, ivaTratamiento: 'IVA_0' }),
    ]

    for (const r of resultados) {
      expect(r).toMatchObject(HISTORIA)
      expect(r).toBeInstanceOf(ConflictError)
    }
    expect(await tratamiento(productId)).toBe('IVA_16')
    expect(await prisma.product.count({ where: { venueId: x.venueId } })).toBe(1)
  })

  it('sólo un AccountingPeriodLock basta, cerrado o reabierto', async () => {
    for (const status of ['CLOSED', 'OPEN'] as const) {
      const x = await nuevoNegocio({ contabilidad: false })
      const { productId } = await conProducto(x)
      await prisma.accountingPeriodLock.create({ data: { organizationId: x.organizationId, rfc: x.rfc, period: '2026-06', status } })

      const r = await desenlace(updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_0' }, actor()))

      expect(r).toMatchObject(HISTORIA)
      expect(await tratamiento(productId)).toBe('IVA_16')
    }
  })

  it('una póliza del NEGOCIO en otra organización basta, aunque la organización actual no tenga contabilidad', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const otra = await nuevoNegocio({ contabilidad: false })
    const { productId } = await conProducto(x)
    await polizaSuelta(otra.organizationId, otra.rfc, x.venueId)

    const r = await desenlace(updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_0' }, actor()))

    expect(r).toMatchObject(HISTORIA)
    expect(await tratamiento(productId)).toBe('IVA_16')
  })

  it('sin contabilidad se permite y la organización queda marcada', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { productId } = await conProducto(x)
    expect(await marcada(x.organizationId)).toBe(false)

    await updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_0' }, actor())

    expect(await tratamiento(productId)).toBe('IVA_0')
    expect(await marcada(x.organizationId)).toBe(true)
  })

  it('un producto HEREDADO ≠ 16 % con contabilidad: un UPDATE directo que reenvía su tupla no da 409 (Review Focus 6)', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { categoryId } = await conProducto(x)
    await polizaSuelta(x.organizationId, x.rfc, null)
    const viejo = await productoViejo(x, categoryId, `H-${x.rfc}`)

    await expect(
      prisma.$executeRaw`UPDATE "Product" SET "taxRate" = "taxRate", "objetoImp" = "objetoImp", name = ${'Grano editado'} WHERE id = ${viejo.id}`,
    ).resolves.toBe(1)
    expect(await tratamiento(viejo.id)).toBe('IVA_0')
  })
})

describe('el sello marca, la marca no se apaga y la inicialización la enciende', () => {
  it('sellar un renglón ≠ IVA_16 marca a la organización; con IVA_16 no; liberar no la desmarca', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { categoryId } = await conProducto(x)
    const viejo = await productoViejo(x, categoryId, `S-${x.rfc}`)
    const a16 = await ordenConCfdi(x, viejo.id, 'a16')
    const a0 = await ordenConCfdi(x, viejo.id, 'a0')
    expect(await marcada(x.organizationId)).toBe(false) // estado viejo: producto ≠ 16 % sin marca

    await prisma.$transaction(sellar(a16.cfdiId, a16.orderItemId, 'IVA_16'))
    expect(await marcada(x.organizationId)).toBe(false)

    await prisma.$transaction(sellar(a0.cfdiId, a0.orderItemId, 'IVA_0'))
    expect(await marcada(x.organizationId)).toBe(true)

    await prisma.$transaction(tx => liberarSellosDe(tx, a0.cfdiId))
    expect(await prisma.orderItem.findUniqueOrThrow({ where: { id: a0.orderItemId }, select: { ivaTratamiento: true } })).toEqual({
      ivaTratamiento: null,
    })
    expect(await marcada(x.organizationId)).toBe(true)
  })

  it('apagar la marca lanza IVA_MARCA_PEGAJOSA; de verdadero a verdadero no falla', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    await prisma.$executeRaw`UPDATE "Organization" SET "ivaMixtoAlgunaVez" = true WHERE id = ${x.organizationId}`

    await expect(prisma.$executeRaw`UPDATE "Organization" SET "ivaMixtoAlgunaVez" = false WHERE id = ${x.organizationId}`).rejects.toThrow(
      /IVA_MARCA_PEGAJOSA/,
    )
    await expect(prisma.$executeRaw`UPDATE "Organization" SET "ivaMixtoAlgunaVez" = true WHERE id = ${x.organizationId}`).resolves.toBe(1)
    expect(await marcada(x.organizationId)).toBe(true)
  })

  it('la inicialización marca a quien tiene un producto ≠ 16 % y a quien tiene un renglón sellado ≠ 16 %; al resto no', async () => {
    const conProductoViejo = await nuevoNegocio({ contabilidad: false })
    const conSelloViejo = await nuevoNegocio({ contabilidad: false })
    const control = await nuevoNegocio({ contabilidad: false })
    const p = await conProducto(conProductoViejo)
    await productoViejo(conProductoViejo, p.categoryId, `I-${conProductoViejo.rfc}`)
    const s = await conProducto(conSelloViejo)
    const renglon = await ordenConCfdi(conSelloViejo, s.productId, 'init')
    await sinTriggers(tx => tx.orderItem.update({ where: { id: renglon.orderItemId }, data: { ivaTratamiento: 'EXENTO' } }))
    await conProducto(control)
    const ids = [conProductoViejo, conSelloViejo, control].map(n => n.organizationId)
    for (const id of ids) expect(await marcada(id)).toBe(false)

    // El archivo REAL de la migración, en una transacción que se revierte: no marca nada fuera de esta prueba.
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
    try {
      await client.query('BEGIN')
      await client.query(marcaInicial())
      const { rows } = await client.query<{ id: string; ivaMixtoAlgunaVez: boolean }>(
        `SELECT id, "ivaMixtoAlgunaVez" FROM "Organization" WHERE id = ANY($1)`,
        [ids],
      )
      expect(Object.fromEntries(rows.map(r => [r.id, r.ivaMixtoAlgunaVez]))).toEqual({ [ids[0]]: true, [ids[1]]: true, [ids[2]]: false })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      await client.end()
    }
  })
})

describe('carreras con las funciones REALES: bloqueador, espera probada en pg_stat_activity y soltar', () => {
  let harness: CatalogPublicationIntegrationHarness | null = null
  const fixtures: CatalogPublicationFixture[] = []
  const h = () => {
    if (!harness) throw new Error('El arnés del catálogo no se inició')
    return harness
  }
  const errores: unknown[] = []

  beforeAll(async () => {
    harness = await createCatalogPublicationIntegrationHarness('iva-inversa')
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
        await h().primary.activityLog.deleteMany({ where: { venueId: f.venueId } })
        await cleanupCatalogPublicationFixture(h().primary, f)
      }
    } finally {
      await harness?.disconnect()
    }
  })

  /** Alguien espera un candado que retiene `pid`, con una consulta como `like`; devuelve su pid. Plazo corto: los 5 s del producto. */
  const esperaDetrasDe = (pid: number, like: string, descripcion: string, plazoMs = 4_000, soloPid?: number) =>
    hastaQue(
      h().observer,
      descripcion,
      plazoMs,
      Prisma.sql`SELECT a.pid FROM pg_stat_activity a
        WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
          AND ${pid}::int = ANY(pg_blocking_pids(a.pid)) AND a.query LIKE ${like}
          AND (${soloPid ?? null}::int IS NULL OR a.pid = ${soloPid ?? null}::int)
        LIMIT 1`,
    )

  /** Se reintentó un conflicto de serialización: 40001 crudo (P2010) o, en una consulta de modelo, P2034. */
  const huboUn40001 = () =>
    errores.some(
      e =>
        (e as any)?.code === 'P2034' ||
        /40001/.test(JSON.stringify({ c: (e as any)?.code, m: (e as any)?.meta, msg: (e as any)?.message })),
    )
  // `message` no es enumerable y Prisma 6.19 pone ahí el SQLSTATE de una consulta de modelo (T1-R1): se revisa aparte.
  const noEs40P01 = (r: unknown) => expect(JSON.stringify(r ?? null) + String((r as any)?.message ?? '')).not.toMatch(/40P01|deadlock/i)

  // Los cuatro caminos que escriben IVA. Una edición espera la fila del producto (cerco negocio → producto); un alta, la del
  // negocio (su `FOR SHARE` tras la organización). En los dos casos ya tiene la organización: el posteo espera detrás.
  const caminos = [
    {
      camino: 'edición del dashboard',
      retenida: (x: Negocio, productId: string) => (tx: Prisma.TransactionClient) =>
        tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`,
      espera: '%FROM "Product" AS product%',
      escribir: (x: Negocio, productId: string) => desenlace(updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_0' }, actor())),
    },
    {
      camino: 'edición móvil',
      retenida: (x: Negocio, productId: string) => (tx: Prisma.TransactionClient) =>
        tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`,
      espera: '%FROM "Product" AS product%',
      escribir: (x: Negocio, productId: string) =>
        movilLlama(movil.updateProduct, { venueId: x.venueId, productId }, { ivaTratamiento: 'IVA_0' }),
    },
    {
      camino: 'alta del dashboard',
      retenida: (x: Negocio) => (tx: Prisma.TransactionClient) => tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${x.venueId} FOR UPDATE`,
      espera: '%FROM "Venue"%FOR SHARE%',
      escribir: async (x: Negocio) => {
        const { categoryId } = await prisma.product.findFirstOrThrow({ where: { venueId: x.venueId }, select: { categoryId: true } })
        const alta = {
          name: 'Grano',
          price: 480,
          type: 'REGULAR',
          sku: `A-${x.rfc}`,
          categoryId,
          ivaTratamiento: 'IVA_0',
        } as CreateProductDto
        return desenlace(createProduct(x.venueId, alta, actor()))
      },
    },
    {
      camino: 'alta móvil',
      retenida: (x: Negocio) => (tx: Prisma.TransactionClient) => tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${x.venueId} FOR UPDATE`,
      espera: '%FROM "Venue"%FOR SHARE%',
      escribir: async (x: Negocio) => {
        const { categoryId } = await prisma.product.findFirstOrThrow({ where: { venueId: x.venueId }, select: { categoryId: true } })
        return movilLlama(movil.createProduct, { venueId: x.venueId }, { name: 'Grano móvil', categoryId, ivaTratamiento: 'IVA_0' })
      },
    },
  ]

  it.each(caminos)(
    '(a) $camino: retiene Organization y espera; el posteo espera en Organization, reintenta tras el 40001 y sale 409 sin pólizas',
    async ({ retenida, espera, escribir }) => {
      const x = await nuevoNegocio()
      const { productId } = await conProducto(x)
      const lines = await lineasDeVenta(x.organizationId, x.rfc)
      const fila = await retener(h().blocker, retenida(x, productId))
      let cambio: Promise<unknown> = Promise.resolve()
      let posteo: Promise<unknown> = Promise.resolve()
      try {
        cambio = escribir(x, productId)
        const pidCambio = await esperaDetrasDe(fila.pid, espera, 'el cambio esperando la fila retenida, con la organización ya tomada')
        posteo = createManualEntry(x.venueId, { date: '2026-06-15', concept: 'Póliza en carrera', lines }, { staffId: null })
        posteo.catch(() => undefined)
        await esperaDetrasDe(pidCambio, '%FROM "Organization"%FOR SHARE%', 'el posteo esperando la organización que retiene el cambio')
      } finally {
        await fila.soltar()
      }

      expect(await cambio).toHaveProperty('ok')
      expect(await prisma.product.count({ where: { venueId: x.venueId, ivaTratamiento: 'IVA_0' } })).toBe(1)
      await debePausarse(posteo)
      expect(await polizas(x.organizationId)).toBe(0)
      expect(huboUn40001()).toBe(true)
    },
  )

  // R2: un producto pasa a ≠ 16 % ENTRE la carga y el posteo de la corrida automática ⇒ 409 y cero pólizas.
  it('(a2) la corrida automática: pasa el aviso temprano, carga sus pagos, su primer posteo espera en Organization y sale 409 sin pólizas', async () => {
    const x = await nuevoNegocio()
    const { productId } = await conProducto(x)
    await cobroConTarjeta(x)
    const fila = await retener(h().blocker, tx => tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`)
    let cambio: Promise<unknown> = Promise.resolve()
    let posteo: Promise<unknown> = Promise.resolve()
    try {
      cambio = desenlace(updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_0' }, actor()))
      const pidCambio = await esperaDetrasDe(
        fila.pid,
        '%FROM "Product" AS product%',
        'el cambio esperando la fila del producto, con la organización ya tomada',
      )
      posteo = generatePoliciesForVenue(x.venueId)
      posteo.catch(() => undefined)
      await esperaDetrasDe(pidCambio, '%FROM "Organization"%FOR SHARE%', 'el primer posteo de la corrida esperando la organización')
    } finally {
      await fila.soltar()
    }

    expect(await cambio).toHaveProperty('ok')
    expect(await tratamiento(productId)).toBe('IVA_0')
    await debePausarse(posteo)
    expect(await polizas(x.organizationId)).toBe(0)
    expect(huboUn40001()).toBe(true)
  })

  // La edición (READ COMMITTED) y el alta del dashboard (Serializable: su foto se fija ANTES de esperar la organización; la
  // póliza que confirma mientras tanto la alcanza SSI, que aborta el alta con 40001 y el reintento de PF3 ve la historia).
  it.each([
    {
      camino: 'edición del dashboard',
      reintenta: false,
      escribir: (x: Negocio, productId: string) => desenlace(updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_0' }, actor())),
    },
    {
      camino: 'alta del dashboard (Serializable)',
      reintenta: true,
      escribir: async (x: Negocio) => {
        const { categoryId } = await prisma.product.findFirstOrThrow({ where: { venueId: x.venueId }, select: { categoryId: true } })
        const alta = {
          name: 'Grano',
          price: 480,
          type: 'REGULAR',
          sku: `B-${x.rfc}`,
          categoryId,
          ivaTratamiento: 'IVA_0',
        } as CreateProductDto
        return desenlace(createProduct(x.venueId, alta, actor()))
      },
    },
  ])(
    '(b) $camino: el posteo retiene Organization y espera una cuenta; el cambio espera en Organization y sale IVA_CONTABILIDAD_CON_HISTORIA',
    async ({ escribir, reintenta }) => {
      const x = await nuevoNegocio()
      const { productId } = await conProducto(x)
      const lines = await lineasDeVenta(x.organizationId, x.rfc)
      const cuenta = await retener(
        h().blocker,
        tx => tx.$queryRaw`SELECT id FROM "LedgerAccount" WHERE id = ${lines[0].ledgerAccountId} FOR UPDATE`,
      )
      let posteo: Promise<unknown> = Promise.resolve()
      let cambio: Promise<unknown> = Promise.resolve()
      try {
        posteo = desenlace(
          postJournalEntry(
            x.venueId,
            { date: '2026-06-15', concept: 'Póliza primero', source: JournalEntrySource.MANUAL, lines },
            { staffId: null },
          ),
        )
        const pidPosteo = await esperaDetrasDe(cuenta.pid, '%INSERT INTO "public"."JournalLine"%', 'el posteo esperando la cuenta retenida')
        cambio = escribir(x, productId)
        await esperaDetrasDe(
          pidPosteo,
          '%FROM "Organization"%FOR NO KEY UPDATE%',
          'el cambio esperando la organización que retiene el posteo',
        )
      } finally {
        await cuenta.soltar()
      }

      expect(await posteo).toMatchObject({ ok: { totalDebitCents: 11_600 } })
      expect(await polizas(x.organizationId)).toBe(1)
      const r = await cambio
      expect(r).toMatchObject(HISTORIA)
      expect(r).toBeInstanceOf(ConflictError)
      expect(await prisma.product.count({ where: { venueId: x.venueId, NOT: { ivaTratamiento: 'IVA_16' } } })).toBe(0)
      expect(huboUn40001()).toBe(reintenta) // el alta: SSI la abortó con 40001 y su reintento vio la póliza
    },
  )

  it('(c) el cierre retiene Organization y espera su periodo; el cambio espera en Organization y sale IVA_CONTABILIDAD_CON_HISTORIA', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { productId } = await conProducto(x)
    const periodo = await retener(h().blocker, tx =>
      tx.accountingPeriodLock.create({ data: { organizationId: x.organizationId, rfc: x.rfc, period: '2026-06' } }),
    )
    let cierre: Promise<unknown> = Promise.resolve()
    let cambio: Promise<unknown> = Promise.resolve()
    try {
      cierre = desenlace(closePeriod(x.venueId, '2026-06', { staffId: null }, 'cierre en carrera'))
      const pidCierre = await esperaDetrasDe(periodo.pid, '%INSERT INTO "public"."AccountingPeriodLock"%', 'el cierre esperando su periodo')
      cambio = desenlace(updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_0' }, actor()))
      await esperaDetrasDe(
        pidCierre,
        '%FROM "Organization"%FOR NO KEY UPDATE%',
        'el cambio esperando la organización que retiene el cierre',
      )
    } finally {
      await periodo.soltar()
    }

    expect(await cierre).toMatchObject({ ok: { status: 'CLOSED' } })
    expect(await cambio).toMatchObject(HISTORIA)
    expect(await tratamiento(productId)).toBe('IVA_16')
  })

  it('(d) un sello ≠ 16 % en vuelo sobre una organización vieja sin marca: el posteo espera, y al confirmar el sello sale 409 sin escribir', async () => {
    const x = await nuevoNegocio()
    const { categoryId } = await conProducto(x)
    const viejo = await productoViejo(x, categoryId, `D-${x.rfc}`)
    const { orderItemId, cfdiId } = await ordenConCfdi(x, viejo.id, 'd')
    const lines = await lineasDeVenta(x.organizationId, x.rfc)
    expect(await marcada(x.organizationId)).toBe(false)

    const sello = await retener(h().blocker, sellar(cfdiId, orderItemId, 'IVA_0'), { confirmar: true })
    let posteo: Promise<unknown> = Promise.resolve()
    try {
      posteo = createManualEntry(x.venueId, { date: '2026-06-15', concept: 'Póliza contra sello', lines }, { staffId: null })
      posteo.catch(() => undefined)
      await esperaDetrasDe(sello.pid, '%FROM "Organization"%FOR SHARE%', 'el posteo esperando la organización que marca el sello')
    } finally {
      await sello.soltar()
    }

    await debePausarse(posteo)
    expect(await polizas(x.organizationId)).toBe(0)
    expect(await marcada(x.organizationId)).toBe(true)
    expect(huboUn40001()).toBe(true)
  })

  // Ola 2 · A (Codex P1): un 40P01 de consulta de MODELO (el INSERT de JournalLine) llega como error desconocido de Prisma
  // con el SQLSTATE sólo en el mensaje (como el 55P03 de T1-R1). Ciclo REAL: X —SQL directo— retiene una cuenta y cambia el
  // producto (su trigger pide la organización); el posteo real tiene la organización y espera la cuenta. Un bloqueador del
  // negocio deja al posteo formado con la organización tomada ANTES de la cuenta, para que el ciclo exista cuando corra su
  // detector: X espera primero con un deadlock_timeout largo, así que la víctima es el posteo.
  it('(f) bloqueo mutuo REAL con un UPDATE crudo del producto: el posteo es la víctima (40P01), reintenta y sale 409 sin pólizas, nunca 500', async () => {
    const x = await nuevoNegocio()
    const { productId } = await conProducto(x)
    const lines = await lineasDeVenta(x.organizationId, x.rfc)
    const crudo = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await crudo.connect()
    let posteo: Promise<unknown> = Promise.resolve()
    let cambio: Promise<unknown> = Promise.resolve()
    let negocio: Awaited<ReturnType<typeof retener>> | null = null
    try {
      const { rows } = await crudo.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const pidX = rows[0].pid
      await crudo.query('BEGIN')
      await crudo.query("SET LOCAL deadlock_timeout = '60s'") // X nunca corre el detector: la víctima la elige el del posteo
      await crudo.query('SELECT id FROM "LedgerAccount" WHERE id = $1 FOR UPDATE', [lines[0].ledgerAccountId])
      negocio = await retener(h().blocker, tx => tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${x.venueId} FOR UPDATE`)

      posteo = desenlace(createManualEntry(x.venueId, { date: '2026-06-15', concept: 'Póliza en ciclo', lines }, { staffId: null }))
      const pidPosteo = await esperaDetrasDe(
        negocio.pid,
        '%FROM "Venue"%FOR SHARE%',
        'el posteo con la organización tomada, esperando el negocio',
      )
      cambio = crudo.query(`UPDATE "Product" SET "ivaTratamiento" = 'IVA_0' WHERE id = $1`, [productId]).then(
        r => ({ ok: r.rowCount }),
        (e: unknown) => e,
      )
      await esperaDetrasDe(pidPosteo, '%UPDATE "Product"%', 'X (SQL directo) esperando la organización del posteo', 4_000, pidX)
      await negocio.soltar()
      // El ciclo: el posteo espera la cuenta de X; X espera la organización del posteo.
      await esperaDetrasDe(pidX, '%INSERT INTO "public"."JournalLine"%', 'el posteo esperando la cuenta que retiene X', 4_000, pidPosteo)
      // PostgreSQL aborta al posteo (40P01) y X termina su UPDATE; el reintento del posteo espera la organización de X. Si el
      // 40P01 salió crudo (el rojo), el posteo ya terminó y no hay espera que ver.
      expect(await cambio).toEqual({ ok: 1 })
      await Promise.race([
        posteo,
        esperaDetrasDe(pidX, '%FROM "Organization"%FOR SHARE%', 'el reintento del posteo esperando la organización de X'),
      ])
    } finally {
      await negocio?.soltar()
      await crudo.query('COMMIT').catch(() => undefined)
      await crudo.end()
    }

    const hubo40P01 = errores.some(
      e => e instanceof Prisma.PrismaClientUnknownRequestError && e.message.includes('PostgresError { code: "40P01"'),
    )
    const r = await posteo // `desenlace`: el error llega como valor
    expect(r).toMatchObject(PAUSA) // nunca el 40P01 crudo (500)
    expect(r).toBeInstanceOf(ConflictError)
    expect(hubo40P01).toBe(true)
    expect(await polizas(x.organizationId)).toBe(0)
    expect(await tratamiento(productId)).toBe('IVA_0')
    expect(await marcada(x.organizationId)).toBe(true)
  })

  /** Organización SIN marca (producto al 16 %, IVA por producto encendido) con una publicación del MISMO producto lista. */
  async function publicacionLista(suite: string) {
    const f = await createCatalogPublicationFixture(h().primary, suite, { productTaxRate: '0.1600' })
    fixtures.push(f)
    const { createCatalogPublicationPreviewService } = await import('@/services/master-catalog/catalogPublicationPreview.service')
    const { createCatalogPublicationConfirmationService } = await import('@/services/master-catalog/catalogPublicationConfirmation.service')
    const context: CatalogCommandContext = {
      organizationId: f.organizationId,
      actor: { type: 'HUMAN', staffId: f.staffId, impersonating: false },
      orgRole: 'OWNER',
    }
    const idempotencyKey = `iva-inversa-${f.key}`
    const preview = await createCatalogPublicationPreviewService({ prisma: h().primary as never }).preview(context, {
      operation: 'CATALOG_FIELDS_PUBLISH',
      idempotencyKey,
      targets: [{ catalogItemId: f.catalogItemId, venueId: f.venueId, productId: f.productId }],
    })
    const confirmar = () =>
      createCatalogPublicationConfirmationService({ prisma: h().writerOne as never }).confirm(context, {
        publicationBatchId: preview.publicationBatchId,
        previewToken: preview.previewToken,
        idempotencyKey,
        confirm: true,
      })
    return { f, confirmar }
  }

  it('(e) orden 1: el catálogo retiene Organization y el cambio del MISMO producto espera; al soltar terminan los dos, sin 40P01', async () => {
    const { f, confirmar } = await publicacionLista('iva-inversa-e1')
    const articulo = await retener(h().blocker, tx => tx.$queryRaw`SELECT id FROM "CatalogItem" WHERE id = ${f.catalogItemId} FOR UPDATE`)
    let publicacion: Promise<unknown> = Promise.resolve()
    let cambio: Promise<unknown> = Promise.resolve()
    try {
      publicacion = desenlace(confirmar())
      const pidCatalogo = await esperaDetrasDe(
        articulo.pid,
        '%FROM "CatalogItem"%',
        'la publicación esperando el artículo retenido',
        60_000,
      )
      cambio = desenlace(updateProduct(f.venueId, f.productId, { ivaTratamiento: 'IVA_0' }, actor(f.staffId)))
      await esperaDetrasDe(
        pidCatalogo,
        '%FROM "Organization"%FOR NO KEY UPDATE%',
        'el cambio esperando la organización que retiene el catálogo',
      )
    } finally {
      await articulo.soltar()
    }

    const [p, c] = [await publicacion, await cambio]
    noEs40P01(p)
    noEs40P01(c)
    expect(p).toMatchObject({ ok: { state: 'APPLIED' } })
    expect(c).toMatchObject({ ok: { ivaTratamiento: 'IVA_0' } })
  })

  it('(e) orden 2: el cambio retiene Organization y la publicación del MISMO producto espera; el cambio termina, el catálogo reintenta su 40001 y termina, nunca 40P01', async () => {
    const { f, confirmar } = await publicacionLista('iva-inversa-e2')
    // La publicación se deja formada JUSTO antes de Organization (su candado de catálogo retenido) para que el cambio, con sus
    // 5 s de transacción, no pague la preparación de la publicación.
    const antesaladelCatalogo = await retener(h().writerTwo, tx => acquireCatalogMutationLock(tx, f.organizationId))
    const fila = await retener(h().blocker, tx => tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${f.productId} FOR UPDATE`)
    let publicacion: Promise<unknown> = Promise.resolve()
    let cambio: Promise<unknown> = Promise.resolve()
    try {
      publicacion = desenlace(confirmar())
      const pidCatalogo = await esperaDetrasDe(
        antesaladelCatalogo.pid,
        '%pg_advisory_xact_lock%',
        'la publicación formada antes de Organization',
        60_000,
      )
      cambio = desenlace(updateProduct(f.venueId, f.productId, { ivaTratamiento: 'IVA_0' }, actor(f.staffId)))
      const pidCambio = await esperaDetrasDe(fila.pid, '%FROM "Product" AS product%', 'el cambio esperando la fila del producto')
      await antesaladelCatalogo.soltar()
      await esperaDetrasDe(
        pidCambio,
        '%FROM "Organization"%FOR NO KEY UPDATE%',
        'la publicación esperando la organización del cambio',
        4_000,
        pidCatalogo,
      )
    } finally {
      await antesaladelCatalogo.soltar()
      await fila.soltar()
    }

    const [p, c] = [await publicacion, await cambio]
    noEs40P01(p)
    noEs40P01(c)
    expect(c).toMatchObject({ ok: { ivaTratamiento: 'IVA_0' } })
    // Ruling T4-R2 (de PF9): el cambio marcó la organización después de la foto de la publicación ⇒ 40001. Con el reintento de
    // R12 ya no sale: la aplicación se repite, encuentra el producto ya en IVA_0 y su vista previa vieja ⇒ STALE_PREVIEW.
    expect(p).toMatchObject({ statusCode: 409, code: 'STALE_PREVIEW' })
    expect(huboUn40001()).toBe(true)
  })
})
