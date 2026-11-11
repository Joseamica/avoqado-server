/**
 * S13 (P2-6): «Guardar en mi cuenta» contra Postgres REAL. El claim y la lectura de códigos con dos transacciones de verdad:
 *  - E4: la propia, la repetida y la de otra clienta; nunca mueve saldo.
 *  - E5 (codex-plan2-r1 #1): el gerente repone el código mientras el claim espera el candado ⇒ 404 y nada escrito.
 *  - R1/R1': S8 cambia el número, o el panel desactiva a la clienta, mientras el claim o la lectura de códigos esperan la ficha ⇒ 401 sin
 *    escribir ni revelar.
 *  - E6: una tarjeta guardada no se vuelve saldo a favor (ni un reembolso la recarga).
 *  - R8: el panel ve a la dueña y su CLAIM; bloquear, desbloquear y vencer; cruces con el cobro con esa tarjeta y con «regresar el saldo
 *    y cancelar» (S9); y la red por traba: un 40P01 real contra el claim se reintenta y guarda UNA vez.
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
  reintentarAvisosDeTarjeta: jest.fn().mockResolvedValue({ avisados: 0, fallidos: 0, ocupados: 0 }),
}))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  ...jest.requireActual('@/services/shared/cashDrawerPosting'),
  postCashSaleToDrawer: jest.fn().mockResolvedValue(undefined),
  postCashRefundToDrawer: jest.fn().mockResolvedValue('NOT_DRAWER_CASH'),
}))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))

import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { encryptGiftCardCode, generateGiftCardCode, generateOpaqueToken, hashGiftCardCode } from '@/services/giftCards/giftCardCode'
import {
  esSobreDeSaldoAFavor,
  lockGiftCardsForUpdate,
  operarSobreDeGerenteEnTx,
  prepararSobreDeSaldoAFavorEnTx,
} from '@/services/giftCards/giftCardLedger'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { guardarTarjetaEnMiCuenta, type SesionDeLaClienta } from '@/services/giftCards/giftCardClaim.service'
import { operarSobreDeGerente } from '@/services/giftCards/giftCardSurface.service'
import { getGiftCardDetail } from '@/services/giftCards/giftCardReports.service'
import { getCustomerPortal, listarMisTarjetas } from '@/services/public/customerPortal.public.service'
import { payGiftCardBalanceOnOrder, returnGiftBalanceAndCancelOrder } from '@/services/mobile/order.mobile.service'
import { withDeadlockRetry, type TxConReintento } from '@/utils/serializableRetry'
import { esperarAQueAlguienEspereA, limpiarNegocioDePrueba, pidDe } from './sembrarTarjetasDeRegalo'

jest.setTimeout(120000)

const SUF = `guardar-${process.pid}-${Date.now()}`
const D = (v: number) => new Prisma.Decimal(v)
const PRESUPUESTO = { timeout: 20_000, maxWait: 5_000 }
let orgId: string
let venueId: string
let staffId: string
let n = 0

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: SUF, email: `${SUF}@example.test`, phone: '5500000000' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: SUF, slug: SUF, timezone: 'America/Mexico_City' } })).id
  staffId = (await prisma.staff.create({ data: { email: `${SUF}@staff.test`, firstName: 'Caja', lastName: 'QA', active: true } })).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'MANAGER', active: true } })
  await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000, 2000] } })
  await ensureGiftCardTender(prisma, venueId)
})
afterAll(async () => {
  await limpiarNegocioDePrueba(venueId)
})

/** Un sobre ACTIVE con su código real y su ACTIVATE. Sin dueña. */
async function tarjeta(monto = 1000) {
  n += 1
  const c = generateGiftCardCode()
  const s = await prisma.giftCard.create({
    data: {
      venueId,
      organizationId: orgId,
      codeHash: hashGiftCardCode(c.normalized),
      codeEnc: encryptGiftCardCode(c.normalized),
      codeLast4: c.last4,
      pageToken: generateOpaqueToken(),
      initialAmount: D(monto),
      balance: D(monto),
      status: 'ACTIVE',
      activatedAt: new Date(),
      termsVersion: '2026-10-14',
      deliveryChannel: 'PRINTED',
    },
  })
  await prisma.giftCardActivity.create({ data: { giftCardId: s.id, venueId, type: 'ACTIVATE', amount: D(monto), balanceAfter: D(monto) } })
  return { id: s.id, codigo: c.display, last4: c.last4 }
}

