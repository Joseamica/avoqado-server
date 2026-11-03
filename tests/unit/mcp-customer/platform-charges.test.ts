import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TOOL_EFFECTS } from '@/mcp/catalog'
import { DIRECTORY_TOOLS } from '@/mcp/directory/catalog'
import type { McpScope } from '@/mcp/scope'
import { registerAllTools } from '@/mcp/server'
import { registerPlatformChargeTools } from '@/mcp/tools/platformCharges'
import {
  listOccurrences,
  summarizeOccurrences,
  type ChargeSummary,
  type OccurrenceView,
} from '@/services/superadmin/platform-charges/occurrences.service'

jest.mock('@/services/superadmin/platform-charges/occurrences.service', () => ({
  ...jest.requireActual('@/services/superadmin/platform-charges/occurrences.service'),
  summarizeOccurrences: jest.fn(),
  listOccurrences: jest.fn(),
}))

/**
 * «Por cobrar» desde el MCP (spec 2026-11-02-por-cobrar-superadmin §8): una sola tool de LECTURA, sólo para el equipo de Avoqado, que
 * contesta vencido, hoy y próximos 7 días EN PESOS. Los totales son los agregados exactos de `summarizeOccurrences` (nunca la suma de
 * una página); las filas las acota el servidor y la respuesta dice cuántas hay, para que nada se trunque en silencio. No entra al
 * directorio certificado.
 */

const summarize = summarizeOccurrences as jest.Mock
const list = listOccurrences as jest.Mock

const TODAY = '2026-11-02'

const SUMMARY: ChargeSummary = {
  today: TODAY,
  overdue: { count: 2, totalCents: 173884 },
  dueToday: { count: 1, totalCents: 58000 },
  upcoming: { count: 3, totalCents: 200050 },
  paidThisMonth: { count: 9, totalCents: 999999 },
}

function view(over: Partial<OccurrenceView> = {}): OccurrenceView {
  return {
    id: 'coccmcp0000000000000001',
    chargeId: 'cchargemcp00000000000001',
    customerName: 'Café Ana',
    frequency: 'MONTHLY',
    dueDate: '2026-10-28',
    concepts: [
      { description: 'Renta de terminal', amountCents: 50000, ivaMode: 'WITHOUT_IVA', satProductKey: '81112401', satUnitKey: 'E48' },
      { description: 'Licencia', amountCents: 49900, ivaMode: 'WITH_IVA', satProductKey: '43232611', satUnitKey: 'E48' },
    ],
    subtotalCents: 150000,
    taxCents: 23884,
    totalCents: 173884,
    invoiceMode: 'AUTOMATIC',
    status: 'PENDING',
    paidAt: null,
    skippedAt: null,
    bucket: 'OVERDUE',
    invoice: null,
    ...over,
  }
}

function page(rows: OccurrenceView[], over: { total?: number; page?: number; pageSize?: number } = {}) {
  return { rows, total: rows.length, page: 1, pageSize: 25, ...over }
}

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>

/** Por omisión, una conexión de superadmin; `setup({})` es una sin la marca (quien no es superadmin no la trae). */
function setup(scopeOver: Partial<McpScope> = { isSuperAdmin: true }) {
  const registered: Record<string, { description: string; shape: z.ZodRawShape; handler: Handler }> = {}
  const server = {
    tool: jest.fn((name: string, description: string, shape: z.ZodRawShape, handler: Handler) => {
      registered[name] = { description, shape, handler }
    }),
  }
  const scope = { staffId: 'actor', scopes: ['mcp:read'], ...scopeOver } as McpScope
  registerPlatformChargeTools(server as unknown as McpServer, scope)
  return { server, registered, scope }
}

/** Lo que el asistente recibe: el texto de la respuesta, ya como objeto. */
const answer = async (handler: Handler, args: Record<string, unknown> = { page: 1, pageSize: 25 }) =>
  JSON.parse((await handler(args)).content[0].text) as Record<string, any>

beforeEach(() => {
  summarize.mockReset().mockResolvedValue(SUMMARY)
  list.mockReset().mockResolvedValue(page([view()]))
})

