import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/online-ordering/presence.service', () => ({
  __esModule: true,
  getAcceptingStatus: jest.fn(async () => ({ status: 'OPEN', reason: null, config: {} })),
  storeView: jest.fn(() => ({ status: 'OPEN' })),
}))
jest.mock('@/services/online-ordering/settings.service', () => ({
  __esModule: true,
  getSettings: jest.fn(),
  getSettingsWithSaved: jest.fn(),
  storeRequirements: jest.fn(async () => ({ address: true, phone: true, privacyNotice: true })),
}))

import { getSettings, getSettingsWithSaved } from '@/services/online-ordering/settings.service'
import { settingsView } from '@/services/online-ordering/settingsView.service'

const SETTINGS = { enabled: true, acceptsCardOnline: true, lastInboxPollAt: null }
const M = (o: Record<string, unknown> = {}) => ({
  id: 'em1',
  chargesEnabled: true,
  providerCredentials: { connectAccountId: 'acct_1' },
  provider: { code: 'STRIPE_CONNECT' },
  ...o,
})

// El mock de getSettingsWithSaved sigue a getSettings (cada prueba cambia getSettings); `saved` por omisión true.
let SAVED = true
beforeEach(() => {
  SAVED = true
  ;(getSettings as jest.Mock).mockResolvedValue(SETTINGS)
  ;(getSettingsWithSaved as jest.Mock).mockImplementation(async () => ({ settings: await (getSettings as jest.Mock)(), saved: SAVED }))
})

describe('settingsView.card', () => {
  it('sin ningún comercio Stripe Connect: NOT_CONNECTED', async () => {
    prismaMock.ecommerceMerchant.findMany.mockResolvedValue([])
    expect((await settingsView('v1')).card).toEqual({ enabled: true, merchantStatus: 'NOT_CONNECTED' })
  })

  it('hay comercio pero ninguno cobra (chargesEnabled false): NOT_CHARGEABLE', async () => {
    prismaMock.ecommerceMerchant.findMany.mockResolvedValue([M({ chargesEnabled: false })] as any)
    expect((await settingsView('v1')).card.merchantStatus).toBe('NOT_CHARGEABLE')
  })

  it('al menos uno cobrable: READY, con UNA sola consulta acotada', async () => {
    prismaMock.ecommerceMerchant.findMany.mockResolvedValue([M({ chargesEnabled: false }), M({ id: 'em2' })] as any)
    expect((await settingsView('v1')).card.merchantStatus).toBe('READY')
    expect(prismaMock.ecommerceMerchant.findMany).toHaveBeenCalledTimes(1)
    expect((prismaMock.ecommerceMerchant.findMany.mock.calls[0][0] as any).take).toBeGreaterThan(0)
  })

  it('card.enabled refleja el switch aunque el comercio ya no cobre', async () => {
    prismaMock.ecommerceMerchant.findMany.mockResolvedValue([])
    expect((await settingsView('v1')).card).toEqual({ enabled: true, merchantStatus: 'NOT_CONNECTED' })
    ;(getSettings as jest.Mock).mockResolvedValue({ ...SETTINGS, acceptsCardOnline: false })
    expect((await settingsView('v1')).card.enabled).toBe(false)
  })
})

describe('settingsView: ¿Quién confirma? (T5)', () => {
  beforeEach(() => prismaMock.ecommerceMerchant.findMany.mockResolvedValue([]))

  it('trae requiresAcceptance y lastToPayPollAt en ISO', async () => {
    const at = new Date('2026-11-05T10:00:00.000Z')
    ;(getSettings as jest.Mock).mockResolvedValue({ ...SETTINGS, requiresAcceptance: false, lastToPayPollAt: at })
    prismaMock.venue.findUnique.mockResolvedValue({ type: 'CLOTHING' } as any)
    const v = await settingsView('v1')
    expect(v.requiresAcceptance).toBe(false)
    expect(v.lastToPayPollAt).toBe(at.toISOString())
  })

  it('lastToPayPollAt null sigue siendo null', async () => {
    ;(getSettings as jest.Mock).mockResolvedValue({ ...SETTINGS, requiresAcceptance: true, lastToPayPollAt: null })
    prismaMock.venue.findUnique.mockResolvedValue({ type: 'RESTAURANT' } as any)
    expect((await settingsView('v1')).lastToPayPollAt).toBeNull()
  })

  it('una tienda de ropa sugiere «Nadie» (suggestedRequiresAcceptance false) aunque hoy esté en «Mi equipo»; un restaurante sugiere «Mi equipo»', async () => {
    ;(getSettings as jest.Mock).mockResolvedValue({ ...SETTINGS, requiresAcceptance: true, lastToPayPollAt: null })
    prismaMock.venue.findUnique.mockResolvedValue({ type: 'CLOTHING' } as any)
    const ropa = await settingsView('v1')
    expect(ropa.requiresAcceptance).toBe(true)
    expect(ropa.suggestedRequiresAcceptance).toBe(false)
    prismaMock.venue.findUnique.mockResolvedValue({ type: 'RESTAURANT' } as any)
    expect((await settingsView('v1')).suggestedRequiresAcceptance).toBe(true)
  })

  it('un FITNESS_STUDIO sugiere «Nadie» (suggestedRequiresAcceptance false)', async () => {
    ;(getSettings as jest.Mock).mockResolvedValue({ ...SETTINGS, requiresAcceptance: true, lastToPayPollAt: null })
    prismaMock.venue.findUnique.mockResolvedValue({ type: 'FITNESS_STUDIO' } as any)
    expect((await settingsView('v1')).suggestedRequiresAcceptance).toBe(false)
  })
})

