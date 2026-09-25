/**
 * Casilla «Se atiende con pantalla de cocina» por estación (spec 2026-09-24 §4, etapa 1).
 */
import prisma from '@/utils/prismaClient'
import { setKitchenDisplay } from '@/services/dashboard/printStation.dashboard.service'
import { NotFoundError } from '@/errors/AppError'

const suffix = `kdscasilla-${Date.now()}`
let orgId: string
let venueA: string
let venueB: string
let estacionA: string
let estacionB: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `KDS casilla ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueA = (await prisma.venue.create({ data: { organizationId: orgId, name: `a-${suffix}`, slug: `a-${suffix}` } })).id
  venueB = (await prisma.venue.create({ data: { organizationId: orgId, name: `b-${suffix}`, slug: `b-${suffix}` } })).id
  estacionA = (await prisma.printStation.create({ data: { venueId: venueA, name: 'Cocina' } })).id
  estacionB = (await prisma.printStation.create({ data: { venueId: venueB, name: 'Cocina' } })).id
})

afterAll(async () => {
  if (!orgId) return
  const venues = [venueA, venueB].filter(Boolean)
  await prisma.activityLog.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.printStation.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('setKitchenDisplay', () => {
  it('prende y apaga la casilla de una estación del venue', async () => {
    expect((await setKitchenDisplay(venueA, estacionA, true)).hasKitchenDisplay).toBe(true)
    expect((await prisma.printStation.findUniqueOrThrow({ where: { id: estacionA } })).hasKitchenDisplay).toBe(true)
    expect((await setKitchenDisplay(venueA, estacionA, false)).hasKitchenDisplay).toBe(false)
  })

  it('una estación de OTRO negocio responde 404 y no cambia', async () => {
    await expect(setKitchenDisplay(venueA, estacionB, true)).rejects.toBeInstanceOf(NotFoundError)
    expect((await prisma.printStation.findUniqueOrThrow({ where: { id: estacionB } })).hasKitchenDisplay).toBe(false)
  })

  it('no toca los demás campos de la estación', async () => {
    const antes = await prisma.printStation.findUniqueOrThrow({ where: { id: estacionA } })
    await setKitchenDisplay(venueA, estacionA, true)
    const despues = await prisma.printStation.findUniqueOrThrow({ where: { id: estacionA } })
    expect({ ...despues, hasKitchenDisplay: false, updatedAt: null }).toEqual({ ...antes, hasKitchenDisplay: false, updatedAt: null })
  })
})
