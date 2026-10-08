import { withIssueTransaction } from '../../../__helpers__/issue-cfdi-transaction'
// tests/unit/services/fiscal/cfdiConceptosPorTratamiento.test.ts
// Plan 3 (IVA por producto), Tarea 3: conceptos por tratamiento.
//
// 🔴 La primera mitad son GOLDEN de la rama todo-16: se capturaron con el código ANTERIOR a la tarea
// (commit 0e5c7c40) y fijan, por orden, el payload al PAC, los montos que se guardan en la fila y los
// motivos. En producción todo es IVA_16 mientras la bandera esté apagada: si una golden cambia, el
// defecto es del cambio, nunca de la golden.
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
  reconstruirConceptos,
  RenglonParaCfdi,
  MOTIVO_CONTRATO_DESCONOCIDO,
  MOTIVO_IVA_APARTE,
  MOTIVO_OCHO_SIN_REGLA,
  MOTIVO_TODO_CORTESIA,
  trasladoParaElPac,
} from '../../../../src/services/fiscal/cfdi.service'
import { MOTIVO_SIN_REPARTO_IVA_MEZCLADO, reduccionDeImpuestoCobrado } from '../../../../src/services/shared/repartoDescuento'
import { MAX_CENTAVOS_DE_REDONDEO, motivoNoCuadra } from '../../../../src/services/fiscal/reglaDelPac'
import { MOTIVO_DESCUENTOS_NO_CUADRAN, MOTIVO_REPARTO_FUERA_DE_LA_CUENTA } from '../../../../src/services/fiscal/descuentoPorRenglon'
import { assembleSaleInput } from '../../../../src/services/fiscal/assembleSaleInput'
import { buildCreateInvoiceParams } from '../../../../src/services/fiscal/cfdiPayloadBuilder'
import { D, receptor, CONFIG, producto, renglon, orden, CASOS } from './fixtures/ivaPorProductoGoldenOrders'

const orderMock = prisma.order.findUnique as jest.Mock
const cfgMock = prisma.merchantFiscalConfig.findUnique as jest.Mock

function depsDelMotor(createInvoice: jest.Mock): IssueCfdiDeps {
  return withIssueTransaction({
    findExistingCfdi: jest.fn().mockResolvedValue(null),
    reserveCfdi: jest.fn().mockImplementation(async data => ({ id: 'cfdi1', ...data })),
    claimCfdi: jest.fn().mockResolvedValue(true),
    persistArtifacts: jest.fn().mockResolvedValue({}),
    loadOrderForCfdi: (id, opts) => loadOrderForCfdiFromDb(id, opts),
    resolveProvider: jest.fn().mockReturnValue({
      name: 'facturapi',
      createInvoice,
      downloadXml: jest.fn().mockResolvedValue(Buffer.from('<Comprobante/>')),
      downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
    } as any),
    storeArtifact: jest.fn().mockImplementation(async (_b, path) => `https://cdn/${path}`),
    persistCfdi: jest.fn().mockImplementation(async data => ({ id: 'cfdi1', ...data })),
  })
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
    expect(createInvoice).toHaveBeenCalledWith({ ...payload, idempotencyKey: 'cfdi-order-o1#1', externalId: 'cfdi-order-o1#1' })
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
    // 🔴 B3a (1-oct, spec §4.2 + D8): cambia A PROPÓSITO sólo el motivo. Ya no se bloquea «por varios artículos» (H7): el
    // descuento no consta por producto y mezcla 16 % con «no objeto», así que D8 lo detiene con SU motivo. Payload y montos,
    // idénticos a la captura de 0e5c7c40.
    motivos: [MOTIVO_SIN_REPARTO_IVA_MEZCLADO],
  },
}

