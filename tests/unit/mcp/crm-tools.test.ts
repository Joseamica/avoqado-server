/**
 * The CRM's MCP tools (spec 2026-10-30 §5.8, plan task 10): the founder's Claude routine writes WhatsApp prospects and
 * follow-ups into the CRM through these.
 *
 * What they pin: they exist only in the free catalog and only for a SUPERADMIN — never in the certified one, and a direct
 * call without SUPERADMIN or without the key is refused; the WhatsApp upsert of ruling 38 (one business per person, two
 * identical calls = one business and one event, a person already in the CRM gets a note and comes back from the archive
 * unless lost); and «sólo avanza» (never back, «Ganado» goes through the ficha, «Perdido» resolves its reason by name).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { prismaMock } from '@tests/__helpers__/setup'
import { FAKE_LOST_STAGE_ID, FAKE_STAGE_ID, installCrmInboundFake } from '@tests/__helpers__/crmInboundFake'
import { configureToolCatalog, TOOL_EFFECTS } from '@/mcp/catalog'
import { DIRECTORY_TOOLS } from '@/mcp/directory/catalog'
import { registerAllTools } from '@/mcp/server'
import type { McpScope } from '@/mcp/scope'
import { conLlave, registerCrmTools } from '@/mcp/tools/crm'
import { deleteAccount, erasedHashes } from '@/services/crm/erase.service'
import { auditMcpWrite } from '@/mcp/audit'
import { getCrmAccess, type CrmAccess } from '@/services/crm/access.service'
import { addNote, getPending, listAccounts, listLostReasons, listStages, lose, moveStage } from '@/services/crm/accounts.service'
import { addActivity } from '@/services/crm/activities.service'
import { applyEntry } from '@/services/crm/inbound.service'
import { NotFoundError } from '@/errors/AppError'
import { getCampaign, listCampaigns } from '@/services/crm/email/campaigns.service'
import { listTemplates } from '@/services/crm/email/templates.service'
import { getReports } from '@/services/crm/reports.service'

jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/services/crm/access.service', () => ({
  ...jest.requireActual('@/services/crm/access.service'),
  getCrmAccess: jest.fn(),
}))
// The WhatsApp upsert runs on the REAL `touchEditableTx`, `findDuplicates` and `getInitialStage` over the in-memory CRM;
// the rest of the services are already tested on their own, so here they only answer.
jest.mock('@/services/crm/accounts.service', () => ({
  ...jest.requireActual('@/services/crm/accounts.service'),
  listAccounts: jest.fn(),
  getPending: jest.fn(),
  moveStage: jest.fn(),
  lose: jest.fn(),
  addNote: jest.fn(),
  listStages: jest.fn(),
  listLostReasons: jest.fn(),
}))
jest.mock('@/services/crm/activities.service', () => ({ addActivity: jest.fn() }))
// «Eliminar» is tested on its own (erase.service.test.ts); here only who reaches it, and the two steps.
jest.mock('@/services/crm/erase.service', () => ({ ...jest.requireActual('@/services/crm/erase.service'), deleteAccount: jest.fn() }))
jest.mock('@/services/crm/reports.service', () => ({ getReports: jest.fn() }))
// The email phase: the tools only read through these two, which are tested on their own.
jest.mock('@/services/crm/email/templates.service', () => ({
  ...jest.requireActual('@/services/crm/email/templates.service'),
  listTemplates: jest.fn(),
}))
jest.mock('@/services/crm/email/campaigns.service', () => ({
  ...jest.requireActual('@/services/crm/email/campaigns.service'),
  listCampaigns: jest.fn(),
  getCampaign: jest.fn(),
}))

const cuid = (prefix: string) => `c${prefix}`.padEnd(25, '0')

const CRM_TOOLS = [
  'crm_find_account',
  'crm_upsert_whatsapp_prospect',
  'crm_advance_stage',
  'crm_add_note',
  'crm_add_activity',
  'crm_delete_account',
  'crm_pending',
  'crm_pipeline_summary',
  'crm_list_email_templates',
  'crm_campaign_status',
]
const EFFECTS: Record<string, 'read' | 'write'> = {
  crm_find_account: 'read',
  crm_upsert_whatsapp_prospect: 'write',
  crm_advance_stage: 'write',
  crm_add_note: 'write',
  crm_add_activity: 'write',
  crm_delete_account: 'write',
  crm_pending: 'read',
  crm_pipeline_summary: 'read',
  crm_list_email_templates: 'read',
  crm_campaign_status: 'read',
}
const WRITES = CRM_TOOLS.filter(name => EFFECTS[name] === 'write')

const ACC = cuid('acct')
const SUPER = {
  staffId: cuid('staffsup'),
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map(),
  isSuperAdmin: true,
  scopes: ['mcp:read', 'mcp:write'],
} as McpScope

const ADMIN: CrmAccess = {
  staffId: SUPER.staffId,
  isSuperadmin: true,
  ver: 'todos',
  editar: 'todos',
  contactar: true,
  campanas: true,
  exportar: true,
  ventas: true,
  admin: true,
}

/** A plausible call of every tool. */
const ARGS: Record<string, Record<string, unknown>> = {
  crm_find_account: { q: 'Café' },
  crm_upsert_whatsapp_prospect: { phoneE164: '+525512345678' },
  crm_advance_stage: { accountId: ACC, stageName: 'Demo' },
  crm_add_note: { accountId: ACC, text: 'Pidió precios' },
  crm_add_activity: { accountId: ACC, type: 'LLAMADA', title: 'Llamarle', dueAt: '2026-11-03T10:00:00-06:00' },
  crm_delete_account: { accountId: ACC, confirmName: 'Tacos Lupe' },
  crm_pending: {},
  crm_pipeline_summary: {},
  crm_list_email_templates: {},
  crm_campaign_status: {},
}

/** What the services answer for an account. */
const ROW = {
  id: ACC,
  name: 'Tacos Lupe',
  giro: 'Taquería',
  ventasRango: null,
  source: 'WHATSAPP',
  owner: null,
  stage: { id: cuid('stage4'), name: 'Demo', kind: 'ABIERTA' },
  nextActivityAt: new Date('2026-11-03T16:00:00.000Z'),
  nextActivity: { id: cuid('act'), type: 'LLAMADA', title: 'Llamarle', dueAt: new Date('2026-11-03T16:00:00.000Z'), assigneeStaffId: null },
  semaforo: 'gris',
  estancadoDias: null,
  firstMoneyAt: null,
  organizationId: null,
  archivedAt: null,
  createdAt: new Date('2026-10-30T18:00:00.000Z'),
}

/** Every handler of `registerCrmTools`, called the way the catalog calls it, its JSON answer parsed. */
function setup(over: Partial<McpScope> = {}) {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>> = {}
  const descriptions: Record<string, string> = {}
  const server = {
    tool: jest.fn((name: string, description: string, _schema: unknown, handler: (typeof handlers)[string]) => {
      handlers[name] = handler
      descriptions[name] = description
    }),
  }
  const scope = { ...SUPER, ...over } as McpScope
  registerCrmTools(server as unknown as McpServer, scope)
  const call = async (name: string, args: Record<string, unknown> = ARGS[name]) => JSON.parse((await handlers[name](args)).content[0].text)
  return { server, scope, call, descriptions }
}

/** The whole catalog as `server.ts` registers it, names only. */
function catalogFor(scope: Partial<McpScope>): string[] {
  const names: string[] = []
  const server = { tool: (...a: unknown[]) => names.push(a[0] as string) } as never
  registerAllTools(server, { ...SUPER, ...scope } as McpScope, { serializedEnabled: true, whiteLabelEnabled: true, catalogEnabled: true })
  return names
}

