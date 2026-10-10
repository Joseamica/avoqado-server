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
import logger from '../../../../src/config/logger'
import { loadOrderForCfdiFromDb, IssueReceptor, LoadedOrderBundle } from '../../../../src/services/fiscal/cfdi.service'
import { assembleSaleInput } from '../../../../src/services/fiscal/assembleSaleInput'
import { buildCreateInvoiceParams } from '../../../../src/services/fiscal/cfdiPayloadBuilder'
import { CASOS, receptor, CONFIG, D, orden, producto, renglon } from './fixtures/ivaPorProductoGoldenOrders'
import * as saldoFiscal from '../../../../src/services/fiscal/saldoFiscal'
import {
  capturarEntrada,
  huellaDeEntrada,
  paramsDesdeEntrada,
  leerEntrada,
  leerMontosPorRenglon,
  EntradaDocumentalV1,
  type MontosPorRenglon,
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

// ─── C2 · Tarea 6: montosPorRenglon (lo facturado de cada artículo, del documento repartido) ──────────────────────────────────────

/** Una orden IVA incluido con estos renglones: lo pagado es lo que cobra cada renglón (total − su descuento) y la cabecera lleva sus descuentos. */
function ordenDe(items: any[]) {
  const c = (d: any) => Math.round(Number(d ?? 0) * 100)
  const pagado = items.reduce((s, it) => s + c(it.total) - c(it.discountAmount), 0) / 100
  const descuento = items.reduce((s, it) => s + c(it.discountAmount), 0) / 100
  return orden(pagado, { discountAmount: D(descuento), items })
}

/** El bundle del cargador REAL (`loadOrderForCfdiFromDb`, con el ajuste de la 6b) sobre esa orden, y la entrada que se captura de él. */
async function capturar(caso: any) {
  orderMock.mockResolvedValue(caso)
  cfgMock.mockResolvedValue(CONFIG)
  const bundle = await loadOrderForCfdiFromDb(ORDER_ID, { permitirEfectivo: true })
  if (!bundle) throw new Error('el cargador devolvió null')
  expect(bundle.unsupportedReasons).toBeUndefined() // el caso es facturable: lo que se congela es lo que se timbraría
  return { bundle, entrada: capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID) }
}

/** Una entrada válida capturada con el cargador real (un artículo de $100 al 16 %). */
async function entradaValida(): Promise<EntradaDocumentalV1> {
  return (await capturar(ordenDe([renglon({ id: 'a', unitPrice: D(100), total: D(100) })]))).entrada
}

const AL_0 = (nombre: string) => producto({ name: nombre, ivaTratamiento: 'IVA_0', taxRate: D(0), objetoImp: '02' })

