/**
 * The CRM's reports and its CSV export (spec 2026-10-30 §5.7, plan task 9, ruling 35).
 *
 * What these pin beyond the happy path: every number is an aggregate the database computes — never accounts loaded to
 * be counted here; a «propios» seller's reports only count what they may see; the range is Mexico City's calendar; the
 * export asks for its own key, follows the same filters as the list, stops at 10,000 rows and says so, never carries a
 * phone or an email, cannot smuggle a formula into Excel, and leaves its ActivityLog with the count.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import type { CrmAccess } from '@/services/crm/access.service'
import { exportAccountsCsv, getReports } from '@/services/crm/reports.service'
import { logAction } from '@/services/dashboard/activity-log.service'

const SELLER = 'cstaffsel0000000000000001'
const OTHER = 'cstaffoth0000000000000001'
const PROSPECTO = 'cstageprs0000000000000001'
const DEMO = 'cstagedem0000000000000001'
const GANADO = 'cstagegan0000000000000001'
const PERDIDO = 'cstageper0000000000000001'
const PRECIO = 'creasonpr0000000000000001'

const NOW = new Date('2026-10-31T18:00:00.000Z')
const DAY = 86_400_000
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)
// 1-oct 00:00 and 31-oct 23:59:59.999 in Mexico City (UTC-6).
const FROM = new Date('2026-10-01T06:00:00.000Z')
const TO = new Date('2026-11-01T05:59:59.999Z')
const OCTOBER = { desde: '2026-10-01', hasta: '2026-10-31' }

const access = (over: Partial<CrmAccess> = {}): CrmAccess => ({
  staffId: SELLER,
  isSuperadmin: false,
  ver: 'propios',
  editar: 'propios',
  contactar: true,
  campanas: false,
  exportar: true,
  ventas: false,
  admin: false,
  ...over,
})

const MINE_OR_UNOWNED = { OR: [{ ownerStaffId: SELLER }, { ownerStaffId: null }] }

const STAGES = [
  { id: PROSPECTO, name: 'Prospecto', order: 1, kind: 'ABIERTA', staleDays: 2 },
  { id: DEMO, name: 'Demo', order: 4, kind: 'ABIERTA', staleDays: 5 },
  { id: GANADO, name: 'Ganado', order: 6, kind: 'GANADA', staleDays: null },
  { id: PERDIDO, name: 'Perdido', order: 7, kind: 'PERDIDA', staleDays: null },
]

const MODELS = ['crmAccount', 'crmStage', 'crmLostReason', 'staff'] as const

beforeEach(() => {
  for (const model of MODELS) for (const fn of Object.values(prismaMock[model]) as jest.Mock[]) fn.mockReset()
  prismaMock.$queryRaw.mockReset()
  jest.mocked(logAction).mockClear()
  prismaMock.crmStage.count.mockResolvedValue(7)
  prismaMock.crmLostReason.count.mockResolvedValue(5)
  prismaMock.crmStage.findMany.mockImplementation(async ({ where }: any = {}) =>
    where ? STAGES.filter(stage => stage.kind === 'ABIERTA') : STAGES,
  )
  prismaMock.crmLostReason.findMany.mockResolvedValue([{ id: PRECIO, name: 'Precio', active: true }])
  prismaMock.staff.findMany.mockResolvedValue([
    { id: SELLER, firstName: 'Luis', lastName: 'Ramírez' },
    { id: OTHER, firstName: 'Ana', lastName: 'Soto' },
  ])
  prismaMock.crmAccount.groupBy.mockResolvedValue([])
  prismaMock.crmAccount.findMany.mockResolvedValue([])
  prismaMock.crmAccount.count.mockResolvedValue(0)
  prismaMock.$queryRaw.mockResolvedValue([])
})

/** The text of a raw query, with its binds apart. */
const sqlOf = (call: unknown[]) => call[0] as Prisma.Sql
const rawCall = (needle: string) => prismaMock.$queryRaw.mock.calls.map(sqlOf).find((sql: Prisma.Sql) => sql.sql.includes(needle))

