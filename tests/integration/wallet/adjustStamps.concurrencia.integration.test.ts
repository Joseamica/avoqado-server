/**
 * adjustStamps (sellos a mano) bajo concurrencia REAL contra Postgres, 23-oct-2026.
 *
 * El cruce NO depende de tiempos: la primera transacción se APARCA con el candado (negocio, cliente) tomado y la prueba OBSERVA
 * en `pg_stat_activity` a la segunda esperándola (`advisory`) antes de soltarla.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))

import { adjustStamps, grantStamp, contarVersionDeCartilla } from '@/services/wallet/stampLedger.service'
import { aTiempo, aparcarLaSiguienteTransaccion, esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'

const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
let orgId: string | undefined
let venueId: string | undefined
let n = 0

async function cliente(): Promise<string> {
  return (await prisma.customer.create({ data: { venueId: venueId!, firstName: `Ajuste ${++n}` } })).id
}

async function venta(): Promise<string> {
  const o = await prisma.order.create({
    data: {
      venueId: venueId!,
      orderNumber: `ORD-AJUSTE-${sello}-${++n}`,
      subtotal: 50,
      taxAmount: 0,
      total: 50,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    },
  })
  return o.id
}

/** Cartilla de 3 sellos con el programa encendido y sin tope diario. */
async function preparar(): Promise<{ c: string; cardId: string }> {
  await prisma.loyaltyConfig.upsert({
    where: { venueId: venueId! },
    create: {
      venueId: venueId!,
      active: true,
      stampsEnabled: true,
      stampsRequired: 3,
      maxStampsPerDay: 0,
      stampRewardLabel: 'Un café gratis',
    },
    update: { active: true, stampsEnabled: true, stampsRequired: 3, maxStampsPerDay: 0 },
  })
  const c = await cliente()
  const card = await prisma.stampCard.create({ data: { venueId: venueId!, customerId: c, cycle: 1, stampsRequired: 3, stampsEarned: 0 } })
  return { c, cardId: card.id }
}

/** Lo que vio quien pide el ajuste (el CAS), leído como lo haría el panel. */
async function visto(cardId: string, stampsEarned: number) {
  // La meta de `preparar()` (3): la que vería el panel.
  return {
    expectedStampCardId: cardId,
    expectedStampsEarned: stampsEarned,
    expectedVersion: await contarVersionDeCartilla(cardId),
    expectedStampsRequired: 3,
  }
}

const MOTIVO = 'Migración del cartón de papel'

/** Suma de asientos (EARN +, ADJUST con signo) de cada tarjeta del cliente = su stampsEarned. */
async function cuadra(customerId: string) {
  const cartillas = await prisma.stampCard.findMany({
    where: { venueId, customerId },
    orderBy: { cycle: 'asc' },
    select: { id: true, cycle: true, stampsEarned: true },
    take: 10,
  })
  for (const k of cartillas) {
    const suma = await prisma.stampEvent.aggregate({ where: { stampCardId: k.id }, _sum: { quantity: true } })
    expect({ cycle: k.cycle, suma: suma._sum.quantity ?? 0 }).toEqual({ cycle: k.cycle, suma: k.stampsEarned })
  }
  return cartillas
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ITEST Ajuste ${sello}`, email: `itest-ajuste-${sello}@test.com`, phone: '5550000000' },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { name: `itest-ajuste-${sello}`, slug: `itest-ajuste-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
    })
  ).id
})

