// tests/unit/services/fiscal/entradaDocumental.test.ts
// Plan 3 (IVA por producto), Tarea 4: la entrada documental (foto congelada del intento).
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
import { loadOrderForCfdiFromDb, IssueReceptor, LoadedOrderBundle } from '../../../../src/services/fiscal/cfdi.service'
import { assembleSaleInput } from '../../../../src/services/fiscal/assembleSaleInput'
import { buildCreateInvoiceParams } from '../../../../src/services/fiscal/cfdiPayloadBuilder'
import { CASOS, receptor, CONFIG } from './fixtures/ivaPorProductoGoldenOrders'
import {
  capturarEntrada,
  huellaDeEntrada,
  paramsDesdeEntrada,
  leerEntrada,
  EntradaDocumentalV1,
} from '../../../../src/services/fiscal/entradaDocumental'

const orderMock = prisma.order.findUnique as jest.Mock
const cfgMock = prisma.merchantFiscalConfig.findUnique as jest.Mock

const ORDER_ID = 'o1'

/** Construye el bundle REAL (loadOrderForCfdiFromDb) para una de las órdenes golden de la Tarea 3. */
async function construirBundle(nombre: keyof typeof CASOS): Promise<LoadedOrderBundle> {
  orderMock.mockResolvedValue(CASOS[nombre])
  cfgMock.mockResolvedValue(CONFIG)
  const bundle = await loadOrderForCfdiFromDb(ORDER_ID, { permitirEfectivo: true })
  if (!bundle) throw new Error('el cargador devolvió null')
  return bundle
}

/** El payload que produce el camino de HOY (assemble + build), con la MISMA idempotencyKey que usa
 * `capturarEntrada` internamente (el orderId — ese campo nunca se manda al PAC, sólo `externalId`). */
function payloadDeHoy(bundle: LoadedOrderBundle) {
  return buildCreateInvoiceParams(
    assembleSaleInput(bundle.order, {
      receptor,
      paymentMethod: bundle.paymentMethod,
      tenderSatFormaPago: bundle.tenderSatFormaPago ?? null,
      metodoPago: bundle.metodoPago,
      serie: bundle.emisor.serie ?? undefined,
      idempotencyKey: ORDER_ID,
    }),
  )
}

/** Reconstruye un objeto con las llaves en orden INVERSO, recursivamente (para probar que la huella
 * no depende del orden de inserción). */
function conLlavesInvertidas(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(conLlavesInvertidas)
  if (v !== null && typeof v === 'object') {
    const entradas = Object.entries(v as Record<string, unknown>).reverse()
    const out: Record<string, unknown> = {}
    for (const [k, val] of entradas) out[k] = conLlavesInvertidas(val)
    return out
  }
  return v
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('capturarEntrada + paramsDesdeEntrada: misma foto ⇒ mismo payload', () => {
  const TODO_16 = ['extras', 'peso', 'descuentoRenglon', 'sinRenglones', 'ivaSeparado'] as const

  it.each(TODO_16)('%s: paramsDesdeEntrada(capturarEntrada(...)) === payload de hoy + externalId', async nombre => {
    const bundle = await construirBundle(nombre)
    const hoy = payloadDeHoy(bundle)
    const entrada = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID)
    const resultado = paramsDesdeEntrada(entrada, 'cfdi-order-o1#1')
    expect(resultado).toEqual({ ...hoy, externalId: 'cfdi-order-o1#1' })
  })

  it.each(TODO_16)('%s: entrada.montos coincide con los montos del bundle (lo que se guarda en la fila)', async nombre => {
    const bundle = await construirBundle(nombre)
    const entrada = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID)
    expect(entrada.montos).toEqual({
      subtotalCents: bundle.subtotalCents,
      taxCents: bundle.taxCents,
      totalCents: bundle.totalCents,
    })
    expect(entrada.paidCents).toBe(bundle.paidCents)
    expect(entrada.clasificacion).toBe('TODO_16')
  })

  it('la venta sin renglones captura renglones: [] (sin OrderItem real que sellar)', async () => {
    const bundle = await construirBundle('sinRenglones')
    const entrada = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID)
    expect(entrada.renglones).toEqual([])
  })

  it('una orden con renglones reales sella orderItemId + tratamiento por renglón', async () => {
    const bundle = await construirBundle('extras')
    const entrada = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID)
    expect(entrada.renglones).toEqual([
      { orderItemId: 'oi-cap', tratamiento: 'IVA_16' },
      { orderItemId: 'oi-pan', tratamiento: 'IVA_16' },
    ])
  })
})