describe('getReports', () => {
  /** What the database answers to each aggregate. */
  function aggregates() {
    prismaMock.crmAccount.groupBy.mockImplementation(async ({ by, where }: any) => {
      const text = JSON.stringify(where)
      if (by[0] === 'stageId' && text.includes('lastTouchAt')) return [{ stageId: PROSPECTO, _count: { _all: 2 } }]
      if (by[0] === 'stageId')
        return [
          { stageId: PROSPECTO, _count: { _all: 5 } },
          { stageId: DEMO, _count: { _all: 3 } },
          { stageId: GANADO, _count: { _all: 4 } },
        ]
      if (text.includes('wonAt') && by[0] === 'ownerStaffId')
        return [
          { ownerStaffId: SELLER, _count: { _all: 3 } },
          { ownerStaffId: null, _count: { _all: 1 } },
        ]
      if (text.includes('wonAt') && by[0] === 'source') return [{ source: 'LANDING', _count: { _all: 4 } }]
      if (text.includes('lostAt') && by[0] === 'lostReasonId') return [{ lostReasonId: PRECIO, _count: { _all: 2 } }]
      if (text.includes('lostAt') && by[0] === 'ownerStaffId') return [{ ownerStaffId: OTHER, _count: { _all: 2 } }]
      if (text.includes('lostAt') && by[0] === 'source') return [{ source: 'WHATSAPP', _count: { _all: 2 } }]
      return []
    })
    prismaMock.$queryRaw.mockImplementation(async (sql: Prisma.Sql) => {
      if (sql.sql.includes('"CrmActivity"')) return [{ staffId: SELLER, semana: '2026-10-26', total: 7 }]
      if (sql.sql.includes('"wonAt"')) return [{ mes: '2026-10', total: 4 }]
      if (sql.sql.includes('"lostAt"')) return [{ mes: '2026-10', total: 2 }]
      return []
    })
  }

  it('reportes_usan_groupBy_no_findMany', async () => {
    aggregates()
    const report = await getReports(access(), OCTOBER, NOW)

    // Counted by the database, never loaded to be counted here.
    expect(prismaMock.crmAccount.findMany).not.toHaveBeenCalled()
    expect(prismaMock.crmAccount.groupBy).toHaveBeenCalled()

    expect(report.porEtapa).toEqual([
      { id: PROSPECTO, name: 'Prospecto', kind: 'ABIERTA', total: 5, estancados: 2 },
      { id: DEMO, name: 'Demo', kind: 'ABIERTA', total: 3, estancados: 0 },
      { id: GANADO, name: 'Ganado', kind: 'GANADA', total: 4, estancados: 0 },
      { id: PERDIDO, name: 'Perdido', kind: 'PERDIDA', total: 0, estancados: 0 },
    ])
    expect(report.abiertos).toBe(8)
    expect(report.estancados).toBe(2)
    expect(report.ganados).toEqual({
      total: 4,
      porMes: [{ mes: '2026-10', total: 4 }],
      porDueno: [
        { owner: { id: SELLER, name: 'Luis Ramírez' }, total: 3 },
        { owner: null, total: 1 },
      ],
      porFuente: [{ source: 'LANDING', total: 4 }],
    })
    expect(report.perdidos).toEqual({
      total: 2,
      porMes: [{ mes: '2026-10', total: 2 }],
      porMotivo: [{ motivo: { id: PRECIO, name: 'Precio' }, total: 2 }],
      porDueno: [{ owner: { id: OTHER, name: 'Ana Soto' }, total: 2 }],
      porFuente: [{ source: 'WHATSAPP', total: 2 }],
    })
    expect(report.actividades).toEqual([{ persona: { id: SELLER, name: 'Luis Ramírez' }, semana: '2026-10-26', total: 7 }])
    // The names of everyone the report mentions, in one query.
    expect(prismaMock.staff.findMany).toHaveBeenCalledTimes(1)
  })

  it('reportes_cuentan_solo_lo_que_el_vendedor_ve_y_sin_archivados', async () => {
    aggregates()
    await getReports(access(), OCTOBER, NOW)

    for (const [args] of prismaMock.crmAccount.groupBy.mock.calls) {
      expect(args.where.AND).toContainEqual(MINE_OR_UNOWNED)
      expect(args.where.AND).toContainEqual({ archivedAt: null })
    }
    // The bucketed queries carry the same scope in SQL: mine or nobody's.
    for (const needle of ['"wonAt"', '"lostAt"', '"CrmActivity"']) {
      const sql = rawCall(needle)
      expect(sql.sql).toContain('"ownerStaffId" IS NULL')
      expect(sql.values).toContain(SELLER)
      expect(sql.sql).toContain('"archivedAt" IS NULL')
    }

    // «todos» sees everyone: no seller id anywhere.
    prismaMock.$queryRaw.mockClear()
    await getReports(access({ ver: 'todos' }), OCTOBER, NOW)
    for (const needle of ['"wonAt"', '"lostAt"', '"CrmActivity"']) expect(rawCall(needle).values).not.toContain(SELLER)
  })

  it('reportes_el_rango_es_el_calendario_de_ciudad_de_mexico', async () => {
    aggregates()
    await getReports(access(), OCTOBER, NOW)

    const won = prismaMock.crmAccount.groupBy.mock.calls.find(([args]: any) => JSON.stringify(args.where).includes('wonAt'))[0]
    expect(won.where.AND).toContainEqual({ wonAt: { gte: FROM, lte: TO } })
    const lost = prismaMock.crmAccount.groupBy.mock.calls.find(([args]: any) => JSON.stringify(args.where).includes('lostAt'))[0]
    expect(lost.where.AND).toContainEqual({ lostAt: { gte: FROM, lte: TO } })
    // Raw SQL binds the same instants (through utcTs) and buckets in Mexico City's wall clock.
    for (const needle of ['"wonAt"', '"lostAt"', '"CrmActivity"']) {
      const sql = rawCall(needle)
      expect(sql.values).toEqual(expect.arrayContaining([FROM, TO, 'America/Mexico_City']))
      expect(sql.sql).toContain("AT TIME ZONE 'UTC'")
    }
  })

  it('reportes_rango_invalido_422', async () => {
    await expect(getReports(access(), { desde: '2026-10-31', hasta: '2026-10-01' }, NOW)).rejects.toMatchObject({ statusCode: 422 })
    await expect(getReports(access(), { desde: '2025-01-01', hasta: '2026-10-31' }, NOW)).rejects.toMatchObject({ statusCode: 422 })
    expect(prismaMock.crmAccount.groupBy).not.toHaveBeenCalled()
  })
})

