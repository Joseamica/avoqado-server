// tests/unit/services/fiscal/cfdiConceptosPorTratamiento.test.ts
// Plan 3 (IVA por producto), Tarea 3: conceptos por tratamiento.
//
// 🔴 La primera mitad son GOLDEN de la rama todo-16: se capturaron con el código ANTERIOR a la tarea
// (commit 0e5c7c40) y fijan, por orden, el payload al PAC, los montos que se guardan en la fila y los
// motivos. En producción todo es IVA_16 mientras la bandera esté apagada: si una golden cambia, el
// defecto es del cambio, nunca de la golden.
import { Prisma } from '@prisma/client'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn() },
    merchantFiscalConfig: { findUnique: jest.fn() },
    fiscalEmisor: { findMany: jest.fn().mockResolvedValue([]) },
  },
}))
jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import prisma from '../../../../src/utils/prismaClient'
import {
  issueCfdiForOrder,
  IssueCfdiDeps,
  loadOrderForCfdiFromDb,
  repartirDescuentoDeOrden,
  RenglonParaCfdi,
} from '../../../../src/services/fiscal/cfdi.service'
import { assembleSaleInput } from '../../../../src/services/fiscal/assembleSaleInput'
import { buildCreateInvoiceParams } from '../../../../src/services/fiscal/cfdiPayloadBuilder'

const D = (n: number) => new Prisma.Decimal(n)
const orderMock = prisma.order.findUnique as jest.Mock
const cfgMock = prisma.merchantFiscalConfig.findUnique as jest.Mock

const receptor = {
  rfc: 'EKU9003173C9',
  razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
  regimenFiscal: '601',
  codigoPostal: '64000',
  usoCfdi: 'G03',
}

const CONFIG = {
  facturacionEnabled: true,
  autofacturaEnabled: true,
  fiscalEmisor: {
    id: 'e1',
    venueId: 'v1',
    provider: 'FACTURAPI',
    providerKeyEnc: null,
    csdStatus: 'ACTIVE',
    serie: 'F',
    invoiceCashSales: false,
  },
}

type Prod = Record<string, any>
function producto(over: Prod = {}): Prod {
  return {
    name: 'Producto',
    satProductKey: '90101501',
    satUnitKey: 'H87',
    objetoImp: '02',
    taxRate: D(0.16),
    ivaTratamiento: 'IVA_16',
    category: null,
    ...over,
  }
}

function renglon(over: Record<string, any> = {}) {
  return {
    id: 'oi-1',
    ivaTratamiento: null,
    productName: 'Producto',
    quantity: 1,
    unitPrice: D(100),
    discountAmount: D(0),
    total: D(100),
    weightQuantity: null,
    modifiers: [],
    product: producto(),
    ...over,
  }
}

function orden(pagado: number, over: Record<string, any> = {}) {
  return {
    venueId: 'v1',
    subtotal: D(pagado),
    taxAmount: D(0),
    total: D(pagado),
    tipAmount: D(0),
    discountAmount: D(0),
    serviceChargeAmount: D(0),
    promotions: [],
    contratoDePrecio: 'IVA_INCLUIDO',
    paymentStatus: 'PAID',
    venue: { slug: 'demo', type: 'RESTAURANT' },
    payments: [
      {
        method: 'CREDIT_CARD',
        merchantAccountId: 'm1',
        ecommerceMerchantId: null,
        tenderSatFormaPago: null,
        amount: D(pagado),
        type: 'REGULAR',
      },
    ],
    items: [renglon({ unitPrice: D(pagado), total: D(pagado) })],
    ...over,
  }
}

