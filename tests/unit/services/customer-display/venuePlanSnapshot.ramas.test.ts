// tests/unit/services/customer-display/venuePlanSnapshot.ramas.test.ts
import { prismaMock } from '@tests/__helpers__/setup'
import { getVenuePlanInfo } from '@/services/access/basePlan.service'
import { PollWorkLimiter } from '@/services/customer-display/pollWork'
import { readVenuePlanSnapshot, resetVenuePlanSnapshotsForTests } from '@/services/customer-display/venuePlanSnapshot'

/**
 * El lector REAL del plan (`basePlan` sin simular; sólo la base). Una rama de `getVenuePlanInfo` falla al instante y otra
 * se queda en la base: ni el lector ni el lugar del poll pueden soltarse antes de que ésa termine.
 */
const vaciar = () => new Promise(r => setImmediate(r))
let soltarContrato!: (v: unknown) => void

beforeEach(() => {
  resetVenuePlanSnapshotsForTests()
  prismaMock.venue.findUnique
    .mockReset()
    .mockRejectedValueOnce(new Error('base caída'))
    .mockResolvedValue(null as any) // la rama del venue falla YA
  prismaMock.hybridContract.findFirst.mockReset().mockReturnValueOnce(new Promise(r => (soltarContrato = r)) as any) // y ésta sigue viva
  prismaMock.capabilityGrant.findFirst.mockResolvedValue(null as any)
  prismaMock.capabilityGrant.groupBy.mockResolvedValue([] as any)
  prismaMock.venueFeature.findMany.mockResolvedValue([] as any)
  prismaMock.venueFeature.findFirst.mockResolvedValue(null as any)
})

it('🔴 con la espera completa, getVenuePlanInfo no se asienta mientras una de sus ramas siga en la base', async () => {
  let asentada = false
  const lectura = getVenuePlanInfo('v1', { esperarTodasLasRamas: true }).catch(e => ((asentada = true), e))
  await vaciar()
  expect(asentada).toBe(false) // con `Promise.all` ya se habría rendido, con la rama del contrato viva
  soltarContrato(null)
  expect(await lectura).toEqual(new Error('base caída'))
})

// 🔴 Codex r3 N2: el POS, la TPV, el dashboard y el MCP la llaman SIN la opción y no pueden esperar a la rama lenta.
it('🔴 sin la opción, se rinde al PRIMER fallo, como hoy (la rama viva no retiene a nadie)', async () => {
  let asentada = false
  const lectura = getVenuePlanInfo('v1').catch(e => ((asentada = true), e))
  await vaciar()
  try {
    expect(asentada).toBe(true) // ya rechazó, con la rama del contrato todavía en la base
  } finally {
    soltarContrato(null) // aunque la aserción falle: la prueba cae al momento, no por el timeout de jest
  }
  expect(await lectura).toEqual(new Error('base caída'))
})

it('🔴 y el lugar del poll sigue ocupado hasta entonces (la reproducción de Codex r2, en pequeño)', async () => {
  const limiter = new PollWorkLimiter(1)
  const lectura = readVenuePlanSnapshot('v1', { limiter }).catch(e => e)
  await vaciar()
  expect(limiter.enVuelo).toBe(1)
  expect(limiter.intentar(async () => 'otro')).toBeNull() // ningún otro trabajo entra mientras la rama siga viva
  soltarContrato(null)
  expect(await lectura).toEqual(new Error('base caída'))
  expect(limiter.enVuelo).toBe(0)
})
