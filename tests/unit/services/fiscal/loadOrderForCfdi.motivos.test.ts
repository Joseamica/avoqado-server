// D11 (videos de Facturación, 5-nov): el cargador dice POR QUÉ una venta no se puede facturar, sin cambiar lo que devuelve.
// Antes, una venta cobrada con un comercio sin configuración fiscal caía en un texto genérico que hablaba de efectivo.
import { Prisma } from '@prisma/client'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn() },
    merchantFiscalConfig: { findUnique: jest.fn() },
    merchantAccount: { findUnique: jest.fn() },
    ecommerceMerchant: { findUnique: jest.fn() },
    fiscalEmisor: { findMany: jest.fn().mockResolvedValue([]) },
    orderDiscount: { findMany: jest.fn() },
  },
}))
jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import prisma from '../../../../src/utils/prismaClient'
import { loadOrderForCfdiFromDb, type MotivoNoFacturable } from '../../../../src/services/fiscal/cfdi.service'

const D = (n: number) => new Prisma.Decimal(n)
const orderMock = prisma.order.findUnique as jest.Mock
const cfgMock = prisma.merchantFiscalConfig.findUnique as jest.Mock
const maMock = (prisma as any).merchantAccount.findUnique as jest.Mock
const ecMock = (prisma as any).ecommerceMerchant.findUnique as jest.Mock
const emisorMock = (prisma as any).fiscalEmisor.findMany as jest.Mock

const tarjeta = { method: 'CREDIT_CARD', merchantAccountId: 'm1', ecommerceMerchantId: null, amount: D(116), type: 'REGULAR' }
const transferencia = { method: 'BANK_TRANSFER', merchantAccountId: null, ecommerceMerchantId: null, amount: D(116), type: 'REGULAR' }
const efectivo = { ...transferencia, method: 'CASH' }

function anOrder(over: Record<string, any> = {}) {
  return {
    venueId: 'venueB',
    subtotal: D(100),
    taxAmount: D(16),
    total: D(116),
    tipAmount: D(0),
    discountAmount: D(0),
    venue: { slug: 'demo', type: 'RESTAURANT' },
    payments: [tarjeta],
    items: [
      {
        productName: 'X',
        quantity: 1,
        unitPrice: D(100),
        discountAmount: D(0),
        total: D(100),
        weightQuantity: null,
        modifiers: [],
        product: { satProductKey: '90101500', satUnitKey: 'E48', objetoImp: '02', taxRate: D(0.16), category: null },
      },
    ],
    ...over,
  }
}
const EMISOR = {
  id: 'e1',
  venueId: 'venueB',
  provider: 'FACTURAPI',
  providerKeyEnc: null,
  csdStatus: 'ACTIVE',
  serie: 'F',
  invoiceCashSales: false,
}
const unEmisor = (over: Record<string, any> = {}) => ({
  ...EMISOR,
  merchantConfigs: [{ facturacionEnabled: true, autofacturaEnabled: true }],
  ...over,
})

/** Carga con `explicar` y regresa lo que devolvió el cargador y el motivo que dio. */
async function cargar(opts: { permitirEfectivo?: boolean } = { permitirEfectivo: true }) {
  let motivo: MotivoNoFacturable | undefined
  const bundle = await loadOrderForCfdiFromDb('o1', { ...opts, explicar: m => (motivo = m) })
  return { bundle, motivo }
}

const sinEfectivo = (m?: MotivoNoFacturable) => expect(m?.texto ?? '').not.toMatch(/efectivo/i)

beforeEach(() => {
  jest.clearAllMocks()
  emisorMock.mockResolvedValue([])
})

