/**
 * Tarjetas de regalo — el asistente OPERA tarjetas (pendientes 1a, tarea 4): bloquear, desbloquear y ajustar una tarjeta,
 * cancelar o liberar la venta de tarjetas y cambiar las reglas o apagar la función. Con vista previa y confirmación; nunca
 * repone el código (el nuevo pasaría por el chat) ni prende la función (los términos se aceptan en el panel). La tarjeta
 * se resuelve por sus últimos 4 y, si hay varias, por el folio o su `cardRef`: nunca se adivina.
 */
import fs from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'
import { registerGiftCardTools } from '../../../src/mcp/tools/giftCards'
import { TOOL_EFFECTS } from '../../../src/mcp/catalog'
import { DIRECTORY_TOOLS } from '../../../src/mcp/directory/catalog'
import { GiftCardError } from '../../../src/services/giftCards/giftCardErrors'
import { BadRequestError } from '../../../src/errors/AppError'
import type { McpScope } from '../../../src/mcp/scope'

const mockList = jest.fn()
const mockDetail = jest.fn()
const mockOperar = jest.fn()
const mockIniciar = jest.fn()
const mockLiberar = jest.fn()
const mockAjustes = jest.fn()
const mockGuardar = jest.fn()
const mockAudit = jest.fn()
const mockPermiso = jest.fn()
jest.mock('@/services/giftCards/giftCardReports.service', () => ({
  getGiftCardSummary: jest.fn(),
  getGiftCardLiabilityAging: jest.fn(),
  listGiftCards: (...a: unknown[]) => mockList(...a),
  getGiftCardDetail: (...a: unknown[]) => mockDetail(...a),
}))
jest.mock('@/services/giftCards/giftCardSurface.service', () => ({ operarSobreDeGerente: (...a: unknown[]) => mockOperar(...a) }))
jest.mock('@/services/giftCards/giftCardCancel.service', () => ({
  iniciarCancelacionDeVenta: (...a: unknown[]) => mockIniciar(...a),
  liberarCancelacionDeVenta: (...a: unknown[]) => mockLiberar(...a),
}))
jest.mock('@/services/giftCards/giftCardSettings.service', () => ({
  getGiftCardSettings: (...a: unknown[]) => mockAjustes(...a),
  updateGiftCardSettings: (...a: unknown[]) => mockGuardar(...a),
}))
jest.mock('@/services/dashboard/commission/commission-utils', () => ({
  getVenueTimezone: jest.fn().mockResolvedValue('America/Mexico_City'),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...a) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'ajeno') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (perm: string, v: string) => {
      mockPermiso(perm, v)
      if (v === 'sin-permiso') throw new Error(`Forbidden: missing ${perm}`)
    },
  }),
}))

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
const handlers = new Map<string, Handler>()
const schemas = new Map<string, Record<string, { safeParse: (v: unknown) => { success: boolean } }>>()
const descripciones = new Map<string, string>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const crudo = async (nombre: string, args: Record<string, unknown>) => (await handlers.get(nombre)!(args, {})).content[0].text
const llamar = async (nombre: string, args: Record<string, unknown>) => JSON.parse(await crudo(nombre, args))

beforeAll(() => {
  registerGiftCardTools(
    {
      tool: (...a: unknown[]) => {
        handlers.set(a[0] as string, a[a.length - 1] as Handler)
        schemas.set(a[0] as string, a[a.length - 2] as never)
        if (typeof a[1] === 'string') descripciones.set(a[0] as string, a[1])
      },
    } as never,
    scope,
  )
})
beforeEach(() => jest.clearAllMocks())

const LLAVE = 'mcp-tarjeta-0001'
const fila = (extra: Record<string, unknown> = {}) => ({
  id: 'gc1',
  last4: '4821',
  status: 'ACTIVE',
  initialAmount: 500,
  balance: 400,
  createdAt: '2026-10-18T15:00:00.000Z',
  activatedAt: '2026-10-18T15:01:00.000Z',
  expiresAt: null,
  deliveryChannel: 'PRINTED',
  deliveryStatus: 'PENDING',
  recipientName: null,
  purchaserName: null,
  source: 'POS',
  customer: null,
  order: { id: 'o1', orderNumber: 'ORD-1' },
  ...extra,
})
const pagina = (...items: unknown[]) => ({ items, page: 1, pageSize: 10, total: items.length, totalBalance: 0 })
/** El servicio filtra por folio en la base (sin importar mayúsculas); aquí se simula igual. */
const conFolio =
  (...filas: Array<ReturnType<typeof fila>>) =>
  async (_v: string, q: { folio?: string }) =>
    pagina(...filas.filter(f => !q.folio || f.order?.orderNumber.toUpperCase() === q.folio.trim().toUpperCase()))
