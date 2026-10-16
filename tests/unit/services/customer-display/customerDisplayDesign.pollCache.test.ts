// tests/unit/services/customer-display/customerDisplayDesign.pollCache.test.ts
import { prismaMock } from '@tests/__helpers__/setup'
import { getVenuePlanInfo, venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { PollWorkLimiter, PollWorkSaturated } from '@/services/customer-display/pollWork'
import { readVenuePlanSnapshot, resetVenuePlanSnapshotsForTests } from '@/services/customer-display/venuePlanSnapshot'
import {
  cacheSizeForTests,
  getEffectiveDesign,
  invalidateCustomerDisplayCache,
  peekEffectiveFingerprint,
} from '@/services/customer-display/customerDisplayDesign.service'

jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(async () => true),
  getVenuePlanInfo: jest.fn(async () => ({ tier: 'PRO', grandfathered: false, exempt: false })),
}))
jest.mock('@/services/customer-display/storageOrigins', () => ({
  ...jest.requireActual('@/services/customer-display/storageOrigins'),
  configuredStorageBucket: jest.fn(() => 'bucket-de-prueba.appspot.com'),
}))

const VENUE = 'venue-a'
const TERMINAL = 'terminal-1'
const acceso = venueHasFeatureAccess as jest.Mock
const plan = getVenuePlanInfo as jest.Mock

const terminalRow = (over: Record<string, unknown> = {}) => ({
  id: TERMINAL,
  venueId: VENUE,
  name: 'Caja 1',
  type: 'POS_ANDROID',
  customerDisplayDesignVersion: 2,
  customerDisplayPresent: true,
  customerDisplayInvertible: true,
  displayModeProtocolVersion: 1,
  capabilitiesObservedAt: new Date(),
  customerDisplayInverted: false,
  customerDisplayRequest: null,
  customerDisplayRequestVersion: null,
  customerDisplayAck: null,
  customerDisplayInstallationId: null,
  customerDisplayInstallationSwitches: null,
  lastHeartbeat: new Date(),
  venue: { logo: null, updatedAt: new Date('2026-09-01T00:00:00Z') },
  customerDisplayDesign: null,
  ...over,
})

function diferida<T>() {
  let resolver!: (v: T) => void
  const promesa = new Promise<T>(r => (resolver = r))
  return { promesa, resolver }
}

beforeEach(() => {
  invalidateCustomerDisplayCache(TERMINAL)
  resetVenuePlanSnapshotsForTests()
  acceso.mockClear()
  prismaMock.terminal.findFirst.mockReset().mockResolvedValue(terminalRow() as any)
  prismaMock.customerDisplayAsset.findMany.mockResolvedValue([] as any)
})

describe('cache: true — el camino del poll', () => {
  it('dos pedidos A LA VEZ de la misma ficha: UNA lectura de la terminal, y no queda ningún vuelo', async () => {
    await Promise.all([getEffectiveDesign(VENUE, TERMINAL, { cache: true }), getEffectiveDesign(VENUE, TERMINAL, { cache: true })])
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(1)
    expect(cacheSizeForTests()).toMatchObject({ enVuelo: 0, vuelos: 0 })
  })

  it('🔴 no se une a un cálculo que empezó ANTES de una invalidación', async () => {
    const lenta = diferida<unknown>()
    prismaMock.terminal.findFirst.mockReturnValueOnce(lenta.promesa as any)
    const primera = getEffectiveDesign(VENUE, TERMINAL, { cache: true })
    invalidateCustomerDisplayCache(TERMINAL) // p. ej. se guardó un diseño mientras tanto
    const segunda = getEffectiveDesign(VENUE, TERMINAL, { cache: true })
    lenta.resolver(terminalRow())
    await Promise.all([primera, segunda])
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2)
  })

  it('con el plan en caché y el tope lleno, la terminal no se lee: PollWorkSaturated', async () => {
    await readVenuePlanSnapshot(VENUE) // el plan ya está: lo único que falta es el lugar de la ficha
    await expect(getEffectiveDesign(VENUE, TERMINAL, { cache: true, limiter: new PollWorkLimiter(0) })).rejects.toBeInstanceOf(
      PollWorkSaturated,
    )
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
    expect(cacheSizeForTests()).toMatchObject({ enVuelo: 0, vuelos: 0 }) // no quedó ningún vuelo colgado
  })

  it('🔴 Codex r1 #2: sin lugares anidados — con UN solo lugar y el plan frío, la ficha sale (el plan toma el lugar y lo suelta; después, la terminal)', async () => {
    const limiter = new PollWorkLimiter(1)
    await expect(getEffectiveDesign(VENUE, TERMINAL, { cache: true, limiter })).resolves.toBeDefined()
    expect(limiter.enVuelo).toBe(0)
  })

  it('🔴 Codex r1 #2: el lugar de la ficha sigue ocupado mientras su lectura de la terminal no termina', async () => {
    await readVenuePlanSnapshot(VENUE)
    const lenta = diferida<unknown>()
    prismaMock.terminal.findFirst.mockReturnValueOnce(lenta.promesa as any)
    const limiter = new PollWorkLimiter(1)
    const ficha = getEffectiveDesign(VENUE, TERMINAL, { cache: true, limiter })
    await new Promise(r => setImmediate(r))
    expect(limiter.enVuelo).toBe(1)
    lenta.resolver(terminalRow())
    await ficha
    expect(limiter.enVuelo).toBe(0)
  })

  it('usa el plan cacheado: dos terminales del mismo venue consultan el plan UNA vez', async () => {
    prismaMock.terminal.findFirst.mockResolvedValueOnce(terminalRow() as any).mockResolvedValueOnce(terminalRow({ id: 't2' }) as any)
    await getEffectiveDesign(VENUE, TERMINAL, { cache: true })
    await getEffectiveDesign(VENUE, 't2', { cache: true })
    expect(acceso).toHaveBeenCalledTimes(2) // dos códigos, una sola vez
  })

  // Sabotaje «la terminal antes que el plan»: con el plan caído, una lectura de la terminal sería trabajo tirado.
  it('el plan va PRIMERO: si el plan truena, la terminal ni se lee; y el error no se guarda', async () => {
    plan.mockRejectedValueOnce(new Error('base caída'))
    await expect(getEffectiveDesign(VENUE, TERMINAL, { cache: true })).rejects.toThrow('base caída')
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
    expect(cacheSizeForTests()).toMatchObject({ enVuelo: 0, vuelos: 0 })
    expect(peekEffectiveFingerprint(VENUE, TERMINAL)).toBeUndefined()
    await getEffectiveDesign(VENUE, TERMINAL, { cache: true }) // el siguiente poll vuelve a calcular
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(1)
  })

  it('la entrada vence con el plan con que se armó (DD4): nunca 60 s DESPUÉS de un plan de hace 50', async () => {
    const reloj = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      await getEffectiveDesign(VENUE, 'otra', { cache: true }) // el plan se calcula en t0
      reloj.mockReturnValue(1_050_000)
      await getEffectiveDesign(VENUE, TERMINAL, { cache: true }) // la ficha se arma en t0+50 s con ese plan
      reloj.mockReturnValue(1_060_001)
      expect(peekEffectiveFingerprint(VENUE, TERMINAL)).toBeUndefined()
    } finally {
      reloj.mockRestore()
    }
  })

  it('peekEffectiveFingerprint: nada si no hay; la huella si la hay; nunca calcula', async () => {
    expect(peekEffectiveFingerprint(VENUE, TERMINAL)).toBeUndefined()
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
    const { ficha } = await getEffectiveDesign(VENUE, TERMINAL, { cache: true })
    expect(peekEffectiveFingerprint(VENUE, TERMINAL)).toBe(ficha.fingerprint)
    expect(peekEffectiveFingerprint('otro-venue', TERMINAL)).toBeUndefined() // la llave lleva el venue
  })
})