/** The real protocol: `configureToolCatalog` (effects, write scope, certified catalog) in front of the CRM tools. */
async function connect(profile: 'manual' | 'directory') {
  const server = new McpServer({ name: 'crm-test', version: '1' })
  configureToolCatalog(server, SUPER, profile)
  registerCrmTools(server, SUPER)
  const client = new Client({ name: 'test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

beforeEach(() => {
  ;(getCrmAccess as jest.Mock).mockResolvedValue(ADMIN)
})

// ── Who sees them ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('CRM MCP — catalogs', () => {
  it('catalogo_libre_las_trae: the free catalog lists all of them for a SUPERADMIN, through server.ts and the real protocol', async () => {
    expect(catalogFor({ isSuperAdmin: true })).toEqual(expect.arrayContaining(CRM_TOOLS))

    const c = await connect('manual')
    try {
      const { tools } = await c.client.listTools()
      for (const name of CRM_TOOLS) {
        const tool = tools.find(t => t.name === name)
        expect({ name, readOnly: tool?.annotations?.readOnlyHint }).toEqual({ name, readOnly: EFFECTS[name] === 'read' })
      }
    } finally {
      await c.close()
    }
  })

  it('catalogo_certificado_no_las_trae: none is in a certified tier, none is listed there, and a direct call is refused', async () => {
    for (const name of CRM_TOOLS) expect({ name, certified: DIRECTORY_TOOLS.has(name) }).toEqual({ name, certified: false })

    const c = await connect('directory')
    try {
      const listed = (await c.client.listTools()).tools.map(t => t.name)
      expect(listed.filter(name => name.startsWith('crm_'))).toEqual([])
      expect((await c.client.callTool({ name: 'crm_pending', arguments: {} })).isError).toBe(true)
      expect(getCrmAccess).not.toHaveBeenCalled()
      expect(getPending).not.toHaveBeenCalled()
    } finally {
      await c.close()
    }
  })

  it('no_superadmin_no_las_ve: a customer connection never gets them, not even registered', () => {
    expect(catalogFor({ isSuperAdmin: false }).filter(name => name.startsWith('crm_'))).toEqual([])
    expect(catalogFor({ isSuperAdmin: undefined }).filter(name => name.startsWith('crm_'))).toEqual([])
    expect(setup({ isSuperAdmin: false }).server.tool).not.toHaveBeenCalled()
  })

  it('toda_herramienta_tiene_efecto_declarado: each one declares its effect, and TOOL_EFFECTS has no CRM tool that is not registered', () => {
    const registered = setup().server.tool.mock.calls.map(([name]) => name)
    expect([...registered].sort()).toEqual([...CRM_TOOLS].sort())
    for (const name of CRM_TOOLS) expect({ name, effect: TOOL_EFFECTS[name] }).toEqual({ name, effect: EFFECTS[name] })
    expect(
      Object.keys(TOOL_EFFECTS)
        .filter(name => name.startsWith('crm_'))
        .sort(),
    ).toEqual([...CRM_TOOLS].sort())
  })

  it('descriptions speak business, never internals', () => {
    const { descriptions } = setup()
    for (const name of CRM_TOOLS) {
      expect(descriptions[name]).toMatch(/Sólo para el equipo de Avoqado/)
      expect(descriptions[name]).not.toMatch(/\bprisma\b|\bpostgres|src\/|\/api\/v1\//i)
      // No model names and no `Modelo.campo`.
      expect(descriptions[name]).not.toMatch(/\bCrm[A-Z][a-zA-Z]+\b|\b[A-Z][a-zA-Z]+\.[a-z][a-zA-Z]+\b/)
    }
    // A new WhatsApp prospect has no owner: the activity stays with whoever schedules it.
    expect(descriptions.crm_add_activity).toMatch(/si no tiene, de quien la agenda/)
  })
})

// ── Who can call them ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('CRM MCP — access', () => {
  it('llamada_directa_sin_superadmin_rechazada: a handler registered for a SUPERADMIN refuses once the connection is not one', async () => {
    const { scope, call } = setup()
    scope.isSuperAdmin = false
    for (const name of CRM_TOOLS) expect({ name, ...(await call(name)) }).toMatchObject({ name, ok: false })
    expect(getCrmAccess).not.toHaveBeenCalled()
    for (const service of [
      listAccounts,
      getPending,
      moveStage,
      lose,
      addNote,
      addActivity,
      getReports,
      listTemplates,
      listCampaigns,
      getCampaign,
    ])
      expect(service).not.toHaveBeenCalled()
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('a SUPERADMIN the CRM does not recognize (inactive) gets ok:false with the reason', async () => {
    ;(getCrmAccess as jest.Mock).mockResolvedValue(null)
    const { call } = setup()
    for (const name of CRM_TOOLS) {
      const answer = await call(name)
      expect({ name, ok: answer.ok, error: typeof answer.error }).toEqual({ name, ok: false, error: 'string' })
    }
    for (const service of [
      listAccounts,
      getPending,
      moveStage,
      lose,
      addNote,
      addActivity,
      getReports,
      listTemplates,
      listCampaigns,
      getCampaign,
    ])
      expect(service).not.toHaveBeenCalled()
  })

  it('without «crm:editar» the writes refuse and name the key; the reads still answer', async () => {
    ;(getCrmAccess as jest.Mock).mockResolvedValue({ ...ADMIN, editar: null })
    ;(getPending as jest.Mock).mockResolvedValue({
      vencidas: { rows: [], total: 0 },
      hoy: { rows: [], total: 0 },
      sinSiguientePaso: { rows: [], total: 0 },
      estancados: { rows: [], total: 0 },
      nuevosSinDueno: { rows: [], total: 0 },
    })
    const { call } = setup()
    for (const name of WRITES.filter(name => name !== 'crm_delete_account'))
      expect({ name, ...(await call(name)) }).toMatchObject({ name, ok: false, error: expect.stringContaining('crm:editar') })
    expect(await call('crm_pending')).toMatchObject({ ok: true })
    for (const service of [moveStage, lose, addNote, addActivity]) expect(service).not.toHaveBeenCalled()
  })

  it('a SUPERADMIN connection without the write grant cannot write', async () => {
    const { call } = setup({ scopes: ['mcp:read'] })
    await expect(call('crm_add_note')).rejects.toThrow(/mcp:write/)
    expect(addNote).not.toHaveBeenCalled()
  })
})

describe('crm_delete_account (D7)', () => {
  it('sin «Administrar» se niega y la nombra; un admin del equipo que no es el superadmin, tampoco', async () => {
    ;(getCrmAccess as jest.Mock).mockResolvedValue({ ...ADMIN, admin: false })
    expect(await setup().call('crm_delete_account', { ...ARGS.crm_delete_account, confirm: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining('crm:admin'),
    })
    ;(getCrmAccess as jest.Mock).mockResolvedValue({ ...ADMIN, isSuperadmin: false })
    expect(await setup().call('crm_delete_account', { ...ARGS.crm_delete_account, confirm: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Sólo el superadmin'),
    })
    expect(deleteAccount).not.toHaveBeenCalled()
  })

  it('dos_pasos: la primera llamada sólo dice qué se borraría; con la confirmación firmada, se elimina', async () => {
    prismaMock.crmAccount.findUnique.mockResolvedValue({
      name: 'Tacos Lupe',
      source: 'WHATSAPP',
      stage: { name: 'Demo' },
      _count: { contacts: 1, activities: 2, timelineEvents: 5 },
    })
    ;(deleteAccount as jest.Mock).mockResolvedValue({ id: ACC, eliminado: true })
    const c = await connect('manual')
    try {
      const first = JSON.parse(
        (
          (await c.client.callTool({ name: 'crm_delete_account', arguments: ARGS.crm_delete_account })).content as Array<{ text: string }>
        )[0].text,
      )
      expect(first).toMatchObject({
        requiresConfirmation: true,
        negocio: 'Tacos Lupe',
        seBorran: { contactos: 1, actividades: 2, eventos: 5 },
      })
      expect(deleteAccount).not.toHaveBeenCalled()
      // Another name than the one it shows is never signed (Codex r2 H4).
      const other = JSON.parse(
        (
          (await c.client.callTool({ name: 'crm_delete_account', arguments: { accountId: ACC, confirmName: 'Café Ana' } }))
            .content as Array<{ text: string }>
        )[0].text,
      )
      expect(other).toMatchObject({ ok: false, error: expect.stringContaining('«Tacos Lupe»') })
      expect(other.confirmationToken).toBeUndefined()

      await c.client.callTool({
        name: 'crm_delete_account',
        arguments: { ...first.confirmationArguments, confirm: true, confirmationToken: first.confirmationToken },
      })
      expect(deleteAccount).toHaveBeenCalledWith(ADMIN, ACC, 'Tacos Lupe')
      expect(auditMcpWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'CRM_ACCOUNT_DELETED_BY_MCP' }))
    } finally {
      await c.close()
    }
  })
})

// ── WhatsApp (rulings 38, 44 and 45) ──────────────────────────────────────────────────────────────────────────────────

describe('crm_upsert_whatsapp_prospect', () => {
  const PHONE = '+525512345678'
  const LANDING_ACC = cuid('acctlnd')
  // The routine runs every day and re-reads the chats of the last 4 days.
  const MON = new Date('2026-11-02T18:00:00.000Z')
  const TUE = new Date('2026-11-03T18:00:00.000Z')
  const THU = new Date('2026-11-05T18:00:00.000Z')
  /** The chat's last message, as the routine saw it: Monday 09:04, and a real new one on Thursday 11:20. */
  const MSG_1 = '2026-11-02T09:04:31-06:00'
  const MSG_2 = '2026-11-05T11:20:00-06:00'
  let db: ReturnType<typeof installCrmInboundFake>

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
    jest.setSystemTime(MON)
    db = installCrmInboundFake(prismaMock)
    // `findDuplicates`: the accounts with a person of this phone.
    prismaMock.crmAccount.findMany.mockImplementation(async ({ where }: any) => {
      const phone = where.contacts.some.OR.find((by: { phoneE164?: string }) => by.phoneE164)?.phoneE164
      const ids = new Set(db.contacts.filter(contact => contact.phoneE164 === phone).map(contact => contact.accountId))
      return db.accounts.filter(account => ids.has(account.id)).map(account => ({ ...account, ownerStaffId: null, owner: null }))
    })
    // The account read under its row lock, within the edit scope (everything, for a SUPERADMIN). The resolver's lookup by
    // person (ruling 65) stays the in-memory CRM's.
    const byPerson = prismaMock.crmAccount.findFirst.getMockImplementation()!
    prismaMock.crmAccount.findFirst.mockImplementation(async (args: any) => {
      if (args.where.contacts) return byPerson(args)
      const { where } = args
      const row = db.accounts.find(account => account.id === where.AND[0].id)
      if (!row) return null
      const kind = row.stageId === FAKE_LOST_STAGE_ID ? 'PERDIDA' : 'ABIERTA'
      return {
        name: row.name,
        giro: row.giro ?? null,
        ventasRango: row.ventasRango ?? null,
        archivedAt: row.archivedAt ?? null,
        lastTouchAt: row.lastTouchAt ?? null,
        qualifiedAt: row.qualifiedAt ?? null,
        stage: { kind },
      }
    })
  })

  afterEach(() => jest.useRealTimers())

  /** An account the CRM already has for this person, from the landing. */
  function seedLanding(over: Record<string, unknown> = {}) {
    const account = {
      id: LANDING_ACC,
      name: 'Café Ana',
      giro: 'Cafetería',
      ventasRango: null,
      source: 'LANDING',
      externalKey: 'ana@cafe.mx',
      stageId: FAKE_STAGE_ID,
      organizationId: null,
      archivedAt: new Date('2026-09-01T18:00:00.000Z'),
      lastTouchAt: new Date('2026-09-01T18:00:00.000Z'),
      ...over,
    }
    db.accounts.push(account)
    db.contacts.push({ accountId: account.id, name: 'Ana', phoneE164: PHONE, isPrimary: true })
    return account
  }

  const kinds = () => db.events.map(event => event.kind)

  it('eliminado_no_vuelve_con_un_chat_viejo (D7): releer el chat de antes no lo crea; un mensaje nuevo sí', async () => {
    // The superadmin deleted this WhatsApp prospect on Tuesday.
    const { person } = erasedHashes({
      keys: [{ source: 'WHATSAPP', externalKey: PHONE }],
      emails: [],
      phones: [PHONE],
      organizationId: null,
    })
    db.erased.push(...person.map(keyHash => ({ keyHash, scope: '', erasedAt: TUE })))
    jest.setSystemTime(THU)
    const { call } = setup()

    // An old chat, a chat without its date, or one dated tomorrow (it proves no new message; Codex r4 H3).
    for (const ultimoMensajeAt of [MSG_1, undefined, '2026-11-06T11:20:00-06:00']) {
      expect(await call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE, name: 'Tacos Lupe', ultimoMensajeAt })).toMatchObject({
        ok: false,
        error: expect.stringContaining('se eliminó del CRM'),
      })
    }
    expect(db.accounts).toHaveLength(0)
    expect(auditMcpWrite).not.toHaveBeenCalled()

    expect(await call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE, name: 'Tacos Lupe', ultimoMensajeAt: MSG_2 })).toMatchObject({
      ok: true,
      creado: true,
    })
  })

  it('upsert_dos_veces_un_negocio: the same call twice leaves ONE business «Sin dueño» in the first stage and ONE event', async () => {
    const { call } = setup()
    const input = { phoneE164: '55 1234 5678', name: 'Tacos Lupe', giro: 'Taquería', campaign: 'pos22', ultimoMensajeAt: MSG_1 }
    const first = await call('crm_upsert_whatsapp_prospect', input)
    const second = await call('crm_upsert_whatsapp_prospect', input)

    expect(first).toMatchObject({ ok: true, creado: true, yaExistia: false })
    expect(second).toMatchObject({ ok: true, accountId: first.accountId, creado: false, yaExistia: true, notaNueva: false })
    expect(db.accounts).toHaveLength(1)
    expect(db.accounts[0]).toMatchObject({
      id: first.accountId,
      source: 'WHATSAPP',
      externalKey: PHONE,
      name: 'Tacos Lupe',
      giro: 'Taquería',
      ownerStaffId: null,
      stageId: FAKE_STAGE_ID,
      sourceDetail: { campaign: 'pos22' },
    })
    expect(db.contacts).toEqual([expect.objectContaining({ accountId: first.accountId, phoneE164: PHONE, isPrimary: true })])
    // The creation takes the key of the message it came from (to the minute, UTC).
    expect(db.events).toEqual([
      expect.objectContaining({
        accountId: first.accountId,
        kind: 'SYSTEM',
        sourceKey: `whatsapp:${first.accountId}:2026-11-02T15:04`,
        data: expect.objectContaining({ event: 'CREATED', source: 'WHATSAPP' }),
      }),
    ])
    expect(auditMcpWrite).toHaveBeenCalledTimes(1)
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: SUPER.staffId }),
      expect.objectContaining({ entity: 'CrmAccount', entityId: first.accountId, venueId: null }),
    )
  })

  it('releer_el_chat_otro_dia_no_escribe: re-reading the same chat the next day writes and touches nothing; a real new message does', async () => {
    const { call } = setup()
    const created = await call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE, ultimoMensajeAt: MSG_1 })

    jest.setSystemTime(TUE)
    expect(await call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE, ultimoMensajeAt: MSG_1 })).toMatchObject({
      ok: true,
      creado: false,
      notaNueva: false,
    })
    expect(kinds()).toEqual(['SYSTEM'])
    expect(db.accounts[0].lastTouchAt).toEqual(MON)

    jest.setSystemTime(THU)
    expect(await call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE, ultimoMensajeAt: MSG_2 })).toMatchObject({
      ok: true,
      notaNueva: true,
    })
    expect(db.events[1]).toMatchObject({
      kind: 'NOTE',
      sourceKey: `whatsapp:${created.accountId}:2026-11-05T17:20`,
      data: expect.objectContaining({ text: expect.stringMatching(/^Volvió a escribir por WhatsApp/) }),
    })
    // A real new message restarts «Estancado», like the landing does.
    expect(db.accounts[0].lastTouchAt).toEqual(THU)
    // And the same new message read again adds nothing.
    await call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE, ultimoMensajeAt: MSG_2 })
    expect(kinds()).toEqual(['SYSTEM', 'NOTE'])
    expect(auditMcpWrite).toHaveBeenCalledTimes(2)
  })

  it('without the last message, its own WhatsApp business writes and touches nothing, not even back from the archive', async () => {
    const { call } = setup()
    await call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE })
    const archivedAt = new Date('2026-11-02T20:00:00.000Z')
    db.accounts[0].archivedAt = archivedAt

    jest.setSystemTime(TUE)
    expect(await call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE })).toMatchObject({
      ok: true,
      creado: false,
      yaExistia: true,
      reactivado: false,
      notaNueva: false,
    })
    expect(kinds()).toEqual(['SYSTEM'])
    expect(db.accounts[0]).toMatchObject({ lastTouchAt: MON, archivedAt })
    expect(auditMcpWrite).toHaveBeenCalledTimes(1)
  })

  it('a person already in the CRM from another source: no WhatsApp business; a note, the touch and back from the archive only for a new message', async () => {
    seedLanding()
    const { call } = setup()
    const first = await call('crm_upsert_whatsapp_prospect', {
      phoneE164: PHONE,
      name: 'Otro nombre',
      campaign: 'pos22',
      ultimoMensajeAt: MSG_1,
    })

    expect(first).toMatchObject({ ok: true, accountId: LANDING_ACC, creado: false, yaExistia: true, reactivado: true, notaNueva: true })
    expect(db.accounts).toHaveLength(1)
    // A real name is never overwritten.
    expect(db.accounts[0]).toMatchObject({ source: 'LANDING', name: 'Café Ana', archivedAt: null, lastTouchAt: MON })
    expect(db.events).toEqual([
      expect.objectContaining({
        accountId: LANDING_ACC,
        kind: 'NOTE',
        data: expect.objectContaining({ text: expect.stringMatching(/Volvió a escribir por WhatsApp.*pos22/) }),
      }),
      expect.objectContaining({ accountId: LANDING_ACC, kind: 'REACTIVATED', data: expect.objectContaining({ via: 'WHATSAPP' }) }),
    ])

    // Someone archives it again; the next day the routine re-reads the same chat: it stays archived and untouched.
    const archivedAt = new Date('2026-11-02T22:00:00.000Z')
    db.accounts[0].archivedAt = archivedAt
    jest.setSystemTime(TUE)
    expect(await call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE, campaign: 'pos22', ultimoMensajeAt: MSG_1 })).toMatchObject({
      reactivado: false,
      notaNueva: false,
    })
    expect(db.accounts[0]).toMatchObject({ archivedAt, lastTouchAt: MON })
    expect(db.events).toHaveLength(2)
    expect(auditMcpWrite).toHaveBeenCalledTimes(1)
  })

  it('another source without the last message: one note in its whole life', async () => {
    seedLanding()
    const { call } = setup()
    expect(await call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE })).toMatchObject({ notaNueva: true, reactivado: true })
    expect(db.events[0]).toMatchObject({ kind: 'NOTE', sourceKey: `whatsapp:${LANDING_ACC}` })

    jest.setSystemTime(THU)
    expect(await call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE })).toMatchObject({ notaNueva: false, reactivado: false })
    expect(kinds()).toEqual(['NOTE', 'REACTIVATED'])
    expect(db.accounts[0].lastTouchAt).toEqual(MON)
  })

  it('a LOST account stays lost and archived: it only gets the note', async () => {
    const archivedAt = new Date('2026-09-01T18:00:00.000Z')
    seedLanding({ stageId: FAKE_LOST_STAGE_ID, archivedAt })
    const answer = await setup().call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE, ultimoMensajeAt: MSG_1 })

    expect(answer).toMatchObject({ ok: true, accountId: LANDING_ACC, creado: false, yaExistia: true, reactivado: false, notaNueva: true })
    expect(db.accounts[0].archivedAt).toEqual(archivedAt)
    expect(kinds()).toEqual(['NOTE'])
  })

  it('llena_lo_vacio: an existing business of any source gets only its empty fields, never overwritten, with FIELD_CHANGE', async () => {
    // Imported from HubSpot with the phone as its name, no giro and a sales range already known.
    seedLanding({
      source: 'IMPORTACION',
      externalKey: 'hs-1',
      name: '55 1234 5678',
      giro: null,
      ventasRango: 'De $150 a $500 mil',
      archivedAt: null,
    })
    const { call } = setup()
    const input = { phoneE164: PHONE, name: 'Tacos Lupe', giro: 'Taquería', ventasRango: 'Menos de $150 mil', ultimoMensajeAt: MSG_1 }
    expect(await call('crm_upsert_whatsapp_prospect', input)).toMatchObject({ ok: true, actualizados: ['name', 'giro'] })
    expect(db.accounts[0]).toMatchObject({ name: 'Tacos Lupe', giro: 'Taquería', ventasRango: 'De $150 a $500 mil' })
    expect(db.events).toContainEqual(
      expect.objectContaining({
        kind: 'FIELD_CHANGE',
        actorStaffId: null,
        data: {
          via: 'WHATSAPP',
          changes: [
            { field: 'name', from: '55 1234 5678', to: 'Tacos Lupe' },
            { field: 'giro', from: null, to: 'Taquería' },
          ],
        },
      }),
    )

    // The same chat read again: nothing left to fill, nothing written.
    jest.setSystemTime(TUE)
    const events = db.events.length
    expect(await call('crm_upsert_whatsapp_prospect', input)).toMatchObject({ actualizados: [] })
    expect(db.events).toHaveLength(events)
  })

  it('what the routine learns days later fills its own WhatsApp business without a note and without touching it', async () => {
    const { call } = setup()
    await call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE, ultimoMensajeAt: MSG_1 })
    expect(db.accounts[0].name).toBe(PHONE)

    jest.setSystemTime(TUE)
    const answer = await call('crm_upsert_whatsapp_prospect', {
      phoneE164: PHONE,
      name: 'Tacos Lupe',
      giro: 'Taquería',
      ventasRango: 'Menos de $150 mil',
      ultimoMensajeAt: MSG_1,
    })
    expect(answer).toMatchObject({ notaNueva: false, actualizados: ['name', 'giro', 'ventasRango'] })
    expect(db.accounts[0]).toMatchObject({ name: 'Tacos Lupe', giro: 'Taquería', ventasRango: 'Menos de $150 mil', lastTouchAt: MON })
    expect(kinds()).toEqual(['SYSTEM', 'FIELD_CHANGE'])
    expect(auditMcpWrite).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ action: 'CRM_WHATSAPP_PROSPECT_UPDATED' }))
  })

  it('un_toque_nunca_retrocede (Codex exhaustiva #10 B): a touch someone made while this call waited for the lock stays', async () => {
    // A landing form touched the business on Tuesday; this call took «now» on Monday before it got the lock.
    seedLanding({ archivedAt: null, lastTouchAt: TUE })

    expect(await setup().call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE, ultimoMensajeAt: MSG_1 })).toMatchObject({
      notaNueva: true,
    })
    expect(db.accounts[0].lastTouchAt).toEqual(TUE)
  })

  it('lo_que_aprende_whatsapp_sella_qualifiedAt (Codex exhaustiva #10 A): an older form repaired later does not overwrite it', async () => {
    const { call } = setup()
    await call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE, giro: 'Taquería', ultimoMensajeAt: MSG_1 })
    // Created with what the chat said, stamped with when it said it.
    expect(db.accounts[0]).toMatchObject({ giro: 'Taquería', qualifiedAt: new Date(MSG_1) })

    // Filling an empty field later stamps the later message; an earlier stamp is never moved back.
    jest.setSystemTime(THU)
    await call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE, ventasRango: 'Menos de $150 mil', ultimoMensajeAt: MSG_2 })
    expect(db.accounts[0]).toMatchObject({ ventasRango: 'Menos de $150 mil', qualifiedAt: new Date(MSG_2) })
  })

  it('un_formulario_viejo_reparado_despues_no_pisa_lo_que_sello_whatsapp (M4, ruling 70): the stamp works across writers', async () => {
    // WhatsApp learns the giro on Monday 09:04 and stamps it.
    await setup().call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE, giro: 'Taquería', ultimoMensajeAt: MSG_1 })
    const [business] = db.accounts
    // A landing form sent the day before by the same person (same phone) failed to apply; the sweep repairs it now.
    const old = {
      id: cuid('entryvieja'),
      source: 'LANDING',
      externalKey: 'ana@cafe.mx',
      payload: { firstName: 'Ana', phone: '55 1234 5678', email: 'ana@cafe.mx', businessType: 'Bar', revenue: 'menos de 100k' },
      receivedAt: new Date(new Date(MSG_1).getTime() - 86_400_000),
      signupOutcome: null,
      signupResolvedAt: new Date(new Date(MSG_1).getTime() - 86_400_000),
      appliedAt: null,
      accountId: null,
      lastError: 'connection reset',
      noticeSentAt: null,
      noticeAttempts: 0,
    }
    db.entries.push(old)

    await applyEntry(old.id)

    // Applied to the same business, its story in the timeline — and what WhatsApp learned stays.
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: business.id })
    expect(db.accounts).toEqual([
      expect.objectContaining({ id: business.id, giro: 'Taquería', ventasRango: null, qualifiedAt: new Date(MSG_1) }),
    ])
    expect(db.events).toContainEqual(
      expect.objectContaining({ kind: 'ENTRY_APPLIED', data: expect.objectContaining({ qualificationSkipped: true }) }),
    )
    expect(db.events.filter(event => event.kind === 'FIELD_CHANGE')).toEqual([])
  })

  it('the race: a call at the same instant created it first — this one reads that business and writes nothing', async () => {
    // What the other call committed while this one waited on the insert: the business and its creation event.
    const OTHER = cuid('acctwa')
    db.accounts.push({ id: OTHER, name: PHONE, source: 'WHATSAPP', externalKey: PHONE, stageId: FAKE_STAGE_ID, lastTouchAt: MON })
    db.events.push({ accountId: OTHER, kind: 'SYSTEM', sourceKey: `whatsapp:${OTHER}:2026-11-02T15:04`, data: {} })
    // …which this call's first lookups did not see yet: the check before the transaction and the resolver's inside it.
    prismaMock.crmAccount.findUnique.mockImplementationOnce(async () => null).mockImplementationOnce(async () => null)

    const answer = await setup().call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE, ultimoMensajeAt: MSG_1 })
    expect(prismaMock.crmAccount.createMany).toHaveBeenCalledTimes(1)
    expect(answer).toMatchObject({ ok: true, accountId: OTHER, creado: false, yaExistia: true, notaNueva: false })
    expect(db.accounts).toHaveLength(1)
    expect(db.contacts).toEqual([])
    expect(db.events).toHaveLength(1)
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('otro_negocio_aparece_entre_la_revision_y_el_candado (Codex autorización H3): nothing is written, the candidates come back', async () => {
    // The check sees ONE business with this phone…
    seedLanding({ archivedAt: null })
    // …and before the transaction locks it, a seller creates another one with the same (shared) phone, touched later.
    const plain = prismaMock.$transaction.getMockImplementation()!
    prismaMock.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => {
      db.accounts.push({
        id: cuid('acctman'),
        name: 'Tienda Ana',
        source: 'MANUAL',
        externalKey: null,
        stageId: FAKE_STAGE_ID,
        lastTouchAt: TUE,
      })
      db.contacts.push({ id: cuid('contman'), accountId: cuid('acctman'), name: 'Ana', phoneE164: PHONE })
      return plain(callback)
    })

    const answer = await setup().call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE, giro: 'Taquería', ultimoMensajeAt: MSG_1 })

    expect(answer).toMatchObject({ ok: false, candidatos: expect.arrayContaining([expect.objectContaining({ id: LANDING_ACC })]) })
    expect(answer.candidatos).toHaveLength(2)
    expect(db.events).toEqual([])
    expect(db.accounts.find(account => account.id === cuid('acctman'))).not.toHaveProperty('giro')
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('a phone in two businesses is resolved, not guessed: nothing is written and both come back', async () => {
    seedLanding({ archivedAt: null })
    db.accounts.push({ id: cuid('acctman'), name: 'Tienda Ana', source: 'MANUAL', externalKey: null, stageId: FAKE_STAGE_ID })
    db.contacts.push({ accountId: cuid('acctman'), name: 'Ana', phoneE164: PHONE })

    const answer = await setup().call('crm_upsert_whatsapp_prospect', { phoneE164: PHONE })
    expect(answer).toMatchObject({ ok: false, candidatos: expect.arrayContaining([expect.objectContaining({ id: LANDING_ACC })]) })
    expect(answer.candidatos).toHaveLength(2)
    expect(db.accounts).toHaveLength(2)
    expect(db.events).toEqual([])
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('a phone that is not one writes nothing', async () => {
    expect(await setup().call('crm_upsert_whatsapp_prospect', { phoneE164: 'no tengo' })).toMatchObject({ ok: false })
    expect(db.accounts).toEqual([])
  })
})