afterAll(async () => {
  // 🔴 Sin fixture no se limpia NADA: un filtro con venueId undefined borraría tablas enteras.
  if (!venueId || !orgId) return
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampEvent.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('adjustStamps y grantStamp del MISMO cliente a la vez (Postgres real)', () => {
  it('🔴 el ajuste llega primero (aparcado con el candado): la venta espera y sella ENCIMA; el libro cuadra', async () => {
    const { c, cardId } = await preparar()
    const o = await venta()
    const esperado = await visto(cardId, 0)
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    let ajuste: ReturnType<typeof adjustStamps> | undefined
    let sellar: ReturnType<typeof grantStamp> | undefined
    try {
      ajuste = adjustStamps(venueId!, c, { stampsEarned: 1, ...esperado, reason: MOTIVO })
      const pid = await aTiempo(aparcada.pid, 8_000, 'el ajuste no llegó al commit')
      sellar = grantStamp(venueId!, c, o)
      const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: /pg_advisory_xact_lock/ })
      expect(espera).toMatchObject({ waitEvent: 'advisory' })
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
    }
    const [a, g] = await Promise.all([ajuste!, sellar!])
    expect(a).toMatchObject({ from: 0, to: 1, delta: 1, completed: false })
    expect(g.granted).toBe(true) // el sello de la venta nunca se pierde
    const cartillas = await cuadra(c)
    expect(cartillas.map(x => x.stampsEarned)).toEqual([2])
    expect(await prisma.stampEvent.count({ where: { venueId, orderId: o, type: 'EARN' } })).toBe(1)
  })

  it('🔴 la venta llega primero (aparcada con el candado): el ajuste espera y dice STAMPS_CHANGED; el sello de la venta queda', async () => {
    const { c, cardId } = await preparar()
    const o = await venta()
    const esperado = await visto(cardId, 0) // lo que vio el panel ANTES de la venta
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    let sellar: ReturnType<typeof grantStamp> | undefined
    let ajuste: ReturnType<typeof adjustStamps> | undefined
    try {
      sellar = grantStamp(venueId!, c, o)
      const pid = await aTiempo(aparcada.pid, 8_000, 'la venta no llegó al commit')
      ajuste = adjustStamps(venueId!, c, { stampsEarned: 2, ...esperado, reason: MOTIVO })
      const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: /pg_advisory_xact_lock/ })
      expect(espera).toMatchObject({ waitEvent: 'advisory' })
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
    }
    const resultado = await Promise.allSettled([sellar!, ajuste!])
    expect(resultado[0]).toMatchObject({ status: 'fulfilled', value: { granted: true } })
    expect(resultado[1]).toMatchObject({ status: 'rejected', reason: { code: 'STAMPS_CHANGED' } })
    const cartillas = await cuadra(c)
    expect(cartillas.map(x => x.stampsEarned)).toEqual([1])
    expect(await prisma.stampEvent.count({ where: { venueId, stampCard: { customerId: c }, type: 'ADJUST' } })).toBe(0)
  })
})

describe('dos ajustes idénticos HASTA LA META a la vez (doble clic y reintento, Postgres real)', () => {
  it('🔴 uno aplica y el otro STAMPS_CHANGED; un ADJUST y un premio; repetir la petición después deja los conteos iguales', async () => {
    const { c, cardId } = await preparar()
    const peticion = { stampsEarned: 3, ...(await visto(cardId, 0)), reason: MOTIVO } // la meta
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    let primero: ReturnType<typeof adjustStamps> | undefined
    let segundo: ReturnType<typeof adjustStamps> | undefined
    try {
      primero = adjustStamps(venueId!, c, peticion)
      const pid = await aTiempo(aparcada.pid, 8_000, 'el primer ajuste no llegó al commit')
      segundo = adjustStamps(venueId!, c, { ...peticion })
      const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: /pg_advisory_xact_lock/ })
      expect(espera).toMatchObject({ waitEvent: 'advisory' })
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
    }
    const r = await Promise.allSettled([primero!, segundo!])
    expect(r[0]).toMatchObject({ status: 'fulfilled', value: { from: 0, to: 3, delta: 3, completed: true } })
    expect(r[1]).toMatchObject({ status: 'rejected', reason: { code: 'STAMPS_CHANGED' } })

    const foto = async () => ({
      ajustes: await prisma.stampEvent.count({ where: { venueId, stampCard: { customerId: c }, type: 'ADJUST' } }),
      eventos: await prisma.stampEvent.count({ where: { venueId, stampCard: { customerId: c } } }),
      premios: await prisma.stampReward.count({ where: { venueId, customerId: c } }),
      cartillas: await prisma.stampCard.findMany({
        where: { venueId, customerId: c },
        orderBy: { cycle: 'asc' },
        select: { cycle: true, stampsEarned: true, completedAt: true },
        take: 5,
      }),
    })
    const despues = await foto()
    expect(despues.ajustes).toBe(1)
    expect(despues.premios).toBe(1)
    expect(despues.cartillas.map(x => ({ cycle: x.cycle, stampsEarned: x.stampsEarned, llena: x.completedAt !== null }))).toEqual([
      { cycle: 1, stampsEarned: 3, llena: true },
      { cycle: 2, stampsEarned: 0, llena: false },
    ])
    await cuadra(c)

    // El reintento tardío de la MISMA petición: sigue siendo STAMPS_CHANGED y no mueve nada.
    await expect(adjustStamps(venueId!, c, { ...peticion })).rejects.toMatchObject({ code: 'STAMPS_CHANGED' })
    expect(await foto()).toEqual(despues)
  })
})

