/**
 * Herramientas de lectura de tarjetas de regalo (C5; las del gerente, en gift-cards.write.test.ts): permiso exacto y alcance del negocio, sin candado de plan (el saldo
 * vendido siempre se puede leer, spec §6), pesos, días del negocio y nunca el código.
 */
import fs from 'fs'
import path from 'path'
import { registerGiftCardTools } from '../../../src/mcp/tools/giftCards'
import { TOOL_EFFECTS } from '../../../src/mcp/catalog'
import type { McpScope } from '../../../src/mcp/scope'

const mockSummary = jest.fn()
const mockAging = jest.fn()
const mockList = jest.fn()
const mockPermiso = jest.fn()
jest.mock('@/services/giftCards/giftCardReports.service', () => ({
  getGiftCardSummary: (...a: unknown[]) => mockSummary(...a),
  getGiftCardLiabilityAging: (...a: unknown[]) => mockAging(...a),
  listGiftCards: (...a: unknown[]) => mockList(...a),
}))
jest.mock('@/services/dashboard/commission/commission-utils', () => ({
  getVenueTimezone: jest.fn().mockResolvedValue('America/Mexico_City'),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'ajeno') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (perm: string, v: string) => {
      mockPermiso(perm, v)
      if (v === 'sin-permiso') throw new Error('Forbidden: missing giftCards:read')
    },
  }),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const llamar = async (nombre: string, args: Record<string, unknown>) => JSON.parse((await handlers.get(nombre)!(args, {})).content[0].text)

beforeAll(() => {
  registerGiftCardTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())
afterEach(() => jest.useRealTimers())

const RESUMEN = {
  from: '2026-10-01',
  to: '2026-10-14',
  timezone: 'America/Mexico_City',
  sold: { cards: 2, amount: 1500 },
  redeemed: { movements: 1, amount: 300, reversed: 0, net: 300 },
  cancelled: { cards: 0, amount: 0 },
  adjustments: { increments: 0, decrements: 0, net: 0 },
  liveBalance: { cards: 2, amount: 1200, expiredAmount: 0, asOf: '2026-10-15T03:00:00.000Z' },
}
const ANTIGUEDAD = { at: '2026-10-14', timezone: 'America/Mexico_City', buckets: [], total: { cards: 2, amount: 1200 } }
const FILA = {
  id: 'gc1',
  last4: 'K7QZ',
  status: 'ACTIVE',
  initialAmount: 1000,
  balance: 400.5,
  createdAt: '2026-10-15T02:55:00.000Z',
  activatedAt: '2026-10-15T03:00:00.000Z',
  expiresAt: null,
  deliveryChannel: 'PRINTED',
  deliveryStatus: 'PENDING',
  recipientName: 'Ana',
  purchaserName: 'Luis',
  source: 'POS',
  customer: { id: 'c1', name: 'Karla Q' },
  order: { id: 'o1', orderNumber: 'ORD-1' },
}

describe('gift_cards_summary', () => {
  it('fuera de alcance o sin permiso: no lee nada', async () => {
    await expect(llamar('gift_cards_summary', { venueId: 'ajeno' })).rejects.toThrow('out of scope')
    await expect(llamar('gift_cards_summary', { venueId: 'sin-permiso' })).rejects.toThrow('Forbidden')
    expect(mockSummary).not.toHaveBeenCalled()
  })

  it('por default: del día 1 del mes a HOY del negocio (a las 21:00 de México, en UTC ya es «mañana»)', async () => {
    // Sólo el reloj: las promesas y los temporizadores siguen reales (las herramientas esperan servicios simulados).
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval'] })
    jest.setSystemTime(new Date('2026-10-15T03:00:00.000Z'))
    mockSummary.mockResolvedValue(RESUMEN)
    mockAging.mockResolvedValue(ANTIGUEDAD)
    const r = await llamar('gift_cards_summary', { venueId: 'v1' })
    expect(mockSummary).toHaveBeenCalledWith('v1', { from: '2026-10-01', to: '2026-10-14' })
    expect(mockAging).toHaveBeenCalledWith('v1', '2026-10-14')
    expect(mockPermiso).toHaveBeenCalledWith('giftCards:read', 'v1')
    expect(r).toMatchObject({
      venueId: 'v1',
      currency: 'MXN',
      sold: { cards: 2, amount: 1500 },
      liveBalance: { amount: 1200 },
      aging: ANTIGUEDAD,
    })
  })

  it('⭐ (C5 menor 4) con sólo toDate en un mes anterior, empieza el día 1 del mes de toDate (no del mes actual)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval'] })
    jest.setSystemTime(new Date('2026-10-15T18:00:00.000Z'))
    mockSummary.mockResolvedValue(RESUMEN)
    mockAging.mockResolvedValue(ANTIGUEDAD)
    await llamar('gift_cards_summary', { venueId: 'v1', toDate: '2026-09-20' })
    expect(mockSummary).toHaveBeenCalledWith('v1', { from: '2026-09-01', to: '2026-09-20' })
    expect(mockAging).toHaveBeenCalledWith('v1', '2026-09-20')
  })

  it('respeta el periodo que se le pide; la antigüedad, al cierre del último día', async () => {
    mockSummary.mockResolvedValue(RESUMEN)
    mockAging.mockResolvedValue(ANTIGUEDAD)
    await llamar('gift_cards_summary', { venueId: 'v1', fromDate: '2026-09-01', toDate: '2026-09-30' })
    expect(mockSummary).toHaveBeenCalledWith('v1', { from: '2026-09-01', to: '2026-09-30' })
    expect(mockAging).toHaveBeenCalledWith('v1', '2026-09-30')
  })
})

