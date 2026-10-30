/**
 * 30-sep-2026 · Inventario de warns de producción: «⚠️ [TerminalPayment] Authenticated late result closed row without an HTTP
 * waiter» salía ~200 veces al día en Testarudo — dos líneas por cobro NORMAL — porque desde S8 el WEBHOOK de AngelPay cierra la
 * fila (`closedVia = 'webhook'`) antes de que la terminal mande su propio resultado por socket; para entonces el POS ya fue
 * contestado y no hay «espera» que resolver. Eso no es un resultado tardío: es el orden normal, y sale en info.
 *
 * El warn se conserva para la fila que NADIE había cerrado y cuyo POS ya no esperaba (ventana vencida, servidor reiniciado):
 * ahí la terminal sí cerró dinero sin nadie del otro lado, y eso sí hay que mirarlo.
 */
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { terminalPaymentService } from '@/services/terminal-payment.service'

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: jest.fn() },
  socketManager: { getServer: jest.fn() },
}))
jest.mock('@/communication/sockets/terminal-registry', () => {
  const normalizeTerminalId = (id: string) => id.replace(/^AVQD-/i, '').toLowerCase()
  return {
    normalizeTerminalId,
    terminalRegistry: { getTerminal: jest.fn(), getTerminalBySocketId: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
  }
})

const prismaMock = prisma as any
const svc = terminalPaymentService as any
const TERMINAL = { socketId: 's1', terminalId: 'AVQD-N860W173400', venueId: 'v1' }
const RESULTADO = { requestId: 'r1', status: 'success', paymentId: 'p1' } as any
const SIN_ESPERA = expect.stringContaining('without an HTTP waiter')

let closeRow: jest.SpyInstance
beforeEach(() => {
  closeRow = jest.spyOn(svc, 'closeRow').mockResolvedValue(RESULTADO)
})
afterEach(() => closeRow.mockRestore())

it('la fila que el WEBHOOK ya cerró: el resultado de la terminal se procesa igual (idempotente) y se anota en info, no en warn', async () => {
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue({ requestId: 'r1', closedVia: 'webhook' })

  expect(await terminalPaymentService.handlePaymentResultFromSocket(RESULTADO, TERMINAL)).toBe(false)

  expect(closeRow).toHaveBeenCalledWith('r1', 'v1', RESULTADO)
  expect(logger.warn).not.toHaveBeenCalledWith(SIN_ESPERA, expect.anything())
  expect(logger.info).toHaveBeenCalledWith(
    expect.stringContaining('webhook already closed'),
    expect.objectContaining({ requestId: 'r1', closedVia: 'webhook' }),
  )
})

it('🔴 la fila que NADIE había cerrado y cuyo POS ya no espera sigue siendo un warn: ahí sí hubo un resultado tardío', async () => {
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue({ requestId: 'r1', closedVia: null })

  expect(await terminalPaymentService.handlePaymentResultFromSocket(RESULTADO, TERMINAL)).toBe(false)

  expect(closeRow).toHaveBeenCalledWith('r1', 'v1', RESULTADO)
  expect(logger.warn).toHaveBeenCalledWith(SIN_ESPERA, expect.objectContaining({ requestId: 'r1' }))
})

it('regresión: un resultado de una fila que NO es de esta terminal se rechaza sin cerrar nada', async () => {
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(null)

  expect(await terminalPaymentService.handlePaymentResultFromSocket(RESULTADO, TERMINAL)).toBe(false)

  expect(closeRow).not.toHaveBeenCalled()
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not owned by authenticated terminal socket'), expect.anything())
})

/**
 * Mismo inventario: «🔎 Probe NOT_FOUND cannot accredit non-receipt: reservation kept for an operator» era el aviso que más
 * crecía (85 → 448 al día): la Nexgo de Testarudo re-sondea en cada reconexión las mismas filas viejas sin procedencia de
 * entrega, y la respuesta no cambia. La PRIMERA respuesta de una fila sigue siendo un warn y queda en ActivityLog; las
 * repeticiones sobre una fila ya auditada salen en info. La reserva se conserva igual en los dos casos.
 */
describe('sonda NOT_FOUND sobre una fila vieja sin procedencia', () => {
  const filaVieja = (id: string) => ({
    id,
    status: 'FAILED',
    acknowledgedAt: null,
    lastDeliveredAt: null,
    deliveryProvenance: null,
    expiresAt: new Date(0),
    terminalId: 'n860w173400',
    probeActiveAt: null,
  })
  const NO_ACREDITA = expect.stringContaining('Probe NOT_FOUND cannot accredit non-receipt')

  it('la PRIMERA respuesta de una fila avisa en warn y deja constancia en ActivityLog', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(filaVieja('fila-sonda-1'))
    prismaMock.activityLog.findFirst.mockResolvedValue(null)
    const { logAction } = jest.requireMock('@/services/dashboard/activity-log.service')

    const ok = await terminalPaymentService.handleProbeResultFromSocket({ requestId: 'rs1', disposition: 'NOT_FOUND' }, TERMINAL)

    expect(ok).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(NO_ACREDITA, expect.objectContaining({ requestId: 'rs1', audited: true }))
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TERMINAL_PAYMENT_PROBE_UNACCREDITED', entityId: 'fila-sonda-1' }),
    )
    expect(prismaMock.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 la MISMA respuesta sobre una fila ya auditada no repite el warn: sale en info y la reserva se conserva igual', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(filaVieja('fila-sonda-2'))
    prismaMock.activityLog.findFirst.mockResolvedValue({ id: 'log-previo' })
    const { logAction } = jest.requireMock('@/services/dashboard/activity-log.service')

    const ok = await terminalPaymentService.handleProbeResultFromSocket({ requestId: 'rs2', disposition: 'NOT_FOUND' }, TERMINAL)

    expect(ok).toBe(true)
    expect(logger.warn).not.toHaveBeenCalledWith(NO_ACREDITA, expect.anything())
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Probe NOT_FOUND repeated'),
      expect.objectContaining({ requestId: 'rs2' }),
    )
    expect(logAction).not.toHaveBeenCalled()
    expect(prismaMock.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
  })
})

