/**
 * S10 (P2-4): el cotizador conoce a la clienta. La cadena de beneficios (`aplicarBeneficiosEnTx`), la oferta y la cotización con su
 * simulación. Aquí se prueban el orden fijo, los modos tolerante (cotizar) y estricto (crear el folio, S11), la traba que sube, lo que
 * la simulación NO bloquea (R9) y la degradación por carga (R5'', R8'). Los importes en centavos y «sin rastro» van contra Postgres en
 * `tests/integration/online-ordering/cotizacion.integration.test.ts`.
 */
import fs from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import AppError, { BadRequestError } from '@/errors/AppError'
import logger from '@/config/logger'

jest.mock('@/services/dashboard/discountEngine.service', () => ({ aplicarDescuentosDelMotorEnTx: jest.fn() }))
jest.mock('@/services/shared/cuponDeLaVenta', () => ({
  ...jest.requireActual('@/services/shared/cuponDeLaVenta'),
  cuponDeLaVenta: jest.fn(),
  apartarCupon: jest.fn(),
  bloquearDescuentoDelCupon: jest.fn(),
}))
jest.mock('@/services/wallet/redeemStampReward.service', () => ({ canjearPremioEnTx: jest.fn(), renglonDelPremioEnTx: jest.fn() }))
jest.mock('@/services/mobile/loyalty.mobile.service', () => ({
  redeemPointsToOrderInTransaction: jest.fn(),
  // La regla del canje es pura: la cotización usa la REAL (W7, puntos usables).
  puntosQueSeCanjean: jest.requireActual('@/services/mobile/loyalty.mobile.service').puntosQueSeCanjean,
}))
jest.mock('@/services/shared/repartoDescuentoTx', () => ({
  conservarDescuentoHistorico: jest.fn(),
  sincronizarRepartos: jest.fn(async () => ({ impuestoDevuelto: 0 })),
}))
jest.mock('@/services/shared/serviceCharges', () => ({
  ...jest.requireActual('@/services/shared/serviceCharges'),
  recalcularCargosPorServicio: jest.fn(async () => 0),
}))
jest.mock('@/services/online-ordering/order.service', () => ({
  crearCuentaDelPedidoEnTx: jest.fn(),
  toQuoteSnapshot: jest.fn((q: unknown) => q),
}))
jest.mock('@/services/online-ordering/quote.service', () => ({
  ...jest.requireActual('@/services/online-ordering/quote.service'),
  quoteCart: jest.fn(),
}))

import { aplicarDescuentosDelMotorEnTx } from '@/services/dashboard/discountEngine.service'
import { apartarCupon, bloquearDescuentoDelCupon, cuponDeLaVenta } from '@/services/shared/cuponDeLaVenta'
import { canjearPremioEnTx, renglonDelPremioEnTx } from '@/services/wallet/redeemStampReward.service'
import { puntosQueSeCanjean, redeemPointsToOrderInTransaction } from '@/services/mobile/loyalty.mobile.service'
import { crearCuentaDelPedidoEnTx } from '@/services/online-ordering/order.service'
import { quoteCart, toPublicQuote } from '@/services/online-ordering/quote.service'
import {
  MAX_APLICADOS,
  SIMULACION,
  aplicarBeneficiosEnTx,
  cedeLaSimulacion,
  cotizarConBeneficios,
  simularBeneficios,
  ofertaDeBeneficios,
  topeGlobalDeSimulaciones,
} from '@/services/online-ordering/beneficios.service'
import type { TxConReintento } from '@/utils/serializableRetry'

const D = (v: number | string) => new Prisma.Decimal(v)
const tx = prismaMock as unknown as TxConReintento & Record<string, any>
let trazo: string[] = []
const anota =
  (nombre: string, r?: unknown) =>
  async (...args: unknown[]) => {
    trazo.push(nombre)
    return typeof r === 'function' ? (r as (...a: unknown[]) => unknown)(...args) : r
  }
const traba = () => Object.assign(new Error('deadlock detected'), { code: '40P01' })
const candadoVencido = () =>
  new Prisma.PrismaClientKnownRequestError('lock timeout', { code: 'P2010', clientVersion: 'x', meta: { code: '55P03' } })

const CUPON = {
  id: 'cc-1',
  code: 'DIEZ',
  discount: {
    id: 'd-cupon',
    name: 'Diez',
    type: 'PERCENTAGE',
    value: D(10),
    scope: 'ORDER',
    requiresApproval: false,
    maxDiscountAmount: null,
  },
  minimo: null,
}
const CONFIG = {
  venueId: 'v1',
  active: true,
  stampsEnabled: true,
  redemptionRate: D('0.01'),
  pointsPerDollar: D(1),
  minPointsRedeem: 100,
}
const FILAS = [
  { id: 'od-auto', name: 'Automático', amount: D(10), discountId: 'd-auto', couponCodeId: null, loyaltyTransactionId: null },
  { id: 'od-cupon', name: 'Diez (DIEZ)', amount: D(10), discountId: 'd-cupon', couponCodeId: 'cc-1', loyaltyTransactionId: null },
  { id: 'od-premio', name: 'Café gratis', amount: D(1), discountId: null, couponCodeId: null, loyaltyTransactionId: null },
  { id: 'od-puntos', name: 'Recompensas — 100 puntos', amount: D(1), discountId: null, couponCodeId: null, loyaltyTransactionId: 'lt-1' },
]
const ELECCION = { cupon: 'diez', premioId: 'premio-1', puntos: 100 }
const entrada = (eleccion: Record<string, unknown> = ELECCION) => ({ venueId: 'v1', orderId: 'o-sim', customerId: 'c1', eleccion })
const QUOTE = {
  ok: true,
  lines: [
    {
      productId: 'p1',
      productName: 'Combo',
      productSku: null,
      categoryName: 'Menú',
      quantity: 1,
      unitPrice: D(100),
      modifiers: [],
      note: null,
      lineTotal: D(100),
    },
  ],
  subtotal: D(100),
  total: D(100),
  minOrderAmount: D(0),
  issues: [],
}
const ITEMS = [{ productId: 'p1', quantity: 1 }]

