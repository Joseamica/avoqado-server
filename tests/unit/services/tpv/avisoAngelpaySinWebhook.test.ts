/**
 * D11: una cuenta activa de AngelPay SIN aviso del banco acaba de cobrar con tarjeta. Sin aviso, ese cobro no se concilia solo: que se
 * entere soporte. Nunca altera el cobro: corre después del commit, sin que nadie lo espere, y ningún fallo sale de aquí.
 *
 * Log en cada cobro nuevo; correo UNA vez por cuenta en la ventana, con un tope de cuentas en memoria.
 */
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { sendOpsAlert } from '@/services/alerts/opsAlert.service'
import {
  avisarSiCobraSinAviso,
  TOPE_DE_CUENTAS,
  VENTANA_DEL_CORREO_MS,
  __reiniciarCorreosParaPruebas,
} from '@/services/tpv/avisoAngelpaySinWebhook'

jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

const mockedPrisma = prisma as unknown as { merchantAccount: { findFirst: jest.Mock } }
const mockedAlerta = sendOpsAlert as jest.Mock
const mockedError = logger.error as jest.Mock

const VENUE = 'ckz9d11venue00000000000001'
const CUENTA = 'ckz9d11cuenta0000000000001'

const cobro = (over: Record<string, unknown> = {}) => ({
  id: 'ckz9d11pago000000000000001',
  merchantAccountId: CUENTA,
  status: 'COMPLETED',
  type: null,
  method: 'CREDIT_CARD',
  fundsFlow: 'AVOQADO_PROCESSED',
  tenderTypeId: null,
  tenderCountsAsCash: null,
  ...over,
})

const avisar = (over: Record<string, unknown> = {}) => avisarSiCobraSinAviso(cobro(over) as any, VENUE)

const gritos = () => mockedError.mock.calls.filter(([mensaje]) => String(mensaje).includes('🚨'))