/**
 * 24-oct-2026 · Better Stack mandaba el correo «🚨 Terminal-payment crítico» varias veces al día por las MISMAS 9 filas de la
 * N86 de Testarudo (9 y 10-sep, ya canceladas): cada reconexión de la terminal —o cada reinicio del servidor, que borra la
 * espera en memoria— volvía a escribir el 🚨 «Probe contradiction» aunque la fila ya estaba auditada. Mismo arreglo que la rama
 * hermana de arriba: la PRIMERA contradicción de una fila es un 🚨 y queda en ActivityLog; las repeticiones salen en info.
 */
describe('sonda NOT_FOUND sobre una fila que la terminal sí acusó (contradicción)', () => {
  const filaAcusada = (id: string) => ({
    id,
    status: 'CANCELLED',
    acknowledgedAt: new Date('2026-09-10T17:08:14.320Z'),
    lastDeliveredAt: new Date('2026-09-10T17:08:13.000Z'),
    deliveryProvenance: null,
    expiresAt: new Date(0),
    terminalId: 'n860w173400',
    probeActiveAt: null,
  })
  const CONTRADICCION = expect.stringContaining('Probe contradiction')

  it('la PRIMERA contradicción de una fila sigue siendo un 🚨 y deja constancia en ActivityLog', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(filaAcusada('fila-contradiccion-1'))
    prismaMock.activityLog.findFirst.mockResolvedValue(null)
    const { logAction } = jest.requireMock('@/services/dashboard/activity-log.service')

    const ok = await terminalPaymentService.handleProbeResultFromSocket({ requestId: 'rc1', disposition: 'NOT_FOUND' }, TERMINAL)

    expect(ok).toBe(true)
    expect(logger.error).toHaveBeenCalledWith(CONTRADICCION, expect.objectContaining({ requestId: 'rc1', audited: true }))
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TERMINAL_PAYMENT_PROBE_CONTRADICTION', entityId: 'fila-contradiccion-1' }),
    )
    expect(prismaMock.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 la MISMA contradicción sobre una fila ya auditada no repite el 🚨: sale en info y la reserva se conserva igual', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(filaAcusada('fila-contradiccion-2'))
    prismaMock.activityLog.findFirst.mockResolvedValue({ id: 'log-previo' })
    const { logAction } = jest.requireMock('@/services/dashboard/activity-log.service')

    const ok = await terminalPaymentService.handleProbeResultFromSocket({ requestId: 'rc2', disposition: 'NOT_FOUND' }, TERMINAL)

    expect(ok).toBe(true)
    expect(logger.error).not.toHaveBeenCalledWith(CONTRADICCION, expect.anything())
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('🚨'), expect.anything())
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Probe contradiction repeated'),
      expect.objectContaining({ requestId: 'rc2' }),
    )
    expect(logAction).not.toHaveBeenCalled()
    expect(prismaMock.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
  })
})