describe("cache: 'refresh' — la ficha móvil, el ack y /settings", () => {
  it('siempre calcula, y deja lo calculado para el poll', async () => {
    await getEffectiveDesign(VENUE, TERMINAL, { cache: 'refresh' })
    await getEffectiveDesign(VENUE, TERMINAL, { cache: 'refresh' })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2)
    await getEffectiveDesign(VENUE, TERMINAL, { cache: true })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2) // el poll ya no vuelve a la base
  })

  it('🔴 un cálculo VIEJO del poll que termina después no pisa lo que dejó el refresco', async () => {
    const lenta = diferida<unknown>()
    prismaMock.terminal.findFirst
      .mockReturnValueOnce(lenta.promesa as any)
      .mockResolvedValueOnce(terminalRow({ customerDisplayDesign: disenoCon({ welcomeText: 'Nuevo' }) }) as any)
    const delPoll = getEffectiveDesign(VENUE, TERMINAL, { cache: true })
    // El plan va primero: se espera a que el poll YA esté leyendo la terminal (la lenta) antes de refrescar.
    await new Promise(r => setImmediate(r))
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(1)
    const fresca = await getEffectiveDesign(VENUE, TERMINAL, { cache: 'refresh' })
    lenta.resolver(terminalRow({ customerDisplayDesign: disenoCon({ welcomeText: 'Viejo' }) }))
    await delPoll
    expect(peekEffectiveFingerprint(VENUE, TERMINAL)).toBe(fresca.ficha.fingerprint)
  })

  it('no respeta el tope: lo pide una persona (o su aparato), no el trabajo de fondo', async () => {
    await expect(getEffectiveDesign(VENUE, TERMINAL, { cache: 'refresh', limiter: new PollWorkLimiter(0) })).resolves.toBeDefined()
  })
})

describe('cache: false — el dashboard, igual que F0-A', () => {
  it('siempre fresco (plan incluido), sin tope, y no toca lo que el poll dejó guardado', async () => {
    await getEffectiveDesign(VENUE, TERMINAL, { cache: true }) // el poll deja ficha y plan guardados
    const delPoll = peekEffectiveFingerprint(VENUE, TERMINAL)
    acceso.mockClear()
    prismaMock.terminal.findFirst
      .mockReset()
      .mockResolvedValue(terminalRow({ customerDisplayDesign: disenoCon({ welcomeText: 'Recién guardado' }) }) as any)

    const a = await getEffectiveDesign(VENUE, TERMINAL)
    const b = await getEffectiveDesign(VENUE, TERMINAL, { cache: false, limiter: new PollWorkLimiter(0) })

    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2) // nunca de la caché
    expect(acceso).toHaveBeenCalledTimes(4) // el plan, fresco cada vez
    expect(a.ficha.welcomeText).toBe('Recién guardado')
    expect(b.ficha.welcomeText).toBe('Recién guardado')
    expect(peekEffectiveFingerprint(VENUE, TERMINAL)).toBe(delPoll) // ni lo pisó ni lo invalidó
    expect(cacheSizeForTests()).toMatchObject({ enVuelo: 0, vuelos: 0 })
  })
})

function disenoCon(over: Record<string, unknown>) {
  return {
    id: 'd1',
    terminalId: TERMINAL,
    revision: 1,
    updatedById: null,
    theme: 'LIGHT',
    accentColor: null,
    logoAssetId: null,
    welcomeText: null,
    thanksText: null,
    slides: [],
    slideSeconds: 8,
    showPromotions: false,
    schemaVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }
}
