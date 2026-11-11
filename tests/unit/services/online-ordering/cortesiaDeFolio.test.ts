/**
 * S9 (P2-5): al anular un folio, cada beneficio que se le puede devolver a la clienta regresa a ella y su fila se queda en la cuenta
 * como cortesía del mismo importe, congelada como importe fijo y sin enlaces. La transacción es un doble que guarda lo que escribe:
 * las devoluciones de puntos y premios son las de hoy (reales), así que la prueba ve el saldo, el premio, la bandeja de Wallet y el
 * orden en que se toman los candados. Lo de Postgres va en `anularFolioConBeneficios.integration.test.ts`.
 */
const quitarComoHoy = jest.fn()
jest.mock('@/services/mobile/order.mobile.service', () => ({
  removeOrderDiscountInTransaction: (...a: unknown[]) => quitarComoHoy(...a),
}))

import { Prisma } from '@prisma/client'
import {
  MOTIVO_BENEFICIO_REGRESADO,
  convertirBeneficiosEnCortesiaEnTx,
  sellarFolioAnuladoEnTx,
} from '@/services/online-ordering/cortesiaDeFolio'
import { devolverCanjesDeVentaAnuladaEnTx } from '@/services/shared/orderCancelGuard'
import { importesDeLasFilas } from '@/services/shared/repartoDescuento'
import type { TxConReintento } from '@/utils/serializableRetry'

const D = (v: number | string) => new Prisma.Decimal(v)
const VENUE = 'cvenue000000000000000001a'
const ORDER = 'corder000000000000000001a'
const STAFF = 'cstaff000000000000000001a'
const ANA = 'ccustomerana000000000001a'
const REPARTO = { v: 1, alcance: 'CUENTA', conPromociones: false, espejo: false, renglones: { citem1: 8500 } }

interface Fila {
  id: string
  orderId: string
  amount: Prisma.Decimal
  taxReduction: Prisma.Decimal
  reparto: unknown
  type: string
  value: Prisma.Decimal
  discountId: string | null
  couponCodeId: string | null
  loyaltyTransactionId: string | null
  isComp: boolean
  compReason: string | null
  appliedToItemIds: string[]
}
interface Estado {
  folio: boolean
  filas: Fila[]
  descuentos: Array<{ id: string; venueId: string; currentUses: number; maxTotalUses: number | null; maxUsesPerCustomer: number | null }>
  premios: Array<{
    id: string
    venueId: string
    customerId: string
    stampCardId: string
    status: string
    orderDiscountId: string | null
    redeemedAt: Date | null
    rewardLabel: string
  }>
  cartillas: Array<{ id: string; stampsEarned: number; stampsRequired: number; completedAt: Date | null }>
  movimientos: Array<{ id: string; customerId: string; points: number; orderId: string | null; type: string }>
  clientes: Array<{ id: string; loyaltyPoints: number }>
  bandeja: any[]
  bitacora: any[]
  llamadas: string[]
}

const porId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

function fila(id: string, extra: Partial<Fila> = {}): Fila {
  return {
    id,
    orderId: ORDER,
    amount: D(85),
    taxReduction: D('11.72'),
    reparto: REPARTO,
    type: 'FIXED_AMOUNT',
    value: D(85),
    discountId: null,
    couponCodeId: null,
    loyaltyTransactionId: null,
    isComp: false,
    compReason: null,
    appliedToItemIds: [],
    ...extra,
  }
}

function estado(e: Partial<Estado> = {}): Estado {
  return {
    folio: true,
    filas: [],
    descuentos: [],
    premios: [],
    cartillas: [],
    movimientos: [],
    clientes: [{ id: ANA, loyaltyPoints: 200 }],
    bandeja: [],
    bitacora: [],
    llamadas: [],
    ...e,
  }
}

