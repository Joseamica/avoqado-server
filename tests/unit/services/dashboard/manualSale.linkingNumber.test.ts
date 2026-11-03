// Ventas externas con número de vinculación (PlayTelecom, A8).
// Con el interruptor prendido (`requireLinkingNumber`), cada fila trae su número de vinculación (y el portado si es
// portabilidad), de 9 o 10 dígitos; se guarda con fuente EXTERNAL_SALE y la vista previa marca los repetidos sin
// frenar la fila. Apagado, los números se ignoran por completo (Review Focus 5: plantilla vieja y MCP).
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

import { Prisma } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    serializedItemCustodyEvent: { create: jest.fn() },
  },
}))

const resolveIccidMock = jest.fn()
const resolveVenueMock = jest.fn()
const resolveStaffByCodeMock = jest.fn()
const resolveCategoryMock = jest.fn()
jest.mock('@/services/dashboard/manualSale.resolvers', () => ({
  __esModule: true,
  resolveIccid: (...a: any[]) => resolveIccidMock(...a),
  resolveVenue: (...a: any[]) => resolveVenueMock(...a),
  resolveStaffByCode: (...a: any[]) => resolveStaffByCodeMock(...a),
  resolveCategory: (...a: any[]) => resolveCategoryMock(...a),
  mapPaymentForm: () => ({ method: 'CASH', amountApplies: true }),
  parseAmount: () => new Prisma.Decimal(150),
  mapSaleStatus: (...a: any[]) => jest.requireActual('@/services/dashboard/manualSale.resolvers').mapSaleStatus(...a),
}))

const markAsSoldMock = jest.fn().mockResolvedValue({})
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({
  __esModule: true,
  serializedInventoryService: { markAsSold: (...a: any[]) => markAsSoldMock(...a) },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn().mockResolvedValue(undefined),
}))

const findDuplicatesMock = jest.fn()
jest.mock('@/services/playtelecom/linkingNumber.duplicates', () => ({
  __esModule: true,
  findDuplicatesForSales: (...a: any[]) => findDuplicatesMock(...a),
}))

import { bulkManualSales, createOneManualSale } from '@/services/dashboard/manualSale.service'
import prisma from '@/utils/prismaClient'
import type { ManualSaleRowInput } from '@/schemas/dashboard/manualSale.schema'

const prismaMock = prisma as jest.Mocked<typeof prisma>
const ORG_ID = 'org-1'
const ACTOR = 'actor-staff-1'
const ON = { requireLinkingNumber: true }
const OFF = { requireLinkingNumber: false }

let lastTx: ReturnType<typeof makeTx>
let txs: Array<ReturnType<typeof makeTx>> = []
function makeTx() {
  return {
    order: { create: jest.fn().mockResolvedValue({ id: 'order-1' }) },
    orderItem: { create: jest.fn().mockResolvedValue({ id: 'orderitem-1' }) },
    payment: { create: jest.fn().mockResolvedValue({ id: 'payment-1' }) },
    saleVerification: { create: jest.fn().mockResolvedValue({ id: 'verification-1' }) },
  }
}
const svData = () => (lastTx.saleVerification.create as jest.Mock).mock.calls[0][0].data
/**
 * Ninguna venta a medias: la transacción puede abrirse (los resolvers corren dentro) pero nada se escribe. Sin argumento,
 * en todas las transacciones; con `scope`, sólo en ésas (las de las filas malas de un archivo que sí crea otras).
 */
function expectNothingWritten(scope = txs) {
  for (const t of scope) {
    for (const m of [t.order.create, t.orderItem.create, t.payment.create, t.saleVerification.create]) expect(m).not.toHaveBeenCalled()
  }
  // markAsSold(venueId, serial, orderItemId, tx, …): ninguna llamada dentro de esas transacciones.
  expect(markAsSoldMock.mock.calls.filter(c => scope.includes(c[3]))).toEqual([])
}
const SOLD = 'ICCID-SOLD'

function row(overrides: Partial<ManualSaleRowInput> = {}): ManualSaleRowInput {
  return {
    iccid: '8952140064323812041F',
    promoterCode: 'P123',
    storeName: 'BAE MUÑOZ SLP (898)',
    saleDate: '2026-10-24',
    saleType: 'Línea nueva',
    paymentForm: 'Efectivo',
    amount: 150,
    linkingNumber: '5512345678',
    ...overrides,
  }
}
const porta = (overrides: Partial<ManualSaleRowInput> = {}) => row({ saleType: 'Portabilidad', portedNumber: '5587654321', ...overrides })

