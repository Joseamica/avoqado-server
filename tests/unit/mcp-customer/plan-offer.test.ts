/**
 * Planes editables B1 (Task 10): las tres herramientas del MCP de la oferta de planes (`get_plan_offer`, `publish_plan_offer`,
 * `resolve_pending_plan_offer`). Sólo SUPERADMIN, sólo en el modo libre. Dinero que se LEE en pesos; la `entrada` que se publica
 * es la del editor (centavos SIN IVA) y el token de confirmación la ata junto con `expectedRevision`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog, TOOL_EFFECTS } from '@/mcp/catalog'
import { DIRECTORY_TOOLS } from '@/mcp/directory/catalog'
import { registerAllTools } from '@/mcp/server'
import { registerPlanOfferTools } from '@/mcp/tools/planOffer'
import type { McpScope } from '@/mcp/scope'
import { auditMcpWrite } from '@/mcp/audit'
import { ConflictError } from '@/errors/AppError'
import { planOfferInput } from '@/services/billing/planOffer'
import {
  descartarPublicacion,
  estadoDeLaOferta,
  publicarVersion,
  reintentarPublicacion,
  vistaPreviaDeLaOferta,
} from '@/services/billing/planOfferPublisher'

jest.mock('@/services/billing/planOfferPublisher', () => ({
  estadoDeLaOferta: jest.fn(),
  vistaPreviaDeLaOferta: jest.fn(),
  publicarVersion: jest.fn(),
  reintentarPublicacion: jest.fn(),
  descartarPublicacion: jest.fn(),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))

const TOOLS = ['get_plan_offer', 'publish_plan_offer', 'resolve_pending_plan_offer']
const superadmin = {
  staffId: 'staff-1',
  activeOrg: 'org-1',
  allowedVenueIds: [],
  perVenueAccess: new Map(),
  scopes: ['mcp:read', 'mcp:write'],
  isSuperAdmin: true,
} as unknown as McpScope

const precio = (netCents: number) => ({ netCents, grossCents: Math.round((netCents * 116) / 100), stripePriceId: null })
const plan = (displayName: string, mensual: number, anual: number) => ({
  displayName,
  onSale: true,
  requiresCard: true,
  trialDays: 30,
  monthly: precio(mensual),
  annual: precio(anual),
  stripeProductName: null,
})
const definition = {
  schemaVersion: 1,
  FREE: { displayName: 'Gratis' },
  PRO: plan('Pro', 79900, 799000),
  PREMIUM: plan('Premium', 139900, 1399000),
}
const entradaVigente = {
  FREE: { displayName: 'Gratis' },
  PRO: { displayName: 'Pro', onSale: true, requiresCard: true, trialDays: 30, monthlyNetCents: 79900, annualNetCents: 799000 },
  PREMIUM: { displayName: 'Premium', onSale: true, requiresCard: true, trialDays: 30, monthlyNetCents: 139900, annualNetCents: 1399000 },
}
const entradaNueva = { ...entradaVigente, PRO: { ...entradaVigente.PRO, monthlyNetCents: 89900 } }
const estado = (extra: Record<string, unknown> = {}) => ({
  revision: 4,
  vigente: {
    number: 2,
    versionId: 'v2',
    definition,
    entrada: entradaVigente,
    publishedAt: new Date('2026-11-01T00:00:00Z'),
    publishedById: 's',
  },
  pendiente: null,
  interruptor: { prendido: false, desde: null, actualizadoPor: null, faltan: ['SERVIDOR_LISTO'] },
  nombresEnStripe: null,
  destinatarios: ['alguien@example.com'],
  ...extra,
})
const vistaPrevia = {
  cambios: [{ plan: 'PRO', campo: 'monthlyNetCents', antes: 79900, despues: 89900 }],
  preciosNuevos: ['PRO:monthly'],
  bloqueos: { campanas: [], promociones: [] },
  conservanSuPrecio: { 'PRO:monthly': 3, 'PRO:annual': 0, 'PREMIUM:monthly': 0, 'PREMIUM:annual': 0 },
  problemas: [],
}

type Handler = (args: any) => Promise<any>
function toolsFor(overrides: Partial<McpScope> = {}) {
  const handlers = new Map<string, Handler>()
  const descriptions = new Map<string, string>()
  const server = {
    tool: (...args: any[]) => {
      handlers.set(args[0], args[args.length - 1])
      descriptions.set(args[0], args[1])
    },
  } as any
  registerPlanOfferTools(server, { ...superadmin, ...overrides })
  return { handlers, descriptions }
}
const call = (name: string, args: object, overrides: Partial<McpScope> = {}) => toolsFor(overrides).handlers.get(name)!(args)
const read = (value: any) => JSON.parse(value.content[0].text)

beforeEach(() => {
  jest.clearAllMocks()
  ;(estadoDeLaOferta as jest.Mock).mockResolvedValue(estado())
  ;(vistaPreviaDeLaOferta as jest.Mock).mockResolvedValue(vistaPrevia)
  ;(publicarVersion as jest.Mock).mockResolvedValue({ number: 3, versionId: 'v3' })
  ;(reintentarPublicacion as jest.Mock).mockResolvedValue({ number: 3, versionId: 'v3' })
  ;(descartarPublicacion as jest.Mock).mockResolvedValue({ revision: 5, pendiente: null, parcial: true })
})

async function conectar(scope: McpScope, registrar: (server: McpServer) => void) {
  const server = new McpServer({ name: 'planes', version: '1' })
  configureToolCatalog(server, scope)
  registrar(server)
  const client = new Client({ name: 'prueba', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return { server, client }
}

describe('catálogo', () => {
  async function listar(scope: McpScope): Promise<string[]> {
    const { server, client } = await conectar(scope, s =>
      registerAllTools(s, scope, { serializedEnabled: true, whiteLabelEnabled: true, catalogEnabled: true }),
    )
    try {
      return (await client.listTools()).tools.map(t => t.name)
    } finally {
      await client.close()
      await server.close()
    }
  }

  it('tools/list de un SUPERADMIN incluye las tres; la de un OWNER con mcp:write no', async () => {
    const nombres = await listar(superadmin)
    for (const t of TOOLS) expect(nombres).toContain(t)
    const owner = {
      ...superadmin,
      isSuperAdmin: false,
      allowedVenueIds: ['v1'],
      perVenueAccess: new Map([['v1', { role: 'OWNER', corePermissions: ['*:*'], isSuperAdmin: false }]]),
    } as unknown as McpScope
    const delOwner = await listar(owner)
    expect(delOwner.length).toBeGreaterThan(100)
    for (const t of TOOLS) expect(delOwner).not.toContain(t)
  })

  it('declara sus efectos y ninguna aparece en el catálogo del directorio', () => {
    expect(TOOL_EFFECTS.get_plan_offer).toBe('read')
    expect(TOOL_EFFECTS.publish_plan_offer).toBe('write')
    expect(TOOL_EFFECTS.resolve_pending_plan_offer).toBe('write')
    for (const t of TOOLS) expect(DIRECTORY_TOOLS.has(t)).toBe(false)
  })

  it('el dinero de la entrada se describe en centavos SIN IVA', () => {
    const { descriptions } = toolsFor()
    expect(descriptions.get('publish_plan_offer')).toMatch(/centavos SIN IVA/)
  })
})

describe('get_plan_offer', () => {
  it('lee la oferta con los precios en pesos, sin y con IVA, y no suelta los correos', async () => {
    const r = read(await call('get_plan_offer', {}))
    expect(r.ok).toBe(true)
    expect(r.revision).toBe(4)
    expect(r.vigente.numero).toBe(2)
    expect(r.vigente.planes.PRO).toMatchObject({
      nombre: 'Pro',
      enVenta: true,
      pideTarjeta: true,
      diasDePrueba: 30,
      mensual: { sinIva: 799, conIva: 926.84 },
      anual: { sinIva: 7990, conIva: 9268.4 },
    })
    expect(r.entrada).toEqual(entradaVigente)
    expect(r.interruptor.faltan).toEqual(['SERVIDOR_LISTO'])
    expect(JSON.stringify(r)).not.toContain('example.com')
  })

  it('muestra la pendiente con su motivo', async () => {
    ;(estadoDeLaOferta as jest.Mock).mockResolvedValue(
      estado({
        pendiente: {
          versionId: 'v3',
          definition,
          creadaAt: new Date('2026-11-02T00:00:00Z'),
          preparacion: { ultimoError: { motivo: 'STRIPE' } },
        },
      }),
    )
    const r = read(await call('get_plan_offer', {}))
    expect(r.pendiente).toMatchObject({ versionId: 'v3', preparacion: { ultimoError: { motivo: 'STRIPE' } } })
  })

  it('un no SUPERADMIN recibe ok:false', async () => {
    const r = read(await call('get_plan_offer', {}, { isSuperAdmin: false }))
    expect(r.ok).toBe(false)
    expect(estadoDeLaOferta).not.toHaveBeenCalled()
  })
})

describe('publish_plan_offer', () => {
  it('sin confirm devuelve requiresConfirmation con antes → después en pesos y no escribe', async () => {
    const r = read(await call('publish_plan_offer', { entrada: entradaNueva, expectedRevision: 4 }))
    expect(r.requiresConfirmation).toBe(true)
    expect(r.preview.precios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plan: 'PRO',
          periodo: 'mensual',
          actual: { sinIva: 799, conIva: 926.84 },
          nuevo: { sinIva: 899, conIva: 1042.84 },
        }),
      ]),
    )
    expect(r.mensaje).toMatch(/conserva el suyo/)
    expect(publicarVersion).not.toHaveBeenCalled()
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('con confirm publica exactamente la entrada y la revisión, y audita', async () => {
    const r = read(await call('publish_plan_offer', { entrada: entradaNueva, expectedRevision: 4, confirm: true }))
    expect(publicarVersion).toHaveBeenCalledWith(entradaNueva, 4, 'staff-1')
    expect(r).toMatchObject({ ok: true, publicada: { number: 3, versionId: 'v3' } })
    expect(auditMcpWrite).toHaveBeenCalledWith(superadmin, expect.objectContaining({ action: 'MCP_PLAN_OFFER_PUBLISHED', venueId: null }))
  })

  it('si otra publicación movió el puntero → { ok: false, codigo: PLAN_OFFER_STALE }', async () => {
    ;(publicarVersion as jest.Mock).mockRejectedValue(new ConflictError('La oferta cambió.', 'PLAN_OFFER_STALE', {}))
    const r = read(await call('publish_plan_offer', { entrada: entradaNueva, expectedRevision: 4, confirm: true }))
    expect(r).toMatchObject({ ok: false, codigo: 'PLAN_OFFER_STALE' })
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('un 409 PLAN_PRICE_BLOCKED_BY_CAMPAIGNS regresa las campañas como datos', async () => {
    const detalles = { motivo: 'PRECIO', campaigns: [{ code: 'C1' }] }
    ;(publicarVersion as jest.Mock).mockRejectedValue(new ConflictError('Hay campañas.', 'PLAN_PRICE_BLOCKED_BY_CAMPAIGNS', detalles))
    const r = read(await call('publish_plan_offer', { entrada: entradaNueva, expectedRevision: 4, confirm: true }))
    expect(r).toMatchObject({ ok: false, codigo: 'PLAN_PRICE_BLOCKED_BY_CAMPAIGNS', detalles })
  })

  it('un error desconocido se lanza', async () => {
    ;(publicarVersion as jest.Mock).mockRejectedValue(new Error('boom'))
    await expect(call('publish_plan_offer', { entrada: entradaNueva, expectedRevision: 4, confirm: true })).rejects.toThrow('boom')
  })

  it('sin mcp:write se niega', async () => {
    await expect(
      call('publish_plan_offer', { entrada: entradaNueva, expectedRevision: 4, confirm: true }, { scopes: ['mcp:read'] }),
    ).rejects.toThrow(/mcp:write/)
    expect(publicarVersion).not.toHaveBeenCalled()
  })

  it('un no SUPERADMIN recibe ok:false', async () => {
    const r = read(await call('publish_plan_offer', { entrada: entradaNueva, expectedRevision: 4 }, { isSuperAdmin: false }))
    expect(r.ok).toBe(false)
    expect(vistaPreviaDeLaOferta).not.toHaveBeenCalled()
  })
})

describe('resolve_pending_plan_offer', () => {
  it('descartar sin confirm pide confirmación y no escribe', async () => {
    const r = read(await call('resolve_pending_plan_offer', { versionId: 'v3', accion: 'descartar' }))
    expect(r.requiresConfirmation).toBe(true)
    expect(descartarPublicacion).not.toHaveBeenCalled()
  })

  it('descartar con confirm llama a descartarPublicacion, pasa el estado parcial tal cual y audita', async () => {
    const r = read(await call('resolve_pending_plan_offer', { versionId: 'v3', accion: 'descartar', confirm: true }))
    expect(descartarPublicacion).toHaveBeenCalledWith('v3', 'staff-1')
    expect(r).toMatchObject({ ok: true, estado: { revision: 5, pendiente: null, parcial: true } })
    expect(auditMcpWrite).toHaveBeenCalledWith(superadmin, expect.objectContaining({ action: 'MCP_PLAN_OFFER_DISCARDED', entityId: 'v3' }))
  })

  it('reintentar con confirm llama a reintentarPublicacion y audita', async () => {
    const r = read(await call('resolve_pending_plan_offer', { versionId: 'v3', accion: 'reintentar', confirm: true }))
    expect(reintentarPublicacion).toHaveBeenCalledWith('v3', 'staff-1')
    expect(r).toMatchObject({ ok: true, publicada: { number: 3, versionId: 'v3' } })
    expect(auditMcpWrite).toHaveBeenCalledWith(superadmin, expect.objectContaining({ action: 'MCP_PLAN_OFFER_RETRIED' }))
  })

  it('PLAN_EDIT_DISABLED al reintentar regresa como dato', async () => {
    ;(reintentarPublicacion as jest.Mock).mockRejectedValue(new ConflictError('Apagado.', 'PLAN_EDIT_DISABLED', {}))
    const r = read(await call('resolve_pending_plan_offer', { versionId: 'v3', accion: 'reintentar', confirm: true }))
    expect(r).toMatchObject({ ok: false, codigo: 'PLAN_EDIT_DISABLED' })
  })

  it('sin mcp:write se niega', async () => {
    await expect(
      call('resolve_pending_plan_offer', { versionId: 'v3', accion: 'descartar', confirm: true }, { scopes: ['mcp:read'] }),
    ).rejects.toThrow(/mcp:write/)
  })
})

/** Por `tools/call` real, con el token que firma el catálogo. */
describe('publish_plan_offer: el token de confirmación ata la entrada y la revisión', () => {
  let server: McpServer
  let client: Client
  beforeEach(async () => {
    ;({ server, client } = await conectar(superadmin, s => registerPlanOfferTools(s, superadmin)))
  })
  afterEach(async () => {
    await client.close()
    await server.close()
  })
  const llamar = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args })
    return JSON.parse((r.content as Array<{ text: string }>)[0].text)
  }

  it('🔴 confirmar con el token real publica la entrada y la revisión de la vista previa y audita', async () => {
    const vista = await llamar('publish_plan_offer', { entrada: entradaNueva, expectedRevision: 4 })
    expect(vista.requiresConfirmation).toBe(true)
    expect(vista.confirmationToken).toEqual(expect.any(String))
    expect(vista.confirmationArguments).toMatchObject({ expectedRevision: 4 })
    const r = await llamar('publish_plan_offer', {
      ...vista.confirmationArguments,
      confirm: true,
      confirmationToken: vista.confirmationToken,
    })
    expect(r).toMatchObject({ ok: true, publicada: { versionId: 'v3' } })
    expect(publicarVersion).toHaveBeenCalledTimes(1)
    expect(publicarVersion).toHaveBeenCalledWith(entradaNueva, 4, 'staff-1')
    expect(auditMcpWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'MCP_PLAN_OFFER_PUBLISHED' }))
  })

  it('🔴 confirmar con otra entrada o con otra revisión que la de la vista previa no publica', async () => {
    const vista = await llamar('publish_plan_offer', { entrada: entradaNueva, expectedRevision: 4 })
    const otraEntrada = { ...entradaNueva, PREMIUM: { ...entradaNueva.PREMIUM, monthlyNetCents: 1 } }
    const a = await llamar('publish_plan_offer', {
      ...vista.confirmationArguments,
      entrada: otraEntrada,
      confirm: true,
      confirmationToken: vista.confirmationToken,
    })
    expect(a).toMatchObject({ ok: false, needsInput: true, field: 'confirmationToken' })
    const b = await llamar('publish_plan_offer', {
      ...vista.confirmationArguments,
      expectedRevision: 5,
      confirm: true,
      confirmationToken: vista.confirmationToken,
    })
    expect(b).toMatchObject({ ok: false, needsInput: true, field: 'confirmationToken' })
    expect(publicarVersion).not.toHaveBeenCalled()
  })

  it('resolve_pending_plan_offer: el token ata la versión y la acción', async () => {
    const vista = await llamar('resolve_pending_plan_offer', { versionId: 'v3', accion: 'descartar' })
    const otra = await llamar('resolve_pending_plan_offer', {
      ...vista.confirmationArguments,
      accion: 'reintentar',
      confirm: true,
      confirmationToken: vista.confirmationToken,
    })
    expect(otra).toMatchObject({ needsInput: true })
    expect(reintentarPublicacion).not.toHaveBeenCalled()
    const bien = await llamar('resolve_pending_plan_offer', {
      ...vista.confirmationArguments,
      confirm: true,
      confirmationToken: vista.confirmationToken,
    })
    expect(bien.ok).toBe(true)
    expect(descartarPublicacion).toHaveBeenCalledWith('v3', 'staff-1')
  })
})