// ─── Las 5 órdenes de la rama todo-16 + las 2 bloqueadas de hoy ──────────────────────────────────────
const CASOS: Record<string, any> = {
  // 1. Extras con precio (y uno de $0 que se queda en el nombre) + un producto con claves de su categoría.
  //    Contrato DESCONOCIDO y pago PENDING a propósito: en la rama todo-16 los candados NO aplican.
  extras: orden(175, {
    contratoDePrecio: 'DESCONOCIDO',
    paymentStatus: 'PENDING',
    items: [
      renglon({
        id: 'oi-cap',
        productName: 'CAPUCCINO',
        quantity: 2,
        unitPrice: D(65),
        total: D(140),
        modifiers: [
          { name: 'Deslactosada', price: D(5), quantity: 1 },
          { name: 'Canela', price: D(0), quantity: 1 },
        ],
        product: producto({ name: 'CAPUCCINO' }),
      }),
      renglon({
        id: 'oi-pan',
        productName: 'Pan dulce',
        unitPrice: D(35),
        total: D(35),
        product: producto({
          name: 'Pan dulce',
          satProductKey: null,
          satUnitKey: null,
          category: { defaultSatProductKey: '50181900', defaultSatUnitKey: 'H87' },
        }),
      }),
    ],
  }),
  // 2. Venta por peso con centavos exactos: 0.250 kg × $180 = $45.00.
  peso: orden(45, {
    items: [
      renglon({
        id: 'oi-queso',
        productName: 'Queso Oaxaca',
        quantity: 1,
        weightQuantity: D(0.25),
        unitPrice: D(180),
        total: D(45),
        product: producto({ name: 'Queso Oaxaca', satProductKey: '50131700', satUnitKey: 'KGM' }),
      }),
    ],
  }),
  // 3. Descuento de renglón ($20 sobre $120).
  descuentoRenglon: orden(100, {
    discountAmount: D(20),
    items: [renglon({ id: 'oi-hamb', productName: 'Hamburguesa', unitPrice: D(120), total: D(120), discountAmount: D(20) })],
  }),
  // 4. Venta sin renglones (importe libre): un concepto «Venta» por lo pagado.
  sinRenglones: orden(50, { items: [] }),
  // 5. IVA separado (taxAmount > 0): precios NETOS, el PAC suma el IVA.
  ivaSeparado: orden(232, {
    subtotal: D(200),
    taxAmount: D(32),
    total: D(232),
    contratoDePrecio: 'IVA_APARTE',
    items: [renglon({ id: 'oi-clase', productName: 'Clase de yoga', unitPrice: D(200), total: D(200) })],
  }),
  // B1. Bloqueada hoy: tasa 0 + objeto 02 SIN tratamiento (entrada legacy).
  bloqueadaTasa0Objeto02: orden(30, {
    items: [
      renglon({
        id: undefined,
        ivaTratamiento: undefined,
        productName: 'Agua',
        unitPrice: D(30),
        total: D(30),
        product: { name: 'Agua', satProductKey: '50202301', satUnitKey: 'H87', objetoImp: '02', taxRate: D(0), category: null },
      }),
    ],
  }),
  // B2. Bloqueada hoy: descuento general sobre dos tasas (16 % y no objeto), entrada legacy.
  bloqueadaDescuentoDosTasas: orden(140, {
    discountAmount: D(10),
    items: [
      renglon({
        id: undefined,
        ivaTratamiento: undefined,
        productName: 'Café',
        unitPrice: D(100),
        total: D(100),
        product: { name: 'Café', satProductKey: '90101501', satUnitKey: 'H87', objetoImp: '02', taxRate: D(0.16), category: null },
      }),
      renglon({
        id: undefined,
        ivaTratamiento: undefined,
        productName: 'Propina de barra',
        unitPrice: D(50),
        total: D(50),
        product: { name: 'Propina de barra', satProductKey: '84111506', satUnitKey: 'ACT', objetoImp: '01', taxRate: D(0), category: null },
      }),
    ],
  }),
}

