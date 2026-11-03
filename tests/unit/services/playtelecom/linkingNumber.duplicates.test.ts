/**
 * Repetidos del número de vinculación en la organización (spec §5.2). Prisma va doblado: aquí se prueba lo que la
 * función hace con lo que devuelve la base (quitarse a sí misma, el histórico de su ICCID, total exacto, 3 más recientes)
 * y la forma de las consultas. Que el SQL cuente y ordene bien contra Postgres real lo prueba
 * tests/integration/playtelecom/linkingNumberAlertFilter.integration.test.ts.
 */
import {
  findDuplicatesForSales,
  isNumberDuplicate,
  findVerificationIdsWithNumberAlert,
  type SaleNumbers,
} from '@/services/playtelecom/linkingNumber.duplicates'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { $queryRaw: jest.fn(), historicalLinkingNumber: { findMany: jest.fn() } },
}))

const queryRaw = prisma.$queryRaw as jest.Mock
const histFindMany = prisma.historicalLinkingNumber.findMany as jest.Mock

const ORG = 'org-1'
const N = '5512345678'
const sqlOf = (call = 0) => (queryRaw.mock.calls[call][0] as { sql: string }).sql
const valuesOf = (call = 0) => (queryRaw.mock.calls[call][0] as { values: unknown[] }).values

type Row = {
  n: string
  k: string
  total: bigint
  d: Date | null
  sv_id: string | null
  status: string | null
  first_name: string | null
  last_name: string | null
  venue_name: string | null
}
const saleRow = (n: string, id: string, total: number, opts: Partial<Row> = {}): Row => ({
  n,
  k: `sv:${id}`,
  total: BigInt(total),
  d: new Date('2026-10-20T18:00:00Z'),
  sv_id: id,
  status: 'COMPLETED',
  first_name: 'Ana',
  last_name: 'Pérez',
  venue_name: 'Walmart Centro',
  ...opts,
})
const histRow = (n: string, iccid: string, total: number, d: Date | null = null): Row => ({
  n,
  k: `h:${iccid}`,
  total: BigInt(total),
  d,
  sv_id: null,
  status: null,
  first_name: null,
  last_name: null,
  venue_name: null,
})
const sale = (o: Partial<SaleNumbers> & { key: string }): SaleNumbers => ({
  verificationId: null,
  iccid: null,
  linkingNumber: null,
  portedNumber: null,
  ...o,
})

beforeEach(() => {
  jest.clearAllMocks()
  histFindMany.mockResolvedValue([])
})

