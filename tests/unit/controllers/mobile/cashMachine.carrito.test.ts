/**
 * Máquina de efectivo · Codex servidor r2 #11 (familia C): EL lector del carrito de la máquina (`leerCarritoDeLaMaquina`). La cotización,
 * la venta, la duda y la resolución del gerente lo usan todas, así que un carrito que la cotización excluye (premio de sellos pendiente)
 * también queda excluido al registrarlo o resolverlo.
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
import { huellaDelCarrito } from '@/services/cashMachine/ventaDeLaMaquina'

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

  it('devuelve la huella de los artículos', async () => {
    const r = await carrito.leerCarritoDeLaMaquina(req(CARRITO), CARRITO, {
      venueId: VENUE,
      usuario: 'u1',
      conPropinaDeOrden: false,
      conAutoridad: false,
    })
    expect(r.huella).toBe(huellaDelCarrito(CARRITO))
    expect(r.input.stampRewardId).toBeNull()
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

  it('vender: el MISMO premio llega al registro (y el servicio contesta 202 PREMIO_PENDIENTE)', async () => {
    const next = jest.fn()
    await registrarVenta(req({ referenceCC: 'AQ0123456789AB', cierre: {}, pedido: CON_PREMIO }), res(), next)
    expect(next).not.toHaveBeenCalled()
    expect(espia).toHaveBeenCalledWith(expect.anything(), CON_PREMIO, expect.objectContaining({ conPropinaDeOrden: false }))
    expect(mockRegistrar.mock.calls[0][2].pedido).toMatchObject({ stampRewardId: 'premio-1' })
  })

  it('subir la duda valida el carrito con el mismo lector', async () => {
    await subirDuda(req({ referenceCC: 'AQ0123456789AB', pedido: CON_PREMIO }), res(), jest.fn())
    expect(espia).toHaveBeenCalledWith(expect.anything(), CON_PREMIO, expect.objectContaining({ conAutoridad: false }))
  })

  it('resolver: el gerente arma el carrito congelado con el mismo lector (el premio sigue ahí)', async () => {
    await resolverDuda(
      req({ outcome: 'PAGADO', creditCents: 20000, changeDispensedCents: 1250, evidence: 'x' }, { referenceCC: 'AQ0123456789AB' }),
      res(),
      jest.fn(),
    )
    expect(espia).toHaveBeenCalledWith(expect.anything(), CON_PREMIO, expect.objectContaining({ usuario: 'cajera', conAutoridad: true }))
    const armado = await espia.mock.results.at(-1)!.value
    expect(armado.input.stampRewardId).toBe('premio-1')
  })
})
