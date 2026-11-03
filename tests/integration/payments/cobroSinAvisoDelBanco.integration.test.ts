/**
 * D11: una cuenta activa de AngelPay sin aviso del banco cobra con tarjeta ⇒ 🚨 y correo a soporte. Por los dos registradores reales,
 * contra Postgres: «sólo un cobro nuevo y comiteado» lo deciden las salidas tempranas y la transacción de verdad, no un mock.
 * Nunca altera el cobro: lo mismo si el correo se cuelga que si la revisión truena.
 */
import { randomUUID } from 'crypto'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { sendOpsAlert } from '@/services/alerts/opsAlert.service'
import { __reiniciarCorreosParaPruebas } from '@/services/tpv/avisoAngelpaySinWebhook'
import { recordFastPayment, recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { crearFixture, exigirBaseDesechable, type Fixture } from './webhookCheckpoint.fixture'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(() => null), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))

const mockedAlerta = sendOpsAlert as jest.Mock
const SECRETO = 'whsec_fixture_de_prueba'
let f: Fixture

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('d11c')
})
beforeEach(async () => {
  jest.clearAllMocks()
  __reiniciarCorreosParaPruebas()
  mockedAlerta.mockResolvedValue(true)
  await prisma.merchantAccount.update({ where: { id: f.merchantId }, data: { active: true, angelpayWebhookSecret: null } })
})
afterEach(async () => {
  jest.restoreAllMocks()
  await f.limpiar()
})
afterAll(() => f.destruir())

const pausa = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const gritos = () => (logger.error as jest.Mock).mock.calls.filter(c => String(c[0]).includes('cobra sin aviso del banco'))
/** La revisión corre después de responder: se espera a que aparezca; para «no hay» o «no se repite», se le da tiempo de sobra. */
const esperarGrito = async (cuantos = 1) => {
  expect(await f.esperar(async () => gritos().length >= cuantos)).toBe(true)
}
const darleTiempo = () => pausa(400)

const conOrden = async (attemptId = randomUUID()) => {
  const venta = await f.nuevaVenta(100)
  return recordOrderPayment(f.venueId, venta.id, f.registroDeLaTerminal({ attemptId }), f.staffId)
}
const rapido = (attemptId = randomUUID()) => recordFastPayment(f.venueId, f.registroDeLaTerminal({ attemptId }), f.staffId)

describe('avisa', () => {
  it.each([
    ['con orden', conOrden],
    ['rápido', rapido],
  ] as const)('cobro %s con una cuenta sin secreto: 🚨 con sus datos, un correo, y el cobro queda igual', async (_caso, cobrar) => {
    const cobro = await cobrar()

    expect(cobro).toMatchObject({ status: 'COMPLETED', method: 'CREDIT_CARD', merchantAccountId: f.merchantId })
    await esperarGrito()
    expect(gritos()[0][1]).toMatchObject({ venueId: f.venueId, merchantAccountId: f.merchantId, paymentId: cobro.id })
    expect(mockedAlerta).toHaveBeenCalledTimes(1)
    expect(mockedAlerta.mock.calls[0][0].lines.join(' ')).toContain('SUPERADMIN')
  })

  it('dos cobros de la misma cuenta: dos 🚨, un correo', async () => {
    await rapido()
    await rapido()

    await esperarGrito(2)
    await darleTiempo()
    expect(gritos()).toHaveLength(2)
    expect(mockedAlerta).toHaveBeenCalledTimes(1)
  })
})

describe('no avisa', () => {
  it('una cuenta con secreto, aunque le falte el endpoint: ya tiene canal', async () => {
    await prisma.merchantAccount.update({
      where: { id: f.merchantId },
      data: { angelpayWebhookSecret: SECRETO, angelpayWebhookEndpointId: null },
    })

    await rapido()
    await conOrden()

    await darleTiempo()
    expect(gritos()).toEqual([])
    expect(mockedAlerta).not.toHaveBeenCalled()
  })

  it('el reintento del MISMO cobro no vuelve a avisar: ya no es un cobro nuevo', async () => {
    const attemptId = randomUUID()
    const primero = await rapido(attemptId)
    await esperarGrito()

    const repetido = await rapido(attemptId)

    expect(repetido.id).toBe(primero.id)
    await darleTiempo()
    expect(gritos()).toHaveLength(1)
  })

  it('un cobro en efectivo con la misma cuenta', async () => {
    await recordFastPayment(
      f.venueId,
      { ...f.registroDeLaTerminal({ attemptId: randomUUID() }), method: 'CASH', authorizationNumber: undefined },
      f.staffId,
    )

    await darleTiempo()
    expect(gritos()).toEqual([])
  })

  it('un cobro de una cuenta de otro proveedor', async () => {
    const otro = await prisma.paymentProvider.create({
      data: { code: `D11_${randomUUID()}`, name: 'Otro', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
    const original = await prisma.merchantAccount.findUniqueOrThrow({ where: { id: f.merchantId }, select: { providerId: true } })
    await prisma.merchantAccount.update({ where: { id: f.merchantId }, data: { providerId: otro.id } })
    try {
      await rapido()
      await darleTiempo()
      expect(gritos()).toEqual([])
    } finally {
      await prisma.merchantAccount.update({ where: { id: f.merchantId }, data: { providerId: original.providerId } })
      await prisma.paymentProvider.delete({ where: { id: otro.id } })
    }
  })

  it('si la transacción del cobro no se confirma', async () => {
    jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('la base se cayó'))

    await expect(rapido()).rejects.toThrow('la base se cayó')

    await darleTiempo()
    expect(gritos()).toEqual([])
  })
})

describe('nunca le estorba al cobro', () => {
  it('un correo que nunca contesta no demora la respuesta', async () => {
    mockedAlerta.mockReturnValue(new Promise(() => undefined))

    const cobro = await rapido()

    expect(cobro.status).toBe('COMPLETED')
    await esperarGrito()
  })

  it('una revisión que truena no llega al cobro: queda una línea, y el cobro completo', async () => {
    const original = prisma.merchantAccount.findFirst.bind(prisma.merchantAccount)
    jest
      .spyOn(prisma.merchantAccount, 'findFirst')
      .mockImplementation(((args: { where?: { angelpayWebhookSecret?: unknown } }) =>
        args?.where?.angelpayWebhookSecret === null
          ? Promise.reject(new Error('sin base para la revisión'))
          : original(args as never)) as never)

    const cobro = await rapido()

    expect(cobro.status).toBe('COMPLETED')
    expect(await prisma.payment.count({ where: { id: cobro.id } })).toBe(1)
    expect(
      await f.esperar(async () =>
        (logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('No se pudo revisar si la cuenta del cobro')),
      ),
    ).toBe(true)
    expect(gritos()).toEqual([])
  })
})
