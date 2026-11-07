/**
 * S5b paso 10 · los cruces X5–X8, X10 y X11 contra Postgres real (dos transacciones reales, con barreras).
 *
 * Una transacción se detiene en el punto exacto (con lo que ya tomó) hasta que la otra queda ESPERÁNDOLA en `pg_stat_activity`;
 * entonces se suelta y, si hay un círculo, Postgres lo corta con 40P01 a la que esperó primero.
 *  - Círculos reales (X5, X6, X10, X11): con `REINTENTO_POR_INTERBLOQUEO.intentos = 1` UNA aborta con 40P01 (el rojo: sin la red, el
 *    error llegaría al llamador); con 4 el log trae el `warn` y las dos terminan.
 *  - Prevención (X7, X8): las dos terminan aun con 1 intento y sin `warn`.
 *  - X11: el borrado abre `withSerializableRetry`; su rojo baja también `REINTENTO_SERIALIZABLE.intentos = 1` y el resultado público es
 *    `ConflictError` con `cause` = un 40P01.
 */
import '../../__helpers__/integration-setup'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { ConflictError } from '@/errors/AppError'
import { REINTENTO_POR_INTERBLOQUEO, REINTENTO_SERIALIZABLE, isDeadlockError } from '@/utils/serializableRetry'
import { aTiempo, esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'
import { createOrderWithItems as crearEnTerminal } from '@/services/tpv/order.tpv.service'
import { createOrderWithItems as crearEnMovil } from '@/services/mobile/order.mobile.service'
import { revokeTierReward } from '@/services/referrals/referralRefund.service'
import { finalizeCouponsForOrder } from '@/services/shared/cuponDeLaVenta'
import { recordCouponRedemption } from '@/services/dashboard/coupon.dashboard.service'
import { deleteDiscount } from '@/services/dashboard/discount.dashboard.service'
import { applyAutomaticDiscounts } from '@/services/dashboard/discountEngine.service'
import { hardDeleteTeamMember } from '@/services/dashboard/team.dashboard.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

jest.setTimeout(45_000)
// ───────────────────────── fixtures ─────────────────────────
interface Negocio {
  venueId: string
  orgId: string
  staffId: string
  staffVenueId: string
  productId: string
  discountId: string
  couponId: string
  couponCode: string
}
const negocios: string[] = []
const emails: string[] = []

async function negocio(): Promise<Negocio> {
  const venueId = `x-${randomUUID()}`
  const staffEmail = `${venueId}@staff.test`
  emails.push(staffEmail)
  await prisma.organization.create({ data: { id: venueId, name: venueId, email: `${venueId}@test.example`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: venueId, slug: venueId } })
  negocios.push(venueId)
  const staff = await prisma.staff.create({ data: { email: staffEmail, firstName: 'Caja', lastName: 'Cruces' } })
  const sv = await prisma.staffVenue.create({ data: { venueId, staffId: staff.id, role: 'MANAGER' } })
  const categoria = await prisma.menuCategory.create({ data: { venueId, name: 'Café', slug: `cafe-${venueId}` } })
  const producto = await prisma.product.create({
    data: { venueId, categoryId: categoria.id, name: 'Café', sku: `SKU-${venueId.slice(-12)}`, price: 100 },
  })
  const descuento = await prisma.discount.create({
    data: { venueId, name: 'Diez', type: 'PERCENTAGE', value: 10, scope: 'ORDER', active: true },
  })
  const code = `C${randomUUID().slice(0, 8).toUpperCase()}`
  const cupon = await prisma.couponCode.create({ data: { discountId: descuento.id, code } })
  return {
    venueId,
    orgId: venueId,
    staffId: staff.id,
    staffVenueId: sv.id,
    productId: producto.id,
    discountId: descuento.id,
    couponId: cupon.id,
    couponCode: code,
  }
}

async function limpiar(venueId: string) {
  // 🔴 Sin fixture no se limpia NADA: un filtro con venueId undefined borraría tablas enteras.
  if (!venueId) return
  const ordenes = (await prisma.order.findMany({ where: { venueId }, select: { id: true }, take: 500 })).map(o => o.id)
  await prisma.couponRedemption.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.orderDiscount.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.orderCustomer.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.paymentAllocation.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.payment.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.order.deleteMany({ where: { id: { in: ordenes } } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.table.deleteMany({ where: { venueId } })
  await prisma.couponCode.deleteMany({ where: { discount: { venueId } } })
  await prisma.discount.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: venueId } })
}