/** Una clienta con su teléfono probado por la sesión (como la deja S6/S7). */
async function clienta(nombre: string) {
  n += 1
  const phone = `+5255${String(10000000 + n * 7919).slice(0, 8)}`
  const c = await prisma.customer.create({ data: { venueId, firstName: nombre, phone } })
  const sesion: SesionDeLaClienta & { tipo: 'SESION' } = {
    customerId: c.id,
    contactos: [{ tipo: 'PHONE', valor: phone, metodo: 'WHATSAPP', probadoEn: Math.floor(Date.now() / 1000) }],
    verifiedPhone: phone,
    v: 0,
    tipo: 'SESION',
  }
  return { id: c.id, phone, sesion }
}

async function cuentaDeMercancia(monto: number) {
  n += 1
  return (
    await prisma.order.create({
      data: {
        venueId,
        orderNumber: `${SUF}-o${n}`,
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: D(monto),
        taxAmount: D(0),
        total: D(monto),
        remainingBalance: D(monto),
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
        items: { create: [{ productName: 'Blusa', quantity: 1, unitPrice: D(monto), taxAmount: D(0), total: D(monto) }] },
      },
    })
  ).id
}

const fila = (id: string) => prisma.giftCard.findUniqueOrThrow({ where: { id } })
const claims = (id: string) => prisma.giftCardActivity.count({ where: { giftCardId: id, type: 'CLAIM' } })
const bitacora = (id: string) => prisma.activityLog.count({ where: { venueId, entityId: id, action: 'GIFT_CARD_CLAIMED' } })

/**
 * codex-s13-r2: espera a que `cuantos` sesiones distintas estén detenidas por un candado que sostiene `pidQueTiene` (los DOS
 * contendientes de un cruce, no sólo el primero). Lanza si no llegan en ~5 s.
 */
async function esperarAQueEsperenA(pidQueTiene: number, cuantos: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    // El segundo en llegar espera el candado de fila que tomó el PRIMERO en la cola (no al dueño): se cuenta a quien espera al dueño
    // y a quien espera a uno de ésos.
    const [fila] = await prisma.$queryRaw<Array<{ n: number }>>`
      WITH primeros AS (
        SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND ${pidQueTiene}::int = ANY(pg_blocking_pids(pid))
      )
      SELECT count(*)::int AS n FROM pg_stat_activity a
      WHERE a.datname = current_database()
        AND (${pidQueTiene}::int = ANY(pg_blocking_pids(a.pid)) OR EXISTS (SELECT 1 FROM primeros f WHERE f.pid = ANY(pg_blocking_pids(a.pid))))`
    if (fila.n >= cuantos) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`No llegaron ${cuantos} sesiones a esperar el candado que sostiene el proceso ${pidQueTiene}`)
}

/** Una transacción de la prueba que toma algo y no confirma hasta que la soltemos (molde de cobroConSaldo). */
function sostener<T>(cuerpo: (tx: Prisma.TransactionClient) => Promise<T>) {
  let avisar!: (pid: number) => void
  const tomado = new Promise<number>(r => (avisar = r))
  let soltar!: () => void
  const suelta = new Promise<void>(r => (soltar = r))
  const tx = prisma.$transaction(async t => {
    const r = await cuerpo(t)
    avisar(await pidDe(t))
    await suelta
    return r
  }, PRESUPUESTO)
  return { tomado, soltar, tx }
}