beforeEach(() => {
  trazo = []
  tx.$executeRawUnsafe = jest.fn(anota('sql', 0)) as any
  tx.$executeRaw = jest.fn(anota('set', 0)) as any
  prismaMock.$transaction.mockImplementation((cb: any) => cb(prismaMock))
  prismaMock.loyaltyConfig.findUnique.mockResolvedValue(CONFIG as any)
  prismaMock.couponCode.findFirst.mockResolvedValue({ discountId: 'd-cupon' } as any)
  prismaMock.order.findFirst.mockImplementation((async (a: any) =>
    a?.select?.subtotal
      ? {
          subtotal: D(100),
          discountAmount: D(10),
          taxAmount: D(0),
          tipAmount: D(0),
          paidAmount: D(0),
          contratoDePrecio: 'IVA_INCLUIDO',
          status: 'PENDING',
        }
      : { total: D('78.00') }) as any)
  prismaMock.order.update.mockImplementation(anota('totalesDelCupon', {}) as any)
  prismaMock.orderDiscount.findMany.mockResolvedValue(FILAS as any)
  prismaMock.orderDiscount.create.mockImplementation(anota('filaCupon', { id: 'od-cupon' }) as any)
  prismaMock.stampReward.findFirst.mockResolvedValue({ orderDiscountId: 'od-premio' } as any)
  ;(aplicarDescuentosDelMotorEnTx as jest.Mock).mockImplementation(anota('motor', { applied: [], audits: [] }))
  ;(bloquearDescuentoDelCupon as jest.Mock).mockImplementation(anota('asesorDelCupon'))
  ;(cuponDeLaVenta as jest.Mock).mockImplementation(anota('cupon', CUPON))
  ;(apartarCupon as jest.Mock).mockImplementation(anota('apartar'))
  ;(canjearPremioEnTx as jest.Mock).mockImplementation(anota('premio', {}))
  ;(redeemPointsToOrderInTransaction as jest.Mock).mockImplementation(anota('puntos', {}))
  ;(crearCuentaDelPedidoEnTx as jest.Mock).mockImplementation(anota('cuenta', { orderId: 'o-sim' }))
  ;(quoteCart as jest.Mock).mockResolvedValue(QUOTE)
})

describe('aplicarBeneficiosEnTx — el orden fijo', () => {
  it('motor → cupón → premio → puntos; total y montos LEÍDOS de la cuenta al final, nunca sumando pasos (R1)', async () => {
    const r = await aplicarBeneficiosEnTx(tx, entrada(), {})

    expect(trazo.filter(p => p !== 'sql')).toEqual([
      'asesorDelCupon',
      'motor',
      'cupon',
      'apartar',
      'filaCupon',
      'totalesDelCupon',
      'premio',
      'puntos',
    ])
    // R1: lo que dice la cuenta tras el último recálculo ($78), nunca la suma de lo que devolvió cada paso.
    expect(r.total.toFixed(2)).toBe('78.00')
    expect(r.aplicados.map(a => [a.tipo, a.monto.toFixed(2), a.orderDiscountId])).toEqual([
      ['DESCUENTO', '10.00', 'od-auto'],
      ['CUPON', '10.00', 'od-cupon'],
      ['PREMIO', '1.00', 'od-premio'],
      ['PUNTOS', '1.00', 'od-puntos'],
    ])
    expect(r.descartados).toEqual([])
  })

  it("R1''': los canjes son los helpers de la caja tal cual, con su default (sin opciones nuevas ni recálculo propio)", async () => {
    await aplicarBeneficiosEnTx(tx, entrada(), {})

    expect((canjearPremioEnTx as jest.Mock).mock.calls[0]).toEqual([tx, 'v1', 'o-sim', 'premio-1'])
    const puntos = (redeemPointsToOrderInTransaction as jest.Mock).mock.calls[0]
    // La configuración leída SIN crearla (R4) va en el parámetro de hoy: nunca `getOrCreateLoyaltyConfig` dentro.
    expect(puntos).toEqual([tx, 'v1', 'o-sim', 'c1', 100, undefined, expect.objectContaining({ active: true, redemptionRate: 0.01 })])
    // El cupón se monta como en la caja sobre una cuenta abierta: % de lo que queda ($90), con su tope en el reparto.
    const fila = prismaMock.orderDiscount.create.mock.calls[0][0]!.data as any
    expect(fila).toMatchObject({ orderId: 'o-sim', discountId: 'd-cupon', couponCodeId: 'cc-1', type: 'PERCENTAGE', isManual: false })
    expect(Number(fila.amount)).toBe(9)
    expect(prismaMock.order.update.mock.calls[0][0]).toMatchObject({ where: { id: 'o-sim' }, data: { discountAmount: 19, total: 81 } })
  })

  it('estricto: el asesor del cupón va ANTES del motor y el motor recibe su descuento para la pasada única de Discount', async () => {
    await aplicarBeneficiosEnTx(tx, entrada(), {})

    expect(trazo.indexOf('asesorDelCupon')).toBeLessThan(trazo.indexOf('motor'))
    expect(bloquearDescuentoDelCupon).toHaveBeenCalledWith(tx, 'd-cupon')
    expect(aplicarDescuentosDelMotorEnTx).toHaveBeenCalledWith(tx, {
      venueId: 'v1',
      orderId: 'o-sim',
      bloquearTambien: ['d-cupon'],
      simulacion: false,
    })
    expect((apartarCupon as jest.Mock).mock.calls[0][4]).toEqual({ conCandado: true, usosPropios: 0 })
  })

  it('R9: cotizar (tolerante) no aparta nada compartido: ni asesor del cupón, ni pasada de contadores, ni candado al apartar', async () => {
    await aplicarBeneficiosEnTx(tx, entrada(), { tolerante: true })

    expect(bloquearDescuentoDelCupon).not.toHaveBeenCalled()
    expect(prismaMock.couponCode.findFirst).not.toHaveBeenCalled()
    expect(aplicarDescuentosDelMotorEnTx).toHaveBeenCalledWith(tx, {
      venueId: 'v1',
      orderId: 'o-sim',
      bloquearTambien: [],
      simulacion: true,
    })
    expect((apartarCupon as jest.Mock).mock.calls[0][4]).toEqual({ conCandado: false, usosPropios: 0 })
    expect(prismaMock.discount.update).not.toHaveBeenCalled()
    expect(prismaMock.discount.updateMany).not.toHaveBeenCalled()
  })

  it("R9': la simulación cuenta los usos propios del motor al validar el límite del cupón (sin escribir contadores)", async () => {
    ;(aplicarDescuentosDelMotorEnTx as jest.Mock).mockResolvedValue({
      applied: [{ discountId: 'd-cupon' }, { discountId: 'd-otro' }],
      audits: [],
    })
    await aplicarBeneficiosEnTx(tx, entrada({ cupon: 'diez' }), { tolerante: true })
    expect((apartarCupon as jest.Mock).mock.calls[0][4]).toEqual({ conCandado: false, usosPropios: 1 })

    // En estricto, el motor ya subió el contador bajo candado: no se suman propios.
    ;(apartarCupon as jest.Mock).mockClear()
    await aplicarBeneficiosEnTx(tx, entrada({ cupon: 'diez' }), {})
    expect((apartarCupon as jest.Mock).mock.calls[0][4]).toEqual({ conCandado: true, usosPropios: 0 })
  })

  it('sin elección: sólo el motor (automáticos, de grupo y asignados)', async () => {
    prismaMock.orderDiscount.findMany.mockResolvedValue([FILAS[0]] as any)
    const r = await aplicarBeneficiosEnTx(tx, entrada({}), { tolerante: true })

    expect(trazo.filter(p => p !== 'sql')).toEqual(['motor'])
    expect(r.aplicados.map(a => a.tipo)).toEqual(['DESCUENTO'])
  })

  it('no escribe ni bloquea WalletPass (R55 a): ni por el cliente ni en su código', async () => {
    await aplicarBeneficiosEnTx(tx, entrada(), { tolerante: true })
    for (const fn of Object.values(prismaMock.walletPass)) expect(fn).not.toHaveBeenCalled()
    const fuente = fs.readFileSync(path.join(__dirname, '../../../../src/services/online-ordering/beneficios.service.ts'), 'utf8')
    expect(fuente).not.toMatch(/walletPass\b/)
  })
})