describe('golden de la rama todo-16 (idénticas al código anterior a la tarea)', () => {
  it.each(Object.keys(GOLDEN))('%s: mismo payload, mismos montos guardados, mismos motivos', async nombre => {
    expect(await resultadoDe(CASOS[nombre])).toEqual(GOLDEN[nombre])
  })

  it('descuento general entre dos TASAS sin constancia (entrada legacy): D8 lo detiene con su motivo (antes, H7)', () => {
    const { motivos } = reconstruirConceptos(
      {
        discountAmount: D(10),
        items: [
          {
            id: 'a',
            productName: 'A',
            quantity: 1,
            unitPrice: D(100),
            discountAmount: D(0),
            total: D(100),
            product: { taxRate: D(0.16), objetoImp: '02' },
          },
          {
            id: 'b',
            productName: 'B',
            quantity: 1,
            unitPrice: D(50),
            discountAmount: D(0),
            total: D(50),
            product: { taxRate: D(0), objetoImp: '01' },
          },
        ] as RenglonParaCfdi[],
      },
      'o1',
    )
    expect(motivos).toEqual([MOTIVO_SIN_REPARTO_IVA_MEZCLADO])
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
  it('caso Mavericks: café al 0 % + contrato confirmado ⇒ un concepto de $6,040 con $2,958 de descuento, al 0 %', async () => {
    const grano = conTratamiento('IVA_0', 'GRN TURISMO 2 KG', 6040)
    const r = await resultadoDe(orden(3082, { contratoDePrecio: 'IVA_INCLUIDO', discountAmount: D(2958), items: [grano] }))
    expect(r.motivos).toEqual([])
    expect(r.payload.items).toHaveLength(1)
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items[0]).toMatchObject({
      objetoImp: '02',
      taxes: TASA_0,
      taxIncluded: true,
      unitPriceCents: 604000,
      discountCents: 295800,
    })
    // el cargador guarda la base DESPUÉS del descuento (cfdi.service.ts:1604): a tasa 0, subtotal = total = $3,082
    expect(r.guardado).toEqual({ subtotalCents: 308200, taxCents: 0, totalCents: 308200 })
  })

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

  it('mixta con contrato DESCONOCIDO ⇒ el motivo pide confirmarlo, no se timbra', async () => {
    const r = await resultadoDe(orden(150, { contratoDePrecio: 'DESCONOCIDO', items: [cafe(), conTratamiento('IVA_0', 'Grano', 50)] }))
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([MOTIVO_CONTRATO_DESCONOCIDO])
    expect(MOTIVO_CONTRATO_DESCONOCIDO).toBe(MOTIVO_CONTRATO) // regresión: el texto de hoy no cambia
  })

  // B3b, Tarea 1: una venta que separó el IVA al cobrar no se confirma (§4.2). Antes compartía el texto de
  // «confírmalo» con la DESCONOCIDA y mandaba al dueño a una confirmación que el servidor iba a rechazar.
  it('mixta con contrato IVA_APARTE ⇒ motivo propio, que NO ofrece confirmar', async () => {
    const r = await resultadoDe(orden(150, { contratoDePrecio: 'IVA_APARTE', items: [cafe(), conTratamiento('EXENTO', 'Libro', 50)] }))
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([MOTIVO_IVA_APARTE])
    expect(MOTIVO_IVA_APARTE).not.toMatch(/confírmalo/i)
    // Dice qué hacer (a quién acudir), no sólo que no se puede.
    expect(MOTIVO_IVA_APARTE).toMatch(/soporte/i)
    expect(MOTIVO_IVA_APARTE).toMatch(/IVA aparte/)
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

  it('producto BLOQUEADO_04 repetido (mismo producto dos veces) ⇒ un motivo CON el nombre, una sola vez, no se timbra', async () => {
    const r = await resultadoDe(
      orden(200, { items: [conTratamiento('BLOQUEADO_04', 'Servicio', 100), conTratamiento('BLOQUEADO_04', 'Servicio', 100)] }),
    )
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([`«Servicio»: ${MOTIVO_OBJETO_04}`])
  })

  // R5b (regresión de la Tarea 3): el motivo de un renglón bloqueado debe nombrar el PRODUCTO, como
  // hacía el mensaje legacy («<Nombre>: objeto de impuesto N no soportado»), no sólo el objeto genérico.
  it('el motivo de un renglón BLOQUEADO nombra el producto', async () => {
    const r = await resultadoDe(orden(100, { items: [conTratamiento('BLOQUEADO_03', 'Servicio raro', 100)] }))
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([
      '«Servicio raro»: Hay un producto con objeto de impuesto 03, que la facturación todavía no soporta; corrígelo en el producto antes de facturar.',
    ])
  })

  // R5b: con un renglón bloqueado, la mixta NO debe además enseñar los motivos de contrato/liquidación
  // (nunca se timbraría de todos modos; el único motivo útil es corregir el producto bloqueado).
  it('con un renglón bloqueado, la mixta muestra SÓLO el motivo del bloqueo (no también contrato/liquidación)', async () => {
    const r = await resultadoDe(
      orden(100, {
        contratoDePrecio: 'DESCONOCIDO',
        paymentStatus: 'PENDING',
        items: [conTratamiento('BLOQUEADO_04', 'Servicio', 100)],
      }),
    )
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([`«Servicio»: ${MOTIVO_OBJETO_04}`])
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

describe('D8 (descuento sin constancia) agrupa por tratamiento', () => {
  const r = (t: string, id: string, precio: number): RenglonParaCfdi =>
    ({
      id,
      productName: t,
      quantity: 1,
      unitPrice: D(precio),
      discountAmount: D(0),
      total: D(precio),
      tratamiento: t as any,
      product: { taxRate: D(0), objetoImp: '02' },
    }) as RenglonParaCfdi

  it('IVA_0 y EXENTO son grupos DISTINTOS aunque los dos tengan tasa 0 ⇒ motivo', () => {
    expect(reconstruirConceptos({ discountAmount: D(10), items: [r('IVA_0', 'a', 100), r('EXENTO', 'b', 50)] }, 'o1').motivos).toEqual([
      MOTIVO_SIN_REPARTO_IVA_MEZCLADO,
    ])
  })

  it('mismo tratamiento ⇒ reparte en proporción, sin motivo', () => {
    const { items, motivos } = reconstruirConceptos({ discountAmount: D(15), items: [r('IVA_0', 'a', 100), r('IVA_0', 'b', 50)] }, 'o1')
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

// ─── Bloque B3a: dentro del renglón, entre producto y extras, se conserva el repartidor de hoy (founder, 1-oct; Codex r1 #1) ───
describe('B3a · el descuento del renglón entre producto y extras (controles de regresión)', () => {
  const capuccino = (descuento: number) =>
    renglon({
      id: 'oi-cap',
      productName: 'CAPUCCINO',
      unitPrice: D(65),
      total: D(70),
      discountAmount: D(descuento),
      modifiers: [{ name: 'Deslactosada', price: D(5), quantity: 1 }],
      product: producto({ name: 'CAPUCCINO' }),
    })

  it('🔴 control — precios SIN IVA: $65 + $5 con $1.11 de descuento propio ⇒ 1.04 y 0.07 y el documento da $79.91 (con el proporcional daría $79.92 y se bloquearía)', async () => {
    const r = await resultadoDe(
      orden(79.91, {
        subtotal: D(68.89),
        taxAmount: D(11.02),
        total: D(79.91),
        discountAmount: D(1.11),
        contratoDePrecio: 'IVA_APARTE',
        items: [capuccino(1.11)],
      }),
    )
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map((i: any) => [i.description, i.unitPriceCents, i.discountCents, i.taxIncluded])).toEqual([
      ['CAPUCCINO', 6500, 104, false],
      ['Deslactosada (CAPUCCINO)', 500, 7, false],
    ])
    expect(r.guardado).toEqual({ subtotalCents: 6889, taxCents: 1102, totalCents: 7991 })
  })

  it('control — precios con IVA: $2.50 de descuento propio sobre $65 + $5 ⇒ el PAC daría $67.49 ⇒ 2.32 y 0.17 (6b)', async () => {
    const r = await resultadoDe(orden(67.5, { discountAmount: D(2.5), items: [capuccino(2.5)] }))
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map((i: any) => [i.description, i.discountCents])).toEqual([
      ['CAPUCCINO', 232],
      ['Deslactosada (CAPUCCINO)', 17],
    ])
    expect(r.guardado).toEqual({ subtotalCents: 5819, taxCents: 931, totalCents: 6750 })
  })

  it('🔴 6b, el del founder: $65 con $2.50 propios — el PAC daría $62.49 ⇒ sale con 2.49 y se guarda lo que dirá el XML', async () => {
    const r = await resultadoDe(
      orden(62.5, {
        discountAmount: D(2.5),
        items: [
          renglon({
            id: 'oi-cafe',
            productName: 'Latte',
            unitPrice: D(65),
            total: D(65),
            discountAmount: D(2.5),
            product: producto({ name: 'Latte' }),
          }),
        ],
      }),
    )
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([['Latte', 249]])
    expect(r.guardado).toEqual({ subtotalCents: 5388, taxCents: 862, totalCents: 6250 })
  })

  it('6b, Codex r1 #1b de punta a punta: Latte $10 con $0.18 + Grano al 0 % de $50 ⇒ 0.17 y 0.01', async () => {
    const r = await resultadoDe(
      orden(59.82, {
        discountAmount: D(0.18),
        items: [
          renglon({
            id: 'oi-cafe',
            productName: 'Latte',
            unitPrice: D(10),
            total: D(10),
            discountAmount: D(0.18),
            product: producto({ name: 'Latte' }),
          }),
          grano(),
        ],
      }),
    )
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([
      ['Latte', 17],
      ['Grano', 1],
    ])
    // SubTotal 58.62 − Descuento 0.16 = base 58.46.
    expect(r.guardado).toEqual({ subtotalCents: 5846, taxCents: 136, totalCents: 5982 })
  })

  it('6b, 8 % que hoy se timbra: $65 con $2.50 al 8 % — el modelo da $62.51 y el 8 % no se ajusta ⇒ se detiene', async () => {
    const r = await resultadoDe(
      orden(62.5, { discountAmount: D(2.5), items: [conTratamiento('IVA_8', 'Ocho', 65, { discountAmount: D(2.5) })] }),
    )
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([MOTIVO_OCHO_SIN_REGLA])
  })

  it('control — los extras con precio siguen repartiendo exacto (cantidad × precio de cada extra)', async () => {
    const r = await resultadoDe(CASOS.extras)
    expect(r.payload.items.map((i: any) => [i.description, i.unitPriceCents])).toEqual([
      ['CAPUCCINO (Canela)', 6500],
      ['Deslactosada (CAPUCCINO)', 1000],
      ['Pan dulce', 3500],
    ])
  })
})

// ─── Bloque B3a (spec §4.2, D7, D8): la factura lee el reparto guardado por quien calculó cada descuento ──────────────────
const cuenta = (renglones: Record<string, number>) => ({ v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones })
const dirigido = (renglones: Record<string, number>) => ({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones })
const espejo = (renglones: Record<string, number>) => ({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones })
const grano = () => conTratamiento('IVA_0', 'Grano', 50)
const pan = (over: Record<string, any> = {}) => conTratamiento('IVA_16', 'Pan', 50, over)
const conDescuentos = (i: { description: string; discountCents: number }) => [i.description, i.discountCents]

describe('B3a · descuentos de la cuenta', () => {
  it('E1 🔴 el reparto se LEE tal cual: $10 guardados como 7 y 3 salen 7 y 3 (no 5 y 5)', async () => {
    const r = await resultadoDe(
      orden(190, {
        discountAmount: D(10),
        orderDiscounts: [{ amount: D(10), reparto: cuenta({ 'oi-A': 700, 'oi-B': 300 }) }],
        items: [conTratamiento('IVA_16', 'A', 100), conTratamiento('IVA_16', 'B', 100)],
      }),
    )
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([
      ['A', 700],
      ['B', 300],
    ])
    expect(r.guardado).toEqual({ subtotalCents: 16379, taxCents: 2621, totalCents: 19000 })
  })

  it('E2 IVA mezclado CON reparto ⇒ se factura y cada tasa lleva lo suyo', async () => {
    const r = await resultadoDe(
      orden(135, {
        discountAmount: D(15),
        orderDiscounts: [{ amount: D(15), reparto: cuenta({ 'oi-cafe': 1000, 'oi-Grano': 500 }) }],
        items: [cafe(), grano()],
      }),
    )
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(i => [i.description, i.discountCents, i.taxes])).toEqual([
      ['Latte', 1000, TASA_16],
      ['Grano', 500, TASA_0],
    ])
    expect(r.guardado).toEqual({ subtotalCents: 12259, taxCents: 1241, totalCents: 13500 })
  })

  it('E2b IVA mezclado con EXENTO y reparto ⇒ pasa la barrera del PAC (Exento no suma impuesto) y se factura', async () => {
    const r = await resultadoDe(
      orden(135, {
        discountAmount: D(15),
        orderDiscounts: [{ amount: D(15), reparto: cuenta({ 'oi-cafe': 1000, 'oi-Libro': 500 }) }],
        items: [cafe(), conTratamiento('EXENTO', 'Libro', 50)],
      }),
    )
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(i => [i.description, i.discountCents, i.taxes])).toEqual([
      ['Latte', 1000, TASA_16],
      ['Libro', 500, EXENTO],
    ])
    expect(r.guardado).toEqual({ subtotalCents: 12259, taxCents: 1241, totalCents: 13500 })
  })

  it('trasladoParaElPac: el mismo traslado que arma resolveItem (Exento, Tasa, no objeto y legacy)', () => {
    const it_ = (o: Record<string, any>) =>
      ({ productName: 'X', quantity: 1, unitPrice: D(1), discountAmount: D(0), ...o }) as RenglonParaCfdi
    expect(trasladoParaElPac(it_({ tratamiento: 'EXENTO', product: { taxRate: D(0) } }))).toEqual({ factor: 'Exento' })
    expect(trasladoParaElPac(it_({ tratamiento: 'IVA_0', product: { taxRate: D(0) } }))).toEqual({ factor: 'Tasa', tasa: 0 })
    expect(trasladoParaElPac(it_({ tratamiento: 'NO_OBJETO', product: { taxRate: D(0) } }))).toBeNull()
    expect(trasladoParaElPac(it_({ product: { taxRate: D(0), objetoImp: '01' } }))).toBeNull()
    expect(trasladoParaElPac(it_({ product: null }))).toEqual({ factor: 'Tasa', tasa: 0.16 })
  })

  it('E3 un descuento dirigido al artículo al 0 % no toca el 16 %', async () => {
    const r = await resultadoDe(
      orden(145, {
        discountAmount: D(5),
        orderDiscounts: [{ amount: D(5), reparto: dirigido({ 'oi-Grano': 500 }) }],
        items: [cafe(), grano()],
      }),
    )
    expect(r.payload.items.map(conDescuentos)).toEqual([
      ['Latte', 0],
      ['Grano', 500],
    ])
    expect(r.guardado).toEqual({ subtotalCents: 13121, taxCents: 1379, totalCents: 14500 })
  })

  it('E4 una fila espejo no se cuenta dos veces', async () => {
    const r = await resultadoDe(
      orden(123, {
        discountAmount: D(27),
        orderDiscounts: [
          { amount: D(20), reparto: espejo({ 'oi-cafe': 2000 }) },
          { amount: D(7), reparto: cuenta({ 'oi-cafe': 400, 'oi-Pan': 300 }) },
        ],
        items: [{ ...cafe(), discountAmount: D(20) }, pan()],
      }),
    )
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([
      ['Latte', 2400],
      ['Pan', 300],
    ])
    // Ronda final F1: se guarda lo que dirá el XML (subtotal 129.31 − descuento 23.28, IVA 16.97); antes, la suma por concepto 10604 / 1696.
    expect(r.guardado).toEqual({ subtotalCents: 10603, taxCents: 1697, totalCents: 12300 })
  })

  it('E5 sin constancia y un solo IVA (D8) ⇒ en proporción', async () => {
    const r = await resultadoDe(
      orden(90, { discountAmount: D(10), items: [conTratamiento('IVA_16', 'A', 60), conTratamiento('IVA_16', 'B', 40)] }),
    )
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([
      ['A', 600],
      ['B', 400],
    ])
    // Ronda final F1: lo que dirá el XML (subtotal 86.21 − descuento 8.62, IVA 12.41); antes, la suma por concepto 7758 / 1242.
    expect(r.guardado).toEqual({ subtotalCents: 7759, taxCents: 1241, totalCents: 9000 })
  })

  it('E6 sin constancia e IVA mezclado (D8) ⇒ su motivo, no se timbra', async () => {
    const r = await resultadoDe(orden(135, { discountAmount: D(15), items: [cafe(), grano()] }))
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([MOTIVO_SIN_REPARTO_IVA_MEZCLADO])
  })

  it('E7 un reparto sobre un renglón que ya no está ⇒ su motivo (no «no coincide»)', async () => {
    const r = await resultadoDe(
      orden(140, {
        discountAmount: D(10),
        orderDiscounts: [{ amount: D(10), reparto: cuenta({ 'oi-borrado': 1000 }) }],
        items: [cafe(), pan()],
      }),
    )
    expect(r.motivos).toEqual([MOTIVO_REPARTO_FUERA_DE_LA_CUENTA])
  })

  it('E8 lo que consta suma más que la cabecera ⇒ su motivo', async () => {
    const r = await resultadoDe(
      orden(145, {
        discountAmount: D(5),
        orderDiscounts: [{ amount: D(10), reparto: cuenta({ 'oi-cafe': 1000 }) }],
        items: [cafe(), pan()],
      }),
    )
    expect(r.motivos).toEqual([MOTIVO_DESCUENTOS_NO_CUADRAN])
  })

  it('E9 orden de antes de B2 recalculada después: lo que consta exacto, la fila vieja por D8 sobre lo que queda', async () => {
    const r = await resultadoDe(
      orden(184, {
        discountAmount: D(16),
        orderDiscounts: [
          { amount: D(10), reparto: cuenta({ 'oi-A': 1000 }) },
          { amount: D(6), reparto: null },
        ],
        items: [conTratamiento('IVA_16', 'A', 100), conTratamiento('IVA_16', 'B', 100)],
      }),
    )
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([
      ['A', 1284],
      ['B', 316],
    ])
  })

  it('E10 premio FREE_PRODUCT dirigido a un renglón de dos unidades con extra: cuadra al centavo', async () => {
    const cap = renglon({
      id: 'oi-cap',
      productName: 'CAPUCCINO',
      quantity: 2,
      unitPrice: D(65),
      total: D(140),
      modifiers: [{ name: 'Deslactosada', price: D(5), quantity: 1 }],
      product: producto({ name: 'CAPUCCINO' }),
    })
    const r = await resultadoDe(
      orden(75, { discountAmount: D(65), orderDiscounts: [{ amount: D(65), reparto: dirigido({ 'oi-cap': 6500 }) }], items: [cap] }),
    )
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([
      ['CAPUCCINO', 6036],
      ['Deslactosada (CAPUCCINO)', 464],
    ])
    // Ronda final F1: lo que dirá el XML; antes, la suma por concepto 6465 / 1035. El total no cambia.
    expect(r.guardado).toEqual({ subtotalCents: 6466, taxCents: 1034, totalCents: 7500 })
  })

  it('E11 un reparto que no cupo entero (B2): lo que guarda va a su renglón y lo que falta por D8', async () => {
    // $10 guardados sólo como $5 en A: A lleva 5 + 2.44 y B 2.56 (D8 sobre 95 y 100).
    const r = await resultadoDe(
      orden(190, {
        discountAmount: D(10),
        orderDiscounts: [{ amount: D(10), reparto: cuenta({ 'oi-A': 500 }) }],
        items: [conTratamiento('IVA_16', 'A', 100), conTratamiento('IVA_16', 'B', 100)],
      }),
    )
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([
      ['A', 744],
      ['B', 256],
    ])
  })

  it('E12 una venta desbloqueada por B3a que lleva 8 % (frontera) se detiene: su regla no está comprobada (Codex r3 R3-2)', async () => {
    const r = await resultadoDe(
      orden(135, {
        discountAmount: D(15),
        orderDiscounts: [{ amount: D(15), reparto: cuenta({ 'oi-cafe': 1000, 'oi-Ocho': 500 }) }],
        items: [cafe(), conTratamiento('IVA_8', 'Ocho', 50)],
      }),
    )
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([MOTIVO_OCHO_SIN_REGLA])
  })

  it('🔴 6b (revisión Imp-1): desbloqueada al 8 % y el modelo SÍ da lo cobrado ($141.00) ⇒ se detiene igual (lo desbloqueado al 8 % nunca se timbra)', async () => {
    // Latte $100 + Ocho $50 al 8 % con $9 de cuenta repartidos 600 / 300: el modelo del PAC da $141.00 = lo cobrado, así que sólo la
    // marca (`desbloqueado`) la detiene; E12 en cambio da $134.99 y caería también por el total.
    const r = await resultadoDe(
      orden(141, {
        discountAmount: D(9),
        orderDiscounts: [{ amount: D(9), reparto: cuenta({ 'oi-cafe': 600, 'oi-Ocho': 300 }) }],
        items: [cafe(), conTratamiento('IVA_8', 'Ocho', 50)],
      }),
    )
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([MOTIVO_OCHO_SIN_REGLA])
  })
})

describe('B3a · lo que no cobra nada no aparece (D9)', () => {
  it('C1 cortesía de «Cobrar» (total bruto, descuento = total): no aparece y su fila espejo no se cuenta', async () => {
    const r = await resultadoDe(
      orden(100, {
        discountAmount: D(50),
        orderDiscounts: [{ amount: D(50), reparto: espejo({ 'oi-Pan': 5000 }) }],
        items: [cafe(), pan({ discountAmount: D(50), isCortesia: true })],
      }),
    )
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(i => i.description)).toEqual(['Latte'])
    expect(r.guardado).toEqual({ subtotalCents: 8621, taxCents: 1379, totalCents: 10000 })
  })

  it('C2 cortesía del móvil (total 0) de un artículo al 0 % en una venta mixta: no aparece y la factura sale', async () => {
    const r = await resultadoDe(
      orden(100, { items: [cafe(), conTratamiento('IVA_0', 'Grano', 50, { total: D(0), discountAmount: D(50), isCortesia: true })] }),
    )
    expect(r.motivos).toEqual([])
    expect(r.payload.items.map(i => i.description)).toEqual(['Latte'])
    expect(r.guardado).toEqual({ subtotalCents: 8621, taxCents: 1379, totalCents: 10000 })
  })

  it('C3 todo es cortesía ⇒ su motivo: no hay importe que facturar', async () => {
    const r = await resultadoDe(orden(0, { discountAmount: D(100), items: [{ ...cafe(), discountAmount: D(100), isCortesia: true }] }))
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([MOTIVO_TODO_CORTESIA])
  })

  it('C3b todo es cortesía y además el reparto de la cuenta no cuadra: gana «no hay importe que facturar» (decisión: es el motivo más útil)', async () => {
    const r = await resultadoDe(
      orden(0, {
        discountAmount: D(110),
        orderDiscounts: [{ amount: D(10), reparto: cuenta({ 'oi-cafe': 1000 }) }],
        items: [{ ...cafe(), discountAmount: D(100), isCortesia: true }],
      }),
    )
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([MOTIVO_TODO_CORTESIA])
  })

  it('C4 un producto por revisar regalado sigue deteniendo con su motivo', async () => {
    const r = await resultadoDe(
      orden(100, { items: [conTratamiento('BLOQUEADO_04', 'Servicio', 100, { discountAmount: D(100), isCortesia: true })] }),
    )
    expect(r.motivos).toEqual([`«Servicio»: ${MOTIVO_OBJETO_04}`])
  })

  it('C5 un descuento de cuenta guardado sobre un artículo que después se regaló (datos de antes de B2c) ⇒ su motivo', async () => {
    const r = await resultadoDe(
      orden(90, {
        discountAmount: D(60),
        orderDiscounts: [{ amount: D(10), reparto: cuenta({ 'oi-cafe': 667, 'oi-Pan': 333 }) }],
        items: [cafe(), pan({ discountAmount: D(50), isCortesia: true })],
      }),
    )
    expect(r.motivos).toEqual([MOTIVO_REPARTO_FUERA_DE_LA_CUENTA])
  })

  it('C6 cortesía del móvil con la fila espejo vieja todavía en la cabecera (antes de B2c): lo que sí se descontó va por D8', async () => {
    // El cliente pagó $95: los $5 del espejo que siguió restando van al Latte; no se pierden ni se duplican.
    const r = await resultadoDe(
      orden(95, {
        discountAmount: D(5),
        orderDiscounts: [{ amount: D(5), reparto: espejo({ 'oi-Pan': 500 }) }],
        items: [cafe(), pan({ total: D(0), discountAmount: D(50), isCortesia: true })],
      }),
    )
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([['Latte', 500]])
  })

  it.each([
    ['sin fila espejo (antes de B2c)', []],
    ['con su fila espejo (B2c)', [{ amount: D(80), reparto: espejo({ 'oi-p': 8000 }) }]],
  ])(
    'C7 🔴 promoción $100→$80 regalada después en la terminal, %s: la línea no aparece y la cuenta cuadra',
    async (_caso, orderDiscounts) => {
      const regalada = renglon({
        id: 'oi-p',
        productName: 'Combo',
        unitPrice: D(100),
        total: D(80),
        discountAmount: D(80),
        orderPromotionId: 'op1',
        isCortesia: true,
        product: producto({ name: 'Combo' }),
      })
      const r = await resultadoDe(orden(100, { discountAmount: D(80), orderDiscounts, items: [cafe(), regalada] }))
      expect(r.motivos).toEqual([])
      expect(r.payload.items.map(i => i.description)).toEqual(['Latte'])
      expect(r.guardado).toEqual({ subtotalCents: 8621, taxCents: 1379, totalCents: 10000 })
    },
  )

  it('C8 🔴 un premio que se come un renglón entero: ese concepto no se manda con descuento = importe', async () => {
    const r = await resultadoDe(
      orden(100, {
        discountAmount: D(50),
        orderDiscounts: [{ amount: D(50), reparto: dirigido({ 'oi-Pan': 5000 }) }],
        items: [cafe(), pan()],
      }),
    )
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(i => i.description)).toEqual(['Latte'])
  })

  it('C8b 🔴 m1: 3 × $33.33 que un descuento dirigido se come entero no se manda (se decide en centavos, no sobre la Base de 6 decimales del PAC)', async () => {
    const r = await resultadoDe(
      orden(100, {
        discountAmount: D(99.99),
        orderDiscounts: [{ amount: D(99.99), reparto: dirigido({ 'oi-Pan': 9999 }) }],
        items: [cafe(), pan({ quantity: 3, unitPrice: D(33.33), total: D(99.99) })],
      }),
    )
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(i => i.description)).toEqual(['Latte'])
    expect(r.guardado.totalCents).toBe(10000)
  })

  it('C9 🔴 una cuenta completamente descontada por su descuento de cuenta ⇒ no hay importe que facturar', async () => {
    const r = await resultadoDe(
      orden(0, { discountAmount: D(100), orderDiscounts: [{ amount: D(100), reparto: cuenta({ 'oi-cafe': 10000 }) }], items: [cafe()] }),
    )
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([MOTIVO_TODO_CORTESIA])
  })

  // Codex r2 N1: café $100 + combo $80 regalado después en la terminal + descuento de cuenta de $10. La cabecera trae 80 + 10.
  const regaladaEnTerminal = () =>
    renglon({
      id: 'oi-p',
      productName: 'Combo',
      unitPrice: D(100),
      total: D(80),
      discountAmount: D(80),
      orderPromotionId: 'op1',
      isCortesia: true,
      product: producto({ name: 'Combo' }),
    })

  it('C10 🔴 defensa: si el reparto todavía le da parte a la promoción regalada (B2 sin su arreglo N1), NO se reinterpreta: su motivo', async () => {
    const r = await resultadoDe(
      orden(90, {
        discountAmount: D(90),
        orderDiscounts: [{ amount: D(10), reparto: cuenta({ 'oi-cafe': 556, 'oi-p': 444 }) }],
        items: [cafe(), regaladaEnTerminal()],
      }),
    )
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([MOTIVO_REPARTO_FUERA_DE_LA_CUENTA])
  })

  it('C11 con el reparto que deja B2 al regalar (todo el descuento de cuenta en lo que sí se cobra) se facturan los $90 cobrados', async () => {
    const r = await resultadoDe(
      orden(90, {
        discountAmount: D(90),
        orderDiscounts: [{ amount: D(10), reparto: cuenta({ 'oi-cafe': 1000 }) }],
        items: [cafe(), regaladaEnTerminal()],
      }),
    )
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([['Latte', 1000]])
    expect(r.guardado).toEqual({ subtotalCents: 7759, taxCents: 1241, totalCents: 9000 })
  })

  it('C12 🔴 una venta que B3a desbloquea al quitar una cortesía pasa por la regla del PAC (Codex r3 R3-1): aquí daría $67.49 ⇒ se mueve un centavo (6b)', async () => {
    // CAPUCCINO $65 + extra $5 con $2.50 propios (233/17, como hoy) y un Pan regalado en «Cobrar». Sin la cortesía, el resto sería
    // la variante R5 del sandbox: el PAC redondea subtotal y descuento aparte.
    const cap = renglon({
      id: 'oi-cap',
      productName: 'CAPUCCINO',
      unitPrice: D(65),
      total: D(70),
      discountAmount: D(2.5),
      modifiers: [{ name: 'Deslactosada', price: D(5), quantity: 1 }],
      product: producto({ name: 'CAPUCCINO' }),
    })
    const r = await resultadoDe(orden(67.5, { discountAmount: D(52.5), items: [cap, pan({ discountAmount: D(50), isCortesia: true })] }))
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([
      ['CAPUCCINO', 232],
      ['Deslactosada (CAPUCCINO)', 17],
    ])
    expect(r.guardado).toEqual({ subtotalCents: 5819, taxCents: 931, totalCents: 6750 })
  })

  // Codex r4 R4-1: el filtro final quita un concepto SIN descuento de cuenta, promoción, cortesía ni peso. `repartir` da 6500 / 503
  // (el centavo sobrante va al primer concepto con saldo) y el producto queda en base 0.
  it('C13 🔴 un concepto que el filtro final quita activa la regla del PAC: sin él, el PAC daría $116.00 contra $116.01 ⇒ 5.03 → 5.02 (6b)', async () => {
    const cap = renglon({
      id: 'oi-cap',
      productName: 'CAPUCCINO',
      unitPrice: D(65),
      total: D(70.04),
      discountAmount: D(70.03),
      modifiers: [{ name: 'Deslactosada', price: D(5.04), quantity: 1 }],
      product: producto({ name: 'CAPUCCINO' }),
    })
    const r = await resultadoDe(orden(116.01, { discountAmount: D(70.03), items: [cap, conTratamiento('IVA_16', 'Comida', 116)] }))
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([
      ['Deslactosada (CAPUCCINO)', 502],
      ['Comida', 0],
    ])
    expect(r.guardado).toEqual({ subtotalCents: 10001, taxCents: 1600, totalCents: 11601 })
  })

  it('C14 control de C13: si quitar el concepto conserva el total del PAC, la factura sale sin él por lo cobrado', async () => {
    // Té $11.60 + Miel $5.80 con $17.39 propios ⇒ `repartir` 1160 / 579: el Té queda en base 0 y se quita. Sin él el PAC da
    // 105.00 − 4.99 + 16.00 = $116.01 (variante R6 del sandbox).
    const te = renglon({
      id: 'oi-te',
      productName: 'Té',
      unitPrice: D(11.6),
      total: D(17.4),
      discountAmount: D(17.39),
      modifiers: [{ name: 'Miel', price: D(5.8), quantity: 1 }],
      product: producto({ name: 'Té' }),
    })
    const r = await resultadoDe(orden(116.01, { discountAmount: D(17.39), items: [te, conTratamiento('IVA_16', 'Comida', 116)] }))
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([
      ['Miel (Té)', 579],
      ['Comida', 0],
    ])
    expect(r.guardado.totalCents).toBe(11601)
  })
})

describe('B3a · promociones', () => {
  const combo = (over: Record<string, any> = {}) =>
    renglon({
      id: 'oi-p',
      productName: 'Combo',
      unitPrice: D(100),
      total: D(80),
      discountAmount: D(20),
      orderPromotionId: 'op1',
      product: producto({ name: 'Combo' }),
      ...over,
    })

  it('P1 🔴 (spec §11) promoción $100 → $80 + descuento de cuenta de $10: la promoción lleva $20 y la cuenta reparte exactamente $10', async () => {
    const r = await resultadoDe(
      orden(170, {
        discountAmount: D(10),
        orderDiscounts: [{ amount: D(10), reparto: cuenta({ 'oi-cafe': 556, 'oi-p': 444 }) }],
        items: [cafe(), combo()],
      }),
    )
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(i => [i.description, i.unitPriceCents, i.discountCents])).toEqual([
      ['Latte', 10000, 556],
      ['Combo', 10000, 2444],
    ])
    expect(r.guardado).toEqual({ subtotalCents: 14655, taxCents: 2345, totalCents: 17000 })
  })

  it('P2 una promoción que junta un producto al 16 % y otro al 0 %: cada línea con su parte y su tasa', async () => {
    const r = await resultadoDe(
      orden(120, {
        items: [
          renglon({
            id: 'oi-p1',
            productName: 'Latte',
            unitPrice: D(100),
            total: D(80),
            discountAmount: D(20),
            orderPromotionId: 'op1',
            product: producto({ name: 'Latte' }),
          }),
          conTratamiento('IVA_0', 'Grano', 50, { total: D(40), discountAmount: D(10), orderPromotionId: 'op1' }),
        ],
      }),
    )
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(i => [i.description, i.discountCents, i.taxes])).toEqual([
      ['Latte', 2000, TASA_16],
      ['Grano', 1000, TASA_0],
    ])
    expect(r.guardado).toEqual({ subtotalCents: 10897, taxCents: 1103, totalCents: 12000 })
  })

  it('P3 control: un renglón SIN liga a promoción cuyo total es menor que precio × cantidad sigue detenido', async () => {
    const r = await resultadoDe(
      orden(80, { items: [renglon({ id: 'oi-x', productName: 'Raro', unitPrice: D(100), total: D(80), discountAmount: D(20) })] }),
    )
    expect(r.motivos.join(' ')).toMatch(/menor que precio × cantidad/)
  })

  it('P4 control: una línea de promoción regalada en el móvil (total 0) no aparece', async () => {
    const r = await resultadoDe(orden(100, { items: [cafe(), combo({ total: D(0), discountAmount: D(80), isCortesia: true })] }))
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(i => i.description)).toEqual(['Latte'])
  })

  it('P5 🔴 promoción normal del 50 % (total = descuento, sin cortesía): se factura a precio de lista con su mitad de descuento', async () => {
    const r = await resultadoDe(orden(150, { items: [cafe(), combo({ total: D(50), discountAmount: D(50) })] }))
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(i => [i.description, i.unitPriceCents, i.discountCents])).toEqual([
      ['Latte', 10000, 0],
      ['Combo', 10000, 5000],
    ])
  })

  it('P6 🔴 una venta con promoción la desbloquea B3a, así que pasa por la regla del PAC (Codex r3 R3-1): aquí daría $67.49 ⇒ 2.32 → 2.31 (6b)', async () => {
    // Un combo de $65 + $5 por $67.50: la promoción reparte sus $2.50 proporcional (232/18, `resolvePromotionLines`).
    const r = await resultadoDe(
      orden(67.5, {
        items: [
          renglon({
            id: 'oi-p1',
            productName: 'Combo café',
            unitPrice: D(65),
            total: D(62.68),
            discountAmount: D(2.32),
            orderPromotionId: 'op1',
            product: producto({ name: 'Combo café' }),
          }),
          renglon({
            id: 'oi-p2',
            productName: 'Combo extra',
            unitPrice: D(5),
            total: D(4.82),
            discountAmount: D(0.18),
            orderPromotionId: 'op1',
            product: producto({ name: 'Combo extra' }),
          }),
        ],
      }),
    )
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([
      ['Combo café', 231],
      ['Combo extra', 18],
    ])
    expect(r.guardado).toEqual({ subtotalCents: 5819, taxCents: 931, totalCents: 6750 })
  })
})

