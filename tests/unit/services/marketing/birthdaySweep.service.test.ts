/**
 * El barrido del cumpleaños. Lo que estas pruebas fijan es, sobre todo, lo que NO debe
 * pasar: felicitar el día equivocado, felicitar dos veces, o seguir felicitando cuando el
 * negocio ya no paga.
 */
import { BirthdayAutomationStatus } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    birthdayAutomation: { findMany: jest.fn(), updateMany: jest.fn() },
    customerCampaignDelivery: { createMany: jest.fn() },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
  },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { barrerCumpleanos, hoyEnElVenue, claveDeDedupe } from '@/services/marketing/birthdaySweep.service'

const automationFindMany = (prisma as any).birthdayAutomation.findMany as jest.Mock
const automationUpdateMany = (prisma as any).birthdayAutomation.updateMany as jest.Mock
const deliveryCreateMany = (prisma as any).customerCampaignDelivery.createMany as jest.Mock
const txMock = (prisma as any).$transaction as jest.Mock
const execRaw = (prisma as any).$executeRaw as jest.Mock
const queryRaw = (prisma as any).$queryRaw as jest.Mock
const tieneFeature = venueHasFeatureAccess as jest.Mock

/** El cliente de transacción que ve el servicio: los mismos mocks. */
const tx = {
  $executeRaw: execRaw,
  $queryRaw: queryRaw,
  birthdayAutomation: { updateMany: automationUpdateMany },
  customerCampaignDelivery: { createMany: deliveryCreateMany },
}

const auto = (over: Record<string, unknown> = {}) => ({
  id: 'auto_1',
  venueId: 'venue_1',
  daysBefore: 7,
  lastEvaluatedLocalDate: '2026-07-09',
  venue: { timezone: 'America/Mexico_City', status: 'ACTIVE' },
  ...over,
})

// 10 de julio de 2026, 15:00 UTC → 09:00 en Ciudad de México.
const AHORA = new Date('2026-07-10T15:00:00Z')

beforeEach(() => {
  jest.clearAllMocks()
  txMock.mockImplementation(async (fn: any) => fn(tx))
  execRaw.mockResolvedValue(1)
  queryRaw.mockResolvedValue([])
  deliveryCreateMany.mockResolvedValue({ count: 0 })
  automationUpdateMany.mockResolvedValue({ count: 1 })
  tieneFeature.mockResolvedValue(true)
})

describe('hoyEnElVenue', () => {
  it('usa la zona del VENUE, no la del servidor', () => {
    // El mismo instante es un día distinto en Ciudad de México que en Tokio.
    expect(hoyEnElVenue('America/Mexico_City', new Date('2026-07-11T03:00:00Z'))).toBe('2026-07-10')
    expect(hoyEnElVenue('Asia/Tokyo', new Date('2026-07-11T03:00:00Z'))).toBe('2026-07-11')
  })

  it('🔴 sin zona o con zona inválida devuelve null: NO adivina', () => {
    // Caer a México en silencio felicitaría el día equivocado en Tijuana o Cancún, y el
    // correo saldría igual — sólo que el día que no era.
    expect(hoyEnElVenue(null, AHORA)).toBeNull()
    expect(hoyEnElVenue('', AHORA)).toBeNull()
    expect(hoyEnElVenue('Marte/Olympus', AHORA)).toBeNull()
  })
})

describe('claveDeDedupe', () => {
  it('lleva el año del ANIVERSARIO, no el año en curso', () => {
    // Una felicitación adelantada el 28-dic-2026 para un cumpleaños del 4-ene-2027
    // pertenece a 2027. Con el año en curso se duplicaría al cruzar el 31 de diciembre.
    expect(claveDeDedupe('auto_1', 'cus_1', 2027)).toBe('birthday:auto_1:cus_1:2027')
  })
})