describe('findDuplicatesForSales', () => {
  it('choca con otra venta de la organización en cualquier estado y en cualquier campo', async () => {
    queryRaw.mockResolvedValue([
      saleRow(N, 'x', 3),
      saleRow(N, 'r', 3, { status: 'REJECTED', d: new Date('2026-10-19T18:00:00Z') }),
      saleRow(N, 'f', 3, { status: 'FAILED', d: new Date('2026-10-18T18:00:00Z') }),
    ])

    const out = await findDuplicatesForSales(ORG, [sale({ key: 'x', verificationId: 'x', iccid: 'I1', linkingNumber: N })])

    expect(out.get('x')?.linking).toEqual({
      total: 2,
      matches: [
        {
          kind: 'SALE',
          verificationId: 'r',
          status: 'REJECTED',
          date: new Date('2026-10-19T18:00:00Z'),
          staffName: 'Ana Pérez',
          venueName: 'Walmart Centro',
        },
        expect.objectContaining({ kind: 'SALE', verificationId: 'f', status: 'FAILED' }),
      ],
    })
    expect(out.get('x')?.ported).toBeUndefined()
    // Busca el número en los dos campos de las otras ventas, sin filtrar por estado.
    const sql = sqlOf()
    expect(sql).toContain('sv."linkingNumber" = ANY(')
    expect(sql).toContain('sv."portedNumber" = ANY(')
    expect(sql).not.toMatch(/\bstatus\s*(=|<>|IN\b|NOT IN\b)/i)
  })

  it('no choca consigo misma aunque tenga el mismo número en vinculación y portado', async () => {
    // La base devuelve UNA fila por llave: la propia venta sale una vez aunque esté en los dos campos.
    queryRaw.mockResolvedValue([saleRow(N, 'x', 1)])

    const out = await findDuplicatesForSales(ORG, [sale({ key: 'x', verificationId: 'x', linkingNumber: N, portedNumber: N })])

    expect(out.get('x')).toEqual({})
    // UNION (no UNION ALL): sin eso la venta contaría dos veces y se marcaría repetida consigo misma.
    expect(sqlOf()).toContain('UNION')
    expect(sqlOf()).not.toContain('UNION ALL')
  })

  it('una fila del histórico con otro ICCID choca; con el mismo ICCID no', async () => {
    queryRaw.mockResolvedValue([saleRow(N, 'x', 2), histRow(N, 'I2', 2)])
    const otra = await findDuplicatesForSales(ORG, [sale({ key: 'x', verificationId: 'x', iccid: 'I1', linkingNumber: N })])
    expect(otra.get('x')?.linking).toEqual({ total: 1, matches: [{ kind: 'HISTORICAL', date: null }] })

    queryRaw.mockResolvedValue([saleRow(N, 'x', 2), histRow(N, 'I1', 2)])
    histFindMany.mockResolvedValue([{ iccid: 'I1', number: N }])
    const misma = await findDuplicatesForSales(ORG, [sale({ key: 'x', verificationId: 'x', iccid: 'I1', linkingNumber: N })])
    expect(misma.get('x')).toEqual({})
    expect(histFindMany).toHaveBeenLastCalledWith({
      where: { organizationId: ORG, OR: [{ iccid: 'I1', number: N }] },
      select: { iccid: true, number: true },
      take: 1,
    })
  })

  // C2 (Codex r1): el importador guarda el ICCID con trim + mayúsculas; la venta pudo capturarlo con «f» minúscula.
  it('su propio histórico cuenta como suyo aunque la venta traiga el ICCID con minúscula o espacios (…901f vs …901F)', async () => {
    queryRaw.mockResolvedValue([saleRow(N, 'x', 2), histRow(N, '8952140012345678901F', 2)])
    histFindMany.mockResolvedValue([{ iccid: '8952140012345678901F', number: N }])

    const out = await findDuplicatesForSales(ORG, [
      sale({ key: 'x', verificationId: 'x', iccid: ' 8952140012345678901f ', linkingNumber: N }),
    ])

    expect(out.get('x')).toEqual({})
    expect(histFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, OR: [{ iccid: '8952140012345678901F', number: N }] } }),
    )
  })

  it('el histórico de su ICCID se descuenta del total aunque no salga entre las filas traídas', async () => {
    queryRaw.mockResolvedValue([1, 2, 3, 4, 5].map(i => saleRow(N, `o${i}`, 7)))
    histFindMany.mockResolvedValue([{ iccid: 'I1', number: N }])

    const out = await findDuplicatesForSales(ORG, [sale({ key: 'x', verificationId: 'x', iccid: 'I1', linkingNumber: N })])

    // 7 llaves: ella, su histórico y 5 ventas más.
    expect(out.get('x')?.linking?.total).toBe(5)
  })

  it('con 5 choques devuelve total 5 y las 3 más recientes', async () => {
    // Postgres: 6 llaves (ella + 5), trae las 5 más recientes en orden; ella cae en medio.
    queryRaw.mockResolvedValue([saleRow(N, 'o1', 6), saleRow(N, 'o2', 6), saleRow(N, 'x', 6), saleRow(N, 'o3', 6), saleRow(N, 'o4', 6)])

    const out = await findDuplicatesForSales(ORG, [sale({ key: 'x', verificationId: 'x', linkingNumber: N })])

    const linking = out.get('x')?.linking
    expect(linking?.total).toBe(5)
    expect(linking?.matches.map(m => (m.kind === 'SALE' ? m.verificationId : 'h'))).toEqual(['o1', 'o2', 'o3'])
  })

  it('si ella quedó fuera de las 5 traídas, igual se descuenta (sus números son los guardados)', async () => {
    queryRaw.mockResolvedValue([1, 2, 3, 4, 5].map(i => saleRow(N, `o${i}`, 7)))

    const out = await findDuplicatesForSales(ORG, [sale({ key: 'x', verificationId: 'x', linkingNumber: N })])

    expect(out.get('x')?.linking?.total).toBe(6)
    expect(out.get('x')?.linking?.matches).toHaveLength(3)
  })

  it('el total es exacto aunque un número tenga miles de choques, y no tapa a los demás números de la página', async () => {
    const A = '5511111111'
    const B = '5522222222'
    queryRaw.mockResolvedValue([...[1, 2, 3, 4, 5].map(i => saleRow(A, `a${i}`, 2001)), saleRow(B, 'b1', 2), saleRow(B, 'b2', 2)])

    const out = await findDuplicatesForSales(ORG, [
      sale({ key: 'nueva', linkingNumber: A }), // venta externa aún sin guardar
      sale({ key: 'b1', verificationId: 'b1', linkingNumber: B }),
      sale({ key: 'b2', verificationId: 'b2', linkingNumber: B }),
    ])

    expect(out.get('nueva')?.linking?.total).toBe(2001)
    expect(out.get('nueva')?.linking?.matches).toHaveLength(3)
    expect(out.get('b1')?.linking).toEqual({ total: 1, matches: [expect.objectContaining({ verificationId: 'b2' })] })
    expect(out.get('b2')?.linking).toEqual({ total: 1, matches: [expect.objectContaining({ verificationId: 'b1' })] })
    // Una sola consulta para toda la página (sin N+1), con el total por número y su propio tope por número.
    expect(queryRaw).toHaveBeenCalledTimes(1)
    expect(valuesOf()).toContainEqual([A, B])
    const sql = sqlOf()
    expect(sql).toMatch(/count\(\*\) OVER \(PARTITION BY n\)/)
    expect(sql).toMatch(/row_number\(\) OVER \(PARTITION BY n ORDER BY d DESC NULLS LAST, k DESC\)/)
  })

  it('un histórico sin fecha nunca tapa a una venta fechada', async () => {
    // Lo que Postgres devuelve con NULLS LAST: la venta primero y luego los históricos sin fecha.
    queryRaw.mockResolvedValue([saleRow(N, 's1', 6), ...['H1', 'H2', 'H3', 'H4'].map(i => histRow(N, i, 6))])

    const out = await findDuplicatesForSales(ORG, [sale({ key: 'nueva', linkingNumber: N })])

    expect(out.get('nueva')?.linking?.total).toBe(6)
    expect(out.get('nueva')?.linking?.matches[0]).toMatchObject({ kind: 'SALE', verificationId: 's1' })
    expect(sqlOf()).toContain('DESC NULLS LAST')
  })

  it('filtra por organización y nunca trae más de 5 filas por número', async () => {
    queryRaw.mockResolvedValue([])

    await findDuplicatesForSales(ORG, [sale({ key: 'x', verificationId: 'x', iccid: 'I1', linkingNumber: N, portedNumber: '5599999999' })])

    const sql = sqlOf()
    expect(sql).toContain('v."organizationId" = ?')
    expect(sql).toContain('h."organizationId" = ?')
    expect(valuesOf().filter(v => v === ORG)).toHaveLength(3) // vinculación, portado e histórico
    expect(sql).toMatch(/WHERE rn <= 5\b/)
    expect(histFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG }) }))
  })

  it('sin números no consulta la base', async () => {
    const out = await findDuplicatesForSales(ORG, [sale({ key: 'x', verificationId: 'x' })])

    expect(out.get('x')).toEqual({})
    expect(queryRaw).not.toHaveBeenCalled()
    expect(histFindMany).not.toHaveBeenCalled()
  })
})

