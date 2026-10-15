// tests/integration/customer-display/venueSignatures.integration.test.ts
import cuid from 'cuid'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getDeviceReceiptPayload } from '@/services/dashboard/receiptLayout/devicePayload.service'
import { ORDEN_DE_EMISORES, readVenueSignatures, venueSignaturesSql } from '@/services/customer-display/venueSignatures'
import { retener } from './barrera'

/**
 * La firma del venue contra Postgres de verdad: cada cosa que cambia el ticket o los ajustes tiene que cambiar SU parte de
 * la firma, y nada más. Andamiaje: una organización, un venue con ajustes y dos comercios reales (un proveedor de pagos de
 * prueba con dos cuentas): la asociación comercio-emisor necesita un `MerchantAccount` que exista.
 */
const suffix = `vsg-${Date.now()}`
const PROVEEDOR = `F0B_FIRMA_${Date.now()}`
let orgId: string
let venueId: string
let m1: string
let m2: string

const firma = async () => (await readVenueSignatures(venueId))!
const emisor = (rfc: string, opciones: { id?: string; createdAt?: Date } = {}) =>
  prisma.fiscalEmisor.create({
    data: { venueId, rfc, legalName: `Emisor ${rfc}`, regimenFiscal: '601', lugarExpedicion: '06600', ...opciones },
    select: { id: true },
  })

/**
 * La firma de emisores leída SIN índices: Postgres recorre la tabla en orden de GUARDADO. Con pocas filas el planificador
 * a veces lee por el índice único `(venueId, rfc)` y entrega los empatados en orden de RFC, que no depende de cómo se
 * guardaron: con ese plan, una firma sin el desempate por id pasaba igual (medido en el sabotaje: 1 de 2 corridas).
 */
const firmaEnOrdenDeGuardado = () =>
  prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET LOCAL enable_indexscan = off')
    await tx.$executeRawUnsafe('SET LOCAL enable_indexonlyscan = off')
    await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off')
    const [fila] = await tx.$queryRaw<{ emisores: string }[]>(venueSignaturesSql(venueId))
    return fila.emisores
  })
