/**
 * La libreta contra Postgres REAL (Tarea A4). Lo que un mock no puede probar: el `SELECT … FOR UPDATE` del sobre
 * serializa a dos cajas, y la llave de una operación de gerente no mueve el saldo dos veces.
 *
 * Correr: source ../urls-tarjetas.sh && TZ=UTC npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/giftCards/giftCardLedger.integration.test.ts --ci --runInBand
 *
 * La libreta no se puede borrar (trigger): la base es desechable y este archivo no limpia; usa nombres únicos.
 */
import { Prisma } from '@prisma/client'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { canjearSobresEnTx, lockGiftCardsForUpdate, operarSobreDeGerenteEnTx, revertirCanjeEnTx } from '@/services/giftCards/giftCardLedger'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'
import { operarSobreDeGerente } from '@/services/giftCards/giftCardSurface.service'
// ⭐ (A4 menor 5): la espera filtra por `pg_blocking_pids` del que tiene el candado (ver la siembra).
import { esperarAQueAlguienEspereA, pidDe } from './sembrarTarjetasDeRegalo'

jest.setTimeout(60000)

const SUF = `libreta-${process.pid}-${Date.now()}`
const PRESUPUESTO = { timeout: 15_000, maxWait: 5_000 }
const D = (v: number) => new Prisma.Decimal(v)
let orgId: string
let venueId: string
// ⭐ (A4 menor 6): todo id escrito a mano es cuid v1, como `@default(cuid())`.
const staffId = cuid()
let n = 0

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: SUF, email: `${SUF}@example.test`, phone: '5500000000' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: SUF, slug: SUF } })).id
})

async function sobreActivo(monto: number) {
  n += 1
  const s = await prisma.giftCard.create({
    data: {
      venueId,
      organizationId: orgId,
      codeHash: `${SUF}-h${n}`,
      codeEnc: 'cifrado-de-prueba',
      codeLast4: 'ABCD',
      pageToken: `${SUF}-p${n}`,
      initialAmount: D(monto),
      balance: D(monto),
      status: 'ACTIVE',
      activatedAt: new Date(),
      termsVersion: '2026-10-14',
      deliveryChannel: 'PRINTED',
    },
  })
  await prisma.giftCardActivity.create({
    data: { giftCardId: s.id, venueId, type: 'ACTIVATE', amount: D(monto), balanceAfter: D(monto) },
  })
  return s
}

