// tests/integration/customer-display/receiptEmisorOrder.integration.test.ts
import cuid from 'cuid'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getDeviceReceiptPayload } from '@/services/dashboard/receiptLayout/devicePayload.service'
import { cargarVenueInfo } from '@/services/dashboard/receiptLayout/readiness.service'

/**
 * El emisor PRINCIPAL del ticket con dos emisores de la MISMA fecha, contra Postgres de verdad: sólo la base decide el
 * orden de filas empatadas, y ese orden depende de cómo quedaron guardadas. Se prueba en los dos órdenes de inserción.
 */
const suffix = `reo-${Date.now()}`
const MISMA_FECHA = new Date('2026-01-01T00:00:00.000Z')
// cuid v1 (regla del repo, CLAUDE.md «IDs MUST be cuid v1»), ordenados: sólo letras minúsculas y dígitos, así que el orden
// de JavaScript y el de Postgres coinciden.
const [idMenor, idMayor] = [cuid(), cuid()].sort()
let orgId: string
let venueId: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `Venue ${suffix}`, slug: `venue-${suffix}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
  ).id
})

afterEach(async () => {
  if (!venueId) return // sin esta guarda, un `venueId` undefined borraría TODOS los emisores de la base (8-oct)
  await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
})

afterAll(async () => {
  if (!venueId) return
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

const crearEmisor = (id: string, rfc: string, db: Prisma.TransactionClient | typeof prisma = prisma) =>
  db.fiscalEmisor.create({
    data: { id, venueId, rfc, legalName: `Emisor ${rfc}`, regimenFiscal: '601', lugarExpedicion: '06600', createdAt: MISMA_FECHA },
  })

it.each([
  ['el de id MAYOR se guardó primero', [idMayor, idMenor]],
  ['el de id menor se guardó primero', [idMenor, idMayor]],
])('con la misma fecha, el principal es el de id menor (%s)', async (_caso, orden) => {
  for (const id of orden) await crearEmisor(id, id === idMenor ? 'AAA010101AAA' : 'ZZZ010101ZZZ')

  const { receiptInfo } = await getDeviceReceiptPayload(venueId)

  expect(receiptInfo?.principalEmisorId).toBe(idMenor)
  expect(receiptInfo?.rfc).toBe('AAA010101AAA')
  expect(receiptInfo?.fiscalEmisors.map(e => e.id)).toEqual([idMenor, idMayor])
})

/**
 * Las dos de arriba sólo cazan el defecto cuando Postgres lee la tabla en orden de GUARDADO («Seq Scan»). Con pocas filas
 * puede leerla por el índice único `(venueId, rfc)` («Index Scan using FiscalEmisor_venueId_rfc_key») y entregarla en
 * orden de RFC; el empate de `createdAt` conserva ese orden y ahí «AAA» coincide con el id menor: sin el arreglo, pasan
 * igual. Medido el 15-oct en la base de pruebas: el mismo `EXPLAIN` dio uno u otro plan antes y después de un
 * autoanalyze. Aquí el RFC va AL REVÉS del id: con el plan del índice, sin el desempate por id el principal sale el de id
 * MAYOR (el RFC «AAA»). Entre las tres, el defecto cae con cualquiera de los dos planes.
 */
it('🔴 aunque la base los entregue en orden de RFC (el de id MAYOR primero), el principal es el de id menor', async () => {
  await crearEmisor(idMenor, 'ZZZ010101ZZZ')
  await crearEmisor(idMayor, 'AAA010101AAA')

  const { receiptInfo } = await getDeviceReceiptPayload(venueId)

  expect(receiptInfo?.principalEmisorId).toBe(idMenor)
  expect(receiptInfo?.rfc).toBe('ZZZ010101ZZZ')
  expect(receiptInfo?.fiscalEmisors.map(e => e.id)).toEqual([idMenor, idMayor])
})

/**
 * 🔴 La vista previa del ticket en el dashboard (`cargarVenueInfo`) tiene que elegir el MISMO principal que imprime el
 * aparato. Sin el desempate por id, los dos planes ponen primero al de id MAYOR: el índice `(venueId, rfc)` porque su RFC
 * es «AAA», y el recorrido de la tabla porque se guardó primero, por UNA sola conexión (dos `create` sueltos pueden ir por
 * conexiones distintas del pool, cada una con su propia página).
 */
it('🔴 la vista previa del dashboard elige el MISMO emisor principal que imprime el aparato', async () => {
  await prisma.$transaction(async tx => {
    await crearEmisor(idMayor, 'AAA010101AAA', tx)
    await crearEmisor(idMenor, 'ZZZ010101ZZZ', tx)
  })

  const [vistaPrevia, { receiptInfo }] = await Promise.all([cargarVenueInfo(venueId), getDeviceReceiptPayload(venueId)])

  expect(receiptInfo?.principalEmisorId).toBe(idMenor)
  expect(vistaPrevia.principalEmisorId).toBe(receiptInfo?.principalEmisorId)
  expect(vistaPrevia.fiscalEmisors.map(e => e.id)).toEqual(receiptInfo?.fiscalEmisors.map(e => e.id))
})
