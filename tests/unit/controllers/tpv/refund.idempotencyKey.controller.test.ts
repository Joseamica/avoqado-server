/**
 * El controlador del reembolso del TPV PASA la llave de idempotencia al servicio.
 *
 * 🔴 POR QUÉ EXISTE, y es la lección cara de este cambio (3-sep-2026):
 *
 * `refund.tpv.service.ts` se volvió idempotente: lee `refundData.idempotencyKey`, corta el
 * reintento y persiste la llave en el `Payment` para que el `@@unique([venueId,
 * idempotencyKey])` por fin proteja. Sus pruebas pasaban, el typecheck pasaba... y el
 * endpoint desplegado habría seguido duplicando EXACTAMENTE igual.
 *
 * Causa: `recordRefund` del CONTROLADOR arma `refundData` campo por campo, y la llave no
 * estaba en esa lista. El servicio leía un campo que en producción siempre valía `undefined`.
 * Las pruebas del servicio no lo veían porque **llaman al servicio directo, saltándose la
 * capa HTTP** — pasaban por el motivo equivocado.
 *
 * Lo encontró una auditoría de Codex, no los tests ni el compilador. De ahí esta prueba: el
 * cableado HTTP→servicio es la parte que ninguna prueba de servicio puede cubrir.
 *
 * ⚠️ Y el body llega CRUDO al controlador: la ruta valida con `recordFastPaymentParamsSchema`,
 * que declara **sólo `params`**, y `validateRequest` únicamente construye `dataToParse.body`
 * cuando el esquema trae `body` (`src/middlewares/validation.ts:14`). Si algún día alguien le
 * añade un `body:` a ese esquema, Zod DESCARTARÁ la llave en silencio y volveremos aquí — el
 * caso «la llave del body llega al servicio» es lo que lo cazaría.
 */
import * as controller from '@/controllers/tpv/refund.tpv.controller'
import * as refundTpvService from '@/services/tpv/refund.tpv.service'

jest.mock('@/services/tpv/refund.tpv.service')
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const recordRefundMock = refundTpvService.recordRefund as jest.Mock

const mockRes = () => {
  const r: any = {}
  r.status = jest.fn().mockReturnValue(r)
  r.json = jest.fn().mockReturnValue(r)
  return r
}

/** `headers` va en minúsculas: es como Express normaliza y como responde `req.header()`. */
const mockReq = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  ({
    params: { venueId: 'venue-1' },
    body,
    authContext: { orgId: 'org-1', userId: 'staff-1' },
    header: (name: string) => headers[name.toLowerCase()],
  }) as any

const cuerpoBase = {
  originalPaymentId: 'pay-orig',
  amount: 5000,
  reason: 'CUSTOMER_REQUEST',
  staffId: 'staff-1',
  merchantAccountId: 'merch-1',
  blumonSerialNumber: '2841548417',
  authorizationNumber: '502511',
  referenceNumber: '000000188231',
  isPartialRefund: true,
  currency: 'MXN',
}

/** Lo que el controlador realmente le entregó al servicio. */
const datosEntregados = () => recordRefundMock.mock.calls[0][1]

beforeEach(() => {
  jest.clearAllMocks()
  recordRefundMock.mockResolvedValue({ id: 'pay-refund', originalPaymentId: 'pay-orig', amount: 50, status: 'COMPLETED' })
})

