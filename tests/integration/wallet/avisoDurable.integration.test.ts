/** S5: cambios y obligación en PostgreSQL real; sólo proveedores externos son dobles. */
import '../../__helpers__/integration-setup'
import cuid from 'cuid'
import { setTimeout as relojDePared, clearTimeout as limpiarRelojDePared } from 'timers'
import prisma from '@/utils/prismaClient'
import * as avisos from '@/services/wallet/notifyPassUpdated.service'
import { grantStamp, reverseStampForOrder, adjustStamps, getStampCardStatus } from '@/services/wallet/stampLedger.service'
import { encolarAvisoDeTarjetaEnTx } from '@/services/wallet/walletPassOutbox.service'
import logger from '@/config/logger'
import { walletClient } from '@/services/wallet/googleWalletClient'
import { sendSilentPush } from '@/services/wallet/apnsClient'
import { canjearPremioEnTx, refundStampRewardForOrderDiscount } from '@/services/wallet/redeemStampReward.service'
import { withDeadlockRetry } from '@/utils/serializableRetry'
import { removeOrderDiscount } from '@/services/mobile/order.mobile.service'
import { crearNegocioDePrueba, limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/wallet/apnsClient', () => ({ apnsAvailable: () => true, sendSilentPush: jest.fn(async () => ({ ok: true })) }))
jest.mock('@/services/wallet/googleWalletClient', () => ({
  googleWalletAvailable: () => true,
  issuerId: () => '338',
  walletBaseUrl: () => 'https://wallet.example.test',
  walletClient: jest.fn(),
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToVenue: jest.fn(), getBroadcastingService: () => null },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const s = { broadcastToVenue: jest.fn(), getBroadcastingService: () => null }
  return { __esModule: true, default: s, socketManager: s }
})
let venueId: string
let staffId: string
beforeAll(async () => {
  ;({ venueId, staffId } = await crearNegocioDePrueba('wallet-s5'))
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, stampsEnabled: true, stampsRequired: 7, maxStampsPerDay: 0, stampRewardLabel: 'Premio' },
  })
})
afterAll(async () => {
  jest.restoreAllMocks()
  if (!venueId) return
  await prisma.walletPass.deleteMany({ where: { venueId } })
  await prisma.walletPassOutbox.deleteMany({ where: { venueId } })
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampEvent.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.onlineOrder.deleteMany({ where: { venueId } })
  await limpiarNegocioDePrueba(venueId)
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.$disconnect()
})
async function cliente() {
  return prisma.customer.create({ data: { venueId, firstName: 'Ana S5' } })
}
async function venta() {
  return prisma.order.create({
    data: { venueId, orderNumber: cuid(), subtotal: 100, total: 100, taxAmount: 0, status: 'COMPLETED', paymentStatus: 'PAID' },
  })
}
it('grantStamp deja la obligación aunque no haya pase; repetir ALREADY_STAMPED no duplica', async () => {
  const despertar = jest.spyOn(avisos, 'notifyCustomerPassUpdated').mockResolvedValue({ notified: 0 })
  try {
    const c = await cliente()
    const o = await venta()
    expect((await grantStamp(venueId, c.id, o.id)).granted).toBe(true)
    expect(await prisma.walletPassOutbox.findMany({ where: { venueId, customerId: c.id }, take: 5 })).toEqual([
      expect.objectContaining({ motivo: 'SELLO', reclamadoPor: null, intentos: 0 }),
    ])
    expect((await grantStamp(venueId, c.id, o.id)).reason).toBe('ALREADY_STAMPED')
    expect(await prisma.walletPassOutbox.count({ where: { venueId, customerId: c.id } })).toBe(1)
  } finally {
    despertar.mockRestore()
  }
})

async function acotar<T>(trabajo: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof relojDePared> | undefined
  try {
    return await Promise.race([
      trabajo,
      new Promise<T>((_, reject) => {
        timer = relojDePared(() => reject(new Error('No llegó al paso esperado')), 3000)
      }),
    ])
  } finally {
    limpiarRelojDePared(timer)
  }
}
function puerta() {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}
async function pendiente(customerId: string, motivo = 'SELLO') {
  return prisma.walletPassOutbox.create({ data: { venueId, customerId, motivo, createdAt: new Date(), siguienteIntentoAt: new Date() } })
}
async function conPase() {
  const c = await cliente()
  const card = await prisma.stampCard.create({ data: { venueId, customerId: c.id, cycle: 1, stampsRequired: 7, stampsEarned: 6 } })
  const pass = await prisma.walletPass.create({
    data: {
      venueId,
      customerId: c.id,
      serialNumber: cuid(),
      authToken: cuid(),
      qrToken: cuid(),
      platform: 'GOOGLE',
      googleObjectId: '338.' + cuid(),
    },
  })
  await pendiente(c.id)
  return { c, card, pass }
}
function proveedor(hook?: (valor: string) => Promise<void>) {
  const remoto = { valor: '', historia: [] as string[], opciones: [] as unknown[] }
  ;(walletClient as jest.Mock).mockImplementation(async () => ({
    loyaltyobject: {
      patch: async (args: any, opciones: any) => {
        remoto.opciones.push(opciones)
        const valor = args.requestBody.loyaltyPoints.balance.string
        if (hook) await hook(valor)
        remoto.valor = valor
        remoto.historia.push(valor)
        return { data: {} }
      },
    },
  }))
  return remoto
}
async function septimo(s: Awaited<ReturnType<typeof conPase>>) {
  await prisma.stampCard.update({ where: { id: s.card.id }, data: { stampsEarned: 7 } })
  return pendiente(s.c.id)
}
async function vencerTodo(customerId: string) {
  await prisma.$executeRaw`UPDATE "WalletPassOutbox" SET "reclamadoHasta" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second', "siguienteIntentoAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '61 seconds' WHERE "venueId" = ${venueId} AND "customerId" = ${customerId}`
}
const filas = (customerId: string) =>
  prisma.walletPassOutbox.findMany({ where: { venueId, customerId }, orderBy: { id: 'asc' }, take: 1000 })

