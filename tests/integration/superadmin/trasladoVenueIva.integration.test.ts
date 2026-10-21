/**
 * IVA por producto, plan 4 · Tarea 3 — trasladar un negocio entre organizaciones no mezcla IVA mixto con contabilidad ni
 * duplica pólizas, contra Postgres REAL.
 *
 * El trigger `Venue_trasladoIva_guard` impone la barrera (también a un UPDATE por SQL directo). El endpoint del superadmin
 * toma las dos organizaciones en orden de id, relee el negocio dentro de la transacción, responde con lo que ésta devolvió y
 * deja su bitácora. Las carreras corren el controlador REAL, pausado por un bloqueador, con la espera probada en
 * `pg_stat_activity` antes de soltar. Cada caso usa organizaciones NUEVAS (Ruling PF7). Corre en la base H1 desechable (el
 * arnés del catálogo da las conexiones del bloqueador y del observador).
 */
// La bitácora VENUE_TRANSFERRED se prueba de verdad: el setup de integración simula `logAction`.
jest.unmock('@/services/dashboard/activity-log.service')
import { JournalEntrySource, Prisma } from '@prisma/client'
import type { Request, Response } from 'express'
import { Client } from 'pg'

import { transferVenue } from '@/controllers/dashboard/venues.superadmin.controller'
import { ConflictError } from '@/errors/AppError'
import { updateProduct } from '@/services/dashboard/product.dashboard.service'
import { seedDefaultMappings } from '@/services/fiscal/accountMapping.service'
import { bloquearOrdenParaFacturar, tomarAdmisionCompartida } from '@/services/fiscal/admisionIva'
import { generatePoliciesForVenue } from '@/services/fiscal/autoPosting.service'
import { seedBaseChart } from '@/services/fiscal/chartOfAccounts.service'
import { createManualEntry, postJournalEntry } from '@/services/fiscal/journalEntry.service'
import { sellarRenglones } from '@/services/fiscal/sellosIva'
import prisma from '@/utils/prismaClient'
import {
  assertDisposableCatalogPublicationDatabase,
  createCatalogPublicationIntegrationHarness,
  type CatalogPublicationIntegrationHarness,
} from '../master-catalog/catalogPublicationIntegrationHarness'
import {
  cobroConTarjeta,
  conProducto,
  desenlace,
  hastaQue,
  limpiarNegocios,
  lineasDeVenta,
  marcada,
  nuevoNegocio,
  ordenConCfdi,
  polizaSuelta,
  retener,
  sinTriggers,
} from '../fiscal/exclusionContable.fixtures'

jest.setTimeout(240_000)

const CON_CONTABILIDAD = {
  statusCode: 409,
  code: 'IVA_TRASLADO_CON_CONTABILIDAD',
  message:
    'No se puede mover este negocio: ya tiene pólizas en la contabilidad de su organización, y moverlo haría que sus ventas se registraran otra vez en la nueva. Pide ayuda a soporte.',
}
const INCOMPATIBLE = {
  statusCode: 409,
  code: 'IVA_TRASLADO_INCOMPATIBLE',
  message:
    'No se puede mover este negocio: la organización destino lleva contabilidad en Avoqado y el negocio tiene productos o facturas con IVA distinto de 16 %. La contabilidad todavía no maneja esa mezcla.',
}
const CAMBIO = {
  statusCode: 409,
  code: 'IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION',
  message: 'Este negocio acaba de cambiar de organización. Vuelve a intentarlo.',
}

let staffId = ''
const staffExtra: string[] = []
const actor = () => ({ type: 'HUMAN' as const, staffId, impersonating: false })

/** El controlador REAL, sin HTTP: el error que pasó a `next`, o `{ status, body }`. */
async function trasladar(venueId: string, targetOrganizationId: string) {
  let error: unknown = null
  let status = 0
  let body: unknown = null
  const res = { status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) } as unknown as Response
  const req = { params: { venueId }, body: { targetOrganizationId }, authContext: { userId: staffId } } as unknown as Request
  await transferVenue(req, res, (e?: unknown) => (error = e))
  return error ?? { status, body }
}

