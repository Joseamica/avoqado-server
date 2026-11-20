/**
 * Encargo 7133e3 (hz:0555ee15:D2): «Descuento manual» (% o fijo) en una cuenta de MESAS, con los candados de MOSTRADOR.
 * - El mismo candado, guardas y tope contra lo que queda que el descuento del catálogo.
 * - La llave del envío: el mismo toque nunca da dos filas (respuesta perdida, reintento, cola) — la trampa D21 no se repite.
 * - La cola sin red (`APPLY_DISCOUNT` con `manual`) llega al mismo servicio con la misma llave.
 *
 * Doble EN MEMORIA con estado, copiado de `descuentoConAprobacion.service.test.ts` (más `IdempotencyRequest`).
 * leen las mismas filas.
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/mobile/avisoDeVentaSinRed', () => ({
  ...jest.requireActual('@/services/mobile/avisoDeVentaSinRed'),
  avisarVentaSinRed: jest.fn().mockResolvedValue(undefined),
}))

import { Prisma } from '@prisma/client'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import { applyOrderDiscount, createOrderWithItems } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

type Fila = Record<string, any>

const VENUE = 'venue-1'
const APROBACION = 'desc-gerente' // 10 %, «Requiere aprobación»
const LIBRE = 'desc-libre' // 10 %, sin aprobación

const aNumero = (v: any) => (v && typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : v)

function coincide(fila: Fila, where: Fila = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v !== null && typeof v === 'object' && !(v instanceof Date))
      throw new Error(`doble en memoria: operador no soportado en where.${k}`)
    return fila[k] === v
  })
}

const catalogo: Record<string, Fila> = {
  [APROBACION]: {
    id: APROBACION,
    venueId: VENUE,
    name: '10% gerencial',
    type: 'PERCENTAGE',
    value: 10,
    scope: 'ORDER',
    active: true,
    requiresApproval: true,
  },
  [LIBRE]: {
    id: LIBRE,
    venueId: VENUE,
    name: '10% frecuente',
    type: 'PERCENTAGE',
    value: 10,
    scope: 'ORDER',
    active: true,
    requiresApproval: false,
  },
}

function baseEnMemoria() {
  const ordenes = new Map<string, Fila>()
  const renglones: Fila[] = []
  const descuentos: Fila[] = []
  let seq = 0
  const nuevoId = (p: string) => `${p}-${++seq}`
  const plano = (o: Fila) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, aNumero(v)]))
  const conRenglones = (o: Fila) => ({
    ...o,
    items: renglones.filter(r => r.orderId === o.id).map(r => ({ ...r, product: null, modifiers: [] })),
    promotions: [],
  })
  const buscarOrden = async ({ where }: any) => {
    if (where.venueId_externalId) return null
    const o = ordenes.get(where.id)
    return o && (!where.venueId || o.venueId === where.venueId) ? conRenglones(o) : null
  }
  prismaMock.order.findUnique.mockImplementation(buscarOrden)
  prismaMock.order.findFirst.mockImplementation(buscarOrden)
  prismaMock.order.create.mockImplementation(async ({ data }: any) => {
    const { items, ...cabecera } = data
    delete cabecera.orderCustomers
    const o = { id: nuevoId('orden'), paidAmount: 0, serviceChargeAmount: 0, ...plano(cabecera) }
    ordenes.set(o.id, o)
    for (const r of items?.create ?? []) renglones.push({ id: nuevoId('renglon'), orderId: o.id, orderPromotionId: null, ...plano(r) })
    return conRenglones(o)
  })
  prismaMock.order.update.mockImplementation(async ({ where, data }: any) => {
    const o = ordenes.get(where.id)!
    for (const [k, v] of Object.entries(data as Fila))
      o[k] = k === 'version' && typeof v === 'object' ? (o.version ?? 0) + v.increment : aNumero(v)
    return conRenglones(o)
  })
  prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...valores: any[]) => {
    // D19: el candado del descuento y la pasada de filas `Discount` de `usoDelDescuento` (leídas como las da `discount.findFirst`).
    const sqlD19 = Array.isArray(strings) ? strings.join('?') : (strings as any).sql
    if (sqlD19.includes('pg_advisory_xact_lock')) return [{}]
    if (sqlD19.includes('FROM "Discount"')) {
      const [venueIdD19, idsD19] = valores
      const filasD19 = await Promise.all(
        (idsD19 as string[]).map((id: string) => prismaMock.discount.findFirst({ where: { id, venueId: venueIdD19 } } as any)),
      )
      return filasD19
        .filter(Boolean)
        .map((d: any) => ({ id: d.id, name: d.name, currentUses: d.currentUses ?? 0, maxTotalUses: d.maxTotalUses ?? null }))
    }
    if (!strings.join('?').includes('FOR UPDATE')) throw new Error('doble en memoria: $queryRaw no soportado')
    const [orderId, venueId] = valores
    const o = ordenes.get(orderId)
    return o && o.venueId === venueId ? [{ id: orderId }] : []
  })
  prismaMock.orderItem.findMany.mockImplementation(async ({ where }: any) => renglones.filter(r => coincide(r, where)))
  prismaMock.orderServiceCharge.findMany.mockResolvedValue([])
  prismaMock.orderDiscount.findMany.mockImplementation(async ({ where }: any) => descuentos.filter(d => coincide(d, where)))
  prismaMock.orderDiscount.findFirst.mockImplementation(async ({ where }: any) => descuentos.find(d => coincide(d, where)) ?? null)
  prismaMock.orderDiscount.create.mockImplementation(async ({ data }: any) => {
    const fila = { id: nuevoId('od'), appliedToItemIds: [], discountId: null, ...plano(data) }
    descuentos.push(fila)
    return fila
  })
  prismaMock.orderDiscount.update.mockImplementation(async ({ where, data }: any) => {
    const fila = descuentos.find(d => d.id === where.id)
    Object.assign(fila!, plano(data))
    return fila
  })
  prismaMock.venue.findUnique.mockResolvedValue({ id: VENUE, name: 'Tienda de prueba', salesEnabled: true })
  // La membresía de cada persona en el negocio: la vendedora (`staff-1`) y la sesión que cobra (`sesion-1`).
  prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) =>
    where.venueId === VENUE ? { id: `sv-${where.staffId}`, staffId: where.staffId, venueId: VENUE, active: true, staff: {} } : null,
  )
  prismaMock.shift.findFirst.mockResolvedValue(null)
  // D19 (encargo 01765a): el descuento de cuenta de la mesa suma su uso (el tope lo prueba topeDeUsos.descuentoDeCuenta.test.ts).
  prismaMock.discount.findFirst.mockImplementation(async ({ where }: any) => {
    const d = catalogo[where.id]
    return d && d.venueId === where.venueId ? { ...d, value: new Prisma.Decimal(d.value) } : null
  })
  // 7133e3: la constancia de la llave (IdempotencyRequest) y la organización del negocio.
  const constancias: Fila[] = []
  prismaMock.venue.findUnique.mockImplementation(async ({ select }: any) =>
    select?.organizationId ? { organizationId: 'org-1' } : { id: VENUE, name: 'Tienda de prueba', salesEnabled: true },
  )
  const llaveDe = (w: any) => w.organizationId_actorStaffId_endpoint_idempotencyKey
  // El doble global no trae `IdempotencyRequest`: se le agrega aquí (sólo en esta suite).
  ;(prismaMock as any).idempotencyRequest = { findUnique: jest.fn(), create: jest.fn(), delete: jest.fn() }
  prismaMock.idempotencyRequest.findUnique.mockImplementation(async ({ where }: any) => {
    const k = llaveDe(where)
    return (
      constancias.find(
        c =>
          c.organizationId === k.organizationId &&
          c.actorStaffId === k.actorStaffId &&
          c.endpoint === k.endpoint &&
          c.idempotencyKey === k.idempotencyKey,
      ) ?? null
    )
  })
  prismaMock.idempotencyRequest.create.mockImplementation(async ({ data }: any) => {
    const c = { id: `ir-${constancias.length + 1}`, createdAt: new Date(), ...data }
    constancias.push(c)
    return c
  })
  prismaMock.idempotencyRequest.delete.mockImplementation(async ({ where }: any) => {
    const i = constancias.findIndex(c => c.id === where.id)
    return constancias.splice(i, 1)[0]
  })
  return { descuentos, constancias, ordenes: () => [...ordenes.values()] }
}

/** Una venta de $100 en un renglón «Otro importe». */
const venta = (extra: Fila = {}) =>
  ({ staffId: 'staff-1', items: [{ name: 'Otro importe', quantity: 1, unitPrice: 10000 }], ...extra }) as any