describe('B3a · peso con fracción de centavo (D9)', () => {
  const jamonDe = (kilos: number, cobrado: number) =>
    renglon({
      id: 'oi-jamon',
      productName: 'Jamón',
      weightQuantity: D(kilos),
      unitPrice: D(45),
      total: D(cobrado),
      product: producto({ name: 'Jamón', satProductKey: '50112000', satUnitKey: 'KGM' }),
    })

  it('W4 el payload lleva los kilos reales y el precio por kilo de 6 decimales; el motor lo manda tal cual al PAC', async () => {
    const jamon = renglon({
      id: 'oi-jamon',
      productName: 'Jamón',
      weightQuantity: D(1.537),
      unitPrice: D(45),
      total: D(69.16),
      product: producto({ name: 'Jamón', satProductKey: '50112000', satUnitKey: 'KGM' }),
    })
    const r = await resultadoDe(orden(69.16, { items: [jamon] }))
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items[0]).toMatchObject({
      description: 'Jamón',
      quantity: 1.537,
      unitPriceCents: 4500,
      unitPriceDecimal: '44.996747',
      discountCents: 0,
      taxIncluded: true,
    })
    expect(r.guardado).toEqual({ subtotalCents: 5962, taxCents: 954, totalCents: 6916 })
  })

  // Ajuste 2 del controlador (zona prohibida, caso E del sandbox: 45.00 × 1.537 = 69.165, en medio centavo). Con D9 el precio de
  // lista NUNCA viaja cuando no cae en centavos: viaja el derivado de lo cobrado (44.996747 = variante A, medida al dígito), que no
  // cae en medio centavo; la venta pasa por la barrera (`precioDerivado`) y timbra. La zona sigue cuidando el concepto que viaja
  // (`reglaDelPac.test.ts`: E con el precio de lista ⇒ `MOTIVO_MEDIO_CENTAVO_SIN_REGLA`).
  it('🔴 E de punta a punta (45 × 1.537, cobrado $69.16): no viaja el precio de lista en medio centavo sino el derivado (variante A) ⇒ timbra', async () => {
    const r = await resultadoDe(orden(69.16, { items: [jamonDe(1.537, 69.16)] }))
    expect(r.status).toBe('STAMPED')
    expect(r.motivos).toEqual([])
    expect(r.payload.items).toHaveLength(1)
    expect(r.payload.items[0].unitPriceDecimal).toBe('44.996747')
    expect(r.guardado.totalCents).toBe(6916)
  })

  it('control — E a un paso (45 × 1.536 = 69.12, centavos exactos): sin precio derivado ni `unitPriceDecimal`, timbra como hoy', async () => {
    const r = await resultadoDe(orden(69.12, { items: [jamonDe(1.536, 69.12)] }))
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items[0]).toMatchObject({ quantity: 1.536, unitPriceCents: 4500 })
    expect(r.payload.items[0]).not.toHaveProperty('unitPriceDecimal')
    expect(r.guardado.totalCents).toBe(6912)
  })
})

