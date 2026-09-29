/**
 * Casilla «Se atiende con pantalla de cocina» por estación (spec 2026-09-24 §4, etapa 1).
 */
jest.mock('@/mcp/scope', () => ({ isActiveSuperAdmin: jest.fn(async (id: string) => id === 'super-1') }))
import prisma from '@/utils/prismaClient'
import { setKitchenDisplay } from '@/services/dashboard/printStation.dashboard.service'
import { ForbiddenError, NotFoundError } from '@/errors/AppError'

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
    expect((await setKitchenDisplay(venueA, estacionA, true, 'super-1')).hasKitchenDisplay).toBe(true)
    expect((await prisma.printStation.findUniqueOrThrow({ where: { id: estacionA } })).hasKitchenDisplay).toBe(true)
    expect((await setKitchenDisplay(venueA, estacionA, false)).hasKitchenDisplay).toBe(false)
  })

  it('una estación de OTRO negocio responde 404 y no cambia', async () => {
    await expect(setKitchenDisplay(venueA, estacionB, true)).rejects.toBeInstanceOf(NotFoundError)
    expect((await prisma.printStation.findUniqueOrThrow({ where: { id: estacionB } })).hasKitchenDisplay).toBe(false)
  })

  it('no toca los demás campos de la estación', async () => {
    const antes = await prisma.printStation.findUniqueOrThrow({ where: { id: estacionA } })
    await setKitchenDisplay(venueA, estacionA, true, 'super-1')
    const despues = await prisma.printStation.findUniqueOrThrow({ where: { id: estacionA } })
    const sinLoQueCambia = (s: typeof antes) => ({ ...s, hasKitchenDisplay: false, kitchenDisplaySince: null, updatedAt: null })
    expect(sinLoQueCambia(despues)).toEqual(sinLoQueCambia(antes))
  })
})

describe('etapa 3 — antes del lanzamiento sólo Avoqado prende; la cuenta nueva se sella al prender', () => {
  it('un dueño no puede PRENDER: KITCHEN_DISPLAY_NOT_RELEASED y nada cambia', async () => {
    await prisma.printStation.update({ where: { id: estacionA }, data: { hasKitchenDisplay: false } })
    const error: any = await setKitchenDisplay(venueA, estacionA, true, 'dueno-1').catch(e => e)
    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error.errorCode ?? error.code).toBe('KITCHEN_DISPLAY_NOT_RELEASED')
    expect((await prisma.printStation.findUniqueOrThrow({ where: { id: estacionA } })).hasKitchenDisplay).toBe(false)
  })

  it('Avoqado prende (sella la cuenta nueva), cualquiera apaga, y re-prender sella una fecha nueva', async () => {
    await setKitchenDisplay(venueA, estacionA, true, 'super-1')
    const primera = (await prisma.printStation.findUniqueOrThrow({ where: { id: estacionA } })).kitchenDisplaySince!
    expect(primera).toBeInstanceOf(Date)
    await setKitchenDisplay(venueA, estacionA, false, 'dueno-1')
    expect((await prisma.printStation.findUniqueOrThrow({ where: { id: estacionA } })).kitchenDisplaySince).toEqual(primera)
    await new Promise(r => setTimeout(r, 5))
    await setKitchenDisplay(venueA, estacionA, true, 'super-1')
    const segunda = (await prisma.printStation.findUniqueOrThrow({ where: { id: estacionA } })).kitchenDisplaySince!
    expect(segunda.getTime()).toBeGreaterThan(primera.getTime())
  })
})