describe('aplicarBeneficiosEnTx — el desglose completo (r5 #2: nada se trunca en silencio)', () => {
  const fila = (i: number, extra: Record<string, unknown> = {}) => ({
    id: `od-${String(i).padStart(3, '0')}`,
    name: `Automático ${i}`,
    amount: D(1),
    couponCodeId: null,
    loyaltyTransactionId: null,
    ...extra,
  })

  it('51 filas (49 automáticos + premio + puntos) ⇒ las 51 en `aplicados`, sin marca de incompleto', async () => {
    const filas = [
      ...Array.from({ length: 49 }, (_, i) => fila(i)),
      fila(49, { id: 'od-premio', name: 'Galleta' }),
      fila(50, { id: 'od-puntos', name: 'Puntos', loyaltyTransactionId: 'lt' }),
    ]
    prismaMock.orderDiscount.findMany.mockResolvedValue(filas as any)
    const r = await aplicarBeneficiosEnTx(tx, entrada({ premioId: 'premio-1', puntos: 100 }), { tolerante: true })

    expect(r.aplicados).toHaveLength(51)
    expect(r.aplicados.slice(-2).map(a => a.tipo)).toEqual(['PREMIO', 'PUNTOS'])
    expect(r).not.toHaveProperty('aplicadosCompletos')
    expect(prismaMock.orderDiscount.findMany.mock.calls[0][0]).toMatchObject({ take: MAX_APLICADOS + 1 })
  })

  it('r6: más filas que el tope ⇒ la cadena lo dice y la cotización entera DEGRADA a calculados:false con el total base (y un warn)', async () => {
    prismaMock.orderDiscount.findMany.mockResolvedValue(Array.from({ length: MAX_APLICADOS + 1 }, (_, i) => fila(i)) as any)
    prismaMock.orderDiscount.count.mockResolvedValue(MAX_APLICADOS + 7)
    // La cadena (también el folio de S11) avisa: el total es el de la cuenta, el desglose no está completo.
    const r = await aplicarBeneficiosEnTx(tx, entrada({}), { tolerante: true })
    expect(r).toMatchObject({ aplicadosCompletos: false, aplicadosTotal: MAX_APLICADOS + 7 })
    expect(r.total.toFixed(2)).toBe('78.00')

    // La cotización no anuncia beneficios con el detalle incompleto: o todo o nada.
    const q = await cotizarConBeneficios('v1', ITEMS, { customerId: 'c1', eleccion: null })
    expect(q).toEqual({ ...QUOTE, beneficios: { calculados: false } })
    expect(toPublicQuote(q)).toEqual({ ...toPublicQuote(QUOTE as any), beneficios: { calculados: false } })
    expect(JSON.stringify(toPublicQuote(q))).not.toMatch(/aplicadosCompletos|aplicadosTotal/)
    expect((logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('desglose') && c[1]?.filas === MAX_APLICADOS + 7)).toBe(
      true,
    )
  })
})

describe('Codex r8 · el desglose recortado nunca se publica como completo', () => {
  const fila = (i: number) => ({
    id: `od-${String(i).padStart(3, '0')}`,
    name: `Automático ${i}`,
    amount: D('0.01'),
    couponCodeId: null,
    loyaltyTransactionId: null,
  })

  it('más de MAX_APLICADOS filas con el premio canjeado FUERA del tope: `premio` lo dice su fila, el desglose no lo trae', async () => {
    prismaMock.orderDiscount.findMany.mockResolvedValue(Array.from({ length: MAX_APLICADOS + 1 }, (_, i) => fila(i)) as any)
    prismaMock.orderDiscount.count.mockResolvedValue(MAX_APLICADOS + 1)
    prismaMock.stampReward.findFirst.mockResolvedValue({ orderDiscountId: 'od-premio-despues-del-tope' } as any)
    const r = await aplicarBeneficiosEnTx(tx, entrada({ premioId: 'premio-1' }), { tolerante: true })
    expect(r).toMatchObject({ aplicadosCompletos: false, premio: true })
    expect(r.aplicados).toHaveLength(MAX_APLICADOS)
    expect(r.aplicados.some(a => a.tipo === 'PREMIO')).toBe(false)
  })

  it('sin premio elegido, `premio` es false', async () => {
    prismaMock.orderDiscount.findMany.mockResolvedValue([fila(0)] as any)
    expect((await aplicarBeneficiosEnTx(tx, entrada({}), { tolerante: true })).premio).toBe(false)
  })

  it('el serializador REAL: con `aplicadosCompletos:false` sale degradada (sin desglose ni oferta, total de lista, calculados:false)', () => {
    const recortada = {
      ...QUOTE,
      totalConBeneficios: D('85.00'),
      aplicados: Array.from({ length: MAX_APLICADOS }, (_, i) => ({
        tipo: 'DESCUENTO' as const,
        nombre: `Automático ${i}`,
        monto: D('0.01'),
        orderDiscountId: `od-${i}`,
      })),
      oferta: { premio: null, puntos: null, cupon: false },
      descartados: [],
      beneficios: { calculados: true },
      aplicadosCompletos: false as const,
    }
    const pub = toPublicQuote(recortada as any)
    expect(pub).toEqual({ ...toPublicQuote(QUOTE as any), beneficios: { calculados: false } })
    expect(pub).not.toHaveProperty('aplicados')
    expect(pub).not.toHaveProperty('oferta')
    expect(JSON.stringify(pub)).not.toMatch(/aplicadosCompletos/)
  })
})

