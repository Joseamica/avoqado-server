// tests/unit/controllers/mobile/settingsEnvelope.test.ts
import type { NextFunction, Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import { getTpvSettings } from '@/services/dashboard/tpv.dashboard.service'
import { getVenuePlanInfo } from '@/services/access/basePlan.service'

const readVenueSignaturesMock = jest.fn()
const readVenuePlanSnapshotMock = jest.fn()
const armarBloqueDelAparatoMock = jest.fn()

jest.mock('@/services/dashboard/tpv.dashboard.service', () => ({ getTpvSettings: jest.fn() }))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  getVenuePlanInfo: jest.fn(),
}))
jest.mock('@/services/customer-display/venueSignatures', () => ({
  readVenueSignatures: (...a: unknown[]) => readVenueSignaturesMock(...a),
}))
jest.mock('@/services/customer-display/venuePlanSnapshot', () => ({
  ...jest.requireActual('@/services/customer-display/venuePlanSnapshot'),
  readVenuePlanSnapshot: (...a: unknown[]) => readVenuePlanSnapshotMock(...a),
}))
jest.mock('@/services/customer-display/customerDisplayMobile.service', () => ({
  ...jest.requireActual('@/services/customer-display/customerDisplayMobile.service'),
  armarBloqueDelAparato: (...a: unknown[]) => armarBloqueDelAparatoMock(...a),
}))

import { getVenueTpvSettings } from '@/controllers/mobile/tpvSettings.mobile.controller'
import { SETTINGS_DEVICE_SELECT } from '@/services/customer-display/posPollFingerprints'

const VENUE = 'venue-1'
function diferida<T>() {
  let resolver!: (v: T) => void
  const promesa = new Promise<T>(r => (resolver = r))
  return { promesa, resolver }
}
const vaciar = () => new Promise(r => setImmediate(r))
const req = (deviceUid?: string) =>
  ({ params: { venueId: VENUE }, headers: deviceUid ? { 'x-device-id': deviceUid } : {} }) as unknown as Request
function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn((b: unknown) => ((r.body = b), r))
  return r as Response & { body: any }
}
const binding = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  status: 'ACTIVE',
  customerDisplayDesignVersion: 1,
  config: null,
  configOverrides: null,
  type: 'POS_ANDROID',
  defaultWorkspace: 'STANDARD_POS',
  fulfillmentAreaId: null,
  canIssueAreaTickets: false,
  canCheckoutAreaTickets: false,
  canDeliverAreaTickets: false,
  customerDisplayInverted: false,
  ...over,
})
const terminalDeLaLista = {
  id: 't1',
  name: 'Caja',
  type: 'POS_ANDROID',
  status: 'ACTIVE',
  serialNumber: null,
  brand: null,
  model: null,
  lastHeartbeat: null,
  config: null,
  configOverrides: null,
  assignedMerchantIds: [],
  preferredProcessor: null,
  activatedAt: null,
  deviceUid: 'dev-1',
  fulfillmentAreaId: null,
  canIssueAreaTickets: false,
  canCheckoutAreaTickets: false,
  canDeliverAreaTickets: false,
  defaultWorkspace: 'STANDARD_POS',
  customerDisplayInverted: false,
}

beforeEach(() => {
  ;(getTpvSettings as jest.Mock).mockResolvedValue({ showTipScreen: true })
  ;(getVenuePlanInfo as jest.Mock).mockResolvedValue({ tier: 'PRO', grandfathered: false, exempt: false })
  prismaMock.terminal.findMany.mockResolvedValue([terminalDeLaLista] as any)
  prismaMock.terminal.findFirst.mockResolvedValue(binding() as any)
  prismaMock.venueSettings.findUnique.mockResolvedValue(null as any)
  prismaMock.venue.findUnique.mockResolvedValue({
    name: 'X',
    logo: null,
    phone: null,
    address: null,
    city: null,
    state: null,
    zipCode: null,
    rfc: null,
    legalName: null,
    fiscalEmisors: [],
  } as any)
  prismaMock.receiptLayout.findUnique.mockResolvedValue(null as any)
  readVenueSignaturesMock.mockResolvedValue({
    venueAt: '2026-09-01T00:00:00.000Z',
    settingsAt: null,
    receiptLayout: null,
    emisores: 'e',
    asociaciones: 'a',
  })
  readVenuePlanSnapshotMock.mockResolvedValue({
    planInfo: { tier: 'PRO', grandfathered: false, exempt: false },
    grants: { CUSTOMER_DISPLAY_PROMOS: true, PROMOTIONS: true },
    entitlements: { slides: true, promotionCards: true },
    calculadoEn: 0,
  })
  armarBloqueDelAparatoMock.mockResolvedValue({ terminalId: 't1', ficha: { fingerprint: 'f' }, imageOrigins: ['https://x'] })
})