/** La transacción: lee y escribe sobre `e`, y anota cada candado y escritura en `e.llamadas`. `walletPass` no se puede tocar. */
function txSobre(e: Estado): TxConReintento {
  const prohibido = new Proxy(
    {},
    {
      get: (_t, prop) => {
        e.llamadas.push(`walletPass.${String(prop)}`)
        throw new Error('la conversión no toca walletPass')
      },
    },
  )
  const tx = {
    walletPass: prohibido,
    onlineOrder: {
      findFirst: jest.fn(async () => (e.folio ? { id: 'conline00000000000000001a' } : null)),
      // S9 (A0, B1): el sello de la anulación.
      updateMany: jest.fn(async ({ where }: any) => {
        e.llamadas.push(`sello:${where.orderId}`)
        return { count: e.folio ? 1 : 0 }
      }),
    },
    orderDiscount: {
      findMany: jest.fn(async ({ where, take }: any) => {
        e.llamadas.push('leer')
        expect(where.order).toEqual({ venueId: VENUE })
        return e.filas
          .filter(f => f.orderId === where.orderId && (!where.id?.gt || f.id > where.id.gt))
          .sort(porId)
          .slice(0, take)
          .map(f => {
            const d = e.descuentos.find(x => x.id === f.discountId)
            return {
              id: f.id,
              amount: f.amount,
              discountId: f.discountId,
              couponCodeId: f.couponCodeId,
              loyaltyTransactionId: f.loyaltyTransactionId,
              discount: d ? { maxTotalUses: d.maxTotalUses, maxUsesPerCustomer: d.maxUsesPerCustomer } : null,
            }
          })
      }),
      update: jest.fn(async ({ where, data }: any) => {
        e.llamadas.push(`fila:${where.id}`)
        Object.assign(e.filas.find(f => f.id === where.id)!, data)
        return {}
      }),
    },
    stampReward: {
      findMany: jest.fn(async ({ where }: any) =>
        e.premios
          .filter(p => p.venueId === where.venueId && where.orderDiscountId.in.includes(p.orderDiscountId))
          .map(p => ({ id: p.id, orderDiscountId: p.orderDiscountId })),
      ),
      findFirst: jest.fn(
        async ({ where }: any) => e.premios.find(p => p.orderDiscountId === where.orderDiscountId && p.venueId === where.venueId) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        Object.assign(e.premios.find(p => p.id === where.id)!, data)
        return {}
      }),
    },
    stampCard: {
      findUnique: jest.fn(async ({ where }: any) => e.cartillas.find(c => c.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        Object.assign(e.cartillas.find(c => c.id === where.id)!, data)
        return {}
      }),
    },
    walletPassOutbox: {
      create: jest.fn(async ({ data }: any) => {
        e.bandeja.push(data)
        return data
      }),
    },
    staffVenue: { findUnique: jest.fn(async () => ({ id: 'cstaffvenue00000000000001' })) },
    loyaltyTransaction: {
      findUnique: jest.fn(async ({ where }: any) => e.movimientos.find(m => m.id === where.id) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const m = { id: `cadjust${e.movimientos.length}`, ...data }
        e.movimientos.push(m)
        return m
      }),
    },
    customer: {
      update: jest.fn(async ({ where, data }: any) => {
        e.llamadas.push(`Customer:${where.id}`)
        e.clientes.find(c => c.id === where.id)!.loyaltyPoints += data.loyaltyPoints.increment
        return {}
      }),
    },
    discount: {
      update: jest.fn(async ({ where, data }: any) => {
        e.llamadas.push(`discount.update:${where.id}`)
        e.descuentos.find(d => d.id === where.id)!.currentUses = data.currentUses
        return {}
      }),
    },
    activityLog: {
      create: jest.fn(async ({ data }: any) => {
        e.bitacora.push(data)
        return data
      }),
    },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const sql = strings.join('?')
      if (sql.includes('"StampReward"') && sql.includes('FOR UPDATE')) {
        e.llamadas.push(`StampReward:${vals[0]}`)
        return [{ id: vals[0] }]
      }
      if (sql.includes('FROM "Discount"')) {
        const ids = vals.find(Array.isArray) as string[]
        expect(sql).toContain('FOR NO KEY UPDATE')
        expect(sql).toContain('ORDER BY id')
        expect(vals).toContain(VENUE)
        e.llamadas.push(`Discount:${ids.join(',')}`)
        return e.descuentos
          .filter(d => ids.includes(d.id) && d.venueId === VENUE)
          .sort(porId)
          .map(d => ({ id: d.id, currentUses: d.currentUses, maxTotalUses: d.maxTotalUses }))
      }
      if (sql.includes('FROM "OrderDiscount"')) {
        // La lectura de hoy de `devolverCanjesDeVentaAnuladaEnTx` (cuentas que no son de folio): canjes por id.
        e.llamadas.push('leerCanjesDeHoy')
        return e.filas
          .filter(f => f.loyaltyTransactionId || e.premios.some(p => p.orderDiscountId === f.id))
          .sort(porId)
          .map(f => ({ id: f.id }))
      }
      throw new Error(`SQL inesperado: ${sql}`)
    }),
  }
  return tx as unknown as TxConReintento
}