it('sin pase activo elimina sus filas sin tocar ningún proveedor', async () => {
  const c = await cliente()
  await pendiente(c.id)
  const remoto = proveedor()
  expect(await avisos.notifyCustomerPassUpdated(venueId, c.id)).toEqual({ notified: 0 })
  expect(await filas(c.id)).toEqual([])
  expect(remoto.historia).toEqual([])
})
it('Google caído conserva filas, incrementa intentos y espera un minuto; no confunde cero con éxito', async () => {
  const s = await conPase()
  ;(walletClient as jest.Mock).mockRejectedValue(new Error('proveedor caído'))
  expect(await avisos.notifyCustomerPassUpdated(venueId, s.c.id)).toMatchObject({ failed: true })
  const rs = await filas(s.c.id)
  expect(rs).toHaveLength(2)
  expect(rs.find(r => r.motivo === 'SELLO')).toMatchObject({ reclamadoPor: null, reclamadoHasta: null, intentos: 1 })
  expect(rs.find(r => r.motivo === 'REPARACION')!.intentos).toBe(1)
  expect(rs.find(r => r.motivo === 'SELLO')!.siguienteIntentoAt.getTime() - Date.now()).toBeGreaterThan(55000)
})
it('sin INSERT del rastro no se habla al proveedor y se conserva la obligación', async () => {
  const s = await conPase()
  const remoto = proveedor()
  const original = prisma.$executeRaw.bind(prisma)
  const fallo = jest.spyOn(prisma, '$executeRaw').mockImplementation(((sql: any, ...args: any[]) => {
    if (String(sql).includes('INSERT INTO "WalletPassOutbox"')) return Promise.reject(new Error('rastro no escrito'))
    return (original as any)(sql, ...args)
  }) as any)
  try {
    expect(await avisos.notifyCustomerPassUpdated(venueId, s.c.id)).toMatchObject({ failed: true })
    expect(remoto.historia).toEqual([])
    expect((await filas(s.c.id))[0]).toMatchObject({ intentos: 1, reclamadoPor: null })
  } finally {
    fallo.mockRestore()
  }
})
it('A publica seis; B ve ocupado; una fila nueva durante el envío termina publicando siete', async () => {
  const s = await conPase()
  const entro = puerta()
  const sigue = puerta()
  let primero = true
  const remoto = proveedor(async () => {
    if (primero) {
      primero = false
      entro.resolve()
      await sigue.promise
    }
  })
  const a = avisos.notifyCustomerPassUpdated(venueId, s.c.id)
  try {
    await acotar(entro.promise)
    await septimo(s)
    expect(await avisos.notifyCustomerPassUpdated(venueId, s.c.id)).toEqual({ notified: 0, ocupado: true })
    expect(remoto.historia).toEqual([])
  } finally {
    sigue.resolve()
  }
  await a
  expect(remoto.opciones).toEqual([{ timeout: 20000 }, { timeout: 20000 }])
  expect(remoto.historia).toEqual(['6/7', '7/7'])
  expect(await filas(s.c.id)).toEqual([])
})
it('lease vencido: B publica siete antes del seis tardío de A; RELECTURA lo repara y no borra lo nuevo', async () => {
  const s = await conPase()
  const entro = puerta()
  const sigue = puerta()
  let primero = true
  const remoto = proveedor(async () => {
    if (primero) {
      primero = false
      entro.resolve()
      await sigue.promise
    }
  })
  const relecturas: string[] = []
  const real = prisma.walletPassOutbox.create.bind(prisma.walletPassOutbox)
  const leer = jest.spyOn(prisma.walletPassOutbox, 'create').mockImplementation((async (args: any) => {
    const r = await real(args)
    if (args.data.motivo === 'RELECTURA') {
      relecturas.push(remoto.valor)
      expect((await filas(s.c.id)).some(x => x.motivo === 'RELECTURA')).toBe(true)
    }
    return r
  }) as any)
  const a = avisos.notifyCustomerPassUpdated(venueId, s.c.id)
  try {
    await acotar(entro.promise)
    await septimo(s)
    await prisma.$executeRaw`UPDATE "WalletPassOutbox" SET "reclamadoHasta" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "venueId" = ${venueId} AND "customerId" = ${s.c.id}`
    await avisos.notifyCustomerPassUpdated(venueId, s.c.id)
    expect(remoto.valor).toBe('7/7')
  } finally {
    sigue.resolve()
  }
  await a
  leer.mockRestore()
  expect(relecturas).toContain('6/7')
  expect(remoto.historia).toEqual(['7/7', '6/7', '7/7'])
  expect(await filas(s.c.id)).toEqual([])
})
it('corte después del PATCH antes del DELETE deja lease y rastro; otro enviador recupera al vencer', async () => {
  const s = await conPase()
  const remoto = proveedor(async () => {
    await septimo(s)
  })
  const original = prisma.$executeRaw.bind(prisma)
  // Representa pérdida del proceso/conexión: no llegan DELETE ni liberación. No se mata ningún proceso real.
  const corte = jest.spyOn(prisma, '$executeRaw').mockImplementation(((sql: any, ...args: any[]) => {
    const texto = String(sql)
    if (texto.includes('DELETE FROM "WalletPassOutbox"') || texto.includes('"intentos" = "intentos" + 1'))
      return Promise.reject(new Error('corte representado'))
    return (original as any)(sql, ...args)
  }) as any)
  try {
    await avisos.notifyCustomerPassUpdated(venueId, s.c.id)
  } finally {
    corte.mockRestore()
  }
  expect(remoto.valor).toBe('6/7')
  expect((await filas(s.c.id)).some(r => r.reclamadoHasta && r.reclamadoHasta.getTime() > Date.now())).toBe(true)
  expect(await avisos.notifyCustomerPassUpdated(venueId, s.c.id)).toMatchObject({ ocupado: true })
  proveedor()
  await vencerTodo(s.c.id)
  expect(await avisos.notifyCustomerPassUpdated(venueId, s.c.id)).toMatchObject({ notified: 1 })
  expect(await filas(s.c.id)).toEqual([])
})