describe('list_platform_charges_due — quién la ve', () => {
  it('no se registra para quien no es superadmin', () => {
    expect(setup({ isSuperAdmin: false }).server.tool).not.toHaveBeenCalled()
    expect(setup({}).server.tool).not.toHaveBeenCalled()
  })

  it('se registra una sola vez para un superadmin, y es de LECTURA', () => {
    const { server } = setup()
    expect(server.tool.mock.calls.map(([name]) => name)).toEqual(['list_platform_charges_due'])
    expect(TOOL_EFFECTS.list_platform_charges_due).toBe('read')
  })

  it('🔴 quien deja de ser superadmin después de conectarse recibe el aviso de «sólo Avoqado» y no se lee nada', async () => {
    const { registered, scope } = setup()
    scope.isSuperAdmin = false

    const result = await answer(registered.list_platform_charges_due.handler)

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/^Sólo el equipo de Avoqado/) })
    expect(summarize).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })

  it('está en el MCP libre de un superadmin y en ningún otro lado: ni para un cliente ni en el directorio certificado', () => {
    const names = (scope: Partial<McpScope>) => {
      const tools: string[] = []
      const server = { tool: (...a: unknown[]) => tools.push(a[0] as string) } as never
      registerAllTools(
        server,
        { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map(), ...scope } as McpScope,
        {
          serializedEnabled: true,
          whiteLabelEnabled: true,
          catalogEnabled: true,
        },
      )
      return tools
    }
    expect(names({ isSuperAdmin: true })).toContain('list_platform_charges_due')
    expect(names({ isSuperAdmin: false })).not.toContain('list_platform_charges_due')
    expect(names({ isSuperAdmin: undefined })).not.toContain('list_platform_charges_due')
    expect(DIRECTORY_TOOLS.has('list_platform_charges_due')).toBe(false)
  })

  it('su descripción no nombra tablas, campos ni piezas internas', () => {
    const { description } = setup().registered.list_platform_charges_due
    expect(description.length).toBeGreaterThan(40)
    expect(description).not.toMatch(
      /PlatformCharge|Occurrence|totalCents|dueDate|invoiceMode|paidAt|prisma|postgres|findMany|schema|\bsrc\//i,
    )
    // Sí dice para quién es y que sólo lee.
    expect(description).toMatch(/Sólo para el equipo de Avoqado/)
    expect(description).toMatch(/Sólo lectura/)
  })
})

describe('list_platform_charges_due — lo que contesta', () => {
  it('vencido, hoy y próximos 7 días EN PESOS: 173884 centavos son 1738.84', async () => {
    const result = await answer(setup().registered.list_platform_charges_due.handler)

    expect(result.ok).toBe(true)
    expect(result.dia).toBe(TODAY)
    expect(result.vencido).toEqual({ cantidad: 2, totalMxn: 1738.84 })
    expect(result.hoy).toEqual({ cantidad: 1, totalMxn: 580 })
    expect(result.proximos7Dias).toEqual({ cantidad: 3, totalMxn: 2000.5 })
    // Nada de centavos en lo que lee el asistente, y lo de «pagado este mes» no se pidió.
    expect(JSON.stringify(result)).not.toMatch(/cents|173884|999999/i)
    expect(result.pagadoEsteMes).toBeUndefined()
  })

  it('🔴 los totales son los agregados exactos, nunca la suma de la página', async () => {
    // La página trae UNA fila de $1,738.84; el total de vencidos es de dos cobros y de otros $0.01 que no vienen en la página.
    summarize.mockResolvedValue({ ...SUMMARY, overdue: { count: 2, totalCents: 173885 } })
    list.mockResolvedValue(page([view()], { total: 6 }))

    const result = await answer(setup().registered.list_platform_charges_due.handler)

    expect(result.vencido).toEqual({ cantidad: 2, totalMxn: 1738.85 })
    expect(result.cobros).toHaveLength(1)
    expect(result.cobros[0].totalMxn).toBe(1738.84)
  })

  it('cada fila trae cliente, fecha de cobro, grupo, conceptos y total en pesos', async () => {
    list.mockResolvedValue(
      page([
        view({ customerName: 'Café Ana', dueDate: '2026-10-28', bucket: 'OVERDUE' }),
        view({ id: 'coccmcp0000000000000002', customerName: 'Estética Luna', dueDate: TODAY, totalCents: 58000, bucket: 'TODAY' }),
        view({ id: 'coccmcp0000000000000003', customerName: 'Gimnasio Sol', dueDate: '2026-11-09', totalCents: 1999, bucket: 'UPCOMING' }),
      ]),
    )

    const result = await answer(setup().registered.list_platform_charges_due.handler)

    expect(result.cobros).toEqual([
      { cliente: 'Café Ana', vence: '2026-10-28', grupo: 'vencido', conceptos: ['Renta de terminal', 'Licencia'], totalMxn: 1738.84 },
      { cliente: 'Estética Luna', vence: TODAY, grupo: 'hoy', conceptos: ['Renta de terminal', 'Licencia'], totalMxn: 580 },
      { cliente: 'Gimnasio Sol', vence: '2026-11-09', grupo: 'proximo', conceptos: ['Renta de terminal', 'Licencia'], totalMxn: 19.99 },
    ])
  })

  it('«próximos» son los 7 días de las tarjetas, no todo lo ya generado: una fila a 8 días no se lista', async () => {
    list.mockResolvedValue(
      page([
        view({ customerName: 'Dentro', dueDate: '2026-11-09', bucket: 'UPCOMING' }), // hoy + 7: entra
        view({ id: 'coccmcp0000000000000002', customerName: 'Fuera', dueDate: '2026-11-10', bucket: 'UPCOMING' }), // hoy + 8: no
      ]),
    )

    const result = await answer(setup().registered.list_platform_charges_due.handler)

    expect(result.cobros.map((row: { cliente: string }) => row.cliente)).toEqual(['Dentro'])
    // Y el total de «próximos» sigue siendo el de las tarjetas, no el de lo que haya en la lista.
    expect(result.proximos7Dias).toEqual({ cantidad: 3, totalMxn: 2000.5 })
  })

  it('lee las dos cosas en el MISMO instante, para que hoy sea el mismo día en el total y en la lista', async () => {
    await answer(setup().registered.list_platform_charges_due.handler)

    expect(summarize).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(1)
    expect(summarize.mock.calls[0][0]).toBeInstanceOf(Date)
    expect(summarize.mock.calls[0][0]).toBe(list.mock.calls[0][1])
    expect(list.mock.calls[0][0]).toEqual({ view: 'open', page: 1, pageSize: 25 })
  })

  it('sin cobros pendientes contesta ceros y una lista vacía, no un error', async () => {
    const empty = { count: 0, totalCents: 0 }
    summarize.mockResolvedValue({ ...SUMMARY, overdue: empty, dueToday: empty, upcoming: empty })
    list.mockResolvedValue(page([]))

    const result = await answer(setup().registered.list_platform_charges_due.handler)

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        vencido: { cantidad: 0, totalMxn: 0 },
        hoy: { cantidad: 0, totalMxn: 0 },
        proximos7Dias: { cantidad: 0, totalMxn: 0 },
        mostrando: 0,
        de: 0,
        hayMas: false,
        cobros: [],
      }),
    )
  })
})