beforeEach(() => {
  jest.clearAllMocks()
  txs = []
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
    lastTx = makeTx()
    txs.push(lastTx)
    return cb(lastTx)
  })
  resolveIccidMock.mockImplementation(async (_org: string, iccid: string) =>
    iccid === SOLD
      ? { error: 'ICCID ya vendido' }
      : { item: { id: `sim-${iccid}`, serialNumber: iccid.trim().toUpperCase(), categoryId: 'cat-1' } },
  )
  resolveVenueMock.mockResolvedValue({ venue: { id: 'store-venue-1', name: 'BAE MUÑOZ SLP' } })
  resolveStaffByCodeMock.mockResolvedValue({ staff: { id: 'seller-staff-1' } })
  resolveCategoryMock.mockResolvedValue({ categoryId: 'cat-1' })
  findDuplicatesMock.mockImplementation(async (_org: string, sales: Array<{ key: string }>) => new Map(sales.map(s => [s.key, {}])))
})

describe('createOneManualSale — interruptor prendido', () => {
  it('sin número de vinculación: la fila falla con «Falta el número de vinculación» y no escribe nada', async () => {
    const result = await createOneManualSale(ORG_ID, ACTOR, row({ linkingNumber: undefined }), ON)
    expect(result).toEqual({ ok: false, error: 'Falta el número de vinculación' })
    expectNothingWritten()
  })

  it('un número de puros espacios cuenta como vacío', async () => {
    const result = await createOneManualSale(ORG_ID, ACTOR, row({ linkingNumber: '   ' }), ON)
    expect(result).toEqual({ ok: false, error: 'Falta el número de vinculación' })
  })

  it('portabilidad sin número portado: «Falta el número portado»', async () => {
    const result = await createOneManualSale(ORG_ID, ACTOR, porta({ portedNumber: undefined }), ON)
    expect(result).toEqual({ ok: false, error: 'Falta el número portado' })
  })

  it.each([
    ['8 dígitos', '55123456'],
    ['11 dígitos', '55123456789'],
    ['12 dígitos con +52 pegado', '+52 55 1234 5678'],
    ['letras', '55ABC45678'],
  ])('número de vinculación con %s: «Número de vinculación inválido»', async (_label, value) => {
    const result = await createOneManualSale(ORG_ID, ACTOR, row({ linkingNumber: value }), ON)
    expect(result).toEqual({ ok: false, error: 'Número de vinculación inválido' })
    expectNothingWritten()
  })

  it('número portado inválido: «Número portado inválido»', async () => {
    const result = await createOneManualSale(ORG_ID, ACTOR, porta({ portedNumber: '1234' }), ON)
    expect(result).toEqual({ ok: false, error: 'Número portado inválido' })
  })

  it('los dos números mal en la misma fila: se dicen los dos', async () => {
    const result = await createOneManualSale(ORG_ID, ACTOR, porta({ linkingNumber: undefined, portedNumber: '12' }), ON)
    expect(result).toEqual({ ok: false, error: 'Falta el número de vinculación; Número portado inválido' })
  })

  it('guarda sólo los dígitos de un número pegado con espacios y guiones, con fuente EXTERNAL_SALE', async () => {
    const result = await createOneManualSale(ORG_ID, ACTOR, row({ linkingNumber: '55 1234-5678' }), ON)
    expect(result.ok).toBe(true)
    expect(svData()).toMatchObject({ linkingNumber: '5512345678', linkingNumberSource: 'EXTERNAL_SALE' })
    expect(svData().linkingNumberSetAt).toBeInstanceOf(Date)
    expect(svData().portedNumber).toBeUndefined()
  })

  it('portabilidad: guarda los dos números con fuente EXTERNAL_SALE', async () => {
    await createOneManualSale(ORG_ID, ACTOR, porta(), ON)
    expect(svData()).toMatchObject({
      isPortabilidad: true,
      linkingNumber: '5512345678',
      linkingNumberSource: 'EXTERNAL_SALE',
      portedNumber: '5587654321',
      portedNumberSource: 'EXTERNAL_SALE',
    })
    expect(svData().portedNumberSetAt).toBeInstanceOf(Date)
  })

  it('acepta 9 dígitos (Ruling A8-1); el back-office lo confirma después', async () => {
    const result = await createOneManualSale(ORG_ID, ACTOR, row({ linkingNumber: '551234567' }), ON)
    expect(result.ok).toBe(true)
    expect(svData()).toMatchObject({ linkingNumber: '551234567', linkingNumberSource: 'EXTERNAL_SALE' })
  })

  it('una venta que no es de portabilidad con número portado es error, nunca se tira en silencio (Ruling A8-4)', async () => {
    const result = await createOneManualSale(ORG_ID, ACTOR, row({ portedNumber: '5587654321' }), ON)
    expect(result).toEqual({ ok: false, error: 'La venta no es de portabilidad: quita el número portado' })
    expectNothingWritten()
  })

  it.each(['-', '( )', ' . '])(
    'una venta que no es de portabilidad con «%s» de relleno en el portado se crea: sin dígitos cuenta como vacío',
    async filler => {
      const result = await createOneManualSale(ORG_ID, ACTOR, row({ portedNumber: filler }), ON)
      expect(result.ok).toBe(true)
      expect(svData()).not.toHaveProperty('portedNumber')
    },
  )

  it('un SIM ya vendido sigue siendo «ICCID ya vendido» aunque la fila no traiga número (Ruling A8-3)', async () => {
    const result = await createOneManualSale(ORG_ID, ACTOR, row({ iccid: SOLD, linkingNumber: undefined }), ON)
    expect(result).toEqual({ ok: false, error: 'ICCID ya vendido' })
    expectNothingWritten()
  })
})

