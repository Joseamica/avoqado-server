/**
 * Máquina de efectivo · Codex servidor r2 #11 (familia C): EL lector del carrito de la máquina (`leerCarritoDeLaMaquina`). La cotización
 * lo usa al cotizar y quien TERMINA un folio (la venta, la duda y la resolución del gerente) lo usa con el carrito congelado, así que un
 * carrito que la cotización excluye (premio de sellos pendiente) también queda excluido al registrarlo o resolverlo. Rediseño r3 (D1):
 * los controladores ya no leen el carrito antes de guardar la evidencia: le pasan al servicio el carrito tal cual y el lector.
 */
const mockCotizar = jest.fn()
const mockRegistrar = jest.fn()
const mockSubirDuda = jest.fn()
const mockResolver = jest.fn()

jest.mock('@/services/cashMachine/cotizacionDeLaMaquina', () => ({
  cotizarParaLaMaquina: (...a: unknown[]) => mockCotizar(...a),
}))
jest.mock('@/services/cashMachine/ventaDeLaMaquina', () => ({
  ...jest.requireActual('@/services/cashMachine/ventaDeLaMaquina'),
  registrarVentaDeLaMaquina: (...a: unknown[]) => mockRegistrar(...a),
}))
jest.mock('@/services/cashMachine/dudasDeLaMaquina', () => ({
  ...jest.requireActual('@/services/cashMachine/dudasDeLaMaquina'),
  subirDudaDeLaMaquina: (...a: unknown[]) => mockSubirDuda(...a),
  resolverDudaDeLaMaquina: (...a: unknown[]) => mockResolver(...a),
}))

import * as carrito from '@/controllers/mobile/carritoDeLaMaquina'
import { cotizar, registrarVenta, resolverDuda, subirDuda } from '@/controllers/mobile/cashMachine.mobile.controller'

const VENUE = 'cjld2cjxh0000qzrmn831i7rn'
const CARRITO = { items: [{ name: 'Pastel', quantity: 1, unitPrice: 18750 }], orderType: 'TAKEOUT', source: 'AVOQADO_ANDROID' }
/** Una caja vieja que no declara `stampRewardAware`: la venta de mostrador ignoraría el premio. */
const CON_PREMIO = { ...CARRITO, stampRewardId: 'premio-1' }

const req = (body: unknown, params: Record<string, string> = {}) =>
  ({
    params: { venueId: VENUE, ...params },
    body,
    headers: { 'x-device-id': 'uid-pc-1', 'x-device-platform': 'DESKTOP' },
    authContext: { userId: 'u1', venueId: VENUE, role: 'CASHIER' },
  }) as any
const res = () => {
  const r: any = { status: jest.fn(() => r), json: jest.fn(() => r) }
  return r
}

describe('leerCarritoDeLaMaquina', () => {
  it('🔴 conserva el premio de sellos pendiente aunque la caja no declare stampRewardAware (la venta de mostrador lo vuelve null)', async () => {
    const { input } = await carrito.leerCarritoDeLaMaquina(req(CON_PREMIO), CON_PREMIO, {
      venueId: VENUE,
      usuario: 'u1',
      conPropinaDeOrden: false,
      conAutoridad: true,
    })
    expect(input.stampRewardId).toBe('premio-1')
  })

  it('un carrito inválido es 400, como POST /orders', async () => {
    await expect(
      carrito.leerCarritoDeLaMaquina(
        req({ items: [] }),
        { items: [] },
        { venueId: VENUE, usuario: 'u1', conPropinaDeOrden: false, conAutoridad: true },
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('🔴 r2 #11: la cotización, la venta, la duda y la resolución leen el carrito con EL MISMO lector', () => {
  let espia: jest.SpyInstance
  beforeEach(() => {
    jest.clearAllMocks()
    espia = jest.spyOn(carrito, 'leerCarritoDeLaMaquina')
    mockCotizar.mockResolvedValue({ cobrableEnMaquina: false, motivo: 'PREMIO_PENDIENTE' })
    mockRegistrar.mockResolvedValue({ status: 202, body: { motivo: 'PREMIO_PENDIENTE' } })
    mockSubirDuda.mockResolvedValue({ status: 'ABIERTO' })
    mockResolver.mockImplementation(
      async (_v: string, _g: string, _r: string, _x: unknown, armar: (p: unknown, s: string) => Promise<unknown>) => {
        await armar(CON_PREMIO, 'cajera')
        return { status: 202, body: {} }
      },
    )
  })
  afterEach(() => espia.mockRestore())

  it('cotizar: el premio llega al servicio (PREMIO_PENDIENTE)', async () => {
    const next = jest.fn()
    await cotizar(req(CON_PREMIO), res(), next)
    expect(next).not.toHaveBeenCalled()
    expect(espia).toHaveBeenCalledWith(expect.anything(), CON_PREMIO, expect.objectContaining({ conPropinaDeOrden: true }))
    expect(mockCotizar.mock.calls[0][1]).toMatchObject({ stampRewardId: 'premio-1', isOfflineReplay: false })
  })

  it('🔴 vender: el carrito llega TAL CUAL al servicio, y el lector que le pasa conserva el MISMO premio (D1)', async () => {
    const next = jest.fn()
    await registrarVenta(req({ referenceCC: 'AQ0123456789AB', cierre: {}, pedido: CON_PREMIO }), res(), next)
    expect(next).not.toHaveBeenCalled()
    expect(espia).not.toHaveBeenCalled() // la evidencia se guarda ANTES de leer el carrito
    expect(mockRegistrar.mock.calls[0][2].pedido).toBe(CON_PREMIO)
    const leido = await mockRegistrar.mock.calls[0][3](CON_PREMIO, 'cajera')
    expect(espia).toHaveBeenCalledWith(
      expect.anything(),
      CON_PREMIO,
      expect.objectContaining({ conPropinaDeOrden: false, conAutoridad: true }),
    )
    expect(leido).toMatchObject({ stampRewardId: 'premio-1' })
  })

  it('🔴 r6-2: subir la duda NO valida el carrito antes de guardarla (uno ilegible no es 400); el lector va al servicio', async () => {
    const next = jest.fn()
    await subirDuda(req({ referenceCC: 'AQ0123456789AB', pedido: {} }), res(), next)
    expect(next).not.toHaveBeenCalled()
    expect(espia).not.toHaveBeenCalled()
    expect(mockSubirDuda.mock.calls[0][2].pedido).toEqual({})
    expect(typeof mockSubirDuda.mock.calls[0][3]).toBe('function')
  })

  it('resolver: el gerente arma el carrito congelado con el mismo lector (el premio sigue ahí)', async () => {
    await resolverDuda(
      req(
        { outcome: 'PAGADO', creditCents: 20000, changeDispensedCents: 1250, evidence: 'x', version: 1 },
        { referenceCC: 'AQ0123456789AB' },
      ),
      res(),
      jest.fn(),
    )
    expect(espia).toHaveBeenCalledWith(expect.anything(), CON_PREMIO, expect.objectContaining({ usuario: 'cajera', conAutoridad: true }))
    const armado = await espia.mock.results.at(-1)!.value
    expect(armado.input.stampRewardId).toBe('premio-1')
    expect(mockResolver.mock.calls[0][3]).toMatchObject({ version: 1 })
  })
})