describe('loadOrderForCfdiFromDb · por qué no se factura (D11)', () => {
  it('🔴 el caso del video: cobro con un comercio SIN configuración fiscal ⇒ lo dice con su nombre y dónde se arregla, sin efectivo', async () => {
    orderMock.mockResolvedValue(anOrder())
    cfgMock.mockResolvedValue(null)
    maMock.mockResolvedValue({ displayName: 'Terminal mostrador', alias: null })
    const { bundle, motivo } = await cargar()
    expect(bundle).toBeNull()
    expect(motivo?.code).toBe('COMERCIO_SIN_CONFIGURAR')
    expect(motivo?.texto).toContain('«Terminal mostrador»')
    expect(motivo?.texto).toContain('Facturación › Configuración')
    sinEfectivo(motivo)
  })

  it('comercio en línea sin configuración ⇒ usa el nombre del canal', async () => {
    orderMock.mockResolvedValue(anOrder({ payments: [{ ...tarjeta, merchantAccountId: null, ecommerceMerchantId: 'ec1' }] }))
    cfgMock.mockResolvedValue(null)
    ecMock.mockResolvedValue({ channelName: 'Web Principal' })
    const { motivo } = await cargar()
    expect(motivo?.code).toBe('COMERCIO_SIN_CONFIGURAR')
    expect(motivo?.texto).toContain('«Web Principal»')
  })

  it('comercio con la facturación APAGADA ⇒ el bundle sale igual (403 de siempre) y el motivo lo nombra', async () => {
    orderMock.mockResolvedValue(anOrder())
    cfgMock.mockResolvedValue({ facturacionEnabled: false, autofacturaEnabled: false, fiscalEmisor: EMISOR })
    maMock.mockResolvedValue({ displayName: null, alias: 'PAX 1' })
    const { bundle, motivo } = await cargar()
    expect(bundle).not.toBeNull()
    expect(bundle!.facturacionEnabled).toBe(false)
    expect(motivo?.code).toBe('FACTURACION_APAGADA')
    expect(motivo?.texto).toContain('«PAX 1»')
    sinEfectivo(motivo)
  })

  it('el RFC del comercio es de otra sucursal ⇒ motivo propio', async () => {
    orderMock.mockResolvedValue(anOrder())
    cfgMock.mockResolvedValue({ facturacionEnabled: true, autofacturaEnabled: false, fiscalEmisor: { ...EMISOR, venueId: 'venueA' } })
    const { bundle, motivo } = await cargar()
    expect(bundle).toBeNull()
    expect(motivo?.code).toBe('RFC_DE_OTRA_SUCURSAL')
  })

  it('la venta no existe ⇒ VENTA_NO_ENCONTRADA', async () => {
    orderMock.mockResolvedValue(null)
    expect((await cargar()).motivo?.code).toBe('VENTA_NO_ENCONTRADA')
  })

  it('sin ningún cobro completado ⇒ SIN_COBRO', async () => {
    orderMock.mockResolvedValue(anOrder({ payments: [] }))
    expect((await cargar()).motivo?.code).toBe('SIN_COBRO')
  })

  describe('venta sin terminal', () => {
    it('el negocio sin RFC ⇒ SIN_EMISOR', async () => {
      orderMock.mockResolvedValue(anOrder({ payments: [transferencia] }))
      const { motivo } = await cargar()
      expect(motivo?.code).toBe('SIN_EMISOR')
      sinEfectivo(motivo)
    })

    it('dos RFC ⇒ VARIOS_RFC, sin hablar de efectivo', async () => {
      orderMock.mockResolvedValue(anOrder({ payments: [efectivo] }))
      emisorMock.mockResolvedValue([unEmisor(), unEmisor({ id: 'e2' })])
      const { motivo } = await cargar()
      expect(motivo?.code).toBe('VARIOS_RFC')
      sinEfectivo(motivo)
    })

    it('un tipo de pago sin dueño fiscal (vales, plataformas) ⇒ PAGO_SIN_RFC', async () => {
      orderMock.mockResolvedValue(anOrder({ payments: [{ ...transferencia, method: 'OTHER' }] }))
      emisorMock.mockResolvedValue([unEmisor()])
      expect((await cargar()).motivo?.code).toBe('PAGO_SIN_RFC')
    })

    it('autofactura con efectivo y el interruptor apagado ⇒ motivo que nunca habla de efectivo', async () => {
      orderMock.mockResolvedValue(anOrder({ payments: [efectivo] }))
      emisorMock.mockResolvedValue([unEmisor()])
      const { bundle, motivo } = await cargar({})
      expect(bundle).toBeNull()
      expect(motivo?.code).toBe('AUTOFACTURA_NO_DISPONIBLE')
      sinEfectivo(motivo)
    })

    it('el RFC tiene comercios pero todos apagados ⇒ SIN_COMERCIO_ENCENDIDO', async () => {
      orderMock.mockResolvedValue(anOrder({ payments: [transferencia] }))
      emisorMock.mockResolvedValue([unEmisor({ merchantConfigs: [{ facturacionEnabled: false, autofacturaEnabled: false }] })])
      const { bundle, motivo } = await cargar()
      expect(bundle!.facturacionEnabled).toBe(false)
      expect(motivo?.code).toBe('SIN_COMERCIO_ENCENDIDO')
      sinEfectivo(motivo)
    })

    // D11 opción A (founder, 5-nov): «el RFC basta». Un RFC con CSD y NINGÚN comercio ligado factura sus ventas sin terminal desde el panel;
    // la autofactura del cliente sigue apagada (no hay dónde prenderla). Aplica aunque el negocio tenga comercios SIN ligar a un RFC.
    it.each([
      ['efectivo', efectivo],
      ['transferencia', transferencia],
      ['tarjeta de otra terminal', { ...transferencia, method: 'CREDIT_CARD' }],
    ])('A: RFC sin ningún comercio ligado ⇒ el personal factura (%s), sin motivo; autofactura apagada', async (_n, pago) => {
      orderMock.mockResolvedValue(anOrder({ payments: [pago] }))
      emisorMock.mockResolvedValue([unEmisor({ merchantConfigs: [] })])
      const { bundle, motivo } = await cargar()
      expect(bundle!.facturacionEnabled).toBe(true)
      expect(bundle!.autofacturaEnabled).toBe(false)
      expect(motivo).toBeUndefined()
    })

    it('A: la autofactura del cliente de esa venta (efectivo con el interruptor del RFC encendido) sigue sin ofrecerse', async () => {
      orderMock.mockResolvedValue(anOrder({ payments: [efectivo] }))
      emisorMock.mockResolvedValue([unEmisor({ merchantConfigs: [], invoiceCashSales: true })])
      const bundle = await loadOrderForCfdiFromDb('o1')
      expect(bundle!.facturacionEnabled).toBe(true)
      expect(bundle!.autofacturaEnabled).toBe(false)
    })

    it('A: con comercios ligados TODOS apagados la regla no cambia ⇒ apagada y SIN_COMERCIO_ENCENDIDO', async () => {
      orderMock.mockResolvedValue(anOrder({ payments: [efectivo] }))
      emisorMock.mockResolvedValue([unEmisor({ merchantConfigs: [{ facturacionEnabled: false, autofacturaEnabled: true }] })])
      const { bundle, motivo } = await cargar()
      expect(bundle!.facturacionEnabled).toBe(false)
      expect(motivo?.code).toBe('SIN_COMERCIO_ENCENDIDO')
    })

    it('A: dos RFC sin comercios ⇒ sigue VARIOS_RFC', async () => {
      orderMock.mockResolvedValue(anOrder({ payments: [efectivo] }))
      emisorMock.mockResolvedValue([unEmisor({ merchantConfigs: [] }), unEmisor({ id: 'e2', merchantConfigs: [] })])
      const { bundle, motivo } = await cargar()
      expect(bundle).toBeNull()
      expect(motivo?.code).toBe('VARIOS_RFC')
    })
  })

  it('Codex r1 #2: OTRO comercio de la cuenta sin configuración ⇒ el bundle sale igual (422 de siempre) y el motivo lo nombra', async () => {
    orderMock.mockResolvedValue(anOrder({ payments: [tarjeta, { ...tarjeta, merchantAccountId: 'm2', amount: D(10) }] }))
    cfgMock.mockImplementation(async (q: any) =>
      q.where.merchantAccountId === 'm1' ? { facturacionEnabled: true, autofacturaEnabled: false, fiscalEmisor: EMISOR } : null,
    )
    maMock.mockResolvedValue({ displayName: 'Nexgo barra', alias: null })
    const { bundle, motivo } = await cargar()
    expect(bundle!.facturacionEnabled).toBe(true)
    // Codex r3 #1: el 422 de «Facturar» dice lo mismo que el aviso previo.
    expect(bundle!.unsupportedReasons).toContain(motivo!.texto)
    expect(motivo!.texto).not.toMatch(/efectivo/i)
    expect(motivo?.code).toBe('COMERCIO_SIN_CONFIGURAR')
    expect(motivo?.texto).toContain('«Nexgo barra»')
    expect(maMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'm2' } }))
  })

  it('Codex r1 #2: OTRO comercio de RFC distinto ⇒ COMERCIOS_DE_RFC_DISTINTO', async () => {
    orderMock.mockResolvedValue(anOrder({ payments: [tarjeta, { ...tarjeta, merchantAccountId: 'm2', amount: D(10) }] }))
    cfgMock.mockImplementation(async (q: any) =>
      q.where.merchantAccountId === 'm1'
        ? { facturacionEnabled: true, autofacturaEnabled: false, fiscalEmisor: EMISOR }
        : { facturacionEnabled: true, autofacturaEnabled: false, fiscalEmisor: { id: 'e2' } },
    )
    expect((await cargar()).motivo?.code).toBe('COMERCIOS_DE_RFC_DISTINTO')
  })

  it('REGRESIÓN: una venta facturable no da motivo, y sin `explicar` no se busca el nombre del comercio', async () => {
    orderMock.mockResolvedValue(anOrder())
    cfgMock.mockResolvedValue({ facturacionEnabled: true, autofacturaEnabled: false, fiscalEmisor: EMISOR })
    const { bundle, motivo } = await cargar()
    expect(bundle).not.toBeNull()
    expect(motivo).toBeUndefined()
    cfgMock.mockResolvedValue(null)
    expect(await loadOrderForCfdiFromDb('o1')).toBeNull()
    expect(maMock).not.toHaveBeenCalled()
  })
})