describe('createOneManualSale — interruptor apagado (Review Focus 5)', () => {
  it('una fila sin número se crea igual', async () => {
    const result = await createOneManualSale(ORG_ID, ACTOR, row({ linkingNumber: undefined }), OFF)
    expect(result.ok).toBe(true)
    expect(svData().linkingNumber).toBeUndefined()
  })

  it('una fila con número (aunque sea inválido) lo ignora: ni valida ni guarda', async () => {
    const result = await createOneManualSale(ORG_ID, ACTOR, porta({ linkingNumber: '123', portedNumber: '5587654321' }), OFF)
    expect(result.ok).toBe(true)
    const data = svData()
    for (const key of [
      'linkingNumber',
      'linkingNumberSource',
      'linkingNumberSetAt',
      'portedNumber',
      'portedNumberSource',
      'portedNumberSetAt',
    ]) {
      expect(data).not.toHaveProperty(key)
    }
  })

  it('una línea nueva con número portado se crea y lo ignora', async () => {
    const result = await createOneManualSale(ORG_ID, ACTOR, row({ portedNumber: '5587654321' }), OFF)
    expect(result.ok).toBe(true)
    expect(svData()).not.toHaveProperty('portedNumber')
  })
})

describe('bulkManualSales — vista previa con el interruptor prendido', () => {
  it('una fila nueva sin número va a error con su motivo', async () => {
    const result = await bulkManualSales(ORG_ID, ACTOR, [row({ linkingNumber: undefined })], false, ON)
    expect(result.error).toEqual([
      { index: 0, iccid: '8952140064323812041F', storeName: 'BAE MUÑOZ SLP (898)', motivo: 'Falta el número de vinculación' },
    ])
    expect(result.crear).toEqual([])
  })

  it('una fila que no es de portabilidad con número portado va a error (Ruling A8-4)', async () => {
    const result = await bulkManualSales(ORG_ID, ACTOR, [row({ portedNumber: '5587654321' })], false, ON)
    expect(result.error).toEqual([
      {
        index: 0,
        iccid: '8952140064323812041F',
        storeName: 'BAE MUÑOZ SLP (898)',
        motivo: 'La venta no es de portabilidad: quita el número portado',
      },
    ])
  })

  it('vista previa: un «-» de relleno en el portado de una línea nueva no es error', async () => {
    const result = await bulkManualSales(ORG_ID, ACTOR, [row({ portedNumber: '-' })], false, ON)
    expect(result.error).toEqual([])
    expect(result.crear).toHaveLength(1)
  })

  it('marca linkingDuplicate contra la organización y la fila se sigue creando', async () => {
    findDuplicatesMock.mockImplementation(async () => new Map([['0', { linking: { total: 1, matches: [] } }]]))

    const result = await bulkManualSales(
      ORG_ID,
      ACTOR,
      [row({ iccid: ' 8952140064323812041f ', linkingNumber: '55-1234-5678' })],
      false,
      ON,
    )

    expect(result.crear).toEqual([
      { index: 0, iccid: ' 8952140064323812041f ', storeName: 'BAE MUÑOZ SLP (898)', saleStatus: 'COMPLETED', linkingDuplicate: true },
    ])
    expect(result.error).toEqual([])
    // Una sola consulta para todo el archivo; la fila aún no existe (verificationId null) y lleva su ICCID guardado.
    expect(findDuplicatesMock).toHaveBeenCalledTimes(1)
    expect(findDuplicatesMock).toHaveBeenCalledWith(ORG_ID, [
      { key: '0', verificationId: null, iccid: '8952140064323812041F', linkingNumber: '5512345678', portedNumber: null },
    ])
  })

  it('marca portedDuplicate contra la organización', async () => {
    findDuplicatesMock.mockImplementation(async () => new Map([['0', { ported: { total: 1, matches: [] } }]]))
    const result = await bulkManualSales(ORG_ID, ACTOR, [porta()], false, ON)
    expect(result.crear[0]).toMatchObject({ portedDuplicate: true })
    expect(result.crear[0]).not.toHaveProperty('linkingDuplicate')
  })

  it('marca como repetidas dos filas del mismo archivo con el mismo número (vinculación o portado)', async () => {
    const rows = [
      row({ iccid: 'ICCID-A', linkingNumber: '5511111111' }),
      row({ iccid: 'ICCID-B', linkingNumber: '55 1111 1111' }),
      porta({ iccid: 'ICCID-C', linkingNumber: '5533333333', portedNumber: '5522222222' }),
      row({ iccid: 'ICCID-D', linkingNumber: '5522222222' }),
      row({ iccid: 'ICCID-E', linkingNumber: '5544444444' }),
    ]

    const result = await bulkManualSales(ORG_ID, ACTOR, rows, false, ON)

    expect(result.crear).toHaveLength(5)
    expect(result.crear[0]).toMatchObject({ linkingDuplicate: true })
    expect(result.crear[1]).toMatchObject({ linkingDuplicate: true })
    expect(result.crear[2]).toMatchObject({ portedDuplicate: true })
    expect(result.crear[2]).not.toHaveProperty('linkingDuplicate')
    expect(result.crear[3]).toMatchObject({ linkingDuplicate: true })
    expect(result.crear[4]).not.toHaveProperty('linkingDuplicate')
    expect(result.crear[4]).not.toHaveProperty('portedDuplicate')
    expect(findDuplicatesMock).toHaveBeenCalledTimes(1)
  })

  it('el mismo número en vinculación y portado de la MISMA fila no es repetido consigo mismo (Review Focus 2)', async () => {
    const result = await bulkManualSales(ORG_ID, ACTOR, [porta({ linkingNumber: '5512345678', portedNumber: '5512345678' })], false, ON)
    expect(result.crear[0]).not.toHaveProperty('linkingDuplicate')
    expect(result.crear[0]).not.toHaveProperty('portedDuplicate')
  })

  it('una fila que no se va a crear no marca a la otra (sólo cuentan las de «crear»)', async () => {
    resolveVenueMock.mockResolvedValueOnce({ error: 'Tienda no encontrada' })
    const rows = [row({ iccid: 'ICCID-A', storeName: 'Otra' }), row({ iccid: 'ICCID-B' })]

    const result = await bulkManualSales(ORG_ID, ACTOR, rows, false, ON)

    expect(result.error).toHaveLength(1)
    expect(result.crear).toEqual([{ index: 1, iccid: 'ICCID-B', storeName: 'BAE MUÑOZ SLP (898)', saleStatus: 'COMPLETED' }])
  })

  it('la vista previa no escribe nada', async () => {
    await bulkManualSales(ORG_ID, ACTOR, [row()], false, ON)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})

describe('bulkManualSales — interruptor apagado (Review Focus 5)', () => {
  it('vista previa: con o sin número, las filas van a crear sin marcas y sin buscar repetidos', async () => {
    const rows = [row({ iccid: 'ICCID-A', linkingNumber: undefined }), row({ iccid: 'ICCID-B', linkingNumber: '12' })]

    const result = await bulkManualSales(ORG_ID, ACTOR, rows, false, OFF)

    expect(result.crear).toEqual([
      { index: 0, iccid: 'ICCID-A', storeName: 'BAE MUÑOZ SLP (898)', saleStatus: 'COMPLETED' },
      { index: 1, iccid: 'ICCID-B', storeName: 'BAE MUÑOZ SLP (898)', saleStatus: 'COMPLETED' },
    ])
    expect(result.error).toEqual([])
    expect(findDuplicatesMock).not.toHaveBeenCalled()
  })

  it('aplicar: una fila sin número se crea igual', async () => {
    const result = await bulkManualSales(ORG_ID, ACTOR, [row({ linkingNumber: undefined })], true, OFF)
    expect(result.created).toBe(1)
    expect(svData().linkingNumber).toBeUndefined()
  })

  it('aplicar: estatus inválido + SIM ya vendido ⇒ error por el estatus (va antes que el SIM), no omitir', async () => {
    const result = await bulkManualSales(ORG_ID, ACTOR, [row({ iccid: SOLD, saleStatus: 'Pendiente' })], true, OFF)
    expect(result.omitir).toEqual([])
    expect(result.error).toHaveLength(1)
    expect(result.error[0]).toMatchObject({ index: 0, iccid: SOLD })
    expect(result.error[0].motivo).toMatch(/estatus/i)
    expect(result.created).toBe(0)
    expectNothingWritten()
  })
})

describe('bulkManualSales — aplicar con el interruptor prendido', () => {
  it('la fila sin número va a error y la buena se crea con su número', async () => {
    const rows = [row({ iccid: 'ICCID-A', linkingNumber: undefined }), row({ iccid: 'ICCID-B', linkingNumber: '5512345678' })]

    const result = await bulkManualSales(ORG_ID, ACTOR, rows, true, ON)

    expect(result.error).toEqual([
      { index: 0, iccid: 'ICCID-A', storeName: 'BAE MUÑOZ SLP (898)', motivo: 'Falta el número de vinculación' },
    ])
    expect(result.created).toBe(1)
    // La fila mala abre su transacción (los resolvers corren dentro) pero no escribe nada en ella.
    expect(txs).toHaveLength(2)
    expectNothingWritten([txs[0]])
    expect(svData()).toMatchObject({ linkingNumber: '5512345678', linkingNumberSource: 'EXTERNAL_SALE' })
  })
})

// Ruling A8-3: estatus → resolvers (omitir/error) → números → crear, igual en la vista previa y al aplicar.
describe.each([
  ['vista previa', false],
  ['aplicar', true],
])('bulkManualSales — orden de las revisiones (%s, interruptor prendido)', (_label, apply) => {
  it('archivo viejo, sin las columnas: el SIM ya registrado sigue en omitir', async () => {
    const result = await bulkManualSales(ORG_ID, ACTOR, [row({ iccid: SOLD, linkingNumber: undefined })], apply, ON)
    expect(result.omitir).toEqual([{ index: 0, iccid: SOLD, storeName: 'BAE MUÑOZ SLP (898)', motivo: 'ICCID ya vendido' }])
    expect(result.error).toEqual([])
    expectNothingWritten()
  })

  it('archivo mixto: los ya vendidos a omitir y sólo los nuevos sin número a error', async () => {
    const rows = [row({ iccid: SOLD, linkingNumber: undefined }), row({ iccid: 'ICCID-NEW', linkingNumber: undefined })]

    const result = await bulkManualSales(ORG_ID, ACTOR, rows, apply, ON)

    expect(result.omitir).toEqual([{ index: 0, iccid: SOLD, storeName: 'BAE MUÑOZ SLP (898)', motivo: 'ICCID ya vendido' }])
    expect(result.error).toEqual([
      { index: 1, iccid: 'ICCID-NEW', storeName: 'BAE MUÑOZ SLP (898)', motivo: 'Falta el número de vinculación' },
    ])
    expect(result.crear).toEqual([])
    expectNothingWritten()
  })

  it('un estatus inválido se dice antes que el número que falta', async () => {
    const result = await bulkManualSales(ORG_ID, ACTOR, [row({ saleStatus: 'Pendiente', linkingNumber: undefined })], apply, ON)
    expect(result.error).toHaveLength(1)
    expect(result.error[0].motivo).toMatch(/estatus/i)
  })

  it('una tienda que no existe se dice antes que el número que falta', async () => {
    resolveVenueMock.mockResolvedValue({ error: 'Tienda no encontrada' })
    const result = await bulkManualSales(ORG_ID, ACTOR, [row({ linkingNumber: undefined })], apply, ON)
    expect(result.error).toEqual([
      { index: 0, iccid: '8952140064323812041F', storeName: 'BAE MUÑOZ SLP (898)', motivo: 'Tienda no encontrada' },
    ])
  })
})
