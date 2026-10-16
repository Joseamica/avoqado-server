import { prismaMock } from '@tests/__helpers__/setup'
import { PollWorkLimiter, PollWorkSaturated } from '@/services/customer-display/pollWork'
import { NO_PROMOTIONS_FINGERPRINT } from '@/services/customer-display/promotionCarousel.service'
import {
  SETTINGS_DEVICE_SELECT,
  capabilityReportRequested,
  collectPollFingerprints,
  leerFuenteDeAjustes,
  settingsFingerprint,
  type FuenteDeAjustes,
  type PollDeps,
  type PollTerminal,
} from '@/services/customer-display/posPollFingerprints'
import logger from '@/config/logger'

function diferida<T>() {
  let resolver!: (v: T) => void
  let rechazar!: (e: unknown) => void
  const promesa = new Promise<T>((r, f) => ((resolver = r), (rechazar = f)))
  return { promesa, resolver, rechazar }
}
const vaciar = () => new Promise(r => setImmediate(r))

const VENUE = 'venue-a'
const terminal = (over: Partial<PollTerminal> = {}): PollTerminal =>
  ({
    id: 't1',
    status: 'ACTIVE',
    customerDisplayRequest: null,
    customerDisplayRequestExpiresAt: null,
    customerDisplayDesignVersion: 2,
    customerDisplayInstallationId: 'inst-1',
    config: { settings: { showTipScreen: true } },
    configOverrides: null,
    type: 'POS_ANDROID',
    defaultWorkspace: 'STANDARD_POS',
    fulfillmentAreaId: null,
    canIssueAreaTickets: false,
    canCheckoutAreaTickets: false,
    canDeliverAreaTickets: false,
    customerDisplayInverted: false,
    ...over,
  }) as PollTerminal
const firmas = { venueAt: '2026-09-01T00:00:00.000Z', settingsAt: null, receiptLayout: null, emisores: 'e', asociaciones: 'a' }
const plan = (PROMOTIONS = true) => ({
  planInfo: { tier: 'PRO' as const, grandfathered: false, exempt: false },
  grants: { CUSTOMER_DISPLAY_PROMOS: true, PROMOTIONS },
  entitlements: { slides: true, promotionCards: PROMOTIONS },
  calculadoEn: 0,
})

function deps(over: Partial<PollDeps> = {}): PollDeps {
  return {
    limiter: new PollWorkLimiter(8),
    plazoMs: 150,
    esperar: () => new Promise(() => {}), // por defecto el plazo nunca se cumple: todo lo que llegue, llega
    peekFicha: jest.fn(() => undefined),
    calcularFicha: jest.fn(async () => 'ficha-fp'),
    peekPlan: jest.fn(() => undefined),
    leerPlan: jest.fn(async () => plan()),
    leerFuente: jest.fn(async (_v: string, t: PollTerminal): Promise<FuenteDeAjustes> => ({ propia: true, id: t.id, aparato: t })),
    leerFirmas: jest.fn(async () => firmas),
    peekCarrusel: jest.fn(() => undefined),
    leerCarrusel: jest.fn(async () => 'promo-fp'),
    ...over,
  }
}

describe('capabilityReportRequested — lo que pide volver a reportar (pendiente del ledger de F0-A)', () => {
  it.each([
    [{ customerDisplayDesignVersion: null, customerDisplayInstallationId: null }, true], // recién mudada, o app vieja
    [{ customerDisplayDesignVersion: 1, customerDisplayInstallationId: null }, true],
    [{ customerDisplayDesignVersion: null, customerDisplayInstallationId: 'x' }, true],
    [{ customerDisplayDesignVersion: 2, customerDisplayInstallationId: 'x' }, false],
  ])('%j → %s', (t, esperado) => {
    expect(capabilityReportRequested(t)).toBe(esperado)
  })
})