describe('libreta de tarjetas de regalo · Postgres real', () => {
  it('🔴 dos cajas cobran $600 del MISMO sobre de $1,000 a la vez: una pasa, la otra recibe «quedan $400» y nada queda negativo', async () => {
    const s = await sobreActivo(1000)
    let avisarQueTieneCandado!: () => void
    const cajaUnoTieneElCandado = new Promise<void>(resolve => (avisarQueTieneCandado = resolve))

    const cajaUno = prisma.$transaction(async tx => {
      const cards = await lockGiftCardsForUpdate(tx, [s.id])
      avisarQueTieneCandado()
      await esperarAQueAlguienEspereA(await pidDe(tx))
      return canjearSobresEnTx(tx, { venueId, orderId: cuid(), paymentId: cuid(), amount: D(600), cards, staffId })
    }, PRESUPUESTO)
    const cajaDos = cajaUnoTieneElCandado.then(() =>
      prisma.$transaction(async tx => {
        const cards = await lockGiftCardsForUpdate(tx, [s.id])
        return canjearSobresEnTx(tx, { venueId, orderId: cuid(), paymentId: cuid(), amount: D(600), cards, staffId })
      }, PRESUPUESTO),
    )

    const [uno, dos] = await Promise.allSettled([cajaUno, cajaDos])
    expect(uno.status).toBe('fulfilled')
    expect(dos.status).toBe('rejected')
    const error = (dos as PromiseRejectedResult).reason
    expect(error).toBeInstanceOf(GiftCardError)
    expect(error).toMatchObject({ code: 'GIFT_CARD_INSUFFICIENT_BALANCE', details: { saldoDisponible: 400 } })
    expect(error.message).toBe('Quedan $400.00 en la tarjeta de regalo.')

    const final = await prisma.giftCard.findUniqueOrThrow({ where: { id: s.id } })
    expect(final.balance.toFixed(2)).toBe('400.00')
    const canjes = await prisma.giftCardActivity.findMany({ where: { giftCardId: s.id, type: 'REDEEM' }, take: 10 })
    expect(canjes.map(c => [c.amount.toFixed(2), c.balanceAfter.toFixed(2)])).toEqual([['600.00', '400.00']])
  })

  it('⭐ (A4 menor 3) un canje con una foto VIEJA del sobre no escribe un saldo inventado: 409 de concurrencia y el saldo intacto', async () => {
    const s = await sobreActivo(1000)
    // La foto se toma bajo candado y la transacción termina: queda vieja en cuanto otra caja cobra.
    const fotoVieja = await prisma.$transaction(tx => lockGiftCardsForUpdate(tx, [s.id]), PRESUPUESTO)
    await prisma.$transaction(async tx => {
      const cards = await lockGiftCardsForUpdate(tx, [s.id])
      return canjearSobresEnTx(tx, { venueId, orderId: cuid(), paymentId: cuid(), amount: D(300), cards, staffId })
    }, PRESUPUESTO)

    await expect(
      prisma.$transaction(
        tx => canjearSobresEnTx(tx, { venueId, orderId: cuid(), paymentId: cuid(), amount: D(100), cards: fotoVieja, staffId }),
        PRESUPUESTO,
      ),
    ).rejects.toMatchObject({ code: 'ORDER_PAYMENT_CONFLICT', statusCode: 409 })

    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: s.id } })).balance.toFixed(2)).toBe('700.00')
    const canjes = await prisma.giftCardActivity.findMany({ where: { giftCardId: s.id, type: 'REDEEM' }, take: 10 })
    expect(canjes.map(c => c.balanceAfter.toFixed(2))).toEqual(['700.00'])
  })

  it('el mismo cobro no puede descontar dos veces el mismo sobre (paymentId, giftCardId, REDEEM es único)', async () => {
    const s = await sobreActivo(1000)
    const orderId = cuid()
    const paymentId = cuid()
    const cobrar = () =>
      prisma.$transaction(async tx => {
        const cards = await lockGiftCardsForUpdate(tx, [s.id])
        return canjearSobresEnTx(tx, { venueId, orderId, paymentId, amount: D(100), cards, staffId })
      }, PRESUPUESTO)
    await cobrar()
    await expect(cobrar()).rejects.toMatchObject({ code: 'P2002' })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: s.id } })).balance.toFixed(2)).toBe('900.00')
  })

  it('🔴 el dashboard reintenta un ajuste con la MISMA operationKey (en serie y a la vez): el saldo cambia UNA vez', async () => {
    const s = await sobreActivo(1000)
    const ajustar = (operationKey: string, monto: number) =>
      prisma.$transaction(
        tx =>
          operarSobreDeGerenteEnTx(tx, {
            venueId,
            giftCardId: s.id,
            staffId,
            operationKey,
            op: { tipo: 'AJUSTE', direccion: 'INCREMENT', amount: D(monto), reason: 'CUSTOMER_REQUEST', note: 'Compensación' },
          }),
        PRESUPUESTO,
      )

    const primero = await ajustar(`${SUF}-ajuste-1`, 50)
    const reintento = await ajustar(`${SUF}-ajuste-1`, 50)
    expect(reintento.activityIds).toEqual(primero.activityIds)
    // r1 (F9): «nuevo o repetición» sale de la decisión bajo candado.
    expect([primero.replay, reintento.replay]).toEqual([false, true])
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: s.id } })).balance.toFixed(2)).toBe('1050.00')

    const [x, y] = await Promise.all([ajustar(`${SUF}-ajuste-2`, 50), ajustar(`${SUF}-ajuste-2`, 50)])
    expect(x.activityIds).toEqual(y.activityIds)
    expect([x.replay, y.replay].sort()).toEqual([false, true]) // exactamente uno escribió
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: s.id } })).balance.toFixed(2)).toBe('1100.00')
    expect(await prisma.giftCardActivity.count({ where: { venueId, operationKey: `${SUF}-ajuste-2` } })).toBe(1)

    await expect(ajustar(`${SUF}-ajuste-1`, 70)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: s.id } })).balance.toFixed(2)).toBe('1100.00')
  })

  it('saldo = suma de la libreta después de cobros y ajustes (lo que revisa la noche)', async () => {
    const s = await sobreActivo(800)
    await prisma.$transaction(async tx => {
      const cards = await lockGiftCardsForUpdate(tx, [s.id])
      return canjearSobresEnTx(tx, { venueId, orderId: cuid(), paymentId: cuid(), amount: D(300), cards, staffId })
    }, PRESUPUESTO)
    await prisma.$transaction(
      tx =>
        operarSobreDeGerenteEnTx(tx, {
          venueId,
          giftCardId: s.id,
          staffId,
          operationKey: `${SUF}-ajuste-s`,
          op: { tipo: 'AJUSTE', direccion: 'DECREMENT', amount: D(100), reason: 'CASHIER_ERROR' },
        }),
      PRESUPUESTO,
    )
    const filas = await prisma.giftCardActivity.findMany({ where: { giftCardId: s.id }, take: 50 })
    const signo: Record<string, number> = { ACTIVATE: 1, REDEEM: -1, REDEEM_REVERSAL: 1, ADJUST_INCREMENT: 1, ADJUST_DECREMENT: -1 }
    const suma = filas.reduce((t, f) => t.plus(f.amount.mul(signo[f.type] ?? 0)), D(0))
    const sobre = await prisma.giftCard.findUniqueOrThrow({ where: { id: s.id } })
    expect(suma.toFixed(2)).toBe(sobre.balance.toFixed(2))
    expect(sobre.balance.toFixed(2)).toBe('400.00')
  })

  it('🔴 r1 (F7): $10,000 → canje $5,000 → ajuste +$5,000 rechazado → el reverso del canje sí entra y queda en $10,000, nunca $15,000', async () => {
    const s = await sobreActivo(10000)
    const pago = cuid()
    await prisma.$transaction(async tx => {
      const cards = await lockGiftCardsForUpdate(tx, [s.id])
      return canjearSobresEnTx(tx, { venueId, orderId: cuid(), paymentId: pago, amount: D(5000), cards, staffId })
    }, PRESUPUESTO)

    await expect(
      prisma.$transaction(
        tx =>
          operarSobreDeGerenteEnTx(tx, {
            venueId,
            giftCardId: s.id,
            staffId,
            operationKey: `${SUF}-techo-1`,
            op: { tipo: 'AJUSTE', direccion: 'INCREMENT', amount: D(5000), reason: 'CUSTOMER_REQUEST', note: 'Compensación' },
          }),
        PRESUPUESTO,
      ),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_AMOUNT_OUT_OF_RANGE' })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: s.id } })).balance.toFixed(2)).toBe('5000.00')

    // El reverso nunca se rechaza por el techo: regresa los $5,000 del canje.
    await prisma.$transaction(
      tx => revertirCanjeEnTx(tx, { venueId, originalPaymentId: pago, refundPaymentId: cuid(), amount: D(5000), staffId }),
      PRESUPUESTO,
    )
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: s.id } })).balance.toFixed(2)).toBe('10000.00')
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: s.id, type: 'ADJUST_INCREMENT' } })).toBe(0)
  })

  it('🔴 la MISMA operationKey con la segunda petición ESPERANDO el candado (choque forzado, no a la suerte): una escribe, la otra es repetición', async () => {
    const s = await sobreActivo(1000)
    const llave = `${SUF}-ajuste-forzado`
    const op = {
      tipo: 'AJUSTE' as const,
      direccion: 'INCREMENT' as const,
      amount: D(50),
      reason: 'CUSTOMER_REQUEST' as const,
      note: 'Compensación',
    }
    let avisarQueTieneCandado!: () => void
    const primeraTieneElCandado = new Promise<void>(resolve => (avisarQueTieneCandado = resolve))

    const primera = prisma.$transaction(async tx => {
      await lockGiftCardsForUpdate(tx, [s.id])
      avisarQueTieneCandado()
      await esperarAQueAlguienEspereA(await pidDe(tx)) // la segunda ya pasó su validación y está detenida en el candado
      return operarSobreDeGerenteEnTx(tx, { venueId, giftCardId: s.id, staffId, operationKey: llave, op })
    }, PRESUPUESTO)
    const segunda = primeraTieneElCandado.then(() =>
      prisma.$transaction(tx => operarSobreDeGerenteEnTx(tx, { venueId, giftCardId: s.id, staffId, operationKey: llave, op }), PRESUPUESTO),
    )

    const [uno, dos] = await Promise.all([primera, segunda])
    expect([uno.replay, dos.replay]).toEqual([false, true])
    expect(dos.activityIds).toEqual(uno.activityIds)
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: s.id } })).balance.toFixed(2)).toBe('1050.00')
    expect(await prisma.giftCardActivity.count({ where: { venueId, operationKey: llave } })).toBe(1)
  })

  it('🔴 dos reembolsos DISTINTOS del mismo cobro con saldo a la vez: sólo se regresa lo canjeado, nunca el doble', async () => {
    const s = await sobreActivo(1000)
    const pago = cuid()
    await prisma.$transaction(async tx => {
      const cards = await lockGiftCardsForUpdate(tx, [s.id])
      return canjearSobresEnTx(tx, { venueId, orderId: cuid(), paymentId: pago, amount: D(300), cards, staffId })
    }, PRESUPUESTO)
    let avisarQueTieneCandado!: () => void
    const primeroTieneElCandado = new Promise<void>(resolve => (avisarQueTieneCandado = resolve))

    const primero = prisma.$transaction(async tx => {
      await lockGiftCardsForUpdate(tx, [s.id])
      avisarQueTieneCandado()
      await esperarAQueAlguienEspereA(await pidDe(tx)) // el segundo ya leyó sus canjes y está detenido en el candado
      return revertirCanjeEnTx(tx, { venueId, originalPaymentId: pago, refundPaymentId: cuid(), amount: D(300), staffId })
    }, PRESUPUESTO)
    const segundo = primeroTieneElCandado.then(() =>
      prisma.$transaction(
        tx => revertirCanjeEnTx(tx, { venueId, originalPaymentId: pago, refundPaymentId: cuid(), amount: D(300), staffId }),
        PRESUPUESTO,
      ),
    )

    const [uno, dos] = await Promise.allSettled([primero, segundo])
    expect(uno.status).toBe('fulfilled')
    expect(dos.status).toBe('rejected')
    expect((dos as PromiseRejectedResult).reason).toMatchObject({ code: 'GIFT_CARD_AMOUNT_OUT_OF_RANGE' })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: s.id } })).balance.toFixed(2)).toBe('1000.00')
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: s.id, type: 'REDEEM_REVERSAL' } })).toBe(1)
  })
})

