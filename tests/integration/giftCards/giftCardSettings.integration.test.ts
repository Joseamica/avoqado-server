/**
 * Ajustes de tarjetas de regalo contra Postgres REAL (r1, A-4): dos guardados a la vez se serializan con el candado
 * consultivo del negocio y cada uno escribe SÓLO lo que mandó. Apagar mientras otra pestaña guarda montos deja la función
 * APAGADA y los montos guardados; guardar montos nunca la vuelve a prender.
 *
 * Correr: source ../urls-tarjetas.sh && TZ=UTC npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/giftCards/giftCardSettings.integration.test.ts --ci --runInBand
 *
 * Además, dos «prender» a la vez (A5, decisión del tender): el tender de sistema nace DENTRO de la transacción del
 * guardado, serializado por el mismo candado; sin él, el segundo chocaría (P2002) y abortaría su transacción. El plan
 * (`GIFT_CARDS`) lo registra C2: aquí `venueHasFeatureAccess` se fija en `true`. La base es desechable y este archivo no
 * limpia.
 */
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import prisma from '@/utils/prismaClient'
import { updateGiftCardSettings } from '@/services/giftCards/giftCardSettings.service'

jest.setTimeout(60000)

const SUF = `ajustes-${process.pid}-${Date.now()}`
let orgId: string
let n = 0

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: SUF, email: `${SUF}@example.test`, phone: '5500000000' } })).id
})

async function negocioPrendido(): Promise<string> {
  n += 1
  const venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `${SUF}-${n}`, slug: `${SUF}-${n}` } })).id
  await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000, 2000] } })
  return venueId
}

describe('ajustes de tarjetas de regalo · Postgres real (r1, A-4)', () => {
  it('🔴 apagar y guardar montos A LA VEZ: queda apagada y con los montos nuevos, en cualquier orden', async () => {
    const venueId = await negocioPrendido()

    const [apagar, montos] = await Promise.allSettled([
      updateGiftCardSettings(venueId, { enabled: false }, 'owner-apaga'),
      updateGiftCardSettings(venueId, { suggestedAmounts: [300, 800] }, 'owner-montos'),
    ])

    expect(apagar.status).toBe('fulfilled')
    expect(montos.status).toBe('fulfilled')
    const fila = await prisma.giftCardSettings.findUniqueOrThrow({ where: { venueId } })
    expect(fila.enabled).toBe(false)
    expect(fila.suggestedAmounts.map(v => v.toFixed(2))).toEqual(['300.00', '800.00'])
  })

  it('guardar montos sobre una función apagada nunca la vuelve a prender', async () => {
    const venueId = await negocioPrendido()
    await updateGiftCardSettings(venueId, { enabled: false }, 'owner-apaga')

    const vista = await updateGiftCardSettings(venueId, { suggestedAmounts: [700], validityMonths: 12 }, 'owner-montos')

    expect(vista).toMatchObject({ enabled: false, suggestedAmounts: [700], validityMonths: 12 })
    const fila = await prisma.giftCardSettings.findUniqueOrThrow({ where: { venueId } })
    expect(fila.enabled).toBe(false)
    expect(fila.updatedById).toBe('owner-montos')
  })

  it('🔴 dos «prender» A LA VEZ en un negocio nuevo: los dos terminan bien y queda UN solo tender de regalo', async () => {
    n += 1
    const venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `${SUF}-${n}`, slug: `${SUF}-${n}` } })).id

    const resultados = await Promise.allSettled([
      updateGiftCardSettings(venueId, { enabled: true, aceptaTerminos: true }, 'owner-a'),
      updateGiftCardSettings(venueId, { enabled: true, aceptaTerminos: true }, 'owner-b'),
    ])

    expect(resultados.map(r => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual(['fulfilled', 'fulfilled'])
    expect(await prisma.venueTenderType.count({ where: { venueId, systemKind: 'GIFT_CARD' } })).toBe(1)
    const fila = await prisma.giftCardSettings.findUniqueOrThrow({ where: { venueId } })
    expect(fila.enabled).toBe(true)
  })
})
