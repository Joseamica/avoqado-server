/**
 * Controlador de `/pay-out`: (H2) la llave y lo guardado salen del MISMO número de centavos; (H12) con autorizador
 * (PIN de gerente) el concepto es obligatorio en el servidor; sin autorizador sigue opcional (apps viejas de gerentes).
 */
const mockPayOut = jest.fn()
jest.mock('@/services/mobile/cash-drawer.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/cash-drawer.mobile.service'),
  payOut: (...a: unknown[]) => mockPayOut(...a),
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { payOut } from '@/controllers/mobile/cash-drawer.mobile.controller'
import { ponerLlaveDelRetiro } from '@/lib/llaveDelRetiro'

async function llamar(body: Record<string, unknown>, overrideAuthorizedBy?: string) {
  const req: any = {
    params: { venueId: 'v1' },
    body,
    authContext: { userId: 'u1', venueId: 'v1', ...(overrideAuthorizedBy ? { overrideAuthorizedBy } : {}) },
  }
  const out: { status?: number; json?: any; err?: any } = {}
  const res: any = { status: (s: number) => ((out.status = s), res), json: (j: unknown) => ((out.json = j), res) }
  await payOut(req, res, (e?: unknown) => {
    out.err = e
  })
  return { out, req }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPayOut.mockResolvedValue({ event: { id: 'e1' }, created: true, authorizedBy: null })
})

describe('H2 · el importe se canoniza una vez', () => {
  it('2.675 con la llave atada :268 guarda 2.68, no 2.67', async () => {
    const llave: any = { body: { localId: 'x', amount: 2.675 } }
    ponerLlaveDelRetiro(llave, {} as any, () => {})
    expect(llave.llaveDeOperacion).toBe('pay-out:x:268')
    await llamar({ localId: 'x', amount: 2.675 })
    expect(mockPayOut.mock.calls[0][0].amount).toBe(2.68)
  })

  it("'26.75' guarda 26.75 y la llave dice :2675", async () => {
    const llave: any = { body: { localId: 'x', amount: '26.75' } }
    ponerLlaveDelRetiro(llave, {} as any, () => {})
    expect(llave.llaveDeOperacion).toBe('pay-out:x:2675')
    await llamar({ localId: 'x', amount: '26.75' })
    expect(mockPayOut.mock.calls[0][0].amount).toBe(26.75)
  })
})

describe('H12 · concepto con autorizador', () => {
  it('cajero con atada válida y nota en blanco ⇒ 400 CONCEPTO_REQUERIDO y nada se crea', async () => {
    const { out } = await llamar({ localId: 'x', amount: 50, note: '  ' }, 'sv-gerente')
    expect(out.err).toMatchObject({ statusCode: 400, code: 'CONCEPTO_REQUERIDO', message: 'El retiro necesita un concepto.' })
    expect(mockPayOut).not.toHaveBeenCalled()
  })

  it('con autorizador y sin nota ⇒ 400 también', async () => {
    const { out } = await llamar({ localId: 'x', amount: 50 }, 'sv-gerente')
    expect(out.err).toMatchObject({ code: 'CONCEPTO_REQUERIDO' })
    expect(mockPayOut).not.toHaveBeenCalled()
  })

  it("con autorizador y note 'Bajada' ⇒ 201", async () => {
    const { out } = await llamar({ localId: 'x', amount: 50, note: 'Bajada' }, 'sv-gerente')
    expect(out.status).toBe(201)
    expect(mockPayOut).toHaveBeenCalledTimes(1)
  })

  it('gerente con su sesión (sin autorizador) y sin nota ⇒ 201 como hoy', async () => {
    const { out } = await llamar({ localId: 'x', amount: 50 })
    expect(out.status).toBe(201)
    expect(mockPayOut).toHaveBeenCalledTimes(1)
  })
})