describe('isNumberDuplicate', () => {
  it('no se marca a sí misma y sí marca a otra venta', async () => {
    queryRaw.mockResolvedValue([saleRow(N, 'x', 1)])
    await expect(isNumberDuplicate(ORG, N, { verificationId: 'x' })).resolves.toBe(false)

    queryRaw.mockResolvedValue([saleRow(N, 'x', 2), saleRow(N, 'y', 2)])
    await expect(isNumberDuplicate(ORG, N, { verificationId: 'x' })).resolves.toBe(true)
  })

  it('un número nuevo (aún no guardado en ella) que ya tiene muchas ventas sale repetido', async () => {
    queryRaw.mockResolvedValue([1, 2, 3, 4, 5].map(i => saleRow(N, `o${i}`, 6)))
    await expect(isNumberDuplicate(ORG, N, { verificationId: 'x', iccid: 'I1' })).resolves.toBe(true)
  })

  it('el histórico de su mismo ICCID no la marca', async () => {
    queryRaw.mockResolvedValue([histRow(N, 'I1', 1)])
    histFindMany.mockResolvedValue([{ iccid: 'I1', number: N }])
    await expect(isNumberDuplicate(ORG, N, { iccid: 'I1' })).resolves.toBe(false)
  })
})

describe('findVerificationIdsWithNumberAlert', () => {
  const range = { from: new Date('2026-10-01T06:00:00Z'), to: new Date('2026-11-01T05:59:59.999Z') }

  it('una sola consulta acotada a la organización y al rango, con las fechas en UTC', async () => {
    queryRaw.mockResolvedValue([{ id: 'a' }, { id: 'b' }])

    await expect(findVerificationIdsWithNumberAlert(ORG, 'any', range)).resolves.toEqual(['a', 'b'])

    expect(queryRaw).toHaveBeenCalledTimes(1)
    const sql = sqlOf()
    expect(sql).toContain('v."organizationId" = ?')
    expect(sql).toContain('h."organizationId" = ?')
    expect(sql).toMatch(/paid_at >= \(\? AT TIME ZONE 'UTC'\)/)
    expect(sql).toMatch(/paid_at <= \(\? AT TIME ZONE 'UTC'\)/)
    expect(sql).toMatch(/LIMIT \?\s*$/)
    expect(valuesOf()).toEqual(expect.arrayContaining([ORG, range.from, range.to, 20001])) // ALERT_IDS_CAP + 1
  })

  it('repetido = otra llave con el mismo número; el histórico de la propia venta no cuenta', async () => {
    queryRaw.mockResolvedValue([])
    await findVerificationIdsWithNumberAlert(ORG, 'duplicate', range)
    const sql = sqlOf()
    expect(sql).toMatch(/HAVING count\(DISTINCT k\) > 1/)
    expect(sql).toContain('NOT EXISTS')
    expect(sql).toContain('IN (SELECT n FROM dup)')
    expect(sql).not.toContain('MANUAL_ENTRY')
  })

  it('compara el ICCID de la venta normalizado como el del histórico (trim + mayúsculas)', async () => {
    queryRaw.mockResolvedValue([])
    await findVerificationIdsWithNumberAlert(ORG, 'duplicate', range)
    expect(sqlOf()).toContain('upper(btrim(sv."serialNumbers"[1])) AS iccid')
  })

  it('cada filtro arma su propio predicado', async () => {
    queryRaw.mockResolvedValue([])
    await findVerificationIdsWithNumberAlert(ORG, 'not10', range)
    expect(sqlOf(0)).toContain('length("linkingNumber") = 9')
    expect(sqlOf(0)).toContain("'BACKOFFICE'")
    expect(sqlOf(0)).not.toContain('IN (SELECT n FROM dup)')

    await findVerificationIdsWithNumberAlert(ORG, 'missing', range)
    expect(sqlOf(1)).toContain('"linkingNumber" IS NULL')
    expect(sqlOf(1)).toContain("coalesce(photos[1], '') <> ''")
    expect(sqlOf(1)).toContain("coalesce(photos[2], '') <> ''")
    expect(sqlOf(1)).toContain("order_type = 'MANUAL_ENTRY'")

    await findVerificationIdsWithNumberAlert(ORG, 'any', range)
    expect(sqlOf(2)).toContain('IN (SELECT n FROM dup)')
    expect(sqlOf(2)).toContain('length("linkingNumber") = 9')
    expect(sqlOf(2)).toContain('"linkingNumber" IS NULL')
  })

  it('con más de 20,000 ventas con alerta pide acotar el rango', async () => {
    queryRaw.mockResolvedValue(Array.from({ length: 20001 }, (_, i) => ({ id: `v${i}` })))

    await expect(findVerificationIdsWithNumberAlert(ORG, 'any', range)).rejects.toMatchObject({
      statusCode: 400,
      code: 'NUMBER_ALERT_RANGE_TOO_WIDE',
      message: 'Hay demasiadas ventas con alerta en el rango; acota las fechas',
    })
  })
})