describe('settingsFingerprint', () => {
  const propia = (over: Partial<PollTerminal> = {}): FuenteDeAjustes => ({ propia: true, id: 't1', aparato: terminal(over) })
  const respaldo = (config: unknown, id = 't-b'): FuenteDeAjustes => ({
    propia: false,
    respaldo: { id, config: config as any, configOverrides: null },
  })
  const base = { fuente: propia(), venue: firmas, plan: plan() }

  it('estable para lo mismo', () => {
    expect(settingsFingerprint(base)).toBe(settingsFingerprint({ ...base }))
  })

  it.each(Object.keys(SETTINGS_DEVICE_SELECT))('cambia si cambia la columna del aparato «%s»', columna => {
    const otro = { ...base, fuente: propia({ [columna]: `cambiado-${columna}` } as Partial<PollTerminal>) }
    expect(settingsFingerprint(otro)).not.toBe(settingsFingerprint(base))
  })

  it('cambia con cualquier firma del venue y con el plan', () => {
    expect(settingsFingerprint({ ...base, venue: { ...firmas, emisores: 'otro' } })).not.toBe(settingsFingerprint(base))
    expect(settingsFingerprint({ ...base, plan: plan(false) })).not.toBe(settingsFingerprint(base))
  })

  // 🔴 Codex r1 #9: la huella sigue a la fuente EFECTIVA, no a la terminal del aparato.
  it('🔴 dejar de ser la propia fuente la cambia; con un respaldo, su config y su identidad también', () => {
    expect(settingsFingerprint({ ...base, fuente: respaldo({ settings: {} }) })).not.toBe(settingsFingerprint(base))
    expect(settingsFingerprint({ ...base, fuente: respaldo({ settings: { showTipScreen: false } }) })).not.toBe(
      settingsFingerprint({ ...base, fuente: respaldo({ settings: {} }) }),
    )
    expect(settingsFingerprint({ ...base, fuente: respaldo({}, 't-c') })).not.toBe(settingsFingerprint({ ...base, fuente: respaldo({}) }))
    expect(settingsFingerprint({ ...base, fuente: { propia: false, respaldo: null } })).not.toBe(
      settingsFingerprint({ ...base, fuente: respaldo({}) }),
    )
  })
})

describe('leerFuenteDeAjustes — LA regla de /settings (`tpvSettings.mobile.controller.ts:126-129`)', () => {
  beforeEach(() => prismaMock.terminal.findFirst.mockReset())

  it.each(['ACTIVE', 'INACTIVE'])(
    '%s: el aparato es su propia fuente, sin consultar nada — y ni ese estado, ni la solicitud, ni la instalación entran',
    async status => {
      const otra = await leerFuenteDeAjustes(
        VENUE,
        terminal({ status, customerDisplayRequest: { status: 'PENDING' }, customerDisplayInstallationId: 'otra' } as Partial<PollTerminal>),
      )
      expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
      const deSiempre = await leerFuenteDeAjustes(VENUE, terminal())
      expect(settingsFingerprint({ fuente: otra, venue: firmas, plan: plan() })).toBe(
        settingsFingerprint({ fuente: deSiempre, venue: firmas, plan: plan() }),
      )
      // La fuente MISMA trae sólo las columnas de los ajustes, no sólo su huella: la Task 10 arma el cuerpo con ella.
      expect(otra).toEqual({ propia: true, id: 't1', aparato: expect.any(Object) })
      const { aparato } = otra as Extract<FuenteDeAjustes, { propia: true }>
      expect(Object.keys(aparato).sort()).toEqual(Object.keys(SETTINGS_DEVICE_SELECT).sort())
    },
  )

  it.each(['MAINTENANCE', 'PENDING_ACTIVATION', 'RETIRED'])(
    '%s: la primera terminal ACTIVA del negocio, por nombre e id (UNA consulta)',
    async status => {
      prismaMock.terminal.findFirst.mockResolvedValueOnce({ id: 't-b', config: { settings: {} }, configOverrides: null } as any)
      const f = await leerFuenteDeAjustes(VENUE, terminal({ status } as Partial<PollTerminal>))
      expect(f).toEqual({ propia: false, respaldo: { id: 't-b', config: { settings: {} }, configOverrides: null } })
      expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith({
        where: { venueId: VENUE, status: 'ACTIVE' },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, config: true, configOverrides: true },
      })
    },
  )
})