describe('refund.tpv.controller — la llave de idempotencia llega al servicio', () => {
  it('🔴 la llave del BODY llega al servicio', async () => {
    const req = mockReq({ ...cuerpoBase, idempotencyKey: 'llave-del-body' })

    await controller.recordRefund(req, mockRes(), jest.fn())

    expect(datosEntregados().idempotencyKey).toBe('llave-del-body')
  })

  it('🔴 sin llave en el body, se toma del header Idempotency-Key', async () => {
    // La terminal la manda por LAS DOS vías (`PaymentApiService.recordRefund` declara
    // `@Body` y `@Header("Idempotency-Key")`). Aceptar el header además del body es lo que
    // hace que un cliente que sólo use la convención HTTP también quede protegido.
    const req = mockReq({ ...cuerpoBase }, { 'idempotency-key': 'llave-del-header' })

    await controller.recordRefund(req, mockRes(), jest.fn())

    expect(datosEntregados().idempotencyKey).toBe('llave-del-header')
  })

  it('el body GANA sobre el header cuando vienen los dos', async () => {
    const req = mockReq({ ...cuerpoBase, idempotencyKey: 'llave-del-body' }, { 'idempotency-key': 'llave-del-header' })

    await controller.recordRefund(req, mockRes(), jest.fn())

    expect(datosEntregados().idempotencyKey).toBe('llave-del-body')
  })

  it('🔴 una llave EN BLANCO en el body no tapa un header válido', async () => {
    // `'' ?? header` devuelve `''` — el operador `??` sólo cae al siguiente con null/undefined.
    // El servicio normaliza `''` a «ausente», así que la llave buena del header se PERDÍA y el
    // reembolso quedaba sin protección de idempotencia sin que nadie se enterara.
    const req = mockReq({ ...cuerpoBase, idempotencyKey: '   ' }, { 'idempotency-key': 'llave-del-header' })

    await controller.recordRefund(req, mockRes(), jest.fn())

    expect(datosEntregados().idempotencyKey).toBe('llave-del-header')
  })

  // ─── Compatibilidad con la calle ────────────────────────────────────────────

  it('sin llave por ninguna vía llega undefined — el APK que hay hoy en la calle', async () => {
    // `PaymentContext.RefundPayment.idempotencyKey` tiene default `null` y nadie la puebla;
    // Gson omite los nulos, así que hoy no viaja ni en el body ni en el header.
    const req = mockReq({ ...cuerpoBase })

    await controller.recordRefund(req, mockRes(), jest.fn())

    expect(datosEntregados().idempotencyKey).toBeUndefined()
    expect(recordRefundMock).toHaveBeenCalledTimes(1)
  })

  // ─── Regresión: lo que NO se puede romper ───────────────────────────────────

  it('el resto del contrato sigue igual — venueId de params, 201, y el sobre de la respuesta', async () => {
    const req = mockReq({ ...cuerpoBase, idempotencyKey: 'llave-1', processor: 'angelpay' })
    const res = mockRes()

    await controller.recordRefund(req, res, jest.fn())

    const datos = datosEntregados()
    expect(datos.venueId).toBe('venue-1') // de req.params, nunca del body
    expect(datos.originalPaymentId).toBe('pay-orig')
    expect(datos.amount).toBe(5000)
    expect(datos.processor).toBe('angelpay')
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, message: 'Refund recorded successfully' }))
  })

  /**
   * 🔴 El límite que la auditoría marcó en esta prueba: llama al controlador con un `mockReq`,
   * así que NO atraviesa la ruta ni sus middlewares. Podría quedar en verde aunque producción
   * descartara la llave ANTES de llegar aquí.
   *
   * El único middleware que puede hacerlo es `validateRequest`, y sólo si el esquema de la ruta
   * declara `body`: en ese caso reemplaza `req.body` por lo que Zod parseó, y Zod DESCARTA las
   * llaves desconocidas — la misma trampa que ya costó una prueba falsa en este repo. Este caso
   * cierra el hueco por construcción, sin necesitar una prueba de API con base de datos.
   */
  it('🔴 el esquema de la ruta NO declara `body` — si alguien se lo añade, Zod tiraría la llave', () => {
    const { recordFastPaymentParamsSchema } = jest.requireActual('@/schemas/tpv.schema')

    expect(Object.keys(recordFastPaymentParamsSchema.shape)).toEqual(['params'])
    expect(recordFastPaymentParamsSchema.shape.body).toBeUndefined()
  })

  it('🔴 un venueId hostil en el BODY no puede sustituir al de la ruta', async () => {
    const req = mockReq({ ...cuerpoBase, venueId: 'venue-de-otro-negocio', idempotencyKey: 'llave-1' })

    await controller.recordRefund(req, mockRes(), jest.fn())

    expect(datosEntregados().venueId).toBe('venue-1')
    expect(recordRefundMock.mock.calls[0][0]).toBe('venue-1')
  })
})