describe('C2 · montosPorRenglon — lo facturado de cada artículo, del documento repartido', () => {
  it('🔴 C2-10/C2-30: con el cargador real, lo facturado del artículo es el documento AJUSTADO, que da lo cobrado: $65 − $2.50 ⇒ 6250; $65 − $2.49 ⇒ 6251', async () => {
    const { entrada } = await capturar(ordenDe([renglon({ id: 'a', unitPrice: D(65), total: D(65), discountAmount: D(2.5) })]))
    expect(entrada.params.items[0].discountCents).toBe(249) // la 6b movió el descuento: el PAC daría 62.49 con $2.50
    expect(entrada.montosPorRenglon).toEqual([{ orderItemId: 'a', totalCents: 6250, porTratamiento: { IVA_16: 6250 } }])
    const otra = (await capturar(ordenDe([renglon({ id: 'a', unitPrice: D(65), total: D(65), discountAmount: D(2.49) })]))).entrada
    expect(otra.params.items[0].discountCents).toBe(248)
    expect(otra.montosPorRenglon).toEqual([{ orderItemId: 'a', totalCents: 6251, porTratamiento: { IVA_16: 6251 } }])
    expect(otra.montos.totalCents).toBe(6251)
  })

  // Desviación medida (reporte de la T6, «Preocupaciones»): el plan esperaba 5000 y 11600. Con el cargador real el PAC daría $166.01 y la
  // 6b sube 1 ¢ el descuento de a ($50.01): su concepto cobra $49.99 y el centavo del documento (ajuste +1 de la tasa) lo reparte la
  // asignación de la T4 por lo que cobra cada concepto, y le toca a b. Esta prueba fija lo que hoy dice la regla mandada.
  it('🔴 artículo de $100 con $50 de descuento y otro de $116 (con un extra): el documento ajustado los reparte en 4999 y 11601, y suman el total de la factura', async () => {
    const { entrada } = await capturar(
      ordenDe([
        renglon({ id: 'a', unitPrice: D(100), total: D(100), discountAmount: D(50) }),
        renglon({ id: 'b', unitPrice: D(100), total: D(116), modifiers: [{ name: 'Extra', price: D(16), quantity: 1 }] }),
      ]),
    )
    expect(entrada.params.items).toHaveLength(3) // el extra es su propio concepto, con `origen` = b
    expect(entrada.params.items.map(i => i.discountCents)).toEqual([5001, 0, 0]) // la 6b movió 1 ¢ al descuento de a
    expect(entrada.montosPorRenglon).toEqual([
      { orderItemId: 'a', totalCents: 4999, porTratamiento: { IVA_16: 4999 } },
      { orderItemId: 'b', totalCents: 11601, porTratamiento: { IVA_16: 11601 } },
    ])
    expect(leerMontosPorRenglon(entrada)).toEqual(entrada.montosPorRenglon)
    expect(leerMontosPorRenglon(entrada)!.reduce((s, m) => s + m.totalCents, 0)).toBe(entrada.montos.totalCents)
    expect(leerEntrada(entrada)).not.toBeNull()
  })

  it('un artículo con conceptos en dos tasas queda con sus dos tratamientos (el cargador de hoy hereda la tasa al extra: dos renglones con el mismo origen)', async () => {
    const { entrada } = await capturar(
      ordenDe([
        renglon({ id: 'a', unitPrice: D(100), total: D(100) }),
        renglon({ id: 'a', productName: 'Extra al 0 %', unitPrice: D(30), total: D(30), product: AL_0('Extra al 0 %') }),
      ]),
    )
    expect(entrada.clasificacion).toBe('MIXTA')
    expect(entrada.montosPorRenglon).toHaveLength(1)
    expect(leerMontosPorRenglon(entrada)![0]).toMatchObject({
      orderItemId: 'a',
      totalCents: 13000,
      porTratamiento: { IVA_16: 10000, IVA_0: 3000 },
    })
  })

  it('una entrada sin el campo (de antes de C2) se sigue leyendo y no trae evidencia, sin aviso; una con un artículo ajeno o que no suma conserva la entrada (ronda 1, M1)', async () => {
    const valida = await entradaValida()
    expect(leerEntrada({ ...valida, montosPorRenglon: undefined })).not.toBeNull()
    const sinElCampo: EntradaDocumentalV1 = { ...valida }
    delete sinElCampo.montosPorRenglon
    expect(leerEntrada(sinElCampo)).not.toBeNull()
    ;(logger.warn as jest.Mock).mockClear()
    expect(leerMontosPorRenglon(leerEntrada(sinElCampo)!)).toBeNull()
    expect(logger.warn).not.toHaveBeenCalled()
    for (const mala of [
      [{ orderItemId: 'zzz', totalCents: 1, porTratamiento: { IVA_16: 1 } }],
      [{ orderItemId: valida.renglones[0].orderItemId, totalCents: 2, porTratamiento: { IVA_16: 1 } }],
    ]) {
      const leida = leerEntrada({ ...valida, montosPorRenglon: mala })
      expect(leida).not.toBeNull()
      expect(leerMontosPorRenglon(leida!)).toBeNull()
    }
  })

  describe('🔴 ronda 1 (M1, M2): un campo malformado NO anula la entrada (la nota por importe sigue); sólo deja de ser evidencia, con aviso', () => {
    const malas: Array<[string, (e: EntradaDocumentalV1) => unknown]> = [
      ['null', () => null],
      ['no es arreglo', () => ({ a: 1 })],
      ['un elemento no es objeto', () => [null]],
      ['orderItemId no es texto', () => [{ orderItemId: 7, totalCents: 1, porTratamiento: { IVA_16: 1 } }]],
      ['totalCents negativo', e => [{ orderItemId: e.renglones[0].orderItemId, totalCents: -1, porTratamiento: { IVA_16: -1 } }]],
      ['totalCents con fracción', e => [{ orderItemId: e.renglones[0].orderItemId, totalCents: 1.5, porTratamiento: { IVA_16: 1.5 } }]],
      ['porTratamiento no es objeto', e => [{ orderItemId: e.renglones[0].orderItemId, totalCents: 1, porTratamiento: [1] }]],
      ['porTratamiento ausente', e => [{ orderItemId: e.renglones[0].orderItemId, totalCents: 1 }]],
      [
        'un tratamiento que no es de nota',
        e => [{ orderItemId: e.renglones[0].orderItemId, totalCents: 1, porTratamiento: { BLOQUEADO_03: 1 } }],
      ],
      [
        'un monto de tratamiento no entero',
        e => [{ orderItemId: e.renglones[0].orderItemId, totalCents: 1, porTratamiento: { IVA_16: '1' } }],
      ],
      [
        'artículo repetido',
        e => [
          { orderItemId: e.renglones[0].orderItemId, totalCents: 1, porTratamiento: { IVA_16: 1 } },
          { orderItemId: e.renglones[0].orderItemId, totalCents: 1, porTratamiento: { IVA_16: 1 } },
        ],
      ],
      [
        'suman más que la factura',
        e => [
          {
            orderItemId: e.renglones[0].orderItemId,
            totalCents: e.montos.totalCents + 1,
            porTratamiento: { IVA_16: e.montos.totalCents + 1 },
          },
        ],
      ],
    ]
    it.each(malas)('%s ⇒ la entrada se lee igual (misma huella) y sin evidencia, con aviso', async (_nombre, mala) => {
      const valida = await entradaValida()
      expect(leerMontosPorRenglon(valida)).toEqual(valida.montosPorRenglon)
      const guardada = JSON.parse(JSON.stringify({ ...valida, montosPorRenglon: mala(valida) }))
      const leida = leerEntrada(guardada)
      expect(leida).not.toBeNull()
      // la huella se calcula sobre lo leído y se compara con la guardada (`cfdi.service.ts`, `cfdiCreditNote.service.ts`): no cambia
      expect(huellaDeEntrada(leida)).toBe(huellaDeEntrada(guardada))
      ;(logger.warn as jest.Mock).mockClear()
      expect(leerMontosPorRenglon(leida!)).toBeNull()
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('montosPorRenglon malformado'))
    })
  })

  it('🔴 doradas de la entrada: cada orden golden gana su montosPorRenglon (la venta sin renglones no lo trae), y suma el total', async () => {
    const esperados: Record<string, MontosPorRenglon | undefined> = {
      extras: [
        { orderItemId: 'oi-cap', totalCents: 14000, porTratamiento: { IVA_16: 14000 } },
        { orderItemId: 'oi-pan', totalCents: 3500, porTratamiento: { IVA_16: 3500 } },
      ],
      peso: [{ orderItemId: 'oi-queso', totalCents: 4500, porTratamiento: { IVA_16: 4500 } }],
      descuentoRenglon: [{ orderItemId: 'oi-hamb', totalCents: 10000, porTratamiento: { IVA_16: 10000 } }],
      ivaSeparado: [{ orderItemId: 'oi-clase', totalCents: 23200, porTratamiento: { IVA_16: 23200 } }],
      sinRenglones: undefined,
    }
    for (const [nombre, esperado] of Object.entries(esperados)) {
      const entrada = capturarEntrada(await construirBundle(nombre as keyof typeof CASOS), receptor as IssueReceptor, ORDER_ID)
      expect({ nombre, montosPorRenglon: entrada.montosPorRenglon }).toEqual({ nombre, montosPorRenglon: esperado })
      expect({ nombre, tieneElCampo: 'montosPorRenglon' in entrada }).toEqual({ nombre, tieneElCampo: esperado !== undefined })
      if (esperado) expect(esperado.reduce((s, m) => s + m.totalCents, 0)).toBe(entrada.montos.totalCents)
      const leida = leerEntrada(JSON.parse(JSON.stringify(entrada)))
      expect(leida).toEqual(entrada)
      expect({ nombre, evidencia: leerMontosPorRenglon(leida!) }).toEqual({ nombre, evidencia: esperado ?? null })
    }
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('sin montosPorRenglon'))
  })

  it('🔴 el orden físico de los renglones no cambia la foto: se congela ordenado por orderItemId', async () => {
    const a = renglon({ id: 'a', unitPrice: D(100), total: D(100), discountAmount: D(50) })
    const b = renglon({ id: 'b', unitPrice: D(35), total: D(35) })
    const ab = (await capturar(ordenDe([a, b]))).entrada.montosPorRenglon
    const ba = (await capturar(ordenDe([b, a]))).entrada.montosPorRenglon
    expect(ab).toEqual([
      { orderItemId: 'a', totalCents: 5000, porTratamiento: { IVA_16: 5000 } },
      { orderItemId: 'b', totalCents: 3500, porTratamiento: { IVA_16: 3500 } },
    ])
    expect(ba).toEqual(ab)
  })

  it('🔴 si el documento no se puede repartir, la entrada se captura SIN el campo (lo demás igual) y queda un aviso', async () => {
    const { bundle } = await capturar(ordenDe([renglon({ id: 'a', unitPrice: D(100), total: D(100) })]))
    // Un concepto regalado (descuento = importe) no se reparte (`MOTIVO_CONCEPTO_REGALADO`): D9 lo impide en el cargador; aquí se fuerza.
    ;(bundle.order.items[0] as any).discountAmount = D(100)
    ;(logger.warn as jest.Mock).mockClear()
    const entrada = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID)
    expect('montosPorRenglon' in entrada).toBe(false)
    expect(entrada.params.items[0].discountCents).toBe(10000) // el payload es el de siempre
    expect(leerEntrada(entrada)).not.toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sin montosPorRenglon'))
  })
})