/** Todas las llaves de un JSON, sin la `entrada` de get_plan_offer (la forma de ENTRADA de publish: centavos, por contrato). */
const llaves = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(llaves)
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => [k, ...llaves(v)])
      : []
const sinCentavos = (value: unknown) => expect(llaves(value).filter((k: string) => /cents$/i.test(k))).toEqual([])

describe('ningún dato que sale del MCP lleva centavos', () => {
  it('get_plan_offer (salvo la `entrada` para publicar), la vista previa y un rechazo con detalles', async () => {
    const lectura = read(await call('get_plan_offer', {}))
    delete lectura.entrada
    sinCentavos(lectura)
    const vista = read(await call('publish_plan_offer', { entrada: entradaNueva, expectedRevision: 4 }))
    sinCentavos(vista)
    expect(vista.preview.cambios[0]).toMatchObject({ plan: 'PRO', campo: 'Pro mensual sin IVA', antes: 799, despues: 899 })
    expect(vista.preview.cambios[0].resumen).toBe('Pro mensual: $799.00 → $899.00 sin IVA ($926.84 → $1,042.84 con IVA)')
    ;(publicarVersion as jest.Mock).mockRejectedValue(
      new ConflictError('Hay campañas.', 'PLAN_PRICE_BLOCKED_BY_CAMPAIGNS', {
        motivo: 'PRECIO',
        campaigns: [{ code: 'C1', priceCents: 2200 }],
      }),
    )
    const rechazo = read(await call('publish_plan_offer', { entrada: entradaNueva, expectedRevision: 4, confirm: true }))
    sinCentavos(rechazo)
    expect(rechazo.detalles.campaigns[0]).toEqual({ code: 'C1', pricePesos: 22 })
  })

  it('M2: si la revisión ya no es la que se leyó, la vista previa avisa y dice la vigente', async () => {
    const r = read(await call('publish_plan_offer', { entrada: entradaNueva, expectedRevision: 3 }))
    expect(r.preview.aviso).toBe('La oferta cambió desde que la leíste; vuelve a leerla antes de confirmar.')
    expect(r.preview.revisionVigente).toBe(4)
    const ok = read(await call('publish_plan_offer', { entrada: entradaNueva, expectedRevision: 4 }))
    expect(ok.preview.aviso).toBeUndefined()
  })
})