// ── Advancing (ruling 38) ─────────────────────────────────────────────────────────────────────────────────────────────

describe('crm_advance_stage', () => {
  const STAGES = [
    { id: cuid('stage1'), name: 'Prospecto', order: 1, kind: 'ABIERTA', staleDays: 2 },
    { id: cuid('stage2'), name: 'Contacto inicial', order: 2, kind: 'ABIERTA', staleDays: 3 },
    { id: cuid('stage3'), name: 'Calificado', order: 3, kind: 'ABIERTA', staleDays: 5 },
    { id: cuid('stage4'), name: 'Demo', order: 4, kind: 'ABIERTA', staleDays: 5 },
    { id: cuid('stage5'), name: 'Negociación', order: 5, kind: 'ABIERTA', staleDays: 7 },
    { id: cuid('stage6'), name: 'Ganado', order: 6, kind: 'GANADA', staleDays: null },
    { id: cuid('stage7'), name: 'Perdido', order: 7, kind: 'PERDIDA', staleDays: null },
  ]
  const REASONS = [
    { id: cuid('reason1'), name: 'Dijo que no', active: true },
    { id: cuid('reason2'), name: 'Precio', active: true },
    { id: cuid('reason3'), name: 'Précio', active: true },
    { id: cuid('reason4'), name: 'Ya no se usa', active: false },
  ]
  const at = (name: string) => ({ id: ACC, stage: STAGES.find(stage => stage.name === name) })

  beforeEach(() => {
    ;(listStages as jest.Mock).mockResolvedValue(STAGES)
    ;(listLostReasons as jest.Mock).mockResolvedValue(REASONS)
    prismaMock.crmAccount.findFirst.mockResolvedValue(at('Demo'))
    ;(moveStage as jest.Mock).mockResolvedValue({ ...ROW, stage: { id: STAGES[4].id, name: 'Negociación', kind: 'ABIERTA' } })
    ;(lose as jest.Mock).mockResolvedValue({ ...ROW, stage: { id: STAGES[6].id, name: 'Perdido', kind: 'PERDIDA' } })
  })

  it('avanzar_no_retrocede: an earlier or the same stage is refused; a later one moves it, by name without accents or capitals', async () => {
    const { call } = setup()
    expect(await call('crm_advance_stage', { accountId: ACC, stageName: 'Contacto inicial' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no retrocede/i),
    })
    expect(await call('crm_advance_stage', { accountId: ACC, stageName: 'Demo' })).toMatchObject({ ok: false })
    expect(moveStage).not.toHaveBeenCalled()

    const moved = await call('crm_advance_stage', { accountId: ACC, stageName: '  negociacion ' })
    expect(moved).toMatchObject({ ok: true, negocio: expect.objectContaining({ id: ACC, etapa: 'Negociación' }) })
    // The stage it saw travels with the move: if someone changed it meanwhile, the service answers 409.
    expect(moveStage).toHaveBeenCalledWith(ADMIN, ACC, STAGES[4].id, STAGES[3].id)
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entity: 'CrmAccount', entityId: ACC, venueId: null }),
    )
  })

  it('a closed business does not move, not even «forward» to Perdido', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValue(at('Ganado'))
    expect(await setup().call('crm_advance_stage', { accountId: ACC, stageName: 'Perdido', lostReason: 'Precio' })).toMatchObject({
      ok: false,
    })
    expect(lose).not.toHaveBeenCalled()
  })

  it('perder_desde_cualquier_etapa_abierta: «Perdido» is not «advancing» — it works from an open stage with a higher order', async () => {
    const seguimiento = { id: cuid('stage8'), name: 'Seguimiento', order: 8, kind: 'ABIERTA', staleDays: 7 }
    ;(listStages as jest.Mock).mockResolvedValue([...STAGES, seguimiento])
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: ACC, stage: seguimiento })
    const answer = await setup().call('crm_advance_stage', { accountId: ACC, stageName: 'Perdido', lostReason: 'Dijo que no' })
    expect(answer).toMatchObject({ ok: true })
    expect(lose).toHaveBeenCalledWith(ADMIN, ACC, expect.objectContaining({ lostReasonId: REASONS[0].id, expectedStageId: seguimiento.id }))
  })

  it('a stage that changed meanwhile comes back as ok:false with its code, nothing reopened', async () => {
    const { ConflictError } = jest.requireActual('@/errors/AppError')
    ;(moveStage as jest.Mock).mockRejectedValueOnce(new ConflictError('El negocio cambió de etapa mientras tanto', 'CRM_ETAPA_CAMBIO'))
    expect(await setup().call('crm_advance_stage', { accountId: ACC, stageName: 'Negociación' })).toMatchObject({
      ok: false,
      code: 'CRM_ETAPA_CAMBIO',
    })
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('«Ganado» is refused: it goes through the ficha, which links the Avoqado business', async () => {
    const answer = await setup().call('crm_advance_stage', { accountId: ACC, stageName: 'ganado' })
    expect(answer).toMatchObject({ ok: false, error: expect.stringContaining('SUPERADMIN') })
    expect(moveStage).not.toHaveBeenCalled()
  })

  it('«Perdido» without a reason, or with one that does not resolve to exactly one active reason, answers the list', async () => {
    const { call } = setup()
    const active = ['Dijo que no', 'Precio', 'Précio']
    for (const lostReason of [undefined, 'caro', 'precio', 'Ya no se usa']) {
      const answer = await call('crm_advance_stage', { accountId: ACC, stageName: 'Perdido', lostReason })
      expect({ lostReason, ...answer }).toMatchObject({ lostReason, ok: false, motivos: active })
    }
    expect(lose).not.toHaveBeenCalled()

    expect(await call('crm_advance_stage', { accountId: ACC, stageName: 'perdido', lostReason: 'DIJO QUE NO' })).toMatchObject({ ok: true })
    expect(lose).toHaveBeenCalledWith(ADMIN, ACC, expect.objectContaining({ lostReasonId: REASONS[0].id, expectedStageId: STAGES[3].id }))
    expect(moveStage).not.toHaveBeenCalled()
  })

  it('a stage that does not exist answers the stages; a business it cannot see answers not found', async () => {
    const { call } = setup()
    expect(await call('crm_advance_stage', { accountId: ACC, stageName: 'Cerrado' })).toMatchObject({
      ok: false,
      etapas: STAGES.map(stage => stage.name),
    })
    prismaMock.crmAccount.findFirst.mockResolvedValue(null)
    expect(await call('crm_advance_stage', { accountId: ACC, stageName: 'Negociación' })).toMatchObject({ ok: false })
    expect(moveStage).not.toHaveBeenCalled()
  })
})

