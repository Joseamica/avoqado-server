import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { lockWasteBatchesInTx } from '@/services/dashboard/fifoBatch.service'

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)
const fixture = `fefo-${randomUUID()}`
let organizationId = ''
let venueId = ''
let otherVenueId = ''

beforeAll(async () => {
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(declared.hostname)
  expect(declared.pathname.toLowerCase()).toContain('test')
  const org = await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
  organizationId = org.id
  const mk = (slug: string) =>
    prisma.venue.create({ data: { organizationId, name: slug, slug, timezone: 'America/Mexico_City', currency: 'MXN' } })
  venueId = (await mk(fixture)).id
  otherVenueId = (await mk(`${fixture}-otro`)).id
})

afterAll(async () => {
  // Cada borrado corre aunque falle el anterior: un fallo no debe dejar huérfano el resto.
  const fallos: unknown[] = []
  const intenta = async (paso: () => Promise<unknown>) => {
    try {
      await paso()
    } catch (error) {
      fallos.push(error)
    }
  }
  for (const id of [venueId, otherVenueId].filter(Boolean)) {
    await intenta(() => prisma.stockBatch.deleteMany({ where: { venueId: id } }))
    await intenta(() => prisma.rawMaterial.deleteMany({ where: { venueId: id } }))
  }
  if (organizationId) {
    await intenta(() => prisma.venue.deleteMany({ where: { organizationId } }))
    await intenta(() => prisma.organization.deleteMany({ where: { id: organizationId } }))
  }
  if (fallos.length > 0) throw fallos[0]
})

async function raw(venue: string) {
  return prisma.rawMaterial.create({
    data: {
      venueId: venue,
      name: `Ing ${randomUUID()}`,
      sku: randomUUID(),
      category: 'OTHER',
      unit: 'PIECE',
      unitType: 'COUNT',
      currentStock: D(10),
      minimumStock: D(0),
      reorderPoint: D(0),
      costPerUnit: D(1),
      avgCostPerUnit: D(1),
      notifyOnLowStock: false,
    },
  })
}

function batch(venue: string, rawMaterialId: string, received: string, expires: string | null, id?: string) {
  return prisma.stockBatch.create({
    data: {
      id,
      venueId: venue,
      rawMaterialId,
      batchNumber: randomUUID(),
      initialQuantity: D(5),
      remainingQuantity: D(5),
      unit: 'PIECE',
      costPerUnit: D(1),
      receivedDate: new Date(received),
      expirationDate: expires ? new Date(expires) : null,
    },
  })
}

const orden = (venue: string, id: string, order: 'FIFO' | 'FEFO') =>
  prisma.$transaction(async tx => (await lockWasteBatchesInTx(tx, venue, id, order)).map(b => b.id))

test('🔴 FEFO pone primero el lote que vence antes, aunque se recibiera después', async () => {
  const item = await raw(venueId)
  const viejoValido = await batch(venueId, item.id, '2026-01-01T00:00:00Z', '2026-12-01T00:00:00Z')
  const nuevoPorVencer = await batch(venueId, item.id, '2026-02-01T00:00:00Z', '2026-10-01T00:00:00Z')
  expect(await orden(venueId, item.id, 'FEFO')).toEqual([nuevoPorVencer.id, viejoValido.id])
  expect(await orden(venueId, item.id, 'FIFO')).toEqual([viejoValido.id, nuevoPorVencer.id])
})

test('los lotes sin fecha de caducidad van al final en FEFO', async () => {
  const item = await raw(venueId)
  const sinFecha = await batch(venueId, item.id, '2026-01-01T00:00:00Z', null)
  const conFecha = await batch(venueId, item.id, '2026-03-01T00:00:00Z', '2027-01-01T00:00:00Z')
  expect(await orden(venueId, item.id, 'FEFO')).toEqual([conFecha.id, sinFecha.id])
})

test('🔴 no cruza venues', async () => {
  const propio = await raw(venueId)
  await batch(venueId, propio.id, '2026-01-01T00:00:00Z', null)
  expect(await orden(otherVenueId, propio.id, 'FEFO')).toEqual([])
})

test('sin caducidades FEFO degenera a FIFO: primero la fecha de recepción, luego el id', async () => {
  const item = await raw(venueId)
  const p = randomUUID()
  // Ids fijados a mano: su orden no coincide ni con la recepción ni con la inserción, así
  // que sólo un ORDER BY por recepción y luego por id produce el orden esperado.
  const tardio = await batch(venueId, item.id, '2026-03-01T00:00:00Z', null, `${p}-1`)
  const temprano = await batch(venueId, item.id, '2026-01-01T00:00:00Z', null, `${p}-2`)
  const empateB = await batch(venueId, item.id, '2026-02-01T00:00:00Z', null, `${p}-4`)
  const empateA = await batch(venueId, item.id, '2026-02-01T00:00:00Z', null, `${p}-3`)
  const esperado = [temprano.id, empateA.id, empateB.id, tardio.id]
  expect(await orden(venueId, item.id, 'FIFO')).toEqual(esperado)
  expect(await orden(venueId, item.id, 'FEFO')).toEqual(esperado)
})

class Revertir extends Error {}

/**
 * A bloquea el lote con FOR UPDATE y se queda abierta; B intenta asignar mientras tanto.
 * A sólo se suelta cuando B ya respondió, y siempre termina por rollback (Revertir).
 */
async function asignarMientrasOtraTxBloqueaElLote(order: 'FIFO' | 'FEFO') {
  const item = await raw(venueId)
  const lote = await batch(venueId, item.id, '2026-01-01T00:00:00Z', '2026-12-01T00:00:00Z')

  let avisarCandado!: () => void
  const candadoTomado = new Promise<void>(resolve => (avisarCandado = resolve))
  let soltarA!: () => void
  const aPuedeTerminar = new Promise<void>(resolve => (soltarA = resolve))

  let errorDeA: unknown
  const a = prisma
    .$transaction(async txA => {
      await txA.$queryRaw`SELECT id FROM "StockBatch" WHERE id = ${lote.id} FOR UPDATE`
      avisarCandado()
      await aPuedeTerminar
      throw new Revertir()
    })
    .catch(error => {
      if (!(error instanceof Revertir)) errorDeA = error
    })

  let resultado!: { error?: unknown; ms: number }
  try {
    const aTieneElCandado = await Promise.race([candadoTomado.then(() => true), a.then(() => false)])
    if (!aTieneElCandado) throw new Error('A terminó sin tomar el candado del lote')
    const inicio = Date.now()
    try {
      await prisma.$transaction(txB => lockWasteBatchesInTx(txB, venueId, item.id, order))
      resultado = { ms: Date.now() - inicio }
    } catch (error) {
      resultado = { error, ms: Date.now() - inicio }
    }
  } finally {
    soltarA()
    await a
  }
  if (errorDeA) throw errorDeA
  return resultado
}

test.each(['FEFO', 'FIFO'] as const)('🔴 %s no espera un lote bloqueado: falla al instante con 55P03 (NOWAIT)', async order => {
  const resultado = await asignarMientrasOtraTxBloqueaElLote(order)
  expect(resultado.error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  expect(resultado.error).toMatchObject({ code: 'P2010', meta: { code: '55P03' } })
  // Sin NOWAIT, B esperaría a que A suelte el lote (hasta el timeout de 5 s de la transacción).
  expect(resultado.ms).toBeLessThan(2500)
})