describe('aplicarBeneficiosEnTx — lo que ya no está (codex-plan2-r1 #5)', () => {
  const casos: Array<[string, 'PREMIO' | 'PUNTOS' | 'CUPON', () => void]> = [
    [
      'premio ya canjeado',
      'PREMIO',
      () => (canjearPremioEnTx as jest.Mock).mockRejectedValue(new BadRequestError('Este premio ya fue canjeado.')),
    ],
    [
      'más puntos de los que tiene',
      'PUNTOS',
      () =>
        (redeemPointsToOrderInTransaction as jest.Mock).mockRejectedValue(new BadRequestError('Puntos insuficientes: el cliente tiene 50')),
    ],
    [
      'cupón agotado',
      'CUPON',
      () => (apartarCupon as jest.Mock).mockRejectedValue(new BadRequestError('Este cupón ya alcanzó su límite de usos.')),
    ],
    [
      'cupón por producto (el rechazo de la caja)',
      'CUPON',
      () =>
        (cuponDeLaVenta as jest.Mock).mockRejectedValue(
          new BadRequestError('Este cupón sólo aplica a ciertos productos y todavía no se puede usar en caja.'),
        ),
    ],
  ]

  it.each(casos)('tolerante, %s ⇒ sin error, descartado, su SAVEPOINT deshecho y lo demás aplicado', async (_n, cual, falla) => {
    falla()
    const r = await aplicarBeneficiosEnTx(tx, entrada(), { tolerante: true })

    expect(r.descartados).toEqual([cual])
    const sql = (tx.$executeRawUnsafe as jest.Mock).mock.calls.map(c => c[0])
    expect(sql).toContain(`ROLLBACK TO SAVEPOINT beneficio_${cual.toLowerCase()}`)
    for (const otro of ['CUPON', 'PREMIO', 'PUNTOS'].filter(c => c !== cual)) {
      expect(sql).toContain(`RELEASE SAVEPOINT beneficio_${otro.toLowerCase()}`)
      expect(sql).not.toContain(`ROLLBACK TO SAVEPOINT beneficio_${otro.toLowerCase()}`)
    }
    // Los demás canjes sí corrieron.
    if (cual !== 'PREMIO') expect(canjearPremioEnTx).toHaveBeenCalled()
    if (cual !== 'PUNTOS') expect(redeemPointsToOrderInTransaction).toHaveBeenCalled()
  })

  it.each(casos)('estricto, %s ⇒ BENEFIT_UNAVAILABLE 409 con el texto de la caja y `cual`', async (_n, cual, falla) => {
    falla()
    const e = await aplicarBeneficiosEnTx(tx, entrada(), {}).catch(x => x)

    expect(e).toBeInstanceOf(AppError)
    expect(e).toMatchObject({ statusCode: 409, code: 'BENEFIT_UNAVAILABLE', details: { cual } })
    expect(e.message).not.toBe('')
    expect((tx.$executeRawUnsafe as jest.Mock).mock.calls.map(c => c[0]).join()).not.toMatch(/SAVEPOINT/)
  })

  it('R63: una traba (40P01) dentro del SAVEPOINT de un canje SUBE tal cual: no se anota como descartado ni se deshace el SAVEPOINT', async () => {
    const t = traba()
    ;(canjearPremioEnTx as jest.Mock).mockRejectedValue(t)

    await expect(aplicarBeneficiosEnTx(tx, entrada(), { tolerante: true })).rejects.toBe(t)
    expect((tx.$executeRawUnsafe as jest.Mock).mock.calls.map(c => c[0])).not.toContain('ROLLBACK TO SAVEPOINT beneficio_premio')
    expect(redeemPointsToOrderInTransaction).not.toHaveBeenCalled()
  })

  it("R5'': un candado vencido (55P03) tampoco se convierte en descarte", async () => {
    const e = candadoVencido()
    ;(redeemPointsToOrderInTransaction as jest.Mock).mockRejectedValue(e)
    await expect(aplicarBeneficiosEnTx(tx, entrada(), { tolerante: true })).rejects.toBe(e)
  })
})

describe('aplicarBeneficiosEnTx — R2 y R3: lo que la oferta oculta tampoco se aplica', () => {
  it('R2: un cupón que pide aprobación no se aplica (tolerante: descartado; estricto: BENEFIT_UNAVAILABLE)', async () => {
    ;(cuponDeLaVenta as jest.Mock).mockResolvedValue({ ...CUPON, discount: { ...CUPON.discount, requiresApproval: true } })

    const r = await aplicarBeneficiosEnTx(tx, entrada({ cupon: 'diez' }), { tolerante: true })
    expect(r.descartados).toEqual(['CUPON'])
    expect(apartarCupon).not.toHaveBeenCalled()
    expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()

    await expect(aplicarBeneficiosEnTx(tx, entrada({ cupon: 'diez' }), {})).rejects.toMatchObject({
      code: 'BENEFIT_UNAVAILABLE',
      details: { cual: 'CUPON' },
    })
  })

  it('R2: una cortesía (COMP) por cupón tampoco: en la tienda nadie tiene el permiso de cortesía', async () => {
    ;(cuponDeLaVenta as jest.Mock).mockResolvedValue({ ...CUPON, discount: { ...CUPON.discount, type: 'COMP' } })
    const r = await aplicarBeneficiosEnTx(tx, entrada({ cupon: 'diez' }), { tolerante: true })
    expect(r.descartados).toEqual(['CUPON'])
  })

  it('R3: con los sellos apagados el premio no se canjea (tolerante: descartado; estricto: rechazo)', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ ...CONFIG, stampsEnabled: false } as any)

    const r = await aplicarBeneficiosEnTx(tx, entrada({ premioId: 'premio-1' }), { tolerante: true })
    expect(r.descartados).toEqual(['PREMIO'])
    expect(canjearPremioEnTx).not.toHaveBeenCalled()
    await expect(aplicarBeneficiosEnTx(tx, entrada({ premioId: 'premio-1' }), {})).rejects.toMatchObject({
      details: { cual: 'PREMIO' },
    })
  })

  it('R3: con el programa de puntos apagado (o sin configuración) los puntos no se canjean', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ ...CONFIG, active: false } as any)
    expect((await aplicarBeneficiosEnTx(tx, entrada({ puntos: 100 }), { tolerante: true })).descartados).toEqual(['PUNTOS'])

    prismaMock.loyaltyConfig.findUnique.mockResolvedValue(null)
    const r = await aplicarBeneficiosEnTx(tx, entrada({ puntos: 100, premioId: 'premio-1' }), { tolerante: true })
    expect(r.descartados).toEqual(['PREMIO', 'PUNTOS'])
    expect(redeemPointsToOrderInTransaction).not.toHaveBeenCalled()
    expect(prismaMock.loyaltyConfig.create).not.toHaveBeenCalled()
  })
})