afterAll(async () => {
  for (const v of negocios) await limpiar(v).catch(() => undefined)
  if (emails.length) await prisma.staff.deleteMany({ where: { email: { in: emails } } })
  await prisma.$disconnect()
})

beforeEach(() => (logger.warn as jest.Mock).mockClear())

/** Una prueba que falla a medias no deja transacciones colgadas que traben a la siguiente ni la limpieza. */
afterEach(async () => {
  await prisma.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid() AND (state = 'idle in transaction' OR wait_event_type = 'Lock')`
})

/** Foto de quién espera a quién, para el mensaje de un fallo (nunca se cuelga: tiene su límite). */
async function fotoDeEsperas(): Promise<string> {
  const filas = await aTiempo(
    prisma.$queryRaw<Array<{ pid: number; state: string; wait: string | null; bloq: number[]; query: string }>>`
      SELECT pid, state, wait_event_type AS wait, pg_blocking_pids(pid) AS bloq, left(query, 160) AS query
        FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'`,
    5_000,
    'foto de esperas',
  ).catch(() => [])
  return JSON.stringify(filas)
}

const venta = (n: Negocio, extra: Record<string, unknown> = {}) =>
  prisma.order.create({
    data: {
      venueId: n.venueId,
      orderNumber: `ORD-X-${randomUUID()}`,
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      remainingBalance: 100,
      items: { create: { productId: n.productId, productName: 'Café', quantity: 1, unitPrice: 100, total: 100, taxAmount: 0 } },
      ...extra,
    },
  })

/** Una venta PAGADA con el cupón ya ligado, lista para `finalizeCouponsForOrder`. */
const ventaPagadaConCupon = (n: Negocio) =>
  venta(n, {
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    remainingBalance: 0,
    orderDiscounts: {
      create: {
        discountId: n.discountId,
        couponCodeId: n.couponId,
        name: 'Diez',
        type: 'PERCENTAGE',
        value: 10,
        amount: 10,
        taxReduction: 0,
        isManual: false,
      },
    },
  })

const usos = async (n: Negocio) => ({
  cupon: (await prisma.couponCode.findUniqueOrThrow({ where: { id: n.couponId }, select: { currentUses: true } })).currentUses,
  descuento: (await prisma.discount.findUniqueOrThrow({ where: { id: n.discountId }, select: { currentUses: true } })).currentUses,
  canjes: await prisma.couponRedemption.count({ where: { couponCodeId: n.couponId } }),
})

// ───────────────────────── barreras ─────────────────────────
type Punto = { modelo: string; operacion: string; nth?: number } | { raw: RegExp; nth?: number }

const textoDe = (a: unknown): string => {
  if (Array.isArray(a)) return a.join('?')
  const s = a as { strings?: string[]; sql?: string } | undefined
  return s?.strings?.join('?') ?? s?.sql ?? ''
}

/**
 * La PRÓXIMA transacción interactiva corre normal hasta el `nth` toque de `punto` y ahí se detiene (con todo lo que ya tomó) hasta
 * `soltar()`. `pid` = su backend de Postgres. El toque detenido NO se ejecuta hasta que se suelta.
 */