const debeRechazar = (r: unknown, esperado: typeof CAMBIO) => {
  expect(r).toMatchObject(esperado) // primero: si pasó, el diff muestra la respuesta
  expect(r).toBeInstanceOf(ConflictError)
}
const organizacionDe = async (venueId: string) =>
  (await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { organizationId: true } })).organizationId
const bitacoras = (venueId: string) =>
  prisma.activityLog.findMany({ where: { action: 'VENUE_TRANSFERRED', entity: 'Venue', entityId: venueId }, take: 5 })
/** `logAction` va después del commit y sin esperar: se sondea un momento. */
async function bitacoraDe(venueId: string) {
  const limite = Date.now() + 3_000
  while (Date.now() < limite) {
    const [fila] = await bitacoras(venueId)
    if (fila) return fila
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Nunca se escribió la bitácora VENUE_TRANSFERRED')
}

/** Una organización con historia contable (una póliza suya). */
async function conLibros() {
  const n = await nuevoNegocio({ contabilidad: false })
  await polizaSuelta(n.organizationId, n.rfc, null)
  return n
}

/** Un negocio con un producto ≠ 16 % (su organización queda marcada por el trigger de Product). */
async function mixto() {
  const x = await nuevoNegocio({ contabilidad: false })
  const { productId } = await conProducto(x)
  await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
  return { x, productId }
}

beforeAll(async () => {
  assertDisposableCatalogPublicationDatabase()
  staffId = (await prisma.staff.create({ data: { email: `t3-${Date.now()}@example.test`, firstName: 'IVA', lastName: 'Tarea 3' } })).id
})

afterEach(() => jest.restoreAllMocks())

afterAll(async () => {
  await limpiarNegocios()
  const todos = [staffId, ...staffExtra]
  await prisma.activityLog.deleteMany({ where: { OR: [{ staffId: { in: todos } }, { actorStaffId: { in: todos } }] } })
  await prisma.staff.deleteMany({ where: { id: { in: todos } } })
})

describe('la barrera del traslado: ni mezcla IVA mixto con contabilidad ni duplica pólizas', () => {
  it('un negocio todo 16 % y sin pólizas se traslada a una organización con pólizas (como hoy)', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    await conProducto(x)
    const destino = await conLibros()

    expect(await trasladar(x.venueId, destino.organizationId)).toMatchObject({ status: 200, body: { success: true } })
    expect(await organizacionDe(x.venueId)).toBe(destino.organizationId)
    expect(await marcada(destino.organizationId)).toBe(false)
  })

  it('un negocio con una póliza propia no se traslada (Review Focus 2); sin la barrera, autoPosting la repetiría en la nueva', async () => {
    const x = await nuevoNegocio()
    const pago = await cobroConTarjeta(x)
    expect(await generatePoliciesForVenue(x.venueId)).toMatchObject({ posted: 1 })
    const limpio = await nuevoNegocio({ contabilidad: false })
    const clave = `pay:${pago.id}:v1`

    debeRechazar(await trasladar(x.venueId, limpio.organizationId), CON_CONTABILIDAD)
    expect(await organizacionDe(x.venueId)).toBe(x.organizationId)
    expect(await bitacoras(x.venueId)).toHaveLength(0)

    // El daño que se evita: con el trigger apagado SÓLO en su transacción, el negocio pasa a la organización limpia, y en
    // ella autoPosting no ve la póliza (su idempotencia es por organización y RFC): vuelve a postear la MISMA venta.
    await sinTriggers(tx => tx.$executeRaw`UPDATE "Venue" SET "organizationId" = ${limpio.organizationId} WHERE id = ${x.venueId}`)
    try {
      await seedBaseChart(x.venueId, { staffId: null })
      await seedDefaultMappings(x.venueId, { staffId: null })
      expect(await generatePoliciesForVenue(x.venueId)).toMatchObject({ posted: 1, alreadyPosted: 0 })
      const conLaClave = await prisma.journalEntry.findMany({ where: { idempotencyKey: clave }, select: { organizationId: true }, take: 5 })
      expect(conLaClave.map(e => e.organizationId).sort()).toEqual([x.organizationId, limpio.organizationId].sort())
    } finally {
      await prisma.journalEntry.deleteMany({ where: { organizationId: limpio.organizationId } })
      await prisma.accountMapping.deleteMany({ where: { organizationId: limpio.organizationId } })
      await prisma.ledgerAccount.deleteMany({ where: { organizationId: limpio.organizationId } })
      await sinTriggers(tx => tx.$executeRaw`UPDATE "Venue" SET "organizationId" = ${x.organizationId} WHERE id = ${x.venueId}`)
    }
    expect(await prisma.journalEntry.count({ where: { idempotencyKey: clave } })).toBe(1)
    expect(await organizacionDe(x.venueId)).toBe(x.organizationId)
  })

  it('un negocio con un producto ≠ 16 % (aunque esté borrado): hacia contabilidad 409 IVA_TRASLADO_INCOMPATIBLE; hacia una limpia pasa y la marca', async () => {
    const { x, productId } = await mixto()
    await prisma.product.update({ where: { id: productId }, data: { deletedAt: new Date() } })
    const destinoConLibros = await conLibros()
    const limpio = await nuevoNegocio({ contabilidad: false })

    debeRechazar(await trasladar(x.venueId, destinoConLibros.organizationId), INCOMPATIBLE)
    expect(await organizacionDe(x.venueId)).toBe(x.organizationId)

    expect(await marcada(limpio.organizationId)).toBe(false)
    expect(await trasladar(x.venueId, limpio.organizationId)).toMatchObject({ status: 200 })
    expect(await organizacionDe(x.venueId)).toBe(limpio.organizationId)
    expect(await marcada(limpio.organizationId)).toBe(true)
  })

  it('todos sus productos en 16 % pero un renglón SELLADO ≠ 16 % en un CFDI suyo: hacia contabilidad 409', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { productId } = await conProducto(x)
    const factura = await ordenConCfdi(x, productId, 'sello')
    await prisma.$transaction(tx =>
      sellarRenglones(tx, { cfdiId: factura.cfdiId, intento: 1, renglones: [{ orderItemId: factura.orderItemId, tratamiento: 'IVA_0' }] }),
    )
    expect(await prisma.product.count({ where: { venueId: x.venueId, NOT: { ivaTratamiento: 'IVA_16' } } })).toBe(0)
    const destino = await conLibros()

    debeRechazar(await trasladar(x.venueId, destino.organizationId), INCOMPATIBLE)
    expect(await organizacionDe(x.venueId)).toBe(x.organizationId)
  })

  it('un UPDATE "Venue" SET "organizationId" por SQL directo recibe la misma barrera', async () => {
    const conPoliza = await nuevoNegocio({ contabilidad: false })
    await polizaSuelta(conPoliza.organizationId, conPoliza.rfc, conPoliza.venueId)
    const { x } = await mixto()
    const destinoConLibros = await conLibros()
    const limpio = await nuevoNegocio({ contabilidad: false })
    const directo = (venueId: string, organizationId: string) =>
      prisma.$executeRaw`UPDATE "Venue" SET "organizationId" = ${organizationId} WHERE id = ${venueId}`

    await expect(directo(conPoliza.venueId, limpio.organizationId)).rejects.toThrow(/IVA_TRASLADO_CON_CONTABILIDAD/)
    await expect(directo(x.venueId, destinoConLibros.organizationId)).rejects.toThrow(/IVA_TRASLADO_INCOMPATIBLE/)
    expect(await organizacionDe(conPoliza.venueId)).toBe(conPoliza.organizationId)
    expect(await organizacionDe(x.venueId)).toBe(x.organizationId)

    await expect(directo(x.venueId, limpio.organizationId)).resolves.toBe(1)
    expect(await marcada(limpio.organizationId)).toBe(true)
  })

  // Ola 2 · B (Codex P1): en REPEATABLE READ la foto es de la primera sentencia y no hay SSI; el posteo sólo BLOQUEA el
  // negocio y la organización, así que el traslado crudo toma sus candados sin error y su EXISTS (foto vieja) no ve la póliza.
  it('un traslado crudo en REPEATABLE READ con la foto de ANTES de la primera póliza del negocio sale IVA_REPEATABLE_READ_NO_ADMITIDO; sin cambiar de organización sigue permitido', async () => {
    const x = await nuevoNegocio()
    const limpio = await nuevoNegocio({ contabilidad: false })
    const lines = await lineasDeVenta(x.organizationId, x.rfc)
    const rr = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await rr.connect()
    let r: unknown = null
    try {
      await rr.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await rr.query('SELECT 1 FROM "Organization" LIMIT 1') // la foto
      await createManualEntry(x.venueId, { date: '2026-06-15', concept: 'Primera póliza del negocio', lines }, { staffId: null })
      // Lo que no cambia de organización ni siquiera llega a la barrera.
      await expect(rr.query('UPDATE "Venue" SET "organizationId" = "organizationId" WHERE id = $1', [x.venueId])).resolves.toMatchObject({
        rowCount: 1,
      })
      // Sin la barrera, este UPDATE pasa y el COMMIT deja el negocio con su póliza en la organización limpia.
      r = await rr.query('UPDATE "Venue" SET "organizationId" = $1 WHERE id = $2', [limpio.organizationId, x.venueId]).then(
        async ok => (await rr.query('COMMIT'), { confirmado: ok.rowCount }),
        (e: unknown) => e,
      )
    } finally {
      await rr.query('ROLLBACK').catch(() => undefined)
      await rr.end()
    }

    expect(r).toMatchObject({ code: 'P0001', message: 'IVA_REPEATABLE_READ_NO_ADMITIDO' })
    expect(await organizacionDe(x.venueId)).toBe(x.organizationId)
    expect(await prisma.journalEntry.count({ where: { venueId: x.venueId } })).toBe(1)
  })

  it('la respuesta conserva su forma de hoy con el negocio leído DENTRO de la transacción, y deja su bitácora VENUE_TRANSFERRED', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const destino = await nuevoNegocio({ contabilidad: false })
    const otro = (
      await prisma.staff.create({ data: { email: `t3-otro-${Date.now()}@example.test`, firstName: 'Otro', lastName: 'Tarea 3' } })
    ).id
    staffExtra.push(otro)
    await prisma.staffVenue.create({ data: { staffId, venueId: x.venueId, role: 'MANAGER' } })
    const nombre = (await prisma.venue.findUniqueOrThrow({ where: { id: x.venueId }, select: { name: true } })).name
    const nombreDe = async (id: string) => (await prisma.organization.findUniqueOrThrow({ where: { id }, select: { name: true } })).name
    const [origen, llegada] = [await nombreDe(x.organizationId), await nombreDe(destino.organizationId)]

    const transaccion = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>
    jest.spyOn(prisma, '$transaction').mockImplementationOnce((async (...args: unknown[]) => {
      // Entre las validaciones y la transacción llega otro empleado: el conteo tiene que leerse DENTRO.
      await prisma.staffVenue.create({ data: { staffId: otro, venueId: x.venueId, role: 'WAITER' } })
      const resultado = await transaccion(...args)
      // Y después del commit alguien renombra el negocio: releerlo fuera de la transacción lo vería.
      await prisma.$executeRaw`UPDATE "Venue" SET name = ${'Renombrado después del commit'} WHERE id = ${x.venueId}`
      return resultado
    }) as never)

    const r = await trasladar(x.venueId, destino.organizationId)

    expect(r).toEqual({
      status: 200,
      body: {
        success: true,
        message: `Venue "${nombre}" transferred from "${origen}" to "${llegada}"`,
        venue: expect.objectContaining({
          id: x.venueId,
          name: nombre,
          organizationId: destino.organizationId,
          organization: { id: destino.organizationId, name: llegada },
        }),
        staffMembersUpdated: 2,
      },
    })
    expect(
      await prisma.staffOrganization.count({ where: { organizationId: destino.organizationId, staffId: { in: [staffId, otro] } } }),
    ).toBe(2)
    expect(await bitacoraDe(x.venueId)).toMatchObject({
      staffId,
      venueId: x.venueId,
      organizationId: destino.organizationId,
      entity: 'Venue',
      entityId: x.venueId,
      data: {
        fromOrganizationId: x.organizationId,
        toOrganizationId: destino.organizationId,
        staffMembersUpdated: 2,
        ivaMixtoDestino: false,
      },
    })
  })
})

