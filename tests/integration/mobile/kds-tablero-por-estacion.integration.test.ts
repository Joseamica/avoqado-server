/**
 * Etapa 3 del KDS (spec 2026-09-27 §3): cada pantalla ve sólo lo suyo y lo «Sin estación»; nadie ve lo anterior a
 * prender la pantalla (salvo Uber) ni lo que salió en papel. Con «Recientes» se deshace un LISTO por error.
 */
import prisma from '@/utils/prismaClient'
import {
  bumpKdsOrdersBatch,
  countKdsOrders,
  listKdsOrders,
  listRecentKdsOrders,
  recallKdsOrder,
} from '@/services/mobile/kds.mobile.service'
import { NotFoundError } from '@/errors/AppError'

const SUF = `kdstablero-${Date.now()}`
const haceUnaHora = new Date(Date.now() - 60 * 60 * 1000)
const haceDos = new Date(Date.now() - 2 * 60 * 60 * 1000)
let orgId: string
let venueId: string
let cocina: string
let barra: string
const ids: Record<string, string> = {}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Tablero ${SUF}`, email: `${SUF}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V ${SUF}`, slug: `v-${SUF}` } })).id
  cocina = (
    await prisma.printStation.create({ data: { venueId, name: 'Cocina', hasKitchenDisplay: true, kitchenDisplaySince: haceUnaHora } })
  ).id
  barra = (
    await prisma.printStation.create({ data: { venueId, name: 'Barra', hasKitchenDisplay: true, kitchenDisplaySince: haceUnaHora } })
  ).id
  const k = async (nombre: string, data: Record<string, unknown>) => {
    ids[nombre] = (
      await prisma.kdsOrder.create({
        data: { venueId, orderNumber: nombre, orderType: 'DINE_IN', items: { create: [{ productName: nombre, quantity: 1 }] }, ...data },
      })
    ).id
  }
  await k('cocina', { printStationId: cocina, sourceKey: `sale:${SUF}:${cocina}` })
  await k('barra', { printStationId: barra })
  await k('sinEstacion', {})
  await k('viejo', { printStationId: cocina, createdAt: haceDos })
  await k('enPapel', { printStationId: cocina, fallbackPrintedAt: new Date() })
  await k('uber', { orderType: 'DELIVERY', createdAt: haceDos })
})

afterAll(async () => {
  if (!orgId) return
  await prisma.kdsOrder.deleteMany({ where: { venueId } })
  await prisma.printStation.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

const nombres = (xs: Array<{ orderNumber: string }>) => xs.map(x => x.orderNumber).sort()

describe('tablero por estación', () => {
  it('la pantalla de Cocina ve lo suyo, «Sin estación» y Uber; no Barra, ni lo viejo, ni lo impreso', async () => {
    const tablero = await listKdsOrders(venueId, undefined, cocina)
    expect(nombres(tablero)).toEqual(['cocina', 'sinEstacion', 'uber'])
    expect(await countKdsOrders(venueId, undefined, cocina)).toBe(3)
    // El folio y la estación viajan en la respuesta: la pantalla junta por folio lo que le llegó por WiFi (spec §6).
    expect(tablero.find(o => o.orderNumber === 'cocina')).toMatchObject({
      sourceKey: `sale:${SUF}:${cocina}`,
      printStationId: cocina,
      fallbackPrintedAt: null,
    })
  })

  it('una pantalla vieja (sin estación) ve todo lo vigente, nunca lo viejo ni lo impreso', async () => {
    expect(nombres(await listKdsOrders(venueId))).toEqual(['barra', 'cocina', 'sinEstacion', 'uber'])
    expect(await countKdsOrders(venueId)).toBe(4)
  })

  it('marcar en lote, verlo en Recientes y deshacerlo', async () => {
    expect(await bumpKdsOrdersBatch(venueId, [ids.cocina, ids.barra, ids.barra])).toEqual({ completed: 2 })
    expect(nombres(await listRecentKdsOrders(venueId, cocina))).toEqual(['cocina'])
    const regresada = await recallKdsOrder(venueId, ids.cocina)
    expect(regresada.status).toBe('NEW')
    expect(regresada.completedAt).toBeNull()
    await expect(recallKdsOrder(venueId, ids.cocina)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('estación sin pantalla (revisión final I-3)', () => {
  let apagada: string
  beforeAll(async () => {
    // La pantalla se acaba de APAGAR: `kitchenDisplaySince` se conserva.
    apagada = (
      await prisma.printStation.create({ data: { venueId, name: 'Postres', hasKitchenDisplay: false, kitchenDisplaySince: haceUnaHora } })
    ).id
    const item = { create: [{ productName: 'x', quantity: 1 }] }
    await prisma.kdsOrder.create({
      data: { venueId, orderNumber: 'sinEstacionVieja', orderType: 'DINE_IN', createdAt: haceDos, items: item },
    })
    await prisma.kdsOrder.create({
      data: { venueId, orderNumber: 'deApagada', orderType: 'DINE_IN', printStationId: apagada, items: item },
    })
  })

  it('pedir con la estación de la pantalla recién apagada no trae lo anterior a su cuenta nueva', async () => {
    const tablero = nombres(await listKdsOrders(venueId, undefined, apagada))
    expect(tablero).not.toContain('sinEstacionVieja')
    expect(tablero).toContain('deApagada')
  })

  it('la comanda de una estación que se quedó sin pantalla sale en las pantallas de las otras estaciones', async () => {
    expect(nombres(await listKdsOrders(venueId, undefined, cocina))).toContain('deApagada')
    expect(nombres(await listKdsOrders(venueId, undefined, barra))).toContain('deApagada')
  })

  it('una estación que no existe o de otro negocio no ve nada', async () => {
    const otroVenue = (await prisma.venue.create({ data: { organizationId: orgId, name: `V2 ${SUF}`, slug: `v2-${SUF}` } })).id
    const ajena = (
      await prisma.printStation.create({
        data: { venueId: otroVenue, name: 'Ajena', hasKitchenDisplay: true, kitchenDisplaySince: haceUnaHora },
      })
    ).id
    try {
      for (const stationId of ['no-existe', ajena]) {
        expect(await listKdsOrders(venueId, undefined, stationId)).toEqual([])
        expect(await countKdsOrders(venueId, undefined, stationId)).toBe(0)
        expect(await listRecentKdsOrders(venueId, stationId)).toEqual([])
      }
    } finally {
      await prisma.printStation.deleteMany({ where: { venueId: otroVenue } })
      await prisma.venue.deleteMany({ where: { id: otroVenue } })
    }
  })
})
