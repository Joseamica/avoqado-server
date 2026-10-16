// tests/unit/services/customer-display/venuePlanSnapshot.test.ts
import { getVenuePlanInfo, venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { PollWorkLimiter, PollWorkSaturated } from '@/services/customer-display/pollWork'
import {
  entitlementsFrom,
  peekVenuePlanSnapshot,
  planFingerprintPart,
  readVenuePlanSnapshot,
  resetVenuePlanSnapshotsForTests,
} from '@/services/customer-display/venuePlanSnapshot'
import { readEntitlements } from '@/services/customer-display/customerDisplayDesign.service'

jest.mock('@/services/access/basePlan.service', () => ({
  getVenuePlanInfo: jest.fn(),
  venueHasFeatureAccess: jest.fn(),
}))

const plan = getVenuePlanInfo as jest.Mock
const acceso = venueHasFeatureAccess as jest.Mock

beforeEach(() => {
  resetVenuePlanSnapshotsForTests()
  plan.mockReset().mockResolvedValue({ tier: 'PRO', grandfathered: false, exempt: false })
  acceso.mockReset().mockImplementation(async (_v: string, code: string) => code === 'CUSTOMER_DISPLAY_PROMOS' || code === 'PROMOTIONS')
})

describe('entitlementsFrom — LA regla de las tarjetas', () => {
  it.each([
    [
      { CUSTOMER_DISPLAY_PROMOS: true, PROMOTIONS: true },
      { slides: true, promotionCards: true },
    ],
    [
      { CUSTOMER_DISPLAY_PROMOS: true, PROMOTIONS: false },
      { slides: true, promotionCards: false },
    ],
    [
      { CUSTOMER_DISPLAY_PROMOS: false, PROMOTIONS: true },
      { slides: false, promotionCards: false },
    ],
  ])('%j → %j', (grants, esperado) => {
    expect(entitlementsFrom(grants)).toEqual(esperado)
  })

  it('readEntitlements (dashboard, subida, guardar) contesta con LA MISMA regla', async () => {
    acceso.mockImplementation(async (_v: string, code: string) => code === 'CUSTOMER_DISPLAY_PROMOS')
    expect(await readEntitlements('venue-a')).toEqual({ slides: true, promotionCards: false })
  })
})

describe('readVenuePlanSnapshot', () => {
  it('un solo cálculo por venue aunque lo pidan diez a la vez — y pide la espera completa (Codex r3 N2: sólo el poll)', async () => {
    await Promise.all(Array.from({ length: 10 }, () => readVenuePlanSnapshot('venue-a')))
    expect(plan).toHaveBeenCalledTimes(1)
    expect(plan).toHaveBeenCalledWith('venue-a', { esperarTodasLasRamas: true })
    expect(acceso).toHaveBeenCalledTimes(2) // dos códigos, una vez cada uno
  })

  it('dentro de 60 s no vuelve a la base; pasados, sí', async () => {
    const reloj = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      await readVenuePlanSnapshot('venue-a')
      reloj.mockReturnValue(1_059_999)
      await readVenuePlanSnapshot('venue-a')
      expect(plan).toHaveBeenCalledTimes(1)
      reloj.mockReturnValue(1_060_001)
      await readVenuePlanSnapshot('venue-a')
      expect(plan).toHaveBeenCalledTimes(2)
    } finally {
      reloj.mockRestore()
    }
  })

  it('un error no se guarda', async () => {
    plan.mockRejectedValueOnce(new Error('base caída'))
    await expect(readVenuePlanSnapshot('venue-a')).rejects.toThrow('base caída')
    expect(peekVenuePlanSnapshot('venue-a')).toBeUndefined()
    await expect(readVenuePlanSnapshot('venue-a')).resolves.toMatchObject({ planInfo: { tier: 'PRO' } })
  })

  it('saturado: no consulta nada', async () => {
    await expect(readVenuePlanSnapshot('venue-a', { limiter: new PollWorkLimiter(0) })).rejects.toBeInstanceOf(PollWorkSaturated)
    expect(plan).not.toHaveBeenCalled()
  })

  it('peek no calcula', () => {
    expect(peekVenuePlanSnapshot('venue-a')).toBeUndefined()
    expect(plan).not.toHaveBeenCalled()
  })

  it('🔴 si una lectura del plan falla PRIMERO, su lugar sigue ocupado hasta que las otras terminan (Codex r1 #2)', async () => {
    let soltarGrant!: (v: boolean) => void
    plan.mockRejectedValueOnce(new Error('base caída'))
    acceso.mockReturnValueOnce(new Promise<boolean>(r => (soltarGrant = r))).mockResolvedValueOnce(true)
    const limiter = new PollWorkLimiter(1)
    let asentada = false
    const lectura = readVenuePlanSnapshot('venue-a', { limiter }).catch(e => ((asentada = true), e))
    await new Promise(r => setImmediate(r))
    expect(asentada).toBe(false)
    expect(limiter.enVuelo).toBe(1) // el grant sigue en la base: el lugar no se suelta
    soltarGrant(true)
    expect(await lectura).toEqual(new Error('base caída'))
    expect(limiter.enVuelo).toBe(0)
  })

  it('sin PROMOTIONS, las tarjetas quedan fuera aunque el código nuevo esté', async () => {
    acceso.mockImplementation(async (_v: string, code: string) => code === 'CUSTOMER_DISPLAY_PROMOS')
    const s = await readVenuePlanSnapshot('venue-a')
    expect(s.grants).toEqual({ CUSTOMER_DISPLAY_PROMOS: true, PROMOTIONS: false })
    expect(s.entitlements).toEqual({ slides: true, promotionCards: false })
  })
})