async function premio() {
  const c = await cliente()
  const card = await prisma.stampCard.create({
    data: { venueId, customerId: c.id, cycle: 1, stampsRequired: 7, stampsEarned: 7, completedAt: new Date() },
  })
  const reward = await prisma.stampReward.create({
    data: { venueId, customerId: c.id, stampCardId: card.id, rewardType: 'FIXED_AMOUNT', rewardValue: 10, rewardLabel: 'Premio' },
  })
  const order = await prisma.order.create({
    data: {
      venueId,
      customerId: c.id,
      orderNumber: cuid(),
      subtotal: 100,
      total: 100,
      taxAmount: 0,
      status: 'PENDING',
      paymentStatus: 'PENDING',
      items: { create: { productName: 'Servicio', quantity: 1, unitPrice: 100, total: 100, taxAmount: 0 } },
    },
  })
  return { c, card, reward, order }
}
it('canje, devolución y removeOrderDiscount REAL sobre folio vivo ligado; rollback/SAVEPOINT/simulación no dejan obligación', async () => {
  const s = await premio()
  await prisma.order.update({
    where: { id: s.order.id },
    data: {
      source: 'WEB',
      type: 'PICKUP',
      remainingBalance: 100,
      createdById: staffId,
      orderCustomers: { create: { customerId: s.c.id, isPrimary: true } },
    },
  })
  const acceptDeadlineAt = new Date(Date.now() + 30 * 60000)
  const online = await prisma.onlineOrder.create({
    data: {
      venueId,
      orderId: s.order.id,
      trackingToken: cuid(),
      paymentMode: 'PAY_AT_PICKUP',
      requiresAcceptance: false,
      status: 'PENDING_ACCEPTANCE',
      acceptDeadlineAt,
    },
  })
  const comprobarFolioVivo = async () => {
    const vinculo = await prisma.onlineOrder.findUniqueOrThrow({ where: { orderId: s.order.id } })
    expect(vinculo).toMatchObject({
      id: online.id,
      venueId,
      orderId: s.order.id,
      paymentMode: 'PAY_AT_PICKUP',
      status: 'PENDING_ACCEPTANCE',
      requiresAcceptance: false,
      acceptDeadlineAt,
    })
    expect(vinculo.acceptDeadlineAt.getTime()).toBeGreaterThan(Date.now())
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })
    expect(cuenta).toMatchObject({ source: 'WEB', type: 'PICKUP', customerId: s.c.id, status: 'PENDING', paymentStatus: 'PENDING' })
    expect(Number(cuenta.paidAmount)).toBe(0)
    expect(await prisma.payment.count({ where: { orderId: s.order.id } })).toBe(0)
    expect(await prisma.onlineOrderCharge.count({ where: { onlineOrderId: online.id } })).toBe(0)
  }
  await comprobarFolioVivo()
  await expect(
    withDeadlockRetry(
      async tx => {
        await canjearPremioEnTx(tx, venueId, s.order.id, s.reward.id)
        expect(await tx.walletPassOutbox.count({ where: { venueId, customerId: s.c.id } })).toBe(1)
        throw new Error('simulación descartada')
      },
      { etiqueta: 'S5-simulacion' },
    ),
  ).rejects.toThrow('simulación descartada')
  expect(await filas(s.c.id)).toEqual([])
  expect((await prisma.stampReward.findUniqueOrThrow({ where: { id: s.reward.id } })).status).toBe('PENDING')
  await withDeadlockRetry(
    async tx => {
      await tx.$executeRawUnsafe('SAVEPOINT cotizador_s5')
      await canjearPremioEnTx(tx, venueId, s.order.id, s.reward.id)
      expect(await tx.walletPassOutbox.count({ where: { venueId, customerId: s.c.id } })).toBe(1)
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT cotizador_s5')
      expect(await tx.walletPassOutbox.count({ where: { venueId, customerId: s.c.id } })).toBe(0)
    },
    { etiqueta: 'S5-savepoint' },
  )
  await withDeadlockRetry(tx => canjearPremioEnTx(tx, venueId, s.order.id, s.reward.id), { etiqueta: 'S5-canje' })
  expect((await filas(s.c.id)).map(x => x.motivo)).toEqual(['PREMIO_CANJEADO'])
  await prisma.walletPassOutbox.deleteMany({ where: { venueId, customerId: s.c.id } })
  const discountId = (await prisma.stampReward.findUniqueOrThrow({ where: { id: s.reward.id } })).orderDiscountId!
  const despertar = jest.spyOn(avisos, 'notifyCustomerPassUpdated').mockResolvedValue({ notified: 0 })
  try {
    await removeOrderDiscount(venueId, s.order.id, discountId, staffId)
  } finally {
    despertar.mockRestore()
  }
  expect((await filas(s.c.id)).map(x => x.motivo)).toEqual(['PREMIO_DEVUELTO'])
  expect((await prisma.stampReward.findUniqueOrThrow({ where: { id: s.reward.id } })).status).toBe('PENDING')
  await comprobarFolioVivo()
  const apple = await prisma.walletPass.create({
    data: { venueId, customerId: s.c.id, serialNumber: cuid(), authToken: cuid(), qrToken: cuid(), platform: 'APPLE' },
  })
  await prisma.walletPassRegistration.create({
    data: { walletPassId: apple.id, deviceLibraryIdentifier: cuid(), pushToken: 'remove-real' },
  })
  await prisma.walletPass.create({
    data: {
      venueId,
      customerId: s.c.id,
      serialNumber: cuid(),
      authToken: cuid(),
      qrToken: cuid(),
      platform: 'GOOGLE',
      googleObjectId: '338.' + cuid(),
    },
  })
  let appleContent: Awaited<ReturnType<typeof getStampCardStatus>> | undefined
  ;(sendSilentPush as jest.Mock).mockImplementation(async () => {
    appleContent = await getStampCardStatus(venueId, s.c.id)
    return { ok: true }
  })
  const remoto = proveedor()
  await vencerTodo(s.c.id)
  const barrido = await barridoPropio()
  expect(barrido.paginas[0].propios).toContain(s.c.id)
  expect(appleContent).toMatchObject({ pendingRewards: 1, stampsRequired: 7 })
  expect(remoto.valor).toBe('0/7')
  expect(await filas(s.c.id)).toEqual([])
  await comprobarFolioVivo()
  ;(sendSilentPush as jest.Mock).mockResolvedValue({ ok: true })
})
it('reversa y ajuste dejan su obligación, y el segundo no-op no añade otra', async () => {
  const c = await cliente()
  const o = await venta()
  const despertar = jest.spyOn(avisos, 'notifyCustomerPassUpdated').mockResolvedValue({ notified: 0 })
  try {
    await grantStamp(venueId, c.id, o.id)
    await reverseStampForOrder(venueId, o.id)
    await reverseStampForOrder(venueId, o.id)
    const card = await prisma.stampCard.findFirstOrThrow({ where: { venueId, customerId: c.id } })
    const version = await prisma.stampEvent.count({ where: { stampCardId: card.id } })
    await adjustStamps(venueId, c.id, {
      expectedStampCardId: card.id,
      expectedStampsEarned: 0,
      expectedVersion: version,
      expectedStampsRequired: 7,
      stampsEarned: 2,
      reason: 'Migración cartón',
    })
    expect((await filas(c.id)).map(r => r.motivo).sort()).toEqual(['AJUSTE', 'SELLO', 'SELLO_REVERTIDO'])
  } finally {
    despertar.mockRestore()
  }
})

