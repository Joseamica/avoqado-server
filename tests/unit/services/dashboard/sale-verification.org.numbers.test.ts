/**
 * Número de vinculación (plan A7): Ventas de la organización.
 *
 * - Cada fila trae los dos números, de dónde vinieron, si es venta externa y sus alertas (con los choques).
 * - Filtro `numberAlert=any|duplicate|missing|not10`, con rango obligatorio; búsqueda por número exacto.
 * - `PATCH …/:id/numbers`: el back-office corrige (10 dígitos, o 9 confirmado), con bitácora en la misma transacción.
 * - Con el interruptor de la organización apagado, nada cambia para nadie: sin alertas, sin filtro, sin corrección.
 */
import type { Request, Response } from 'express'
import prisma from '@/utils/prismaClient'
import { isLinkingNumberEnabledForOrg } from '@/services/playtelecom/linkingNumber.flag'
import { findDuplicatesForSales, findVerificationIdsWithNumberAlert } from '@/services/playtelecom/linkingNumber.duplicates'
import { listOrgSaleVerifications, setOrgSaleVerificationNumbers } from '@/services/dashboard/sale-verification.org.dashboard.service'
import * as ctrl from '@/controllers/dashboard/sale-verification.org.dashboard.controller'
import orgSalesRouter from '@/routes/dashboard/saleVerification.org.dashboard.routes'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn(), count: jest.fn() },
    terminal: { findMany: jest.fn() },
    saleVerification: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/playtelecom/linkingNumber.flag', () => ({ isLinkingNumberEnabledForOrg: jest.fn() }))
jest.mock('@/services/playtelecom/linkingNumber.duplicates', () => ({
  findDuplicatesForSales: jest.fn(),
  findVerificationIdsWithNumberAlert: jest.fn(),
}))
// El router se importa para leer su permiso por ruta; los candados de sesión no son lo que se prueba aquí.
jest.mock('@/middlewares/authenticateToken.middleware', () => ({ authenticateTokenMiddleware: (_q: any, _s: any, n: any) => n() }))
jest.mock('@/routes/dashboard/organizationDashboard.routes', () => ({ checkOrgAccess: (_q: any, _s: any, n: any) => n() }))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (permission: string) => Object.assign((_q: any, _s: any, n: any) => n(), { permission }),
}))

const mockPrisma = prisma as unknown as {
  payment: { findMany: jest.Mock; count: jest.Mock }
  terminal: { findMany: jest.Mock }
  saleVerification: { findUnique: jest.Mock }
  $transaction: jest.Mock
}
const enabled = isLinkingNumberEnabledForOrg as jest.Mock
const dups = findDuplicatesForSales as jest.Mock
const alertIds = findVerificationIdsWithNumberAlert as jest.Mock

const ORG = 'cc5sr8sl15j5x87ksbw8exajp'
const OTHER_ORG = 'cc0p2tnj3b33vb6r6i3avhzif'
const VENUE = { id: 'cstmz6apz6xioaj0wlctb62xz', name: 'BAE MEZQUITAL', city: 'San Luis Potosí', slug: 'bae-mezquital' }
const SV = 'cazflog9mcvy3yie1a1jz536f'
const PAY = 'cst2jaw2h384v01awd8o40l1q'
const ORPHAN_PAY = 'c3jzeq557n2qb8791wuuaqcp3'
const EDITOR = 'cb2pb37zsmp2fudatgvmwh4os'
const ICCID = '8952140064247085252F'
const T = new Date(Date.UTC(2026, 10, 1, 18, 0, 0))

type Sv = Record<string, unknown>

function verificacion(over: Sv = {}): Sv {
  return {
    id: SV,
    venueId: VENUE.id,
    paymentId: PAY,
    staffId: 'c8a22p27yokd6jhazwh6j8e7r',
    status: 'PENDING',
    isPortabilidad: true,
    photos: ['https://example.test/vinculacion.jpg', 'https://example.test/portado.jpg'],
    serialNumbers: [ICCID],
    reviewedById: null,
    reviewedAt: null,
    reviewNotes: null,
    rejectionReasons: [],
    deviceId: null,
    linkingNumber: '551234567',
    linkingNumberSource: 'TPV',
    linkingNumberSetAt: T,
    portedNumber: null,
    portedNumberSource: null,
    portedNumberSetAt: null,
    createdAt: T,
    updatedAt: T,
    staff: { id: 'c8a22p27yokd6jhazwh6j8e7r', firstName: 'Josefina', lastName: 'Alvarado', email: null, photoUrl: null },
    reviewedBy: null,
    ...over,
  }
}