describe('replacesCfdiId', () => {
  it('se conserva en la entrada y cambia la huella respecto de una sin reemplazo', async () => {
    const bundle = await construirBundle('extras')
    const sinReemplazo = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID)
    const conReemplazo = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID, { replacesCfdiId: 'cfdi-viejo-1' })
    expect(sinReemplazo.replacesCfdiId).toBeNull()
    expect(conReemplazo.replacesCfdiId).toBe('cfdi-viejo-1')
    expect(huellaDeEntrada(conReemplazo)).not.toBe(huellaDeEntrada(sinReemplazo))
  })
})

describe('huellaDeEntrada', () => {
  it('es estable ante reordenar llaves, recursivamente', async () => {
    const bundle = await construirBundle('extras')
    const entrada = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID)
    const invertida = conLlavesInvertidas(entrada) as EntradaDocumentalV1
    expect(huellaDeEntrada(invertida)).toBe(huellaDeEntrada(entrada))
  })

  it('cambia si cambia un centavo de los montos', async () => {
    const bundle = await construirBundle('extras')
    const entrada = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID)
    const mutada: EntradaDocumentalV1 = { ...entrada, montos: { ...entrada.montos, totalCents: entrada.montos.totalCents + 1 } }
    expect(huellaDeEntrada(mutada)).not.toBe(huellaDeEntrada(entrada))
  })

  it('cambia si cambia el tratamiento de un renglón', async () => {
    const bundle = await construirBundle('extras')
    const entrada = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID)
    const mutada: EntradaDocumentalV1 = {
      ...entrada,
      renglones: [{ ...entrada.renglones[0], tratamiento: 'IVA_0' }, ...entrada.renglones.slice(1)],
    }
    expect(huellaDeEntrada(mutada)).not.toBe(huellaDeEntrada(entrada))
  })

  it('cambia si cambia el receptor', async () => {
    const bundle = await construirBundle('extras')
    const entrada = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID)
    const mutada: EntradaDocumentalV1 = {
      ...entrada,
      params: { ...entrada.params, receptor: { ...entrada.params.receptor, rfc: 'OTRO000000AAA' } },
    }
    expect(huellaDeEntrada(mutada)).not.toBe(huellaDeEntrada(entrada))
  })
})

describe('leerEntrada', () => {
  it('rechaza null, {} y { version: 2 }', () => {
    expect(leerEntrada(null)).toBeNull()
    expect(leerEntrada({})).toBeNull()
    expect(leerEntrada({ version: 2 })).toBeNull()
    expect(leerEntrada(undefined)).toBeNull()
    expect(leerEntrada('cadena')).toBeNull()
    expect(leerEntrada([])).toBeNull()
  })

  it('acepta una entrada capturada, incluso tras un viaje redondo por JSON', async () => {
    const bundle = await construirBundle('extras')
    const entrada = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID)
    const rehidratada = JSON.parse(JSON.stringify(entrada))
    expect(leerEntrada(rehidratada)).toEqual(entrada)
  })
})

describe('la entrada es una copia profunda (structuredClone)', () => {
  it('mutar el bundle Y el receptor DESPUÉS de capturar no cambia paramsDesdeEntrada', async () => {
    const bundle = await construirBundle('extras')
    const receptorMutable: IssueReceptor = { ...receptor }
    const entrada = capturarEntrada(bundle, receptorMutable, ORDER_ID)
    const antes = paramsDesdeEntrada(entrada, 'k1')

    // Mutar el bundle y el receptor pasado a capturarEntrada, DESPUÉS de haber capturado.
    ;(bundle.order.items[0] as any).unitPrice = new Prisma.Decimal(999999)
    bundle.subtotalCents = 1
    bundle.order.renglonesOrigen![0].tratamiento = 'IVA_0'
    receptorMutable.rfc = 'MUTADO0000AAA'

    const despues = paramsDesdeEntrada(entrada, 'k1')
    expect(despues).toEqual(antes)
  })
})

describe('capturarEntrada falla cerrado (nunca asume TODO_16 ni inventa dinero)', () => {
  it('lanza si el bundle no trae clasificacion resuelta', async () => {
    const bundle = await construirBundle('extras')
    const sinClasificacion = { ...bundle, order: { ...bundle.order, clasificacion: undefined } } as any
    expect(() => capturarEntrada(sinClasificacion, receptor as IssueReceptor, ORDER_ID)).toThrow()
  })

  it('lanza si el bundle no trae paidCents', async () => {
    const bundle = await construirBundle('extras')
    const sinPaidCents = { ...bundle, paidCents: undefined } as any
    expect(() => capturarEntrada(sinPaidCents, receptor as IssueReceptor, ORDER_ID)).toThrow()
  })
})
