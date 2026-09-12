/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * UN `null` DE JSON ES UN CAMPO AUSENTE, NO UN CAMPO INVÁLIDO
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 Defecto que fija esta prueba (Testarudo, 2026-09-11, 18 rechazos en 10 minutos):
 * el POS Android serializa con kotlinx.serialization y `encodeDefaults = true`, así que un
 * campo opcional que no aplica viaja como `"amount": null` en vez de omitirse. Los guards
 * añadidos el 2026-09-04 preguntaban `!== undefined`, y **en JSON no existe `undefined`**:
 * el `null` entraba por esa puerta y moría contra el validador de centavos. Resultado en
 * producción: ninguna devolución desde la tablet, con dos mensajes que acusaban al monto
 * («amount debe ser un entero seguro positivo…») cuando el monto ni siquiera se estaba
 * mandando.
 *
 * 🔑 Lo que lo vuelve un defecto y no una decisión: el MISMO controlador, cinco líneas más
 * abajo, ya trata el nulo como ausente al llamar al servicio
 * (`typeof amount === 'number' ? amount : undefined`). El guard era más estricto que el
 * código al que protege.
 *
 * 🔴 Y lo que esta prueba NO permite: aflojar el candado. Un valor PRESENTE que no sea un
 * entero seguro de centavos (una cadena, un decimal de pesos, cero, negativo) sigue siendo
 * un 400. La diferencia entre «no me mandaste el campo» y «me mandaste basura» es justo lo
 * que se estaba perdiendo.
 */
import * as mobileController from '@/controllers/mobile/refund.mobile.controller'
import * as dashboardController from '@/controllers/dashboard/refund.dashboard.controller'
import * as tpvController from '@/controllers/tpv/refund.tpv.controller'
import * as refundDashboardService from '@/services/dashboard/refund.dashboard.service'
import * as refundTpvService from '@/services/tpv/refund.tpv.service'

jest.mock('@/services/dashboard/refund.dashboard.service')
jest.mock('@/services/mobile/refund.mobile.service')
jest.mock('@/services/tpv/refund.tpv.service')
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const issueRefundMock = refundDashboardService.issueRefund as jest.Mock
const recordRefundMock = refundTpvService.recordRefund as jest.Mock

function hacerRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as any
}

function codigoDeRespuesta(res: any): number | undefined {
  return res.status.mock.calls[0]?.[0]
}

function mensajeDeRespuesta(res: any): string | undefined {
  return res.json.mock.calls[0]?.[0]?.message
}

beforeEach(() => {
  jest.clearAllMocks()
  issueRefundMock.mockResolvedValue({ refundId: 'refund-1' })
  recordRefundMock.mockResolvedValue({ id: 'refund-1' })
})

// ──────────────────────────────────────────────────────────────────────────────────────
// El caso exacto de Testarudo: la tablet reembolsa POR ARTÍCULOS y manda `amount: null`
// ──────────────────────────────────────────────────────────────────────────────────────

describe('móvil · POST /mobile/venues/:venueId/payments/:paymentId/refund', () => {
  function reqMovil(body: Record<string, unknown>) {
    return {
      params: { venueId: 'venue-1', paymentId: 'payment-1' },
      body,
      authContext: { userId: 'staff-1' },
    } as any
  }

  it('acepta el reembolso por artículos aunque `amount` viaje como null explícito', async () => {
    const res = hacerRes()

    await mobileController.issueAssociatedRefund(
      reqMovil({
        amount: null,
        items: [{ orderItemId: 'oi-1', quantity: 1 }],
        restockItemIds: null,
        reason: 'ACCIDENTAL_CHARGE',
        note: null,
        tipRefundCents: null,
      }),
      res,
      jest.fn(),
    )

    expect(codigoDeRespuesta(res)).toBe(201)
    expect(issueRefundMock).toHaveBeenCalledTimes(1)
    const entregado = issueRefundMock.mock.calls[0][0]
    expect(entregado.amount).toBeUndefined()
    expect(entregado.tipRefundCents).toBeUndefined()
    expect(entregado.items).toEqual([{ orderItemId: 'oi-1', quantity: 1 }])
  })

  it('acepta el reembolso por importe con `tipRefundCents` en null (reparto proporcional)', async () => {
    const res = hacerRes()

    await mobileController.issueAssociatedRefund(
      reqMovil({ amount: 6500, items: null, reason: 'ACCIDENTAL_CHARGE', tipRefundCents: null }),
      res,
      jest.fn(),
    )

    expect(codigoDeRespuesta(res)).toBe(201)
    const entregado = issueRefundMock.mock.calls[0][0]
    expect(entregado.amount).toBe(6500)
    expect(entregado.tipRefundCents).toBeUndefined()
  })

  it('conserva tipRefundCents=0: es «devuelve sólo la venta», no «no me mandaste nada»', async () => {
    const res = hacerRes()

    await mobileController.issueAssociatedRefund(
      reqMovil({ amount: 6500, reason: 'ACCIDENTAL_CHARGE', tipRefundCents: 0 }),
      res,
      jest.fn(),
    )

    expect(codigoDeRespuesta(res)).toBe(201)
    expect(issueRefundMock.mock.calls[0][0].tipRefundCents).toBe(0)
  })

  // ── El candado NO se afloja ──────────────────────────────────────────────────────────

  it.each([
    ['una cadena', '6500'],
    ['un decimal de pesos', 65.5],
    ['cero', 0],
    ['un negativo', -100],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rechaza `amount` cuando viene PRESENTE y es %s', async (_caso, amount) => {
    const res = hacerRes()

    await mobileController.issueAssociatedRefund(
      reqMovil({ amount, reason: 'ACCIDENTAL_CHARGE' }),
      res,
      jest.fn(),
    )

    expect(codigoDeRespuesta(res)).toBe(400)
    expect(mensajeDeRespuesta(res)).toContain('centavos')
    expect(issueRefundMock).not.toHaveBeenCalled()
  })

  it.each([
    ['un decimal de pesos (la propina en $9.75)', 9.75],
    ['una cadena', '975'],
    ['un negativo', -1],
  ])('rechaza `tipRefundCents` cuando viene PRESENTE y es %s', async (_caso, tipRefundCents) => {
    const res = hacerRes()

    await mobileController.issueAssociatedRefund(
      reqMovil({ amount: 6500, reason: 'ACCIDENTAL_CHARGE', tipRefundCents }),
      res,
      jest.fn(),
    )

    expect(codigoDeRespuesta(res)).toBe(400)
    expect(mensajeDeRespuesta(res)).toContain('tipRefundCents')
    expect(issueRefundMock).not.toHaveBeenCalled()
  })

  it('sigue exigiendo `amount` o `items`: ambos nulos no es un reembolso', async () => {
    const res = hacerRes()

    await mobileController.issueAssociatedRefund(
      reqMovil({ amount: null, items: null, reason: 'ACCIDENTAL_CHARGE' }),
      res,
      jest.fn(),
    )

    expect(codigoDeRespuesta(res)).toBe(400)
    expect(issueRefundMock).not.toHaveBeenCalled()
  })
})