function aparcar(punto: Punto) {
  const original = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>
  let avisar: (pid: number) => void = () => undefined
  const pid = new Promise<number>(r => (avisar = r))
  let soltar: () => void = () => undefined
  const puede = new Promise<void>(r => (soltar = r))
  let vistas = 0
  const nth = punto.nth ?? 1
  const espia = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((cuerpo: (tx: any) => Promise<unknown>, opciones?: object) =>
    original(
      async (tx: any) => {
        const [{ pid: propio }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`
        const alcanzar = async () => {
          if (++vistas !== nth) return
          avisar(Number(propio))
          await puede
        }
        const detenido = new Proxy(tx, {
          get(objetivo, propiedad) {
            const valor = Reflect.get(objetivo, propiedad)
            if ('raw' in punto) {
              if (propiedad !== '$queryRaw') return valor
              return async (...args: unknown[]) => {
                if (punto.raw.test(textoDe(args[0]))) await alcanzar()
                return (valor as (...a: unknown[]) => unknown).apply(objetivo, args)
              }
            }
            if (propiedad !== punto.modelo) return valor
            return new Proxy(valor, {
              get(delegado, op) {
                const real = Reflect.get(delegado, op)
                if (op !== punto.operacion) return real
                return async (...args: unknown[]) => {
                  await alcanzar()
                  return real.apply(delegado, args)
                }
              },
            })
          },
        })
        return cuerpo(detenido)
      },
      { ...(opciones ?? {}), timeout: 60_000 },
    )) as never)
  return { pid, soltar: () => soltar(), restaurar: () => espia.mockRestore() }
}

/** Corre `fn` con el reintento por traba (y el serializable) en `n`; siempre los deja como estaban. */
async function conIntentos<T>(n: number, fn: () => Promise<T>, tambienSerializable = false): Promise<T> {
  const antes = REINTENTO_POR_INTERBLOQUEO.intentos
  const antesSer = REINTENTO_SERIALIZABLE.intentos
  REINTENTO_POR_INTERBLOQUEO.intentos = n
  if (tambienSerializable) REINTENTO_SERIALIZABLE.intentos = n
  try {
    return await fn()
  } finally {
    REINTENTO_POR_INTERBLOQUEO.intentos = antes
    REINTENTO_SERIALIZABLE.intentos = antesSer
  }
}

const huboInterbloqueo = () =>
  (logger.warn as jest.Mock).mock.calls.some(
    ([m]) => typeof m === 'string' && /interbloqueo|deadlock|Serialization\/lock conflict/i.test(m),
  )

/** Marca la promesa como atendida: si la prueba falla a medias, su rechazo no tumba la suite. */
const manejada = <T>(p: Promise<T>): Promise<T> => {
  p.catch(() => undefined)
  return p
}

type Resultado = PromiseSettledResult<unknown>
const caidoPor40P01 = (r: Resultado) =>
  r.status === 'rejected' && (isDeadlockError(r.reason) || isDeadlockError((r.reason as { cause?: unknown } | undefined)?.cause))

/**
 * Cada cruce es una función `(n) => { aparcada, esperaA, a, b }`: arma las dos operaciones, espera a que la segunda quede esperando a la
 * aparcada (se OBSERVA en `pg_stat_activity`), suelta y devuelve los dos desenlaces.
 */
interface Cruce {
  /** La que se aparca (retiene) y la que la espera. */
  aparcada: { promesa: Promise<unknown>; barrera: ReturnType<typeof aparcar> }
  /** La otra operación. */
  otra: Promise<unknown>
}
async function soltarYEsperar(c: Cruce): Promise<[Resultado, Resultado]> {
  c.aparcada.barrera.soltar()
  try {
    const [a, b] = await aTiempo(Promise.allSettled([c.aparcada.promesa, c.otra]), 20_000, 'las dos operaciones terminan')
    return [a, b]
  } finally {
    c.aparcada.barrera.soltar()
    c.aparcada.barrera.restaurar()
  }
}

// ───────────────────────── X5 ─────────────────────────
describe('X5 · venta de mostrador del POS contra createOrderWithItems de la TPV en la misma mesa y con el mismo cupón (círculo real)', () => {
  async function armar(): Promise<{ n: Negocio; cruce: Cruce }> {
    const n = await negocio()
    const mesa = await prisma.table.create({
      data: { venueId: n.venueId, number: `M-${randomUUID().slice(0, 6)}`, capacity: 4, qrCode: randomUUID() },
    })
    // El POS: asesor del cupón → mesa. Se detiene justo antes de pedir la mesa (ya tiene el asesor).
    const barrera = aparcar({ raw: /"Venue"[\s\S]*FOR KEY SHARE/ })
    const pos = manejada(
      crearEnMovil(n.venueId, {
        staffId: n.staffId,
        source: 'AVOQADO_ANDROID',
        orderType: 'DINE_IN',
        tableId: mesa.id,
        items: [{ productId: n.productId, quantity: 1 }],
        couponCode: n.couponCode,
      } as never),
    )
    const pidPos = await aTiempo(barrera.pid, 15_000, 'el POS detenido con el asesor tomado').catch(e => {
      barrera.restaurar()
      throw e
    })
    // La TPV: mesa → asesor. Toma la mesa y espera el asesor que tiene el POS.
    const tpv = manejada(
      crearEnTerminal(n.venueId, {
        items: [{ productId: n.productId, quantity: 1 }],
        staffId: n.staffId,
        taxAmount: 0,
        subtotal: 100,
        discount: 10,
        total: 90,
        tip: 0,
        tableId: mesa.id,
        couponCode: n.couponCode,
      } as never),
    )
    const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pidPos], consulta: /pg_advisory_xact_lock/, ms: 10_000 })
    expect(espera).not.toBeNull() // el cruce SÍ ocurrió: la TPV, con la mesa, espera el asesor del POS
    return { n, cruce: { aparcada: { promesa: pos, barrera }, otra: tpv } }
  }

  it('rojo · con 1 intento una aborta con 40P01', async () => {
    const { cruce } = await conIntentos(1, armar)
    const [pos, tpv] = await conIntentos(1, () => soltarYEsperar(cruce))
    expect([pos, tpv].filter(caidoPor40P01)).toHaveLength(1)
    expect([pos, tpv].filter(r => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('verde · con 4 intentos el log trae el warn y las dos terminan', async () => {
    const { n, cruce } = await armar()
    const [pos, tpv] = await soltarYEsperar(cruce)
    expect(pos.status).toBe('fulfilled')
    expect(tpv.status).toBe('fulfilled')
    expect(huboInterbloqueo()).toBe(true)
    expect(await prisma.order.count({ where: { venueId: n.venueId } })).toBe(2)
  })
})

// ───────────────────────── X6 ─────────────────────────
describe('X6 · revertir el nivel de una referidora contra finalizeCouponsForOrder del cupón de ese premio (círculo real)', () => {
  async function armar() {
    const n = await negocio()
    const pagada = await ventaPagadaConCupon(n)
    // El revertir: Discount → CouponCode. Se detiene justo antes de tocar los cupones (ya tiene el Discount).
    const barrera = aparcar({ modelo: 'couponCode', operacion: 'updateMany' })
    const revertir = manejada(revokeTierReward(n.discountId, 'TIER_REVERSED_BY_REFUND'))
    const pidRevertir = await aTiempo(barrera.pid, 15_000, 'el revertir detenido con el Discount tomado').catch(e => {
      barrera.restaurar()
      throw e
    })
    // El canje: asesor → CouponCode → Discount. Llega al Discount y espera.
    const canje = manejada(finalizeCouponsForOrder(n.venueId, pagada.id))
    const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pidRevertir], consulta: /"Discount"/, ms: 10_000 })
    expect(espera).not.toBeNull()
    return { n, cruce: { aparcada: { promesa: revertir, barrera }, otra: canje } as Cruce }
  }

  it('rojo · con 1 intento una aborta con 40P01', async () => {
    const { cruce } = await conIntentos(1, armar)
    const res = await conIntentos(1, () => soltarYEsperar(cruce))
    expect(res.filter(caidoPor40P01)).toHaveLength(1)
    expect(res.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('verde · con 4 intentos el log trae el warn y las dos terminan', async () => {
    const { n, cruce } = await armar()
    const res = await soltarYEsperar(cruce)
    expect(res.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(huboInterbloqueo()).toBe(true)
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: n.discountId } })).active).toBe(false)
    expect(await prisma.couponCode.findUniqueOrThrow({ where: { id: n.couponId }, select: { active: true } })).toEqual({ active: false })
    expect((await usos(n)).canjes).toBe(1)
  })
})

// ───────────────────────── X7 ─────────────────────────
describe('X7 · recordCouponRedemption contra finalizeCouponsForOrder de otra venta con el mismo cupón (prevención)', () => {
  it('con 1 intento terminan las dos, sin warn y con los dos usos contados', async () => {
    const n = await negocio()
    const a = await venta(n)
    const b = await ventaPagadaConCupon(n)
    // El canje manual toma el CouponCode y se detiene antes del Discount.
    const barrera = aparcar({ modelo: 'discount', operacion: 'update' })
    const manual = manejada(recordCouponRedemption(n.venueId, n.couponId, a.id, 10))
    const pid = await aTiempo(barrera.pid, 15_000, 'el canje manual detenido con el CouponCode tomado').catch(e => {
      barrera.restaurar()
      throw e
    })
    const finalizar = manejada(finalizeCouponsForOrder(n.venueId, b.id))
    const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: /"CouponCode"/, ms: 10_000 })
    expect(espera).not.toBeNull() // la otra espera la fila del cupón: serializan, no se cruzan
    const res = await conIntentos(1, () => soltarYEsperar({ aparcada: { promesa: manual, barrera }, otra: finalizar }))
    expect(res.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(huboInterbloqueo()).toBe(false)
    expect(await usos(n)).toEqual({ cupon: 2, descuento: 2, canjes: 2 })
  })
})

// ───────────────────────── X8 ─────────────────────────
describe('X8 · recordCouponRedemption contra applyAutomaticDiscounts sobre LA MISMA cuenta pendiente (prevención)', () => {
  it('con 1 intento terminan las dos y sin warn: el canje espera la cuenta sin retener nada', async () => {
    const n = await negocio()
    await prisma.discount.create({
      data: { venueId: n.venueId, name: 'Auto', type: 'FIXED_AMOUNT', value: 5, scope: 'ORDER', isAutomatic: true, active: true },
    })
    const cuenta = await venta(n)
    // El motor toma la cuenta y se detiene antes de sus contadores.
    const barrera = aparcar({ modelo: 'discount', operacion: 'update' })
    const motor = manejada(applyAutomaticDiscounts(cuenta.id, undefined, n.venueId))
    const pid = await aTiempo(barrera.pid, 15_000, 'el motor detenido con la cuenta tomada').catch(e => {
      barrera.restaurar()
      throw e
    })
    const canje = manejada(recordCouponRedemption(n.venueId, n.couponId, cuenta.id, 10))
    const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: /CouponRedemption/, ms: 10_000 })
    expect(espera).not.toBeNull() // el canje espera el KEY SHARE de la cuenta
    const res = await conIntentos(1, () => soltarYEsperar({ aparcada: { promesa: motor, barrera }, otra: canje }))
    expect(res.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(huboInterbloqueo()).toBe(false)
    expect((await usos(n)).canjes).toBe(1)
    expect(await prisma.orderDiscount.count({ where: { orderId: cuenta.id } })).toBe(1)
  })
})

// ───────────────────────── X10 ─────────────────────────
describe('X10 · deleteDiscount del panel contra recordCouponRedemption de un cupón de ese descuento (círculo real)', () => {
  async function armar() {
    const n = await negocio()
    const cuenta = await venta(n)
    // El canje retiene el CouponCode y se detiene antes de tocar el Discount.
    const barrera = aparcar({ modelo: 'discount', operacion: 'update' })
    const canje = manejada(recordCouponRedemption(n.venueId, n.couponId, cuenta.id, 10))
    const pid = await aTiempo(barrera.pid, 15_000, 'el canje detenido con el CouponCode tomado').catch(e => {
      barrera.restaurar()
      throw e
    })
    // El borrado retiene el Discount y su cascada pide el CouponCode: espera primero.
    const borrado = manejada(deleteDiscount(n.venueId, n.discountId))
    const espera = await esperarBloqueado(prisma, {
      bloqueadoPor: [pid],
      consulta: /DELETE FROM[\s\S]*"Discount"|"CouponCode"/,
      ms: 20_000,
    })
    expect(espera).not.toBeNull()
    return { n, cruce: { aparcada: { promesa: canje, barrera }, otra: borrado } as Cruce }
  }

  it('rojo · con 1 intento la víctima es el borrado (40P01) y el canje termina', async () => {
    const { cruce } = await conIntentos(1, armar)
    const [canje, borrado] = await conIntentos(1, () => soltarYEsperar(cruce))
    expect(canje.status).toBe('fulfilled')
    expect(caidoPor40P01(borrado)).toBe(true)
  })

  it('verde · con 4 intentos el log trae el warn y las dos terminan (el borrado arrastra el cupón en cascada)', async () => {
    const { n, cruce } = await armar()
    const res = await soltarYEsperar(cruce)
    expect(res.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(huboInterbloqueo()).toBe(true)
    expect(await prisma.discount.count({ where: { id: n.discountId } })).toBe(0)
    expect(await prisma.couponCode.count({ where: { id: n.couponId } })).toBe(0)
  })
})

// ───────────────────────── X11 ─────────────────────────
describe('X11 · applyAutomaticDiscounts contra hardDeleteTeamMember: el SET NULL toma D2 y espera D1 (círculo real por acción referencial)', () => {
  async function armar() {
    const n = await negocio()
    // La persona S que se borrará: sus dos descuentos automáticos D1 < D2, con D2 FÍSICAMENTE antes que D1 (D1 se actualiza después).
    const staff = await prisma.staff.create({ data: { email: `${n.venueId}-s@staff.test`, firstName: 'Borrable', lastName: 'S' } })
    emails.push(staff.email)
    const s = await prisma.staffVenue.create({ data: { venueId: n.venueId, staffId: staff.id, role: 'CASHIER' } })
    const base = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.padEnd(23, '0').slice(0, 23)
    const d1 = `${base}aa`
    const d2 = `${base}bb`
    const comunes = {
      venueId: n.venueId,
      type: 'FIXED_AMOUNT' as const,
      scope: 'ORDER' as const,
      isAutomatic: true,
      isStackable: true,
      active: true,
      createdById: s.id,
    }
    await prisma.discount.create({ data: { ...comunes, id: d1, name: 'D1', value: 5 } })
    await prisma.discount.create({ data: { ...comunes, id: d2, name: 'D2', value: 3 } })
    await prisma.discount.update({ where: { id: d1 }, data: { description: 'mueve D1 detrás de D2' } })
    const fisico = await prisma.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM "Discount" WHERE id IN (${d1}, ${d2}) AND "createdById" = ${s.id}`
    // Sin ORDER BY: el orden de un recorrido secuencial es el físico (el del SET NULL). Se anota lo que se vio.
    const cuenta = await venta(n)
    // El motor suma D1 y se detiene antes de D2.
    const barrera = aparcar({ modelo: 'discount', operacion: 'update', nth: 2 })
    const motor = manejada(applyAutomaticDiscounts(cuenta.id, undefined, n.venueId))
    const pidMotor = await aTiempo(barrera.pid, 15_000, 'el motor detenido con D1 sumado').catch(async e => {
      barrera.soltar()
      barrera.restaurar()
      throw new Error(`${e.message} :: ${await fotoDeEsperas()} :: físico=${JSON.stringify(fisico)}`)
    })
    // El borrado de S: su SET NULL toma D2 y espera D1 (el motor la tiene).
    const borrado = manejada(hardDeleteTeamMember(n.venueId, s.id, true, n.staffId))
    const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pidMotor], consulta: /DELETE[\s\S]*"StaffVenue"/, ms: 10_000 })
    if (!espera) throw new Error(`el SET NULL no quedó esperando al motor :: ${await fotoDeEsperas()} :: físico=${JSON.stringify(fisico)}`)
    return { n, s, d1, d2, fisico, espera, cruce: { aparcada: { promesa: motor, barrera }, otra: borrado } as Cruce }
  }

  it('rojo · con 1 intento (traba y serializable) el borrado responde ConflictError con cause 40P01 y el motor termina', async () => {
    const x = await conIntentos(1, armar, true)
    expect(x.espera).not.toBeNull() // el cruce SÍ ocurrió: el SET NULL espera D1 con D2 ya tomado
    const [motor, borrado] = await conIntentos(1, () => soltarYEsperar(x.cruce), true)
    expect(motor.status).toBe('fulfilled')
    expect(borrado.status).toBe('rejected')
    const razon = (borrado as PromiseRejectedResult).reason
    expect(razon).toBeInstanceOf(ConflictError)
    expect(isDeadlockError((razon as { cause?: unknown }).cause)).toBe(true)
  })

  it('verde · con los intentos normales se repite al confirmar el motor y las dos terminan', async () => {
    const x = await armar()
    expect(x.espera).not.toBeNull()
    const [motor, borrado] = await soltarYEsperar(x.cruce)
    expect(motor.status).toBe('fulfilled')
    expect(borrado.status).toBe('fulfilled')
    expect(huboInterbloqueo()).toBe(true)
    expect(await prisma.staffVenue.count({ where: { id: x.s.id } })).toBe(0)
    const filas = await prisma.discount.findMany({
      where: { id: { in: [x.d1, x.d2] } },
      select: { createdById: true, currentUses: true },
      take: 5,
    })
    expect(filas).toEqual([
      { createdById: null, currentUses: 1 },
      { createdById: null, currentUses: 1 },
    ])
  })
})