describe('barrerCumpleanos', () => {
  it('sólo mira las automatizaciones ACTIVE', async () => {
    automationFindMany.mockResolvedValue([])
    await barrerCumpleanos(AHORA)
    expect(automationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: BirthdayAutomationStatus.ACTIVE } }),
    )
  })

  it('🔴 revalida el PLAN en cada barrido: sin él no encola nada', async () => {
    automationFindMany.mockResolvedValue([auto()])
    tieneFeature.mockResolvedValue(false)

    const r = await barrerCumpleanos(AHORA)

    expect(deliveryCreateMany).not.toHaveBeenCalled()
    expect(r.saltados[0].motivo).toMatch(/plan/)
  })

  it('🔴 un venue sin zona horaria utilizable se SALTA, no se felicita a ciegas', async () => {
    automationFindMany.mockResolvedValue([auto({ venue: { timezone: null, status: 'ACTIVE' } })])

    const r = await barrerCumpleanos(AHORA)

    expect(deliveryCreateMany).not.toHaveBeenCalled()
    expect(r.saltados[0].motivo).toMatch(/zona horaria/)
  })

  it('un venue que no está ACTIVE se salta', async () => {
    automationFindMany.mockResolvedValue([auto({ venue: { timezone: 'America/Mexico_City', status: 'SUSPENDED' } })])

    const r = await barrerCumpleanos(AHORA)

    expect(deliveryCreateMany).not.toHaveBeenCalled()
    expect(r.saltados[0].motivo).toMatch(/ACTIVE/)
  })

  it('toma el advisory lock del venue ANTES de encolar', async () => {
    automationFindMany.mockResolvedValue([auto()])
    queryRaw.mockResolvedValue([{ id: 'cus_1', birthDate: new Date('1990-07-17') }])
    deliveryCreateMany.mockResolvedValue({ count: 1 })

    await barrerCumpleanos(AHORA)

    // Sin el lock, dos workers evalúan la misma fecha del mismo negocio a la vez.
    const sql = execRaw.mock.calls[0]?.[0]
    expect(JSON.stringify(sql)).toContain('pg_advisory_xact_lock')
  })

  it('encola con el dedupeKey del aniversario y con skipDuplicates', async () => {
    automationFindMany.mockResolvedValue([auto()])
    queryRaw.mockResolvedValue([{ id: 'cus_1', birthDate: new Date('1990-07-17') }])
    deliveryCreateMany.mockResolvedValue({ count: 1 })

    const r = await barrerCumpleanos(AHORA)

    const args = deliveryCreateMany.mock.calls[0][0]
    // 🔴 skipDuplicates sobre el unique de dedupeKey es lo que hace el barrido idempotente:
    // repetirlo el mismo día no vuelve a felicitar a nadie.
    expect(args.skipDuplicates).toBe(true)
    expect(args.data[0]).toMatchObject({
      automationId: 'auto_1',
      customerId: 'cus_1',
      venueId: 'venue_1',
      dedupeKey: 'birthday:auto_1:cus_1:2026',
    })
    expect(r.encoladas).toBe(1)
  })

  it('🔴 avanza el cursor con CAS: exige que nadie lo haya movido', async () => {
    automationFindMany.mockResolvedValue([auto()])

    await barrerCumpleanos(AHORA)

    // El `where` lleva el valor ANTERIOR. Sin eso, dos barridos solapados se pisan el
    // cursor y una fecha se evalúa dos veces o ninguna.
    expect(automationUpdateMany).toHaveBeenCalledWith({
      where: { id: 'auto_1', lastEvaluatedLocalDate: '2026-07-09' },
      data: { lastEvaluatedLocalDate: '2026-07-10' },
    })
  })

  it('un venue que revienta no deja sin felicitación a los demás', async () => {
    automationFindMany.mockResolvedValue([auto({ id: 'a1', venueId: 'v1' }), auto({ id: 'a2', venueId: 'v2' })])
    txMock.mockImplementationOnce(async () => {
      throw new Error('se cayó la base')
    })
    txMock.mockImplementation(async (fn: any) => fn(tx))

    const r = await barrerCumpleanos(AHORA)

    expect(r.saltados).toHaveLength(1)
    expect(r.saltados[0]).toMatchObject({ venueId: 'v1' })
    expect(r.automatizacionesRevisadas).toBe(2)
  })

  it('sin fechas pendientes no abre transacción siquiera', async () => {
    automationFindMany.mockResolvedValue([auto({ lastEvaluatedLocalDate: '2026-07-10' })])

    await barrerCumpleanos(AHORA)

    expect(txMock).not.toHaveBeenCalled()
  })
})
