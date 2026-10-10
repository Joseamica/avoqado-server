// Herramientas MCP del conector Shopify. Datos inventados: nada real.
// Catálogo, guardia y confirmación REALES; los servicios, simulados. El candado de plan es el REAL de la herramienta: sólo se
// simula el resolvedor de funciones (`venueHasFeatureAccess`), nunca `@/mcp/planGate` (L2).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ConflictError, ForbiddenError, NotFoundError } from '@/errors/AppError'

const mockAudit = jest.fn()
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...a) }))
const mockAccess = jest.fn()
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: (...a: unknown[]) => mockAccess(...a),
}))
const mockOverview = { getShopifyOverview: jest.fn(), listShopifyReviews: jest.fn(), listShopifyIssues: jest.fn() }
jest.mock('@/services/commerce-channels/shopify/shopify.overview.service', () => mockOverview)
const mockResolve = jest.fn()
jest.mock('@/services/commerce-channels/shopify/shopify.reconcile.service', () => ({
  resolveShopifyReview: (...a: unknown[]) => mockResolve(...a),
}))
const mockConnect = { getConnectReview: jest.fn(), requestApplyShopifyConnect: jest.fn(), disconnectShopify: jest.fn() }
jest.mock('@/services/commerce-channels/shopify/shopify.connect.service', () => mockConnect)
const mockPanel = { getShopifyReviewPreview: jest.fn(), requestShopifyResync: jest.fn() }
jest.mock('@/services/commerce-channels/shopify/shopify.dashboard.service', () => mockPanel)

import { configureToolCatalog } from '@/mcp/catalog'
import type { McpScope } from '@/mcp/scope'
import { registerShopifyTools } from '@/mcp/tools/shopify'

const DUENO = { role: 'OWNER', corePermissions: ['*:*'], isSuperAdmin: false }
const TODAS = [
  'shopify_connect_apply',
  'shopify_connect_preview',
  'shopify_disconnect',
  'shopify_resync',
  'shopify_review_list',
  'shopify_review_resolve',
  'shopify_status',
  'shopify_unmatched_list',
]
const scopeDe = (staffId: string, scopes: string[], acceso = DUENO, permitidos = ['centro', 'norte']) =>
  ({
    staffId,
    activeOrg: 'org',
    allowedVenueIds: permitidos,
    scopes,
    perVenueAccess: new Map([
      ['centro', acceso],
      ['norte', acceso],
    ]),
  }) as unknown as McpScope

const abiertos: Array<() => Promise<void>> = []
async function conectar(staffId = 'dueno', scopes = ['mcp:read', 'mcp:write'], acceso = DUENO, permitidos = ['centro', 'norte']) {
  const server = new McpServer({ name: 'shopify-prueba', version: '1' })
  const scope = scopeDe(staffId, scopes, acceso, permitidos)
  configureToolCatalog(server, scope)
  registerShopifyTools(server, scope)
  const client = new Client({ name: 'prueba', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  abiertos.push(async () => {
    await client.close()
    await server.close()
  })
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args })
    const crudo = (r.content as Array<{ text: string }>)[0].text
    try {
      return { ...JSON.parse(crudo), isError: r.isError === true }
    } catch {
      return { texto: crudo, isError: r.isError === true }
    }
  }
  return { client, call }
}
/** Primera llamada (vista previa) y segunda con los argumentos y el token que firmó el catálogo. */
async function enDosPasos(call: Awaited<ReturnType<typeof conectar>>['call'], name: string, args: Record<string, unknown>) {
  const p = await call(name, args)
  return { p, r: await call(name, { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken }) }
}

/** [herramienta, permiso exacto, argumentos mínimos] */
const CASOS: Array<[string, string, Record<string, unknown>]> = [
  ['shopify_status', 'inventory:read', { venueId: 'centro' }],
  ['shopify_review_list', 'inventory:read', { venueId: 'centro' }],
  ['shopify_unmatched_list', 'inventory:read', { venueId: 'centro' }],
  ['shopify_connect_preview', 'settings:manage', { venueId: 'centro' }],
  ['shopify_review_resolve', 'inventory:adjust', { venueId: 'centro', reviewId: 'r1', choice: 'SHOPIFY' }],
  ['shopify_resync', 'settings:manage', { venueId: 'centro' }],
  ['shopify_connect_apply', 'settings:manage', { venueId: 'centro' }],
  ['shopify_disconnect', 'settings:manage', { venueId: 'centro' }],
]

const VISTA = { reviewId: 'r1', producto: 'Camisa · M', sku: 'CAM-M', avoqadoQty: '5', shopifyQty: 4, suggestion: 'SHOPIFY' }
const RESUMEN = { emparejados: 30, cambian: 4, nuevos: 2, sinPareja: 1 }
const CONEXION = {
  shopDomain: 'mi-tienda.myshopify.com',
  locationName: 'Tienda México',
  estado: 'POR_APLICAR',
  conteos: { pendientes: 2, porRevisar: 3 },
}
const PILOTO = 'El conector con Shopify está en piloto por invitación y este local no lo tiene activo; escríbenos para sumarte.'

