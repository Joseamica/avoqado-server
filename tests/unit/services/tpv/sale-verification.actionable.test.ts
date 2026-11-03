/**
 * Lecturas de la TPV (spec §5.3.1 y §5.3.3, plan A6): repetido (`number-check`), «Pendientes» con página y cursor, el
 * detalle, la lista para trabajar sin señal (`actionable`) y el estado por pago (`status`).
 *
 * Aquí va la lógica del servicio con la base simulada: forma de cada respuesta, tope de 200, cursor, 403 por módulo e
 * interruptor, candados y repetidos. El ORDEN real del SQL (foto faltante primero, de la más vieja a la más nueva, luego
 * id) lo prueba contra Postgres `tests/integration/playtelecom/terminalVerificationPages.integration.test.ts`.
 */

import {
  checkTerminalNumber,
  getActionableVerifications,
  getPendingVerifications,
  getVerificationForCorrection,
  getVerificationStatuses,
  setNumberFromTerminal,
} from '@/services/tpv/sale-verification.service'
import prisma from '@/utils/prismaClient'
import { moduleService } from '@/services/modules/module.service'
import { isLinkingNumberEnabledForOrg } from '@/services/playtelecom/linkingNumber.flag'
import { findDuplicatesForSales, isNumberDuplicate } from '@/services/playtelecom/linkingNumber.duplicates'
import { terminalVerificationPageSchema, checkLinkingNumberSchema, verificationStatusesSchema } from '@/schemas/tpv.schema'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    saleVerification: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}))

jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { isModuleEnabled: jest.fn() },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