describe('W7 · puntos usables: la regla del canje (`puntosQueSeCanjean`)', () => {
  it('500 puntos a $0.10 con $15 por descontar ⇒ se usan 150 (−$15), no 500 (−$50)', () => {
    expect(puntosQueSeCanjean(500, 0.1, 15)).toEqual({ puntos: 150, monto: 15 })
  })
  it('si caben todos, se usan todos', () => {
    expect(puntosQueSeCanjean(500, 0.1, 80)).toEqual({ puntos: 500, monto: 50 })
  })
  it('sin nada por descontar ⇒ 0 y 0 (el canje lo rechaza)', () => {
    expect(puntosQueSeCanjean(300, 0.01, 0)).toEqual({ puntos: 0, monto: 0 })
    expect(puntosQueSeCanjean(300, 0.01, -2)).toEqual({ puntos: 0, monto: 0 })
  })
  it('con centavos: $18.22 a $0.01 ⇒ ⌈18.22 / 0.01⌉ puntos, la misma aritmética que quema el canje', () => {
    expect(puntosQueSeCanjean(5000, 0.01, 18.22)).toEqual({ puntos: Math.ceil(18.22 / 0.01), monto: 18.22 })
  })
})

describe('ofertaDeBeneficios — lectura pura', () => {
  beforeEach(() => {
    prismaMock.customer.findFirst.mockResolvedValue({ loyaltyPoints: 250 } as any)
    prismaMock.stampReward.findFirst.mockResolvedValue({ id: 'premio-1', rewardLabel: 'Café gratis' } as any)
    prismaMock.couponCode.findFirst.mockResolvedValue({ id: 'cc-1' } as any)
  })

  it('trae el premio sólo con los sellos prendidos, y sólo uno PENDING y vigente', async () => {
    const o = await ofertaDeBeneficios('v1', 'c1')
    expect(o.premio).toEqual({ id: 'premio-1', etiqueta: 'Café gratis' })
    const where = prismaMock.stampReward.findFirst.mock.calls[0][0]!.where as any
    expect(where).toMatchObject({ venueId: 'v1', customerId: 'c1', status: 'PENDING' })
    expect(JSON.stringify(where)).toMatch(/expiresAt/)

    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ ...CONFIG, stampsEnabled: false } as any)
    prismaMock.stampReward.findFirst.mockClear()
    expect((await ofertaDeBeneficios('v1', 'c1')).premio).toBeNull()
    expect(prismaMock.stampReward.findFirst).not.toHaveBeenCalled()
  })

  it('los puntos bajo el mínimo no se ofrecen; arriba, con su valor', async () => {
    expect((await ofertaDeBeneficios('v1', 'c1')).puntos).toEqual({ saldo: 250, minimo: 100, valorPorPunto: 0.01, maxPuntos: 250 })
    prismaMock.customer.findFirst.mockResolvedValue({ loyaltyPoints: 99 } as any)
    expect((await ofertaDeBeneficios('v1', 'c1')).puntos).toBeNull()
  })

  it('el campo de cupón sólo si el negocio tiene un cupón vigente que la tienda puede aplicar', async () => {
    expect((await ofertaDeBeneficios('v1', 'c1')).cupon).toBe(true)
    const where = prismaMock.couponCode.findFirst.mock.calls[0][0]!.where as any
    expect(where).toMatchObject({ active: true, discount: { venueId: 'v1', active: true, scope: 'ORDER', requiresApproval: false } })
    prismaMock.couponCode.findFirst.mockResolvedValue(null)
    expect((await ofertaDeBeneficios('v1', 'c1')).cupon).toBe(false)
  })

  it('R4: sin configuración de lealtad no la crea (nunca getOrCreateLoyaltyConfig): sin premio ni puntos', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue(null)
    const o = await ofertaDeBeneficios('v1', 'c1')
    expect(o).toMatchObject({ premio: null, puntos: null })
    expect(prismaMock.loyaltyConfig.create).not.toHaveBeenCalled()
    expect(prismaMock.loyaltyConfig.upsert).not.toHaveBeenCalled()
  })
})

