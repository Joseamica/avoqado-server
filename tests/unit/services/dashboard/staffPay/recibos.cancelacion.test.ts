import { prismaMock } from '@tests/__helpers__/setup'
import { getContext, runWithContext, type RequestCancellation } from '@/observability/executionContext'
import { checkCancellation, RequestCancelledError } from '@/utils/requestCancellation'
import { enUnaFoto } from '@/services/dashboard/staffPay/recibos.service'

/** Como la extensión real de Prisma: la operación es PEREZOSA y pasa por el freno al arrancar (`.then`). */
const perezosa = (operacion: string, args?: unknown) => ({
  then(ok: (v: unknown) => void, ko: (e: unknown) => void) {
    try {
      checkCancellation(operacion, getContext()?.cancellation, args)
      ok(operacion === '$executeRaw' ? 0 : [])
    } catch (e) {
      ko(e)
    }
  },
})

describe('enUnaFoto y el freno de lecturas del MCP (Codex R4-Nuevo 2)', () => {
  it('el SET TRANSACTION READ ONLY no cuenta como escritura: cancelar después del SET corta la siguiente lectura', async () => {
    const controller = new AbortController()
    const c: RequestCancellation = { signal: controller.signal, hasWritten: false, refused: false }
    const tx = {
      $executeRaw: () => perezosa('$executeRaw'),
      $queryRaw: () => perezosa('$queryRaw', { strings: ['SELECT 1'], values: [] }),
    }
    prismaMock.$transaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
    const contexto = {
      correlationId: 'c-1',
      source: 'http' as const,
      entrypoint: 'POST /mcp tools/call staff_service_pay_detail',
      cancellation: c,
    }
    const lectura = runWithContext(contexto, () =>
      enUnaFoto(async t => {
        controller.abort(new RequestCancelledError('client-closed')) // el cliente se va DESPUÉS del SET
        return (t as unknown as { $queryRaw: () => PromiseLike<unknown> }).$queryRaw()
      }),
    )
    await expect(lectura).rejects.toBeInstanceOf(RequestCancelledError)
    expect(c.hasWritten).toBe(false)
  })
})