describe('collectPollFingerprints', () => {
  it('🔴 sin versión reportada: nada, y nada se consulta (decisión 1)', async () => {
    const d = deps()
    expect(
      await collectPollFingerprints({ venueId: VENUE, terminal: terminal({ customerDisplayDesignVersion: null }), hasRequest: false }, d),
    ).toEqual({})
    expect(d.peekFicha).not.toHaveBeenCalled()
    expect(d.leerFirmas).not.toHaveBeenCalled()
  })

  it('versión 1: ficha y settings, NUNCA promociones', async () => {
    const d = deps()
    const r = await collectPollFingerprints(
      { venueId: VENUE, terminal: terminal({ customerDisplayDesignVersion: 1 }), hasRequest: false },
      d,
    )
    expect(r).toEqual({ customerDisplay: 'ficha-fp', settings: expect.stringMatching(/^[0-9a-f]{32}$/) })
    expect(d.leerCarrusel).not.toHaveBeenCalled()
  })

  it('sin solicitud: las tres, calculadas EN PARALELO (todas arrancan antes de que termine una)', async () => {
    const ficha = diferida<string>()
    const d = deps({ calcularFicha: jest.fn(() => ficha.promesa) })
    const r = collectPollFingerprints({ venueId: VENUE, terminal: terminal(), hasRequest: false }, d)
    await vaciar()
    expect(d.leerFirmas).toHaveBeenCalled() // no esperó a la ficha para empezar lo demás
    expect(d.leerCarrusel).toHaveBeenCalled()
    ficha.resolver('ficha-fp')
    await expect(r).resolves.toEqual({ customerDisplay: 'ficha-fp', settings: expect.any(String), promotions: 'promo-fp' })
  })

  it('🔴 plazo CONJUNTO: lo que no llegó a tiempo se omite, lo demás sale', async () => {
    const plazo = diferida<void>()
    const lenta = diferida<string>()
    const d = deps({ esperar: () => plazo.promesa, leerCarrusel: jest.fn(() => lenta.promesa) })
    const r = collectPollFingerprints({ venueId: VENUE, terminal: terminal(), hasRequest: false }, d)
    await vaciar()
    plazo.resolver()
    const huellas = await r
    expect(huellas).toEqual({ customerDisplay: 'ficha-fp', settings: expect.any(String) })
    lenta.resolver('tarde') // sigue su camino para llenar su caché; la respuesta ya salió
  })

  it('🔴 con solicitud de inversión: responde con lo que hay en caché y NO espera nada', async () => {
    const nunca = new Promise<never>(() => {})
    const d = deps({
      peekFicha: jest.fn(() => 'ficha-guardada'),
      peekPlan: jest.fn(() => plan()),
      peekCarrusel: jest.fn(() => undefined),
      leerCarrusel: jest.fn(() => nunca),
      esperar: () => nunca,
    })
    // Contra una vuelta del event loop, no contra el timeout de jest: si esperara algo, cae aquí por aserción.
    const NO_RESPONDIO = 'no respondió en una vuelta del event loop'
    const huellas = await Promise.race([
      collectPollFingerprints({ venueId: VENUE, terminal: terminal(), hasRequest: true }, d),
      vaciar().then(() => NO_RESPONDIO),
    ])
    expect(huellas).toEqual({ customerDisplay: 'ficha-guardada' })
    expect(d.leerFirmas).not.toHaveBeenCalled() // settings no tiene caché: con solicitud se omite
    await vaciar()
    expect(d.leerCarrusel).toHaveBeenCalled() // pero la caché de promociones se empieza a llenar en segundo plano
    expect(d.leerFirmas).not.toHaveBeenCalled() // ni después: settings no arrancó
  })

  it('sin PROMOTIONS: la constante, sin armar carrusel', async () => {
    const d = deps({ leerPlan: jest.fn(async () => plan(false)) })
    const r = await collectPollFingerprints({ venueId: VENUE, terminal: terminal(), hasRequest: false }, d)
    expect(r.promotions).toBe(NO_PROMOTIONS_FINGERPRINT)
    expect(d.leerCarrusel).not.toHaveBeenCalled()
  })

  it('un error omite SÓLO su huella, se registra, y no deja rechazos sin manejar', async () => {
    const warn = logger.warn as jest.Mock
    warn.mockClear()
    const d = deps({ calcularFicha: jest.fn(async () => Promise.reject(new Error('base caída'))) })
    const r = await collectPollFingerprints({ venueId: VENUE, terminal: terminal(), hasRequest: false }, d)
    expect(r).toEqual({ settings: expect.any(String), promotions: 'promo-fp' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('huella'), expect.objectContaining({ fuente: 'customerDisplay' }))
  })

  it('🔴 tope lleno: settings no arranca y lo saturado se omite en silencio', async () => {
    const warn = logger.warn as jest.Mock
    warn.mockClear()
    const d = deps({
      limiter: new PollWorkLimiter(0),
      calcularFicha: jest.fn(async () => Promise.reject(new PollWorkSaturated())),
      leerPlan: jest.fn(async () => Promise.reject(new PollWorkSaturated())),
    })
    const r = await collectPollFingerprints({ venueId: VENUE, terminal: terminal(), hasRequest: false }, d)
    expect(r).toEqual({})
    expect(d.leerFirmas).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled() // saturar no es un error: es el tope haciendo su trabajo
  })

  // 🔴 Codex r1 #2, su reproducción literal: 7 lugares ocupados, 20 polls de versión 1, ficha caliente y plan frío.
  it('🔴 el tope cuenta el trabajo PENDIENTE: ninguna lectura arranca sin lugar ni lo suelta antes de terminar', async () => {
    const limiter = new PollWorkLimiter(8)
    for (let i = 0; i < 7; i++) limiter.intentar(() => new Promise<never>(() => {}))
    const firmasVivas: Array<(v: typeof firmas) => void> = []
    const d = deps({
      limiter,
      esperar: () => Promise.resolve(),
      peekFicha: jest.fn(() => 'ficha-guardada'),
      // El plan frío pide SU lugar, como la caché real (`SingleFlightCache.get` con `limiter`).
      leerPlan: jest.fn(
        (_v: string, l: PollWorkLimiter) => l.intentar(() => new Promise<never>(() => {})) ?? Promise.reject(new PollWorkSaturated()),
      ),
      leerFirmas: jest.fn(() => new Promise<typeof firmas>(r => firmasVivas.push(r))),
    })
    for (let i = 0; i < 20; i++) {
      await collectPollFingerprints({ venueId: VENUE, terminal: terminal({ customerDisplayDesignVersion: 1 }), hasRequest: false }, d)
    }
    await vaciar()
    // La versión anterior: contador en 7 y 20 lecturas de firmas vivas. Ahora: UNA lectura viva, y ocupa el lugar 8.
    expect(firmasVivas).toHaveLength(1)
    expect(limiter.enVuelo).toBe(8)
    firmasVivas[0](firmas)
    await vaciar()
    expect(limiter.enVuelo).toBe(7) // se soltó al terminar SU lectura, no antes
  })

  it('un venue que ya no existe (firmas null) omite settings', async () => {
    const d = deps({ leerFirmas: jest.fn(async () => null) })
    const r = await collectPollFingerprints({ venueId: VENUE, terminal: terminal(), hasRequest: false }, d)
    expect(r).not.toHaveProperty('settings')
  })
})