describe('cotizarConBeneficios', () => {
  it('sin sesión: la cotización de hoy (total = subtotal), sin aplicados, oferta ni simulación', async () => {
    const q = await cotizarConBeneficios('v1', ITEMS, { customerId: null, eleccion: ELECCION })

    expect(q).toEqual(QUOTE)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(toPublicQuote(q)).not.toHaveProperty('aplicados')
    expect(toPublicQuote(q)).not.toHaveProperty('beneficios')
  })

  it('un carrito con problemas no se simula', async () => {
    ;(quoteCart as jest.Mock).mockResolvedValue({ ...QUOTE, ok: false })
    await cotizarConBeneficios('v1', ITEMS, { customerId: 'c1', eleccion: null })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it("con sesión: simula en una transacción acotada (R5''), la cuenta provisional va primero (R6) y nunca lanza BENEFIT_UNAVAILABLE", async () => {
    ;(canjearPremioEnTx as jest.Mock).mockRejectedValue(new BadRequestError('Este premio ya fue canjeado.'))

    const q = await cotizarConBeneficios('v1', ITEMS, { customerId: 'c1', eleccion: ELECCION })

    expect(prismaMock.$transaction.mock.calls[0][1]).toEqual({ maxWait: 300, timeout: 800 })
    expect((tx.$executeRaw as jest.Mock).mock.calls.map((c: any[]) => c[0].join('?'))).toEqual([
      "SET LOCAL lock_timeout = '200ms'",
      "SET LOCAL statement_timeout = '500ms'",
    ])
    // R6: el KEY SHARE de Customer (la cuenta con customerId) es lo PRIMERO que toma la simulación.
    expect(trazo.filter(p => !['sql', 'set'].includes(p))[0]).toBe('cuenta')
    const cuenta = (crearCuentaDelPedidoEnTx as jest.Mock).mock.calls[0][1]
    expect(cuenta).toMatchObject({ venueId: 'v1', customerId: 'c1' })
    expect(cuenta.orderNumber).toMatch(/^COTIZACION-c[a-z0-9]{24}$/)
    expect(q).toMatchObject({ beneficios: { calculados: true }, descartados: ['PREMIO'] })
    expect(q.totalConBeneficios!.toFixed(2)).toBe('78.00')
    expect(q.oferta).toBeDefined()
    // El público ve el total CON beneficios.
    expect(toPublicQuote(q)).toMatchObject({ subtotal: 100, total: 78, descartados: ['PREMIO'], beneficios: { calculados: true } })
  })

  it('R63: una traba en un canje repite la cotización ENTERA y da lo mismo que sin traba', async () => {
    const limpia = await cotizarConBeneficios('v1', ITEMS, { customerId: 'c1', eleccion: ELECCION })
    ;(crearCuentaDelPedidoEnTx as jest.Mock).mockClear()
    ;(canjearPremioEnTx as jest.Mock).mockRejectedValueOnce(traba()).mockImplementation(anota('premio', {}))

    const conTraba = await cotizarConBeneficios('v1', ITEMS, { customerId: 'c1', eleccion: ELECCION })

    expect(crearCuentaDelPedidoEnTx).toHaveBeenCalledTimes(2)
    expect(conTraba.descartados).toEqual([])
    expect(conTraba.totalConBeneficios!.toFixed(2)).toBe(limpia.totalConBeneficios!.toFixed(2))
    expect(conTraba.aplicados).toEqual(limpia.aplicados)
  })

  it("R5'': un candado vencido (55P03) o el tiempo agotado ⇒ la cotización de hoy con calculados:false, sin reintento ni descartados", async () => {
    for (const error of [
      candadoVencido(),
      new Prisma.PrismaClientKnownRequestError('Transaction already closed', { code: 'P2028', clientVersion: 'x' }),
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    ]) {
      ;(crearCuentaDelPedidoEnTx as jest.Mock).mockClear()
      ;(redeemPointsToOrderInTransaction as jest.Mock).mockRejectedValueOnce(error)

      const q = await cotizarConBeneficios('v1', ITEMS, { customerId: 'c1', eleccion: ELECCION })

      expect(crearCuentaDelPedidoEnTx).toHaveBeenCalledTimes(1)
      expect(q).toEqual({ ...QUOTE, beneficios: { calculados: false } })
      expect(toPublicQuote(q).total).toBe(100)
    }
  })

  it('r5 #1: el pool saturado (P2024) o la conexión caída (P1001, P1017) al leer la OFERTA ⇒ la cotización de hoy, calculados:false', async () => {
    const infra = [
      new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool', {
        code: 'P2024',
        clientVersion: 'x',
      }),
      new Prisma.PrismaClientInitializationError("Can't reach database server", 'x', 'P1001'),
      new Prisma.PrismaClientKnownRequestError('Server has closed the connection', { code: 'P1017', clientVersion: 'x' }),
    ]
    for (const error of infra) {
      prismaMock.loyaltyConfig.findUnique.mockRejectedValueOnce(error)
      const q = await cotizarConBeneficios('v1', ITEMS, { customerId: 'c1', eleccion: ELECCION })
      expect(q).toEqual({ ...QUOTE, beneficios: { calculados: false } })
      expect(toPublicQuote(q).total).toBe(100)
    }
    // Y lo mismo si la infraestructura cae DENTRO de la simulación.
    ;(crearCuentaDelPedidoEnTx as jest.Mock).mockRejectedValueOnce(infra[0])
    expect(await cotizarConBeneficios('v1', ITEMS, { customerId: 'c1', eleccion: null })).toEqual({
      ...QUOTE,
      beneficios: { calculados: false },
    })
  })

  it('r6: el warn de la degradación lleva el código también de un PrismaClientInitializationError (errorCode)', async () => {
    prismaMock.loyaltyConfig.findUnique.mockRejectedValueOnce(
      new Prisma.PrismaClientInitializationError("Can't reach database server", 'x', 'P1001'),
    )
    await cotizarConBeneficios('v1', ITEMS, { customerId: 'c1', eleccion: null })
    expect((logger.warn as jest.Mock).mock.calls.find(c => String(c[0]).includes('cedió'))?.[1]).toMatchObject({ codigo: 'P1001' })
  })

  it('r5 #1: un error de programación (TypeError) o de negocio en la oferta NO se esconde: sube', async () => {
    prismaMock.loyaltyConfig.findUnique.mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'x')"))
    await expect(cotizarConBeneficios('v1', ITEMS, { customerId: 'c1', eleccion: null })).rejects.toThrow(TypeError)
    prismaMock.loyaltyConfig.findUnique.mockRejectedValueOnce(new BadRequestError('otra cosa'))
    await expect(cotizarConBeneficios('v1', ITEMS, { customerId: 'c1', eleccion: null })).rejects.toThrow('otra cosa')
  })

  it('cualquier otro error sale tal cual (no se disfraza de degradación)', async () => {
    ;(crearCuentaDelPedidoEnTx as jest.Mock).mockRejectedValue(new Error('boom'))
    await expect(cotizarConBeneficios('v1', ITEMS, { customerId: 'c1', eleccion: null })).rejects.toThrow('boom')
  })
})

describe("cotizarConBeneficios — lugares (R5'' por negocio, R8' global por el pool)", () => {
  const original = { ...SIMULACION }
  afterEach(() => Object.assign(SIMULACION, original))

  /** Cada simulación espera su propia compuerta; así se ve cuántas corren a la vez. */
  function compuertas() {
    const abiertas: Array<() => void> = []
    ;(crearCuentaDelPedidoEnTx as jest.Mock).mockImplementation(
      () => new Promise(resolve => abiertas.push(() => resolve({ orderId: 'o-sim' }))),
    )
    return {
      corriendo: () => abiertas.length,
      abrirTodas: () => abiertas.splice(0).forEach(a => a()),
    }
  }
  const cotiza = (venueId: string) => cotizarConBeneficios(venueId, ITEMS, { customerId: 'c1', eleccion: null })

  it('2 por negocio: la tercera del mismo negocio espera ≤ 300 ms y responde calculados:false; al soltar, hay lugar otra vez', async () => {
    SIMULACION.global = 10
    const c = compuertas()
    const a = cotiza('v1')
    const b = cotiza('v1')
    const tercera = await cotiza('v1')

    expect(tercera.beneficios).toEqual({ calculados: false })
    expect(c.corriendo()).toBe(2)
    c.abrirTodas()
    expect((await a).beneficios).toEqual({ calculados: true })
    expect((await b).beneficios).toEqual({ calculados: true })
    ;(crearCuentaDelPedidoEnTx as jest.Mock).mockImplementation(anota('cuenta', { orderId: 'o-sim' }))
    expect((await cotiza('v1')).beneficios).toEqual({ calculados: true })
  })

  it('una que espera toma el lugar que se suelta dentro de los 300 ms', async () => {
    SIMULACION.porNegocio = 1
    const c = compuertas()
    const a = cotiza('v1')
    const b = cotiza('v1')
    await new Promise(r => setTimeout(r, 50))
    c.abrirTodas()
    await a
    await new Promise(r => setTimeout(r, 20))
    c.abrirTodas()
    expect((await b).beneficios).toEqual({ calculados: true })
  })

  it("R8': el tope global corta entre negocios distintos", async () => {
    SIMULACION.global = 1
    const c = compuertas()
    const a = cotiza('v1')
    const otro = await cotiza('v2')

    expect(otro.beneficios).toEqual({ calculados: false })
    expect(c.corriendo()).toBe(1)
    c.abrirTodas()
    expect((await a).beneficios).toEqual({ calculados: true })
  })

  it("R8''': el tope global es ⌊pool / 6⌋ del connection_limit EXPLÍCITO de la URL resuelta (puede ser 0); sin él, 0", () => {
    expect(topeGlobalDeSimulaciones('postgresql://u:p@h/db?connection_limit=18')).toBe(3)
    expect(topeGlobalDeSimulaciones('postgresql://u:p@h/db?connection_limit=3')).toBe(0)
    expect(topeGlobalDeSimulaciones('postgresql://u:p@h/db?connection_limit=1')).toBe(0)
    expect(topeGlobalDeSimulaciones('postgresql://u:p@h/db?sslmode=require&connection_limit=30')).toBe(5)
    expect(topeGlobalDeSimulaciones('postgresql://u:p@h/db?pgbouncer=true&connection_limit=12')).toBe(2)
    // Sin límite explícito (el camino de pgbouncer, o sin URL) no se puede saber el pool: ninguna simulación.
    expect(topeGlobalDeSimulaciones('postgresql://u:p@h/db?pgbouncer=true')).toBe(0)
    expect(topeGlobalDeSimulaciones('postgresql://u:p@h/db?connection_limit=')).toBe(0)
    expect(topeGlobalDeSimulaciones(undefined)).toBe(0)
    // El de este proceso: `buildDatasourceUrl` le pone 18 a la URL de las pruebas.
    expect(SIMULACION.global).toBe(3)
  })

  it("R8'': con tope 0 responde calculados:false directo, sin abrir transacción ni leer la oferta", async () => {
    SIMULACION.global = 0
    const q = await cotiza('v1')
    expect(q).toEqual({ ...QUOTE, beneficios: { calculados: false } })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.loyaltyConfig.findUnique).not.toHaveBeenCalled()
  })
})