// ─── B3a, ronda final (Codex final del bloque, rulings F1 y F2) ─────────────────────────────────────────────────────────────
describe('B3a · ronda final: importes del PAC sin ajustes (F1) y diferencia de redondeo hasta la búsqueda (F2)', () => {
  // Una venta con IVA aparte como la guarda el escritor nativo: subtotal BRUTO (antes del descuento), impuesto ya bajado por D16.
  const conIvaAparte = (cobradoCents: number, subtotal: number, impuesto: number, descuento: number, items: any[], reparto: any) =>
    orden(cobradoCents / 100, {
      subtotal: D(subtotal),
      taxAmount: D(impuesto),
      total: D(cobradoCents / 100),
      discountAmount: D(descuento),
      contratoDePrecio: 'IVA_APARTE',
      orderDiscounts: [{ amount: D(descuento), reparto }],
      items,
    })

  it('🔴 F1 (Codex final #1): dos de $100 con IVA aparte y $20 de cuenta repartidos 10/10, subtotal bruto del escritor y cobro $208.80 ⇒ el PAC da exacto, CERO ajustes, y se guarda lo que dirá el XML', async () => {
    const r = await resultadoDe(
      conIvaAparte(
        20880,
        200,
        28.8,
        20,
        [conTratamiento('IVA_16', 'A', 100), conTratamiento('IVA_16', 'B', 100)],
        cuenta({ 'oi-A': 1000, 'oi-B': 1000 }),
      ),
    )
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    // Cero ajustes: los descuentos viajan como se repartieron.
    expect(r.payload.items.map(conDescuentos)).toEqual([
      ['A', 1000],
      ['B', 1000],
    ])
    // Base neta del descuento, IVA y total = lo cobrado (antes se guardaba 20000 + 2880 ≠ 20880 y la validación lo rechazaba).
    expect(r.guardado).toEqual({ subtotalCents: 18000, taxCents: 2880, totalCents: 20880 })
  })

  it('🔴 F2 (Codex final #2): D16 de punta a punta — NET $100.02, impuesto $16.00 y $1.04 de cuenta ⇒ cobro $114.81; por concepto da $114.82 y la búsqueda lo cuadra con descuento $1.05 e IVA $15.84', async () => {
    const reduccion = reduccionDeImpuestoCobrado(
      'IVA_APARTE',
      { 'oi-Pan': 104 },
      [{ id: 'oi-Pan', total: D(100.02), taxAmount: D(16) }],
      D(16),
    )
    expect(reduccion).toBe(0.17)
    const cobradoCents = 10002 - 104 + (1600 - Math.round(reduccion * 100))
    expect(cobradoCents).toBe(11481)
    const r = await resultadoDe(
      conIvaAparte(cobradoCents, 100.02, 16 - reduccion, 1.04, [conTratamiento('IVA_16', 'Pan', 100.02)], cuenta({ 'oi-Pan': 104 })),
    )
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([['Pan', 105]])
    expect(r.guardado).toEqual({ subtotalCents: 9897, taxCents: 1584, totalCents: 11481 })
  })

  // NET $100 con $10 de cuenta: por concepto 90 × 1.16 = $104.40; el IVA aparte es lineal (cada centavo de descuento baja 1.16 ¢).
  const cien = (cobradoCents: number) =>
    conIvaAparte(cobradoCents, 100, 14.4, 10, [conTratamiento('IVA_16', 'Pan', 100)], cuenta({ 'oi-Pan': 1000 }))

  it('🔴 F2: justo en la cota, la diferencia llega a la búsqueda y se timbra lo cobrado', async () => {
    const cobradoCents = 10440 - MAX_CENTAVOS_DE_REDONDEO
    const r = await resultadoDe(cien(cobradoCents))
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.guardado.totalCents).toBe(cobradoCents)
  })

  it('control — 🔴 F2: una diferencia MAYOR que la cota no es redondeo: se detiene con su motivo y no se mueve ningún descuento', async () => {
    const cobradoCents = 10440 - MAX_CENTAVOS_DE_REDONDEO - 1
    const r = await resultadoDe(cien(cobradoCents))
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toContain(
      `El total de la factura ($104.40) no coincide con lo cobrado ($${(cobradoCents / 100).toFixed(2)}). No se timbró; revisa la cuenta o repórtala a soporte.`,
    )
    expect(r.payload.items.map(conDescuentos)).toEqual([['Pan', 1000]])
  })
})

