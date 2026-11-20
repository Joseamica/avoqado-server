/**
 * 🔴 DINERO (tope de usos), contra PostgreSQL real — pizarrón hz:e82938e1:D24, encargo ea1827.
 *
 * D19 hizo que el descuento de cuenta del POS (Mesas de ANDROID ≥ 2.25.32, WINDOWS, iOS) sume su uso al aplicarse
 * (`OrderDiscount.usoContado`) y lo devuelva al QUITAR la fila o al BORRAR la cuenta vacía. Pero ANULAR la cuenta sin cobrar sólo
 * devolvía los canjes de lealtad: el uso quedaba gastado y un «primeros 100» (o uno de un solo uso) se agotaba antes de tiempo en todas
 * las cajas, también en la TPV.
 *
 * Aquí, por cada camino que anula: aplicar → anular → `currentUses` igual que antes, la fila se queda como historia sin su marca, y queda
 * la bitácora `ORDER_CANCEL_DISCOUNT_USES_RETURNED`. Los caminos: el POS (`cancelOrder`, el mismo que reproduce la cola sin red
 * `CANCEL_ORDER`), la TPV al anular todos los renglones (`voidItems`) y el panel/MCP (`cancelarCuentaSinCobrar`).
 */
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { applyOrderDiscount, cancelOrder, createOrderWithItems, payCashOrder } from '@/services/mobile/order.mobile.service'
import { recordFastPayment, recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { voidItems } from '@/services/tpv/order.tpv.service'
import { cancelarCuentaSinCobrar } from '@/services/dashboard/order.dashboard.service'
import { removeDiscountFromOrder } from '@/services/dashboard/discountEngine.service'
import { devolverUsosDeCuentaQueSeBorraEnTx } from '@/services/shared/usoDelDescuento'
import * as cuentaCancelada from '@/services/shared/cuentaCancelada'
import { reabrirSiRecibeDinero, volverAGastarUsosTrasElCobro } from '@/services/shared/cuentaCancelada'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { withDeadlockRetry } from '@/utils/serializableRetry'

jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

const sufijo = `anular-uso-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let orgId: string
let venueId: string
let staffId: string
let promoId: string

/** Una cuenta abierta de $100 en un renglón «Otro importe», sin cobrar. */
async function cuentaAbierta(): Promise<string> {
  const creada = await createOrderWithItems(venueId, {
    staffId,
    items: [{ name: 'Otro importe', quantity: 1, unitPrice: 10000 }],
    orderType: 'TAKEOUT',
    source: 'AVOQADO_ANDROID',
  } as any)
  return creada.id
}

const usos = async () => (await prisma.discount.findUniqueOrThrow({ where: { id: promoId }, select: { currentUses: true } })).currentUses
const filas = (orderId: string) =>
  prisma.orderDiscount.findMany({
    where: { orderId },
    select: { discountId: true, usoContado: true, usoDevueltoAlAnular: true },
    orderBy: { id: 'asc' },
    take: 10,
  })
const bitacora = (orderId: string) =>
  prisma.activityLog.findMany({
    where: { venueId, entityId: orderId, action: 'ORDER_CANCEL_DISCOUNT_USES_RETURNED' },
    select: { data: true, staffId: true },
    take: 10,
  })

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${sufijo}`, email: `${sufijo}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `Café ${sufijo}`, slug: sufijo, seatCapExempt: true },
      select: { id: true },
    })
  ).id
  staffId = (
    await prisma.staff.create({
      data: { email: `gerente-${sufijo}@example.test`, firstName: 'Gerente', lastName: 'Prueba' },
      select: { id: true },
    })
  ).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'MANAGER' } })
  promoId = (
    await prisma.discount.create({
      data: { venueId, name: 'Primeros 100', type: 'PERCENTAGE', value: 10, scope: 'ORDER', maxTotalUses: 100, currentUses: 40 },
      select: { id: true },
    })
  ).id
})

afterAll(async () => {
  if (!orgId) return
  // D26 cobra estas cuentas: sus efectos de pago PENDING los reclamaría el worker de otra suite (la base de CI es una sola).
  await prisma.paymentEffect.deleteMany({ where: { venueId } })
  // Lo demás que deja un cobro (pagos, movimientos de caja) se queda en la base desechable de CI: borrar la venta fallaría por su FK.
  const conCobro = await prisma.payment.count({ where: { venueId } })
  if (conCobro > 0) return
  const ids = (await prisma.order.findMany({ where: { venueId }, select: { id: true }, take: 100 })).map(o => o.id)
  await prisma.orderAction.deleteMany({ where: { orderId: { in: ids } } })
  await prisma.orderDiscount.deleteMany({ where: { orderId: { in: ids } } })
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
  await prisma.order.deleteMany({ where: { id: { in: ids } } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.discount.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('🔴 D24: anular una cuenta sin cobrar devuelve el uso de su descuento de cuenta (PostgreSQL real)', () => {
  it('POS «Anular cuenta» (y la cola sin red CANCEL_ORDER, que llama lo mismo): el contador regresa', async () => {
    const orderId = await cuentaAbierta()
    const antes = await usos()
    await applyOrderDiscount(venueId, orderId, promoId, staffId)
    // El escenario ocurrió de verdad: el uso se sumó (si esto falla, la prueba no está midiendo nada).
    expect(await usos()).toBe(antes + 1)

    await cancelOrder(venueId, orderId, 'el cliente se fue', staffId)

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    expect(await usos()).toBe(antes)
    expect(await filas(orderId)).toEqual([{ discountId: promoId, usoContado: false, usoDevueltoAlAnular: true }])
    expect(await bitacora(orderId)).toEqual([
      { staffId, data: expect.objectContaining({ camino: 'cancelOrder', usosDevueltos: 1, porDescuento: { [promoId]: 1 } }) },
    ])
    // El barrido de cuentas vacías (o cualquier otro que devuelva por la marca) ya no devuelve otra vez.
    expect(await prisma.$transaction(tx => devolverUsosDeCuentaQueSeBorraEnTx(tx as any, venueId, orderId))).toBe(0)
    expect(await usos()).toBe(antes)
  })

  it('TPV: anular TODOS los renglones cancela la cuenta y el contador regresa', async () => {
    const orderId = await cuentaAbierta()
    const antes = await usos()
    await applyOrderDiscount(venueId, orderId, promoId, staffId)
    expect(await usos()).toBe(antes + 1)
    const orden = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { version: true, items: { select: { id: true } } },
    })

    await voidItems(venueId, orderId, {
      itemIds: orden.items.map(i => i.id),
      reason: 'se equivocó de mesa',
      staffId,
      actorId: staffId,
      expectedVersion: orden.version,
    })

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    expect(await usos()).toBe(antes)
    expect(await bitacora(orderId)).toEqual([{ staffId, data: expect.objectContaining({ camino: 'voidItems', usosDevueltos: 1 }) }])
  })

  it('panel / MCP «Cancelar cuenta sin cobrar»: el contador regresa', async () => {
    const orderId = await cuentaAbierta()
    const antes = await usos()
    await applyOrderDiscount(venueId, orderId, promoId, staffId)
    expect(await usos()).toBe(antes + 1)

    await cancelarCuentaSinCobrar(venueId, orderId, 'cuenta de prueba', staffId)

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    expect(await usos()).toBe(antes)
  })

  it('🔴 Codex r1 #1: la cuenta anulada revive por dinero tardío y la TPV le quita el descuento: no se resta otro uso', async () => {
    const orderId = await cuentaAbierta()
    const antes = await usos()
    await applyOrderDiscount(venueId, orderId, promoId, staffId)
    await cancelOrder(venueId, orderId, 'anulada en otra caja', staffId)
    expect(await usos()).toBe(antes)
    // Lo que deja `reabrirSiRecibeDinero` cuando llega un abono sin red de otra caja: la cuenta vuelve a estar viva y debe.
    await prisma.order.update({ where: { id: orderId }, data: { status: 'CONFIRMED' } })
    const [fila] = await prisma.orderDiscount.findMany({ where: { orderId }, select: { id: true }, take: 1 })

    await removeDiscountFromOrder(orderId, fila.id, staffId, venueId)

    expect(await prisma.orderDiscount.count({ where: { orderId } })).toBe(0)
    expect(await usos()).toBe(antes)
  })

  it('regresión: la TPV sigue restando el uso de un descuento que su motor sí sumó (sin marca de anulación)', async () => {
    const orderId = await cuentaAbierta()
    await prisma.discount.update({ where: { id: promoId }, data: { currentUses: { increment: 1 } } })
    const fila = await prisma.orderDiscount.create({
      data: { orderId, discountId: promoId, type: 'PERCENTAGE', name: 'Primeros 100', value: 10, amount: 0 },
      select: { id: true },
    })
    const antes = await usos()

    await removeDiscountFromOrder(orderId, fila.id, staffId, venueId)

    expect(await usos()).toBe(antes - 1)
  })

  it('regresión: una fila vieja sin marca (de antes de D19) no resta lo que nunca sumó', async () => {
    const orderId = await cuentaAbierta()
    await prisma.orderDiscount.create({
      data: { orderId, discountId: promoId, type: 'PERCENTAGE', name: 'Primeros 100', value: 10, amount: 0, usoContado: false },
    })
    const antes = await usos()

    await cancelOrder(venueId, orderId, 'fila vieja', staffId)

    expect(await usos()).toBe(antes)
    expect(await bitacora(orderId)).toEqual([])
  })
})

/**
 * 🔴 hz:e82938e1:D26 (encargo 2f1901): el caso contrario que abrió D24. Una caja cobra la mesa en efectivo SIN RED con la última rebaja
 * de un descuento con tope; otra caja anula esa cuenta antes de que suba el cobro (D24 devuelve el uso). Al subir, el dinero ya
 * capturado revive la cuenta (`reabrirSiRecibeDinero`), pero el uso seguía libre: el contador quedaba uno abajo y otra caja podía dar
 * la misma rebaja. La regla (D19 «A»): lo cobrado nunca se rechaza por el tope; el uso se vuelve a gastar y, si queda arriba del
 * tope, el dueño ve `DESCUENTO_SOBRE_TOPE`.
 */
describe('🔴 D26: la cuenta anulada que revive por dinero tardío vuelve a gastar el uso de su descuento (PostgreSQL real)', () => {
  const respentidos = (orderId: string) =>
    prisma.activityLog.findMany({
      where: { venueId, entityId: orderId, action: 'ORDER_REOPENED_DISCOUNT_USES_RESPENT' },
      select: { data: true, staffId: true },
      take: 10,
    })
  const sobreTope = (orderId: string) =>
    prisma.activityLog.findMany({
      where: { venueId, entityId: orderId, action: 'DESCUENTO_SOBRE_TOPE' },
      select: { data: true },
      take: 10,
    })
  /** Aplicar → anular en otra caja: el escenario de partida (el uso ya regresó). */
  async function anuladaConDescuento(): Promise<{ orderId: string; antes: number }> {
    const orderId = await cuentaAbierta()
    const antes = await usos()
    await applyOrderDiscount(venueId, orderId, promoId, staffId)
    expect(await usos()).toBe(antes + 1)
    await cancelOrder(venueId, orderId, 'anulada en otra caja', staffId)
    expect(await usos()).toBe(antes)
    return { orderId, antes }
  }
  /**
   * Lo que manda la terminal por un cobro de $90 ya en el cajón. `llave: null` es la TPV vieja (1.2.0), que no manda `idempotencyKey` y
   * reenvía por `referencia` (Codex r2 #1: con `undefined` el parámetro por defecto volvía a poner una llave).
   */
  const datosDelCobro = (llave: string | null, o: { centavos?: number; referencia?: string; split?: string } = {}) =>
    ({
      venueId,
      amount: o.centavos ?? 9000,
      tip: 0,
      ...(o.referencia ? { referenceNumber: o.referencia } : {}),
      status: 'COMPLETED',
      method: 'CASH',
      source: 'TPV',
      splitType: o.split ?? 'FULLPAYMENT',
      tpvId: `d26-${sufijo}`,
      staffId,
      paidProductsId: [],
      ...(llave !== null ? { idempotencyKey: llave } : {}),
      currency: 'MXN',
      isInternational: false,
    }) as never
  /** El cobro de la terminal con orden (Mesas → «Tarjeta» → pantalla de pago general → «Efectivo»). */
  const cobrarEnTpv = (
    orderId: string,
    llave: string | null = `tpv-${orderId}`,
    o: { centavos?: number; referencia?: string; split?: string } = {},
  ) => recordOrderPayment(venueId, orderId, datosDelCobro(llave, o), staffId)
  /** El mismo cobro reenviado por «Pago rápido» (`/fast`), como lo hace la cola de la TPV 1.2.0. */
  const reenviarPorPagoRapido = (llave: string | null, o: { referencia?: string } = {}) =>
    recordFastPayment(venueId, datosDelCobro(llave, o), staffId)
  /** El paso del uso sigue solo después de la respuesta (tope de 1.5 s): se espera a que el contador llegue a `n`. */
  async function usosLlegaA(n: number): Promise<number> {
    let u = await usos()
    for (let i = 0; i < 60 && u !== n; i += 1) {
      await new Promise(r => setTimeout(r, 100))
      u = await usos()
    }
    return u
  }
  /** Otra caja toma la fila de la promoción y la retiene hasta `soltar()`. */
  async function otraCajaRetieneLaPromocion(): Promise<{ soltar: () => void; termino: Promise<unknown> }> {
    let soltar!: () => void
    const hastaSoltar = new Promise<void>(r => (soltar = r))
    let avisarTomada!: () => void
    const tomada = new Promise<void>(r => (avisarTomada = r))
    const termino = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Discount" WHERE id = ${promoId} FOR UPDATE`
        avisarTomada()
        await hastaSoltar
      },
      { timeout: 40_000, maxWait: 10_000 },
    )
    await tomada
    return { soltar, termino }
  }
  const pagoDeLaLlave = (llave: string) =>
    prisma.payment.findUnique({ where: { venueId_idempotencyKey: { venueId, idempotencyKey: llave } }, select: { id: true } })
  /** La cuenta revivida por dinero SIN gastar todavía el uso: lo que deja el cobro de la terminal entre sus dos pasos. */
  async function revividaSinGastar(orderId: string): Promise<void> {
    await withDeadlockRetry(
      async tx => {
        await lockExistingOrderForPayment(tx, { venueId, orderId })
        await reabrirSiRecibeDinero(tx, {
          venueId,
          orderId,
          status: 'CANCELLED',
          originSystem: 'AVOQADO',
          cobrado: 50,
          cubreComoCancelada: false,
          canal: 'recordOrderPayment',
          staffId,
          usos: 'despues',
        } as never)
      },
      { etiqueta: 'd26-tras-el-cobro-test' },
    )
  }

  it('POS: el efectivo de la cola sin red revive la cuenta y el contador queda como antes de anular', async () => {
    const { orderId, antes } = await anuladaConDescuento()

    // $100 − 10 % = $90: lo que la caja cobró sin red, ya en el cajón.
    await payCashOrder(venueId, orderId, { amount: 9000, tip: 0, staffId, idempotencyKey: `cola-${orderId}`, isOfflineReplay: true } as any)

    const orden = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, paymentStatus: true } })
    expect(orden.status).not.toBe('CANCELLED')
    expect(orden.paymentStatus).toBe('PAID')
    expect(await usos()).toBe(antes + 1)
    // La fila vuelve a ocupar su uso: si la cuenta se anula otra vez o le quitan el descuento, lo devuelve UNA vez.
    expect(await filas(orderId)).toEqual([{ discountId: promoId, usoContado: true, usoDevueltoAlAnular: false }])
    expect(await respentidos(orderId)).toEqual([
      { staffId, data: expect.objectContaining({ canal: 'payCashOrder:cola', usosGastados: 1, porDescuento: { [promoId]: 1 } }) },
    ])
    expect(await sobreTope(orderId)).toEqual([])

    // La cola reenvía el mismo cobro (la respuesta se perdió): la llave lo devuelve como ya hecho y no gasta otro uso.
    await payCashOrder(venueId, orderId, { amount: 9000, tip: 0, staffId, idempotencyKey: `cola-${orderId}`, isOfflineReplay: true } as any)
    expect(await usos()).toBe(antes + 1)
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1)
  })

  it('TPV: el efectivo ya capturado de la terminal (`recordOrderPayment`) revive la cuenta y, ya guardado el cobro, vuelve a gastar el uso', async () => {
    const { orderId, antes } = await anuladaConDescuento()
    const cobrar = () => cobrarEnTpv(orderId)

    await cobrar()

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PAID')
    expect(await usos()).toBe(antes + 1)
    expect(await filas(orderId)).toEqual([{ discountId: promoId, usoContado: true, usoDevueltoAlAnular: false }])
    expect(await respentidos(orderId)).toEqual([
      { staffId, data: expect.objectContaining({ canal: 'recordOrderPayment', usosGastados: 1, porDescuento: { [promoId]: 1 } }) },
    ])

    // La terminal reenvía el mismo cobro (no le llegó la respuesta): la llave lo devuelve y no gasta otro uso.
    await cobrar()
    expect(await usos()).toBe(antes + 1)
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1)
  })

  it('🔴 cruce con la venta de $0 (20-nov): con la promoción trabada por otra caja, el cobro de la terminal YA queda guardado; al soltarla, el uso se gasta', async () => {
    const { orderId, antes } = await anuladaConDescuento()
    const llave = `tpv-trabada-${orderId}`
    const caja = await otraCajaRetieneLaPromocion()
    let cobro: Promise<unknown> | undefined
    try {
      cobro = cobrarEnTpv(orderId, llave)
      // Sin tocar Discount, el registro del dinero no espera a la otra caja: el pago aparece confirmado mientras ella sigue con la fila.
      let guardado: { id: string } | null = null
      for (let i = 0; i < 80 && !guardado; i += 1) {
        guardado = await pagoDeLaLlave(llave)
        if (!guardado) await new Promise(r => setTimeout(r, 100))
      }
      expect(guardado).not.toBeNull()
      expect(await usos()).toBe(antes)
    } finally {
      caja.soltar()
      await caja.termino
    }
    await cobro
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PAID')
    expect(await usosLlegaA(antes + 1)).toBe(antes + 1)
    expect(await filas(orderId)).toEqual([{ discountId: promoId, usoContado: true, usoDevueltoAlAnular: false }])
  })

  it('🔴 Codex r2 #2: con la promoción retenida TODO el tiempo, la respuesta del cobro espera al paso como mucho el tope (1.5 s)', async () => {
    const { orderId, antes } = await anuladaConDescuento()
    // Línea base: un cobro igual sobre una cuenta viva, sin nada que gastar después.
    const viva = await cuentaAbierta()
    const t0 = Date.now()
    await cobrarEnTpv(viva, `tpv-base-${viva}`, { centavos: 10000 })
    const base = Date.now() - t0

    const caja = await otraCajaRetieneLaPromocion()
    let conPaso = 0
    try {
      const t1 = Date.now()
      await cobrarEnTpv(orderId, `tpv-tope-${orderId}`)
      conPaso = Date.now() - t1
    } finally {
      caja.soltar()
      await caja.termino
    }
    // El paso esperó su tope y la respuesta salió; lo extra es el tope y poco más, nunca los intentos completos del paso.
    expect(conPaso).toBeGreaterThanOrEqual(1_400)
    expect(conPaso - base).toBeLessThan(2_500)
    // El paso siguió solo y, suelta la promoción, termina de gastar (o se rinde con su logger.error: el uso queda libre).
    const final = await usosLlegaA(antes + 1)
    expect([antes, antes + 1]).toContain(final)
  })

  it('🔴 la anularon OTRA VEZ entre los dos pasos: el paso posterior no gasta, y la segunda anulación no devuelve nada', async () => {
    const { orderId, antes } = await anuladaConDescuento()
    await revividaSinGastar(orderId)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PENDING')
    // Revivida pero sin gastar todavía: el uso sigue libre y la fila conserva su marca.
    expect(await usos()).toBe(antes)
    expect(await filas(orderId)).toEqual([{ discountId: promoId, usoContado: false, usoDevueltoAlAnular: true }])

    await cancelOrder(venueId, orderId, 'anulada otra vez en otra caja', staffId)
    expect(await usos()).toBe(antes)

    expect(await volverAGastarUsosTrasElCobro({ venueId, orderId, canal: 'recordOrderPayment', paymentId: null, staffId })).toBe(0)
    expect(await usos()).toBe(antes)
    expect(await filas(orderId)).toEqual([{ discountId: promoId, usoContado: false, usoDevueltoAlAnular: true }])
    expect(await respentidos(orderId)).toEqual([])
  })

  it('🔴 repetir el paso posterior (dos a la vez) gasta UN solo uso', async () => {
    const { orderId, antes } = await anuladaConDescuento()
    await revividaSinGastar(orderId)

    const r = await Promise.all([
      volverAGastarUsosTrasElCobro({ venueId, orderId, canal: 'recordOrderPayment', staffId }),
      volverAGastarUsosTrasElCobro({ venueId, orderId, canal: 'recordOrderPayment', staffId }),
    ])
    expect(r.sort()).toEqual([0, 1])
    expect(await volverAGastarUsosTrasElCobro({ venueId, orderId, canal: 'recordOrderPayment', staffId })).toBe(0)
    expect(await usos()).toBe(antes + 1)
    expect(await filas(orderId)).toEqual([{ discountId: promoId, usoContado: true, usoDevueltoAlAnular: false }])
    expect(await respentidos(orderId)).toHaveLength(1)
  })

  it('🔴 el proceso murió entre los dos pasos: el reenvío de la terminal con la misma llave lo cura (un solo pago, un solo uso)', async () => {
    const { orderId, antes } = await anuladaConDescuento()
    const llave = `tpv-murio-${orderId}`
    // El primer registro guarda el dinero y «muere» antes del paso del uso.
    const paso = jest.spyOn(cuentaCancelada, 'volverAGastarUsosTrasElCobro').mockResolvedValueOnce(0)
    try {
      await cobrarEnTpv(orderId, llave)
      expect(paso).toHaveBeenCalledTimes(1)
      expect(await usos()).toBe(antes)
      expect(await prisma.payment.count({ where: { orderId } })).toBe(1)

      // La terminal no recibió respuesta y reenvía: el atajo de la llave devuelve el pago guardado y vuelve a llamar al paso.
      await cobrarEnTpv(orderId, llave)
    } finally {
      paso.mockRestore()
    }
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1)
    expect(await usosLlegaA(antes + 1)).toBe(antes + 1)
    expect(await respentidos(orderId)).toEqual([
      { staffId, data: expect.objectContaining({ canal: 'recordOrderPayment', usosGastados: 1 }) },
    ])
    // Y otro reenvío ya no gasta.
    await cobrarEnTpv(orderId, llave)
    expect(await usos()).toBe(antes + 1)
  })

  it('🔴 Codex r1 #2: otra caja retiene la promoción más de lo que espera el paso: el cobro queda, un SEGUNDO abono de la misma cuenta no se frena, y el reenvío con la llave cura el uso', async () => {
    const { orderId, antes } = await anuladaConDescuento()
    const llave1 = `tpv-abono1-${orderId}`
    const errores = () => (logger.error as jest.Mock).mock.calls.filter(([m, d]) => String(m).includes('[D26]') && d?.orderId === orderId)
    const caja = await otraCajaRetieneLaPromocion()
    try {
      // Abono 1: $50 de $90 revive la cuenta; su paso del uso espera a la promoción (acotado) mientras llega el abono 2.
      const t0 = Date.now()
      const abono1 = cobrarEnTpv(orderId, llave1, { centavos: 5000, split: 'CUSTOMAMOUNT' })
      let guardado: { id: string } | null = null
      for (let i = 0; i < 80 && !guardado; i += 1) {
        guardado = await pagoDeLaLlave(llave1)
        if (!guardado) await new Promise(r => setTimeout(r, 50))
      }
      expect(guardado).not.toBeNull()
      // Abono 2 ($40) de la misma cuenta, mientras el paso del abono 1 sigue esperando: no se frena (antes, hasta 15 s con la cuenta tomada).
      const t1 = Date.now()
      await cobrarEnTpv(orderId, `tpv-abono2-${orderId}`, { centavos: 4000, split: 'CUSTOMAMOUNT' })
      expect(Date.now() - t1).toBeLessThan(4_000)
      await abono1
      expect(Date.now() - t0).toBeLessThan(5_000)
      // El paso del abono 1 se rinde solo (dos intentos de 1 s) con la promoción todavía retenida.
      for (let i = 0; i < 60 && errores().length === 0; i += 1) await new Promise(r => setTimeout(r, 100))
    } finally {
      caja.soltar()
      await caja.termino
    }
    expect(await prisma.payment.count({ where: { orderId } })).toBe(2)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PAID')
    // El residuo declarado: el paso se rindió, el uso quedó libre y lo dice el log.
    expect(errores().length).toBeGreaterThan(0)
    expect(await usos()).toBe(antes)

    // La terminal reenvía el abono 1 con su llave: el paso se termina y gasta UN uso.
    await cobrarEnTpv(orderId, llave1, { centavos: 5000, split: 'CUSTOMAMOUNT' })
    expect(await prisma.payment.count({ where: { orderId } })).toBe(2)
    expect(await usosLlegaA(antes + 1)).toBe(antes + 1)
    expect(await respentidos(orderId)).toHaveLength(1)
  })

  it('🔴 Codex r1 #1: la TPV vieja manda SIN llave y reenvía por referencia a la misma ruta: el reenvío cura el uso (un pago, un uso)', async () => {
    const { orderId, antes } = await anuladaConDescuento()
    const referencia = `ref-orden-${orderId}`
    const paso = jest.spyOn(cuentaCancelada, 'volverAGastarUsosTrasElCobro').mockResolvedValueOnce(0)
    try {
      await cobrarEnTpv(orderId, null, { referencia })
      expect(paso).toHaveBeenCalledTimes(1)
    } finally {
      paso.mockRestore()
    }
    expect(await prisma.payment.findFirst({ where: { orderId }, select: { idempotencyKey: true } })).toEqual({ idempotencyKey: null })
    expect(await usos()).toBe(antes)

    await cobrarEnTpv(orderId, null, { referencia })
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1)
    expect(await usosLlegaA(antes + 1)).toBe(antes + 1)
    await cobrarEnTpv(orderId, null, { referencia })
    expect(await usos()).toBe(antes + 1)
  })

  it('🔴 Codex r2 #1: la cola de la TPV 1.2.0 reenvía por PAGO RÁPIDO, sin llave y con la misma referencia: también cura el uso', async () => {
    const { orderId, antes } = await anuladaConDescuento()
    const referencia = `ref-rapido-${orderId}`
    const paso = jest.spyOn(cuentaCancelada, 'volverAGastarUsosTrasElCobro').mockResolvedValueOnce(0)
    try {
      await cobrarEnTpv(orderId, null, { referencia })
    } finally {
      paso.mockRestore()
    }
    expect(await usos()).toBe(antes)

    const r: any = await reenviarPorPagoRapido(null, { referencia })
    expect(r.orderId).toBe(orderId)
    expect(await prisma.payment.count({ where: { venueId, referenceNumber: referencia } })).toBe(1)
    expect(await usosLlegaA(antes + 1)).toBe(antes + 1)
    expect(await respentidos(orderId)).toHaveLength(1)
  })

  it('🔴 el mismo intento reenviado por Pago rápido CON su llave también cura el uso', async () => {
    const { orderId, antes } = await anuladaConDescuento()
    const llave = `tpv-rapido-llave-${orderId}`
    const paso = jest.spyOn(cuentaCancelada, 'volverAGastarUsosTrasElCobro').mockResolvedValueOnce(0)
    try {
      await cobrarEnTpv(orderId, llave)
    } finally {
      paso.mockRestore()
    }
    expect(await usos()).toBe(antes)

    const r: any = await reenviarPorPagoRapido(llave)
    expect(r.orderId).toBe(orderId)
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1)
    expect(await usosLlegaA(antes + 1)).toBe(antes + 1)
  })

  it('el punto único (`reabrirSiRecibeDinero`, el mismo de la TPV y del panel): revive y vuelve a gastar; otra anulación lo devuelve otra vez', async () => {
    const { orderId, antes } = await anuladaConDescuento()

    await withDeadlockRetry(
      async tx => {
        await lockExistingOrderForPayment(tx, { venueId, orderId })
        await reabrirSiRecibeDinero(tx, {
          venueId,
          orderId,
          status: 'CANCELLED',
          originSystem: 'AVOQADO',
          cobrado: 50,
          cubreComoCancelada: false,
          canal: 'recordOrderPayment',
          staffId,
        })
      },
      { etiqueta: 'd26-revive-test' },
    )

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PENDING')
    expect(await usos()).toBe(antes + 1)

    // Revivida y viva: otra anulación devuelve el uso (una vez), como la primera.
    await prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'PENDING' } })
    await cancelOrder(venueId, orderId, 'anulada otra vez', staffId)
    expect(await usos()).toBe(antes)
    expect(await filas(orderId)).toEqual([{ discountId: promoId, usoContado: false, usoDevueltoAlAnular: true }])
  })

  it('🔴 D19 «A»: si otra caja ya tomó el último uso, el cobro tardío NO se rechaza; el contador queda uno arriba del tope y el dueño lo ve', async () => {
    const { orderId, antes } = await anuladaConDescuento()
    // Otra caja dio la rebaja que quedó libre: el tope ya está lleno.
    await prisma.discount.update({ where: { id: promoId }, data: { maxTotalUses: antes } })
    try {
      await payCashOrder(venueId, orderId, {
        amount: 9000,
        tip: 0,
        staffId,
        idempotencyKey: `cola-tope-${orderId}`,
        isOfflineReplay: true,
      } as any)

      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PAID')
      expect(await usos()).toBe(antes + 1)
      expect(await sobreTope(orderId)).toEqual([
        { data: expect.objectContaining({ discountId: promoId, usos: antes + 1, tope: antes, camino: 'reapertura' }) },
      ])
    } finally {
      await prisma.discount.update({ where: { id: promoId }, data: { maxTotalUses: 100 } })
    }
  })

  it('regresión: una cuenta cancelada sin descuento marcado revive igual y no toca ningún contador', async () => {
    const orderId = await cuentaAbierta()
    await cancelOrder(venueId, orderId, 'sin descuento', staffId)
    const antes = await usos()

    await payCashOrder(venueId, orderId, {
      amount: 10000,
      tip: 0,
      staffId,
      idempotencyKey: `cola-sin-${orderId}`,
      isOfflineReplay: true,
    } as any)

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PAID')
    expect(await usos()).toBe(antes)
    expect(await respentidos(orderId)).toEqual([])
  })
})