const AJUSTE = {
  venueId: 'v1',
  last4: '4821',
  action: 'adjust',
  direction: 'add',
  amount: 50,
  reason: 'CASHIER_ERROR',
  note: 'Se cobró doble',
  idempotencyKey: LLAVE,
}

describe('permisos', () => {
  it('sin giftCards:manage ⇒ PERMISSION_DENIED y no llama al servicio', async () => {
    await expect(llamar('manage_gift_card', { ...AJUSTE, venueId: 'sin-permiso', confirm: true })).rejects.toThrow('Forbidden')
    await expect(
      llamar('cancel_gift_card_sale', { venueId: 'sin-permiso', last4: '4821', action: 'start', idempotencyKey: LLAVE, confirm: true }),
    ).rejects.toThrow('Forbidden')
    await expect(llamar('update_gift_card_settings', { venueId: 'sin-permiso', enabled: false, confirm: true })).rejects.toThrow(
      'Forbidden',
    )
    await expect(llamar('manage_gift_card', { ...AJUSTE, venueId: 'ajeno' })).rejects.toThrow('out of scope')
    expect(mockPermiso.mock.calls).toEqual([
      ['giftCards:manage', 'sin-permiso'],
      ['giftCards:manage', 'sin-permiso'],
      ['giftCards:manage', 'sin-permiso'],
    ])
    for (const m of [mockList, mockDetail, mockOperar, mockIniciar, mockLiberar, mockAjustes, mockGuardar, mockAudit])
      expect(m).not.toHaveBeenCalled()
  })
})