it.each([false, true])(
  'race vencido no cancela PATCH: llegada tardía después del reenvío de un minuto=%s; rastro futuro repara',
  async despuesDelMinuto => {
    const s = await conPase()
    const entro = puerta()
    const sigue = puerta()
    let primero = true
    const remoto = proveedor(async () => {
      if (primero) {
        primero = false
        entro.resolve()
        await sigue.promise
      }
    })
    jest.useFakeTimers({ doNotFake: ['Date', 'nextTick', 'setImmediate'] })
    const a = avisos.notifyCustomerPassUpdated(venueId, s.c.id)
    try {
      await acotar(entro.promise)
      await jest.advanceTimersByTimeAsync(25001)
      expect(await acotar(a)).toMatchObject({ failed: true })
    } catch (error) {
      sigue.resolve()
      await a
      throw error
    } finally {
      jest.useRealTimers()
    }
    try {
      const antes = await filas(s.c.id)
      const r1 = antes.find(r => r.motivo === 'SELLO')!
      const rastro = antes.find(r => r.motivo === 'REPARACION')!
      expect(rastro).toBeDefined()
      expect(rastro.siguienteIntentoAt.getTime() - Date.now()).toBeGreaterThan(110000)
      await septimo(s)
      await avisos.notifyCustomerPassUpdated(venueId, s.c.id)
      expect(remoto.valor).toBe('7/7')
      expect((await filas(s.c.id)).map(r => r.id).sort()).toEqual([r1.id, rastro.id].sort())
      if (despuesDelMinuto) {
        await prisma.walletPassOutbox.update({ where: { id: r1.id }, data: { siguienteIntentoAt: new Date(Date.now() - 1000) } })
        await avisos.notifyCustomerPassUpdated(venueId, s.c.id)
        expect((await filas(s.c.id)).map(r => r.id)).toEqual([rastro.id])
      }
      sigue.resolve()
      await new Promise(resolve => setImmediate(resolve))
      expect(remoto.valor).toBe('6/7')
      expect((await filas(s.c.id)).some(r => r.id === rastro.id)).toBe(true)
      await vencerTodo(s.c.id)
      await avisos.notifyCustomerPassUpdated(venueId, s.c.id)
      expect(remoto.valor).toBe('7/7')
      expect(await filas(s.c.id)).toEqual([])
    } finally {
      sigue.resolve()
      await a
    }
  },
)
it('no comienza otro pase después del presupuesto de sesenta segundos', async () => {
  const s = await conPase()
  await prisma.walletPass.create({
    data: {
      venueId,
      customerId: s.c.id,
      serialNumber: cuid(),
      authToken: cuid(),
      qrToken: cuid(),
      platform: 'GOOGLE',
      googleObjectId: '338.' + cuid(),
    },
  })
  await prisma.walletPass.create({
    data: {
      venueId,
      customerId: s.c.id,
      serialNumber: cuid(),
      authToken: cuid(),
      qrToken: cuid(),
      platform: 'GOOGLE',
      googleObjectId: '338.' + cuid(),
    },
  })
  let now = Date.now()
  const reloj = jest.spyOn(Date, 'now').mockImplementation(() => now)
  const remoto = proveedor(async () => {
    now += 31000
  })
  try {
    expect(await avisos.notifyCustomerPassUpdated(venueId, s.c.id)).toMatchObject({ failed: true })
    expect(remoto.historia).toHaveLength(2)
    expect((await filas(s.c.id)).some(r => r.intentos === 1 && r.reclamadoPor === null)).toBe(true)
  } finally {
    reloj.mockRestore()
  }
})