async function cuentaAbierta(db: ReturnType<typeof baseEnMemoria>) {
  const creada = await createOrderWithItems(VENUE, venta())
  return { id: creada.id, filas: () => db.descuentos.filter(d => d.orderId === creada.id) }
}

const LLAVE = '6f1c2a3b-4d5e-4f60-8a71-9b0c1d2e3f40'
const OTRA_LLAVE = '7a2b3c4d-5e6f-4a70-8b81-9c0d1e2f3a41'
const manual = (extra: Partial<{ type: 'PERCENTAGE' | 'FIXED_AMOUNT'; value: number; name: string; llave: string }> = {}) => ({
  type: 'PERCENTAGE' as const,
  value: 10,
  name: '',
  llave: LLAVE,
  ...extra,
})

describe('7133e3 · «Descuento manual» en la cuenta de MESAS', () => {
  it('10 % de una cuenta de $100: fila manual de $10, sin discountId, a nombre de quien lo dio, y la cuenta queda en $90', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    const r = await applyOrderDiscount(VENUE, cuenta.id, manual(), 'sesion-1')
    expect(r).toMatchObject({ amount: 10, name: 'Descuento manual', total: 90 })
    expect(cuenta.filas()).toEqual([
      expect.objectContaining({ discountId: null, isManual: true, type: 'PERCENTAGE', value: 10, amount: 10, appliedById: 'sv-sesion-1' }),
    ])
    // Un manual no es del catálogo: no suma usos.
    expect(cuenta.filas()[0].usoContado ?? false).toBe(false)
  })

  it('fijo con nombre y motivo: la fila guarda el nombre que tecleó la caja y el motivo de f998c8', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    await applyOrderDiscount(
      VENUE,
      cuenta.id,
      manual({ type: 'FIXED_AMOUNT', value: 25, name: ' Cliente frecuente ' }),
      'sesion-1',
      false,
      undefined,
      {
        reason: 'Queja del cliente',
      },
    )
    expect(cuenta.filas()).toEqual([
      expect.objectContaining({ type: 'FIXED_AMOUNT', name: 'Cliente frecuente', amount: 25, reason: 'Queja del cliente' }),
    ])
  })

  it('🔴 D21: la MISMA llave dos veces (respuesta perdida, reintento, cola) deja UNA sola fila y contesta la misma', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    const primera = await applyOrderDiscount(VENUE, cuenta.id, manual(), 'sesion-1')
    const segunda = await applyOrderDiscount(VENUE, cuenta.id, manual(), 'otra-sesion', false, undefined, {}, { enLaCola: true })
    expect(cuenta.filas()).toHaveLength(1)
    expect(segunda.orderDiscountId).toBe(primera.orderDiscountId)
    expect(segunda.amount).toBe(10)
    expect(db.ordenes()[0].total).toBe(90)
  })

  it('🔴 la llave sobrevive a que quiten la rebaja: un replay tardío no la vuelve a poner', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    await applyOrderDiscount(VENUE, cuenta.id, manual(), 'sesion-1')
    db.descuentos.splice(0, db.descuentos.length) // alguien la quitó
    await applyOrderDiscount(VENUE, cuenta.id, manual(), 'sesion-1', false, undefined, {}, { enLaCola: true })
    expect(cuenta.filas()).toHaveLength(0)
  })

  it('dos toques distintos (otra llave) son dos descuentos, y el segundo sólo descuenta lo que queda', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    await applyOrderDiscount(VENUE, cuenta.id, manual({ type: 'FIXED_AMOUNT', value: 70 }), 'sesion-1')
    const r = await applyOrderDiscount(
      VENUE,
      cuenta.id,
      manual({ type: 'FIXED_AMOUNT', value: 70, llave: OTRA_LLAVE }),
      'sesion-1',
      true,
      {},
    )
    expect(r.amount).toBe(30)
    expect(cuenta.filas()).toHaveLength(2)
    expect(db.ordenes()[0].total).toBe(0)
  })

  it('misma llave con OTRO descuento: 409 y nada cambia', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    await applyOrderDiscount(VENUE, cuenta.id, manual(), 'sesion-1')
    await expect(applyOrderDiscount(VENUE, cuenta.id, manual({ value: 50 }), 'sesion-1')).rejects.toBeInstanceOf(ConflictError)
    expect(cuenta.filas()).toHaveLength(1)
  })

  it('tope: un fijo mayor a la cuenta descuenta sólo lo que debe; con la cuenta ya en $0 se rechaza', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    const r = await applyOrderDiscount(VENUE, cuenta.id, manual({ type: 'FIXED_AMOUNT', value: 500 }), 'sesion-1', true, {})
    expect(r.amount).toBe(100)
    await expect(
      applyOrderDiscount(VENUE, cuenta.id, manual({ type: 'FIXED_AMOUNT', value: 5, llave: OTRA_LLAVE }), 'sesion-1'),
    ).rejects.toMatchObject({ message: 'La cuenta ya no tiene nada por descontar' })
  })

  it('un % arriba de 100, cero o negativo no entra (400) y la cuenta no cambia', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    for (const malo of [manual({ value: 101 }), manual({ value: 0 }), manual({ type: 'FIXED_AMOUNT', value: -5 })])
      await expect(applyOrderDiscount(VENUE, cuenta.id, malo, 'sesion-1')).rejects.toBeInstanceOf(BadRequestError)
    expect(cuenta.filas()).toEqual([])
  })

  it('una cortesía (COMP) no entra por el manual: la cortesía tiene su botón y su permiso', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    await expect(applyOrderDiscount(VENUE, cuenta.id, { ...manual(), type: 'COMP' as any }, 'sesion-1')).rejects.toBeInstanceOf(
      BadRequestError,
    )
    expect(cuenta.filas()).toEqual([])
  })

  it('una cuenta ya pagada (o con abono) no se descuenta, igual que con el del catálogo', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    db.ordenes()[0].paymentStatus = 'PARTIAL'
    await expect(applyOrderDiscount(VENUE, cuenta.id, manual(), 'sesion-1')).rejects.toMatchObject({
      message: 'No se puede descontar una orden ya pagada',
    })
    expect(cuenta.filas()).toEqual([])
  })

  it('regresión: el del catálogo sigue igual junto al manual (cada uno con su fila)', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    await applyOrderDiscount(VENUE, cuenta.id, LIBRE, 'sesion-1')
    await applyOrderDiscount(VENUE, cuenta.id, manual({ type: 'FIXED_AMOUNT', value: 5 }), 'sesion-1')
    expect(cuenta.filas().map(f => [f.discountId, Number(f.amount)])).toEqual([
      [LIBRE, 10],
      [null, 5],
    ])
  })
})

