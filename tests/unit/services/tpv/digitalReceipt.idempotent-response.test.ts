/**
 * Regresión — el bucle infinito de reintentos de Testarudo Café (2026-08-05).
 *
 * Una terminal PAX reintentó el MISMO cobro del 23-jun 2,781 veces en 6.3 h (≈7.7 req/s en las
 * ráfagas). Cero doble cargo: la idempotencia del server respondió correctamente las 2,781 veces.
 * Lo que fallaba era la FORMA de esa respuesta.
 *
 * Cadena completa, verificada contra prod + Crashlytics:
 *   1. El pago existente NO tenía fila en `DigitalReceipt` (verificado: 0 recibos).
 *   2. `mapDigitalReceiptResponse(undefined)` corta con `if (!receipt) return null`.
 *   3. El server respondía 200 con `digitalReceipt: null`.
 *   4. El TPV lo leía sin protección (`body.data.digitalReceipt.receiptUrl`) → NullPointerException
 *      (Crashlytics `FastPaymentRecorder$recordPayment$2`, ref=855502456783).
 *   5. La NPE se clasificaba como TRANSITORIA → 5 reintentos internos × 10 del worker = 50
 *      requests por ciclo, resucitando indefinidamente.
 *
 * El TPV ya quedó blindado, pero un APK tarda 3-5 días en llegar a las terminales. Esto cierra el
 * hueco desde el server (despliega en minutos) y además cubre a las terminales con versiones viejas.
 */

const mockGenerateDigitalReceipt = jest.fn()

jest.mock('../../../../src/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: (...args: unknown[]) => mockGenerateDigitalReceipt(...args),
}))

import { ensureDigitalReceiptResponse, mapDigitalReceiptResponse } from '../../../../src/services/tpv/payment.tpv.service'

describe('ensureDigitalReceiptResponse — respuesta idempotente sin recibo', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('🔴 REGRESIÓN: genera el recibo faltante en vez de devolver null', async () => {
    mockGenerateDigitalReceipt.mockResolvedValue({ id: 'rcp_nuevo', accessKey: 'llave_nueva' })

    const result = await ensureDigitalReceiptResponse('pmt_sin_recibo', undefined)

    // Lo que importa: NO es null. Un null aquí es lo que tiraba la NPE en el TPV.
    expect(result).not.toBeNull()
    expect(result?.accessKey).toBe('llave_nueva')
    expect(result?.receiptUrl).toContain('/receipts/public/llave_nueva')
    expect(mockGenerateDigitalReceipt).toHaveBeenCalledWith('pmt_sin_recibo')
  })

  it('no genera nada si el pago YA tiene recibo (no duplica recibos)', async () => {
    const result = await ensureDigitalReceiptResponse('pmt_con_recibo', { accessKey: 'llave_existente' })

    expect(result?.accessKey).toBe('llave_existente')
    expect(result?.receiptUrl).toContain('/receipts/public/llave_existente')
    expect(mockGenerateDigitalReceipt).not.toHaveBeenCalled()
  })

  it('si la generación falla, NO lanza — cae a null y el cobro se responde igual', async () => {
    // Un recibo faltante jamás puede tumbar la respuesta de un cobro que ya ocurrió.
    mockGenerateDigitalReceipt.mockRejectedValue(new Error('PAC caído'))

    await expect(ensureDigitalReceiptResponse('pmt_x', null)).resolves.toBeNull()
  })

  it('propaga autofacturaAvailable en ambos caminos', async () => {
    mockGenerateDigitalReceipt.mockResolvedValue({ id: 'r1', accessKey: 'k1' })

    const generado = await ensureDigitalReceiptResponse('pmt_1', null, true)
    const existente = await ensureDigitalReceiptResponse('pmt_2', { accessKey: 'k2' }, true)

    expect(generado?.autofacturaAvailable).toBe(true)
    expect(existente?.autofacturaAvailable).toBe(true)
  })

  // Regresión del mapeador base: sigue devolviendo null cuando no hay recibo. Es correcto como
  // MAPEO puro — el arreglo fue no usarlo directo en las ramas idempotentes, no cambiarlo.
  it('mapDigitalReceiptResponse (mapeo puro) sigue devolviendo null sin recibo', () => {
    expect(mapDigitalReceiptResponse(null)).toBeNull()
    expect(mapDigitalReceiptResponse(undefined)).toBeNull()
    expect(mapDigitalReceiptResponse({ accessKey: 'k' })?.receiptUrl).toContain('/receipts/public/k')
  })
})