function depsDelMotor(createInvoice: jest.Mock): IssueCfdiDeps {
  return {
    findExistingCfdi: jest.fn().mockResolvedValue(null),
    reserveCfdi: jest.fn().mockResolvedValue({}),
    claimCfdi: jest.fn().mockResolvedValue(true),
    persistArtifacts: jest.fn().mockResolvedValue({}),
    loadOrderForCfdi: loadOrderForCfdiFromDb,
    resolveProvider: jest.fn().mockReturnValue({
      name: 'facturapi',
      createInvoice,
      downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
      downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
    } as any),
    storeArtifact: jest.fn().mockImplementation(async (_b, path) => `https://cdn/${path}`),
    persistCfdi: jest.fn().mockImplementation(async data => ({ id: 'cfdi1', ...data })),
  }
}

/** Lo que la golden fija de UNA orden: payload, montos guardados y motivos (motor completo). */
async function resultadoDe(caso: any) {
  orderMock.mockResolvedValue(caso)
  cfgMock.mockResolvedValue(CONFIG)
  const bundle = await loadOrderForCfdiFromDb('o1', { permitirEfectivo: true })
  if (!bundle) throw new Error('el cargador devolvió null')
  // (a) El payload que sale de assemble + build sobre el bundle del cargador.
  const payload = buildCreateInvoiceParams(
    assembleSaleInput(bundle.order, {
      receptor,
      paymentMethod: bundle.paymentMethod,
      tenderSatFormaPago: bundle.tenderSatFormaPago ?? null,
      metodoPago: bundle.metodoPago,
      serie: bundle.emisor.serie ?? undefined,
      idempotencyKey: 'cfdi-order-o1',
    }),
  )
  // (b) + (c) El motor completo: montos que se guardan en la fila y motivos (validación + barrera).
  const createInvoice = jest.fn().mockResolvedValue({
    providerInvoiceId: 'fa1',
    uuid: 'UUID-1',
    serie: 'F',
    folio: '1',
    totalCents: 0,
    stampedAt: new Date('2026-09-26T00:00:00Z'),
    status: 'valid',
  })
  const deps = depsDelMotor(createInvoice)
  const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
  const fila = (deps.reserveCfdi as jest.Mock).mock.calls[0][0]
  // El motor manda al PAC exactamente el payload de (a), más su external_id.
  if (res.status === 'STAMPED') {
    expect(createInvoice).toHaveBeenCalledWith({ ...payload, externalId: 'cfdi-order-o1' })
  } else {
    expect(createInvoice).not.toHaveBeenCalled()
  }
  return {
    payload,
    guardado: { subtotalCents: fila.subtotalCents, taxCents: fila.taxCents, totalCents: fila.totalCents },
    status: res.status,
    motivos: res.reasons ?? [],
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

// Capturadas con el código anterior a la tarea (0e5c7c40). NO se editan: ver la cabecera.
const GOLDEN: Record<string, any> = {
  extras: {
    payload: {
      receptor: {
        rfc: 'EKU9003173C9',
        razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
        regimenFiscal: '601',
        codigoPostal: '64000',
        usoCfdi: 'G03',
      },
      items: [
        {
          satProductKey: '90101501',
          satUnitKey: 'H87',
          description: 'CAPUCCINO (Canela)',
          quantity: 2,
          unitPriceCents: 6500,
          discountCents: 0,
          objetoImp: '02',
          taxes: [
            {
              type: 'IVA',
              factor: 'Tasa',
              rate: 0.16,
              withholding: false,
            },
          ],
          taxIncluded: true,
        },
        {
          satProductKey: '90101501',
          satUnitKey: 'H87',
          description: 'Deslactosada (CAPUCCINO)',
          quantity: 1,
          unitPriceCents: 1000,
          discountCents: 0,
          objetoImp: '02',
          taxes: [
            {
              type: 'IVA',
              factor: 'Tasa',
              rate: 0.16,
              withholding: false,
            },
          ],
          taxIncluded: true,
        },
        {
          satProductKey: '50181900',
          satUnitKey: 'H87',
          description: 'Pan dulce',
          quantity: 1,
          unitPriceCents: 3500,
          discountCents: 0,
          objetoImp: '02',
          taxes: [
            {
              type: 'IVA',
              factor: 'Tasa',
              rate: 0.16,
              withholding: false,
            },
          ],
          taxIncluded: true,
        },
      ],
      formaPago: '04',
      metodoPago: 'PUE',
      serie: 'F',
      idempotencyKey: 'cfdi-order-o1',
    },
    guardado: {
      subtotalCents: 15086,
      taxCents: 2414,
      totalCents: 17500,
    },
    status: 'STAMPED',
    motivos: [],
  },
  peso: {
    payload: {
      receptor: {
        rfc: 'EKU9003173C9',
        razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
        regimenFiscal: '601',
        codigoPostal: '64000',
        usoCfdi: 'G03',
      },
      items: [
        {
          satProductKey: '50131700',
          satUnitKey: 'KGM',
          description: 'Queso Oaxaca',
          quantity: 0.25,
          unitPriceCents: 18000,
          discountCents: 0,
          objetoImp: '02',
          taxes: [
            {
              type: 'IVA',
              factor: 'Tasa',
              rate: 0.16,
              withholding: false,
            },
          ],
          taxIncluded: true,
        },
      ],
      formaPago: '04',
      metodoPago: 'PUE',
      serie: 'F',
      idempotencyKey: 'cfdi-order-o1',
    },
    guardado: {
      subtotalCents: 3879,
      taxCents: 621,
      totalCents: 4500,
    },
    status: 'STAMPED',
    motivos: [],
  },
  descuentoRenglon: {
    payload: {
      receptor: {
        rfc: 'EKU9003173C9',
        razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
        regimenFiscal: '601',
        codigoPostal: '64000',
        usoCfdi: 'G03',
      },
      items: [
        {
          satProductKey: '90101501',
          satUnitKey: 'H87',
          description: 'Hamburguesa',
          quantity: 1,
          unitPriceCents: 12000,
          discountCents: 2000,
          objetoImp: '02',
          taxes: [
            {
              type: 'IVA',
              factor: 'Tasa',
              rate: 0.16,
              withholding: false,
            },
          ],
          taxIncluded: true,
        },
      ],
      formaPago: '04',
      metodoPago: 'PUE',
      serie: 'F',
      idempotencyKey: 'cfdi-order-o1',
    },
    guardado: {
      subtotalCents: 8621,
      taxCents: 1379,
      totalCents: 10000,
    },
    status: 'STAMPED',
    motivos: [],
  },
  sinRenglones: {
    payload: {
      receptor: {
        rfc: 'EKU9003173C9',
        razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
        regimenFiscal: '601',
        codigoPostal: '64000',
        usoCfdi: 'G03',
      },
      items: [
        {
          satProductKey: '01010101',
          satUnitKey: 'ACT',
          description: 'Venta',
          quantity: 1,
          unitPriceCents: 5000,
          discountCents: 0,
          objetoImp: '02',
          taxes: [
            {
              type: 'IVA',
              factor: 'Tasa',
              rate: 0.16,
              withholding: false,
            },
          ],
          taxIncluded: true,
        },
      ],
      formaPago: '04',
      metodoPago: 'PUE',
      serie: 'F',
      idempotencyKey: 'cfdi-order-o1',
    },
    guardado: {
      subtotalCents: 4310,
      taxCents: 690,
      totalCents: 5000,
    },
    status: 'STAMPED',
    motivos: [],
  },
  ivaSeparado: {
    payload: {
      receptor: {
        rfc: 'EKU9003173C9',
        razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
        regimenFiscal: '601',
        codigoPostal: '64000',
        usoCfdi: 'G03',
      },
      items: [
        {
          satProductKey: '90101501',
          satUnitKey: 'H87',
          description: 'Clase de yoga',
          quantity: 1,
          unitPriceCents: 20000,
          discountCents: 0,
          objetoImp: '02',
          taxes: [
            {
              type: 'IVA',
              factor: 'Tasa',
              rate: 0.16,
              withholding: false,
            },
          ],
          taxIncluded: false,
        },
      ],
      formaPago: '04',
      metodoPago: 'PUE',
      serie: 'F',
      idempotencyKey: 'cfdi-order-o1',
    },
    guardado: {
      subtotalCents: 20000,
      taxCents: 3200,
      totalCents: 23200,
    },
    status: 'STAMPED',
    motivos: [],
  },
  bloqueadaTasa0Objeto02: {
    payload: {
      receptor: {
        rfc: 'EKU9003173C9',
        razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
        regimenFiscal: '601',
        codigoPostal: '64000',
        usoCfdi: 'G03',
      },
      items: [],
      formaPago: '04',
      metodoPago: 'PUE',
      serie: 'F',
      idempotencyKey: 'cfdi-order-o1',
    },
    guardado: {
      subtotalCents: 0,
      taxCents: 0,
      totalCents: 0,
    },
    status: 'VALIDATION_FAILED',
    motivos: ['«Agua»: producto con tasa 0 y objeto de impuesto 02 (tasa cero vs exento sin distinguir).'],
  },
  bloqueadaDescuentoDosTasas: {
    payload: {
      receptor: {
        rfc: 'EKU9003173C9',
        razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
        regimenFiscal: '601',
        codigoPostal: '64000',
        usoCfdi: 'G03',
      },
      items: [
        {
          satProductKey: '90101501',
          satUnitKey: 'H87',
          description: 'Café',
          quantity: 1,
          unitPriceCents: 10000,
          discountCents: 0,
          objetoImp: '02',
          taxes: [
            {
              type: 'IVA',
              factor: 'Tasa',
              rate: 0.16,
              withholding: false,
            },
          ],
          taxIncluded: true,
        },
        {
          satProductKey: '84111506',
          satUnitKey: 'ACT',
          description: 'Propina de barra',
          quantity: 1,
          unitPriceCents: 5000,
          discountCents: 0,
          objetoImp: '01',
          taxes: [],
          taxIncluded: true,
        },
      ],
      formaPago: '04',
      metodoPago: 'PUE',
      serie: 'F',
      idempotencyKey: 'cfdi-order-o1',
    },
    guardado: {
      subtotalCents: 13621,
      taxCents: 1379,
      totalCents: 15000,
    },
    status: 'VALIDATION_FAILED',
    motivos: [
      'La cuenta lleva un descuento general sobre varios artículos o extras; la facturación de descuentos generales llega en la siguiente versión.',
    ],
  },
}

const GOLDEN_REPARTO_DOS_TASAS = [
  'La cuenta lleva un descuento general y productos con IVA distinto; el reparto del descuento entre tasas no está soportado todavía.',
]

describe('golden de la rama todo-16 (idénticas al código anterior a la tarea)', () => {
  it.each(Object.keys(GOLDEN))('%s: mismo payload, mismos montos guardados, mismos motivos', async nombre => {
    expect(await resultadoDe(CASOS[nombre])).toEqual(GOLDEN[nombre])
  })

  it('reparto del descuento general entre dos TASAS (entrada legacy, sin tratamiento): mismo motivo', () => {
    const { motivos } = repartirDescuentoDeOrden(
      [
        { productName: 'A', quantity: 1, unitPrice: D(100), discountAmount: D(0), product: { taxRate: D(0.16), objetoImp: '02' } },
        { productName: 'B', quantity: 1, unitPrice: D(50), discountAmount: D(0), product: { taxRate: D(0), objetoImp: '01' } },
      ] as RenglonParaCfdi[],
      1000,
    )
    expect(motivos).toEqual(GOLDEN_REPARTO_DOS_TASAS)
  })

  it('las órdenes todo-16 se clasifican TODO_16 y cada renglón lleva IVA_16 (la venta sin renglones también)', async () => {
    for (const nombre of ['extras', 'peso', 'descuentoRenglon', 'sinRenglones', 'ivaSeparado']) {
      orderMock.mockResolvedValue(CASOS[nombre])
      cfgMock.mockResolvedValue(CONFIG)
      const bundle = await loadOrderForCfdiFromDb('o1')
      expect(bundle!.order.clasificacion).toBe('TODO_16')
      for (const it of bundle!.order.items) expect(it.tratamiento).toBe('IVA_16')
    }
  })
})

// ─── Rama mixta ─────────────────────────────────────────────────────────────────────────────────────
const TASA_16 = [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }]
const TASA_0 = [{ type: 'IVA', factor: 'Tasa', rate: 0, withholding: false }]
const EXENTO = [{ type: 'IVA', factor: 'Exento', rate: 0, withholding: false }]

const MOTIVO_CONTRATO =
  'Esta venta tiene productos con IVA distinto de 16 % y no consta que se cobró con IVA incluido; confírmalo antes de facturar.'
const MOTIVO_LIQUIDACION =
  'Esta venta tiene productos con IVA distinto de 16 % y no está pagada por completo; se factura cuando se liquide.'
const MOTIVO_OBJETO_04 =
  'Hay un producto con objeto de impuesto 04, que la facturación todavía no soporta; corrígelo en el producto antes de facturar.'

const cafe = () => renglon({ id: 'oi-cafe', productName: 'Latte', unitPrice: D(100), total: D(100), product: producto({ name: 'Latte' }) })
const conTratamiento = (t: string, nombre: string, precio: number, over: Record<string, any> = {}) =>
  renglon({
    id: `oi-${nombre}`,
    productName: nombre,
    unitPrice: D(precio),
    total: D(precio),
    product: producto({
      name: nombre,
      ivaTratamiento: t,
      taxRate: D(t === 'IVA_16' || t.startsWith('BLOQUEADO') ? 0.16 : 0),
      objetoImp: t === 'BLOQUEADO_04' ? '04' : t === 'NO_OBJETO' ? '01' : '02',
    }),
    ...over,
  })

describe('rama mixta (algún renglón ≠ IVA_16)', () => {
  it('IVA_0 + contrato IVA_INCLUIDO + PAID: sin motivos; concepto 02 con traslado Tasa 0, IVA incluido', async () => {
    const r = await resultadoDe(orden(150, { items: [cafe(), conTratamiento('IVA_0', 'Café en grano', 50)] }))
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(i => [i.description, i.objetoImp, i.taxes, i.taxIncluded])).toEqual([
      ['Latte', '02', TASA_16, true],
      ['Café en grano', '02', TASA_0, true],
    ])
    // El 16 % sale del Latte; el grano no carga IVA. Total = lo cobrado.
    expect(r.guardado).toEqual({ subtotalCents: 8621 + 5000, taxCents: 1379, totalCents: 15000 })
  })

  it('la clasificación del bundle es MIXTA y cada renglón trae su tratamiento', async () => {
    orderMock.mockResolvedValue(orden(150, { items: [cafe(), conTratamiento('IVA_0', 'Café en grano', 50)] }))
    cfgMock.mockResolvedValue(CONFIG)
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.order.clasificacion).toBe('MIXTA')
    expect(bundle!.order.items.map(i => i.tratamiento)).toEqual(['IVA_16', 'IVA_0'])
    expect(bundle!.unsupportedReasons).toBeUndefined()
  })

  it('EXENTO: concepto 02 con factor Exento, sin tasa', async () => {
    const r = await resultadoDe(orden(150, { items: [cafe(), conTratamiento('EXENTO', 'Libro', 50)] }))
    expect(r.motivos).toEqual([])
    expect(r.payload.items[1]).toMatchObject({ description: 'Libro', objetoImp: '02', taxes: EXENTO, taxIncluded: true })
  })

  it('los extras con precio heredan el tratamiento del renglón padre', async () => {
    const grano = conTratamiento('IVA_0', 'Café en grano', 50, {
      total: D(55),
      modifiers: [{ name: 'Molido', price: D(5), quantity: 1 }],
    })
    const r = await resultadoDe(orden(155, { items: [cafe(), grano] }))
    expect(r.motivos).toEqual([])
    expect(r.payload.items.map(i => [i.description, i.taxes])).toEqual([
      ['Latte', TASA_16],
      ['Café en grano', TASA_0],
      ['Molido (Café en grano)', TASA_0],
    ])
  })

  it('el SELLO manda: renglón sellado IVA_16 con producto hoy en IVA_0 sale al 16 %', async () => {
    const sellado = conTratamiento('IVA_0', 'Café en grano', 100, { ivaTratamiento: 'IVA_16' })
    orderMock.mockResolvedValue(orden(100, { items: [sellado] }))
    cfgMock.mockResolvedValue(CONFIG)
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.order.clasificacion).toBe('TODO_16')
    const r = await resultadoDe(orden(100, { items: [sellado] }))
    expect(r.motivos).toEqual([])
    expect(r.payload.items[0]).toMatchObject({ objetoImp: '02', taxes: TASA_16 })
    expect(r.guardado).toEqual({ subtotalCents: 8621, taxCents: 1379, totalCents: 10000 })
  })

  it('el SELLO manda también al revés: sellado IVA_0 con producto hoy en IVA_16 sale a tasa 0', async () => {
    const sellado = renglon({ id: 'oi-x', productName: 'Latte', ivaTratamiento: 'IVA_0', unitPrice: D(100), total: D(100) })
    const r = await resultadoDe(orden(100, { items: [sellado] }))
    expect(r.motivos).toEqual([])
    expect(r.payload.items[0]).toMatchObject({ objetoImp: '02', taxes: TASA_0, taxIncluded: true })
    expect(r.guardado).toEqual({ subtotalCents: 10000, taxCents: 0, totalCents: 10000 })
  })

  it('mixta con contrato DESCONOCIDO ⇒ motivo del contrato, no se timbra', async () => {
    const r = await resultadoDe(orden(150, { contratoDePrecio: 'DESCONOCIDO', items: [cafe(), conTratamiento('IVA_0', 'Grano', 50)] }))
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([MOTIVO_CONTRATO])
  })

  it('mixta con contrato IVA_APARTE ⇒ motivo del contrato', async () => {
    const r = await resultadoDe(orden(150, { contratoDePrecio: 'IVA_APARTE', items: [cafe(), conTratamiento('EXENTO', 'Libro', 50)] }))
    expect(r.motivos).toEqual([MOTIVO_CONTRATO])
  })

  it('mixta con paymentStatus PENDING ⇒ motivo de liquidación, no se timbra', async () => {
    const r = await resultadoDe(orden(150, { paymentStatus: 'PENDING', items: [cafe(), conTratamiento('IVA_0', 'Grano', 50)] }))
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([MOTIVO_LIQUIDACION])
  })

  it('mixta sin contrato y sin liquidar ⇒ los dos motivos', async () => {
    const r = await resultadoDe(
      orden(150, { contratoDePrecio: 'DESCONOCIDO', paymentStatus: 'PARTIAL', items: [cafe(), conTratamiento('IVA_0', 'Grano', 50)] }),
    )
    expect(r.motivos).toEqual([MOTIVO_CONTRATO, MOTIVO_LIQUIDACION])
  })

  it('producto BLOQUEADO_04 ⇒ motivo de objeto de impuesto (una sola vez), no se timbra', async () => {
    const r = await resultadoDe(
      orden(200, { items: [conTratamiento('BLOQUEADO_04', 'Servicio A', 100), conTratamiento('BLOQUEADO_04', 'Servicio B', 100)] }),
    )
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([MOTIVO_OBJETO_04])
  })

  it('con contrato IVA_INCLUIDO la mixta manda precios con IVA incluido aunque taxAmount > 0 (el contrato gana a la heurística)', async () => {
    const r = await resultadoDe(orden(150, { taxAmount: D(13.79), items: [cafe(), conTratamiento('IVA_0', 'Grano', 50)] }))
    expect(r.motivos).toEqual([])
    expect(r.payload.items.every(i => i.taxIncluded === true)).toBe(true)
    expect(r.guardado).toEqual({ subtotalCents: 13621, taxCents: 1379, totalCents: 15000 })
  })

  it('la barrera «documento = cobrado» sigue bloqueando una mixta que no cuadra', async () => {
    const caso = orden(150, { items: [cafe(), conTratamiento('IVA_0', 'Grano', 50)] })
    caso.payments[0].amount = D(140)
    const r = await resultadoDe(caso)
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([
      'El total de la factura ($150.00) no coincide con lo cobrado ($140.00). No se timbró; revisa la cuenta o repórtala a soporte.',
    ])
  })

  it('con tratamiento, tasa 0 + objeto 02 NO es ambiguo (IVA_0 y EXENTO son válidos)', async () => {
    for (const t of ['IVA_0', 'EXENTO']) {
      const r = await resultadoDe(orden(50, { items: [conTratamiento(t, 'Grano', 50)] }))
      expect(r.motivos).toEqual([])
    }
  })
})