it('rollback posterior al sello revierte también su obligación (segunda escritura real)', async () => {
  const c = await cliente()
  const o = await venta()
  const abrir = prisma.$transaction.bind(prisma)
  const cortar = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: any, opciones: any) =>
    abrir(async tx => {
      await fn(tx)
      expect(await tx.walletPassOutbox.count({ where: { venueId, customerId: c.id } })).toBe(1)
      throw new Error('segunda escritura falló')
    }, opciones)) as any)
  try {
    await expect(grantStamp(venueId, c.id, o.id)).rejects.toThrow('segunda escritura falló')
  } finally {
    cortar.mockRestore()
  }
  expect(await filas(c.id)).toEqual([])
  expect(await prisma.stampEvent.count({ where: { venueId, orderId: o.id } })).toBe(0)
})
it('devolución directa del premio inserta una vez; repetir su no-op no inventa aviso', async () => {
  const s = await premio()
  await withDeadlockRetry(
    async tx => {
      await canjearPremioEnTx(tx, venueId, s.order.id, s.reward.id)
      const reward = await tx.stampReward.findUniqueOrThrow({ where: { id: s.reward.id } })
      expect(await refundStampRewardForOrderDiscount(tx, venueId, { id: reward.orderDiscountId! })).not.toBeNull()
      expect(await refundStampRewardForOrderDiscount(tx, venueId, { id: reward.orderDiscountId! })).toBeNull()
    },
    { etiqueta: 'S5-devolver-premio' },
  )
  expect((await filas(s.c.id)).map(r => r.motivo).sort()).toEqual(['PREMIO_CANJEADO', 'PREMIO_DEVUELTO'])
})
it('reclama como máximo doscientas filas; el resto sigue y se procesa en la vuelta siguiente sin RELECTURA falsa', async () => {
  const s = await conPase()
  await prisma.walletPassOutbox.createMany({
    data: Array.from({ length: 200 }, () => ({
      venueId,
      customerId: s.c.id,
      motivo: 'SELLO',
      createdAt: new Date(),
      siguienteIntentoAt: new Date(),
    })),
  })
  const claims: number[] = []
  const remoto = proveedor(async () => {
    claims.push(await prisma.walletPassOutbox.count({ where: { venueId, customerId: s.c.id, reclamadoPor: { not: null } } }))
  })
  const create = jest.spyOn(prisma.walletPassOutbox, 'create')
  try {
    expect(await avisos.notifyCustomerPassUpdated(venueId, s.c.id)).toEqual({ notified: 2 })
    expect(claims).toEqual([200, 1])
    expect(remoto.historia).toEqual(['6/7', '6/7'])
    expect(create.mock.calls.some(c => c[0].data.motivo === 'RELECTURA')).toBe(false)
    expect(await filas(s.c.id)).toEqual([])
  } finally {
    create.mockRestore()
  }
})
it('no roba una fila con hora futura y se limita a tres vueltas cuando siguen entrando cambios', async () => {
  const s = await conPase()
  const futuro = await prisma.walletPassOutbox.create({
    data: { venueId, customerId: s.c.id, motivo: 'REPARACION', siguienteIntentoAt: new Date(Date.now() + 120000) },
  })
  const remoto = proveedor(async () => {
    await pendiente(s.c.id)
  })
  expect(await avisos.notifyCustomerPassUpdated(venueId, s.c.id)).toEqual({ notified: 3 })
  expect(remoto.historia).toHaveLength(3)
  const rs = await filas(s.c.id)
  expect(rs).toHaveLength(2)
  expect(rs.some(r => r.id === futuro.id && r.reclamadoPor === null)).toBe(true)
})
it('dos aparatos: uno falla, conserva; 410 elimina registro y omisión legítima permite vaciar', async () => {
  const s = await conPase()
  await prisma.walletPass.update({ where: { id: s.pass.id }, data: { platform: 'APPLE', googleObjectId: null } })
  await prisma.walletPassRegistration.createMany({
    data: [
      { walletPassId: s.pass.id, deviceLibraryIdentifier: cuid(), pushToken: 'ok' },
      { walletPassId: s.pass.id, deviceLibraryIdentifier: cuid(), pushToken: 'gone' },
    ],
  })
  ;(sendSilentPush as jest.Mock).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false })
  expect(await avisos.notifyCustomerPassUpdated(venueId, s.c.id)).toMatchObject({ failed: true })
  expect((await filas(s.c.id)).some(r => r.intentos === 1)).toBe(true)
  await vencerTodo(s.c.id)
  ;(sendSilentPush as jest.Mock).mockResolvedValueOnce({ ok: false, gone: true }).mockResolvedValueOnce({ ok: false, omitido: true })
  expect(await avisos.notifyCustomerPassUpdated(venueId, s.c.id)).toEqual({ notified: 0 })
  expect(await filas(s.c.id)).toEqual([])
  expect(await prisma.walletPassRegistration.count({ where: { walletPassId: s.pass.id } })).toBe(1)
  ;(sendSilentPush as jest.Mock).mockResolvedValue({ ok: true })
})
it('barrido: diez intentos crecientes ya no reintentan; un cambio nuevo recoge las viejas que ya están en su hora', async () => {
  const s = await conPase()
  ;(walletClient as jest.Mock).mockRejectedValue(new Error('caído'))
  for (let i = 1; i <= 10; i++) {
    await vencerTodo(s.c.id)
    const intento = await barridoPropio()
    expect(intento.resultado.fallidos).toBe(1)
    expect(intento.paginas).toHaveLength(1)
    const rs = await filas(s.c.id)
    expect(rs).toHaveLength(i + 1)
    expect(rs.every(r => r.intentos === i && r.reclamadoPor === null)).toBe(true)
  }
  await vencerTodo(s.c.id)
  expect((await barridoPropio()).resultado).toEqual({ avisados: 0, fallidos: 0, ocupados: 0 })
  expect(logger.warn).toHaveBeenCalledWith(
    'Avisos de Wallet sin confirmar tras diez intentos',
    expect.objectContaining({ cantidad: expect.any(Number) }),
  )
  const remoto = proveedor()
  await pendiente(s.c.id)
  await avisos.notifyCustomerPassUpdated(venueId, s.c.id)
  expect(remoto.valor).toBe('6/7')
  expect(await filas(s.c.id)).toEqual([])
})
it('barrido: una sola página de cincuenta clientas con desempate estable, respeta minuto y lease vivo', async () => {
  const ids = Array.from({ length: 51 }, () => cuid()).sort()
  const datos = ids.map(id => ({
    id,
    venueId,
    customerId: cuid(),
    motivo: 'SELLO',
    createdAt: new Date(0),
    siguienteIntentoAt: new Date(0),
  }))
  await prisma.walletPassOutbox.createMany({ data: [...datos].reverse() })
  const reciente = await pendiente(cuid())
  const ocupada = await prisma.walletPassOutbox.create({
    data: {
      venueId,
      customerId: cuid(),
      motivo: 'SELLO',
      siguienteIntentoAt: new Date(0),
      reclamadoPor: cuid(),
      reclamadoHasta: new Date(Date.now() + 120000),
    },
  })
  const ajena = await prisma.walletPassOutbox.create({
    data: { venueId: cuid(), customerId: cuid(), motivo: 'CONTROL_AJENO', siguienteIntentoAt: new Date(Date.now() - 61000) },
  })
  const r = await barridoPropio(500)
  expect(r.resultado).toEqual({ avisados: 50, fallidos: 0, ocupados: 0 })
  expect(r.paginas).toEqual([{ cantidad: 50, propios: datos.slice(0, 50).map(d => d.customerId) }])
  expect(await prisma.walletPassOutbox.findUnique({ where: { id: ajena.id } })).toMatchObject({
    motivo: 'CONTROL_AJENO',
    intentos: 0,
    reclamadoPor: null,
  })
  await prisma.walletPassOutbox.delete({ where: { id: ajena.id } })
  expect(await prisma.walletPassOutbox.findMany({ where: { id: { in: ids } }, select: { id: true }, take: 60 })).toEqual([{ id: ids[50] }])
  expect(await prisma.walletPassOutbox.count({ where: { id: { in: [reciente.id, ocupada.id] } } })).toBe(2)
  await prisma.walletPassOutbox.deleteMany({ where: { venueId, id: { in: [...ids, reciente.id, ocupada.id] } } })
})
it('limpieza conserva otro venue y con venue vacío no borra nada', async () => {
  const ajeno = cuid()
  const c = cuid()
  const propia = await pendiente(c)
  const otra = await prisma.walletPassOutbox.create({ data: { venueId: ajeno, customerId: c, motivo: 'SELLO' } })
  await limpiarNegocioDePrueba('')
  expect(await prisma.walletPassOutbox.count({ where: { id: { in: [propia.id, otra.id] } } })).toBe(2)
  // Usa un venue de recogida sin órdenes, para no limpiar las ventas de otros ensayos de este archivo.
  await limpiarNegocioDePrueba(ajeno)
  expect(await prisma.walletPassOutbox.findUnique({ where: { id: otra.id } })).toBeNull()
  expect(await prisma.walletPassOutbox.findUnique({ where: { id: propia.id } })).not.toBeNull()
  await prisma.walletPassOutbox.delete({ where: { id: propia.id } })
})