jest.mock('@/services/playtelecom/linkingNumber.flag', () => ({ __esModule: true, isLinkingNumberEnabledForOrg: jest.fn() }))
jest.mock('@/services/playtelecom/linkingNumber.duplicates', () => ({
  __esModule: true,
  isNumberDuplicate: jest.fn(),
  findDuplicatesForSales: jest.fn(),
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

const ORG = 'org-1'
const VENUE = 'venue-token'
const PROMOTER = 'staff-promoter'
const T0 = Date.parse('2026-10-01T15:00:00.000Z')

type Row = Record<string, any>
type Key = { id: string; createdAt: Date; complete: number }

/** Una verificación como la devuelve `findMany` con el `include` del pago. */
const row = (id: string, over: Row = {}): Row => ({
  id,
  venueId: 'venue-moved',
  paymentId: `pay-${id}`,
  staffId: PROMOTER,
  photos: ['https://x/v.jpg'],
  status: 'PENDING',
  isPortabilidad: false,
  serialNumbers: [`ICC-${id}`],
  rejectionReasons: [],
  reviewNotes: null,
  linkingNumber: null,
  linkingNumberSource: null,
  portedNumber: null,
  portedNumberSource: null,
  createdAt: new Date(T0),
  payment: { amount: { toNumber: () => 150 }, order: { orderNumber: `ORD-${id}` } },
  ...over,
})

const key = (i: number, complete = 1): Key => ({ id: `sv-${String(i).padStart(3, '0')}`, createdAt: new Date(T0 + i * 60_000), complete })

let db: { keys: Key[]; total: number; rows: Map<string, Row> }

function sqlText(query: any): string {
  return Array.isArray(query?.strings) ? query.strings.join('?') : String(query?.sql ?? query)
}
const queryValues = (query: any): unknown[] => (Array.isArray(query?.values) ? query.values : [])
const pageCalls = () => (prisma.$queryRaw as jest.Mock).mock.calls.map(c => c[0]).filter(q => !sqlText(q).includes('count(*)'))

beforeEach(() => {
  jest.resetAllMocks()
  db = { keys: [], total: 0, rows: new Map() }
  ;(moduleService.isModuleEnabled as jest.Mock).mockResolvedValue(true)
  ;(isLinkingNumberEnabledForOrg as jest.Mock).mockResolvedValue(true)
  ;(isNumberDuplicate as jest.Mock).mockResolvedValue(false)
  ;(findDuplicatesForSales as jest.Mock).mockImplementation(async (_org: string, sales: Array<{ key: string }>) => {
    return new Map(sales.map(s => [s.key, {}]))
  })
  // El SQL de la página devuelve las llaves que le tocan (el orden real se prueba contra Postgres); el conteo, el total.
  ;(prisma.$queryRaw as jest.Mock).mockImplementation(async (query: any) => {
    if (sqlText(query).includes('count(*)')) return [{ total: db.total }]
    const values = queryValues(query)
    const afterId = values.find(v => typeof v === 'string' && db.keys.some(k => k.id === v))
    const from = afterId ? db.keys.findIndex(k => k.id === afterId) + 1 : 0
    const limit = values.find(v => typeof v === 'number' && v > 1) as number
    return db.keys.slice(from, from + limit)
  })
  // Hidrata en otro orden a propósito: el servicio debe respetar el de la página.
  ;(prisma.saleVerification.findMany as jest.Mock).mockImplementation(async ({ where }: any) =>
    (where?.id?.in ?? [])
      .map((id: string) => db.rows.get(id) ?? row(id))
      .filter((r: Row) => !where.status?.in || where.status.in.includes(r.status))
      .reverse(),
  )
})

describe('GET tpv/verification/pending', () => {
  it('conserva los campos de hoy y agrega números, candados, alertas, total y nextCursor', async () => {
    db.keys = [key(1)]
    db.total = 1
    db.rows.set('sv-001', row('sv-001', { linkingNumber: '5512345678', linkingNumberSource: 'TPV' }))

    const page = await getPendingVerifications(ORG, PROMOTER)

    expect(page).toEqual({
      data: [
        {
          id: 'sv-001',
          paymentId: 'pay-sv-001',
          amount: 150,
          orderNumber: 'ORD-sv-001',
          date: new Date(T0).toISOString(),
          serialNumbers: ['ICC-sv-001'],
          isPortabilidad: false,
          photos: ['https://x/v.jpg'],
          requiredPhotos: 1,
          linkingNumber: '5512345678',
          portedNumber: null,
          linkingNumberLocked: false,
          portedNumberLocked: false,
          alerts: [],
        },
      ],
      total: 1,
      nextCursor: null,
    })
  })

  it('busca por la organización del token y el promotor (la venta movida por el job sigue saliendo), sólo PENDING', async () => {
    db.keys = [key(1)]
    db.total = 1

    await getPendingVerifications(ORG, PROMOTER)

    const [page] = pageCalls()
    expect(sqlText(page)).toContain('"organizationId"')
    expect(queryValues(page)).toEqual(expect.arrayContaining([ORG, PROMOTER, ['PENDING']]))
    expect(prisma.saleVerification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['sv-001'] }, staffId: PROMOTER, status: { in: ['PENDING'] }, venue: { organizationId: ORG } },
        take: 1,
      }),
    )
  })

  it('ordena foto faltante primero, luego de la más vieja a la más nueva y luego id, ANTES del límite', async () => {
    db.keys = [key(1)]
    db.total = 1

    await getPendingVerifications(ORG, PROMOTER)

    const text = sqlText(pageCalls()[0])
    expect(text).toMatch(/array_remove\(coalesce\(sv\.photos/)
    expect(text).toMatch(/ORDER BY complete, created_at, id\s+LIMIT/)
  })

  it('el estado se compara contra el enum, no contra su texto: la página y el conteo pueden usar el índice de status', async () => {
    db.keys = [key(1)]
    db.total = 1

    await getPendingVerifications(ORG, PROMOTER)

    const texts = (prisma.$queryRaw as jest.Mock).mock.calls.map(c => sqlText(c[0]))
    expect(texts).toHaveLength(2)
    for (const text of texts) {
      expect(text).toContain('sv.status = ANY(?::"SaleVerificationStatus"[])')
      expect(text).not.toContain('status::text')
    }
  })

  it('con 205 pendientes devuelve 200, total 205 y un nextCursor que trae las 5 que faltan', async () => {
    db.keys = Array.from({ length: 205 }, (_, i) => key(i + 1))
    db.total = 205

    const first = await getPendingVerifications(ORG, PROMOTER)

    expect(first.data).toHaveLength(200)
    expect(first.total).toBe(205)
    expect(first.data.map(d => d.id)).toEqual(db.keys.slice(0, 200).map(k => k.id)) // el orden de la página, no el de la hidratación
    expect(queryValues(pageCalls()[0])).toContain(201) // tope de servidor: 200 + 1 para saber si hay más
    expect(first.nextCursor).toEqual(expect.any(String))

    const second = await getPendingVerifications(ORG, PROMOTER, first.nextCursor!)

    expect(second.data.map(d => d.id)).toEqual(db.keys.slice(200).map(k => k.id))
    expect(second.total).toBe(205)
    expect(second.nextCursor).toBeNull()
    // El cursor lleva las tres llaves de la última de la primera página.
    const after = queryValues(pageCalls()[1])
    expect(after).toEqual(expect.arrayContaining([1, 'sv-200', db.keys[199].createdAt]))
  })

  it('un cursor que no es nuestro responde 400 INVALID_CURSOR', async () => {
    const bad = [
      'basura',
      Buffer.from('{"a":1}').toString('base64url'),
      Buffer.from(JSON.stringify([2, new Date(T0).toISOString(), 'sv-1'])).toString('base64url'),
      Buffer.from(JSON.stringify([0, '2026-10-01', 'sv-1'])).toString('base64url'),
      Buffer.from(JSON.stringify([0, new Date(T0).toISOString(), ''])).toString('base64url'),
    ]
    for (const cursor of bad) {
      await expect(getPendingVerifications(ORG, PROMOTER, cursor)).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_CURSOR' })
    }
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
  })

  it('candado: con fuente BACKOFFICE (o importación, venta externa) el número está bloqueado; con TPV o vacío, no', async () => {
    db.keys = [key(1), key(2), key(3)]
    db.total = 3
    db.rows.set('sv-001', row('sv-001', { linkingNumber: '5512345678', linkingNumberSource: 'BACKOFFICE' }))
    db.rows.set(
      'sv-002',
      row('sv-002', {
        isPortabilidad: true,
        linkingNumber: '5511111111',
        linkingNumberSource: 'TPV',
        portedNumber: '5522222222',
        portedNumberSource: 'IMPORT',
      }),
    )
    db.rows.set('sv-003', row('sv-003', { linkingNumberSource: 'BACKOFFICE' })) // fuente sin número: nada que bloquear

    const { data } = await getPendingVerifications(ORG, PROMOTER)

    expect(data.map(d => [d.linkingNumberLocked, d.portedNumberLocked])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ])
  })

  it('las alertas de repetido salen de UNA llamada a findDuplicatesForSales con los números guardados de la página', async () => {
    db.keys = [key(1), key(2)]
    db.total = 2
    db.rows.set('sv-001', row('sv-001', { linkingNumber: '5512345678', serialNumbers: ['ICC-A', 'ICC-B'] }))
    db.rows.set('sv-002', row('sv-002', { isPortabilidad: true, linkingNumber: '5533333333', portedNumber: '5544444444' }))
    ;(findDuplicatesForSales as jest.Mock).mockResolvedValue(
      new Map([
        ['sv-001', { linking: { total: 1, matches: [] } }],
        ['sv-002', { ported: { total: 2, matches: [] } }],
      ]),
    )

    const { data } = await getPendingVerifications(ORG, PROMOTER)

    expect(findDuplicatesForSales).toHaveBeenCalledTimes(1)
    expect(findDuplicatesForSales).toHaveBeenCalledWith(ORG, [
      { key: 'sv-001', verificationId: 'sv-001', iccid: 'ICC-A', linkingNumber: '5512345678', portedNumber: null },
      { key: 'sv-002', verificationId: 'sv-002', iccid: 'ICC-sv-002', linkingNumber: '5533333333', portedNumber: '5544444444' },
    ])
    expect(data.map(d => d.alerts)).toEqual([['LINKING_DUPLICATE'], ['PORTED_DUPLICATE']])
    // Al promotor no se le dice con qué venta choca.
    expect(JSON.stringify(data)).not.toContain('matches')
  })

  // Codex r1 C3: un negocio con el interruptor apagado no recibe alertas ni se le buscan repetidos (pendientes y detalle).
  it('con el interruptor apagado: alertas vacías y sin buscar repetidos', async () => {
    ;(isLinkingNumberEnabledForOrg as jest.Mock).mockResolvedValue(false)
    db.keys = [key(1)]
    db.total = 1
    db.rows.set('sv-001', row('sv-001', { linkingNumber: '5512345678', linkingNumberSource: 'TPV' }))
    ;(prisma.saleVerification.findFirst as jest.Mock).mockResolvedValue(row('sv-001', { linkingNumber: '5512345678' }))
    ;(findDuplicatesForSales as jest.Mock).mockResolvedValue(new Map([['sv-001', { linking: { total: 1, matches: [] } }]]))

    const { data } = await getPendingVerifications(ORG, PROMOTER)
    const detail = await getVerificationForCorrection(ORG, PROMOTER, 'sv-001')

    expect(data[0].alerts).toEqual([])
    expect(detail.alerts).toEqual([])
    expect(findDuplicatesForSales).not.toHaveBeenCalled()
    expect(isLinkingNumberEnabledForOrg).toHaveBeenCalledWith(ORG)
  })

  it('sin pendientes: lista vacía, total 0, sin cursor y sin hidratar', async () => {
    const page = await getPendingVerifications(ORG, PROMOTER)
    expect(page).toEqual({ data: [], total: 0, nextCursor: null })
    expect(prisma.saleVerification.findMany).not.toHaveBeenCalled()
  })

  it('el schema acepta la terminal vieja (sin query) y un cursor; rechaza uno enorme', () => {
    expect(terminalVerificationPageSchema.safeParse({ query: {} }).success).toBe(true)
    expect(terminalVerificationPageSchema.safeParse({ query: { cursor: 'abc' } }).success).toBe(true)
    expect(terminalVerificationPageSchema.safeParse({ query: { cursor: 'x'.repeat(600) } }).success).toBe(false)
  })
})

