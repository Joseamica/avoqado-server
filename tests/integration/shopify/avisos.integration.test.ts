// tests/integration/shopify/avisos.integration.test.ts
import { randomUUID } from 'crypto'
import { formatInTimeZone } from 'date-fns-tz'
import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { notifyShopify } from '@/services/commerce-channels/shopify/shopify.notify.service'
import { assertTestDatabase, crearEscenarioShopify, EscenarioShopify, limpiarEscenarioShopify } from './fixtures'

let e: EscenarioShopify
beforeAll(() => assertTestDatabase())
beforeEach(async () => {
  e = await crearEscenarioShopify()
})
afterEach(async () => {
  await limpiarEscenarioShopify(e)
})

const hoy = () => formatInTimeZone(new Date(), 'America/Mexico_City', 'yyyy-MM-dd')
async function persona(role: StaffRole, active = true): Promise<string> {
  const s = await prisma.staff.create({
    data: { email: `${role.toLowerCase()}-${randomUUID()}@example.test`, firstName: 'Prueba', lastName: role },
  })
  await prisma.staffVenue.create({ data: { staffId: s.id, venueId: e.venueId, role, active } })
  return s.id
}
const avisos = (recipientId?: string) =>
  prisma.notification.findMany({
    where: { venueId: e.venueId, entityType: 'ShopifyAviso', ...(recipientId ? { recipientId } : {}) },
    orderBy: { createdAt: 'asc' },
    take: 200,
  })

it('avisa a OWNER y ADMIN activos; no a MANAGER ni a un ADMIN inactivo', async () => {
  const owner = await persona('OWNER')
  await persona('MANAGER')
  await persona('ADMIN', false)
  await notifyShopify(e.venueId, 'REVOCADA')
  expect(new Set((await avisos()).map(n => n.recipientId))).toEqual(new Set([e.staffId, owner]))
})

it('el mismo aviso el mismo día llega una sola vez a cada quien', async () => {
  await notifyShopify(e.venueId, 'ATORADOS', { count: 2 })
  await notifyShopify(e.venueId, 'ATORADOS', { count: 5 })
  const lista = await avisos(e.staffId)
  expect(lista).toHaveLength(1)
  expect(lista[0].message).toContain('2 cambios de stock')
})

it('dos avisos distintos el mismo día sí llegan los dos', async () => {
  await notifyShopify(e.venueId, 'REVOCADA')
  await notifyShopify(e.venueId, 'SOBREVENTA', { productName: 'Camisa · M' })
  expect((await avisos(e.staffId)).map(n => n.entityId?.split(':')[0]).sort()).toEqual(['REVOCADA', 'SOBREVENTA'])
})

it('el dedup es por destinatario: quien no lo tenía lo recibe aunque otro ya lo tenga', async () => {
  await notifyShopify(e.venueId, 'FALTA_PERMISO')
  const owner = await persona('OWNER')
  await notifyShopify(e.venueId, 'FALTA_PERMISO')
  expect(await avisos(e.staffId)).toHaveLength(1)
  expect(await avisos(owner)).toHaveLength(1)
})

it('la llave es aviso:negocio:día local, tipo ALERT, con el producto en el texto y la liga a la página', async () => {
  await notifyShopify(e.venueId, 'SOBREVENTA', { productName: 'Camisa · M' })
  const [n] = await avisos(e.staffId)
  expect(n).toMatchObject({ type: 'ALERT', entityId: `SOBREVENTA:${e.venueId}:${hoy()}`, priority: 'HIGH' })
  expect(n.message).toContain('Camisa · M')
  expect(n.actionUrl).toMatch(/\/settings\/integrations\/shopify$/)
})

it('🔴 N8: recorre a TODOS por tandas: 101 administradores reciben su aviso, una sola vez', async () => {
  const sufijo = randomUUID().slice(0, 8)
  await prisma.staff.createMany({
    data: Array.from({ length: 100 }, (_, i) => ({ email: `admin-${i}-${sufijo}@example.test`, firstName: 'Admin', lastName: `${i}` })),
  })
  const nuevos = await prisma.staff.findMany({ where: { email: { endsWith: `-${sufijo}@example.test` } }, select: { id: true }, take: 200 })
  await prisma.staffVenue.createMany({
    data: nuevos.map(s => ({ staffId: s.id, venueId: e.venueId, role: 'ADMIN' as const, active: true })),
  })
  await notifyShopify(e.venueId, 'REVOCADA')
  await notifyShopify(e.venueId, 'REVOCADA')
  const porPersona = await prisma.notification.groupBy({
    by: ['recipientId'],
    where: { venueId: e.venueId, entityType: 'ShopifyAviso' },
    _count: { _all: true },
  })
  expect(porPersona).toHaveLength(101)
  expect(porPersona.every(g => g._count._all === 1)).toBe(true)
})

it('🔴 N8: los avisos repetidos de una persona no tapan a quien ya estaba avisado', async () => {
  const owner = await persona('OWNER')
  const llave = `ATORADOS:${e.venueId}:${hoy()}`
  const fila = (recipientId: string) => ({
    recipientId,
    venueId: e.venueId,
    type: 'ALERT' as const,
    title: 'x',
    message: 'x',
    entityType: 'ShopifyAviso',
    entityId: llave,
  })
  await prisma.notification.createMany({ data: Array.from({ length: 150 }, () => fila(e.staffId)) })
  await prisma.notification.create({ data: fila(owner) })
  await notifyShopify(e.venueId, 'ATORADOS', { count: 1 })
  expect(await prisma.notification.count({ where: { recipientId: owner, entityId: llave } })).toBe(1)
  expect(await prisma.notification.count({ where: { recipientId: e.staffId, entityId: llave } })).toBe(150)
})

it('nunca truena: un negocio que no existe no lanza', async () => {
  await expect(notifyShopify('no-existe', 'ATORADOS')).resolves.toBeUndefined()
})

it('§12.1 CONTEO_NO_APLICADO: uno por producto y por día, con el producto en el texto y en la llave', async () => {
  await notifyShopify(e.venueId, 'CONTEO_NO_APLICADO', { productId: 'prod-1', productName: 'Camisa · M' })
  await notifyShopify(e.venueId, 'CONTEO_NO_APLICADO', { productId: 'prod-1', productName: 'Camisa · M' })
  await notifyShopify(e.venueId, 'CONTEO_NO_APLICADO', { productId: 'prod-2', productName: 'Camisa · L' })
  const lista = await avisos(e.staffId)
  expect(lista.map(n => n.entityId).sort()).toEqual([
    `CONTEO_NO_APLICADO:${e.venueId}:prod-1:${hoy()}`,
    `CONTEO_NO_APLICADO:${e.venueId}:prod-2:${hoy()}`,
  ])
  expect(lista.find(n => n.entityId?.includes(':prod-1:'))).toMatchObject({
    type: 'ALERT',
    priority: 'HIGH',
    message: 'El conteo de Camisa · M no se aplicó: había un cambio en camino a Shopify. Vuelve a contarlo en unos minutos.',
  })
})