describe('la entrada local no se separa de planOfferInput', () => {
  const esquema = () => {
    const captured: { shape?: any } = {}
    const server = { tool: (...a: any[]) => a[0] === 'publish_plan_offer' && (captured.shape = a[2]) } as any
    registerPlanOfferTools(server, superadmin)
    return captured.shape.entrada as { safeParse: (v: unknown) => { success: boolean } }
  }
  const clon = () => JSON.parse(JSON.stringify(entradaNueva))
  const casos: Array<[string, unknown]> = [['válida', clon()]]
  const niveles: Array<[string, (o: any) => any]> = [
    ['raíz', (o: any) => o],
    ['FREE', (o: any) => o.FREE],
    ['PRO', (o: any) => o.PRO],
    ['PREMIUM', (o: any) => o.PREMIUM],
  ]
  for (const [nombre, nivel] of niveles) {
    const extra = clon()
    nivel(extra).desconocido = 1
    casos.push([`llave desconocida en ${nombre}`, extra])
    const falta = clon()
    delete nivel(falta)[Object.keys(nivel(falta))[0]]
    casos.push([`falta una llave en ${nombre}`, falta])
  }
  for (const campo of ['monthlyNetCents', 'annualNetCents']) {
    const texto = clon()
    texto.PRO[campo] = '79900'
    casos.push([`${campo} como texto`, texto])
  }
  it.each(casos)('coinciden en aceptar o rechazar: %s', (_nombre: string, valor: unknown) => {
    expect(esquema().safeParse(valor).success).toBe(planOfferInput.safeParse(valor).success)
  })
})