/**
 * ⭐ (D4, estado de HOY): el panel reintenta un bloqueo o un desbloqueo EN DUDA con la misma llave. Si el estado ya se movió después
 * (el bloqueo sí llegó y otra pestaña desbloqueó), la llave vieja no vuelve a responder «hecho»: 409 con código y sin escribir.
 */
describe('panel · bloquear y desbloquear repetidos con la misma llave', () => {
  const bloquear = (giftCardId: string, operationKey: string) =>
    operarSobreDeGerente(venueId, giftCardId, staffId, { operationKey, tipo: 'BLOQUEAR', reason: 'SUSPICIOUS_ACTIVITY' })
  const desbloquear = (giftCardId: string, operationKey: string) =>
    operarSobreDeGerente(venueId, giftCardId, staffId, { operationKey, tipo: 'DESBLOQUEAR', reason: 'CUSTOMER_REQUEST' })
  const estado = async (id: string) => (await prisma.giftCard.findUniqueOrThrow({ where: { id } })).status
  const movimientos = (giftCardId: string) => prisma.giftCardActivity.count({ where: { giftCardId } })

  it('🔴 el bloqueo en duda que sí llegó y otra pestaña desbloqueó ⇒ repetirlo responde 409 y la tarjeta sigue activa', async () => {
    const s = await sobreActivo(500)
    const llave = `${SUF}-bloqueo-duda`
    await expect(bloquear(s.id, llave)).resolves.toMatchObject({ replayed: false })
    // Mientras el estado no se mueva, el reintento es la misma respuesta.
    await expect(bloquear(s.id, llave)).resolves.toMatchObject({ replayed: true })
    await desbloquear(s.id, `${SUF}-desbloqueo-otra-pestana`)
    const antes = await movimientos(s.id)

    await expect(bloquear(s.id, llave)).rejects.toMatchObject({
      code: 'GIFT_CARD_STATE_CHANGED',
      statusCode: 409,
      message:
        'Este bloqueo ya se había registrado, pero la tarjeta cambió después: hoy no está bloqueada. Vuelve a abrirla para ver su estado.',
    })
    expect(await estado(s.id)).toBe('ACTIVE')
    expect(await movimientos(s.id)).toBe(antes)
  })

  it('🔴 el desbloqueo en duda que sí llegó y luego se volvió a bloquear ⇒ repetirlo responde 409 y la tarjeta sigue bloqueada', async () => {
    const s = await sobreActivo(500)
    await bloquear(s.id, `${SUF}-bloqueo-1`)
    const llave = `${SUF}-desbloqueo-duda`
    await expect(desbloquear(s.id, llave)).resolves.toMatchObject({ replayed: false })
    await expect(desbloquear(s.id, llave)).resolves.toMatchObject({ replayed: true })
    await bloquear(s.id, `${SUF}-bloqueo-2`)
    const antes = await movimientos(s.id)

    await expect(desbloquear(s.id, llave)).rejects.toMatchObject({
      code: 'GIFT_CARD_STATE_CHANGED',
      statusCode: 409,
      message:
        'Este desbloqueo ya se había registrado, pero la tarjeta cambió después: hoy no está activa. Vuelve a abrirla para ver su estado.',
    })
    expect(await estado(s.id)).toBe('BLOCKED')
    expect(await movimientos(s.id)).toBe(antes)
  })
})
