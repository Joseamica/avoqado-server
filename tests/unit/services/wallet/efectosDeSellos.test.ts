/**
 * 🔴 H7 (auditoría de Codex del código + revisión final Important 1, 15-oct-2026): `grantStamp` y la reversión avisan al pase
 * del cliente y mandan el correo del primer sello en SEGUNDO PLANO (el cobro no los espera). Un script que termina con
 * `process.exit` los cortaba a medias. `esperarEfectosDeSellos` espera los que siguen en vuelo y dice cuántos hubo.
 */
const avisos: Array<{ soltar: (r: { notified: number; failed?: boolean }) => void }> = []
const correos: Array<{ soltar: () => void }> = []
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn(
    () =>
      new Promise(resolve => {
        avisos.push({ soltar: resolve })
      }),
  ),
}))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({
  sendFirstStampEmailIfDue: jest.fn(
    () =>
      new Promise<void>(resolve => {
        correos.push({ soltar: () => resolve() })
      }),
  ),
}))

import { esperarEfectosDeSellos, grantStamp } from '@/services/wallet/stampLedger.service'
import { prismaMock } from '@tests/__helpers__/setup'

const CONFIG = {
  venueId: 'v1',
  stampsEnabled: true,
  stampsRequired: 7,
  maxStampsPerDay: 0,
  stampRewardType: 'FREE_PRODUCT',
  stampRewardValue: null,
  stampRewardProductId: null,
  stampRewardLabel: 'Un café gratis',
  active: true,
}

beforeEach(() => {
  avisos.length = 0
  correos.length = 0
  prismaMock.loyaltyConfig.findUnique.mockResolvedValue(CONFIG as any)
  prismaMock.stampEvent.findFirst.mockResolvedValue(null)
  prismaMock.stampCard.findFirst.mockResolvedValue({ id: 'sc1', cycle: 1, stampsRequired: 7, stampsEarned: 0 } as any)
  prismaMock.stampEvent.create.mockResolvedValue({ id: 'se1' } as any)
  prismaMock.stampCard.update.mockResolvedValue({ stampsEarned: 1, stampsRequired: 7 } as any)
})

describe('esperarEfectosDeSellos', () => {
  it('🔴 espera el aviso al pase y el correo del primer sello que el sello dejó corriendo, y los cuenta', async () => {
    const antes = await esperarEfectosDeSellos()
    expect((await grantStamp('v1', 'c1', 'o1')).granted).toBe(true)
    expect(avisos).toHaveLength(1)
    expect(correos).toHaveLength(1)

    let termino = false
    const espera = esperarEfectosDeSellos().then(r => {
      termino = true
      return r
    })
    await new Promise(r => setImmediate(r))
    expect(termino).toBe(false) // sigue esperando: el aviso y el correo no han terminado

    avisos[0].soltar({ notified: 2 })
    correos[0].soltar()
    const despues = await espera

    expect(despues.pendientes).toBe(0)
    expect(despues.avisosAlPase - antes.avisosAlPase).toBe(1)
    expect(despues.tarjetasAvisadas - antes.tarjetasAvisadas).toBe(2)
    expect(despues.correosDePrimerSello - antes.correosDePrimerSello).toBe(1)
  })

  it('con tope de espera: dice cuántos siguen en vuelo en vez de colgarse', async () => {
    await grantStamp('v1', 'c1', 'o2')
    const r = await esperarEfectosDeSellos({ maxMs: 30 })
    expect(r.pendientes).toBe(2)
    avisos[0].soltar({ notified: 0, failed: true })
    correos[0].soltar()
    const fin = await esperarEfectosDeSellos()
    expect(fin.pendientes).toBe(0)
    expect(fin.avisosFallidos).toBeGreaterThanOrEqual(1)
  })
})