describe('resolve_pending_plan_offer: descarte parcial', () => {
  it('pasa { revision: -1, pendiente: null, parcial: true } tal cual y dice que el descarte SÍ se hizo', async () => {
    ;(descartarPublicacion as jest.Mock).mockResolvedValue({ revision: -1, pendiente: null, parcial: true })
    const r = read(await call('resolve_pending_plan_offer', { versionId: 'v3', accion: 'descartar', confirm: true }))
    expect(r.estado).toEqual({ revision: -1, pendiente: null, parcial: true })
    expect(r.aviso).toMatch(/SÍ se hizo/)
    expect(toolsFor().descriptions.get('resolve_pending_plan_offer')).toMatch(/descarte SÍ se hizo/)
  })
})

describe('los demás rechazos regresan como datos', () => {
  it.each(['PLAN_OFFER_PENDING', 'PLAN_OFFER_PREPARING', 'HYBRID_LIST_BREAKS_PROMOTIONS', 'PLAN_OFFER_INVALID', 'PLAN_OFFER_UNCHANGED'])(
    '%s',
    async (codigo: string) => {
      ;(publicarVersion as jest.Mock).mockRejectedValue(new ConflictError('Motivo.', codigo, { x: 1 }))
      const r = read(await call('publish_plan_offer', { entrada: entradaNueva, expectedRevision: 4, confirm: true }))
      expect(r).toEqual({ ok: false, codigo, error: 'Motivo.', detalles: { x: 1 } })
    },
  )
})