describe('list_platform_charges_due — lo acota el servidor y lo dice', () => {
  it('dice cuántos muestra, de cuántos, y cómo ver el resto: nada se trunca en silencio', async () => {
    summarize.mockResolvedValue({
      ...SUMMARY,
      overdue: { count: 100, totalCents: 1 },
      dueToday: { count: 20, totalCents: 1 },
      upcoming: { count: 10, totalCents: 1 },
    })
    list.mockResolvedValue(page([view(), view({ id: 'coccmcp0000000000000002' })], { total: 130, page: 1, pageSize: 100 }))

    const first = await answer(setup().registered.list_platform_charges_due.handler, { page: 1, pageSize: 100 })

    // El total de la respuesta es el de las tarjetas (130), la página es la que acotó el servidor y quedan más.
    expect(first).toEqual(expect.objectContaining({ pagina: 1, porPagina: 100, mostrando: 2, de: 130, hayMas: true }))
    expect(first.nota).toMatch(/page/)

    list.mockResolvedValue(page([view()], { total: 130, page: 2, pageSize: 100 }))
    const second = await answer(setup().registered.list_platform_charges_due.handler, { page: 2, pageSize: 100 })
    expect(second).toEqual(expect.objectContaining({ pagina: 2, mostrando: 1, de: 130, hayMas: false }))
    expect(second.nota).toBeUndefined()
    expect(list).toHaveBeenLastCalledWith({ view: 'open', page: 2, pageSize: 100 }, expect.any(Date))
  })

  it('contesta con la página y el tamaño que ACOTÓ el servidor, no con lo que pidió el cliente', async () => {
    list.mockResolvedValue(page([view()], { total: 6, page: 1, pageSize: 100 }))

    const result = await answer(setup().registered.list_platform_charges_due.handler, { page: 1, pageSize: 100_000 })

    expect(result.porPagina).toBe(100)
  })

  it('la entrada ya viene acotada: página desde 1 y de 1 a 100 filas, con 1 y 25 por omisión', () => {
    const input = z.object(setup().registered.list_platform_charges_due.shape)

    expect(input.parse({})).toEqual({ page: 1, pageSize: 25 })
    expect(input.parse({ page: 3, pageSize: 100 })).toEqual({ page: 3, pageSize: 100 })
    for (const hostile of [{ pageSize: 101 }, { pageSize: 0 }, { page: 0 }, { page: 1.5 }, { pageSize: -5 }]) {
      expect(input.safeParse(hostile).success).toBe(false)
    }
  })
})