beforeEach(() => {
  jest.clearAllMocks()
  __reiniciarCorreosParaPruebas()
  mockedPrisma.merchantAccount.findFirst.mockResolvedValue({ displayName: 'Boutique Centro', externalMerchantId: '990' })
  mockedAlerta.mockResolvedValue(true)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('avisarSiCobraSinAviso', () => {
  it('cuenta activa de AngelPay sin secreto que cobra con tarjeta: 🚨 con sus datos y un correo con qué hacer', async () => {
    await avisar()

    expect(mockedPrisma.merchantAccount.findFirst).toHaveBeenCalledWith({
      where: { id: CUENTA, active: true, angelpayWebhookSecret: null, provider: { code: 'ANGELPAY' } },
      select: { displayName: true, externalMerchantId: true },
    })
    expect(gritos()).toHaveLength(1)
    expect(gritos()[0][1]).toEqual(
      expect.objectContaining({
        venueId: VENUE,
        merchantAccountId: CUENTA,
        paymentId: 'ckz9d11pago000000000000001',
        externalMerchantId: '990',
      }),
    )
    expect(mockedAlerta).toHaveBeenCalledTimes(1)
    const alerta = mockedAlerta.mock.calls[0][0]
    expect(alerta.subject).toContain('Boutique Centro')
    expect(alerta.lines.join(' ')).toContain('SUPERADMIN')
  })

  it('la pregunta a la base decide: una cuenta configurada, de otro proveedor o inactiva no la contesta, y no hay aviso', async () => {
    mockedPrisma.merchantAccount.findFirst.mockResolvedValue(null)

    await avisar()

    expect(gritos()).toEqual([])
    expect(mockedAlerta).not.toHaveBeenCalled()
  })

  it.each([
    ['sin cuenta', { merchantAccountId: null }],
    ['en efectivo', { method: 'CASH', fundsFlow: 'CASH_DRAWER' }],
    ['por un medio ajeno a Avoqado', { method: 'OTHER', fundsFlow: 'EXTERNAL', tenderTypeId: 'ckz9d11tender00000000000001' }],
    ['un reembolso', { type: 'REFUND' }],
    ['un cobro que no se completó', { status: 'PROCESSING' }],
    ['un cobro que falló', { status: 'FAILED' }],
  ])('%s: ni consulta la base', async (_caso, over) => {
    await avisar(over)

    expect(mockedPrisma.merchantAccount.findFirst).not.toHaveBeenCalled()
    expect(gritos()).toEqual([])
    expect(mockedAlerta).not.toHaveBeenCalled()
  })

  it('un cobro viejo sin fundsFlow estampado cuenta por su método', async () => {
    await avisar({ fundsFlow: null, method: 'DEBIT_CARD' })

    expect(gritos()).toHaveLength(1)
  })

  describe('el correo tiene tope; el log no', () => {
    it('dos cobros de la misma cuenta: dos 🚨 y UN correo', async () => {
      await avisar()
      await avisar({ id: 'ckz9d11pago000000000000002' })

      expect(gritos()).toHaveLength(2)
      expect(mockedAlerta).toHaveBeenCalledTimes(1)
    })

    it('dos cobros al mismo tiempo tampoco mandan dos', async () => {
      await Promise.all([avisar(), avisar({ id: 'ckz9d11pago000000000000002' })])

      expect(mockedAlerta).toHaveBeenCalledTimes(1)
    })

    it('al pasar la ventana vuelve a avisar', async () => {
      const ahora = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
      await avisar()
      ahora.mockReturnValue(1_000_000 + VENTANA_DEL_CORREO_MS - 1)
      await avisar()
      expect(mockedAlerta).toHaveBeenCalledTimes(1)

      ahora.mockReturnValue(1_000_000 + VENTANA_DEL_CORREO_MS)
      await avisar()
      expect(mockedAlerta).toHaveBeenCalledTimes(2)
    })

    it('otra cuenta sí manda el suyo', async () => {
      await avisar()
      await avisar({ merchantAccountId: 'ckz9d11cuenta0000000000002' })

      expect(mockedAlerta).toHaveBeenCalledTimes(2)
    })

    it('un correo que no salió no gasta la ventana: el siguiente cobro lo intenta de nuevo', async () => {
      mockedAlerta.mockResolvedValueOnce(false)

      await avisar()
      await avisar()

      expect(mockedAlerta).toHaveBeenCalledTimes(2)
    })

    it('la memoria no crece sin límite: en el tope se olvida la cuenta más vieja, y lo único que cuesta es repetir su correo', async () => {
      await avisar({ merchantAccountId: 'la-primera' })
      for (let i = 1; i < TOPE_DE_CUENTAS; i++) await avisar({ merchantAccountId: `cuenta-${i}` })
      expect(mockedAlerta).toHaveBeenCalledTimes(TOPE_DE_CUENTAS)

      await avisar({ merchantAccountId: 'la-primera' })
      expect(mockedAlerta).toHaveBeenCalledTimes(TOPE_DE_CUENTAS)

      await avisar({ merchantAccountId: 'una-mas' })
      await avisar({ merchantAccountId: 'la-primera' })
      expect(mockedAlerta).toHaveBeenCalledTimes(TOPE_DE_CUENTAS + 2)
    })
  })

  describe('nunca le estorba al cobro', () => {
    it('un correo que nunca contesta no detiene el 🚨, y la promesa que se queda colgada no la espera nadie', async () => {
      mockedAlerta.mockReturnValue(new Promise(() => undefined))

      void avisar()
      await new Promise(resolve => setImmediate(resolve))

      expect(gritos()).toHaveLength(1)
    })

    it.each([
      ['la base falla', () => mockedPrisma.merchantAccount.findFirst.mockRejectedValue(new Error('sin base'))],
      ['el correo falla', () => mockedAlerta.mockRejectedValue(new Error('sin correo'))],
    ])('%s: no sale ningún rechazo, sólo una línea', async (_caso, preparar) => {
      preparar()

      await expect(avisar()).resolves.toBeUndefined()

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[AngelPay]'),
        expect.objectContaining({ merchantAccountId: CUENTA }),
      )
    })

    it('ni siquiera un logger que truena deja un rechazo sin atrapar (tumbaría el servidor)', async () => {
      mockedPrisma.merchantAccount.findFirst.mockRejectedValue(new Error('sin base'))
      ;(logger.warn as jest.Mock).mockImplementationOnce(() => {
        throw new Error('logger roto')
      })

      await expect(avisar()).resolves.toBeUndefined()
    })
  })
})