describe('C2 · montosPorRenglon nunca detiene una factura', () => {
  afterEach(() => jest.restoreAllMocks())

  it('🔴 lo que la regla del lector rechazaría no se congela: la captura nunca guarda una entrada que después no se pueda leer', async () => {
    const { bundle } = await capturar(ordenDe([renglon({ id: 'a', unitPrice: D(100), total: D(100) })]))
    // Una asignación que daría al artículo más que la factura entera (10001 > 10000).
    jest.spyOn(saldoFiscal, 'asignacionFiscal').mockReturnValue({
      porTratamiento: { IVA_16: { baseCents: 8622, ivaCents: 1379, totalCents: 10001 } },
      porClave: new Map([['a', { IVA_16: { baseCents: 8622, ivaCents: 1379, totalCents: 10001 } }]]),
      ajustePorTratamiento: {},
    })
    ;(logger.warn as jest.Mock).mockClear()
    const entrada = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID)
    expect('montosPorRenglon' in entrada).toBe(false)
    expect(leerEntrada(JSON.parse(JSON.stringify(entrada)))).not.toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no pasa la regla del lector'))
  })

  it('🔴 si repartir el documento LANZA (un defecto nuestro), la entrada se captura igual, sin el campo, y queda el aviso con la causa', async () => {
    const { bundle, entrada: normal } = await capturar(ordenDe([renglon({ id: 'a', unitPrice: D(100), total: D(100) })]))
    expect(normal.montosPorRenglon).toEqual([{ orderItemId: 'a', totalCents: 10000, porTratamiento: { IVA_16: 10000 } }])
    jest.spyOn(saldoFiscal, 'asignacionFiscal').mockImplementation(() => {
      throw new Error('falla de prueba')
    })
    ;(logger.warn as jest.Mock).mockClear()
    const entrada = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID)
    const sinElCampo: EntradaDocumentalV1 = { ...normal }
    delete sinElCampo.montosPorRenglon
    expect(entrada).toEqual(sinElCampo)
    expect('montosPorRenglon' in entrada).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('falla de prueba'))
  })
})

