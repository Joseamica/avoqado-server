import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { BadRequestError } from '@/errors/AppError'
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

function page(rows: OccurrenceView[], over: { total?: number; page?: number; pageSize?: number; sumCents?: number } = {}) {
  return { rows, total: rows.length, page: 1, pageSize: 25, sumCents: rows.reduce((sum, row) => sum + row.totalCents, 0), ...over }
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

describe('list_platform_charges_due — filtros y suma (NEW)', () => {
  const FILTROS = {
    frequency: ['MONTHLY', 'ONE_TIME'],
    invoice: ['PENDING', 'NONE'],
    customerType: ['ORGANIZATION'],
    from: '2026-11-01',
    to: '2026-11-30',
    customer: 'Café Ana',
  }

  it('la entrada acepta los filtros, todos opcionales, sin cambiar los defaults de hoy', () => {
    const input = z.object(setup().registered.list_platform_charges_due.shape)

    expect(input.parse({})).toEqual({ page: 1, pageSize: 25 })
    expect(input.parse(FILTROS)).toEqual({ page: 1, pageSize: 25, ...FILTROS })
  })

  it('🔴 los valores que no existen o mal formados se rechazan en la entrada, antes de leer nada', () => {
    const input = z.object(setup().registered.list_platform_charges_due.shape)

    for (const hostile of [
      { frequency: ['DIARIO'] },
      { frequency: 'MONTHLY' }, // un arreglo, no un texto
      { invoice: ['FACTURADO'] },
      { customerType: ['NADIE'] },
      { from: '01/11/2026' },
      { to: '2026-11-01T00:00:00Z' },
      { customer: 'x'.repeat(121) },
    ]) {
      expect(input.safeParse(hostile).success).toBe(false)
    }
  })

  it('con filtros: se los pasa al servicio con la vista de pendientes, en el MISMO instante que el resumen', async () => {
    await answer(setup().registered.list_platform_charges_due.handler, { page: 2, pageSize: 10, ...FILTROS })

    expect(list).toHaveBeenCalledTimes(1)
    expect(list.mock.calls[0][0]).toEqual({ view: 'open', page: 2, pageSize: 10, ...FILTROS })
    expect(list.mock.calls[0][1]).toBe(summarize.mock.calls[0][0])
  })

  it('🔴 devuelve la suma del filtro COMPLETO en pesos (no la de la página) y cuántos cobros son; los grupos de hoy no cambian', async () => {
    list.mockResolvedValue(page([view({ totalCents: 100 })], { total: 7, sumCents: 123456, pageSize: 1 }))

    const result = await answer(setup().registered.list_platform_charges_due.handler, { page: 1, pageSize: 1, ...FILTROS })

    expect(result.filtrados).toEqual({ cantidad: 7, totalMxn: 1234.56 })
    expect(result.vencido).toEqual({ cantidad: 2, totalMxn: 1738.84 }) // sigue siendo el de todos los pendientes
    expect(result.notaFiltros).toMatch(/vencido, hoy y proximos7Dias/)
    expect(JSON.stringify(result)).not.toMatch(/cents|123456/i)
  })

  it('con filtros la lista es la del filtro (sin el corte de 7 días) y «de» y «hayMas» cuentan sus cobros', async () => {
    list.mockResolvedValue(
      page(
        [
          view({ customerName: 'Cerca', dueDate: '2026-11-05', bucket: 'UPCOMING' }),
          view({ id: 'coccmcp0000000000000002', customerName: 'Lejos', dueDate: '2026-12-20', bucket: 'UPCOMING' }), // a más de 7 días
        ],
        { total: 5, pageSize: 2 },
      ),
    )

    const result = await answer(setup().registered.list_platform_charges_due.handler, { page: 1, pageSize: 2, ...FILTROS })

    expect(result.cobros.map((row: { cliente: string }) => row.cliente)).toEqual(['Cerca', 'Lejos'])
    expect(result).toEqual(expect.objectContaining({ mostrando: 2, de: 5, hayMas: true }))
    expect(result.nota).toMatch(/page/)
  })

  it('sin cobros que cumplan el filtro: la suma es 0 y la lista, vacía; no es un error', async () => {
    list.mockResolvedValue(page([], { total: 0, sumCents: 0 }))

    const result = await answer(setup().registered.list_platform_charges_due.handler, { page: 1, pageSize: 25, frequency: ['WEEKLY'] })

    expect(result).toEqual(
      expect.objectContaining({ ok: true, filtrados: { cantidad: 0, totalMxn: 0 }, mostrando: 0, de: 0, hayMas: false, cobros: [] }),
    )
  })

  it('🔴 sin filtros la respuesta es la de siempre: ni «filtrados» ni «notaFiltros», y el servicio recibe lo mismo de siempre', async () => {
    const result = await answer(setup().registered.list_platform_charges_due.handler)

    expect(result.filtrados).toBeUndefined()
    expect(result.notaFiltros).toBeUndefined()
    expect(list.mock.calls[0][0]).toEqual({ view: 'open', page: 1, pageSize: 25 })
  })

  it('un filtro vacío (arreglo vacío o texto en blanco) cuenta como sin filtro: respuesta de siempre', async () => {
    const result = await answer(setup().registered.list_platform_charges_due.handler, {
      page: 1,
      pageSize: 25,
      frequency: [],
      invoice: [],
      customerType: [],
      customer: '   ',
    })

    expect(result.filtrados).toBeUndefined()
    expect(list.mock.calls[0][0]).toEqual({ view: 'open', page: 1, pageSize: 25 })
  })

  it('un rechazo del servicio por el rango de fechas llega al asistente como mensaje claro, no como error interno', async () => {
    list.mockRejectedValue(new BadRequestError('La fecha inicial no puede ser después de la final', 'PLATFORM_CHARGE_INVALID_DATE_RANGE'))

    const result = await answer(setup().registered.list_platform_charges_due.handler, {
      page: 1,
      pageSize: 25,
      from: '2026-11-10',
      to: '2026-11-09',
    })

    expect(result).toEqual({ ok: false, error: 'La fecha inicial no puede ser después de la final' })
  })

  it('un error que no es de negocio NO se traga: sale tal cual, para que lo sanee y lo registre el instrumento del MCP', async () => {
    list.mockRejectedValue(new Error('se cayó la base'))

    await expect(setup().registered.list_platform_charges_due.handler({ page: 1, pageSize: 25, ...FILTROS })).rejects.toThrow(
      'se cayó la base',
    )
  })

  it('la descripción ya no dice sólo «recurrentes»: habla de cobros de una sola vez y de los filtros, y sigue siendo de sólo lectura y para Avoqado', () => {
    const { description } = setup().registered.list_platform_charges_due

    expect(description).toMatch(/una sola vez/)
    expect(description).toMatch(/periodicidad/)
    expect(description).toMatch(/factura/)
    expect(description).toMatch(/Sólo lectura/)
    expect(description).toMatch(/Sólo para el equipo de Avoqado/)
    expect(description).not.toMatch(
      /PlatformCharge|Occurrence|totalCents|dueDate|invoiceMode|paidAt|prisma|postgres|findMany|schema|\bsrc\//i,
    )
  })
})
