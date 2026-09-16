/**
 * Codex R4-4 / R5-3 / R6 (diseño B): la obligación de costo de un cobro por REST es DURABLE y tiene UN solo criterio de
 * cumplimiento — la unidad de convergencia (`convergerCostoDeTransaccion`), que corre bajo la fila del Payment con
 * `FOR UPDATE NOWAIT` y decide `costPending` y la transición de la obligación DENTRO. Un fallo operativo del cálculo síncrono
 * sólo ANOTA el motivo (la marca ya nació con la obligación); una contención no toca nada; el REST cierra sólo PENDING.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import {
  anotarCostoNoCalculado,
  asegurarCostoSincrono,
  cerrarObligacionDeCosto,
  convergerCostoDeTransaccion,
} from '@/services/payments/deferredTransactionCost.service'

beforeEach(() => {
  ;(prismaMock as any).paymentEffect.updateMany.mockReset().mockResolvedValue({ count: 1 })
  ;(prismaMock as any).$executeRaw.mockReset().mockResolvedValue(1)
  ;(prismaMock as any).$queryRaw.mockReset().mockResolvedValue([{ id: 'p1' }])
  ;(prismaMock as any).$transaction
    .mockReset()
    .mockImplementation(async (fn: unknown) =>
      typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(prismaMock) : Promise.all(fn as unknown[]),
    )
})

it('un fallo por tarifa no acreditable anota AFFILIATION_PRICING_UNRESOLVED en el efecto (PENDING o PROCESSING) — la marca costPending ya nació con la obligación, aquí NO se decide', async () => {
  await anotarCostoNoCalculado('p1', new Error('COST_PENDING_AFFILIATION_PRICING_UNRESOLVED: payment p1 …'))
  expect((prismaMock as any).paymentEffect.updateMany).toHaveBeenCalledWith({
    where: { paymentId: 'p1', kind: 'TRANSACTION_COST', status: { in: ['PROCESSING', 'PENDING'] } },
    data: { lastError: 'AFFILIATION_PRICING_UNRESOLVED' },
  })
  expect((prismaMock as any).$executeRaw).not.toHaveBeenCalled()
})

it('Codex R7 (P2-d) · un snapshot de tarifa ILEGIBLE anota INVALID_PRICING_SNAPSHOT: es una obligación con nombre (el negocio la ve), no un fallo operativo que el worker reintente a ciegas', async () => {
  await anotarCostoNoCalculado(
    'p1',
    new Error(
      'COST_PENDING_INVALID_PRICING_SNAPSHOT: payment p1 carries a frozen pricing snapshot that is not readable (AFILIACION_DISTINTA)',
    ),
  )
  expect((prismaMock as any).paymentEffect.updateMany.mock.calls[0][0].data).toEqual({ lastError: 'INVALID_PRICING_SNAPSHOT' })
  expect((prismaMock as any).$executeRaw).not.toHaveBeenCalled()
})

it('Codex R10-1 · una captura de tarifa FALLIDA al cobrar anota PRICING_CAPTURE_FAILED: obligación con nombre, sin consumir intentos — nunca un fallo operativo que se reintente hasta DEAD_LETTER', async () => {
  await anotarCostoNoCalculado(
    'p1',
    new Error(
      'COST_PENDING_PRICING_CAPTURE_FAILED: payment p1 was processed by M2 but its pricing could not be read at charge time (NEGOCIO: ECONNRESET)',
    ),
  )
  expect((prismaMock as any).paymentEffect.updateMany.mock.calls[0][0].data).toEqual({ lastError: 'PRICING_CAPTURE_FAILED' })
  expect((prismaMock as any).$executeRaw).not.toHaveBeenCalled()
})

it('cualquier otro fallo se anota como TRANSACTION_COST_FAILED (el worker reintenta con backoff) y nunca cierra la obligación', async () => {
  await anotarCostoNoCalculado('p1', new Error('ECONNRESET'))
  expect((prismaMock as any).paymentEffect.updateMany.mock.calls[0][0].data).toEqual({ lastError: 'TRANSACTION_COST_FAILED' })
  expect((prismaMock as any).paymentEffect.updateMany).not.toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: 'DONE' }) }),
  )
})

it('Codex R6 (diseño B): la unidad de convergencia toma PRIMERO la fila del Payment con FOR NO KEY UPDATE NOWAIT — el mutex es la fila que ya existe (sin bloquear los INSERT ajenos por FK)', async () => {
  ;(prismaMock as any).payment.findUniqueOrThrow.mockResolvedValue({ id: 'p1', status: 'COMPLETED', method: 'CASH' })
  const desenlace = await convergerCostoDeTransaccion('p1', { tipo: 'REST' })
  expect(desenlace).toBe('NO_APLICA')
  const primera = ((prismaMock as any).$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?')
  expect(primera).toMatch(/SELECT "id" FROM "Payment" \/\* convergencia \*\/ WHERE "id" = \? FOR NO KEY UPDATE NOWAIT/)
  expect((prismaMock as any).$transaction).toHaveBeenCalledTimes(1)
})

it('Codex R6 (h): la CONTENCIÓN (55P03, otra corrida tiene la fila) es un desenlace distinto de un fallo: no converge, no cambia costPending, no cierra la obligación, no lanza', async () => {
  const contencion = Object.assign(new Error('could not obtain lock on row in relation "Payment"'), { meta: { code: '55P03' } })
  ;(prismaMock as any).$queryRaw.mockRejectedValueOnce(contencion)
  expect(await convergerCostoDeTransaccion('p1', { tipo: 'REST' })).toBe('CONTENDIDO')
  expect((prismaMock as any).$executeRaw).not.toHaveBeenCalled()
  expect((prismaMock as any).paymentEffect.updateMany).not.toHaveBeenCalled()
  ;(prismaMock as any).$queryRaw.mockRejectedValueOnce(contencion)
  expect(await asegurarCostoSincrono('p1')).toBe('CONTENDIDA')
  expect((prismaMock as any).$executeRaw).not.toHaveBeenCalled()
  expect((prismaMock as any).paymentEffect.updateMany).not.toHaveBeenCalled()
})

it('un error operativo (no es contención) se PROPAGA desde la unidad; asegurarCostoSincrono lo anota y devuelve PENDIENTE sin lanzar', async () => {
  ;(prismaMock as any).$queryRaw.mockRejectedValueOnce(new Error('db down'))
  await expect(convergerCostoDeTransaccion('p1', { tipo: 'REST' })).rejects.toThrow('db down')
  ;(prismaMock as any).$queryRaw.mockRejectedValueOnce(new Error('db down'))
  expect(await asegurarCostoSincrono('p1')).toBe('PENDIENTE')
  expect((prismaMock as any).paymentEffect.updateMany.mock.calls.at(-1)[0].data).toEqual({ lastError: 'TRANSACTION_COST_FAILED' })
})

it('cerrar la obligación (REST) sólo toca el efecto PENDING (uno ya reclamado lo termina el worker con su token) y nunca lanza', async () => {
  await cerrarObligacionDeCosto('p1')
  expect((prismaMock as any).paymentEffect.updateMany.mock.calls[0][0].where).toEqual({
    paymentId: 'p1',
    kind: 'TRANSACTION_COST',
    status: 'PENDING',
  })
  ;(prismaMock as any).paymentEffect.updateMany.mockRejectedValueOnce(new Error('db down'))
  await expect(cerrarObligacionDeCosto('p1')).resolves.toBeUndefined()
})

it('anotar nunca lanza: un fallo al anotar no interrumpe el cobro', async () => {
  ;(prismaMock as any).paymentEffect.updateMany.mockRejectedValueOnce(new Error('db down'))
  await expect(anotarCostoNoCalculado('p1', new Error('x'))).resolves.toBeUndefined()
})

it('Codex R12-3 · un método provisional anota AWAITING_ACCREDITED_CARD_DATA (obligación con nombre, visible, sin consumir intentos)', async () => {
  await anotarCostoNoCalculado(
    'p1',
    new Error('COST_PENDING_AWAITING_ACCREDITED_CARD_DATA: payment p1 method is provisional (webhook-born)'),
  )
  expect((prismaMock as any).paymentEffect.updateMany.mock.calls[0][0].data).toEqual({ lastError: 'AWAITING_ACCREDITED_CARD_DATA' })
  expect((prismaMock as any).$executeRaw).not.toHaveBeenCalled()
})

it('Codex R12-3 · `costoListoParaCalcular`: el PLAZO ya no acredita el tipo de tarjeta — con el método provisional sigue esperando aunque el plazo haya vencido; con el método acreditado (methodProvisional=false) está listo', async () => {
  const { costoListoParaCalcular, esperaDeMarcaVencida } = await import('@/services/payments/deferredTransactionCost.service')
  const vencido = { deadlineAt: new Date(Date.now() - 60_000).toISOString() }
  expect(costoListoParaCalcular({ cardBrand: null, processorData: { methodProvisional: true } }, vencido, new Date())).toBe(false)
  expect(costoListoParaCalcular({ cardBrand: 'VISA', processorData: { methodProvisional: true } }, vencido, new Date())).toBe(false)
  expect(costoListoParaCalcular({ cardBrand: null, processorData: { methodProvisional: false } }, vencido, new Date())).toBe(true)
  expect(costoListoParaCalcular({ cardBrand: 'VISA', processorData: {} }, null, new Date())).toBe(true)
  expect(esperaDeMarcaVencida(vencido, new Date())).toBe(true)
  expect(esperaDeMarcaVencida({ deadlineAt: new Date(Date.now() + 60_000).toISOString() }, new Date())).toBe(false)
})