describe('C2 · ronda 1 (M3, M4): cuándo se calcula y cuándo avisa', () => {
  afterEach(() => jest.restoreAllMocks())

  /** El bundle del cargador real, SIN exigir que sea facturable. */
  async function cargar(caso: any) {
    orderMock.mockResolvedValue(caso)
    cfgMock.mockResolvedValue(CONFIG)
    const bundle = await loadOrderForCfdiFromDb(ORDER_ID, { permitirEfectivo: true })
    if (!bundle) throw new Error('el cargador devolvió null')
    return bundle
  }

  it('🔴 M3: una captura que no se timbra (el cargador ya trae sus motivos) ni calcula ni guarda el campo, y no avisa', async () => {
    // Lo cobrado ($150) no es lo que suman los renglones ($100): el cargador la detiene con su motivo (`VALIDATION_FAILED`).
    const bundle = await cargar(orden(150, { items: [renglon({ id: 'a', unitPrice: D(100), total: D(100) })] }))
    expect(bundle.unsupportedReasons?.length).toBeGreaterThan(0)
    const asignacion = jest.spyOn(saldoFiscal, 'asignacionFiscal')
    ;(logger.warn as jest.Mock).mockClear()
    const entrada = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID)
    expect('montosPorRenglon' in entrada).toBe(false)
    expect(asignacion).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('montosPorRenglon'))
    expect(leerEntrada(entrada)).not.toBeNull()
  })

  it('🔴 M4: si lo congelado no suma el total de la factura (un concepto perdió su origen), se congela igual y queda un aviso', async () => {
    const { bundle } = await capturar(
      ordenDe([
        renglon({ id: 'a', unitPrice: D(100), total: D(100), discountAmount: D(50) }),
        renglon({ id: 'b', unitPrice: D(100), total: D(116), modifiers: [{ name: 'Extra', price: D(16), quantity: 1 }] }),
      ]),
    )
    // Una regresión que le quite el `origen` al extra de b: b se congela sin su extra (dirección segura: su devolución se detiene).
    delete (bundle.order.items[2] as any).origen
    ;(logger.warn as jest.Mock).mockClear()
    const entrada = capturarEntrada(bundle, receptor as IssueReceptor, ORDER_ID)
    expect(entrada.montosPorRenglon).toEqual([
      { orderItemId: 'a', totalCents: 4999, porTratamiento: { IVA_16: 4999 } },
      { orderItemId: 'b', totalCents: 10001, porTratamiento: { IVA_16: 10001 } },
    ])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no suman el total de la factura'))
  })

  it('control — M4: lo normal (suma = total) no avisa', async () => {
    ;(logger.warn as jest.Mock).mockClear()
    const { entrada } = await capturar(ordenDe([renglon({ id: 'a', unitPrice: D(100), total: D(100) })]))
    expect(entrada.montosPorRenglon).toEqual([{ orderItemId: 'a', totalCents: 10000, porTratamiento: { IVA_16: 10000 } }])
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('montosPorRenglon'))
  })
})