const convertir = (e: Estado) =>
  convertirBeneficiosEnCortesiaEnTx(txSobre(e), { venueId: VENUE, orderId: ORDER, staffId: STAFF, camino: 'prueba' })

/** Lo que manda «Global Constraints»: cortesía de importe fijo, sin enlaces; importe, IVA y reparto no se tocan. */
const CORTESIA = (amount: Prisma.Decimal) => ({
  isComp: true,
  compReason: MOTIVO_BENEFICIO_REGRESADO,
  type: 'FIXED_AMOUNT',
  value: amount,
  discountId: null,
  couponCodeId: null,
  loyaltyTransactionId: null,
})

/** Un premio canjeado en la fila `od` y su cartilla (llena por omisión). */
function premio(e: Estado, id: string, od: string, cartillaLlena = true) {
  e.cartillas.push({ id: `card-${id}`, stampsEarned: cartillaLlena ? 7 : 6, stampsRequired: 7, completedAt: new Date('2026-11-01') })
  e.premios.push({
    id,
    venueId: VENUE,
    customerId: ANA,
    stampCardId: `card-${id}`,
    status: 'REDEEMED',
    orderDiscountId: od,
    redeemedAt: new Date('2026-11-08'),
    rewardLabel: 'Café gratis',
  })
}

beforeEach(() => {
  quitarComoHoy.mockReset()
})