describe('gift_card_lookup', () => {
  it('pide con qué buscar antes de leer', async () => {
    const r = await llamar('gift_card_lookup', { venueId: 'v1' })
    expect(r.found).toBe(false)
    expect(r.error).toMatch(/últimos 4/)
    expect(mockList).not.toHaveBeenCalled()
  })

  it('por últimos 4: hasta 10 y el total, pesos, días del negocio y nunca el código', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval'] })
    jest.setSystemTime(new Date('2026-10-15T18:00:00.000Z'))
    mockList.mockResolvedValue({ items: [FILA], page: 1, pageSize: 10, total: 12 })
    const r = await llamar('gift_card_lookup', { venueId: 'v1', last4: 'k7qz' })
    expect(mockList).toHaveBeenCalledWith('v1', { last4: 'k7qz', search: undefined, pageSize: 10 })
    expect(r).toEqual({
      found: true,
      venueId: 'v1',
      currency: 'MXN',
      total: 12,
      showing: 1,
      moreThanShown: true,
      cards: [
        {
          last4: 'K7QZ',
          status: 'ACTIVE',
          initialAmount: 1000,
          balance: 400.5,
          activatedOn: '2026-10-14',
          expiresOn: null,
          expired: false,
          customer: 'Karla Q',
          recipient: 'Ana',
          buyer: 'Luis',
          saleTicket: 'ORD-1',
        },
      ],
    })
  })

  it('por cliente; sin coincidencias → found:false con un texto para el usuario', async () => {
    mockList.mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0 })
    const r = await llamar('gift_card_lookup', { venueId: 'v1', customer: 'Brenda' })
    expect(mockList).toHaveBeenCalledWith('v1', { last4: undefined, search: 'Brenda', pageSize: 10 })
    expect(r).toEqual({ found: false, error: 'No encontré tarjetas de regalo con esos datos en este negocio.' })
  })

  it('fuera de alcance → no busca', async () => {
    await expect(llamar('gift_card_lookup', { venueId: 'ajeno', last4: 'K7QZ' })).rejects.toThrow('out of scope')
    expect(mockList).not.toHaveBeenCalled()
  })

  it('⭐ (C5 menor 6) sin giftCards:read → no busca', async () => {
    await expect(llamar('gift_card_lookup', { venueId: 'sin-permiso', last4: 'K7QZ' })).rejects.toThrow('Forbidden')
    expect(mockPermiso).toHaveBeenCalledWith('giftCards:read', 'sin-permiso')
    expect(mockList).not.toHaveBeenCalled()
  })

  it('⭐ (C5 menor 5) dice si ya venció (`expired`, la misma frontera que el saldo: vence ⇔ expiresAt <= ahora), para que la IA no la ofrezca', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval'] })
    jest.setSystemTime(new Date('2026-10-15T18:00:00.000Z'))
    mockList.mockResolvedValue({
      items: [
        { ...FILA, last4: 'VENC', expiresAt: '2026-10-15T18:00:00.000Z' },
        { ...FILA, last4: 'VIVA', expiresAt: '2026-10-15T18:00:01.000Z' },
      ],
      page: 1,
      pageSize: 10,
      total: 2,
    })
    const r = await llamar('gift_card_lookup', { venueId: 'v1', customer: 'Karla' })
    expect(r.cards.map((c: { last4: string; status: string; expired: boolean }) => [c.last4, c.status, c.expired])).toEqual([
      ['VENC', 'ACTIVE', true],
      ['VIVA', 'ACTIVE', false],
    ])
  })
})

describe('reglas fijas', () => {
  it('🔴 ninguna pasa por un candado de plan (el saldo vendido siempre se puede leer)', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '../../../src/mcp/tools/giftCards.ts'), 'utf8')
    expect(fuente).not.toMatch(/planGate|checkFeatureAccess|venueHasFeatureAccess|venuesWithFeatureAccess/)
  })

  it('las de consulta son lecturas, las del gerente son escrituras, y están registradas en el MCP libre', () => {
    expect(TOOL_EFFECTS.gift_cards_summary).toBe('read')
    expect(TOOL_EFFECTS.gift_card_lookup).toBe('read')
    for (const nombre of ['manage_gift_card', 'cancel_gift_card_sale', 'update_gift_card_settings'])
      expect(TOOL_EFFECTS[nombre]).toBe('write')
    const server = fs.readFileSync(path.join(__dirname, '../../../src/mcp/server.ts'), 'utf8')
    expect(server).toMatch(/registerGiftCardTools\(server, scope\)/)
  })
})