describe('repartirDescuentoDeOrden agrupa por tratamiento', () => {
  const concepto = (t: string, precio: number): RenglonParaCfdi => ({
    productName: t,
    quantity: 1,
    unitPrice: D(precio),
    discountAmount: D(0),
    tratamiento: t as any,
    product: { taxRate: D(0), objetoImp: '02' },
  })

  it('IVA_0 y EXENTO son grupos DISTINTOS aunque los dos tengan tasa 0 ⇒ motivo', () => {
    const { motivos } = repartirDescuentoDeOrden([concepto('IVA_0', 100), concepto('EXENTO', 50)], 1000)
    expect(motivos).toEqual([
      'La cuenta lleva un descuento general y productos con IVA distinto; el reparto del descuento entre tasas no está soportado todavía.',
    ])
  })

  it('mismo tratamiento ⇒ reparte en proporción, sin motivo', () => {
    const { items, motivos } = repartirDescuentoDeOrden([concepto('IVA_0', 100), concepto('IVA_0', 50)], 1500)
    expect(motivos).toEqual([])
    expect(items.map(i => Number(i.discountAmount))).toEqual([10, 5])
  })
})

describe('resolveItem con tratamiento', () => {
  const base = {
    description: 'X',
    quantity: 1,
    unitPriceCents: 10000,
    discountCents: 0,
    taxRate: 0.16,
    taxExempt: false,
    taxIncluded: true,
    satProductKey: '90101501',
    satUnitKey: 'H87',
    categoryDefaultProductKey: null,
    categoryDefaultUnitKey: null,
    objetoImp: '02',
  }
  const params = (items: any[]) =>
    buildCreateInvoiceParams({
      venueType: 'RESTAURANT' as any,
      receptor,
      paymentMethod: 'CREDIT_CARD' as any,
      metodoPago: 'PUE',
      idempotencyKey: 'k',
      items,
    })

  it('IVA_16 produce EXACTAMENTE el mismo concepto que sin tratamiento', () => {
    expect(params([{ ...base, tratamiento: 'IVA_16' }]).items).toEqual(params([base]).items)
  })

  it('NO_OBJETO ⇒ objeto 01 sin traslados', () => {
    const [it] = params([{ ...base, taxRate: 0, taxExempt: true, objetoImp: '01', tratamiento: 'NO_OBJETO' }]).items
    expect(it).toMatchObject({ objetoImp: '01', taxes: [] })
  })

  it('un tratamiento bloqueado nunca llega al PAC: lanza con el motivo', () => {
    expect(() => params([{ ...base, objetoImp: '04', tratamiento: 'BLOQUEADO_04' }])).toThrow(MOTIVO_OBJETO_04)
  })
})