// ─── B3a ronda final, ajuste 2: la cota por tipo (todo lineal ⇒ max(6, n); con algún no lineal ⇒ 6) ─────────────────────────────────
describe('B3a · ronda final, ajuste 2: la cota de la barrera según el documento', () => {
  // Venta NET de 8 renglones (casos de `buscar-casos-f2.ts`): cada renglón deja ~+1 ¢ de redondeo; D16 (función real) baja el IVA
  // una sola vez sobre el descuento de cuenta repartido por renglón.
  const halfUp = (num: number, den: number) => Math.floor((2 * num + den) / (2 * den))
  const ventaNet = (g: number[], d: number[], ajusteCobradoCents = 0) => {
    const ids = g.map((_, i) => `oi-L${i + 1}`)
    const iva = g.map(x => halfUp(x * 16, 100))
    const suma = (a: number[]) => a.reduce((t, x) => t + x, 0)
    const reduccion = reduccionDeImpuestoCobrado(
      'IVA_APARTE',
      Object.fromEntries(ids.map((id, i) => [id, d[i]])),
      ids.map((id, i) => ({ id, total: D(g[i] / 100), taxAmount: D(iva[i] / 100) })),
      D(suma(iva) / 100),
    )
    const impuestoCents = suma(iva) - Math.round(reduccion * 100)
    const cobradoCents = suma(g) - suma(d) + impuestoCents + ajusteCobradoCents
    const porConceptoCents = suma(g.map((x, i) => halfUp((x - d[i]) * 116, 100)))
    const venta = orden(cobradoCents / 100, {
      subtotal: D(suma(g) / 100),
      taxAmount: D(impuestoCents / 100),
      total: D(cobradoCents / 100),
      discountAmount: D(suma(d) / 100),
      contratoDePrecio: 'IVA_APARTE',
      orderDiscounts: [{ amount: D(suma(d) / 100), reparto: cuenta(Object.fromEntries(ids.map((id, i) => [id, d[i]]))) }],
      items: g.map((x, i) => conTratamiento('IVA_16', `L${i + 1}`, x / 100)),
    })
    return { venta, cobradoCents, diferencia: porConceptoCents - cobradoCents }
  }
  const SIETE = { g: [103, 128, 153, 178, 203, 228, 253, 1700], d: [6, 6, 6, 6, 6, 6, 6, 100] }
  const OCHO = { g: [103, 128, 153, 178, 203, 228, 253, 278], d: [6, 6, 6, 6, 6, 6, 6, 6] }

  it('🔴 NET de 8 renglones con 7 ¢ de redondeo de D16 (más que la cota medida de 6) ⇒ llega a la búsqueda y timbra lo cobrado', async () => {
    const { venta, cobradoCents, diferencia } = ventaNet(SIETE.g, SIETE.d)
    expect(diferencia).toBe(7)
    const r = await resultadoDe(venta)
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.guardado.totalCents).toBe(cobradoCents)
  })

  it('🔴 NET de 8 renglones justo en su cota (8 ¢ = número de conceptos) ⇒ timbra lo cobrado', async () => {
    const { venta, cobradoCents, diferencia } = ventaNet(OCHO.g, OCHO.d)
    expect(diferencia).toBe(8)
    const r = await resultadoDe(venta)
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.guardado.totalCents).toBe(cobradoCents)
  })

  it('control — NET de 8 renglones a 9 ¢ (un centavo más que su cota: ya no es redondeo) ⇒ se detiene con el motivo de la barrera', async () => {
    const { venta, cobradoCents, diferencia } = ventaNet(OCHO.g, OCHO.d, -1)
    expect(diferencia).toBe(9)
    const r = await resultadoDe(venta)
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toContain(
      `El total de la factura ($17.16) no coincide con lo cobrado ($${(cobradoCents / 100).toFixed(2)}). No se timbró; revisa la cuenta o repórtala a soporte.`,
    )
  })

  // Con IVA incluido (no lineal) la suma por concepto es el bruto exacto: una diferencia sólo puede ser de armado. La cota queda en 6.
  const dosDeCincuenta = (cobradoCents: number) =>
    orden(cobradoCents / 100, { items: [conTratamiento('IVA_16', 'A', 50), conTratamiento('IVA_16', 'B', 50)] })

  it('control — IVA incluido justo en la cota medida (6 ¢) ⇒ pasa la barrera y decide la búsqueda, que con IVA incluido sólo mueve ±1 ¢: «no encontramos cómo cuadrarla», no el motivo de la barrera', async () => {
    const r = await resultadoDe(dosDeCincuenta(9994))
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toEqual([motivoNoCuadra(10000, 9994)])
  })

  it('control — mezcla con UN solo no lineal (7 piezas al 0 % + un Latte al 16 %, IVA incluido) a 7 ¢ ⇒ la cota es 6, no 8: se detiene en la barrera (si no, el grupo al 0 % absorbería 7 ¢ de un descuento que nadie dio)', async () => {
    const granos = Array.from({ length: 7 }, (_, i) => conTratamiento('IVA_0', `Grano ${i + 1}`, 10))
    const r = await resultadoDe(orden(169.93, { items: [...granos, conTratamiento('IVA_16', 'Latte', 100)] }))
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toContain(
      'El total de la factura ($170.00) no coincide con lo cobrado ($169.93). No se timbró; revisa la cuenta o repórtala a soporte.',
    )
  })

  it('control — IVA incluido a 7 ¢ ⇒ sigue deteniéndose en la barrera (la cota por concepto es sólo de los documentos todo lineales)', async () => {
    const r = await resultadoDe(dosDeCincuenta(9993))
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toContain(
      'El total de la factura ($100.00) no coincide con lo cobrado ($99.93). No se timbró; revisa la cuenta o repórtala a soporte.',
    )
  })
})