describe('manage_gift_card', () => {
  it('sin idempotencyKey pide una llave (UUID) antes de leer nada', async () => {
    const sinLlave = { ...AJUSTE, idempotencyKey: undefined }
    const r = await llamar('manage_gift_card', sinLlave)
    expect(r).toMatchObject({ ok: false, needsInput: true, field: 'idempotencyKey' })
    expect(mockList).not.toHaveBeenCalled()
  })

  it('sin confirm devuelve la vista previa (tarjeta ••••4821, saldo, efecto) y no escribe', async () => {
    mockList.mockImplementation(conFolio(fila()))
    const r = await llamar('manage_gift_card', AJUSTE)
    expect(mockList).toHaveBeenCalledWith('v1', { last4: '4821', folio: undefined, pageSize: 10 })
    expect(r).toMatchObject({
      ok: false,
      requiresConfirmation: true,
      preview: {
        card: '••••4821',
        saleFolio: 'ORD-1',
        status: 'ACTIVE',
        balance: 400,
        action: 'adjust',
        direction: 'add',
        amount: 50,
        balanceAfter: 450,
        reason: 'CASHIER_ERROR',
        note: 'Se cobró doble',
      },
    })
    expect(r.message).toContain('••••4821')
    expect(r.message).toContain('$450.00')

    const bloqueo = await llamar('manage_gift_card', {
      venueId: 'v1',
      last4: '4821',
      action: 'block',
      reason: 'SUSPICIOUS_ACTIVITY',
      idempotencyKey: LLAVE,
    })
    expect(bloqueo).toMatchObject({ requiresConfirmation: true, preview: { card: '••••4821', action: 'block', balance: 400 } })
    expect(bloqueo.message).toMatch(/BLOQUEAR/)
    expect(mockOperar).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('la vista previa no promete lo imposible: restar más que el saldo o bloquear una bloqueada se rechaza antes', async () => {
    mockList.mockImplementation(conFolio(fila()))
    const resta = await llamar('manage_gift_card', { ...AJUSTE, direction: 'remove', amount: 400.01 })
    expect(resta).toMatchObject({ ok: false, code: 'GIFT_CARD_INSUFFICIENT_BALANCE' })
    mockList.mockImplementation(conFolio(fila({ status: 'BLOCKED' })))
    const bloqueo = await llamar('manage_gift_card', {
      venueId: 'v1',
      last4: '4821',
      action: 'block',
      reason: 'OTHER',
      note: 'x',
      idempotencyKey: LLAVE,
    })
    expect(bloqueo).toMatchObject({ ok: false, code: 'GIFT_CARD_BLOCKED' })
    expect(mockOperar).not.toHaveBeenCalled()
  })

  it('dos tarjetas con el mismo last4 ⇒ ambiguous con folio y cardRef de cada una; con saleFolio elige la correcta', async () => {
    mockList.mockImplementation(conFolio(fila(), fila({ id: 'gc2', balance: 900, order: { id: 'o2', orderNumber: 'ORD-2' } })))
    const r = await llamar('manage_gift_card', { ...AJUSTE, confirm: true })
    expect(r).toMatchObject({ ok: false, ambiguous: true, total: 2 })
    expect(r.candidates).toEqual([
      { cardRef: 'gc1', last4: '4821', status: 'ACTIVE', balance: 400, saleFolio: 'ORD-1' },
      { cardRef: 'gc2', last4: '4821', status: 'ACTIVE', balance: 900, saleFolio: 'ORD-2' },
    ])
    expect(r.error).toMatch(/folio/)
    expect(mockOperar).not.toHaveBeenCalled()

    mockOperar.mockResolvedValue({ activityIds: ['act-1'], replayed: false })
    const ok = await llamar('manage_gift_card', { ...AJUSTE, saleFolio: 'ord-2', confirm: true })
    expect(mockList).toHaveBeenLastCalledWith('v1', { last4: '4821', folio: 'ord-2', pageSize: 10 })
    expect(ok.ok).toBe(true)
    expect(mockOperar).toHaveBeenCalledTimes(1)
    expect(mockOperar.mock.calls[0].slice(0, 3)).toEqual(['v1', 'gc2', 's1'])
  })

  it('🔴 dos tarjetas de la MISMA venta con el mismo last4 ⇒ sólo cardRef las separa; con cardRef opera la correcta', async () => {
    mockList.mockImplementation(conFolio(fila(), fila({ id: 'gc2', balance: 900 })))
    const r = await llamar('manage_gift_card', { ...AJUSTE, saleFolio: 'ORD-1', confirm: true })
    expect(r).toMatchObject({ ambiguous: true, total: 2 })
    expect(r.candidates.map((c: { cardRef: string; saleFolio: string }) => [c.cardRef, c.saleFolio])).toEqual([
      ['gc1', 'ORD-1'],
      ['gc2', 'ORD-1'],
    ])
    expect(mockOperar).not.toHaveBeenCalled()

    mockDetail.mockResolvedValue(fila({ id: 'gc2', balance: 900 }))
    mockOperar.mockResolvedValue({ activityIds: ['act-2'], replayed: false })
    const ok = await llamar('manage_gift_card', { ...AJUSTE, saleFolio: 'ORD-1', cardRef: 'gc2', confirm: true })
    expect(mockDetail).toHaveBeenCalledWith('v1', 'gc2', { limit: 1 })
    expect(ok.ok).toBe(true)
    expect(mockOperar.mock.calls[0].slice(0, 3)).toEqual(['v1', 'gc2', 's1'])
  })

  it('🔴 un cardRef de otro negocio, o que no termina en esos 4, es «no encontrada» y no opera', async () => {
    mockDetail.mockRejectedValueOnce(new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos esa tarjeta de regalo en este negocio.', 404))
    const ajena = await llamar('manage_gift_card', { ...AJUSTE, cardRef: 'gc-de-otro-negocio', confirm: true })
    expect(ajena).toMatchObject({ ok: false, code: 'GIFT_CARD_NOT_FOUND' })
    expect(mockDetail).toHaveBeenCalledWith('v1', 'gc-de-otro-negocio', { limit: 1 })

    mockDetail.mockResolvedValueOnce(fila({ id: 'gc9', last4: 'ZZ99' }))
    const otra = await llamar('manage_gift_card', { ...AJUSTE, cardRef: 'gc9', confirm: true })
    expect(otra).toMatchObject({ ok: false, code: 'GIFT_CARD_NOT_FOUND' })
    expect(mockOperar).not.toHaveBeenCalled()
  })

  it('🔴 un ajuste sin nota (o con más de 500) se rechaza antes de llamar al servicio, igual que la ruta del panel', async () => {
    const sinNota = { ...AJUSTE, note: undefined }
    const r1 = await llamar('manage_gift_card', { ...sinNota, confirm: true })
    expect(r1).toEqual({ ok: false, error: 'Escribe una nota que explique el ajuste' })
    const r2 = await llamar('manage_gift_card', { ...AJUSTE, note: '   ', confirm: true })
    expect(r2.error).toBe('Escribe una nota que explique el ajuste')
    const r3 = await llamar('manage_gift_card', { ...AJUSTE, note: 'x'.repeat(501), confirm: true })
    expect(r3.error).toBe('La nota no puede pasar de 500 caracteres')
    // También centavos de más (el esquema del panel valida el texto del número).
    const r4 = await llamar('manage_gift_card', { ...AJUSTE, amount: 10.555, confirm: true })
    expect(r4.ok).toBe(false)
    expect(mockList).not.toHaveBeenCalled()
    expect(mockOperar).not.toHaveBeenCalled()
  })

  it('con confirm llama operarSobreDeGerente con operationKey = idempotencyKey y amount en Decimal; audita GIFT_CARD_ADJUSTED sólo si !replayed', async () => {
    mockList.mockImplementation(conFolio(fila()))
    mockOperar.mockResolvedValueOnce({ activityIds: ['act-1'], replayed: false })
    const r = await llamar('manage_gift_card', { ...AJUSTE, confirm: true })
    expect(r).toMatchObject({ ok: true, card: '••••4821', action: 'adjust', replayed: false })
    const [venue, tarjeta, staff, cuerpo] = mockOperar.mock.calls[0]
    expect([venue, tarjeta, staff]).toEqual(['v1', 'gc1', 's1'])
    expect(cuerpo).toMatchObject({
      operationKey: LLAVE,
      tipo: 'AJUSTE',
      direccion: 'INCREMENT',
      reason: 'CASHIER_ERROR',
      note: 'Se cobró doble',
    })
    expect(cuerpo.amount).toBeInstanceOf(Prisma.Decimal)
    expect(cuerpo.amount.toFixed(2)).toBe('50.00')
    expect(mockAudit).toHaveBeenCalledTimes(1)
    expect(mockAudit).toHaveBeenCalledWith(scope, {
      action: 'GIFT_CARD_ADJUSTED',
      entity: 'GiftCard',
      entityId: 'gc1',
      venueId: 'v1',
      data: {
        operationKey: LLAVE,
        tipo: 'AJUSTE',
        reason: 'CASHIER_ERROR',
        note: 'Se cobró doble',
        direccion: 'INCREMENT',
        amount: 50,
        activityIds: ['act-1'],
      },
    })

    // Reintento con la misma llave: la libreta lo reconoce (replayed) ⇒ «hecho», sin otra bitácora.
    mockOperar.mockResolvedValueOnce({ activityIds: ['act-1'], replayed: true })
    const otra = await llamar('manage_gift_card', { ...AJUSTE, confirm: true })
    expect(otra).toMatchObject({ ok: true, replayed: true })
    expect(mockAudit).toHaveBeenCalledTimes(1)

    // Bloquear y desbloquear: su acción en la bitácora, sin monto.
    mockOperar.mockResolvedValueOnce({ activityIds: ['act-3'], replayed: false })
    await llamar('manage_gift_card', {
      venueId: 'v1',
      last4: '4821',
      action: 'block',
      reason: 'LOST_CARD',
      idempotencyKey: 'mcp-bloqueo-01',
      confirm: true,
    })
    expect(mockOperar.mock.calls[2][3]).toEqual({ operationKey: 'mcp-bloqueo-01', tipo: 'BLOQUEAR', reason: 'LOST_CARD' })
    expect(mockAudit.mock.calls[1][1]).toMatchObject({ action: 'GIFT_CARD_BLOCKED', data: { tipo: 'BLOQUEAR', note: null } })
  })

  it('🔴 el reintento de una confirmación que SÍ llegó responde «hecho» (lo decide la libreta), aunque la tarjeta ya cambió', async () => {
    // El bloqueo llegó pero se perdió la respuesta: hoy la tarjeta está BLOCKED. La vista previa diría «no se puede», el reintento no.
    mockList.mockImplementation(conFolio(fila({ status: 'BLOCKED' })))
    mockOperar.mockResolvedValueOnce({ activityIds: ['act-1'], replayed: true })
    const args = { venueId: 'v1', last4: '4821', action: 'block', reason: 'LOST_CARD', idempotencyKey: LLAVE, confirm: true }
    expect(await llamar('manage_gift_card', args)).toMatchObject({ ok: true, replayed: true })
    // Restar todo el saldo, y reintentarlo con el saldo ya en $0.
    mockList.mockImplementation(conFolio(fila({ balance: 0 })))
    mockOperar.mockResolvedValueOnce({ activityIds: ['act-2'], replayed: true })
    expect(await llamar('manage_gift_card', { ...AJUSTE, direction: 'remove', amount: 400, confirm: true })).toMatchObject({
      ok: true,
      replayed: true,
    })
    expect(mockOperar).toHaveBeenCalledTimes(2)
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('un rechazo del servicio sale con su code y su texto, sin bitácora', async () => {
    mockList.mockImplementation(conFolio(fila()))
    mockOperar.mockRejectedValueOnce(new GiftCardError('IDEMPOTENCY_KEY_REUSED', 'Esta operación ya se registró con otros datos.', 409))
    const r = await llamar('manage_gift_card', { ...AJUSTE, confirm: true })
    expect(r).toEqual({ ok: false, code: 'IDEMPOTENCY_KEY_REUSED', error: 'Esta operación ya se registró con otros datos.' })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('nunca regresa nuevoCodigo ni ofrece reponer', async () => {
    mockList.mockImplementation(conFolio(fila()))
    mockOperar.mockResolvedValueOnce({ activityIds: ['act-1'], nuevoCodigo: { display: 'ABCD-EFGH-4821', last4: '4821' }, replayed: false })
    const salida = await crudo('manage_gift_card', { ...AJUSTE, confirm: true })
    expect(salida).not.toMatch(/nuevoCodigo|ABCD-EFGH/)
    expect(JSON.stringify(mockAudit.mock.calls)).not.toMatch(/ABCD-EFGH/)
    for (const accion of ['replace', 'replace_code', 'reponer', 'REEMPLAZAR_CODIGO'])
      expect(schemas.get('manage_gift_card')!.action.safeParse(accion).success).toBe(false)
    for (const accion of ['block', 'unblock', 'adjust'])
      expect(schemas.get('manage_gift_card')!.action.safeParse(accion).success).toBe(true)
    expect(mockOperar.mock.calls.every(c => c[3].tipo !== 'REEMPLAZAR_CODIGO')).toBe(true)
  })
})

describe('cancel_gift_card_sale', () => {
  const detalle = (cancel: Record<string, unknown>) => ({ ...fila(), cancel, sale: { cards: 2, amount: 1000 } })

  it('exige last4 o saleFolio', async () => {
    const r = await llamar('cancel_gift_card_sale', { venueId: 'v1', action: 'start', idempotencyKey: LLAVE })
    expect(r).toMatchObject({ ok: false, needsInput: true })
    expect(mockList).not.toHaveBeenCalled()
  })

  it('cancel_gift_card_sale release sin confirmNotRefunded ⇒ needsInput y no llama al servicio', async () => {
    for (const confirmNotRefunded of [undefined, false]) {
      const r = await llamar('cancel_gift_card_sale', {
        venueId: 'v1',
        last4: '4821',
        action: 'release',
        idempotencyKey: LLAVE,
        confirm: true,
        ...(confirmNotRefunded === undefined ? {} : { confirmNotRefunded }),
      })
      expect(r).toMatchObject({ ok: false, needsInput: true, field: 'confirmNotRefunded' })
      expect(r.question).toMatch(/NO se hizo/)
    }
    expect(mockLiberar).not.toHaveBeenCalled()
    expect(mockList).not.toHaveBeenCalled()
  })

  it('iniciar: la vista previa dice «Venta #N · K tarjetas · $X»; con confirm inicia con la llave y audita', async () => {
    mockList.mockImplementation(conFolio(fila()))
    mockDetail.mockResolvedValue(detalle({ allowed: true, reason: null, message: null }))
    const vista = await llamar('cancel_gift_card_sale', { venueId: 'v1', saleFolio: 'ord-1', action: 'start', idempotencyKey: LLAVE })
    expect(mockList).toHaveBeenCalledWith('v1', { last4: undefined, folio: 'ord-1', pageSize: 10 })
    expect(mockDetail).toHaveBeenCalledWith('v1', 'gc1', { limit: 1 })
    expect(vista).toMatchObject({ requiresConfirmation: true, preview: { sale: 'Venta #ORD-1 · 2 tarjetas · $1,000.00', action: 'start' } })
    expect(mockIniciar).not.toHaveBeenCalled()

    mockIniciar.mockResolvedValueOnce({ giftCardIds: ['gc1', 'gc2'], bloqueadas: ['gc1', 'gc2'] })
    const ok = await llamar('cancel_gift_card_sale', {
      venueId: 'v1',
      saleFolio: 'ord-1',
      action: 'start',
      idempotencyKey: LLAVE,
      confirm: true,
    })
    expect(mockIniciar).toHaveBeenCalledWith('v1', 'o1', { staffId: 's1', operationKey: LLAVE })
    expect(ok).toMatchObject({ ok: true, sale: 'Venta #ORD-1 · 2 tarjetas · $1,000.00', blockedCards: 2 })
    expect(mockAudit).toHaveBeenCalledWith(scope, {
      action: 'GIFT_CARD_SALE_CANCEL_STARTED',
      entity: 'Order',
      entityId: 'o1',
      venueId: 'v1',
      data: { operationKey: LLAVE, giftCardIds: ['gc1', 'gc2'] },
    })
  })

  it('la vista previa de iniciar dice por qué no se puede (la misma regla del panel), sin llamar al servicio', async () => {
    mockList.mockImplementation(conFolio(fila()))
    mockDetail.mockResolvedValue(
      detalle({ allowed: false, reason: 'NOT_SAME_DAY', message: 'La venta de tarjetas sólo se cancela el mismo día del cobro.' }),
    )
    const r = await llamar('cancel_gift_card_sale', { venueId: 'v1', last4: '4821', action: 'start', idempotencyKey: LLAVE })
    expect(r).toEqual({ ok: false, code: 'NOT_SAME_DAY', error: 'La venta de tarjetas sólo se cancela el mismo día del cobro.' })
    expect(mockIniciar).not.toHaveBeenCalled()
  })

  it('liberar: sólo con la cancelación en curso; con confirmNotRefunded y confirm libera y audita', async () => {
    mockList.mockImplementation(conFolio(fila({ status: 'BLOCKED' })))
    mockDetail.mockResolvedValue(detalle({ allowed: true, reason: null, message: null }))
    const nada = await llamar('cancel_gift_card_sale', {
      venueId: 'v1',
      last4: '4821',
      action: 'release',
      confirmNotRefunded: true,
      idempotencyKey: LLAVE,
    })
    expect(nada).toMatchObject({ ok: false })
    expect(nada.error).toMatch(/nada que liberar/)

    mockDetail.mockResolvedValue(detalle({ allowed: false, reason: 'IN_PROGRESS', message: null }))
    const args = { venueId: 'v1', last4: '4821', action: 'release', confirmNotRefunded: true, idempotencyKey: LLAVE }
    expect(await llamar('cancel_gift_card_sale', args)).toMatchObject({ requiresConfirmation: true, preview: { action: 'release' } })
    mockLiberar.mockResolvedValueOnce({ liberadas: ['gc1', 'gc2'] })
    expect(await llamar('cancel_gift_card_sale', { ...args, confirm: true })).toMatchObject({ ok: true, releasedCards: 2 })
    expect(mockLiberar).toHaveBeenCalledWith('v1', 'o1', { staffId: 's1', operationKey: LLAVE, confirmacionNoDevuelto: true })
    expect(mockAudit).toHaveBeenCalledWith(scope, {
      action: 'GIFT_CARD_SALE_CANCEL_RELEASED',
      entity: 'Order',
      entityId: 'o1',
      venueId: 'v1',
      data: { operationKey: LLAVE, giftCardIds: ['gc1', 'gc2'] },
    })
  })

  it('🔴 iniciar o liberar SIN escribir (un reintento, o una cancelación que ya inició otra persona) no deja bitácora a nombre de esta app', async () => {
    mockList.mockImplementation(conFolio(fila()))
    mockDetail.mockResolvedValue(detalle({ allowed: false, reason: 'IN_PROGRESS', message: null }))
    const inicio = { venueId: 'v1', last4: '4821', action: 'start', idempotencyKey: LLAVE, confirm: true }
    // Reintento con la misma llave, o «ya en curso» con otra llave: el servicio responde con éxito, pero no bloqueó nada.
    mockIniciar.mockResolvedValueOnce({ giftCardIds: ['gc1', 'gc2'], bloqueadas: [] })
    const r1 = await llamar('cancel_gift_card_sale', inicio)
    expect(r1).toMatchObject({ ok: true, blockedCards: 0 })
    expect(r1.note).toMatch(/no cambió nada/)
    mockIniciar.mockResolvedValueOnce({ giftCardIds: ['gc1', 'gc2'], bloqueadas: [] })
    expect(await llamar('cancel_gift_card_sale', { ...inicio, idempotencyKey: 'mcp-otra-persona-01' })).toMatchObject({ blockedCards: 0 })
    // Liberar sin tarjetas liberadas (reintento de una liberación que ya se hizo).
    mockLiberar.mockResolvedValueOnce({ liberadas: [] })
    const r3 = await llamar('cancel_gift_card_sale', { ...inicio, action: 'release', confirmNotRefunded: true })
    expect(r3).toMatchObject({ ok: true, releasedCards: 0 })
    expect(r3.note).toMatch(/no cambió nada/)
    expect(mockIniciar).toHaveBeenCalledTimes(2)
    expect(mockLiberar).toHaveBeenCalledTimes(1)
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('🔴 una venta de 2 tarjetas se cancela por su folio: es UNA venta, no hay «cuál tarjeta» que escoger', async () => {
    mockList.mockImplementation(conFolio(fila(), fila({ id: 'gc2', last4: '7777', balance: 600 })))
    mockDetail.mockResolvedValue(detalle({ allowed: true, reason: null, message: null }))
    const vista = await llamar('cancel_gift_card_sale', { venueId: 'v1', saleFolio: 'ORD-1', action: 'start', idempotencyKey: LLAVE })
    expect(vista).toMatchObject({
      requiresConfirmation: true,
      cardRef: 'gc1',
      preview: { sale: 'Venta #ORD-1 · 2 tarjetas · $1,000.00', action: 'start' },
    })
    expect(vista.ambiguous).toBeUndefined()

    mockIniciar.mockResolvedValueOnce({ giftCardIds: ['gc1', 'gc2'], bloqueadas: ['gc1', 'gc2'] })
    const ok = await llamar('cancel_gift_card_sale', {
      venueId: 'v1',
      saleFolio: 'ORD-1',
      action: 'start',
      idempotencyKey: LLAVE,
      confirm: true,
    })
    expect(ok).toMatchObject({ ok: true, blockedCards: 2 })
    expect(mockIniciar).toHaveBeenCalledWith('v1', 'o1', { staffId: 's1', operationKey: LLAVE })
  })

  it('🔴 dos ventas DISTINTAS con el mismo folio siguen siendo ambiguas: nunca se escoge una', async () => {
    mockList.mockImplementation(conFolio(fila(), fila({ id: 'gc2', order: { id: 'o2', orderNumber: 'ORD-1' } })))
    const r = await llamar('cancel_gift_card_sale', {
      venueId: 'v1',
      saleFolio: 'ORD-1',
      action: 'start',
      idempotencyKey: LLAVE,
      confirm: true,
    })
    expect(r).toMatchObject({ ok: false, ambiguous: true, total: 2 })
    expect(mockDetail).not.toHaveBeenCalled()
    expect(mockIniciar).not.toHaveBeenCalled()
  })

  it('🔴 con sólo el cardRef de una de sus tarjetas resuelve su venta, sin volver a pedir el folio', async () => {
    mockDetail.mockResolvedValue({ ...detalle({ allowed: true, reason: null, message: null }), id: 'gc2', last4: '7777' })
    const vista = await llamar('cancel_gift_card_sale', { venueId: 'v1', cardRef: 'gc2', action: 'start', idempotencyKey: LLAVE })
    expect(mockDetail).toHaveBeenCalledWith('v1', 'gc2', { limit: 1 })
    expect(mockList).not.toHaveBeenCalled()
    expect(vista).toMatchObject({ requiresConfirmation: true, cardRef: 'gc2', preview: { sale: 'Venta #ORD-1 · 2 tarjetas · $1,000.00' } })
  })

  it('un rechazo al leer el detalle de la venta sale como {ok:false, code}, no como error', async () => {
    mockList.mockImplementation(conFolio(fila()))
    // La tarjeta se borró entre la lista y el detalle.
    mockDetail.mockRejectedValueOnce(new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos esa tarjeta de regalo en este negocio.', 404))
    const r = await llamar('cancel_gift_card_sale', { venueId: 'v1', last4: '4821', action: 'start', idempotencyKey: LLAVE })
    expect(r).toEqual({ ok: false, code: 'GIFT_CARD_NOT_FOUND', error: 'No encontramos esa tarjeta de regalo en este negocio.' })
    expect(mockIniciar).not.toHaveBeenCalled()
  })

  it('una tarjeta sin venta no tiene venta que cancelar', async () => {
    mockList.mockImplementation(async () => pagina(fila({ order: null })))
    const r = await llamar('cancel_gift_card_sale', { venueId: 'v1', last4: '4821', action: 'start', idempotencyKey: LLAVE })
    expect(r.ok).toBe(false)
    expect(mockDetail).not.toHaveBeenCalled()
    expect(mockIniciar).not.toHaveBeenCalled()
  })
})

describe('update_gift_card_settings', () => {
  const AJUSTES = { enabled: true, suggestedAmounts: [200, 500], minAmount: 100, maxAmount: 5000, validityMonths: 12 }

  it('update_gift_card_settings con enabled:true ⇒ se rechaza sin llamar a updateGiftCardSettings', async () => {
    for (const confirm of [undefined, true]) {
      const r = await llamar('update_gift_card_settings', { venueId: 'v1', enabled: true, ...(confirm ? { confirm } : {}) })
      expect(r).toEqual({
        ok: false,
        error: 'Las tarjetas de regalo se prenden desde el panel (Ajustes › Tarjetas de regalo), porque hay que aceptar los términos.',
      })
    }
    expect(mockGuardar).not.toHaveBeenCalled()
    expect(mockAjustes).not.toHaveBeenCalled()
  })

  it('valida con el esquema del panel antes de leer (centavos de más, nada que guardar)', async () => {
    expect((await llamar('update_gift_card_settings', { venueId: 'v1', minAmount: 10.555 })).ok).toBe(false)
    expect(await llamar('update_gift_card_settings', { venueId: 'v1' })).toEqual({ ok: false, error: 'No hay nada que guardar' })
    expect(mockAjustes).not.toHaveBeenCalled()
    expect(mockGuardar).not.toHaveBeenCalled()
  })

  it('apagar: la vista previa dice antes → después y que lo vendido sigue valiendo; con confirm guarda y audita', async () => {
    mockAjustes.mockResolvedValue(AJUSTES)
    const vista = await llamar('update_gift_card_settings', { venueId: 'v1', enabled: false, minAmount: 150 })
    expect(vista).toMatchObject({
      requiresConfirmation: true,
      preview: { changes: { enabled: { from: true, to: false }, minAmount: { from: 100, to: 150 } } },
    })
    expect(vista.message).toMatch(/APAGA/)
    expect(vista.message).toMatch(/siguen valiendo/)
    expect(mockGuardar).not.toHaveBeenCalled()

    mockGuardar.mockResolvedValueOnce({ ...AJUSTES, enabled: false, minAmount: 150, termsVersion: '2026-10-14', llavesConfiguradas: true })
    const ok = await llamar('update_gift_card_settings', { venueId: 'v1', enabled: false, minAmount: 150, confirm: true })
    expect(mockGuardar).toHaveBeenCalledWith('v1', { enabled: false, minAmount: 150 }, 's1')
    expect(ok).toEqual({
      ok: true,
      settings: { enabled: false, suggestedAmounts: [200, 500], minAmount: 150, maxAmount: 5000, validityMonths: 12 },
    })
    expect(mockAudit).toHaveBeenCalledWith(scope, {
      action: 'GIFT_CARD_SETTINGS_UPDATED',
      entity: 'GiftCardSettings',
      entityId: 'v1',
      venueId: 'v1',
      data: { changes: { enabled: false, minAmount: 150 } },
    })
  })

  it('un rechazo del servicio (mínimo mayor que el máximo) sale con su texto y sin bitácora', async () => {
    mockAjustes.mockResolvedValue(AJUSTES)
    mockGuardar.mockRejectedValueOnce(new BadRequestError('El monto mínimo no puede ser mayor que el máximo.'))
    const r = await llamar('update_gift_card_settings', { venueId: 'v1', minAmount: 6000, confirm: true })
    expect(r).toEqual({ ok: false, error: 'El monto mínimo no puede ser mayor que el máximo.' })
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

describe('reglas fijas de las de operación', () => {
  const NOMBRES = ['manage_gift_card', 'cancel_gift_card_sale', 'update_gift_card_settings']

  it('las 3 son write, están fuera del directorio y su descripción no lleva palabras internas', () => {
    for (const nombre of NOMBRES) {
      expect({ nombre, efecto: TOOL_EFFECTS[nombre] }).toEqual({ nombre, efecto: 'write' })
      expect({ nombre, directorio: DIRECTORY_TOOLS.has(nombre) }).toEqual({ nombre, directorio: false })
      const d = descripciones.get(nombre)!
      expect(d).toMatch(/giftCards:manage/)
      expect(d).not.toMatch(/\bprisma\b|GiftCard\.|ActivityLog|operarSobre|src\/|\bDecimal\b/i)
    }
  })

  it('🔴 sin candado de plan: operar tarjetas nunca pide plan (R9)', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '../../../src/mcp/tools/giftCards.ts'), 'utf8')
    expect(fuente).not.toMatch(/planGate|checkFeatureAccess|venueHasFeatureAccess|venuesWithFeatureAccess/)
  })
})