describe('toPublicQuote con beneficios', () => {
  it('agrega aplicados (sin ids internos), oferta, descartados y beneficios; total = el total con beneficios', () => {
    const pub = toPublicQuote({
      ...QUOTE,
      totalConBeneficios: D('78.5'),
      aplicados: [{ tipo: 'CUPON', nombre: 'Diez (DIEZ)', monto: D('10'), orderDiscountId: 'od-x' }],
      oferta: { premio: null, puntos: null, cupon: true },
      descartados: ['PUNTOS'],
      beneficios: { calculados: true },
    } as any)

    expect(pub).toMatchObject({
      subtotal: 100,
      total: 78.5,
      aplicados: [{ tipo: 'CUPON', nombre: 'Diez (DIEZ)', monto: 10 }],
      oferta: { premio: null, puntos: null, cupon: true },
      descartados: ['PUNTOS'],
      beneficios: { calculados: true },
    })
    expect(JSON.stringify(pub)).not.toContain('od-x')
  })
})

/**
 * D8 (11-nov): la tienda pinta «Va en tu Latte» (antes de elegir el premio) y «Café gratis en tu Latte» con su renglón «Gratis»
 * (después). El renglón lo elige P11 al canjear; aquí se traduce al índice del carrito (`OrderItem.sequence` = el índice de `items`
 * que mandó la tienda, como el `lineIndex` de los avisos) y se publica OPCIONAL.
 */
describe('D8 · en qué renglón del carrito cae el premio', () => {
  beforeEach(() => {
    prismaMock.orderItem.findFirst.mockResolvedValue({ sequence: 1 } as any)
    ;(renglonDelPremioEnTx as jest.Mock).mockImplementation(anota('destinoDelPremio', 'oi-latte'))
  })

  it('lo aplicado de tipo PREMIO trae el índice del renglón premiado; los demás no traen renglón', async () => {
    ;(canjearPremioEnTx as jest.Mock).mockImplementation(anota('premio', { renglonPremiadoId: 'oi-latte' }))

    const r = await aplicarBeneficiosEnTx(tx, entrada(), { tolerante: true })

    expect(prismaMock.orderItem.findFirst.mock.calls[0][0]).toMatchObject({ where: { id: 'oi-latte', orderId: 'o-sim' } })
    expect(r.aplicados.map(a => [a.tipo, a.lineIndex])).toEqual([
      ['DESCUENTO', undefined],
      ['CUPON', undefined],
      ['PREMIO', 1],
      ['PUNTOS', undefined],
    ])
    // Elegido, no se vuelve a calcular dónde caería.
    expect(renglonDelPremioEnTx).not.toHaveBeenCalled()
  })

  it('un premio de cuenta (% o monto) no tiene renglón: PREMIO sin lineIndex y sin consulta', async () => {
    ;(canjearPremioEnTx as jest.Mock).mockImplementation(anota('premio', { renglonPremiadoId: null }))
    const r = await aplicarBeneficiosEnTx(tx, entrada(), { tolerante: true })
    expect(r.aplicados.find(a => a.tipo === 'PREMIO')).not.toHaveProperty('lineIndex')
    expect(prismaMock.orderItem.findFirst).not.toHaveBeenCalled()
  })

  it('cotizar con el premio OFRECIDO y no elegido: dónde caería, en el MISMO punto de la cadena (tras el cupón, antes de los puntos), sin canjearlo', async () => {
    const r = await aplicarBeneficiosEnTx(tx, entrada({ cupon: 'diez', puntos: 100 }), { tolerante: true, premioOfrecido: 'premio-1' })

    expect(trazo.filter(p => p !== 'sql')).toEqual([
      'motor',
      'cupon',
      'apartar',
      'filaCupon',
      'totalesDelCupon',
      'destinoDelPremio',
      'puntos',
    ])
    expect(renglonDelPremioEnTx).toHaveBeenCalledWith(tx, 'v1', 'o-sim', 'premio-1')
    expect(canjearPremioEnTx).not.toHaveBeenCalled()
    expect(r.premioOfrecidoEn).toBe(1)
  })

  it('en estricto (crear el folio) nunca se calcula dónde caería un premio no elegido', async () => {
    const r = await aplicarBeneficiosEnTx(tx, entrada({}), { premioOfrecido: 'premio-1' } as any)
    expect(renglonDelPremioEnTx).not.toHaveBeenCalled()
    expect(r).not.toHaveProperty('premioOfrecidoEn')
  })

  describe('cotizarConBeneficios y lo público', () => {
    beforeEach(() => {
      // La oferta lee el premio con su etiqueta; la cadena, la fila de su descuento.
      prismaMock.stampReward.findFirst.mockImplementation((async (a: any) =>
        a?.select?.rewardLabel ? { id: 'premio-1', rewardLabel: 'Café gratis' } : { orderDiscountId: 'od-premio' }) as any)
    })

    it('antes de elegirlo: la oferta dice en qué renglón caería («Va en tu Latte»)', async () => {
      const q = await cotizarConBeneficios('v1', ITEMS, { customerId: 'c1', eleccion: null })

      expect(q.oferta?.premio).toEqual({ id: 'premio-1', etiqueta: 'Café gratis', lineIndex: 1 })
      expect(renglonDelPremioEnTx).toHaveBeenCalledWith(tx, 'v1', 'o-sim', 'premio-1')
      expect(toPublicQuote(q).oferta?.premio).toEqual({ id: 'premio-1', etiqueta: 'Café gratis', lineIndex: 1 })
    })

    it('ya elegido: lo aplicado y la oferta dicen el MISMO renglón; los demás beneficios, ninguno', async () => {
      ;(canjearPremioEnTx as jest.Mock).mockImplementation(anota('premio', { renglonPremiadoId: 'oi-latte' }))

      const pub = toPublicQuote(
        await cotizarConBeneficios('v1', ITEMS, { customerId: 'c1', eleccion: { ...ELECCION, premioId: 'premio-1' } }),
      )

      expect(pub.aplicados).toEqual([
        { tipo: 'DESCUENTO', nombre: 'Automático', monto: 10 },
        { tipo: 'CUPON', nombre: 'Diez (DIEZ)', monto: 10 },
        { tipo: 'PREMIO', nombre: 'Café gratis', monto: 1, lineIndex: 1 },
        { tipo: 'PUNTOS', nombre: 'Recompensas — 100 puntos', monto: 1 },
      ])
      expect(pub.oferta?.premio).toEqual({ id: 'premio-1', etiqueta: 'Café gratis', lineIndex: 1 })
      expect(renglonDelPremioEnTx).not.toHaveBeenCalled()
    })

    it('un premio de cuenta (% o monto): la oferta sale como hoy, sin lineIndex', async () => {
      ;(renglonDelPremioEnTx as jest.Mock).mockResolvedValue(null)
      const pub = toPublicQuote(await cotizarConBeneficios('v1', ITEMS, { customerId: 'c1', eleccion: null }))
      expect(pub.oferta?.premio).toEqual({ id: 'premio-1', etiqueta: 'Café gratis' })
    })
  })
})