describe('convertirBeneficiosEnCortesiaEnTx (S9, P2-5)', () => {
  it('puntos: regresan al saldo y la fila queda isComp, FIXED_AMOUNT, value = amount, con el mismo importe, IVA y reparto y sin loyaltyTransactionId', async () => {
    const e = estado({
      filas: [fila('od1', { amount: D(30), taxReduction: D('4.14'), value: D(30), loyaltyTransactionId: 'clt1' })],
      movimientos: [{ id: 'clt1', customerId: ANA, points: -300, orderId: ORDER, type: 'REDEEM' }],
    })

    const r = await convertir(e)

    expect(e.clientes[0].loyaltyPoints).toBe(500)
    expect(e.movimientos.filter(m => m.type === 'ADJUST')).toEqual([
      expect.objectContaining({ customerId: ANA, points: 300, orderId: ORDER }),
    ])
    expect(e.filas[0]).toMatchObject({ ...CORTESIA(D(30)), amount: D(30), taxReduction: D('4.14'), reparto: REPARTO })
    expect(r).toEqual({ filas: 1, montoRegresado: D(30), puntos: 300, premios: [], clientasConPremio: [] })
    expect(e.bitacora).toEqual([
      expect.objectContaining({
        action: 'ONLINE_ORDER_BENEFITS_RETURNED',
        entity: 'Order',
        entityId: ORDER,
        venueId: VENUE,
        staffId: STAFF,
        data: expect.objectContaining({ camino: 'prueba', orderDiscountIds: ['od1'], montoRegresado: '30.00', puntos: 300 }),
      }),
    ])
  })

  it.each([
    [true, 'PENDING'],
    [false, 'CANCELLED'],
  ])('premio (cartilla llena=%s): vuelve a %s, como hoy, y la fila sin enlace', async (llena, esperado) => {
    const e = estado({ filas: [fila('od1')] })
    premio(e, 'csr1', 'od1', llena)

    const r = await convertir(e)

    expect(e.premios[0]).toMatchObject({ status: esperado, orderDiscountId: null, redeemedAt: null })
    if (!llena) expect(e.cartillas[0].completedAt).toBeNull() // la cartilla se reabre (D3)
    expect(e.filas[0]).toMatchObject({ ...CORTESIA(D(85)), amount: D(85), taxReduction: D('11.72'), reparto: REPARTO })
    expect(r).toMatchObject({ filas: 1, puntos: 0, premios: ['csr1'], clientasConPremio: [ANA] })
    expect(r.montoRegresado.toFixed(2)).toBe('85.00')
  })

  it('cupón: la fila sin couponCodeId ni discountId (ya no aparta, cuponDeLaVenta.ts:92) y su descuento no se cuenta (cuenta al pagar)', async () => {
    const e = estado({
      filas: [fila('od1', { discountId: 'cdisc1', couponCodeId: 'ccoupon1', type: 'PERCENTAGE', value: D(10), amount: D(10) })],
      descuentos: [{ id: 'cdisc1', venueId: VENUE, currentUses: 3, maxTotalUses: 10, maxUsesPerCustomer: null }],
    })

    await convertir(e)

    expect(e.filas[0]).toMatchObject(CORTESIA(D(10)))
    expect(e.descuentos[0].currentUses).toBe(3)
    expect(e.llamadas.some(l => l.startsWith('Discount:'))).toBe(false)
  })

  it('descuento con maxTotalUses: currentUses baja una sola vez aunque se llame dos veces', async () => {
    const e = estado({
      filas: [fila('od1', { discountId: 'cdisc1' })],
      descuentos: [{ id: 'cdisc1', venueId: VENUE, currentUses: 1, maxTotalUses: 1, maxUsesPerCustomer: null }],
    })

    await convertir(e)
    const otra = await convertir(e)

    expect(e.descuentos[0].currentUses).toBe(0)
    expect(e.llamadas.filter(l => l === 'discount.update:cdisc1')).toHaveLength(1)
    expect(e.filas[0]).toMatchObject(CORTESIA(D(85)))
    expect(otra).toMatchObject({ filas: 0, puntos: 0, premios: [] })
    expect(e.bitacora).toHaveLength(1) // la segunda no encontró nada que devolver
  })

  it('descuento con maxTotalUses ya en 0: nunca baja de 0', async () => {
    const e = estado({
      filas: [fila('od1', { discountId: 'cdisc1' })],
      descuentos: [{ id: 'cdisc1', venueId: VENUE, currentUses: 0, maxTotalUses: 5, maxUsesPerCustomer: null }],
    })
    await convertir(e)
    expect(e.descuentos[0].currentUses).toBe(0)
  })

  it('descuento con maxUsesPerCustomer: sólo se desliga, sin tocar su contador', async () => {
    const e = estado({
      filas: [fila('od1', { discountId: 'cdisc1' })],
      descuentos: [{ id: 'cdisc1', venueId: VENUE, currentUses: 4, maxTotalUses: null, maxUsesPerCustomer: 1 }],
    })
    await convertir(e)
    expect(e.filas[0]).toMatchObject(CORTESIA(D(85)))
    expect(e.descuentos[0].currentUses).toBe(4)
    expect(e.llamadas.some(l => l.startsWith('Discount:'))).toBe(false)
  })

  it('un 20 % convertido no crece al agregar un producto a la cuenta revivida (repartoDescuento.ts:242, :296)', async () => {
    const veinte = fila('od1', { discountId: 'cdisc1', type: 'PERCENTAGE', value: D(20), amount: D(20), taxReduction: D(0) })
    const e = estado({
      filas: [veinte],
      descuentos: [{ id: 'cdisc1', venueId: VENUE, currentUses: 1, maxTotalUses: null, maxUsesPerCustomer: 1 }],
    })
    const conOtroProducto = [
      { id: 'citem1', total: D(100), productId: 'cprod1' },
      { id: 'citem2', total: D(100), productId: 'cprod2' },
    ] as any
    // Control: sin convertir, el 20 % se vuelve a calcular sobre $200 y crece a $40.
    expect(importesDeLasFilas(conOtroProducto, [{ ...veinte }] as any).descuento).toBe(40)

    await convertir(e)

    expect(importesDeLasFilas(conOtroProducto, [e.filas[0]] as any).descuento).toBe(20)
  })

  it('descuento automático sin límite: se queda igual (historia), sin bitácora', async () => {
    const original = fila('od1', { discountId: 'cdisc1', type: 'PERCENTAGE', value: D(10), amount: D(10) })
    const e = estado({
      filas: [{ ...original }],
      descuentos: [{ id: 'cdisc1', venueId: VENUE, currentUses: 9, maxTotalUses: null, maxUsesPerCustomer: null }],
    })

    const r = await convertir(e)

    expect(e.filas[0]).toEqual(original)
    expect(e.descuentos[0].currentUses).toBe(9)
    expect(r).toEqual({ filas: 0, montoRegresado: D(0), puntos: 0, premios: [], clientasConPremio: [] })
    expect(e.bitacora).toEqual([])
  })

  it('lee TODAS las filas por páginas antes de convertir (una venta con más de una página)', async () => {
    const filas = Array.from({ length: 101 }, (_, i) =>
      fila(`od${String(i).padStart(3, '0')}`, { couponCodeId: `ccoupon${i}`, amount: D(1) }),
    )
    const e = estado({ filas })

    const r = await convertir(e)

    expect(r.filas).toBe(101)
    expect(e.llamadas.filter(l => l === 'leer')).toHaveLength(2)
    // Todas las lecturas van antes de la primera escritura.
    expect(e.llamadas.lastIndexOf('leer')).toBeLessThan(e.llamadas.findIndex(l => l.startsWith('fila:')))
    expect(e.filas.every(f => f.couponCodeId === null && f.isComp)).toBe(true)
  })

  describe('prevención (orden de candados de la parte 2, código nuevo)', () => {
    it('una cuenta de folio con una fila de puntos (id menor), una de premio y descuentos con límite: Discount en UNA pasada ascendente, después el premio y después los puntos', async () => {
      const e = estado({
        filas: [
          fila('od1', { loyaltyTransactionId: 'clt1', amount: D(30) }),
          fila('od2'),
          fila('od3', { discountId: 'cdisc2' }),
          fila('od4', { discountId: 'cdisc1' }),
        ],
        descuentos: [
          { id: 'cdisc2', venueId: VENUE, currentUses: 2, maxTotalUses: 9, maxUsesPerCustomer: null },
          { id: 'cdisc1', venueId: VENUE, currentUses: 2, maxTotalUses: 9, maxUsesPerCustomer: null },
        ],
        movimientos: [{ id: 'clt1', customerId: ANA, points: -300, orderId: ORDER, type: 'REDEEM' }],
      })
      premio(e, 'csr1', 'od2')

      await convertir(e)

      const escrituras = e.llamadas.filter(l => l !== 'leer')
      expect(escrituras.slice(0, 5)).toEqual([
        'Discount:cdisc1,cdisc2',
        'discount.update:cdisc1',
        'discount.update:cdisc2',
        'StampReward:csr1',
        `Customer:${ANA}`,
      ])
      expect(escrituras.filter(l => l.startsWith('Discount:'))).toHaveLength(1)
      expect(escrituras.slice(5).every(l => l.startsWith('fila:'))).toBe(true)
    })

    it('cada premio regresado deja su fila en la bandeja de Wallet; la conversión no toca walletPass', async () => {
      const e = estado({ filas: [fila('od1'), fila('od2')] })
      premio(e, 'csr2', 'od1')
      premio(e, 'csr1', 'od2')

      const r = await convertir(e)

      expect(e.bandeja).toEqual([
        expect.objectContaining({ venueId: VENUE, customerId: ANA, motivo: 'PREMIO_DEVUELTO' }),
        expect.objectContaining({ venueId: VENUE, customerId: ANA, motivo: 'PREMIO_DEVUELTO' }),
      ])
      // Los premios, en orden ascendente de SU id (no del de la fila).
      expect(e.llamadas.filter(l => l.startsWith('StampReward:'))).toEqual(['StampReward:csr1', 'StampReward:csr2'])
      expect(r.premios).toEqual(['csr1', 'csr2'])
      expect(r.clientasConPremio).toEqual([ANA])
      expect(e.llamadas.some(l => l.startsWith('walletPass'))).toBe(false)
    })
  })
})

