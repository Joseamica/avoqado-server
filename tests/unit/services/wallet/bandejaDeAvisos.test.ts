/** S5: el resultado del proveedor determina si la obligación se conserva. */
jest.mock('@/services/wallet/apnsClient', () => ({
  sendSilentPush: jest.fn(),
  apnsAvailable: jest.fn(() => true),
}))
jest.mock('@/services/wallet/googleWalletClient', () => ({
  googleWalletAvailable: () => true,
  issuerId: () => '338',
  walletBaseUrl: () => 'https://wallet.example.test',
  walletClient: jest.fn(),
}))
import { walletClient } from '@/services/wallet/googleWalletClient'
import { encolarAvisoDeTarjetaEnTx } from '@/services/wallet/walletPassOutbox.service'
import { notifyPassUpdated, notifyCustomerPassUpdated, reintentarAvisosDeTarjeta } from '@/services/wallet/notifyPassUpdated.service'
import { sendSilentPush } from '@/services/wallet/apnsClient'
import { prismaMock } from '@tests/__helpers__/setup'

describe('bandeja durable: señales de entrega', () => {
  beforeEach(() => {
    prismaMock.walletPassRegistration.findMany.mockResolvedValue([
      { id: 'r1', pushToken: '1' },
      { id: 'r2', pushToken: '2' },
    ] as any)
    prismaMock.walletPass.update.mockResolvedValue({ venueId: 'v' } as any)
    prismaMock.walletPassRegistration.deleteMany.mockResolvedValue({ count: 1 })
  })
  it('un aparato entregado y otro fallido NO confirman la obligación de la clienta', async () => {
    ;(sendSilentPush as jest.Mock).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false })
    expect(await notifyPassUpdated('p')).toEqual({ notified: 1, failed: true })
  })
  it('410 y omisión legítima permiten confirmar, sin inventar una entrega', async () => {
    ;(sendSilentPush as jest.Mock).mockResolvedValueOnce({ ok: false, gone: true }).mockResolvedValueOnce({ ok: false, omitido: true })
    expect(await notifyPassUpdated('p')).toEqual({ notified: 0, failed: false })
    expect(prismaMock.walletPassRegistration.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r1'] } } })
  })
  it('un proveedor que lanza conserva la señal de fallo y nunca tumba el cobro', async () => {
    ;(sendSilentPush as jest.Mock).mockRejectedValue(new Error('red'))
    expect(await notifyPassUpdated('p')).toEqual({ notified: 0, failed: true })
  })
})

it('helper real sólo inserta aunque el cliente de tx no tenga WalletPass ni Customer', async () => {
  const create = jest.fn().mockResolvedValue(undefined)
  const tx = { walletPassOutbox: { create } }
  const inicio = Date.now()
  await encolarAvisoDeTarjetaEnTx(tx as any, { venueId: 'v', customerId: 'c', motivo: 'SELLO' })
  expect(create).toHaveBeenCalledTimes(1)
  expect(create).toHaveBeenCalledWith({
    data: { venueId: 'v', customerId: 'c', motivo: 'SELLO', createdAt: expect.any(Date), siguienteIntentoAt: expect.any(Date) },
  })
  const data = create.mock.calls[0][0].data
  expect(data.siguienteIntentoAt.getTime()).toBeGreaterThanOrEqual(inicio)
  expect(data.siguienteIntentoAt.getTime()).toBeLessThanOrEqual(Date.now())
})

it('los veinticinco segundos también incluyen esperar la credencial de Google y limpian el timer', async () => {
  jest.useFakeTimers()
  prismaMock.$executeRaw.mockResolvedValue(0)
  prismaMock.$queryRaw
    .mockReset()
    .mockResolvedValue([])
    .mockResolvedValueOnce([{ ocupado: false }])
    .mockResolvedValueOnce([{ id: 'aviso', intentos: 0 }])
  prismaMock.walletPass.findMany.mockResolvedValue([
    { id: 'p', venueId: 'v', customerId: 'c', platform: 'GOOGLE', serialNumber: 's', qrToken: 'q', googleObjectId: '338.p' },
  ])
  prismaMock.walletPass.update.mockResolvedValue({ revision: 2 })
  ;(walletClient as jest.Mock).mockImplementation(() => new Promise(() => undefined))
  let termino = false
  const envio = notifyCustomerPassUpdated('v', 'c').then(r => {
    termino = true
    return r
  })
  try {
    await jest.advanceTimersByTimeAsync(24999)
    expect(termino).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    expect(await envio).toMatchObject({ failed: true })
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    jest.useRealTimers()
  }
})
it('el barrido reintenta sólo la lectura de entrada ante P1001 y mantiene su límite backend', async () => {
  jest.useFakeTimers()
  let lecturas = 0
  let limite: unknown
  prismaMock.$queryRaw.mockReset().mockImplementation((async (sql: any, ...args: any[]) => {
    if (String(sql).includes('SELECT o."venueId", o."customerId"')) {
      lecturas++
      if (lecturas === 1) throw Object.assign(new Error('conexión'), { code: 'P1001' })
      limite = args[args.length - 1]
      return [{ venueId: 'v', customerId: 'c' }]
    }
    if (String(sql).includes('count(*) AS cantidad')) return [{ cantidad: 0n }]
    return []
  }) as any)
  prismaMock.$executeRaw.mockResolvedValue(0)
  const trabajo = reintentarAvisosDeTarjeta(500)
  try {
    await jest.advanceTimersByTimeAsync(2000)
    expect(await trabajo).toEqual({ avisados: 1, fallidos: 0, ocupados: 0 })
    expect(lecturas).toBe(2)
    expect(limite).toBe(50)
  } finally {
    jest.useRealTimers()
  }
})