describe('S11 · R7: en estricto, la cadena devuelve la bitácora de cada canje real (la del motor, el cupón, el premio y los puntos)', () => {
  it('estricto: una auditoría por canje, como sus envoltorios públicos; tolerante (cotizar): ninguna', async () => {
    const delMotor = {
      staffId: null,
      venueId: 'v1',
      action: 'DISCOUNT_APPLIED',
      entity: 'Order',
      entityId: 'o-sim',
      data: { discountId: 'd-auto' },
    }
    ;(aplicarDescuentosDelMotorEnTx as jest.Mock).mockImplementation(anota('motor', { applied: [], audits: [delMotor] }))
    ;(canjearPremioEnTx as jest.Mock).mockImplementation(
      anota('premio', { reward: { customerId: 'c1', rewardType: 'FIXED_AMOUNT', rewardLabel: 'Café gratis' }, discountAmount: 1 }),
    )
    ;(redeemPointsToOrderInTransaction as jest.Mock).mockImplementation(anota('puntos', { pointsToBurn: 100, discountAmount: 1 }))

    const r = await aplicarBeneficiosEnTx(tx, entrada(), {})
    expect(r.auditorias).toEqual([
      delMotor,
      {
        staffId: null,
        venueId: 'v1',
        action: 'DISCOUNT_APPLIED',
        entity: 'Order',
        entityId: 'o-sim',
        data: { discountId: 'd-cupon', couponCodeId: 'cc-1', amount: 9, source: 'coupon' },
      },
      {
        staffId: null,
        venueId: 'v1',
        action: 'STAMP_REWARD_REDEEMED',
        entity: 'StampReward',
        entityId: 'premio-1',
        data: { orderId: 'o-sim', customerId: 'c1', rewardType: 'FIXED_AMOUNT', rewardLabel: 'Café gratis', discountAmount: 1 },
      },
      {
        staffId: null,
        venueId: 'v1',
        action: 'LOYALTY_POINTS_REDEEMED',
        entity: 'Order',
        entityId: 'o-sim',
        data: { customerId: 'c1', points: 100, discountAmount: 1 },
      },
    ])
    const simulada = await aplicarBeneficiosEnTx(tx, entrada(), { tolerante: true })
    expect(simulada).not.toHaveProperty('auditorias')
  })
})

describe("S11 · R2'': la simulación del borrador de tarjeta (sin semáforo ni degradación de S10)", () => {
  it('con lugar: la cuenta provisional + la cadena tolerante, deshecha; sin la degradación de S10 (no lee la oferta)', async () => {
    const antes = SIMULACION.global
    SIMULACION.global = 1
    try {
      ;(canjearPremioEnTx as jest.Mock).mockRejectedValue(new BadRequestError('Este premio ya fue canjeado.'))
      const r = await simularBeneficios('v1', QUOTE as any, 'c1', ELECCION)
      expect(r!.total.toFixed(2)).toBe('78.00')
      expect(r!.descartados).toEqual(['PREMIO'])
      expect(trazo.filter(p => !['sql', 'set'].includes(p))[0]).toBe('cuenta')
      expect((crearCuentaDelPedidoEnTx as jest.Mock).mock.calls[0][1].orderNumber).toMatch(/^COTIZACION-c[a-z0-9]{24}$/)
      expect(prismaMock.stampReward.findFirst).not.toHaveBeenCalledWith(expect.objectContaining({ orderBy: expect.anything() }))
    } finally {
      SIMULACION.global = antes
    }
  })

  it("R2''': comparte el semáforo de S10: con tope 0 (pool sin límite explícito) no abre transacción y responde null", async () => {
    const antes = SIMULACION.global
    SIMULACION.global = 0
    try {
      expect(await simularBeneficios('v1', QUOTE as any, 'c1', ELECCION)).toBeNull()
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
    } finally {
      SIMULACION.global = antes
    }
  })

  it('un error de infraestructura SUBE (el borrador responde 503) y suelta su lugar; cedeLaSimulacion lo reconoce', async () => {
    const antes = SIMULACION.global
    SIMULACION.global = 1
    try {
      ;(crearCuentaDelPedidoEnTx as jest.Mock).mockRejectedValueOnce(candadoVencido())
      const err = await simularBeneficios('v1', QUOTE as any, 'c1', ELECCION).catch((e: unknown) => e)
      expect(cedeLaSimulacion(err)).toBe(true)
      expect(cedeLaSimulacion(new TypeError('x'))).toBe(false)
      // El lugar se soltó: la siguiente simula.
      expect(await simularBeneficios('v1', QUOTE as any, 'c1', {})).not.toBeNull()
    } finally {
      SIMULACION.global = antes
    }
  })
})