describe('E4 · guardar, repetir y la de otra', () => {
  it('guardar pone customerId y UN CLAIM de $0 con su bitácora; repetir no agrega nada; de otra ⇒ 409; el saldo no se mueve', async () => {
    const t = await tarjeta(1000)
    const ana = await clienta('Ana')
    const bety = await clienta('Bety')
    const r = await guardarTarjetaEnMiCuenta(venueId, ana.sesion, t.codigo, { ip: '203.0.113.4' })
    expect(r).toEqual({ giftCardId: t.id, last4: t.last4, saldo: 1000 })
    expect((await fila(t.id)).customerId).toBe(ana.id)
    const [claim] = await prisma.giftCardActivity.findMany({ where: { giftCardId: t.id, type: 'CLAIM' }, take: 2 })
    expect([claim.amount.toFixed(2), claim.balanceAfter.toFixed(2)]).toEqual(['0.00', '1000.00'])
    expect(await bitacora(t.id)).toBe(1)

    expect(await guardarTarjetaEnMiCuenta(venueId, ana.sesion, t.codigo, { ip: null })).toEqual(r)
    expect(await claims(t.id)).toBe(1)
    expect(await bitacora(t.id)).toBe(1)

    await expect(guardarTarjetaEnMiCuenta(venueId, bety.sesion, t.codigo, { ip: null })).rejects.toMatchObject({
      statusCode: 409,
      code: 'GIFT_CARD_ALREADY_SAVED',
    })
    expect((await fila(t.id)).customerId).toBe(ana.id)
    expect((await fila(t.id)).balance.toFixed(2)).toBe('1000.00')
    expect(await claims(t.id)).toBe(1)
  })

  it('R8 · el panel ve a la dueña y la actividad CLAIM (y ya no ofrece reponer el código)', async () => {
    const t = await tarjeta(500)
    const ana = await clienta('Ana Panel')
    await guardarTarjetaEnMiCuenta(venueId, ana.sesion, t.codigo, { ip: null })
    const detalle = await getGiftCardDetail(venueId, t.id, {})
    expect(detalle.customer).toEqual({ id: ana.id, name: expect.stringContaining('Ana Panel') })
    expect(detalle.storeCredit).toBeNull()
    expect(detalle.canReplaceCode).toBe(false)
    expect(detalle.activities.items.map(a => a.type)).toEqual(expect.arrayContaining(['CLAIM', 'ACTIVATE']))
  })
})

describe('E6 · una tarjeta guardada no se vuelve saldo a favor', () => {
  it('EL predicado sigue en falso, el sobre de saldo a favor de la clienta sigue sin existir y «Mi cuenta» la pone en tarjetas', async () => {
    const t = await tarjeta(700)
    const ana = await clienta('Ana Saldo')
    await guardarTarjetaEnMiCuenta(venueId, ana.sesion, t.codigo, { ip: null })
    expect(await esSobreDeSaldoAFavor(prisma, t.id)).toBe(false)
    // R8: un reembolso que crea o recarga saldo a favor elige su sobre con este paso: nunca la tarjeta guardada.
    const preparado = await withDeadlockRetry(tx => prepararSobreDeSaldoAFavorEnTx(tx, { venueId, customerId: ana.id }), {
      etiqueta: 'prueba-preparar',
    })
    expect(preparado.sobre).toBeNull()
    const portal: any = await getCustomerPortal(venueId, ana.id, ana.sesion)
    expect(portal.saldoAFavor).toBeNull()
    expect(portal.tarjetas.items.map((x: any) => [x.id, x.saldo, x.codigo, x.estado])).toEqual([[t.id, 700, t.codigo, 'ACTIVA']])
  })
})

describe('E5 · el gerente repone el código mientras el claim espera el candado', () => {
  it('el claim resolvió el código VIEJO y se detuvo en la tarjeta ⇒ 404, customerId sigue nulo y sin CLAIM', async () => {
    const t = await tarjeta(1000)
    const ana = await clienta('Ana Repone')
    const gerente = sostener(async tx => {
      await lockGiftCardsForUpdate(tx as unknown as TxConReintento, [t.id])
      return operarSobreDeGerenteEnTx(tx as unknown as TxConReintento, {
        venueId,
        giftCardId: t.id,
        staffId,
        operationKey: `${SUF}-repone-${n}`,
        op: { tipo: 'REEMPLAZAR_CODIGO', reason: 'LOST_CARD' },
      })
    })
    const pid = await gerente.tomado
    const claim = guardarTarjetaEnMiCuenta(venueId, ana.sesion, t.codigo, { ip: null })
    claim.catch(() => undefined)
    await esperarAQueAlguienEspereA(pid)
    gerente.soltar()
    const [repuesto, resultado] = await Promise.allSettled([gerente.tx, claim])
    expect(repuesto.status).toBe('fulfilled')
    expect(resultado).toMatchObject({ status: 'rejected', reason: { statusCode: 404, code: 'GIFT_CARD_NOT_FOUND' } })
    expect((await fila(t.id)).customerId).toBeNull()
    expect(await claims(t.id)).toBe(0)
    expect(await bitacora(t.id)).toBe(0)
  })
})