describe('GET tpv/verification/actionable', () => {
  it('trae PENDING y FAILED del promotor en la organización, con motivos, notas y el formato del detalle', async () => {
    db.keys = [key(1, 0), key(2)]
    db.total = 2
    db.rows.set('sv-001', row('sv-001', { status: 'FAILED', rejectionReasons: ['REVIEW_ILLEGIBLE_IMAGES'], reviewNotes: 'Foto borrosa' }))

    const page = await getActionableVerifications(VENUE, ORG, PROMOTER)

    expect(queryValues(pageCalls()[0])).toEqual(expect.arrayContaining([ORG, PROMOTER, ['PENDING', 'FAILED']]))
    expect(page.total).toBe(2)
    expect(page.nextCursor).toBeNull()
    expect(page.data[0]).toMatchObject({
      id: 'sv-001',
      status: 'FAILED',
      rejectionReasons: ['REVIEW_ILLEGIBLE_IMAGES'],
      reviewNotes: 'Foto borrosa',
      linkingNumber: null,
      linkingNumberLocked: false,
      alerts: [],
    })
    expect(page.data[1]).toMatchObject({ id: 'sv-002', status: 'PENDING', requiredPhotos: 1 })
  })

  it('403 MODULE_DISABLED si la tienda del token no tiene SERIALIZED_INVENTORY', async () => {
    ;(moduleService.isModuleEnabled as jest.Mock).mockResolvedValue(false)
    await expect(getActionableVerifications(VENUE, ORG, PROMOTER)).rejects.toMatchObject({ statusCode: 403, code: 'MODULE_DISABLED' })
    expect(moduleService.isModuleEnabled).toHaveBeenCalledWith(VENUE, 'SERIALIZED_INVENTORY')
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
  })
})