it.each(['UTC', 'America/Mexico_City'])(
  'reloj UTC fresco con sesión %s: helper/default, claim, lease, rastro, relectura y espera',
  async zona => {
    const s = await conPase()
    await prisma.walletPassOutbox.deleteMany({ where: { venueId, customerId: s.c.id } })
    const abrir = prisma.$transaction.bind(prisma)
    const medidas: Record<string, unknown> = { zona }
    await abrir(
      async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zona}'`)
        const [sesion] = await tx.$queryRaw<{ zona: string }[]>`SELECT current_setting('TimeZone') AS zona`
        expect(sesion.zona).toBe(zona)
        await encolarAvisoDeTarjetaEnTx(tx, { venueId, customerId: s.c.id, motivo: 'SELLO' })
        const fila = await tx.walletPassOutbox.findFirstOrThrow({ where: { venueId, customerId: s.c.id } })
        const [hora] = await tx.$queryRaw<{ buena: boolean; mezclada: boolean; desfase: number }[]>`
      SELECT "siguienteIntentoAt" <= (clock_timestamp() AT TIME ZONE 'UTC') AS buena,
        "siguienteIntentoAt" <= clock_timestamp() AS mezclada,
        EXTRACT(EPOCH FROM ("createdAt" - (clock_timestamp() AT TIME ZONE 'UTC'))) AS desfase
      FROM "WalletPassOutbox" WHERE id = ${fila.id}`
        expect(hora.buena).toBe(true)
        expect(hora.mezclada).toBe(zona === 'UTC')
        expect(Math.abs(Number(hora.desfase))).toBeLessThan(3)
        medidas.helperSegundos = Number(hora.desfase)
        medidas.comparacionMezclada = hora.mezclada
        const def = await tx.walletPassOutbox.create({ data: { venueId, customerId: cuid(), motivo: 'CONTROL_DEFAULT' } })
        const [defaultHora] = await tx.$queryRaw<
          { desfase: number }[]
        >`SELECT EXTRACT(EPOCH FROM ("createdAt" - (clock_timestamp() AT TIME ZONE 'UTC'))) AS desfase FROM "WalletPassOutbox" WHERE id = ${def.id}`
        medidas.defaultSegundos = Number(defaultHora.desfase)
        expect(Math.abs(Number(defaultHora.desfase))).toBeLessThan(3)
        const defaultSqlId = cuid()
        await tx.$executeRaw`INSERT INTO "WalletPassOutbox" (id, "venueId", "customerId", motivo) VALUES (${defaultSqlId}, ${venueId}, ${cuid()}, 'CONTROL_SQL_DEFAULT')`
        const [sqlHora] = await tx.$queryRaw<
          { desfase: number }[]
        >`SELECT EXTRACT(EPOCH FROM ("createdAt" - (clock_timestamp() AT TIME ZONE 'UTC'))) AS desfase FROM "WalletPassOutbox" WHERE id = ${defaultSqlId}`
        medidas.defaultSqlSegundos = Number(sqlHora.desfase)
        expect(Math.abs(Number(sqlHora.desfase) - (zona === 'UTC' ? 0 : -21600))).toBeLessThan(3)
        // Pinning de TEST: todas las operaciones SQL reales del enviador usan ESTA misma conexión y sesión.
        // El tx exterior sólo es del ensayo; no se infiere nada sobre concurrencia de este control de reloj.
        const transaccion = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: any) => fn(tx)) as any)
        const query = jest.spyOn(prisma, '$queryRaw').mockImplementation(tx.$queryRaw.bind(tx) as any)
        const execute = jest.spyOn(prisma, '$executeRaw').mockImplementation(tx.$executeRaw.bind(tx) as any)
        const creates: number[] = []
        const crear = jest.spyOn(prisma.walletPassOutbox, 'create').mockImplementation((async (a: any) => {
          const r = await tx.walletPassOutbox.create(a)
          if (a.data.motivo === 'RELECTURA') {
            const [h] = await tx.$queryRaw<
              { espera: number }[]
            >`SELECT EXTRACT(EPOCH FROM ("siguienteIntentoAt" - (clock_timestamp() AT TIME ZONE 'UTC'))) AS espera FROM "WalletPassOutbox" WHERE id = ${r.id}`
            creates.push(Number(h.espera))
          }
          return r
        }) as any)
        try {
          await tx.walletPassOutbox.update({
            where: { id: fila.id },
            data: { reclamadoPor: cuid(), reclamadoHasta: new Date(Date.now() + 120000) },
          })
          expect(await avisos.notifyCustomerPassUpdated(venueId, s.c.id)).toEqual({ notified: 0, ocupado: true })
          await tx.$executeRaw`UPDATE "WalletPassOutbox" SET "reclamadoHasta" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE id = ${fila.id}`
          const leases: number[] = []
          const rastros: number[] = []
          let primera = true
          const remoto = proveedor(async () => {
            const [h] = await tx.$queryRaw<{ lease: number; rastro: number }[]>`
          SELECT max(EXTRACT(EPOCH FROM ("reclamadoHasta" - (clock_timestamp() AT TIME ZONE 'UTC')))) AS lease,
            max(CASE WHEN motivo = 'REPARACION' THEN EXTRACT(EPOCH FROM ("siguienteIntentoAt" - (clock_timestamp() AT TIME ZONE 'UTC'))) END) AS rastro
          FROM "WalletPassOutbox" WHERE "venueId" = ${venueId} AND "customerId" = ${s.c.id}`
            leases.push(Number(h.lease))
            rastros.push(Number(h.rastro))
            if (primera) {
              primera = false
              await prisma.stampCard.update({ where: { id: s.card.id }, data: { stampsEarned: 7 } })
            }
          })
          expect(await avisos.notifyCustomerPassUpdated(venueId, s.c.id)).toEqual({ notified: 2 })
          expect(remoto.historia).toEqual(['6/7', '7/7'])
          for (const n of [...leases, ...rastros]) {
            expect(n).toBeGreaterThan(115)
            expect(n).toBeLessThanOrEqual(120)
          }
          expect(creates).toHaveLength(1)
          expect(Math.abs(creates[0])).toBeLessThan(3)
          medidas.leasesSegundos = leases
          medidas.rastrosSegundos = rastros
          medidas.relecturasSegundos = creates
          await encolarAvisoDeTarjetaEnTx(tx, { venueId, customerId: s.c.id, motivo: 'AJUSTE' })
          ;(walletClient as jest.Mock).mockRejectedValue(new Error('red caída'))
          expect(await avisos.notifyCustomerPassUpdated(venueId, s.c.id)).toMatchObject({ failed: true })
          const hs = await tx.$queryRaw<
            { motivo: string; espera: number }[]
          >`SELECT motivo, EXTRACT(EPOCH FROM ("siguienteIntentoAt" - (clock_timestamp() AT TIME ZONE 'UTC'))) AS espera FROM "WalletPassOutbox" WHERE "venueId" = ${venueId} AND "customerId" = ${s.c.id}`
          const espera = Number(hs.find(h => h.motivo === 'AJUSTE')!.espera)
          const rastro = Number(hs.find(h => h.motivo === 'REPARACION')!.espera)
          expect(espera).toBeGreaterThan(55)
          expect(espera).toBeLessThanOrEqual(60)
          expect(rastro).toBeGreaterThan(115)
          expect(rastro).toBeLessThanOrEqual(120)
          medidas.esperaSegundos = espera
          medidas.rastroFallidoSegundos = rastro
        } finally {
          crear.mockRestore()
          execute.mockRestore()
          query.mockRestore()
          transaccion.mockRestore()
        }
      },
      { timeout: 30000 },
    )
    console.info('S5 reloj medido', JSON.stringify(medidas))
  },
)

async function barridoPropio(limite = 50) {
  const real = prisma.$queryRaw.bind(prisma)
  const paginas: { cantidad: number; propios: string[] }[] = []
  const entrada = jest.spyOn(prisma, '$queryRaw').mockImplementation((async (sql: any, ...args: any[]) => {
    const r = await (real as any)(sql, ...args)
    if (String(sql).includes('SELECT o."venueId", o."customerId"')) {
      expect(r.length).toBeLessThanOrEqual(Math.min(50, limite))
      const propios = r.filter((c: any) => c.venueId === venueId)
      paginas.push({ cantidad: r.length, propios: propios.map((c: any) => c.customerId) })
      return propios // R-P2-S5-2: no consumir las obligaciones de otras suites de la misma base.
    }
    return r
  }) as any)
  try {
    return { resultado: await avisos.reintentarAvisosDeTarjeta(limite), paginas }
  } finally {
    entrada.mockRestore()
  }
}