describe('la configuración cambia entre la foto del gerente y su ajuste (pasada de la familia, Postgres real)', () => {
  it('🔴 F1: sin cartilla, otro admin baja la meta de 3 a 2: STAMPS_CHANGED con la meta nueva; no abre cartilla ni da premio', async () => {
    await preparar() // config con meta 3
    const c = await cliente() // sin cartilla: el panel ve 0 de 3
    const peticion = {
      stampsEarned: 2,
      expectedStampCardId: null,
      expectedStampsEarned: 0,
      expectedVersion: 0,
      expectedStampsRequired: 3,
      reason: MOTIVO,
    }
    await prisma.loyaltyConfig.update({ where: { venueId: venueId! }, data: { stampsRequired: 2 } })
    await expect(adjustStamps(venueId!, c, peticion)).rejects.toMatchObject({
      code: 'STAMPS_CHANGED',
      details: { stampCardId: null, stampsEarned: 0, stampsRequired: 2, version: 0, rewardLabel: 'Un café gratis' },
    })
    expect(await prisma.stampCard.count({ where: { venueId, customerId: c } })).toBe(0)
    expect(await prisma.stampReward.count({ where: { venueId, customerId: c } })).toBe(0)
  })

  it('🔴 F3: otro admin apaga los sellos MIENTRAS el ajuste espera el candado del cliente: STAMPS_DISABLED y no escribe', async () => {
    const { c, cardId } = await preparar()
    const peticion = { stampsEarned: 1, ...(await visto(cardId, 0)), reason: MOTIVO }
    // Alguien tiene el candado (negocio, cliente) sin tocar la cartilla, para que la única diferencia sea la config.
    let soltar: () => void = () => undefined
    const puedeSoltar = new Promise<void>(r => (soltar = r))
    let avisar: (pid: number) => void = () => undefined
    const pidRetenedor = new Promise<number>(r => (avisar = r))
    const retenedor = prisma.$transaction(
      async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${venueId!}), hashtext(${c}))`
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        avisar(Number(pid))
        await puedeSoltar
      },
      { timeout: 30_000 },
    )
    let ajuste: ReturnType<typeof adjustStamps> | undefined
    try {
      const pid = await aTiempo(pidRetenedor, 8_000, 'el retenedor no tomó el candado')
      ajuste = adjustStamps(venueId!, c, peticion)
      const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: /pg_advisory_xact_lock/ })
      expect(espera).toMatchObject({ waitEvent: 'advisory' })
      await aTiempo(
        prisma.loyaltyConfig.update({ where: { venueId: venueId! }, data: { stampsEnabled: false } }),
        5_000,
        'apagar los sellos se quedó esperando',
      )
    } finally {
      soltar()
    }
    await retenedor
    await expect(ajuste!).rejects.toMatchObject({ code: 'STAMPS_DISABLED' })
    expect(await prisma.stampEvent.count({ where: { venueId, stampCard: { customerId: c } } })).toBe(0)
    expect((await prisma.stampCard.findUniqueOrThrow({ where: { id: cardId } })).stampsEarned).toBe(0)
  })
})