describe('/settings — la huella', () => {
  it.each([
    [null, 'RETAIL_STORE', true],
    [null, 'RESTAURANT', false],
    [false, 'RETAIL_STORE', false],
    [true, 'RESTAURANT', true],
  ])('keeps the display envelope and effective exchange setting (%s, %s)', async (exchangesEnabled, type, expected) => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ exchangesEnabled } as any)
    prismaMock.venue.findUnique.mockResolvedValue({ type } as any)
    const r = res()
    const next = jest.fn() as NextFunction
    await getVenueTpvSettings(req('dev-1'), r, next)
    expect(next).not.toHaveBeenCalled()
    expect(r.body.data).toMatchObject({
      exchangesEnabled: expected,
      componentsStatus: { promotionsPanel: 'ok', customerDisplay: 'ok' },
      customerDisplay: { terminalId: 't1' },
    })
  })

  it('🔴 las FIRMAS se leen ANTES de que empiece cualquier lectura del cuerpo', async () => {
    const firmas = diferida<unknown>()
    readVenueSignaturesMock.mockReturnValue(firmas.promesa)
    const r = res()
    const hecho = getVenueTpvSettings(req('dev-1'), r, jest.fn() as NextFunction)
    await vaciar()
    expect(prismaMock.venueSettings.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.terminal.findMany).not.toHaveBeenCalled()
    firmas.resolver({ venueAt: '2026-09-01T00:00:00.000Z', settingsAt: null, receiptLayout: null, emisores: 'e', asociaciones: 'a' })
    await hecho
    expect(prismaMock.venueSettings.findUnique).toHaveBeenCalled()
    expect(r.body.data.fingerprints).toEqual({ settings: expect.stringMatching(/^[0-9a-f]{32}$/) })
  })

  it('🔴 R11: la lista del cuerpo ordena por nombre E id — con nombres repetidos, «la primera activa» es la fila del respaldo de la huella', async () => {
    await getVenueTpvSettings(req('dev-1'), res(), jest.fn() as NextFunction)
    // El literal, no la constante: si `ORDEN_DEL_RESPALDO` perdiera el desempate, el cuerpo y la huella dejarían de ser deterministas.
    expect(prismaMock.terminal.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: [{ name: 'asc' }, { id: 'asc' }] }))
  })

  it('sin cabecera: ni binding, ni firmas, ni huella — como hoy', async () => {
    const r = res()
    await getVenueTpvSettings(req(), r, jest.fn() as NextFunction)
    expect(readVenueSignaturesMock).not.toHaveBeenCalled()
    expect(r.body.data).not.toHaveProperty('fingerprints')
  })

  it('aparato sin versión reportada: sin firmas ni huella', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(binding({ customerDisplayDesignVersion: null }) as any)
    const r = res()
    await getVenueTpvSettings(req('dev-1'), r, jest.fn() as NextFunction)
    expect(readVenueSignaturesMock).not.toHaveBeenCalled()
    expect(r.body.data).not.toHaveProperty('fingerprints')
  })

  it('DD3: cada campo del aparato que entrega deviceTerminal está en la huella (salvo el id y lo que sale del tipo)', async () => {
    const r = res()
    await getVenueTpvSettings(req('dev-1'), r, jest.fn() as NextFunction)
    const cubiertos = new Set(Object.keys(SETTINGS_DEVICE_SELECT))
    for (const campo of Object.keys(r.body.data.deviceTerminal)) {
      if (campo === 'id' || campo === 'configurableSettings') continue
      expect(cubiertos.has(campo)).toBe(true)
    }
    expect(cubiertos.has('type')).toBe(true) // configurableSettings sale del tipo
  })
})