describe('exportAccountsCsv', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'caccounta0000000000000001',
    name: 'Café Tlalpan',
    giro: 'Cafetería',
    ventasRango: 'Menos de $150 mil',
    sucursales: 2,
    source: 'LANDING',
    owner: { firstName: 'Luis', lastName: 'Ramírez' },
    stage: { name: 'Prospecto' },
    nextActivityAt: null,
    lastTouchAt: daysAgo(1),
    wonAt: null,
    lostAt: null,
    lostReason: null,
    createdAt: new Date('2026-10-20T20:30:00.000Z'),
    ...over,
  })

  it('exportar_sin_llave_403', async () => {
    await expect(exportAccountsCsv(access({ exportar: false }), {}, NOW)).rejects.toMatchObject({ statusCode: 403, code: 'CRM_FORBIDDEN' })
    expect(prismaMock.crmAccount.findMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('exportar_registra_conteo', async () => {
    prismaMock.crmAccount.findMany.mockResolvedValueOnce([row(), row({ id: 'caccountb0000000000000001', owner: null })])
    prismaMock.crmAccount.count.mockResolvedValue(2)

    const out = await exportAccountsCsv(access(), { sinDueno: true }, NOW)

    expect(out).toMatchObject({ filas: 2, total: 2, truncado: false })
    expect(logAction).toHaveBeenCalledWith({
      staffId: SELLER,
      venueId: null,
      action: 'CRM_EXPORT',
      entity: 'CrmAccount',
      data: { filas: 2, total: 2, truncado: false, filtros: { sinDueno: true } },
    })
    const lines = out.csv.split('\r\n')
    expect(lines[0]).toBe(
      'Negocio,Giro,Ventas al mes,Sucursales,Fuente,Dueño,Etapa,Próxima actividad,Último toque,Ganado,Perdido,Motivo de pérdida,Creado',
    )
    // 14:30 in Mexico City, not 20:30 UTC; an unowned account says «Sin dueño».
    expect(lines[1]).toBe('Café Tlalpan,Cafetería,Menos de $150 mil,2,LANDING,Luis Ramírez,Prospecto,,2026-10-30 12:00,,,,2026-10-20 14:30')
    expect(lines[2]).toContain(',Sin dueño,')
  })

  it('exportar_nunca_lleva_telefono_ni_correo', async () => {
    await exportAccountsCsv(access(), {}, NOW)
    const { select } = prismaMock.crmAccount.findMany.mock.calls[0][0]
    expect(select).not.toHaveProperty('contacts')
    expect(JSON.stringify(select)).not.toMatch(/email|phone/i)
  })

  it('exportar_escapa_formulas', async () => {
    prismaMock.crmAccount.findMany.mockResolvedValueOnce([
      row({ name: '=HYPERLINK("http://malo.mx","clic")', giro: '+52 55', ventasRango: '-1', owner: { firstName: '@admin', lastName: '' } }),
    ])
    prismaMock.crmAccount.count.mockResolvedValue(1)

    const { csv } = await exportAccountsCsv(access(), {}, NOW)
    const [, line] = csv.split('\r\n')
    // Excel runs what starts with = + - @: each such cell starts with a quote mark instead, and stays one cell.
    expect(line.startsWith(`"'=HYPERLINK(""http://malo.mx"",""clic"")",'+52 55,'-1,`)).toBe(true)
    expect(line).toContain(",'@admin,")
  })

  it('exportar_usa_los_filtros_y_el_alcance_de_la_lista', async () => {
    await exportAccountsCsv(access(), { stageId: PROSPECTO, sinDueno: true, source: 'LANDING' }, NOW)

    const { where, orderBy } = prismaMock.crmAccount.findMany.mock.calls[0][0]
    expect(where.AND).toEqual(
      expect.arrayContaining([
        MINE_OR_UNOWNED,
        { archivedAt: null },
        { stageId: PROSPECTO },
        // «Sin dueño» is work to take: open stages only (m-6), in the export as in the list.
        { ownerStaffId: null, stage: { kind: 'ABIERTA' } },
        { source: 'LANDING' },
      ]),
    )
    expect(orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
    expect(prismaMock.crmAccount.count).toHaveBeenCalledWith({ where })
  })

  it('exportar_tope_de_10000_filas_por_paginas_y_lo_dice', async () => {
    let served = 0
    prismaMock.crmAccount.findMany.mockImplementation(async ({ take }: { take: number }) =>
      Array.from({ length: take }, () => row({ id: `cacc${String(++served).padStart(21, '0')}` })),
    )
    prismaMock.crmAccount.count.mockResolvedValue(25_000)

    const out = await exportAccountsCsv(access(), {}, NOW)

    expect(out).toMatchObject({ filas: 10_000, total: 25_000, truncado: true })
    expect(out.csv.split('\r\n')).toHaveLength(10_001)
    const pages = prismaMock.crmAccount.findMany.mock.calls.map(([args]: any) => args)
    // Bounded pages, each one after the last row of the previous one.
    expect(pages).toHaveLength(10)
    expect(pages.every((page: any) => page.take <= 1000)).toBe(true)
    expect(pages[0].cursor).toBeUndefined()
    expect(pages[1]).toMatchObject({ cursor: { id: `cacc${String(1000).padStart(21, '0')}` }, skip: 1 })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ filas: 10_000, truncado: true }) }))
  })
})
