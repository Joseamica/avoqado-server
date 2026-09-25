/**
 * Etapa 1 de la pantalla de cocina (spec 2026-09-24 §4): una venta de la caja sólo guarda comanda KDS
 * si el negocio tiene al menos una estación ACTIVA con pantalla. La hoja impresa no depende de esto.
 */
import prisma from '@/utils/prismaClient'
import { createKdsOrder, venueTienePantallaDeCocina } from '@/services/mobile/kds.mobile.service'
import { BadRequestError } from '@/errors/AppError'

const suffix = `kdspantalla-${Date.now()}`
let orgId: string
let venueSin: string
let venueCon: string
let venueApagada: string

const venta = { orderNumber: 'A1', orderType: 'DINE_IN', items: [{ productName: 'Café', quantity: 1 }] }

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `KDS Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  const venue = async (n: string) =>
    (await prisma.venue.create({ data: { organizationId: orgId, name: `${n}-${suffix}`, slug: `${n}-${suffix}` } })).id
  venueSin = await venue('kds-sin')
  venueCon = await venue('kds-con')
  venueApagada = await venue('kds-apagada')
  // Sin pantalla: una estación normal de impresora.
  await prisma.printStation.create({ data: { venueId: venueSin, name: 'Cocina' } })
  // Con pantalla activa.
  await prisma.printStation.create({ data: { venueId: venueCon, name: 'Cocina', hasKitchenDisplay: true } })
  // Con pantalla pero la estación está apagada.
  await prisma.printStation.create({ data: { venueId: venueApagada, name: 'Cocina', hasKitchenDisplay: true, active: false } })
})

afterAll(async () => {
  if (!orgId) return
  const venues = [venueSin, venueCon, venueApagada].filter(Boolean)
  await prisma.kdsOrder.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.printStation.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('createKdsOrder — sólo con pantalla de cocina', () => {
  it('sin estación con pantalla: no crea nada y devuelve null', async () => {
    await expect(createKdsOrder(venueSin, venta)).resolves.toBeNull()
    expect(await prisma.kdsOrder.count({ where: { venueId: venueSin } })).toBe(0)
  })

  it('con estación activa con pantalla: crea la comanda como hoy', async () => {
    const creada = await createKdsOrder(venueCon, venta)
    expect(creada).not.toBeNull()
    expect(creada!.orderNumber).toBe('A1')
    expect(await prisma.kdsOrder.count({ where: { venueId: venueCon } })).toBe(1)
  })

  it('estación con pantalla pero APAGADA: no crea', async () => {
    await expect(createKdsOrder(venueApagada, venta)).resolves.toBeNull()
    expect(await prisma.kdsOrder.count({ where: { venueId: venueApagada } })).toBe(0)
  })

  it('un POST inválido sigue siendo 400 aunque no haya pantalla (no se vuelve un 200 silencioso)', async () => {
    await expect(createKdsOrder(venueSin, { ...venta, items: [] })).rejects.toBeInstanceOf(BadRequestError)
    await expect(createKdsOrder(venueSin, { ...venta, orderNumber: '' })).rejects.toBeInstanceOf(BadRequestError)
  })

  it('venueTienePantallaDeCocina refleja las tres situaciones', async () => {
    expect(await venueTienePantallaDeCocina(venueSin)).toBe(false)
    expect(await venueTienePantallaDeCocina(venueCon)).toBe(true)
    expect(await venueTienePantallaDeCocina(venueApagada)).toBe(false)
  })
})