// ──────────────────────────────────────────────────────────────────────────────────────
// Dashboard: mismo contrato, mismo controlador espejo
// ──────────────────────────────────────────────────────────────────────────────────────

describe('dashboard · POST /dashboard/venues/:venueId/payments/:paymentId/refund', () => {
  it('acepta el reembolso por artículos con `amount` en null explícito', async () => {
    const res = hacerRes()

    await dashboardController.issueRefund(
      {
        params: { venueId: 'venue-1', paymentId: 'payment-1' },
        body: {
          amount: null,
          items: [{ orderItemId: 'oi-1', quantity: 1 }],
          reason: 'ACCIDENTAL_CHARGE',
          tipRefundCents: null,
        },
        authContext: { userId: 'staff-1' },
      } as any,
      res,
      jest.fn(),
    )

    expect(codigoDeRespuesta(res)).toBe(201)
    expect(issueRefundMock.mock.calls[0][0].amount).toBeUndefined()
    expect(issueRefundMock.mock.calls[0][0].tipRefundCents).toBeUndefined()
  })

  it('rechaza un `amount` presente que no son centavos enteros', async () => {
    const res = hacerRes()

    await dashboardController.issueRefund(
      {
        params: { venueId: 'venue-1', paymentId: 'payment-1' },
        body: { amount: 65.5, reason: 'ACCIDENTAL_CHARGE' },
        authContext: { userId: 'staff-1' },
      } as any,
      res,
      jest.fn(),
    )

    expect(codigoDeRespuesta(res)).toBe(400)
    expect(issueRefundMock).not.toHaveBeenCalled()
  })
})

// ──────────────────────────────────────────────────────────────────────────────────────
// TPV/PAX: hoy manda con Gson (que omite nulos), pero el controlador no puede depender de
// eso — y el commit del 2026-09-04 le quitó la normalización que convertía null en undefined.
// ──────────────────────────────────────────────────────────────────────────────────────

describe('tpv · POST /tpv/venues/:venueId/refunds', () => {
  function reqTpv(body: Record<string, unknown>) {
    return {
      params: { venueId: 'venue-1' },
      body,
      authContext: { orgId: 'org-1', userId: 'staff-1' },
      header: jest.fn(),
    } as any
  }

  it('trata `tipRefundCents: null` como ausente y NO se lo pasa al servicio', async () => {
    const res = hacerRes()

    await tpvController.recordRefund(
      reqTpv({
        originalPaymentId: 'payment-1',
        amount: 10_000,
        reason: 'CUSTOMER_REQUEST',
        tipRefundCents: null,
      }),
      res,
      jest.fn(),
    )

    expect(recordRefundMock).toHaveBeenCalledTimes(1)
    // `undefined` = reparto proporcional por default. Un `null` colado aquí haría que el
    // servicio decidiera el desglose con un valor que no es número.
    expect(recordRefundMock.mock.calls[0][1].tipRefundCents).toBeUndefined()
  })

  it('rechaza `tipRefundCents` presente y decimal', async () => {
    const res = hacerRes()

    await tpvController.recordRefund(
      reqTpv({ originalPaymentId: 'payment-1', amount: 10_000, reason: 'CUSTOMER_REQUEST', tipRefundCents: 9.75 }),
      res,
      jest.fn(),
    )

    expect(codigoDeRespuesta(res)).toBe(400)
    expect(recordRefundMock).not.toHaveBeenCalled()
  })
})
