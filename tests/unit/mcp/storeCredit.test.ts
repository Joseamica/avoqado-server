/**
 * S9 (saldo a favor): las tools del MCP, atravesando el catálogo REAL (confirmación firmada igual que `review_exchange`).
 * Permisos exactos, nada se escribe sin vista previa + token, y la forma de lo que se lee es la de la ficha del cliente (S8c).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import { DIRECTORY_TOOLS } from '@/mcp/directory/catalog'
import type { McpScope } from '@/mcp/scope'
import { registerStoreCreditTools } from '@/mcp/tools/storeCredit'
import AppError from '@/errors/AppError'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'

const mockSettingsUpdate = jest.fn()
const mockPhone = jest.fn()
const mockEsSobre = jest.fn()
const mockBalances = jest.fn()
const mockAvailable = jest.fn()
jest.mock('@/services/dashboard/venueSettings.dashboard.service', () => ({
  updateVenueSettings: (...a: unknown[]) => mockSettingsUpdate(...a),
}))
jest.mock('@/services/giftCards/giftCardCuenta.service', () => ({ cambiarTelefonoDeSaldoAFavor: (...a: unknown[]) => mockPhone(...a) }))
jest.mock('@/services/giftCards/giftCardLedger', () => ({ sobresDeSaldoAFavorEntre: (...a: unknown[]) => mockEsSobre(...a) }))
jest.mock('@/services/storeCredit/customerStoreCreditBalance', () => ({ storeCreditDeClientes: (...a: unknown[]) => mockBalances(...a) }))
jest.mock('@/services/storeCredit/storeCreditTender', () => ({ storeCreditAvailable: () => mockAvailable() }))
const mockSettings = jest.fn()
const mockCustomer = jest.fn()
const mockCard = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueSettings: { findUnique: (...a: unknown[]) => mockSettings(...a) },
    customer: { findFirst: (...a: unknown[]) => mockCustomer(...a) },
    giftCard: { findFirst: (...a: unknown[]) => mockCard(...a) },
  },
}))
jest.mock('@/services/access/access.service', () => ({
  hasPermission: (access: { corePermissions: string[] }, permission: string) => access.corePermissions.includes(permission),
}))

const venueId = 'cm12345678901234567890123'
const customerId = 'cm22345678901234567890123'
const giftCardId = 'cm32345678901234567890123'
const staffId = 'cm42345678901234567890123'
const scopeCon = (permisos: string[], scopes = ['mcp:read', 'mcp:write']): McpScope => ({
  staffId,
  activeOrg: 'cm52345678901234567890123',
  scopes,
  allowedVenueIds: [venueId],
  perVenueAccess: new Map([[venueId, { corePermissions: permisos } as never]]),
})
const TODOS = ['venues:read', 'venues:update', 'customers:read', 'giftCards:manage']

let server: McpServer
let client: Client
async function abrir(scope: McpScope) {
  server = new McpServer({ name: 'saldo', version: '1' })
  configureToolCatalog(server, scope)
  registerStoreCreditTools(server, scope)
  client = new Client({ name: 'saldo-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
}
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args })
  const raw = (r.content as Array<{ text: string }>)[0].text
  try {
    return { isError: r.isError, ...JSON.parse(raw) }
  } catch {
    return { isError: true, error: raw } // los errores de alcance llegan como texto plano
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAvailable.mockReturnValue(true)
  mockSettings.mockResolvedValue({ storeCreditOnly: false })
  mockCustomer.mockResolvedValue({ id: customerId })
  mockCard.mockResolvedValue({ id: giftCardId, status: 'ACTIVE', recipientPhone: '5215512341111' })
  mockEsSobre.mockResolvedValue(new Set([giftCardId]))
  mockPhone.mockResolvedValue({ phoneLast4: '9999' })
  mockSettingsUpdate.mockResolvedValue({})
})
afterEach(async () => {
  await client?.close()
  await server?.close()
})

it('las tools nacen sólo en modo libre: ninguna está en el catálogo certificado', () => {
  for (const n of ['get_store_credit_settings', 'set_store_credit_only', 'get_customer_store_credit', 'change_store_credit_phone'])
    expect(DIRECTORY_TOOLS.has(n)).toBe(false)
})

describe('get_store_credit_settings (venues:read)', () => {
  it('sin el permiso no lee', async () => {
    await abrir(scopeCon(['customers:read']))
    expect((await call('get_store_credit_settings', { venueId })).isError).toBe(true)
  })
  it('lee el interruptor y si el servidor sabe dar saldo', async () => {
    mockSettings.mockResolvedValue({ storeCreditOnly: true })
    mockAvailable.mockReturnValue(false)
    await abrir(scopeCon(['venues:read']))
    expect(await call('get_store_credit_settings', { venueId })).toMatchObject({ storeCreditOnly: true, disponible: false })
  })
  it('sin fila de ajustes, «sólo saldo» está apagado', async () => {
    mockSettings.mockResolvedValue(null)
    await abrir(scopeCon(['venues:read']))
    expect(await call('get_store_credit_settings', { venueId })).toMatchObject({ storeCreditOnly: false })
  })
})

describe('set_store_credit_only (venues:update, confirmación firmada)', () => {
  const args = { venueId, storeCreditOnly: true }
  it('sin el permiso no escribe, ni siquiera la vista previa', async () => {
    await abrir(scopeCon(['venues:read']))
    expect((await call('set_store_credit_only', args)).isError).toBe(true)
    expect(mockSettingsUpdate).not.toHaveBeenCalled()
  })
  it('un token sin mcp:write no escribe', async () => {
    await abrir(scopeCon(TODOS, ['mcp:read']))
    expect((await call('set_store_credit_only', args)).isError).toBe(true)
    expect(mockSettingsUpdate).not.toHaveBeenCalled()
  })
  it('avisa en la vista previa cuando el servidor no puede dar saldo (sin llaves)', async () => {
    mockAvailable.mockReturnValue(false)
    await abrir(scopeCon(TODOS))
    const p = await call('set_store_credit_only', args)
    expect(p.preview.disponible).toBe(false)
    expect(p.message).toContain('todavía no puede dar saldo a favor')
  })
  it('confirm:true sin token NO escribe; la vista previa tampoco', async () => {
    await abrir(scopeCon(TODOS))
    expect(await call('set_store_credit_only', { ...args, confirm: true })).toMatchObject({ needsInput: true, field: 'confirmationToken' })
    const preview = await call('set_store_credit_only', args)
    expect(preview).toMatchObject({ requiresConfirmation: true, preview: { actual: false, nuevo: true } })
    expect(mockSettingsUpdate).not.toHaveBeenCalled()
  })
  it('el token de una vista previa no sirve para otro valor', async () => {
    await abrir(scopeCon(TODOS))
    const preview = await call('set_store_credit_only', args)
    const r = await call('set_store_credit_only', {
      ...preview.confirmationArguments,
      storeCreditOnly: false,
      confirm: true,
      confirmationToken: preview.confirmationToken,
    })
    expect(r).toMatchObject({ needsInput: true })
    expect(mockSettingsUpdate).not.toHaveBeenCalled()
  })
  it('con la vista previa + token guarda por el servicio compartido', async () => {
    await abrir(scopeCon(TODOS))
    const preview = await call('set_store_credit_only', args)
    mockSettings.mockResolvedValue({ storeCreditOnly: true })
    const r = await call('set_store_credit_only', {
      ...preview.confirmationArguments,
      confirm: true,
      confirmationToken: preview.confirmationToken,
    })
    expect(r).toMatchObject({ ok: true, storeCreditOnly: true })
    expect(mockSettingsUpdate).toHaveBeenCalledWith(venueId, { storeCreditOnly: true }, staffId)
  })
})

describe('get_customer_store_credit (customers:read)', () => {
  it('sin el permiso no lee', async () => {
    await abrir(scopeCon(['venues:read']))
    expect((await call('get_customer_store_credit', { venueId, customerId })).isError).toBe(true)
    expect(mockBalances).not.toHaveBeenCalled()
  })
  it('un cliente de otra sucursal no se lee', async () => {
    mockCustomer.mockResolvedValue(null)
    await abrir(scopeCon(['customers:read']))
    expect(await call('get_customer_store_credit', { venueId, customerId })).toMatchObject({ ok: false, code: 'CUSTOMER_NOT_FOUND' })
    expect(mockCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: { in: [venueId] }, id: customerId }) }),
    )
    expect(mockBalances).not.toHaveBeenCalled()
  })
  it('devuelve la forma de la ficha del cliente (S8c) y el saldo en pesos', async () => {
    mockBalances.mockResolvedValue(new Map([[customerId, { balanceCents: 15050, phoneLast4: '1111', giftCardId }]]))
    await abrir(scopeCon(['customers:read']))
    const r = await call('get_customer_store_credit', { venueId, customerId })
    expect(mockBalances).toHaveBeenCalledWith(expect.anything(), venueId, [customerId])
    expect(r.storeCredit).toMatchObject({ balanceCents: 15050, phoneLast4: '1111', giftCardId })
    expect(r.saldo).toBe(150.5)
  })
  it('congelado y sin sobre', async () => {
    mockBalances.mockResolvedValueOnce(new Map([[customerId, { balanceCents: 0, phoneLast4: '1111', giftCardId, blocked: true }]]))
    await abrir(scopeCon(['customers:read']))
    expect((await call('get_customer_store_credit', { venueId, customerId })).storeCredit).toMatchObject({ blocked: true })
    mockBalances.mockResolvedValueOnce(new Map([[customerId, null]]))
    expect(await call('get_customer_store_credit', { venueId, customerId })).toMatchObject({ storeCredit: null, saldo: 0 })
  })
})

describe('change_store_credit_phone (giftCards:manage, confirmación firmada)', () => {
  const args = { venueId, giftCardId, phone: '5512349999' }
  const confirmar = async (extra: Record<string, unknown> = {}) => {
    const preview = await call('change_store_credit_phone', { ...args, ...extra })
    return {
      preview,
      final: () =>
        call('change_store_credit_phone', {
          ...preview.confirmationArguments,
          confirm: true,
          confirmationToken: preview.confirmationToken,
        }),
    }
  }
  it('sin el permiso no escribe', async () => {
    await abrir(scopeCon(['customers:read']))
    expect((await call('change_store_credit_phone', args)).isError).toBe(true)
    expect(mockPhone).not.toHaveBeenCalled()
  })
  it('sin confirmación NO escribe; la vista previa enseña el teléfono actual (últimos 4) y nunca completo', async () => {
    await abrir(scopeCon(TODOS))
    expect(await call('change_store_credit_phone', { ...args, confirm: true })).toMatchObject({ needsInput: true })
    const { preview } = await confirmar()
    expect(preview).toMatchObject({ requiresConfirmation: true, preview: { telefonoActualUltimos4: '1111' } })
    expect(JSON.stringify(preview)).not.toContain('5215512341111')
    expect(mockPhone).not.toHaveBeenCalled()
  })
  it('con la vista previa + token cambia y responde los 4 últimos', async () => {
    await abrir(scopeCon(TODOS))
    const { final } = await confirmar({ expectedPhoneLast4: '1111' })
    expect(await final()).toMatchObject({ ok: true, phoneLast4: '9999' })
    expect(mockPhone).toHaveBeenCalledWith(venueId, giftCardId, { telefono: '5512349999', staffId, expectedPhoneLast4: '1111' })
  })
  it('una tarjeta vendida (no es saldo a favor) responde STORE_CREDIT_PHONE_NOT_ALLOWED desde la vista previa', async () => {
    mockEsSobre.mockResolvedValue(new Set())
    await abrir(scopeCon(TODOS))
    const r = await call('change_store_credit_phone', args)
    expect(r).toMatchObject({ ok: false, code: 'STORE_CREDIT_PHONE_NOT_ALLOWED' })
    expect(r.error).toBe('Esta tarjeta no es un saldo a favor: su destino se cambia con «Cambiar destino».') // el mismo texto del servicio
    expect(mockPhone).not.toHaveBeenCalled()
  })
  it('si el servicio la rechaza al confirmar (código) el código viaja', async () => {
    await abrir(scopeCon(TODOS))
    const { final } = await confirmar()
    mockPhone.mockRejectedValue(new GiftCardError('STORE_CREDIT_PHONE_NOT_ALLOWED', 'Esta tarjeta no es un saldo a favor.', 409))
    expect(await final()).toMatchObject({ ok: false, code: 'STORE_CREDIT_PHONE_NOT_ALLOWED' })
  })
  it('un teléfono inválido no recibe token; el mismo teléfono no pide confirmación', async () => {
    await abrir(scopeCon(TODOS))
    expect(await call('change_store_credit_phone', { ...args, phone: '1234567' })).toMatchObject({
      ok: false,
      code: 'GIFT_CARD_PHONE_INVALID',
    })
    expect(await call('change_store_credit_phone', { ...args, phone: '5512341111' })).toMatchObject({ ok: true, sinCambios: true })
    expect(mockPhone).not.toHaveBeenCalled()
  })
  it('S9 I2: la vista previa sin esperado devuelve el actual y la confirmación lo lleva atado al servicio', async () => {
    await abrir(scopeCon(TODOS))
    const { preview, final } = await confirmar()
    expect(preview.expectedPhoneLast4).toBe('1111')
    expect(preview.confirmationArguments.expectedPhoneLast4).toBe('1111')
    await final()
    expect(mockPhone).toHaveBeenCalledWith(venueId, giftCardId, expect.objectContaining({ expectedPhoneLast4: '1111' }))
  })
  it('S9 I2: la vista previa con un esperado que ya no coincide responde OUTDATED de una vez, sin token ni escritura', async () => {
    await abrir(scopeCon(TODOS))
    const r = await call('change_store_credit_phone', { ...args, expectedPhoneLast4: '0000' })
    expect(r).toMatchObject({ ok: false, code: 'STORE_CREDIT_PHONE_OUTDATED' })
    expect(r.confirmationToken).toBeUndefined()
    expect(mockPhone).not.toHaveBeenCalled()
  })
  it('S9 I2: confirmar con un token cuyo esperado ya no coincide da 409 y no escribe', async () => {
    await abrir(scopeCon(TODOS))
    const { final } = await confirmar()
    mockPhone.mockRejectedValue(
      new AppError('El teléfono de este saldo ya cambió: ahora termina en 2222.', 409, true, 'STORE_CREDIT_PHONE_OUTDATED'),
    )
    const r = await final()
    expect(r).toMatchObject({ ok: false, code: 'STORE_CREDIT_PHONE_OUTDATED' })
    expect(mockPhone).toHaveBeenCalledWith(venueId, giftCardId, expect.objectContaining({ expectedPhoneLast4: '1111' }))
  })
  it('un expectedPhoneLast4 viejo responde STORE_CREDIT_PHONE_OUTDATED', async () => {
    await abrir(scopeCon(TODOS))
    const { final } = await confirmar({ expectedPhoneLast4: '0000' })
    mockPhone.mockRejectedValue(
      new AppError('El teléfono de este saldo ya cambió: ahora termina en 1111.', 409, true, 'STORE_CREDIT_PHONE_OUTDATED'),
    )
    expect(await final()).toMatchObject({ ok: false, code: 'STORE_CREDIT_PHONE_OUTDATED' })
  })
  it('una tarjeta de otra sucursal no se toca', async () => {
    mockCard.mockResolvedValue(null)
    await abrir(scopeCon(TODOS))
    expect(await call('change_store_credit_phone', args)).toMatchObject({ ok: false, code: 'STORE_CREDIT_NOT_FOUND' })
    expect(mockCard).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: { in: [venueId] }, id: giftCardId }) }),
    )
    expect(mockPhone).not.toHaveBeenCalled()
  })
})