// ─── B3a ronda final, ajuste 2 (Codex final r2): D16 redondea una vez POR FILA de descuento que participa, no una vez por venta ──────
describe('B3a · ronda final, ajuste 2 (r2): la cota cuenta también las filas de D16', () => {
  // NET $100 (IVA $16) con 14 descuentos de cuenta de $0.03, todos con `reduceImpuesto` (D16): la reducción de CADA fila
  // (función real, en el orden de `sincronizarRepartos`) redondea a $0.00, así que se cobra el IVA completo.
  const catorceDeTres = (ajusteCobradoCents = 0, reduceImpuesto = true) => {
    const renglones = [{ id: 'oi-Pan', total: D(100), taxAmount: D(16) }]
    let disponible = 1600
    for (let i = 0; i < 14; i++) {
      disponible -= Math.round(reduccionDeImpuestoCobrado('IVA_APARTE', { 'oi-Pan': 3 }, renglones, D(disponible / 100)) * 100)
    }
    const cobradoCents = 10000 - 42 + disponible + ajusteCobradoCents
    const filas = Array.from({ length: 14 }, (_, i) => ({
      id: `d${String(i).padStart(2, '0')}`,
      amount: D(0.03),
      reparto: { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { 'oi-Pan': 3 }, reduceImpuesto },
    }))
    const venta = orden(cobradoCents / 100, {
      subtotal: D(100),
      taxAmount: D(disponible / 100),
      total: D(cobradoCents / 100),
      discountAmount: D(0.42),
      contratoDePrecio: 'IVA_APARTE',
      orderDiscounts: filas,
      items: [conTratamiento('IVA_16', 'Pan', 100)],
    })
    return { venta, cobradoCents, impuestoCents: disponible }
  }

  it('🔴 Codex final r2: 14 × $0.03 con D16 ⇒ IVA completo, cobro $115.58, por concepto $115.51 (7 ¢ > max(6, 1)); la cota de 15 la deja llegar y se timbra con descuento $0.36 e IVA $15.94', async () => {
    const { venta, cobradoCents, impuestoCents } = catorceDeTres()
    expect(impuestoCents).toBe(1600)
    expect(cobradoCents).toBe(11558)
    const r = await resultadoDe(venta)
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.payload.items.map(conDescuentos)).toEqual([['Pan', 36]])
    expect(r.guardado).toEqual({ subtotalCents: 9964, taxCents: 1594, totalCents: 11558 })
  })

  it('control — las mismas 14 filas SIN `reduceImpuesto` no redondean D16: los 7 ¢ son IVA que no bajó, no redondeo ⇒ cota 6 ⇒ se detiene', async () => {
    const { venta } = catorceDeTres(0, false)
    const r = await resultadoDe(venta)
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toContain(
      'El total de la factura ($115.51) no coincide con lo cobrado ($115.58). No se timbró; revisa la cuenta o repórtala a soporte.',
    )
  })

  it('control — filas marcadas `reduceImpuesto` en una venta con IVA INCLUIDO (p. ej. tras fusionar cuentas) no cuentan: D16 sólo redondea con IVA aparte ⇒ cota 6 ⇒ 7 ¢ se detiene', async () => {
    const filas = Array.from({ length: 14 }, (_, i) => ({
      id: `d${String(i).padStart(2, '0')}`,
      amount: D(0.03),
      reparto: { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { 'oi-Grano': 3 }, reduceImpuesto: true },
    }))
    const r = await resultadoDe(
      orden(99.51, { discountAmount: D(0.42), orderDiscounts: filas, items: [conTratamiento('IVA_0', 'Grano', 100)] }),
    )
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toContain(
      'El total de la factura ($99.58) no coincide con lo cobrado ($99.51). No se timbró; revisa la cuenta o repórtala a soporte.',
    )
  })

  it('control — la misma venta a 16 ¢ (un centavo más que su cota de 1 concepto + 14 filas) ⇒ se detiene con el motivo de la barrera', async () => {
    const { venta } = catorceDeTres(9)
    const r = await resultadoDe(venta)
    expect(r.status).toBe('VALIDATION_FAILED')
    expect(r.motivos).toContain(
      'El total de la factura ($115.51) no coincide con lo cobrado ($115.67). No se timbró; revisa la cuenta o repórtala a soporte.',
    )
  })
})