describe('carreras con el controlador REAL: bloqueador, espera probada en pg_stat_activity y soltar', () => {
  let harness: CatalogPublicationIntegrationHarness | null = null
  const h = () => {
    if (!harness) throw new Error('El arnés no se inició')
    return harness
  }
  beforeAll(async () => {
    harness = await createCatalogPublicationIntegrationHarness('iva-traslado')
  })
  afterAll(async () => {
    await harness?.disconnect()
  })

  /** Alguien espera un candado que retiene `pid`, con una consulta como `like`; devuelve su pid. Plazo: los 5 s del traslado. */
  const esperaDetrasDe = (pid: number, like: string, descripcion: string, soloPid?: number) =>
    hastaQue(
      h().observer,
      descripcion,
      4_000,
      Prisma.sql`SELECT a.pid FROM pg_stat_activity a
        WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
          AND ${pid}::int = ANY(pg_blocking_pids(a.pid)) AND a.query LIKE ${like}
          AND (${soloPid ?? null}::int IS NULL OR a.pid = ${soloPid ?? null}::int)
        LIMIT 1`,
    )

  it('dos traslados A→B y A→C a la vez: uno gana y el otro sale 409 IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION, con una sola bitácora', async () => {
    const c = await nuevoNegocio({ contabilidad: false }) // primero: su id queda antes que el de A
    const a = await nuevoNegocio({ contabilidad: false })
    const b = await nuevoNegocio({ contabilidad: false })
    expect(c.organizationId < a.organizationId).toBe(true) // A→C toma C primero: espera SIN haber tomado A

    const retenida = await retener(h().blocker, tx => tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${c.organizationId} FOR UPDATE`)
    let segundo: Promise<unknown> = Promise.resolve()
    let primero: unknown = null
    try {
      segundo = trasladar(a.venueId, c.organizationId)
      await esperaDetrasDe(retenida.pid, '%FROM "Organization"%FOR NO KEY UPDATE%', 'el traslado A→C esperando la organización C')
      primero = await trasladar(a.venueId, b.organizationId)
    } finally {
      await retenida.soltar()
      await segundo // aunque algo falle arriba, nada queda en vuelo al limpiar
    }

    expect(primero).toMatchObject({ status: 200 })
    debeRechazar(await segundo, CAMBIO)
    expect(await organizacionDe(a.venueId)).toBe(b.organizationId)
    await bitacoraDe(a.venueId)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(await bitacoras(a.venueId)).toHaveLength(1)
  })

  /** La emisión de un CFDI con su propia admisión: la orden FOR UPDATE y sus productos FOR SHARE, y sella un IVA_0. */
  const emisionEnVuelo =
    (f: { orderId: string; cfdiId: string; orderItemId: string }) =>
    async (tx: Prisma.TransactionClient): Promise<void> => {
      const orden = await bloquearOrdenParaFacturar(tx, f.orderId)
      await tomarAdmisionCompartida(tx, orden!.organizationId)
      await sellarRenglones(tx, { cfdiId: f.cfdiId, intento: 1, renglones: [{ orderItemId: f.orderItemId, tratamiento: 'IVA_0' }] })
    }

  it('emisión en vuelo (i): el regreso a 16 % por SQL directo ESPERA el producto; el traslado de ese intervalo ve el ≠ 16 % y sale INCOMPATIBLE', async () => {
    const { x, productId } = await mixto()
    const factura = await ordenConCfdi(x, productId, 'vuelo-i')
    const destino = await conLibros()
    const emision = await retener(h().writerOne, emisionEnVuelo(factura), { confirmar: true })
    let aDieciseis: Promise<unknown> = Promise.resolve()
    let traslado: unknown = null
    try {
      aDieciseis = desenlace(h().writerTwo.$executeRaw`UPDATE "Product" SET "ivaTratamiento" = 'IVA_16' WHERE id = ${productId}`)
      const pidCambio = await esperaDetrasDe(emision.pid, '%UPDATE "Product"%', 'el cambio a 16 % esperando el producto de la emisión')
      traslado = await trasladar(x.venueId, destino.organizationId)
      await esperaDetrasDe(emision.pid, '%UPDATE "Product"%', 'el cambio a 16 % todavía esperando tras el traslado', pidCambio)
    } finally {
      await emision.soltar()
      await aDieciseis
    }

    debeRechazar(traslado, INCOMPATIBLE)
    expect(await aDieciseis).toEqual({ ok: 1 })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { ivaTratamiento: true } })).toEqual({
      ivaTratamiento: 'IVA_16',
    })
    expect(await prisma.orderItem.findUniqueOrThrow({ where: { id: factura.orderItemId }, select: { ivaTratamiento: true } })).toEqual({
      ivaTratamiento: 'IVA_0',
    })
    expect(await organizacionDe(x.venueId)).toBe(x.organizationId)
  })

  it('emisión en vuelo (ii): el cambio a 16 % por el endpoint retiene la organización; el traslado espera detrás y sale INCOMPATIBLE por el sello', async () => {
    const { x, productId } = await mixto()
    const factura = await ordenConCfdi(x, productId, 'vuelo-ii')
    const destino = await conLibros()
    const emision = await retener(h().writerOne, emisionEnVuelo(factura), { confirmar: true })
    let aDieciseis: Promise<unknown> = Promise.resolve()
    let traslado: Promise<unknown> = Promise.resolve()
    try {
      aDieciseis = desenlace(updateProduct(x.venueId, productId, { ivaTratamiento: 'IVA_16' }, actor()))
      const pidCambio = await esperaDetrasDe(
        emision.pid,
        '%FROM "Product" AS product%',
        'el cambio por el endpoint esperando el producto, con la organización ya tomada',
      )
      traslado = trasladar(x.venueId, destino.organizationId)
      await esperaDetrasDe(
        pidCambio,
        '%FROM "Organization"%FOR NO KEY UPDATE%',
        'el traslado esperando la organización que retiene el cambio',
      )
    } finally {
      await emision.soltar()
      await Promise.all([aDieciseis, traslado])
    }

    expect(await aDieciseis).toHaveProperty('ok')
    debeRechazar(await traslado, INCOMPATIBLE)
    expect(await prisma.product.count({ where: { venueId: x.venueId, NOT: { ivaTratamiento: 'IVA_16' } } })).toBe(0) // mixto sólo por el sello
    expect(await organizacionDe(x.venueId)).toBe(x.organizationId)
  })

  it('un posteo real del negocio, pausado en una cuenta, hace esperar al traslado en Organization; confirmada la póliza, IVA_TRASLADO_CON_CONTABILIDAD', async () => {
    const x = await nuevoNegocio()
    const limpio = await nuevoNegocio({ contabilidad: false })
    const lines = await lineasDeVenta(x.organizationId, x.rfc)
    const cuenta = await retener(
      h().blocker,
      tx => tx.$queryRaw`SELECT id FROM "LedgerAccount" WHERE id = ${lines[0].ledgerAccountId} FOR UPDATE`,
    )
    let posteo: Promise<unknown> = Promise.resolve()
    let traslado: Promise<unknown> = Promise.resolve()
    try {
      posteo = desenlace(
        postJournalEntry(
          x.venueId,
          { date: '2026-06-15', concept: 'Póliza del negocio', source: JournalEntrySource.MANUAL, venueId: x.venueId, lines },
          { staffId: null },
        ),
      )
      const pidPosteo = await esperaDetrasDe(cuenta.pid, '%INSERT INTO "public"."JournalLine"%', 'el posteo esperando la cuenta retenida')
      traslado = trasladar(x.venueId, limpio.organizationId)
      await esperaDetrasDe(
        pidPosteo,
        '%FROM "Organization"%FOR NO KEY UPDATE%',
        'el traslado esperando la organización que retiene el posteo',
      )
    } finally {
      await cuenta.soltar()
      await Promise.all([posteo, traslado])
    }

    expect(await posteo).toMatchObject({ ok: { totalDebitCents: 11_600 } })
    debeRechazar(await traslado, CON_CONTABILIDAD)
    expect(await organizacionDe(x.venueId)).toBe(x.organizationId)
  })
})