describe('/settings — componentsStatus', () => {
  it('todo bien: ok en los cuatro, y el bloque de la pantalla del cliente', async () => {
    const r = res()
    await getVenueTpvSettings(req('dev-1'), r, jest.fn() as NextFunction)
    expect(r.body.data.componentsStatus).toEqual({ receipt: 'ok', plan: 'ok', promotionsPanel: 'ok', customerDisplay: 'ok' })
    expect(r.body.data.customerDisplay).toEqual({ terminalId: 't1', ficha: { fingerprint: 'f' }, imageOrigins: ['https://x'] })
  })

  it('sin fila de VenueSettings es ok (los defaults son la verdad); una lectura que FALLA es failed', async () => {
    const r1 = res()
    await getVenueTpvSettings(req('dev-1'), r1, jest.fn() as NextFunction)
    expect(r1.body.data.componentsStatus.promotionsPanel).toBe('ok')
    prismaMock.venueSettings.findUnique.mockRejectedValue(new Error('base caída'))
    const r2 = res()
    await getVenueTpvSettings(req('dev-1'), r2, jest.fn() as NextFunction)
    expect(r2.body.data.componentsStatus.promotionsPanel).toBe('failed')
    expect(r2.body.data.promotions).toEqual({ panelCashier: 'TAB', panelCustomer: 'SIDE_PANEL' }) // el cuerpo de siempre
  })

  it('el plan que falla: failed (y el cuerpo sin `plan`, como hoy)', async () => {
    ;(getVenuePlanInfo as jest.Mock).mockRejectedValue(new Error('x'))
    const r = res()
    await getVenueTpvSettings(req('dev-1'), r, jest.fn() as NextFunction)
    expect(r.body.data.componentsStatus.plan).toBe('failed')
    expect(r.body.data).not.toHaveProperty('plan')
  })

  it('el recibo sin encabezado: failed', async () => {
    prismaMock.venue.findUnique.mockRejectedValue(new Error('x'))
    const r = res()
    await getVenueTpvSettings(req('dev-1'), r, jest.fn() as NextFunction)
    expect(r.body.data.componentsStatus.receipt).toBe('failed')
  })

  it.each([
    ['sin cabecera', undefined, undefined],
    ['iPad (no hay binding POS_ANDROID)', 'ipad-1', null],
    ['app sin versión', 'dev-1', binding({ customerDisplayDesignVersion: null })],
  ])('%s: customerDisplay not_applicable y sin bloque', async (_caso, deviceUid, fila) => {
    if (fila !== undefined) prismaMock.terminal.findFirst.mockResolvedValue(fila as any)
    const r = res()
    await getVenueTpvSettings(req(deviceUid), r, jest.fn() as NextFunction)
    expect(r.body.data.componentsStatus.customerDisplay).toBe('not_applicable')
    expect(r.body.data).not.toHaveProperty('customerDisplay')
  })

  it('🔴 Codex r1 #8: si la LECTURA del binding falla, /settings sale entero — sin huella y con customerDisplay failed', async () => {
    prismaMock.terminal.findFirst.mockRejectedValue(new Error('base caída'))
    const r = res()
    const next = jest.fn()
    await getVenueTpvSettings(req('dev-1'), r, next as NextFunction)
    expect(next).not.toHaveBeenCalled() // la ruta NO falla
    expect(r.body.data.settings).toEqual({ showTipScreen: true }) // el cuerpo de siempre
    expect(r.body.data).not.toHaveProperty('fingerprints')
    expect(r.body.data.componentsStatus.customerDisplay).toBe('failed') // «no pude saberlo», no «no aplica»
    expect(readVenueSignaturesMock).not.toHaveBeenCalled()
  })

  it('la ficha que falla: failed y sin bloque — el resto de /settings sale igual', async () => {
    armarBloqueDelAparatoMock.mockRejectedValue(new Error('x'))
    const r = res()
    await getVenueTpvSettings(req('dev-1'), r, jest.fn() as NextFunction)
    expect(r.body.data.componentsStatus.customerDisplay).toBe('failed')
    expect(r.body.data).not.toHaveProperty('customerDisplay')
    expect(r.body.data.settings).toEqual({ showTipScreen: true })
  })
})