describe('settingsView.hasSavedSettings (T18)', () => {
  beforeEach(() => {
    prismaMock.ecommerceMerchant.findMany.mockResolvedValue([])
    prismaMock.venue.findUnique.mockResolvedValue({ type: 'CLOTHING' } as any)
  })

  it('sin fila de ajustes: false', async () => {
    SAVED = false
    expect((await settingsView('v1')).hasSavedSettings).toBe(false)
  })

  it('con fila de ajustes: true', async () => {
    expect((await settingsView('v1')).hasSavedSettings).toBe(true)
  })

  it('con preloaded (lo que acaba de escribir el PUT): true, sin leer la fila otra vez', async () => {
    SAVED = false
    expect((await settingsView('v1', SETTINGS as any)).hasSavedSettings).toBe(true)
    expect(getSettingsWithSaved).not.toHaveBeenCalled()
  })
})

describe('D661 · D2: cardNadie dice si la tarjeta de «No, entran solos» se ofrece AHORA (bloque nuevo y opcional)', () => {
  const RAPIDO = new Date(Date.now() - 20_000)
  const VIEJO = new Date(Date.now() - 10 * 60_000)
  const NADIE = { ...SETTINGS, acceptsCardOnline: false, requiresAcceptance: false, cardOnlineNadie: true, lastToPayPollAt: null }
  /** La fila de ajustes con sus latidos de la caja que avisa (los lee la misma lectura de los ajustes). */
  const conAvisos = (settings: Record<string, unknown>, avisos: { lastCardAlertPollAt: Date | null; cardAlertFastPollAt: Date | null }) => {
    ;(getSettingsWithSaved as jest.Mock).mockResolvedValue({ settings, saved: true, cardAlerts: avisos })
    // `cardOnlineAvailable` (la regla de /info y del borrador) relee la marca rápida.
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ cardAlertFastPollAt: avisos.cardAlertFastPollAt } as any)
  }
  beforeEach(() => {
    prismaMock.ecommerceMerchant.findMany.mockResolvedValue([M()] as any)
    prismaMock.venue.findUnique.mockResolvedValue({ type: 'CLOTHING' } as any)
  })

  it('prendida y con una caja que recibió una respuesta rápida hace menos de 90 s: offeredNow true y las horas en ISO', async () => {
    conAvisos(NADIE, { lastCardAlertPollAt: RAPIDO, cardAlertFastPollAt: RAPIDO })
    expect((await settingsView('v1')).cardNadie).toEqual({
      enabled: true,
      lastAlertAt: RAPIDO.toISOString(),
      fastAlertAt: RAPIDO.toISOString(),
      offeredNow: true,
    })
  })

  it('prendida pero ninguna caja avisando ahora (sin respuesta rápida reciente): offeredNow false', async () => {
    conAvisos(NADIE, { lastCardAlertPollAt: RAPIDO, cardAlertFastPollAt: VIEJO })
    expect((await settingsView('v1')).cardNadie).toEqual({
      enabled: true,
      lastAlertAt: RAPIDO.toISOString(),
      fastAlertAt: VIEJO.toISOString(),
      offeredNow: false,
    })
    conAvisos(NADIE, { lastCardAlertPollAt: null, cardAlertFastPollAt: null })
    expect((await settingsView('v1')).cardNadie).toEqual({ enabled: true, lastAlertAt: null, fastAlertAt: null, offeredNow: false })
  })

  it('apagada, o la tienda en «Mi equipo»: offeredNow false aunque una caja esté avisando', async () => {
    conAvisos({ ...NADIE, cardOnlineNadie: false }, { lastCardAlertPollAt: RAPIDO, cardAlertFastPollAt: RAPIDO })
    expect((await settingsView('v1')).cardNadie).toMatchObject({ enabled: false, offeredNow: false })
    conAvisos({ ...NADIE, requiresAcceptance: true, acceptsCardOnline: true }, { lastCardAlertPollAt: RAPIDO, cardAlertFastPollAt: RAPIDO })
    expect((await settingsView('v1')).cardNadie).toMatchObject({ enabled: true, offeredNow: false })
  })

  it('lo de antes no cambia: card y los demás campos siguen igual; las horas de la caja no se cuelan como campos sueltos', async () => {
    conAvisos(NADIE, { lastCardAlertPollAt: RAPIDO, cardAlertFastPollAt: RAPIDO })
    const v = await settingsView('v1')
    expect(v.card).toEqual({ enabled: false, merchantStatus: 'READY' })
    expect(v).toMatchObject({ requiresAcceptance: false, cardOnlineNadie: true, hasSavedSettings: true })
    expect(v).not.toHaveProperty('lastCardAlertPollAt')
    expect(v).not.toHaveProperty('cardAlertFastPollAt')
  })

  it('con preloaded (el PUT) lee los latidos de la caja en una lectura chica, sin releer los ajustes', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ lastCardAlertPollAt: RAPIDO, cardAlertFastPollAt: RAPIDO } as any)
    expect((await settingsView('v1', NADIE as any)).cardNadie).toEqual({
      enabled: true,
      lastAlertAt: RAPIDO.toISOString(),
      fastAlertAt: RAPIDO.toISOString(),
      offeredNow: true,
    })
    expect(getSettingsWithSaved).not.toHaveBeenCalled()
  })
})