function pago(sv: Sv | null, orderType = 'DINE_IN', id = PAY) {
  return {
    id,
    amount: 100,
    method: 'CASH',
    status: 'COMPLETED',
    createdAt: T,
    order: {
      id: `ord_${id}`,
      type: orderType,
      venue: VENUE,
      items: sv
        ? [{ serializedItem: { id: 'si', serialNumber: ICCID, category: { id: 'cat', name: 'SIM de Evento' }, registeredFromVenue: null } }]
        : [],
    },
    saleVerification: sv,
  }
}

function montarLista(pagos: unknown[]) {
  mockPrisma.payment.findMany.mockResolvedValue(pagos)
  mockPrisma.payment.count.mockResolvedValue(pagos.length)
  mockPrisma.terminal.findMany.mockResolvedValue([])
}

const whereDeLaLista = () => mockPrisma.payment.findMany.mock.calls[0][0].where

const CHOQUE = {
  total: 2,
  matches: [
    { kind: 'SALE', verificationId: 'cc0p2tnj3b33vb6r6i3avhzif', status: 'COMPLETED', date: T, staffName: 'Ana', venueName: 'BAE' },
  ],
}

beforeEach(() => {
  jest.clearAllMocks()
  enabled.mockResolvedValue(true)
  dups.mockImplementation(async (_org: string, sales: Array<{ key: string }>) => new Map(sales.map(s => [s.key, {}])))
  alertIds.mockResolvedValue([])
})