// ─── Bloque C1, Tarea 2: la fila guarda SIEMPRE lo que suma el PAC (controles de B3a F1; v9, C1-46) ───
describe('C1 · control — la fila guarda lo que suma el PAC, con o sin ajuste de la 6b y con o sin descuento (B3a F1)', () => {
  const capuccino = (descuento: number) =>
    renglon({
      id: 'oi-cap',
      productName: 'CAPUCCINO',
      unitPrice: D(65),
      total: D(70),
      discountAmount: D(descuento),
      modifiers: [{ name: 'Deslactosada', price: D(5), quantity: 1 }],
      product: producto({ name: 'CAPUCCINO' }),
    })

  it('control — IVA aparte, sin ajuste (el PAC da lo cobrado): $65 + $5 con $1.11 ⇒ se timbra y guarda 68.89 + 11.02 = 79.91', async () => {
    const r = await resultadoDe(
      orden(79.91, {
        subtotal: D(70),
        taxAmount: D(11.02),
        total: D(79.91),
        discountAmount: D(1.11),
        contratoDePrecio: 'IVA_APARTE',
        items: [capuccino(1.11)],
      }),
    )
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.guardado).toEqual({ subtotalCents: 6889, taxCents: 1102, totalCents: 7991 })
  })

  it('control — IVA aparte, con ajuste (R1 de la 6b: 2 × $2.03 con $1 c/u; el PAC daría 2.39 y se cobró 2.38) ⇒ uno pasa a $1.01 y guarda 2.05 + 0.33 = 2.38', async () => {
    const pieza = (id: string) => renglon({ id, productName: 'PIEZA', unitPrice: D(2.03), total: D(2.03), discountAmount: D(1) })
    const r = await resultadoDe(
      orden(2.38, {
        subtotal: D(4.06),
        taxAmount: D(0.32),
        total: D(2.38),
        discountAmount: D(2),
        contratoDePrecio: 'IVA_APARTE',
        items: [pieza('oi-a'), pieza('oi-b')],
      }),
    )
    expect(r.status).toBe('STAMPED')
    expect(r.guardado).toEqual({ subtotalCents: 205, taxCents: 33, totalCents: 238 })
    // Ajuste M2 del controlador: `resultadoDe` no devuelve `items`; los descuentos se leen del payload que recibe el proveedor.
    expect(r.payload.items.map((i: any) => i.discountCents).sort()).toEqual([100, 101])
  })

  it('control — IVA aparte SIN descuento guarda los montos de la cabecera, como hoy', async () => {
    const r = await resultadoDe(
      orden(116, {
        subtotal: D(100),
        taxAmount: D(16),
        total: D(116),
        contratoDePrecio: 'IVA_APARTE',
        items: [renglon({ unitPrice: D(100), total: D(100) })],
      }),
    )
    expect(r.status).toBe('STAMPED')
    expect(r.guardado).toEqual({ subtotalCents: 10000, taxCents: 1600, totalCents: 11600 })
  })

  // v9 (Codex C1-46): el contraejemplo que la condición «sólo si hubo ajustes o descuento con IVA aparte» de la v8 habría regresado. `orden()` trae
  // IVA INCLUIDO por omisión; sin descuentos y sin ajustes, el cargador igual guarda lo que suma el PAC (el `else` incondicional de B3a F1).
  it('control — 🔴 regresión (C1-46): IVA incluido 16 %, sin descuentos, dos conceptos de $65 cobrados $130 ⇒ guarda base 112.07 + IVA 17.93 = 130.00 (no 112.06 + 17.94)', async () => {
    const r = await resultadoDe(
      orden(130, {
        items: [
          renglon({ id: 'oi-a', productName: 'PIEZA A', unitPrice: D(65), total: D(65) }),
          renglon({ id: 'oi-b', productName: 'PIEZA B', unitPrice: D(65), total: D(65) }),
        ],
      }),
    )
    expect(r.motivos).toEqual([])
    expect(r.status).toBe('STAMPED')
    expect(r.guardado).toEqual({ subtotalCents: 11207, taxCents: 1793, totalCents: 13000 })
  })
})

