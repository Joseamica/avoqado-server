/**
 * El motor de liquidación no puede pagar un log por pago.
 *
 * `calculateSettlementDate` es una función PURA que el calendario de liquidaciones llama
 * UNA VEZ POR PAGO (`settlementCalendar.dashboard.service.ts:77`). Con ~2,900 pagos por
 * carga —medido en producción el 2026-09-21, creciendo ~300/día— un log ahí dentro se paga
 * en el mismo hilo que atiende los cobros, cada vez que alguien abre la pantalla.
 *
 * 🔴 Lo que esta prueba fija, y que bajar el nivel a `debug` NO conseguía: winston aplica su
 * formato ANTES de que el transporte descarte la línea. Medido con la versión instalada: 50
 * llamadas `debug` con `level=info` ⇒ 50 pasadas por el formato y 0 escrituras. Por eso la
 * llamada va detrás de `logger.isDebugEnabled()`: sin `debug` activo no se construye ni el
 * objeto de metadatos.
 */
import { calculateSettlementDate } from '@/services/payments/settlementCalculation.service'
import { SettlementDayType } from '@prisma/client'
import logger from '@/config/logger'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { transactionCost: { findUnique: jest.fn() } },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    isDebugEnabled: jest.fn(() => false),
  },
}))

const cfg: Parameters<typeof calculateSettlementDate>[1] = {
  settlementDays: 2,
  settlementDayType: SettlementDayType.BUSINESS_DAYS,
  cutoffTime: '20:00',
  cutoffTimezone: 'America/Mexico_City',
}

const enero = new Date('2026-09-21T15:00:00Z')

describe('costo de log del motor de liquidación', () => {
  beforeEach(() => jest.clearAllMocks())

  it('con debug APAGADO (producción) no llama al logger en absoluto', () => {
    ;(logger.isDebugEnabled as jest.Mock).mockReturnValue(false)

    for (let i = 0; i < 50; i += 1) calculateSettlementDate(enero, cfg)

    // Ni `info` (el nivel viejo) ni `debug`: con la guarda, el objeto ni se construye.
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it('con debug ENCENDIDO conserva la trazabilidad completa', () => {
    ;(logger.isDebugEnabled as jest.Mock).mockReturnValue(true)

    calculateSettlementDate(enero, cfg)

    expect(logger.debug).toHaveBeenCalledTimes(1)
    const [mensaje, meta] = (logger.debug as jest.Mock).mock.calls[0]
    expect(mensaje).toBe('Settlement date calculated')
    // Assertions exactas del metadata: que siga sirviendo para depurar una fecha concreta.
    expect(meta).toEqual({
      transactionDate: enero,
      settlementDays: 2,
      settlementDayType: SettlementDayType.BUSINESS_DAYS,
      settlementDate: expect.any(Date),
    })
  })

  it('el cálculo es el mismo con debug encendido o apagado (el log no era el cálculo)', () => {
    // Viernes 18-sep 15:00Z = 09:00 en CDMX, antes del corte ⇒ +2 días hábiles = martes 22.
    const viernes = new Date('2026-09-18T15:00:00Z')

    ;(logger.isDebugEnabled as jest.Mock).mockReturnValue(false)
    const apagado = calculateSettlementDate(viernes, cfg)
    ;(logger.isDebugEnabled as jest.Mock).mockReturnValue(true)
    const encendido = calculateSettlementDate(viernes, cfg)

    expect(apagado.toISOString()).toBe(encendido.toISOString())
    expect(apagado.toISOString().slice(0, 10)).toBe('2026-09-22')
  })
})