describe('GET tpv/verification/:id', () => {
  it('busca en la organización del token y agrega números, candados y alertas', async () => {
    ;(prisma.saleVerification.findFirst as jest.Mock).mockResolvedValue(
      row('sv-001', { status: 'FAILED', reviewNotes: 'Revisa', portedNumber: '5598765432', portedNumberSource: 'BACKOFFICE' }),
    )
    ;(findDuplicatesForSales as jest.Mock).mockResolvedValue(new Map([['sv-001', { ported: { total: 1, matches: [] } }]]))

    const detail = await getVerificationForCorrection(ORG, PROMOTER, 'sv-001')

    expect(prisma.saleVerification.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sv-001', staffId: PROMOTER, venue: { organizationId: ORG } } }),
    )
    expect(detail).toMatchObject({
      id: 'sv-001',
      status: 'FAILED',
      rejectionReasons: [],
      reviewNotes: 'Revisa',
      portedNumber: '5598765432',
      portedNumberLocked: true,
      alerts: ['PORTED_DUPLICATE'],
    })
  })

  it('de otro promotor u otra organización ⇒ 404', async () => {
    ;(prisma.saleVerification.findFirst as jest.Mock).mockResolvedValue(null)
    await expect(getVerificationForCorrection(ORG, PROMOTER, 'sv-x')).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('GET tpv/verification/status', () => {
  it('devuelve el estado de cada pago pedido, en su orden; NONE sin verificación o de otra organización', async () => {
    ;(prisma.saleVerification.findMany as jest.Mock).mockResolvedValue([
      { paymentId: 'pay-done', status: 'COMPLETED' },
      { paymentId: 'pay-back', status: 'FAILED' },
    ])

    const data = await getVerificationStatuses(VENUE, ORG, ['pay-back', 'pay-none', 'pay-done', 'pay-other-org'])

    expect(prisma.saleVerification.findMany).toHaveBeenCalledWith({
      where: { paymentId: { in: ['pay-back', 'pay-none', 'pay-done', 'pay-other-org'] }, venue: { organizationId: ORG } },
      select: { paymentId: true, status: true },
      take: 4,
    })
    expect(data).toEqual([
      { paymentId: 'pay-back', status: 'FAILED' },
      { paymentId: 'pay-none', status: 'NONE' },
      { paymentId: 'pay-done', status: 'COMPLETED' },
      { paymentId: 'pay-other-org', status: 'NONE' },
    ])
  })

  it('403 MODULE_DISABLED sin SERIALIZED_INVENTORY en la tienda del token', async () => {
    ;(moduleService.isModuleEnabled as jest.Mock).mockResolvedValue(false)
    await expect(getVerificationStatuses(VENUE, ORG, ['pay-1'])).rejects.toMatchObject({ statusCode: 403, code: 'MODULE_DISABLED' })
    expect(prisma.saleVerification.findMany).not.toHaveBeenCalled()
  })

  it('el schema separa por comas, quita vacíos y repetidos, y rechaza más de 100 o ninguno', () => {
    const ok = verificationStatusesSchema.safeParse({ query: { paymentIds: 'a, b,,a,c' } })
    expect(ok.success && ok.data.query.paymentIds).toEqual(['a', 'b', 'c'])

    const ids = (n: number) => Array.from({ length: n }, (_, i) => `pay-${i}`).join(',')
    expect(verificationStatusesSchema.safeParse({ query: { paymentIds: ids(100) } }).success).toBe(true)
    expect(verificationStatusesSchema.safeParse({ query: { paymentIds: ids(101) } }).success).toBe(false)
    expect(verificationStatusesSchema.safeParse({ query: { paymentIds: ' , ' } }).success).toBe(false)
    expect(verificationStatusesSchema.safeParse({ query: {} }).success).toBe(false)
  })
})

describe('GET tpv/verification/number-check', () => {
  const check = (over: Partial<Parameters<typeof checkTerminalNumber>[0]> = {}) =>
    checkTerminalNumber({ venueId: VENUE, orgId: ORG, staffId: PROMOTER, number: '55 1234-5678', kind: 'linking', ...over })

  it('con su propio verificationId no se marca a sí misma: lo descuenta con su ICCID', async () => {
    ;(prisma.saleVerification.findFirst as jest.Mock).mockResolvedValue({ serialNumbers: ['ICC-OWN', 'ICC-2'] })

    await expect(check({ verificationId: 'sv-own' })).resolves.toEqual({ duplicate: false })

    expect(prisma.saleVerification.findFirst).toHaveBeenCalledWith({
      where: { id: 'sv-own', staffId: PROMOTER, venue: { organizationId: ORG } },
      select: { serialNumbers: true },
    })
    expect(isNumberDuplicate).toHaveBeenCalledWith(ORG, '5512345678', { verificationId: 'sv-own', iccid: 'ICC-OWN' })
  })

  it('repetido en la organización ⇒ duplicate true, sin decir con qué venta', async () => {
    ;(isNumberDuplicate as jest.Mock).mockResolvedValue(true)
    await expect(check({ kind: 'ported', number: '551234567' })).resolves.toEqual({ duplicate: true })
    expect(isNumberDuplicate).toHaveBeenCalledWith(ORG, '551234567', { verificationId: undefined, iccid: undefined })
  })

  it('número inválido ⇒ 400 INVALID_LINKING_NUMBER', async () => {
    for (const number of ['+52 55 1234 5678', '551234567890', '55123456', '334651O556']) {
      await expect(check({ number })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_LINKING_NUMBER' })
    }
    expect(isNumberDuplicate).not.toHaveBeenCalled()
  })

  it('verificationId de otro promotor u otra organización ⇒ 404', async () => {
    ;(prisma.saleVerification.findFirst as jest.Mock).mockResolvedValue(null)
    await expect(check({ verificationId: 'sv-ajena' })).rejects.toMatchObject({ statusCode: 404 })
    expect(isNumberDuplicate).not.toHaveBeenCalled()
  })

  it('403 MODULE_DISABLED sin el módulo y 403 LINKING_NUMBER_DISABLED con el interruptor apagado', async () => {
    ;(moduleService.isModuleEnabled as jest.Mock).mockResolvedValueOnce(false)
    await expect(check()).rejects.toMatchObject({ statusCode: 403, code: 'MODULE_DISABLED' })
    ;(isLinkingNumberEnabledForOrg as jest.Mock).mockResolvedValue(false)
    await expect(check()).rejects.toMatchObject({ statusCode: 403, code: 'LINKING_NUMBER_DISABLED' })
    expect(isLinkingNumberEnabledForOrg).toHaveBeenCalledWith(ORG)
    expect(isNumberDuplicate).not.toHaveBeenCalled()
  })

  it('el schema pide número y kind, y verificationId cuid opcional', () => {
    const ok = { number: '5512345678', kind: 'linking' }
    expect(checkLinkingNumberSchema.safeParse({ query: ok }).success).toBe(true)
    expect(checkLinkingNumberSchema.safeParse({ query: { ...ok, verificationId: 'cmgxk2l3e0001qz8h5y6t7r8s' } }).success).toBe(true)
    expect(checkLinkingNumberSchema.safeParse({ query: { ...ok, kind: 'otro' } }).success).toBe(false)
    expect(checkLinkingNumberSchema.safeParse({ query: { kind: 'linking' } }).success).toBe(false)
    expect(checkLinkingNumberSchema.safeParse({ query: { ...ok, verificationId: 'no-es-cuid' } }).success).toBe(false)
  })
})

describe('POST tpv/verification/:id/number', () => {
  it('403 MODULE_DISABLED si la tienda del token no tiene SERIALIZED_INVENTORY, antes de leer la venta', async () => {
    ;(moduleService.isModuleEnabled as jest.Mock).mockResolvedValue(false)

    await expect(
      setNumberFromTerminal({
        venueId: VENUE,
        orgId: ORG,
        staffId: PROMOTER,
        verificationId: 'sv-001',
        slot: 'VINCULACION',
        number: '5512345678',
        capture: { seq: 1, deviceId: 'd-1', idempotencyKey: 'k-1', capturedAt: new Date(T0) },
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'MODULE_DISABLED' })
    expect(moduleService.isModuleEnabled).toHaveBeenCalledWith(VENUE, 'SERIALIZED_INVENTORY')
    expect(prisma.saleVerification.findFirst).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})