beforeEach(() => {
  jest.clearAllMocks()
  mockAccess.mockResolvedValue(true)
  mockPanel.getShopifyReviewPreview.mockResolvedValue(VISTA)
  mockPanel.requestShopifyResync.mockResolvedValue({ programado: true })
  mockResolve.mockResolvedValue({ estado: 'RESUELTO' })
  mockOverview.getShopifyOverview.mockResolvedValue({ planActive: true, connection: CONEXION })
  mockOverview.listShopifyReviews.mockResolvedValue({ items: [], total: 0, nextOffset: null })
  mockOverview.listShopifyIssues.mockResolvedValue({ items: [], total: 0, nextOffset: null })
  mockConnect.getConnectReview.mockResolvedValue({ items: [], total: 30, nextOffset: 20, resumen: RESUMEN })
  mockConnect.requestApplyShopifyConnect.mockResolvedValue({ applyRequestedAt: new Date('2026-10-08T12:00:00.000Z') })
  mockConnect.disconnectShopify.mockResolvedValue({ desconectada: true })
})
afterEach(async () => {
  while (abiertos.length) await abiertos.pop()!()
})

describe('herramientas MCP de Shopify', () => {
  it('registra las 8 herramientas', async () => {
    const { client } = await conectar()
    expect(
      (await client.listTools()).tools
        .map(t => t.name)
        .filter(n => n.startsWith('shopify_'))
        .sort(),
    ).toEqual(TODAS)
  })

  it('con sólo lectura: se anuncian las cuatro lecturas (la vista previa incluida) y ninguna escritura', async () => {
    const { client, call } = await conectar('dueno', ['mcp:read'])
    const nombres = (await client.listTools()).tools.map(t => t.name).filter(n => n.startsWith('shopify_'))
    expect(nombres.sort()).toEqual(['shopify_connect_preview', 'shopify_review_list', 'shopify_status', 'shopify_unmatched_list'])
    expect(await call('shopify_connect_preview', { venueId: 'centro', offset: 20, filtro: 'NUEVOS' })).toMatchObject({
      ok: true,
      total: 30,
      resumen: RESUMEN,
    })
    expect(mockConnect.getConnectReview).toHaveBeenCalledWith({ venueId: 'centro', offset: 20, limit: 20, filtro: 'NUEVOS' })
    expect(mockAccess).not.toHaveBeenCalled()
  })

  it('el estado no pasa por el candado del plan (la pausa se ve) y respeta el alcance', async () => {
    const { call } = await conectar()
    expect(await call('shopify_status', { venueId: 'centro' })).toMatchObject({ ok: true, venueId: 'centro', planActive: true })
    expect(mockAccess).not.toHaveBeenCalled()
    expect((await call('shopify_status', { venueId: 'otro-negocio' })).isError).toBe(true)
    expect(mockOverview.getShopifyOverview).toHaveBeenCalledTimes(1)
  })

  it('las listas pasan página, búsqueda y motivo', async () => {
    const { call } = await conectar()
    await call('shopify_review_list', { venueId: 'centro', q: 'camisa' })
    expect(mockOverview.listShopifyReviews).toHaveBeenCalledWith('centro', { offset: 0, limit: 20, q: 'camisa' })
    await call('shopify_unmatched_list', { venueId: 'centro', offset: 20, limit: 50, reason: 'SIN_SKU' })
    expect(mockOverview.listShopifyIssues).toHaveBeenCalledWith('centro', { offset: 20, limit: 50, q: undefined, reason: 'SIN_SKU' })
  })

  describe('permiso exacto de cada herramienta (con todos los demás, pero sin ése, no pasa; sólo con ése, sí)', () => {
    const TODOS = ['inventory:read', 'inventory:adjust', 'settings:manage']
    const conPermisos = (corePermissions: string[]) => ({ ...DUENO, role: 'MANAGER', corePermissions })

    it.each(CASOS)('%s exige %s', async (name, permiso, args) => {
      const sin = await conectar('persona', ['mcp:read', 'mcp:write'], conPermisos(TODOS.filter(p => p !== permiso)))
      const negada = await sin.call(name, args)
      expect(negada).toMatchObject({ isError: true, texto: expect.stringContaining(`Missing permission ${permiso}`) })
      const solo = await conectar('persona', ['mcp:read', 'mcp:write'], conPermisos([permiso]))
      const ok = await solo.call(name, args)
      expect(ok.texto).toBeUndefined()
    })

    it('ninguna herramienta llegó a un servicio estando negada (las escrituras, con una confirmación VÁLIDA de la misma persona)', async () => {
      const ESCRITURAS = ['shopify_review_resolve', 'shopify_resync', 'shopify_connect_apply', 'shopify_disconnect']
      for (const [name, permiso, args] of CASOS) {
        let llamada: Record<string, unknown> = args
        if (ESCRITURAS.includes(name)) {
          // Con todos los permisos, la misma persona pide la vista previa y recibe su token firmado: la llamada de abajo
          // trae confirm:true y un token que el catálogo ACEPTA, así que sólo el permiso puede detenerla.
          const completo = await conectar('persona', ['mcp:read', 'mcp:write'], conPermisos(TODOS))
          const p = await completo.call(name, args)
          expect(p.confirmationToken).toEqual(expect.any(String))
          llamada = { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken }
        }
        jest.clearAllMocks() // lo que cuenta es lo que pasa DESPUÉS de negar
        const sin = await conectar('persona', ['mcp:read', 'mcp:write'], conPermisos(TODOS.filter(p => p !== permiso)))
        expect(await sin.call(name, llamada)).toMatchObject({
          isError: true,
          texto: expect.stringContaining(`Missing permission ${permiso}`),
        })
        expect(mockOverview.getShopifyOverview).not.toHaveBeenCalled()
        expect(mockOverview.listShopifyReviews).not.toHaveBeenCalled()
        expect(mockOverview.listShopifyIssues).not.toHaveBeenCalled()
        expect(mockConnect.getConnectReview).not.toHaveBeenCalled()
        expect(mockPanel.getShopifyReviewPreview).not.toHaveBeenCalled()
        expect(mockPanel.requestShopifyResync).not.toHaveBeenCalled()
        expect(mockResolve).not.toHaveBeenCalled()
        expect(mockConnect.requestApplyShopifyConnect).not.toHaveBeenCalled()
        expect(mockConnect.disconnectShopify).not.toHaveBeenCalled()
        expect(mockAccess).not.toHaveBeenCalled()
        expect(mockAudit).not.toHaveBeenCalled()
      }
    })
  })

  it.each(CASOS)(
    '🔴 %s: un local que tiene acceso pero no está en el alcance de la conexión se niega ANTES de tocar nada',
    async (name, _permiso, args) => {
      // `perVenueAccess` conoce a «norte» (permiso de sobra), pero la conexión se limitó a «centro».
      const { call } = await conectar('dueno', ['mcp:read', 'mcp:write'], DUENO, ['centro'])
      const r = await call(name, { ...args, venueId: 'norte' })
      expect(r).toMatchObject({ isError: true, texto: expect.stringContaining('is not in your scope') })
      expect(mockAccess).not.toHaveBeenCalled()
      expect(mockOverview.getShopifyOverview).not.toHaveBeenCalled()
      expect(mockOverview.listShopifyReviews).not.toHaveBeenCalled()
      expect(mockOverview.listShopifyIssues).not.toHaveBeenCalled()
      expect(mockConnect.getConnectReview).not.toHaveBeenCalled()
      expect(mockPanel.getShopifyReviewPreview).not.toHaveBeenCalled()
    },
  )

  describe('Z14 · tope de las lecturas', () => {
    it('limit mayor a 50 o desplazamiento fuera de tope: se rechazan en español, sin llamar al servicio', async () => {
      const { call } = await conectar()
      const largo = await call('shopify_review_list', { venueId: 'centro', limit: 51 })
      expect(largo.isError).toBe(true)
      expect(largo.texto).toContain('El límite máximo es 50')
      const lejos = await call('shopify_unmatched_list', { venueId: 'centro', offset: 100_001 })
      expect(lejos.isError).toBe(true)
      expect(lejos.texto).toContain('El desplazamiento máximo es 100000')
      const vista = await call('shopify_connect_preview', { venueId: 'centro', limit: 500 })
      expect(vista.isError).toBe(true)
      expect(mockOverview.listShopifyReviews).not.toHaveBeenCalled()
      expect(mockOverview.listShopifyIssues).not.toHaveBeenCalled()
      expect(mockConnect.getConnectReview).not.toHaveBeenCalled()
    })

    it('las listas sólo consultan el local pedido, y uno fuera de alcance ni llega al servicio', async () => {
      const { call } = await conectar()
      for (const name of ['shopify_review_list', 'shopify_unmatched_list', 'shopify_connect_preview']) {
        expect((await call(name, { venueId: 'otro-negocio' })).isError).toBe(true)
      }
      expect(mockOverview.listShopifyReviews).not.toHaveBeenCalled()
      expect(mockOverview.listShopifyIssues).not.toHaveBeenCalled()
      expect(mockConnect.getConnectReview).not.toHaveBeenCalled()
    })
  })

  describe('L10 · el motivo es un enum', () => {
    it('un motivo que no existe se rechaza con mensaje en español y no llega al servicio', async () => {
      const { call } = await conectar()
      const r = await call('shopify_unmatched_list', { venueId: 'centro', reason: 'INVENTADO' })
      expect(r.isError).toBe(true)
      expect(r.texto).toContain('Motivo no reconocido')
      expect(mockOverview.listShopifyIssues).not.toHaveBeenCalled()
    })
  })

  describe('L12 · descripciones del catálogo', () => {
    it('las tres lecturas con fechas dicen que son UTC con Z; la vista previa no nombra campos entre comillas inversas', async () => {
      const { client } = await conectar()
      const d = new Map((await client.listTools()).tools.map(t => [t.name, t.description ?? '']))
      for (const n of ['shopify_status', 'shopify_review_list', 'shopify_unmatched_list']) {
        expect(d.get(n)).toContain('fechas en UTC, ISO con Z')
      }
      expect(d.get('shopify_connect_preview')).not.toContain('`')
      expect(d.get('shopify_connect_preview')).toContain('quedara')
    })
  })

  it('resolver sin confirmar: sólo la vista previa, con las cantidades fijadas en la confirmación', async () => {
    const { call } = await conectar()
    const p = await call('shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'SHOPIFY' })
    expect(p).toMatchObject({ ok: false, requiresConfirmation: true, producto: 'Camisa · M', avoqado: '5', shopify: 4, quedara: '4' })
    expect(p.confirmationToken).toEqual(expect.any(String))
    expect(p.confirmationArguments).toEqual({
      venueId: 'centro',
      reviewId: 'r1',
      choice: 'SHOPIFY',
      expectedAvoqadoQty: '5',
      expectedShopifyQty: 4,
    })
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('L18 · la vista previa dice qué número cambia: «usar Shopify» mueve Avoqado; «usar Avoqado» manda la diferencia a Shopify', async () => {
    const { call } = await conectar()
    const s = await call('shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'SHOPIFY' })
    expect(s.cambio).toBe('Avoqado 5 → 4')
    const a = await call('shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'AVOQADO' })
    expect(a.cambio).toBe('Shopify 4 → 5, se envía 1')
    // Con signo: A=3, S=4 ⇒ se envía −1 (Shopify baja una pieza).
    mockPanel.getShopifyReviewPreview.mockResolvedValue({ ...VISTA, avoqadoQty: '3' })
    const neg = await call('shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'AVOQADO' })
    expect(neg.cambio).toBe('Shopify 4 → 3, se envía -1')
  })

  it('«usar Avoqado» con una diferencia que no es de piezas enteras: lo dice desde la vista previa, sin token; «usar Shopify» sí se puede', async () => {
    mockPanel.getShopifyReviewPreview.mockResolvedValue({ ...VISTA, avoqadoQty: '2.5' })
    const { call } = await conectar()
    const a = await call('shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'AVOQADO' })
    expect(a).toMatchObject({ ok: false, codigo: 'SHOPIFY_DIFERENCIA_NO_ENTERA' })
    expect(a.error).toContain('piezas enteras')
    expect(a.error).toContain('-1.5')
    expect(a.requiresConfirmation).toBeUndefined()
    expect(a.confirmationToken).toBeUndefined()
    const s = await call('shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'SHOPIFY' })
    expect(s).toMatchObject({ requiresConfirmation: true, cambio: 'Avoqado 2.5 → 4' })
    expect(s.confirmationToken).toEqual(expect.any(String))
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('resolver confirmado con el token y los argumentos de la vista previa: aplica, con quién eligió', async () => {
    const { call } = await conectar()
    const { r } = await enDosPasos(call, 'shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'SHOPIFY' })
    expect(r).toMatchObject({ ok: true, reviewId: 'r1', eleccion: 'SHOPIFY', estado: 'RESUELTO' })
    expect(mockResolve).toHaveBeenCalledWith({
      venueId: 'centro',
      reviewId: 'r1',
      choice: 'SHOPIFY',
      expectedAvoqadoQty: '5',
      expectedShopifyQty: 4,
      staffId: 'dueno',
    })
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'dueno' }),
      expect.objectContaining({ action: 'MCP_SHOPIFY_REVIEW_RESOLVED', entityId: 'r1', venueId: 'centro' }),
    )
  })

  it('🔴 L18 · si las cantidades cambiaron (409), no es un error pelón: pide la vista previa otra vez y no audita', async () => {
    mockResolve.mockRejectedValue(
      new ConflictError('Los números cambiaron desde que los viste: ya se muestran los de ahora', 'SHOPIFY_REVISION_CAMBIO'),
    )
    const { call } = await conectar()
    const { r } = await enDosPasos(call, 'shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'SHOPIFY' })
    expect(r).toMatchObject({ ok: false, needsInput: true, question: 'Las cantidades cambiaron; pide la vista previa otra vez' })
    expect(r.isError).toBe(false)
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('🔴 el token de OTRA sucursal no sirve', async () => {
    const { call } = await conectar()
    const p = await call('shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'SHOPIFY' })
    const r = await call('shopify_review_resolve', {
      ...p.confirmationArguments,
      venueId: 'norte',
      confirm: true,
      confirmationToken: p.confirmationToken,
    })
    expect(r).toMatchObject({ needsInput: true, field: 'confirmationToken' })
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('🔴 el token de OTRA operación no sirve (el de pedir cuadre no resuelve una diferencia)', async () => {
    const { call } = await conectar()
    const cuadre = await call('shopify_resync', { venueId: 'centro' })
    const r = await call('shopify_review_resolve', {
      venueId: 'centro',
      reviewId: 'r1',
      choice: 'SHOPIFY',
      expectedAvoqadoQty: '5',
      expectedShopifyQty: 4,
      confirm: true,
      confirmationToken: cuadre.confirmationToken,
    })
    expect(r).toMatchObject({ needsInput: true })
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('🔴 el token de OTRO usuario no sirve', async () => {
    const dueno = await conectar('dueno')
    const otro = await conectar('otra-persona')
    const p = await dueno.call('shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'SHOPIFY' })
    const r = await otro.call('shopify_review_resolve', {
      ...p.confirmationArguments,
      confirm: true,
      confirmationToken: p.confirmationToken,
    })
    expect(r).toMatchObject({ needsInput: true })
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('🔴 cambiar a mano una cantidad de la vista previa invalida el token', async () => {
    const { call } = await conectar()
    const p = await call('shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'SHOPIFY' })
    const r = await call('shopify_review_resolve', {
      ...p.confirmationArguments,
      expectedShopifyQty: 9,
      confirm: true,
      confirmationToken: p.confirmationToken,
    })
    expect(r).toMatchObject({ needsInput: true })
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('🔴 confirmar sin token no aplica nada (ninguna de las cuatro escrituras)', async () => {
    const { call } = await conectar()
    const sinToken = [
      call('shopify_review_resolve', {
        venueId: 'centro',
        reviewId: 'r1',
        choice: 'SHOPIFY',
        expectedAvoqadoQty: '5',
        expectedShopifyQty: 4,
        confirm: true,
      }),
      call('shopify_resync', { venueId: 'centro', confirm: true }),
      call('shopify_connect_apply', { venueId: 'centro', confirm: true }),
      call('shopify_disconnect', { venueId: 'centro', confirm: true }),
    ]
    for (const r of await Promise.all(sinToken)) expect(r).toMatchObject({ needsInput: true, field: 'confirmationToken' })
    expect(mockResolve).not.toHaveBeenCalled()
    expect(mockPanel.requestShopifyResync).not.toHaveBeenCalled()
    expect(mockConnect.requestApplyShopifyConnect).not.toHaveBeenCalled()
    expect(mockConnect.disconnectShopify).not.toHaveBeenCalled()
  })

  it('pedir cuadre en dos pasos: primero explica, luego programa', async () => {
    const { call } = await conectar()
    const { p, r } = await enDosPasos(call, 'shopify_resync', { venueId: 'centro' })
    expect(p).toMatchObject({ ok: false, requiresConfirmation: true })
    expect(r).toMatchObject({ ok: true, programado: true })
    expect(mockPanel.requestShopifyResync).toHaveBeenCalledTimes(1)
    expect(mockPanel.requestShopifyResync).toHaveBeenCalledWith({ venueId: 'centro', staffId: 'dueno' })
  })

  it('pedir cuadre con la conexión sin activar (409 SHOPIFY_NO_ACTIVA): lo dice en claro, sin error y sin auditar', async () => {
    mockPanel.requestShopifyResync.mockRejectedValue(new ConflictError('texto del servicio', 'SHOPIFY_NO_ACTIVA'))
    const { call } = await conectar()
    const { r } = await enDosPasos(call, 'shopify_resync', { venueId: 'centro' })
    expect(r).toMatchObject({ ok: false, codigo: 'SHOPIFY_NO_ACTIVA' })
    expect(r.error).toMatch(/no está activa/)
    expect(r.error).toContain('shopify_status')
    expect(r.texto).toBeUndefined() // JSON de la herramienta, no el mensaje crudo de una excepción
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('un error de negocio de Shopify (código SHOPIFY_*) vuelve como ok:false con su texto; uno ajeno sigue lanzando', async () => {
    mockConnect.requestApplyShopifyConnect.mockRejectedValue(
      new ConflictError('La vista previa todavía no está lista, o ya se aplicó', 'SHOPIFY_NO_EN_REVISION'),
    )
    const { call } = await conectar()
    const { r } = await enDosPasos(call, 'shopify_connect_apply', { venueId: 'centro' })
    expect(r).toMatchObject({
      ok: false,
      codigo: 'SHOPIFY_NO_EN_REVISION',
      error: 'La vista previa todavía no está lista, o ya se aplicó',
    })
    expect(r.texto).toBeUndefined()
    expect(mockAudit).not.toHaveBeenCalled()

    mockConnect.requestApplyShopifyConnect.mockRejectedValue(new Error('boom interno'))
    const { r: ajeno } = await enDosPasos(call, 'shopify_connect_apply', { venueId: 'centro' })
    // Lanzado: aquí no hay instrumento, así que el SDK entrega el mensaje crudo (en producción `instrumentTools` lo sanea).
    expect(ajeno).toMatchObject({ isError: true, texto: expect.stringContaining('boom interno') })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('una diferencia que ya no existe en la vista previa de resolver: el error de negocio vuelve como ok:false', async () => {
    mockPanel.getShopifyReviewPreview.mockRejectedValue(
      new NotFoundError('No encontré esa diferencia en este negocio.', 'SHOPIFY_REVISION_NO_EXISTE'),
    )
    const { call } = await conectar()
    const p = await call('shopify_review_resolve', { venueId: 'centro', reviewId: 'nope', choice: 'SHOPIFY' })
    expect(p).toMatchObject({ ok: false, codigo: 'SHOPIFY_REVISION_NO_EXISTE', error: 'No encontré esa diferencia en este negocio.' })
    expect(p.confirmationToken).toBeUndefined()
  })

  it('aplicar la conexión en dos pasos: la vista previa enseña el resumen; confirmado, pide aplicar y lo audita', async () => {
    const { call } = await conectar()
    const { p, r } = await enDosPasos(call, 'shopify_connect_apply', { venueId: 'centro' })
    expect(p).toMatchObject({ ok: false, requiresConfirmation: true, resumen: RESUMEN })
    expect(mockConnect.getConnectReview).toHaveBeenCalledWith({ venueId: 'centro', offset: 0, limit: 1, filtro: 'CAMBIAN' })
    expect(r).toMatchObject({ ok: true, solicitado: true })
    expect(mockConnect.requestApplyShopifyConnect).toHaveBeenCalledTimes(1)
    expect(mockConnect.requestApplyShopifyConnect).toHaveBeenCalledWith({ venueId: 'centro', staffId: 'dueno' })
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'MCP_SHOPIFY_CONNECT_APPLIED', venueId: 'centro' }),
    )
  })

  it.each(['IMPORTANDO', 'APLICANDO', 'ACTIVA', 'PAUSADA', 'REVOCADA'])(
    'aplicar con la conexión en %s: lo dice en claro, sin token ni resumen',
    async estado => {
      mockOverview.getShopifyOverview.mockResolvedValue({ planActive: true, connection: { ...CONEXION, estado } })
      const { call } = await conectar()
      const p = await call('shopify_connect_apply', { venueId: 'centro' })
      expect(p).toMatchObject({ ok: false, estado, error: expect.stringMatching(/.{25,}/) })
      expect(p.requiresConfirmation).toBeUndefined()
      expect(p.confirmationToken).toBeUndefined()
      expect(mockConnect.getConnectReview).not.toHaveBeenCalled()
      expect(mockConnect.requestApplyShopifyConnect).not.toHaveBeenCalled()
    },
  )

  it('aplicar un local sin tienda conectada: lo dice y no pide confirmación', async () => {
    mockOverview.getShopifyOverview.mockResolvedValue({ planActive: true, connection: null })
    const { call } = await conectar()
    const p = await call('shopify_connect_apply', { venueId: 'centro' })
    expect(p).toMatchObject({ ok: false, error: 'Este local no tiene una tienda Shopify conectada.' })
    expect(p.confirmationToken).toBeUndefined()
    expect(mockConnect.getConnectReview).not.toHaveBeenCalled()
  })

  it('🔴 aplicar con el token de OTRA sucursal no aplica nada', async () => {
    const { call } = await conectar()
    const p = await call('shopify_connect_apply', { venueId: 'centro' })
    const r = await call('shopify_connect_apply', { venueId: 'norte', confirm: true, confirmationToken: p.confirmationToken })
    expect(r).toMatchObject({ needsInput: true })
    expect(mockConnect.requestApplyShopifyConnect).not.toHaveBeenCalled()
  })

  it('desconectar en dos pasos y SIN candado de plan: quien lo perdió siempre puede salir', async () => {
    mockAccess.mockResolvedValue(false)
    const { call } = await conectar()
    const { p, r } = await enDosPasos(call, 'shopify_disconnect', { venueId: 'centro' })
    expect(p).toMatchObject({
      ok: false,
      requiresConfirmation: true,
      tienda: 'mi-tienda.myshopify.com',
      ubicacion: 'Tienda México',
      cambiosEnCamino: 2,
      porRevisar: 3,
    })
    expect(p.explicacion).toContain('«Por revisar»')
    // La confirmación queda atada a la tienda y la ubicación que se vieron.
    expect(p.confirmationArguments).toEqual({ venueId: 'centro', expectedSourceFingerprint: 'mi-tienda.myshopify.com|Tienda México' })
    expect(r).toMatchObject({ ok: true, desconectada: true })
    expect(mockConnect.disconnectShopify).toHaveBeenCalledWith({ venueId: 'centro', staffId: 'dueno' })
    expect(mockAccess).not.toHaveBeenCalled()
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'MCP_SHOPIFY_DISCONNECTED', venueId: 'centro' }),
    )
  })

  it.each([
    ['la tienda', { shopDomain: 'otra-tienda.myshopify.com' }],
    ['la ubicación', { locationName: 'Bodega Norte' }],
  ])(
    '🔴 desconectar: si cambió %s entre la vista previa y la confirmación, pide otra vista previa y no desconecta',
    async (_que, cambio) => {
      const { call } = await conectar()
      const p = await call('shopify_disconnect', { venueId: 'centro' })
      mockOverview.getShopifyOverview.mockResolvedValue({ planActive: true, connection: { ...CONEXION, ...cambio } })
      const r = await call('shopify_disconnect', { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })
      expect(r).toMatchObject({ ok: false, needsInput: true })
      expect(r.question).toContain('otra vez')
      expect(mockConnect.disconnectShopify).not.toHaveBeenCalled()
      expect(mockAudit).not.toHaveBeenCalled()
    },
  )

  it('desconectar: si la tienda ya no está al confirmar, lo dice y no llama al servicio', async () => {
    const { call } = await conectar()
    const p = await call('shopify_disconnect', { venueId: 'centro' })
    mockOverview.getShopifyOverview.mockResolvedValue({ planActive: true, connection: null })
    const r = await call('shopify_disconnect', { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })
    expect(r).toMatchObject({ ok: false, error: 'Este local no tiene una tienda Shopify conectada.' })
    expect(mockConnect.disconnectShopify).not.toHaveBeenCalled()
  })

  it('🔴 la huella de la tienda es parte del token: cambiarla a mano lo invalida', async () => {
    const { call } = await conectar()
    const p = await call('shopify_disconnect', { venueId: 'centro' })
    const r = await call('shopify_disconnect', {
      venueId: 'centro',
      expectedSourceFingerprint: 'otra|cosa',
      confirm: true,
      confirmationToken: p.confirmationToken,
    })
    expect(r).toMatchObject({ needsInput: true, field: 'confirmationToken' })
    expect(mockConnect.disconnectShopify).not.toHaveBeenCalled()
  })

  it('desconectar con un nombre de ubicación larguísimo: la huella (tienda|ubicación) cabe en el campo y la confirmación pasa', async () => {
    // `locationName` no tiene tope en Shopify: una huella de 600+ caracteres tiene que pasar la validación (era max(300)).
    mockOverview.getShopifyOverview.mockResolvedValue({ planActive: true, connection: { ...CONEXION, locationName: 'B'.repeat(600) } })
    const { call } = await conectar()
    const { p, r } = await enDosPasos(call, 'shopify_disconnect', { venueId: 'centro' })
    expect(p.confirmationArguments.expectedSourceFingerprint.length).toBeGreaterThan(600)
    expect(r).toMatchObject({ ok: true, desconectada: true })
    expect(mockConnect.disconnectShopify).toHaveBeenCalledWith({ venueId: 'centro', staffId: 'dueno' })
  })

  it('desconectar cuando ya no había nada que desconectar (otra persona se adelantó): lo dice y no audita', async () => {
    mockConnect.disconnectShopify.mockResolvedValue({ desconectada: false })
    const { call } = await conectar()
    const { r } = await enDosPasos(call, 'shopify_disconnect', { venueId: 'centro' })
    expect(r).toMatchObject({ ok: true, desconectada: false })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('desconectar un local sin tienda conectada: lo dice y no pide confirmación', async () => {
    mockOverview.getShopifyOverview.mockResolvedValue({ planActive: true, connection: null })
    const { call } = await conectar()
    const p = await call('shopify_disconnect', { venueId: 'centro' })
    expect(p).toMatchObject({ ok: false, error: 'Este local no tiene una tienda Shopify conectada.' })
    expect(p.confirmationToken).toBeUndefined()
  })

  describe('L2 · el candado de plan es el de una función en piloto, no un anuncio de venta', () => {
    it('sin el conector, resolver, cuadrar y aplicar lo dicen y ni muestran la vista previa', async () => {
      mockAccess.mockResolvedValue(false)
      const { call } = await conectar()
      for (const [name, args] of [
        ['shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'AVOQADO' }],
        ['shopify_resync', { venueId: 'centro' }],
        ['shopify_connect_apply', { venueId: 'centro' }],
      ] as const) {
        expect(await call(name, args)).toMatchObject({ ok: false, planRequired: true, error: PILOTO })
      }
      expect(mockAccess).toHaveBeenCalledWith('centro', 'SHOPIFY_INTEGRATION')
      expect(mockPanel.getShopifyReviewPreview).not.toHaveBeenCalled()
      expect(mockConnect.getConnectReview).not.toHaveBeenCalled()
    })

    it('🔴 el texto de la negativa (el de la función real, con el resolvedor simulado) no promete ni «plan» ni «Premium»', async () => {
      mockAccess.mockResolvedValue(false)
      const { call } = await conectar()
      const textos = [
        (await call('shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'AVOQADO' })).error,
        (await call('shopify_resync', { venueId: 'centro' })).error,
        (await call('shopify_connect_apply', { venueId: 'centro' })).error,
      ]
      for (const t of textos) {
        expect(t).toContain('piloto por invitación')
        expect(t).not.toMatch(/plan|premium|suscri|compr|pagar|subir/i)
      }
    })

    it('🔴 SHOPIFY_SIN_PLAN que viene del servicio se dice con el texto de piloto del MCP, diga lo que diga el servicio', async () => {
      const deServicio = (m: string) => new ForbiddenError(m, 'SHOPIFY_SIN_PLAN')
      // El texto de hoy del servicio (M2) y uno cualquiera: manda el código, nunca el mensaje.
      mockResolve.mockRejectedValue(deServicio('El conector con Shopify no está activo en este local (piloto por invitación).'))
      mockConnect.requestApplyShopifyConnect.mockRejectedValue(deServicio('texto que el MCP no debe repetir'))
      const { call } = await conectar()
      const resolver = (await enDosPasos(call, 'shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'SHOPIFY' })).r
      const aplicar = (await enDosPasos(call, 'shopify_connect_apply', { venueId: 'centro' })).r
      for (const r of [resolver, aplicar]) {
        expect(r).toMatchObject({ ok: false, planRequired: true, error: PILOTO })
        expect(r.codigo).toBeUndefined()
      }
      expect(mockAudit).not.toHaveBeenCalled()
    })

    it('🔴 ninguna descripción, vista previa ni negativa de Shopify habla de «plan» ni «Premium»', async () => {
      const PROHIBIDO = /\bplan\b|premium|actívalo|suscri/i
      const { client, call } = await conectar()
      const tools = (await client.listTools()).tools.filter(x => x.name.startsWith('shopify_'))
      expect(tools).toHaveLength(8)
      for (const t of tools) expect(`${t.name}: ${t.description ?? ''}`).not.toMatch(PROHIBIDO)
      const cadenas = (r: Record<string, unknown>) => Object.values(r).filter((v): v is string => typeof v === 'string')
      const salidas: Array<Record<string, unknown>> = []
      // Vistas previas (la del cuadre habla de cuándo corre).
      salidas.push(await call('shopify_resync', { venueId: 'centro' }))
      salidas.push(await call('shopify_connect_apply', { venueId: 'centro' }))
      salidas.push(await call('shopify_disconnect', { venueId: 'centro' }))
      // Negativa del candado.
      mockAccess.mockResolvedValue(false)
      salidas.push(await call('shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'AVOQADO' }))
      salidas.push(await call('shopify_resync', { venueId: 'centro' }))
      salidas.push(await call('shopify_connect_apply', { venueId: 'centro' }))
      expect(salidas.every(x => cadenas(x).length > 0)).toBe(true)
      for (const x of salidas) for (const c of cadenas(x)) expect(c).not.toMatch(PROHIBIDO)
    })

    it('con el conector concedido pasa el candado y el resolvedor se pregunta por el local pedido', async () => {
      const { call } = await conectar()
      await call('shopify_resync', { venueId: 'norte' })
      expect(mockAccess).toHaveBeenCalledWith('norte', 'SHOPIFY_INTEGRATION')
    })
  })

  it('«usar Avoqado» con el envío pendiente lo dice así', async () => {
    mockResolve.mockResolvedValue({ estado: 'ENVIO_PENDIENTE' })
    const { call } = await conectar()
    const { p, r } = await enDosPasos(call, 'shopify_review_resolve', { venueId: 'centro', reviewId: 'r1', choice: 'AVOQADO' })
    expect(p.quedara).toBe('5')
    expect(r).toMatchObject({ ok: true, estado: 'ENVIO_PENDIENTE', mensaje: 'Elección guardada; se enviará a Shopify en unos segundos.' })
  })
})
