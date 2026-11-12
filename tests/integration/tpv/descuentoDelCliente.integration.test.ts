/**
 * El descuento del cliente contra Postgres de verdad (D1, Codex r6–r8): la consulta devuelve UN ganador por cliente con la
 * regla completa, el desempate fijo y sin que un cliente con muchos descuentos le quite el suyo a otro.
 *
 * @see src/services/shared/descuentoDelCliente.service.ts
 */
import prisma from '@/utils/prismaClient'
import { descuentosDeLosClientes } from '@/services/shared/descuentoDelCliente.service'

const sufijo = `${Date.now()}`
let venueId: string
let otroVenueId: string
let orgId: string

async function cliente(nombre: string, venue = venueId) {
  return prisma.customer.create({
    data: { venueId: venue, firstName: `FULLTEST-${nombre}`, phone: `55${Math.floor(Math.random() * 1e8)}` },
  })
}

async function descuento(datos: Record<string, any>, venue = venueId) {
  return prisma.discount.create({ data: { venueId: venue, name: 'Cliente', type: 'PERCENTAGE', value: 10, ...datos } as any })
}

async function asignar(customerId: string, discountId: string, datos: Record<string, any> = {}) {
  return prisma.customerDiscount.create({ data: { customerId, discountId, ...datos } })
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `FULLTEST descuento cliente ${sufijo}`, email: `fulltest-dc-${sufijo}@test.com`, phone: '5550000000' },
  })
  orgId = org.id
  const venue = (slug: string) =>
    prisma.venue.create({
      data: {
        name: `FULLTEST ${slug}`,
        slug: `fulltest-dc-${slug}-${sufijo}`,
        organizationId: org.id,
        address: 'x',
        city: 'x',
        state: 'x',
        country: 'MX',
        zipCode: '00000',
        timezone: 'America/Mexico_City',
      },
    })
  venueId = (await venue('a')).id
  otroVenueId = (await venue('b')).id
})

afterAll(async () => {
  // Sin id no se borra nada: un filtro `undefined` borraría lo de otras pruebas de la misma base (Codex r9).
  for (const v of [venueId, otroVenueId]) {
    if (!v) continue
    await prisma.customerDiscount.deleteMany({ where: { customer: { venueId: v } } })
    await prisma.discount.deleteMany({ where: { venueId: v } })
    await prisma.customer.deleteMany({ where: { venueId: v } })
    await prisma.venue.deleteMany({ where: { id: v } })
  }
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})
})

describe('descuentosDeLosClientes contra Postgres', () => {
  it('el descuento simple asignado cuenta, en pesos 1:1', async () => {
    const c = await cliente('Simple')
    const d = await descuento({ name: 'Cliente 10 %', maxDiscountAmount: 20 })
    await asignar(c.id, d.id)

    const mapa = await descuentosDeLosClientes(venueId, [c.id])

    expect(mapa.get(c.id)).toEqual({ discountId: d.id, name: 'Cliente 10 %', type: 'PERCENTAGE', value: 10, maxDiscountAmount: 20 })
  })

  it('días NULL (fila por SQL o de referidos) cuentan como vacío; con días puestos no cuenta', async () => {
    const conNull = await cliente('DiasNull')
    const dNull = await descuento({ name: 'Días NULL' })
    await prisma.$executeRaw`UPDATE "Discount" SET "daysOfWeek" = NULL WHERE id = ${dNull.id}`
    await asignar(conNull.id, dNull.id)
    const conDias = await cliente('ConDias')
    await asignar(conDias.id, (await descuento({ name: 'Lunes', daysOfWeek: [1] })).id)

    const mapa = await descuentosDeLosClientes(venueId, [conNull.id, conDias.id])

    expect(mapa.get(conNull.id)?.discountId).toBe(dNull.id)
    expect(mapa.has(conDias.id)).toBe(false)
  })

  it('no cuentan: de otro negocio, asignación apagada o vencida, compra mínima, con aprobación, de grupo', async () => {
    const c = await cliente('NoCuentan')
    await asignar(c.id, (await descuento({ name: 'Otro negocio' }, otroVenueId)).id)
    await asignar(c.id, (await descuento({ name: 'Apagada' })).id, { active: false })
    await asignar(c.id, (await descuento({ name: 'Vencida' })).id, { validUntil: new Date(Date.now() - 60_000) })
    await asignar(c.id, (await descuento({ name: 'Mínima', minPurchaseAmount: 100 })).id)
    await asignar(c.id, (await descuento({ name: 'Aprobación', requiresApproval: true })).id)
    await asignar(c.id, (await descuento({ name: 'Descuento vencido', validUntil: new Date(Date.now() - 60_000) })).id)

    expect((await descuentosDeLosClientes(venueId, [c.id])).has(c.id)).toBe(false)
  })

  it('gana prioridad, luego valor, luego el más viejo', async () => {
    const c = await cliente('Orden')
    const viejo = await descuento({ name: 'Viejo 10', value: 10, createdAt: new Date('2026-01-01T00:00:00Z') })
    await descuento({ name: 'Nuevo 10', value: 10, createdAt: new Date('2026-06-01T00:00:00Z') }).then(d => asignar(c.id, d.id))
    await asignar(c.id, viejo.id)
    expect((await descuentosDeLosClientes(venueId, [c.id])).get(c.id)?.discountId).toBe(viejo.id)

    const mayor = await descuento({ name: 'Mayor 30', value: 30 })
    await asignar(c.id, mayor.id)
    expect((await descuentosDeLosClientes(venueId, [c.id])).get(c.id)?.discountId).toBe(mayor.id)

    const prioritario = await descuento({ name: 'Prioridad 5', value: 5, priority: 5 })
    await asignar(c.id, prioritario.id)
    expect((await descuentosDeLosClientes(venueId, [c.id])).get(c.id)?.discountId).toBe(prioritario.id)
  })

  it('empate total (prioridad, valor y fecha): gana el id menor, sin importar el orden en que se crearon', async () => {
    const c = await cliente('Empate')
    const misma = new Date('2026-03-01T00:00:00Z')
    // ids de 25 caracteres con la `c` de cuid v1; sólo cambia el último.
    const idMayor = `cz${sufijo.slice(-8)}${'0'.repeat(14)}2`
    const idMenor = `cz${sufijo.slice(-8)}${'0'.repeat(14)}1`
    await descuento({ id: idMayor, name: 'Con tope $1', maxDiscountAmount: 1, createdAt: misma }).then(d => asignar(c.id, d.id))
    await descuento({ id: idMenor, name: 'Sin tope', createdAt: misma }).then(d => asignar(c.id, d.id))

    for (let i = 0; i < 3; i++) {
      expect((await descuentosDeLosClientes(venueId, [c.id])).get(c.id)?.discountId).toBe(idMenor)
    }
  })

  it('un cliente con 12 descuentos más prioritarios no le quita el suyo a otro de la misma lista', async () => {
    const acaparador = await cliente('Acaparador')
    for (let i = 0; i < 12; i++) await descuento({ name: `Alto ${i}`, value: 50, priority: 9 }).then(d => asignar(acaparador.id, d.id))
    const otro = await cliente('Otro')
    const suyo = await descuento({ name: 'El de Otro', value: 10 })
    await asignar(otro.id, suyo.id)

    const mapa = await descuentosDeLosClientes(venueId, [acaparador.id, otro.id, acaparador.id])

    expect(mapa.get(otro.id)?.discountId).toBe(suyo.id)
    expect(mapa.get(acaparador.id)?.value).toBe(50)
    expect(mapa.size).toBe(2)
  })
})