// ── Notes and activities ──────────────────────────────────────────────────────────────────────────────────────────────

describe('crm_add_note and crm_add_activity', () => {
  it('a note is added once: the same note again the same day is not repeated', async () => {
    const { call } = setup()
    prismaMock.crmTimelineEvent.findFirst.mockResolvedValueOnce(null)
    expect(await call('crm_add_note')).toMatchObject({ ok: true, yaEstaba: false })
    expect(addNote).toHaveBeenCalledWith(ADMIN, ACC, { text: 'Pidió precios' })
    expect(auditMcpWrite).toHaveBeenCalledTimes(1)

    prismaMock.crmTimelineEvent.findFirst.mockResolvedValueOnce({ id: cuid('event') })
    expect(await call('crm_add_note')).toMatchObject({ ok: true, yaEstaba: true })
    expect(addNote).toHaveBeenCalledTimes(1)
    expect(auditMcpWrite).toHaveBeenCalledTimes(1)
  })

  it('an activity is scheduled once, and its due time comes back in Mexico City time', async () => {
    const { call } = setup()
    const dueAt = new Date('2026-11-03T16:00:00.000Z')
    ;(addActivity as jest.Mock).mockResolvedValue({ id: cuid('act'), type: 'LLAMADA', title: 'Llamarle', dueAt })
    prismaMock.crmActivity.findFirst.mockResolvedValueOnce(null)
    expect(await call('crm_add_activity')).toMatchObject({ ok: true, yaEstaba: false, vence: '2026-11-03 10:00' })
    expect(addActivity).toHaveBeenCalledWith(ADMIN, ACC, { type: 'LLAMADA', title: 'Llamarle', dueAt })

    prismaMock.crmActivity.findFirst.mockResolvedValueOnce({ id: cuid('act'), dueAt })
    expect(await call('crm_add_activity')).toMatchObject({ ok: true, yaEstaba: true })
    expect(addActivity).toHaveBeenCalledTimes(1)
    expect(auditMcpWrite).toHaveBeenCalledTimes(1)
  })

  it('la_bitacora_de_una_actividad_por_mcp_no_lleva_su_titulo (D1, H2): el título puede nombrar a la persona', async () => {
    const { call } = setup()
    const dueAt = new Date('2026-11-03T16:00:00.000Z')
    ;(addActivity as jest.Mock).mockResolvedValue({ id: cuid('act'), type: 'LLAMADA', title: 'Llamarle', dueAt })
    prismaMock.crmActivity.findFirst.mockResolvedValueOnce(null)
    await call('crm_add_activity')
    expect(auditMcpWrite).toHaveBeenCalledTimes(1)
    expect(JSON.stringify((auditMcpWrite as jest.Mock).mock.calls)).not.toContain('Llamarle')
  })

  it('a refusal written for the operator comes back as ok:false with its code', async () => {
    const { NotFoundError } = jest.requireActual('@/errors/AppError')
    prismaMock.crmTimelineEvent.findFirst.mockResolvedValueOnce(null)
    ;(addNote as jest.Mock).mockRejectedValueOnce(new NotFoundError('No encontramos ese negocio', 'CRM_ACCOUNT_NOT_FOUND'))
    expect(await setup().call('crm_add_note')).toEqual({ ok: false, error: 'No encontramos ese negocio', code: 'CRM_ACCOUNT_NOT_FOUND' })
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })
})

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('crm_find_account, crm_pending and crm_pipeline_summary', () => {
  beforeEach(() => {
    ;(listAccounts as jest.Mock).mockResolvedValue({ rows: [ROW], nextCursor: null, total: 1 })
  })

  it('finds by canonical phone, by email or by text, within the caller scope and at most 20', async () => {
    const { call } = setup()
    const found = await call('crm_find_account', { phone: '55 1234 5678' })
    expect(listAccounts).toHaveBeenLastCalledWith(ADMIN, { q: '+525512345678', limit: 20 })
    expect(found).toMatchObject({
      ok: true,
      total: 1,
      hayMas: false,
      negocios: [expect.objectContaining({ id: ACC, nombre: 'Tacos Lupe', etapa: 'Demo', dueno: 'Sin dueño' })],
    })
    expect(found.negocios[0].proximaActividad).toMatchObject({ tipo: 'LLAMADA', vence: '2026-11-03 10:00' })

    // By email it is the exact email, never the fuzzy text search (which also matches phone digits).
    await call('crm_find_account', { email: ' ANA@Cafe.mx ' })
    expect(listAccounts).toHaveBeenLastCalledWith(ADMIN, { email: 'ana@cafe.mx', limit: 20 })
    await call('crm_find_account', { q: 'Tacos' })
    expect(listAccounts).toHaveBeenLastCalledWith(ADMIN, { q: 'Tacos', limit: 20 })
  })

  it('nothing to search by, or a phone that is not one, does not search', async () => {
    const { call } = setup()
    expect(await call('crm_find_account', {})).toMatchObject({ ok: false })
    expect(await call('crm_find_account', { phone: 'abc' })).toMatchObject({ ok: false })
    expect(listAccounts).not.toHaveBeenCalled()
  })

  it('«Mis pendientes» comes by section with its real total', async () => {
    const empty = { rows: [], total: 0 }
    ;(getPending as jest.Mock).mockResolvedValue({
      vencidas: { rows: [ROW], total: 73 },
      hoy: empty,
      sinSiguientePaso: empty,
      estancados: empty,
      nuevosSinDueno: empty,
    })
    const answer = await setup().call('crm_pending')
    expect(getPending).toHaveBeenCalledWith(ADMIN)
    expect(answer).toMatchObject({
      ok: true,
      vencidas: { total: 73, negocios: [expect.objectContaining({ id: ACC })] },
      hoy: { total: 0, negocios: [] },
    })
  })

  it('in «Vencidas» and «Hoy» it says which activity is mine (ruling 61); other sections do not carry it', async () => {
    const empty = { rows: [], total: 0 }
    const mine = { id: cuid('mine'), type: 'DEMO', title: 'Demo', dueAt: new Date('2026-11-03T18:00:00.000Z') }
    ;(getPending as jest.Mock).mockResolvedValue({
      vencidas: { rows: [{ ...ROW, miActividad: mine }], total: 1 },
      hoy: { rows: [{ ...ROW, miActividad: null }], total: 1 },
      sinSiguientePaso: empty,
      estancados: { rows: [ROW], total: 1 },
      nuevosSinDueno: empty,
    })
    const answer = await setup().call('crm_pending')
    expect(answer.vencidas.negocios[0].miActividad).toEqual({ tipo: 'DEMO', titulo: 'Demo', vence: '2026-11-03 12:00' })
    expect(answer.hoy.negocios[0].miActividad).toBeNull()
    expect(answer.estancados.negocios[0]).not.toHaveProperty('miActividad')
  })

  it('the pipeline summary is the reports of the current Mexico City month', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-01T05:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
    try {
      ;(getReports as jest.Mock).mockResolvedValue({
        porEtapa: [{ id: cuid('stage1'), name: 'Prospecto', kind: 'ABIERTA', total: 12, estancados: 3 }],
        abiertos: 12,
        estancados: 3,
        ganados: { total: 2 },
        perdidos: { total: 1 },
      })
      const answer = await setup().call('crm_pipeline_summary')
      // 05:00 UTC on Nov 1 is still Oct 31 in Mexico City.
      expect(getReports).toHaveBeenCalledWith(ADMIN, { desde: '2026-10-01', hasta: '2026-10-31' })
      expect(answer).toMatchObject({
        ok: true,
        porEtapa: [{ etapa: 'Prospecto', total: 12, estancados: 3 }],
        abiertos: 12,
        estancados: 3,
        mes: { desde: '2026-10-01', hasta: '2026-10-31', ganados: 2, perdidos: 1 },
      })
    } finally {
      jest.useRealTimers()
    }
  })
})