describe('listOrgSaleVerifications — números y alertas en cada fila', () => {
  it('la fila trae los números, su origen, si es venta externa y sus alertas con los choques', async () => {
    montarLista([pago(verificacion(), 'MANUAL_ENTRY')])
    dups.mockResolvedValue(new Map([[SV, { linking: CHOQUE }]]))

    const { data } = await listOrgSaleVerifications(ORG, { pageNumber: 1, pageSize: 20 })

    expect(data[0]).toMatchObject({
      linkingNumber: '551234567',
      portedNumber: null,
      linkingNumberSource: 'TPV',
      portedNumberSource: null,
      linkingNumberSetAt: T,
      portedNumberSetAt: null,
      isExternalSale: true,
    })
    expect(data[0].numberAlerts).toEqual([
      { code: 'LINKING_DUPLICATE', total: 2, matches: CHOQUE.matches },
      { code: 'NOT_10_DIGITS' },
      { code: 'PORTED_MISSING' },
    ])
  })

  it('una sola llamada a findDuplicatesForSales por página, con los números guardados de cada verificación', async () => {
    const otra = verificacion({
      id: 'c8a22p27yokd6jhazwh6j8e7r',
      serialNumbers: [],
      linkingNumber: '5512345678',
      portedNumber: '5598765432',
    })
    montarLista([pago(verificacion()), pago(otra, 'DINE_IN', 'cb2pb37zsmp2fudatgvmwh4os'), pago(null, 'DINE_IN', ORPHAN_PAY)])

    const { data } = await listOrgSaleVerifications(ORG, { pageNumber: 1, pageSize: 20 })

    expect(dups).toHaveBeenCalledTimes(1)
    expect(dups).toHaveBeenCalledWith(ORG, [
      { key: SV, verificationId: SV, iccid: ICCID, linkingNumber: '551234567', portedNumber: null },
      {
        key: 'c8a22p27yokd6jhazwh6j8e7r',
        verificationId: 'c8a22p27yokd6jhazwh6j8e7r',
        iccid: null,
        linkingNumber: '5512345678',
        portedNumber: '5598765432',
      },
    ])
    // Un cobro sin verificación no tiene números ni alertas: el filtro tampoco lo considera.
    const huerfano = data.find(r => r.paymentId === ORPHAN_PAY)!
    expect(huerfano).toMatchObject({ linkingNumber: null, portedNumber: null, isExternalSale: false, numberAlerts: [] })
  })

  it('una venta con su número de 10 dígitos, sin repetir, no trae alertas', async () => {
    montarLista([pago(verificacion({ isPortabilidad: false, linkingNumber: '5512345678' }))])

    const { data } = await listOrgSaleVerifications(ORG, { pageNumber: 1, pageSize: 20 })

    expect(data[0].numberAlerts).toEqual([])
    expect(data[0].isExternalSale).toBe(false)
  })

  it('con el interruptor apagado: los números siguen en la fila, pero numberAlerts va vacío y no se buscan repetidos', async () => {
    enabled.mockResolvedValue(false)
    montarLista([pago(verificacion(), 'MANUAL_ENTRY')])

    const { data } = await listOrgSaleVerifications(ORG, { pageNumber: 1, pageSize: 20 })

    expect(data[0].linkingNumber).toBe('551234567')
    expect(data[0].numberAlerts).toEqual([])
    expect(dups).not.toHaveBeenCalled()
  })

  // ── REGRESIÓN: lo de antes sigue igual ──
  it('los campos de antes no cambian', async () => {
    montarLista([pago(verificacion())])

    const { data, pagination } = await listOrgSaleVerifications(ORG, { pageNumber: 1, pageSize: 20 })

    expect(data[0]).toMatchObject({ id: SV, paymentId: PAY, hasVerification: true, serialNumbers: [ICCID], saleType: 'PORTABILIDAD' })
    expect(pagination).toEqual({ pageSize: 20, pageNumber: 1, totalCount: 1, totalPages: 1 })
    expect(mockPrisma.payment.findMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
  })
})

describe('listOrgSaleVerifications — filtro numberAlert', () => {
  const from = new Date(Date.UTC(2026, 9, 1, 6, 0, 0))
  const to = new Date(Date.UTC(2026, 10, 2, 5, 59, 59, 999))

  it('arma el `in` con los ids del filtro, junto a los demás filtros de la verificación, y el total usa el mismo where', async () => {
    alertIds.mockResolvedValue([SV])
    montarLista([pago(verificacion())])

    await listOrgSaleVerifications(ORG, {
      pageNumber: 1,
      pageSize: 20,
      numberAlert: 'duplicate',
      status: 'PENDING',
      fromDate: from,
      toDate: to,
    })

    expect(alertIds).toHaveBeenCalledWith(ORG, 'duplicate', { from, to })
    expect(whereDeLaLista().saleVerification).toEqual({ status: 'PENDING', id: { in: [SV] } })
    expect(mockPrisma.payment.count.mock.calls[0][0].where).toEqual(whereDeLaLista())
  })

  it('una venta cobrada exactamente en toDate sale igual con y sin filtro: los dos extremos llegan sin moverse', async () => {
    montarLista([])
    await listOrgSaleVerifications(ORG, { pageNumber: 1, pageSize: 20, fromDate: from, toDate: to })
    const sinFiltro = whereDeLaLista().createdAt

    jest.clearAllMocks()
    enabled.mockResolvedValue(true)
    alertIds.mockResolvedValue([])
    montarLista([])
    await listOrgSaleVerifications(ORG, { pageNumber: 1, pageSize: 20, fromDate: from, toDate: to, numberAlert: 'any' })

    expect(sinFiltro).toEqual({ gte: from, lte: to })
    expect(whereDeLaLista().createdAt).toEqual(sinFiltro)
    expect(alertIds.mock.calls[0][2]).toEqual({ from, to })
  })

  it.each([
    ['sin fechas', {}],
    ['sólo con fromDate', { fromDate: new Date(Date.UTC(2026, 9, 1)) }],
    ['sólo con toDate', { toDate: new Date(Date.UTC(2026, 9, 1)) }],
  ])('%s ⇒ 400 NUMBER_ALERT_NEEDS_RANGE, sin consultar', async (_t, range) => {
    await expect(listOrgSaleVerifications(ORG, { pageNumber: 1, pageSize: 20, numberAlert: 'missing', ...range })).rejects.toMatchObject({
      statusCode: 400,
      code: 'NUMBER_ALERT_NEEDS_RANGE',
    })
    expect(mockPrisma.payment.findMany).not.toHaveBeenCalled()
  })

  it('con el interruptor apagado el filtro se ignora: ni error ni `in`', async () => {
    enabled.mockResolvedValue(false)
    montarLista([])

    await listOrgSaleVerifications(ORG, { pageNumber: 1, pageSize: 20, numberAlert: 'not10' })

    expect(alertIds).not.toHaveBeenCalled()
    expect(whereDeLaLista().saleVerification).toBeUndefined()
  })
})

describe('listOrgSaleVerifications — búsqueda por número', () => {
  const ramasDeNumero = (where: any) =>
    (where.OR ?? []).filter((c: any) => c.saleVerification?.linkingNumber || c.saleVerification?.portedNumber)

  it('`5512345678` también busca el número de vinculación y el portado exactos', async () => {
    montarLista([pago(verificacion({ linkingNumber: '5512345678' }))])

    const { data } = await listOrgSaleVerifications(ORG, { pageNumber: 1, pageSize: 20, search: '5512345678' })

    expect(ramasDeNumero(whereDeLaLista())).toEqual([
      { saleVerification: { linkingNumber: '5512345678' } },
      { saleVerification: { portedNumber: '5512345678' } },
    ])
    expect(data[0].linkingNumber).toBe('5512345678')
  })

  it('un número pegado con espacios y guiones se busca en dígitos; 9 dígitos también', async () => {
    montarLista([])
    await listOrgSaleVerifications(ORG, { pageNumber: 1, pageSize: 20, search: '55 1234-567' })
    expect(ramasDeNumero(whereDeLaLista())).toEqual([
      { saleVerification: { linkingNumber: '551234567' } },
      { saleVerification: { portedNumber: '551234567' } },
    ])
  })

  it.each(['Josefina', '12345678', '89521400642470852', '+525512345678'])('«%s» no busca por número (y lo de antes sigue)', async term => {
    montarLista([])
    await listOrgSaleVerifications(ORG, { pageNumber: 1, pageSize: 20, search: term })
    const where = whereDeLaLista()
    expect(ramasDeNumero(where)).toEqual([])
    expect(where.OR).toHaveLength(3)
  })
})

describe('setOrgSaleVerificationNumbers — corrección del back-office', () => {
  function montarTx(sv: Sv | null, organizationId = ORG) {
    const tx = {
      $queryRaw: jest.fn(async () => (sv ? [sv] : [])),
      venue: { findUnique: jest.fn(async () => ({ organizationId })) },
      saleVerification: { update: jest.fn(async ({ data }: any) => ({ ...sv, ...data })) },
      activityLog: { create: jest.fn() },
    }
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(tx))
    return tx
  }

  it('9 dígitos sin allowNineDigits ⇒ 400 INVALID_LINKING_NUMBER y no escribe', async () => {
    const tx = montarTx(verificacion())
    await expect(
      setOrgSaleVerificationNumbers(ORG, { saleVerificationId: SV, editedById: EDITOR, linkingNumber: '551234567' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_LINKING_NUMBER' })
    expect(tx.saleVerification.update).not.toHaveBeenCalled()
  })

  it.each(['+52 55 1234 5678', '525512345678', '55123456A8', ''])('«%s» ⇒ 400 INVALID_LINKING_NUMBER', async raw => {
    montarTx(verificacion())
    await expect(
      setOrgSaleVerificationNumbers(ORG, { saleVerificationId: SV, editedById: EDITOR, linkingNumber: raw, allowNineDigits: true }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_LINKING_NUMBER' })
  })

  it('9 dígitos con allowNineDigits ⇒ guarda, BACKOFFICE, y NOT_10_DIGITS desaparece de la fila', async () => {
    const tx = montarTx(verificacion({ isPortabilidad: false }))

    await setOrgSaleVerificationNumbers(ORG, {
      saleVerificationId: SV,
      editedById: EDITOR,
      linkingNumber: '551234567',
      allowNineDigits: true,
      reason: 'Confirmado contra la foto',
    })

    const { data } = tx.saleVerification.update.mock.calls[0][0]
    expect(data).toEqual({ linkingNumber: '551234567', linkingNumberSource: 'BACKOFFICE', linkingNumberSetAt: expect.any(Date) })

    // Antes la fila decía NOT_10_DIGITS; con lo que se guardó, ya no.
    montarLista([pago(verificacion({ isPortabilidad: false }))])
    expect((await listOrgSaleVerifications(ORG, { pageNumber: 1, pageSize: 20 })).data[0].numberAlerts).toEqual([{ code: 'NOT_10_DIGITS' }])
    jest.clearAllMocks()
    enabled.mockResolvedValue(true)
    dups.mockImplementation(async (_o: string, sales: Array<{ key: string }>) => new Map(sales.map(s => [s.key, {}])))
    montarLista([pago(verificacion({ isPortabilidad: false, ...data }))])
    expect((await listOrgSaleVerifications(ORG, { pageNumber: 1, pageSize: 20 })).data[0].numberAlerts).toEqual([])
  })

  it('el ActivityLog va dentro del $transaction, con venueId, organizationId y antes/después (mismo número = confirmarlo)', async () => {
    const tx = montarTx(verificacion({ isPortabilidad: false }))

    await setOrgSaleVerificationNumbers(ORG, {
      saleVerificationId: SV,
      editedById: EDITOR,
      linkingNumber: '55-1234-567',
      allowNineDigits: true,
      reason: '  Confirmado  ',
    })

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: {
        staffId: EDITOR,
        venueId: VENUE.id,
        organizationId: ORG,
        action: 'SALE_VERIFICATION_NUMBER_EDIT',
        entity: 'SaleVerification',
        entityId: SV,
        data: { field: 'linkingNumber', before: '551234567', after: '551234567', reason: 'Confirmado', source: 'BACKOFFICE' },
      },
    })
    // El antes sale de la fila tomada con candado dentro de la misma transacción.
    expect((tx.$queryRaw.mock.calls[0] as any[])[0].join('')).toMatch(/FOR UPDATE/)
  })

  it('los dos números a la vez: dos renglones de bitácora, uno por campo', async () => {
    const tx = montarTx(verificacion())

    await setOrgSaleVerificationNumbers(ORG, {
      saleVerificationId: SV,
      editedById: EDITOR,
      linkingNumber: '5512345678',
      portedNumber: '(55) 9876 5432',
    })

    expect(tx.saleVerification.update.mock.calls[0][0].data).toEqual({
      linkingNumber: '5512345678',
      linkingNumberSource: 'BACKOFFICE',
      linkingNumberSetAt: expect.any(Date),
      portedNumber: '5598765432',
      portedNumberSource: 'BACKOFFICE',
      portedNumberSetAt: expect.any(Date),
    })
    expect(tx.activityLog.create.mock.calls.map(c => c[0].data.data)).toEqual([
      { field: 'linkingNumber', before: '551234567', after: '5512345678', reason: null, source: 'BACKOFFICE' },
      { field: 'portedNumber', before: null, after: '5598765432', reason: null, source: 'BACKOFFICE' },
    ])
  })

  it('una venta de otra organización ⇒ 403 y no escribe', async () => {
    const tx = montarTx(verificacion(), OTHER_ORG)
    await expect(
      setOrgSaleVerificationNumbers(ORG, { saleVerificationId: SV, editedById: EDITOR, linkingNumber: '5512345678' }),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(tx.saleVerification.update).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it('una venta que no existe ⇒ 404', async () => {
    montarTx(null)
    await expect(
      setOrgSaleVerificationNumbers(ORG, { saleVerificationId: SV, editedById: EDITOR, linkingNumber: '5512345678' }),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('el portado en una venta sin portabilidad ⇒ 400 NOT_PORTABILIDAD y no escribe nada (tampoco el de vinculación)', async () => {
    const tx = montarTx(verificacion({ isPortabilidad: false }))
    await expect(
      setOrgSaleVerificationNumbers(ORG, {
        saleVerificationId: SV,
        editedById: EDITOR,
        linkingNumber: '5512345678',
        portedNumber: '5598765432',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'NOT_PORTABILIDAD' })
    expect(tx.saleVerification.update).not.toHaveBeenCalled()
  })

  it('con el interruptor apagado ⇒ 403 LINKING_NUMBER_DISABLED, sin abrir la transacción', async () => {
    enabled.mockResolvedValue(false)
    montarTx(verificacion())
    await expect(
      setOrgSaleVerificationNumbers(ORG, { saleVerificationId: SV, editedById: EDITOR, linkingNumber: '5512345678' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'LINKING_NUMBER_DISABLED' })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('sin ningún número ⇒ 400', async () => {
    montarTx(verificacion())
    await expect(setOrgSaleVerificationNumbers(ORG, { saleVerificationId: SV, editedById: EDITOR })).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })
})

describe('controlador y rutas de Ventas de la organización', () => {
  function res() {
    const r: any = {}
    r.status = jest.fn(() => r)
    r.json = jest.fn(() => r)
    return r as Response & { status: jest.Mock; json: jest.Mock }
  }
  const req = (over: Partial<Request> & Record<string, unknown>) =>
    ({ params: { orgId: ORG }, query: {}, body: {}, authContext: { userId: EDITOR }, ...over }) as unknown as Request

  it('numberAlert fuera de la lista ⇒ 400, sin consultar', async () => {
    const r = res()
    await ctrl.listOrgSaleVerifications(req({ query: { numberAlert: 'todas' } }), r)
    expect(r.status).toHaveBeenCalledWith(400)
    expect(mockPrisma.payment.findMany).not.toHaveBeenCalled()
  })

  it('numberAlert válido llega al servicio; su 400 de rango viaja con su code', async () => {
    const r = res()
    await ctrl.listOrgSaleVerifications(req({ query: { numberAlert: 'duplicate' } }), r)
    expect(r.status).toHaveBeenCalledWith(400)
    expect(r.json.mock.calls[0][0]).toMatchObject({ success: false, code: 'NUMBER_ALERT_NEEDS_RANGE' })
  })

  it('PATCH numbers pasa el cuerpo al servicio y contesta la verificación', async () => {
    const tx = {
      $queryRaw: jest.fn(async () => [verificacion()]),
      venue: { findUnique: jest.fn(async () => ({ organizationId: ORG })) },
      saleVerification: { update: jest.fn(async ({ data }: any) => ({ id: SV, ...data })) },
      activityLog: { create: jest.fn() },
    }
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(tx))
    const r = res()

    await ctrl.setOrgSaleVerificationNumbers(
      req({ params: { orgId: ORG, id: SV }, body: { linkingNumber: '5512345678', reason: 'Foto' } }),
      r,
    )

    expect(r.status).toHaveBeenCalledWith(200)
    expect(r.json.mock.calls[0][0]).toMatchObject({
      success: true,
      data: { id: SV, linkingNumber: '5512345678', linkingNumberSource: 'BACKOFFICE' },
    })
  })

  it('PATCH numbers con un número que no es texto ⇒ 400', async () => {
    const r = res()
    await ctrl.setOrgSaleVerificationNumbers(req({ params: { orgId: ORG, id: SV }, body: { linkingNumber: 5512345678 } }), r)
    expect(r.status).toHaveBeenCalledWith(400)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('un error que no es AppError (p. ej. de Prisma) no expone su code', async () => {
    mockPrisma.$transaction.mockRejectedValue(Object.assign(new Error('Record to update not found.'), { code: 'P2025' }))
    const r = res()

    await ctrl.setOrgSaleVerificationNumbers(req({ params: { orgId: ORG, id: SV }, body: { linkingNumber: '5512345678' } }), r)

    expect(r.status).toHaveBeenCalledWith(500)
    expect(r.json.mock.calls[0][0]).not.toHaveProperty('code')
  })

  it('las rutas de edición y de revisión tampoco exponen el code de un error que no es AppError', async () => {
    mockPrisma.saleVerification.findUnique.mockRejectedValue(Object.assign(new Error('boom'), { code: 'P2025' }))
    for (const handler of [ctrl.editOrgSaleVerification, ctrl.reviewOrgSaleVerification]) {
      const r = res()
      await handler(req({ params: { orgId: ORG, id: SV }, body: { reason: 'Motivo largo', decision: 'APPROVE' } }), r)
      expect(r.json.mock.calls[0][0]).not.toHaveProperty('code')
    }
  })

  it('GET linking-number-status contesta el interruptor de la organización', async () => {
    enabled.mockResolvedValue(true)
    const r = res()
    await ctrl.getLinkingNumberStatus(req({}), r)
    expect(enabled).toHaveBeenCalledWith(ORG)
    expect(r.json).toHaveBeenCalledWith({ success: true, enabled: true })
  })

  function routePermission(method: 'get' | 'patch', url: string): string | undefined {
    for (const layer of (orgSalesRouter as any).stack) {
      if (!layer.route?.methods?.[method] || !layer.match(url)) continue
      return layer.route.stack.map((l: any) => l.handle.permission).find(Boolean)
    }
    return undefined
  }

  it('PATCH /:id/numbers pide sale-verifications:edit y GET /linking-number-status pide sale-verifications:review', () => {
    expect(routePermission('patch', `/${SV}/numbers`)).toBe('sale-verifications:edit')
    expect(routePermission('get', '/linking-number-status')).toBe('sale-verifications:review')
  })
})