describe('7133e3 · hz:e0b12f00:D1 · un manual que deja la cuenta en $0 es una cortesía', () => {
  it('sin permiso de cortesía: 403 PERMISSION_DENIED y la cuenta no cambia (100 % o un fijo por todo)', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    await expect(applyOrderDiscount(VENUE, cuenta.id, manual({ value: 100 }), 'sesion-1')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    await expect(
      applyOrderDiscount(VENUE, cuenta.id, manual({ type: 'FIXED_AMOUNT', value: 500, llave: OTRA_LLAVE }), 'sesion-1'),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(cuenta.filas()).toEqual([])
    expect(db.constancias).toEqual([])
  })

  it('con el PIN de un gerente: entra y la fila guarda quién lo autorizó', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    const r = await applyOrderDiscount(VENUE, cuenta.id, manual({ value: 100 }), 'sesion-1', true, { porPin: 'sv-gerente' })
    expect(r.amount).toBe(100)
    expect(cuenta.filas()).toEqual([expect.objectContaining({ authorizedById: 'sv-gerente', appliedById: 'sv-sesion-1' })])
  })

  it('lo que NO deja la cuenta en $0 no pide cortesía ni guarda autorizador', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    await applyOrderDiscount(VENUE, cuenta.id, manual({ value: 99 }), 'sesion-1')
    expect(cuenta.filas()[0].authorizedById ?? null).toBeNull()
  })
})

describe('7133e3 · Codex r2 #1: el permiso se decide con el importe que SE GUARDA (2 decimales)', () => {
  it.each([
    ['99.99996 %', manual({ value: 99.99996 })],
    ['un fijo de $99.995', manual({ type: 'FIXED_AMOUNT', value: 99.995 })],
  ])('%s se guarda como el total de la cuenta: es cortesía y sin permiso es 403', async (_caso, m) => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    await expect(applyOrderDiscount(VENUE, cuenta.id, m, 'sesion-1')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(cuenta.filas()).toEqual([])
  })

  it('el valor guardado es el normalizado (12.345 % → 12.35 %) y su importe sale de ése', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    const r = await applyOrderDiscount(VENUE, cuenta.id, manual({ value: 12.345 }), 'sesion-1')
    expect(cuenta.filas()[0]).toMatchObject({ value: 12.35 })
    expect(r.amount).toBe(12.35)
  })
})