describe('planFingerprintPart — la parte ESTABLE del plan (R2)', () => {
  it('sólo lo que decide lo que ve o permite el aparato, con los códigos ordenados', async () => {
    plan.mockResolvedValue({
      tier: 'PRO',
      grandfathered: false,
      exempt: false,
      grantedFeatureCodes: ['TABLE_SERVICE', 'CHATBOT'],
      accessSchemaVersion: 1,
      accessObservedAt: '2026-10-15T18:00:00.000Z',
      commercialPlanTier: null,
    })
    const s = await readVenuePlanSnapshot('venue-a')
    expect(planFingerprintPart(s)).toEqual({
      tier: 'PRO',
      grandfathered: false,
      exempt: false,
      grantedFeatureCodes: ['CHATBOT', 'TABLE_SERVICE'],
      accessSchemaVersion: 1,
      commercialPlanTier: null,
      grants: { CUSTOMER_DISPLAY_PROMOS: true, PROMOTIONS: true },
    })
  })

  // 🔴 Review Focus 1: la hora de observación cambia en CADA llamada; si entrara, la tablet refrescaría en cada poll.
  it('la parte del plan ignora la hora de observación y ve los códigos', () => {
    const base = {
      planInfo: {
        tier: 'PRO' as const,
        grandfathered: false,
        exempt: false,
        grantedFeatureCodes: ['CHATBOT', 'TABLE_SERVICE'],
        accessSchemaVersion: 1 as const,
        accessObservedAt: '2026-10-15T18:00:00.000Z',
        commercialPlanTier: null,
      },
      grants: { CUSTOMER_DISPLAY_PROMOS: true, PROMOTIONS: true },
      entitlements: { slides: true, promotionCards: true },
      calculadoEn: 0,
    }
    const otraHora = { ...base, planInfo: { ...base.planInfo, accessObservedAt: '2026-10-15T18:00:01.000Z' } }
    const otroOrden = { ...base, planInfo: { ...base.planInfo, grantedFeatureCodes: ['TABLE_SERVICE', 'CHATBOT'] } }
    const conCodigoNuevo = { ...base, planInfo: { ...base.planInfo, grantedFeatureCodes: ['CHATBOT', 'RESERVATIONS', 'TABLE_SERVICE'] } }
    expect(planFingerprintPart(otraHora)).toEqual(planFingerprintPart(base))
    expect(planFingerprintPart(otroOrden)).toEqual(planFingerprintPart(base))
    expect(planFingerprintPart(conCodigoNuevo)).not.toEqual(planFingerprintPart(base))
  })

  it('un plan sin los campos nuevos (doble viejo, o servidor a medio desplegar) no truena', async () => {
    const s = await readVenuePlanSnapshot('venue-a') // el doble del beforeEach sólo trae tier/grandfathered/exempt
    expect(planFingerprintPart(s)).toMatchObject({ grantedFeatureCodes: [], accessSchemaVersion: null, commercialPlanTier: null })
  })
})