// ─── C1 Tarea 6: cada concepto sabe de qué OrderItem nace (`origen`), y eso nunca viaja al PAC ───────────────────────────────
describe('C1 · `origen` de cada concepto', () => {
  it('🔴 cada concepto —también el del extra— trae el id del OrderItem del que nace; uno sin id no lo inventa', () => {
    const { items, motivos } = reconstruirConceptos(
      { ...CASOS.extras, items: CASOS.extras.items.map((i: any) => ({ ...i, tratamiento: 'IVA_16' })) } as any,
      'o1',
    )
    expect(motivos).toEqual([])
    expect(items.map(i => [i.productName, i.origen])).toEqual([
      ['CAPUCCINO (Canela)', 'oi-cap'],
      ['Deslactosada (CAPUCCINO)', 'oi-cap'],
      ['Pan dulce', 'oi-pan'],
    ])
    const sinId = reconstruirConceptos({ items: [renglon({ id: undefined })] } as any, 'o1')
    expect(sinId.items).toHaveLength(1)
    expect(sinId.items[0]).not.toHaveProperty('origen')
  })
  it('control — `origen` no llega al payload del PAC: con un renglón con extra, ningún item lo trae (las doradas individuales no cambian)', async () => {
    const r = await resultadoDe(CASOS.extras)
    expect(r.status).toBe('STAMPED') // y `resultadoDe` comprueba que el motor manda EXACTAMENTE este payload
    expect(r.payload.items).toHaveLength(3)
    for (const i of r.payload.items) expect(i).not.toHaveProperty('origen')
    expect(JSON.stringify(r.payload)).not.toMatch(/origen|oi-cap/)
  })
})