describe("R1/R1' · la sesión se revalida bajo el candado de la ficha (dos transacciones reales)", () => {
  /** Lo que escribe S8 (`cambiarTelefonoEnTx`): la ficha FOR NO KEY UPDATE, el número nuevo y la versión de sesión + 1. */
  const cambiaElNumero = (id: string) => async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${id} AND "venueId" = ${venueId} FOR NO KEY UPDATE`
    await tx.customer.update({
      where: { id },
      data: { phone: `+5256${Date.now().toString().slice(-8)}`, versionDeSesion: { increment: 1 } },
    })
  }
  /** El panel desactiva a la clienta (un UPDATE: el mismo candado de fila). */
  const laDesactiva = (id: string) => async (tx: Prisma.TransactionClient) => {
    await tx.customer.update({ where: { id }, data: { active: false } })
  }

  it.each([
    ['S8 cambia el número', cambiaElNumero],
    ['el panel la desactiva', laDesactiva],
  ])('claim: %s mientras el claim espera la ficha ⇒ 401 CUSTOMER_REAUTH_REQUIRED y nada escrito', async (_c, cambio) => {
    const t = await tarjeta(1000)
    const ana = await clienta('Ana Revoca')
    const otro = sostener(cambio(ana.id))
    const pid = await otro.tomado
    const claim = guardarTarjetaEnMiCuenta(venueId, ana.sesion, t.codigo, { ip: null })
    claim.catch(() => undefined)
    await esperarAQueAlguienEspereA(pid)
    otro.soltar()
    const [cambiado, resultado] = await Promise.allSettled([otro.tx, claim])
    expect(cambiado.status).toBe('fulfilled')
    expect(resultado).toMatchObject({ status: 'rejected', reason: { statusCode: 401, code: 'CUSTOMER_REAUTH_REQUIRED' } })
    expect((await fila(t.id)).customerId).toBeNull()
    expect(await claims(t.id)).toBe(0)
    expect(await bitacora(t.id)).toBe(0)
  })

  it.each([
    ['S8 cambia el número', cambiaElNumero],
    ['el panel la desactiva', laDesactiva],
  ])('lectura de códigos: %s mientras la lectura espera la ficha ⇒ 401, sin revelar ningún código', async (_c, cambio) => {
    const t = await tarjeta(300)
    const ana = await clienta('Ana Lee')
    await guardarTarjetaEnMiCuenta(venueId, ana.sesion, t.codigo, { ip: null })
    const otro = sostener(cambio(ana.id))
    const pid = await otro.tomado
    const lectura = listarMisTarjetas(venueId, ana.id, ana.sesion, {})
    const portal = getCustomerPortal(venueId, ana.id, ana.sesion)
    lectura.catch(() => undefined)
    portal.catch(() => undefined)
    await esperarAQueAlguienEspereA(pid)
    otro.soltar()
    const [, leida, delPortal] = await Promise.allSettled([otro.tx, lectura, portal])
    expect(leida).toMatchObject({ status: 'rejected', reason: { statusCode: 401, code: 'CUSTOMER_REAUTH_REQUIRED' } })
    expect(delPortal).toMatchObject({ status: 'rejected', reason: { statusCode: 401 } })
  })
})

describe('R6 y R8 · bloquear, desbloquear y vencer', () => {
  it('bloqueada: no se guarda (el mismo 404) y, ya guardada, «Mi cuenta» la muestra BLOQUEADA sin código; al desbloquear vuelve', async () => {
    const libre = await tarjeta(400)
    const t = await tarjeta(400)
    const ana = await clienta('Ana Bloqueo')
    await guardarTarjetaEnMiCuenta(venueId, ana.sesion, t.codigo, { ip: null })
    for (const id of [libre.id, t.id]) {
      await operarSobreDeGerente(venueId, id, staffId, {
        operationKey: `${SUF}-bloq-${id}`,
        tipo: 'BLOQUEAR',
        reason: 'SUSPICIOUS_ACTIVITY',
      })
    }
    await expect(guardarTarjetaEnMiCuenta(venueId, ana.sesion, libre.codigo, { ip: null })).rejects.toMatchObject({
      statusCode: 404,
      code: 'GIFT_CARD_NOT_FOUND',
    })
    expect((await fila(libre.id)).customerId).toBeNull()
    const bloqueada = (await listarMisTarjetas(venueId, ana.id, ana.sesion, {})).items.find(x => x.id === t.id)
    expect(bloqueada).toMatchObject({ estado: 'BLOQUEADA', disponible: false, codigo: null, saldo: 400 })

    await operarSobreDeGerente(venueId, t.id, staffId, {
      operationKey: `${SUF}-desbloq-${t.id}`,
      tipo: 'DESBLOQUEAR',
      reason: 'SUSPICIOUS_ACTIVITY',
    })
    const activa = (await listarMisTarjetas(venueId, ana.id, ana.sesion, {})).items.find(x => x.id === t.id)
    expect(activa).toMatchObject({ estado: 'ACTIVA', disponible: true, codigo: t.codigo })
  })

  it('vencida: no se guarda (el mismo 404) y, ya guardada, sale VENCIDA sin código', async () => {
    const libre = await tarjeta(200)
    const t = await tarjeta(200)
    const ana = await clienta('Ana Vence')
    await guardarTarjetaEnMiCuenta(venueId, ana.sesion, t.codigo, { ip: null })
    const ayer = new Date(Date.now() - 86_400_000)
    await prisma.giftCard.updateMany({ where: { id: { in: [libre.id, t.id] } }, data: { expiresAt: ayer } })
    await expect(guardarTarjetaEnMiCuenta(venueId, ana.sesion, libre.codigo, { ip: null })).rejects.toMatchObject({ statusCode: 404 })
    const vencida = (await listarMisTarjetas(venueId, ana.id, ana.sesion, {})).items.find(x => x.id === t.id)
    expect(vencida).toMatchObject({ estado: 'VENCIDA', disponible: false, codigo: null })
  })
})

describe('R8 · cruces reales del claim', () => {
  it('con el cobro de ESA tarjeta: los dos esperan el candado y los dos terminan; el saldo baja una vez y el CLAIM dice el de su momento', async () => {
    const t = await tarjeta(1000)
    const ana = await clienta('Ana Cobro')
    const orderId = await cuentaDeMercancia(1000)
    const tapon = sostener(tx => lockGiftCardsForUpdate(tx as unknown as TxConReintento, [t.id]))
    const pid = await tapon.tomado
    const claim = guardarTarjetaEnMiCuenta(venueId, ana.sesion, t.codigo, { ip: null })
    const cobro = payGiftCardBalanceOnOrder(venueId, orderId, {
      idempotencyKey: `${SUF}-cobro-${n}`,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(300),
      tip: D(0),
      staffId,
      deviceId: null,
    })
    claim.catch(() => undefined)
    cobro.catch(() => undefined)
    // Los DOS contendientes (el claim y el cobro, o el claim y S9) están detenidos en la tarjeta antes de soltarla.
    await esperarAQueEsperenA(pid, 2)
    tapon.soltar()
    const [, guardado, cobrado] = await Promise.allSettled([tapon.tx, claim, cobro])
    expect(guardado.status).toBe('fulfilled')
    expect(cobrado.status).toBe('fulfilled')
    expect((await fila(t.id)).balance.toFixed(2)).toBe('700.00')
    expect((await fila(t.id)).customerId).toBe(ana.id)
    const libreta = await prisma.giftCardActivity.findMany({
      where: { giftCardId: t.id, type: { in: ['CLAIM', 'REDEEM'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 5,
    })
    expect(libreta.map(a => a.type).sort()).toEqual(['CLAIM', 'REDEEM'])
    const claimFila = libreta.find(a => a.type === 'CLAIM')!
    expect(claimFila.amount.toFixed(2)).toBe('0.00')
    expect(['1000.00', '700.00']).toContain(claimFila.balanceAfter.toFixed(2))
  })

  it('con «regresar el saldo y cancelar» (S9) de una cuenta pagada con ESA tarjeta: los dos terminan y el saldo vuelve entero', async () => {
    const t = await tarjeta(1000)
    const ana = await clienta('Ana S9')
    const orderId = await cuentaDeMercancia(1000)
    await payGiftCardBalanceOnOrder(venueId, orderId, {
      idempotencyKey: `${SUF}-s9-${n}`,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(300),
      tip: D(0),
      staffId,
      deviceId: null,
    })
    expect((await fila(t.id)).balance.toFixed(2)).toBe('700.00')
    const tapon = sostener(tx => lockGiftCardsForUpdate(tx as unknown as TxConReintento, [t.id]))
    const pid = await tapon.tomado
    const claim = guardarTarjetaEnMiCuenta(venueId, ana.sesion, t.codigo, { ip: null })
    const regreso = returnGiftBalanceAndCancelOrder(venueId, orderId, { staffId, operationKey: `${SUF}-regresa-${n}` })
    claim.catch(() => undefined)
    regreso.catch(() => undefined)
    // Los DOS contendientes (el claim y el cobro, o el claim y S9) están detenidos en la tarjeta antes de soltarla.
    await esperarAQueEsperenA(pid, 2)
    tapon.soltar()
    const [, guardado, regresado] = await Promise.allSettled([tapon.tx, claim, regreso])
    expect(guardado.status).toBe('fulfilled')
    expect(regresado).toMatchObject({ status: 'fulfilled', value: { replay: false } })
    expect((await fila(t.id)).balance.toFixed(2)).toBe('1000.00')
    expect((await fila(t.id)).customerId).toBe(ana.id)
    expect(await claims(t.id)).toBe(1)
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: t.id, type: 'REDEEM_REVERSAL' } })).toBe(1)
  })

  it('red por traba: un escritor viejo que toma la tarjeta y DESPUÉS la ficha cruza con el claim (40P01 real) ⇒ se repite y guarda UNA vez', async () => {
    const t = await tarjeta(900)
    const ana = await clienta('Ana Traba')
    const avisos = jest.spyOn(logger, 'warn')
    let avisarTomado!: (pid: number) => void
    const tomado = new Promise<number>(r => (avisarTomado = r))
    let seguir!: () => void
    const puedeSeguir = new Promise<void>(r => (seguir = r))
    // El orden de hoy de algunos escritores viejos (R63 c): GiftCard → Customer, al revés del claim (Customer → GiftCard).
    const viejo = prisma.$transaction(async tx => {
      await lockGiftCardsForUpdate(tx as unknown as TxConReintento, [t.id])
      avisarTomado(await pidDe(tx))
      await puedeSeguir
      await tx.customer.update({ where: { id: ana.id }, data: { totalVisits: { increment: 1 } } })
    }, PRESUPUESTO)
    viejo.catch(() => undefined)
    const pid = await tomado
    // El claim toma la ficha FOR SHARE y se detiene en la tarjeta; entonces el viejo pide la ficha: ciclo, Postgres aborta a uno.
    const claim = guardarTarjetaEnMiCuenta(venueId, ana.sesion, t.codigo, { ip: null })
    claim.catch(() => undefined)
    await esperarAQueAlguienEspereA(pid)
    seguir()
    const [delViejo, guardado] = await Promise.allSettled([viejo, claim])
    expect(guardado.status).toBe('fulfilled')
    expect(await claims(t.id)).toBe(1)
    expect((await fila(t.id)).customerId).toBe(ana.id)
    const reintentosDelClaim = (avisos.mock.calls as unknown[][]).filter(
      ([msg, meta]) => String(msg).includes('interbloqueo') && (meta as any)?.etiqueta === 'guardarTarjetaEnMiCuenta',
    ).length
    // codex-s13-r2: el claim empezó a esperar primero, así que su detector de interbloqueo (deadlock_timeout) corre primero y Postgres
    // aborta AL CLAIM; la red (`withDeadlockRetry`) lo repite entero y el escritor viejo termina. Se acredita con su `warn`.
    expect(delViejo.status).toBe('fulfilled')
    expect(reintentosDelClaim).toBeGreaterThanOrEqual(1)
    avisos.mockRestore()
  })
})