/** El orden físico de los emisores del venue (el que sigue un recorrido de la tabla). */
const ordenDeGuardado = async () =>
  (await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "FiscalEmisor" WHERE "venueId" = ${venueId} ORDER BY ctid`).map(f => f.id)

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
  await prisma.venueSettings.create({ data: { venueId } })
  const proveedor = await prisma.paymentProvider.create({
    data: { code: PROVEEDOR, name: 'Proveedor de prueba F0-B', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    select: { id: true },
  })
  const comercio = async (n: string) =>
    (
      await prisma.merchantAccount.create({
        data: { providerId: proveedor.id, externalMerchantId: `${suffix}-${n}`, credentialsEncrypted: {} },
        select: { id: true },
      })
    ).id
  m1 = await comercio('m1')
  m2 = await comercio('m2')
})

afterEach(async () => {
  if (!venueId) return // sin esta guarda, un `venueId` undefined vaciaría estas tablas enteras (8-oct)
  await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisor: { venueId } } })
  await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
  await prisma.receiptLayout.deleteMany({ where: { venueId } })
})

afterAll(async () => {
  if (!venueId) return
  const comercios = [m1, m2].filter(Boolean)
  if (comercios.length) await prisma.merchantAccount.deleteMany({ where: { id: { in: comercios } } }) // m1 pudo borrarse en la prueba de cascada
  await prisma.paymentProvider.deleteMany({ where: { code: PROVEEDOR } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('readVenueSignatures', () => {
  it('un venue que no existe da null', async () => {
    expect(await readVenueSignatures(cuid())).toBeNull()
  })

  it('sin cambios, dos lecturas dan lo mismo', async () => {
    expect(await firma()).toEqual(await firma())
  })

  it('cambiar el negocio (nombre, logo, zona horaria…) mueve venueAt y nada más', async () => {
    const antes = await firma()
    await prisma.venue.update({ where: { id: venueId }, data: { name: `Otro ${suffix}` } })
    const despues = await firma()
    expect(despues.venueAt).not.toBe(antes.venueAt)
    expect({ ...despues, venueAt: antes.venueAt }).toEqual(antes)
  })

  it('cambiar los ajustes del negocio mueve settingsAt', async () => {
    const antes = await firma()
    await prisma.venueSettings.update({ where: { venueId }, data: { promotionsPanelCustomer: 'HIDDEN' } })
    expect((await firma()).settingsAt).not.toBe(antes.settingsAt)
  })

  it('el ticket: la revisión cambia la firma, y restablecerlo (fila nueva, revisión 1 otra vez) también', async () => {
    const primera = await prisma.receiptLayout.create({ data: { venueId, blocks: [] }, select: { id: true } })
    expect((await firma()).receiptLayout).toBe(`${primera.id}:1`)
    await prisma.receiptLayout.update({ where: { venueId }, data: { revision: 2 } })
    expect((await firma()).receiptLayout).toBe(`${primera.id}:2`)
    await prisma.receiptLayout.delete({ where: { venueId } })
    const segunda = await prisma.receiptLayout.create({ data: { venueId, blocks: [] }, select: { id: true } })
    expect((await firma()).receiptLayout).toBe(`${segunda.id}:1`)
    expect(segunda.id).not.toBe(primera.id)
  })

  it('agregar un emisor cambia la firma — también el número 21 (no hay tope)', async () => {
    for (let i = 0; i < 20; i++) await emisor(`RFC${String(i).padStart(9, '0')}`)
    const con20 = await firma()
    await emisor('RFC000000020')
    expect((await firma()).emisores).not.toBe(con20.emisores)
  })

  it('una edición que confirma TARDE, con un updatedAt viejo, también cambia la firma', async () => {
    const { id } = await emisor('TAR010101AAA')
    // Uno MÁS NUEVO que se queda con el `max(updatedAt)`: así la edición tardía no mueve ni el conteo ni el máximo. Sin él,
    // el editado era también el máximo y una firma de `count + max(updatedAt)` pasaba esta prueba (medido en el sabotaje).
    await emisor('TAR020202BBB')
    const antes = await firma()
    const { soltar, transaccion } = await retener(
      tx => tx.$executeRaw`UPDATE "FiscalEmisor" SET "legalName" = 'Tarde SA', "updatedAt" = '2000-01-01' WHERE id = ${id}`,
    )
    expect((await firma()).emisores).toBe(antes.emisores) // aún no confirma: no se ve
    soltar()
    await transaccion
    expect((await firma()).emisores).not.toBe(antes.emisores)
  })

  it('dos emisores de la MISMA fecha: la firma no depende del orden en que se guardaron', async () => {
    const fecha = new Date('2026-01-01T00:00:00.000Z')
    const [idMenor, idMayor] = [cuid(), cuid()].sort()
    await emisor('ZZZ010101ZZZ', { id: idMayor, createdAt: fecha })
    await emisor('AAA010101AAA', { id: idMenor, createdAt: fecha })
    const guardadoUno = await ordenDeGuardado()
    const unOrden = await firma()
    const unOrdenRecorrido = await firmaEnOrdenDeGuardado()
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await emisor('AAA010101AAA', { id: idMenor, createdAt: fecha })
    await emisor('ZZZ010101ZZZ', { id: idMayor, createdAt: fecha })
    // La prueba sólo vale si de verdad quedaron guardados al revés; si no, que lo diga en vez de pasar sin probar nada.
    expect(await ordenDeGuardado()).toEqual([...guardadoUno].reverse())
    expect((await firma()).emisores).toBe(unOrden.emisores)
    expect(await firmaEnOrdenDeGuardado()).toBe(unOrdenRecorrido)
  })

  it('🔴 y el primero según la firma es EL MISMO emisor principal que imprime el recibo', async () => {
    const fecha = new Date('2026-01-01T00:00:00.000Z')
    const [idMenor, idMayor] = [cuid(), cuid()].sort()
    await emisor('ZZZ010101ZZZ', { id: idMayor, createdAt: fecha })
    await emisor('AAA010101AAA', { id: idMenor, createdAt: fecha })
    const [{ id }] = await prisma.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT e.id FROM "FiscalEmisor" e WHERE e."venueId" = ${venueId} ORDER BY ${ORDEN_DE_EMISORES} LIMIT 1`,
    )
    const { receiptInfo } = await getDeviceReceiptPayload(venueId)
    expect(receiptInfo?.principalEmisorId).toBe(id)
    expect(id).toBe(idMenor)
  })

  it('una asociación nueva, una reasignación y el borrado en cascada de un comercio cambian las asociaciones', async () => {
    const a = await emisor('AAA020202AAA')
    const b = await emisor('BBB020202BBB')
    const sin = await firma()
    const config = await prisma.merchantFiscalConfig.create({ data: { fiscalEmisorId: a.id, merchantAccountId: m1 }, select: { id: true } })
    const con = await firma()
    expect(con.asociaciones).not.toBe(sin.asociaciones)
    expect(con.emisores).toBe(sin.emisores) // los emisores no cambiaron

    await prisma.merchantFiscalConfig.update({ where: { id: config.id }, data: { fiscalEmisorId: b.id } })
    const reasignada = await firma()
    expect(reasignada.asociaciones).not.toBe(con.asociaciones)

    await prisma.merchantAccount.delete({ where: { id: m1 } }) // ON DELETE CASCADE borra la configuración
    expect((await firma()).asociaciones).not.toBe(reasignada.asociaciones)
  })
})
