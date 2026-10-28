// tests/integration/mobile/precioDeExtra.historial.integration.test.ts
import fs from 'node:fs'
import path from 'node:path'
import prisma from '@/utils/prismaClient'

/**
 * Historial de `Modifier.price` (migración `20261020120000_historial_de_precio_de_extra`). Hermano de
 * `productPriceHistory.trigger.test.ts`: lo escriben SÓLO dos disparadores DIFERIDOS ("Modifier_zz_historial_de_precio_ins"
 * / "_upd") con la función `modifierPriceHistoryWriter`, que cubren a todo escritor (Prisma, SQL directo, importaciones).
 * Diferencia con Product: `Modifier` no tiene `venueId`; el disparador lo lee de `"ModifierGroup"."venueId"` por `groupId`.
 * Se prueba contra Postgres real: un mock no puede ejecutar plpgsql.
 */
describe('Historial de precio de Modifier (disparadores diferidos)', () => {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let otroVenueId: string
  let groupId: string
  let otroGroupId: string

  const crear = (data: Record<string, unknown> = {}, grupo = groupId) =>
    prisma.modifier.create({ data: { groupId: grupo, name: `E ${Math.random()}`, price: 10, ...data } as any })
  const historial = (modifierId: string) =>
    prisma.modifierPriceHistory.findMany({ where: { modifierId }, orderBy: [{ validFrom: 'asc' }, { id: 'asc' }] })
  const abiertas = (modifierId: string) => prisma.modifierPriceHistory.findMany({ where: { modifierId, validTo: null } })

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `HistE ${s}`, email: `histe-${s}@example.com`, phone: '5555555555' } })
    organizationId = org.id
    const venue = await prisma.venue.create({ data: { organizationId, name: `HistE ${s}`, slug: `histe-${s}`, seatCapExempt: true } })
    venueId = venue.id
    const otro = await prisma.venue.create({ data: { organizationId, name: `HistE2 ${s}`, slug: `histe2-${s}`, seatCapExempt: true } })
    otroVenueId = otro.id
    groupId = (await prisma.modifierGroup.create({ data: { venueId, name: `Grupo ${s}` } })).id
    otroGroupId = (await prisma.modifierGroup.create({ data: { venueId: otroVenueId, name: `Grupo2 ${s}` } })).id
  })

  afterAll(async () => {
    if (!venueId || !otroVenueId || !organizationId) return // sin fixture, un deleteMany sin filtro borraría la tabla entera
    await prisma.modifierGroup.deleteMany({ where: { venueId: { in: [venueId, otroVenueId] } } }) // extras e historial, en cascada
    await prisma.venue.deleteMany({ where: { id: { in: [venueId, otroVenueId] } } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
  })

  it('alta de extra abre una fila con su precio', async () => {
    const m = await crear({ price: 12.5 })
    const filas = await historial(m.id)
    expect(filas).toHaveLength(1)
    expect([Number(filas[0].price), filas[0].validTo]).toEqual([12.5, null])
    expect(Math.abs(filas[0].validFrom.getTime() - Date.now())).toBeLessThan(5_000) // UTC, no la zona de la sesión
  })

  it('cambio de precio cierra la anterior con validTo y abre otra', async () => {
    const m = await crear({ price: 10 })
    await prisma.modifier.update({ where: { id: m.id }, data: { price: 15 } })
    const [viejo, nuevo, ...resto] = await historial(m.id)
    expect(resto).toHaveLength(0)
    expect([Number(viejo.price), Number(nuevo.price), nuevo.validTo]).toEqual([10, 15, null])
    expect(viejo.validTo!.getTime()).toBe(nuevo.validFrom.getTime()) // contiguas: sin hueco ni traslape
  })

  // Un precio intermedio que nunca se confirmó no se publicó: no puede quedar fila suya (con «el más bajo», un pedido
  // armado a mano podría cobrarlo).
  it('dos cambios en la misma transacción dejan UNA fila corregida (creadoEnTx)', async () => {
    const m = await crear({ price: 10 })
    await prisma.$transaction(async tx => {
      await tx.modifier.update({ where: { id: m.id }, data: { price: 15 } })
      await tx.modifier.update({ where: { id: m.id }, data: { price: 20 } })
    })
    const [viejo, nuevo, ...resto] = await historial(m.id)
    expect(resto).toHaveLength(0)
    expect([Number(viejo.price), Number(nuevo.price), nuevo.validTo]).toEqual([10, 20, null])
    expect(viejo.validTo!.getTime()).toBe(nuevo.validFrom.getTime())
  })

  it('crear y cambiar el precio en la misma transacción deja una sola fila, la del nuevo', async () => {
    let id = ''
    await prisma.$transaction(async tx => {
      id = (await tx.modifier.create({ data: { groupId, name: `E ${Math.random()}`, price: 10 } })).id
      await tx.modifier.update({ where: { id }, data: { price: 15 } })
    })
    expect((await historial(id)).map(f => [Number(f.price), f.validTo])).toEqual([[15, null]])
  })

  it('cambio que no toca price no escribe', async () => {
    const m = await crear({ price: 10 })
    await prisma.modifier.update({ where: { id: m.id }, data: { name: `Otro ${Math.random()}`, active: false } })
    await prisma.modifier.update({ where: { id: m.id }, data: { price: 10 } }) // mismo precio
    expect(await historial(m.id)).toHaveLength(1)
  })

  it('el relleno deja una fila abierta por extra existente (y no duplica)', async () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '../../../prisma/migrations/20261020120000_historial_de_precio_de_extra/migration.sql'),
      'utf8',
    )
    const relleno = sql.slice(sql.indexOf('-- RELLENO')) // el INSERT ... SELECT real de la migración, no una copia
    expect(relleno).toContain('INSERT INTO "ModifierPriceHistory"')

    const sinHistorial = await crear({ price: 7.5 })
    const conHistorial = await crear({ price: 9 })
    await prisma.$executeRawUnsafe(`DELETE FROM "ModifierPriceHistory" WHERE "modifierId" = $1`, sinHistorial.id)
    expect(await historial(sinHistorial.id)).toHaveLength(0)

    await prisma.$executeRawUnsafe(relleno)
    await prisma.$executeRawUnsafe(relleno) // idempotente: la segunda pasada no encuentra nada que rellenar

    const filas = await historial(sinHistorial.id)
    expect(filas.map(f => [Number(f.price), f.validTo, f.venueId])).toEqual([[7.5, null, venueId]])
    expect(Math.abs(filas[0].validFrom.getTime() - Date.now())).toBeLessThan(5_000)
    expect(await historial(conHistorial.id)).toHaveLength(1) // el que ya tenía fila abierta no se toca
  })

  it('venueId de la fila = venueId del grupo', async () => {
    const aqui = await crear({ price: 10 }, groupId)
    const alla = await crear({ price: 10 }, otroGroupId)
    expect((await historial(aqui.id))[0].venueId).toBe(venueId)
    expect((await historial(alla.id))[0].venueId).toBe(otroVenueId)
    await prisma.modifier.update({ where: { id: alla.id }, data: { price: 11 } })
    expect((await historial(alla.id)).map(f => f.venueId)).toEqual([otroVenueId, otroVenueId]) // también al cambiar de precio
  })

  it('el SQL directo también queda registrado', async () => {
    const m = await crear({ price: 10 })
    await prisma.$executeRawUnsafe(`UPDATE "Modifier" SET "price" = 25 WHERE "id" = $1`, m.id)
    expect((await historial(m.id)).map(f => Number(f.price))).toEqual([10, 25])
  })

  // Regresión heredada de Product: el disparador corre al confirmar, cuando el extra ya puede no existir. Sin la guarda,
  // el INSERT choca con la llave foránea y la transacción ENTERA de quien escribe truena al confirmar.
  it('cambiar el precio y borrar el extra en la misma transacción confirma sin error', async () => {
    const m = await crear({ price: 10 })
    await prisma.$transaction(async tx => {
      await tx.modifier.update({ where: { id: m.id }, data: { price: 15 } })
      await tx.modifier.delete({ where: { id: m.id } })
    })
    expect(await prisma.modifier.findUnique({ where: { id: m.id } })).toBeNull()
    expect(await historial(m.id)).toHaveLength(0)
  })

  it('a lo más UN precio abierto por extra', async () => {
    const m = await crear({ price: 10 })
    await expect(
      prisma.modifierPriceHistory.create({ data: { venueId, modifierId: m.id, price: 99, validFrom: new Date() } }),
    ).rejects.toMatchObject({ code: 'P2002' })
    expect(await abiertas(m.id)).toHaveLength(1)
  })
})