describe('devolverCanjesDeVentaAnuladaEnTx con S9', () => {
  const devolver = (e: Estado) =>
    devolverCanjesDeVentaAnuladaEnTx(txSobre(e), { venueId: VENUE, orderId: ORDER, staffId: STAFF, camino: 'prueba' })

  it('cuenta de folio: convierte (no borra) y reporta lo devuelto', async () => {
    const e = estado({
      filas: [fila('od1', { loyaltyTransactionId: 'clt1', amount: D(30) }), fila('od2')],
      movimientos: [{ id: 'clt1', customerId: ANA, points: -300, orderId: ORDER, type: 'REDEEM' }],
    })
    premio(e, 'csr1', 'od2')

    const r = await devolver(e)

    expect(quitarComoHoy).not.toHaveBeenCalled()
    expect(e.filas).toHaveLength(2)
    expect(r).toEqual({ pointsRefunded: 300, stampRewardsReturned: ['csr1'], filasQuitadas: 2, clientasConPremio: [ANA] })
  })

  it('cuenta que no es de folio: borra como hoy, recorriendo por OrderDiscount.id', async () => {
    const e = estado({
      folio: false,
      filas: [fila('od2'), fila('od1', { loyaltyTransactionId: 'clt1' })],
      movimientos: [{ id: 'clt1', customerId: ANA, points: -300, orderId: ORDER, type: 'REDEEM' }],
    })
    premio(e, 'csr1', 'od2')
    quitarComoHoy.mockImplementation(async (_tx: unknown, _v: string, _o: string, id: string) => {
      e.filas = e.filas.filter(f => f.id !== id)
      return { refund: id === 'od1' ? { pointsRefunded: 300 } : null, stampRefund: id === 'od2' ? { rewardId: 'csr1' } : null }
    })

    const r = await devolver(e)

    expect(quitarComoHoy.mock.calls.map(c => c[3])).toEqual(['od1', 'od2'])
    expect(quitarComoHoy).toHaveBeenCalledWith(expect.anything(), VENUE, ORDER, 'od1', STAFF, { porAnulacion: true })
    expect(e.filas).toHaveLength(0)
    expect(r).toMatchObject({ pointsRefunded: 300, stampRewardsReturned: ['csr1'], filasQuitadas: 2 })
    expect(e.bitacora).toEqual([expect.objectContaining({ action: 'ORDER_CANCEL_LOYALTY_RETURNED' })])
  })

  it('S9 (B1, U3): la rama de folio SELLA antes de convertir, también sin beneficios', async () => {
    const conBeneficio = estado({ filas: [fila('od1', { loyaltyTransactionId: 'clt1', amount: D(30) })] })
    conBeneficio.movimientos.push({ id: 'clt1', customerId: ANA, points: -300, orderId: ORDER, type: 'REDEEM' })
    await devolver(conBeneficio)
    expect(conBeneficio.llamadas[0]).toBe(`sello:${ORDER}`)
    expect(conBeneficio.llamadas.indexOf(`sello:${ORDER}`)).toBeLessThan(conBeneficio.llamadas.indexOf('leer'))

    const sinBeneficios = estado()
    await devolver(sinBeneficios)
    expect(sinBeneficios.llamadas).toEqual([`sello:${ORDER}`, 'leer'])
  })

  it('S9: una cuenta que no es de folio no se sella', async () => {
    const e = estado({ folio: false })
    await devolver(e)
    expect(e.llamadas.filter(l => l.startsWith('sello'))).toEqual([])
  })
})

describe('sellarFolioAnuladoEnTx (S9, A0 · U2)', () => {
  it('sella con cancelledAt sólo un folio «Nadie» sin fecha de cierre; «Mi equipo» y lo ya cerrado quedan fuera por el where; sin foto', async () => {
    const updateMany = jest.fn(async () => ({ count: 1 }))
    await sellarFolioAnuladoEnTx({ onlineOrder: { updateMany } } as any, { venueId: VENUE, orderId: ORDER })
    expect(updateMany).toHaveBeenCalledTimes(1)
    expect(updateMany).toHaveBeenCalledWith({
      where: { orderId: ORDER, venueId: VENUE, requiresAcceptance: false, expiredAt: null, cancelledAt: null, rejectedAt: null },
      data: { cancelledAt: expect.any(Date) },
    })
  })
})