// ── Email: templates and campaign status (phase 2, plan task 8) ──────────────────────────────────────────────────────

describe('CRM MCP — email (read only)', () => {
  const TPL = cuid('tpl1')
  const CAMP = cuid('camp1')
  const BLOCKS = [{ type: 'texto', text: 'Cuerpo del correo para {{nombre}}' }]

  const campaignView = (over: Record<string, unknown> = {}) => ({
    id: CAMP,
    name: 'Novedades de noviembre',
    templateId: TPL,
    subject: 'Lo nuevo de Avoqado',
    blocks: BLOCKS,
    audience: { segmentos: [{ tipo: 'PROSPECTOS' }, { tipo: 'CLIENTES', planes: ['PRO'] }] },
    status: 'ENVIANDO',
    total: 40,
    createdById: SUPER.staffId,
    enqueuedAt: new Date('2026-11-03T16:00:00.000Z'),
    finishedAt: null,
    cancelledAt: null,
    createdAt: new Date('2026-11-03T15:00:00.000Z'),
    updatedAt: new Date('2026-11-03T16:00:00.000Z'),
    pruebaVigente: true,
    contadores: { ENVIADO: 25, PENDIENTE: 9, REINTENTO: 2, FALLIDO: 3, OMITIDO: 1 },
    ...over,
  })

  it('crm_list_email_templates: name, subject and date, paginated, never the blocks', async () => {
    ;(listTemplates as jest.Mock).mockResolvedValue({
      rows: [
        {
          id: TPL,
          name: 'Bienvenida',
          subject: 'Hola {{nombre}}',
          blocks: BLOCKS,
          archivedAt: null,
          createdById: SUPER.staffId,
          updatedById: SUPER.staffId,
          createdAt: new Date('2026-11-02T15:00:00.000Z'),
          updatedAt: new Date('2026-11-03T16:00:00.000Z'),
        },
      ],
      nextCursor: cuid('tpl2'),
      total: 61,
    })
    const answer = await setup().call('crm_list_email_templates', { limit: 1, cursor: cuid('tpl0'), archivadas: false })
    expect(listTemplates).toHaveBeenCalledWith({ limit: 1, cursor: cuid('tpl0'), archivadas: false })
    expect(answer).toEqual({
      ok: true,
      total: 61,
      hayMas: true,
      siguiente: cuid('tpl2'),
      plantillas: [
        {
          id: TPL,
          nombre: 'Bienvenida',
          asunto: 'Hola {{nombre}}',
          creada: '2026-11-02 09:00',
          actualizada: '2026-11-03 10:00',
          archivada: false,
        },
      ],
    })
    // The subject is there; the text of the blocks is not.
    expect(JSON.stringify(answer)).not.toContain(BLOCKS[0].text)
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('crm_list_email_templates: the last page says there is no more', async () => {
    ;(listTemplates as jest.Mock).mockResolvedValue({ rows: [], nextCursor: null, total: 0 })
    expect(await setup().call('crm_list_email_templates', {})).toEqual({
      ok: true,
      total: 0,
      hayMas: false,
      siguiente: null,
      plantillas: [],
    })
  })

  it('crm_campaign_status: the list carries the counters by state, zeros included, and never the content or the test hash', async () => {
    ;(listCampaigns as jest.Mock).mockResolvedValue({
      rows: [campaignView(), campaignView({ id: cuid('camp2'), contadores: {}, status: 'BORRADOR' })],
      nextCursor: null,
      total: 2,
    })
    const answer = await setup().call('crm_campaign_status', { status: 'ENVIANDO', limit: 20 })
    expect(listCampaigns).toHaveBeenCalledWith({ status: 'ENVIANDO', limit: 20 })
    expect(getCampaign).not.toHaveBeenCalled()
    expect(answer).toMatchObject({ ok: true, total: 2, hayMas: false, siguiente: null })
    expect(answer.campanas[0]).toEqual({
      id: CAMP,
      nombre: 'Novedades de noviembre',
      estado: 'ENVIANDO',
      asunto: 'Lo nuevo de Avoqado',
      publicos: ['PROSPECTOS', 'CLIENTES'],
      total: 40,
      pruebaVigente: true,
      contadores: { pendientes: 9, enCurso: 0, enviados: 25, reintentos: 2, fallidos: 3, omitidos: 1, desconocidos: 0 },
      creada: '2026-11-03 09:00',
      encolada: '2026-11-03 10:00',
      terminada: null,
      cancelada: null,
    })
    expect(answer.campanas[1].contadores).toEqual({
      pendientes: 0,
      enCurso: 0,
      enviados: 0,
      reintentos: 0,
      fallidos: 0,
      omitidos: 0,
      desconocidos: 0,
    })
    expect(JSON.stringify(answer)).not.toContain(BLOCKS[0].text)
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('crm_campaign_status with an id: that campaign alone, and DESCONOCIDO is counted apart (we do not know whether it went out)', async () => {
    ;(getCampaign as jest.Mock).mockResolvedValue(
      campaignView({ status: 'ENVIADA', contadores: { ENVIADO: 38, DESCONOCIDO: 2 }, finishedAt: new Date('2026-11-03T18:00:00.000Z') }),
    )
    const answer = await setup().call('crm_campaign_status', { campaignId: CAMP })
    expect(getCampaign).toHaveBeenCalledWith(CAMP)
    expect(listCampaigns).not.toHaveBeenCalled()
    expect(answer).toMatchObject({
      ok: true,
      campana: { id: CAMP, estado: 'ENVIADA', terminada: '2026-11-03 12:00', contadores: { enviados: 38, desconocidos: 2, pendientes: 0 } },
    })
  })

  it('crm_campaign_status: a campaign that does not exist comes back ok:false with its code, not as a crash', async () => {
    ;(getCampaign as jest.Mock).mockRejectedValue(new NotFoundError('Esa campaña no existe', 'CRM_CAMPANA_NOT_FOUND'))
    expect(await setup().call('crm_campaign_status', { campaignId: CAMP })).toEqual({
      ok: false,
      error: 'Esa campaña no existe',
      code: 'CRM_CAMPANA_NOT_FOUND',
    })
  })

  it('«desconocidos» is described with BOTH origins: Resend accepted it and it was not saved, or 23 h passed since the first attempt (I1)', () => {
    const { descriptions } = setup()
    const description = descriptions.crm_campaign_status.replace(/\s+/g, ' ')
    // Not «delivered»: the safe reading of «unknown» is that it may never have left.
    expect(description).toMatch(/desconocidos: no sabemos si salieron/)
    expect(description).toMatch(/aceptó y no alcanzamos a guardarlo/)
    expect(description).toMatch(/pasaron más de 23 h desde el primer intento/)
  })

  it('conLlave with a LIST that holds «crm:editar» still demands the write grant, and with it any one key opens (M1)', async () => {
    const run = jest.fn().mockResolvedValue({ ok: true })
    const readOnly = { ...SUPER, scopes: ['mcp:read'] } as McpScope
    await expect(conLlave(readOnly, ['crm:editar', 'crm:admin'], run)).rejects.toThrow(/mcp:write/)
    await expect(conLlave(readOnly, ['crm:admin', 'crm:editar'], run)).rejects.toThrow(/mcp:write/)
    expect(run).not.toHaveBeenCalled()
    expect(getCrmAccess).not.toHaveBeenCalled()

    // With the grant it runs; one key of the list is enough (the person has «admin» but not «editar»).
    ;(getCrmAccess as jest.Mock).mockResolvedValue({ ...ADMIN, editar: null })
    const answer = JSON.parse((await conLlave(SUPER, ['crm:editar', 'crm:admin'], run)).content[0].text)
    expect(answer).toEqual({ ok: true })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keys: templates open with «Mandar correo», «Campañas masivas» or «Administrar»; campaigns only with the last two', async () => {
    ;(listTemplates as jest.Mock).mockResolvedValue({ rows: [], nextCursor: null, total: 0 })
    ;(listCampaigns as jest.Mock).mockResolvedValue({ rows: [], nextCursor: null, total: 0 })
    const none = { ...ADMIN, contactar: false, campanas: false, admin: false }
    const only = (key: 'contactar' | 'campanas' | 'admin') => ({ ...none, [key]: true })
    const reads = async (access: CrmAccess) => {
      ;(getCrmAccess as jest.Mock).mockResolvedValue(access)
      const { call } = setup()
      return {
        plantillas: (await call('crm_list_email_templates', {})).ok,
        campanas: (await call('crm_campaign_status', {})).ok,
      }
    }
    expect(await reads(only('contactar') as CrmAccess)).toEqual({ plantillas: true, campanas: false })
    expect(await reads(only('campanas') as CrmAccess)).toEqual({ plantillas: true, campanas: true })
    expect(await reads(only('admin') as CrmAccess)).toEqual({ plantillas: true, campanas: true })
    expect(await reads(none)).toEqual({ plantillas: false, campanas: false })
    // The refusal names the keys, in the words of the screens.
    const { call } = setup()
    expect(await call('crm_campaign_status', {})).toMatchObject({ ok: false, error: expect.stringContaining('crm:campanas') })
    expect(await call('crm_list_email_templates', {})).toMatchObject({ ok: false, error: expect.stringContaining('crm:contactar') })
  })

  it('they say that sending is not here: a campaign or an email is irreversible and mass, so only a person sends it from the screens', () => {
    const { descriptions } = setup()
    for (const name of ['crm_list_email_templates', 'crm_campaign_status']) {
      expect(descriptions[name]).toMatch(/no (manda|envía)/i)
      expect(descriptions[name]).toMatch(/SUPERADMIN|pantalla/i)
    }
  })

  it('real protocol: the page is capped at 100, a hostile limit or a bad id is refused before any service runs', async () => {
    ;(listTemplates as jest.Mock).mockResolvedValue({ rows: [], nextCursor: null, total: 0 })
    const c = await connect('manual')
    try {
      for (const [name, args] of [
        ['crm_list_email_templates', { limit: 500 }],
        ['crm_list_email_templates', { limit: 0 }],
        ['crm_list_email_templates', { cursor: 'no-es-un-id' }],
        ['crm_campaign_status', { limit: 101 }],
        ['crm_campaign_status', { campaignId: 'no-es-un-id' }],
        ['crm_campaign_status', { status: 'ENVIADOS' }],
      ] as const) {
        expect({ name, args, isError: (await c.client.callTool({ name, arguments: args })).isError }).toEqual({ name, args, isError: true })
      }
      expect(listTemplates).not.toHaveBeenCalled()
      expect(listCampaigns).not.toHaveBeenCalled()
      expect(getCampaign).not.toHaveBeenCalled()

      const ok = await c.client.callTool({ name: 'crm_list_email_templates', arguments: { limit: 100 } })
      expect(ok.isError).toBeFalsy()
      expect(listTemplates).toHaveBeenCalledWith({ limit: 100 })
    } finally {
      await c.close()
    }
  })
})
