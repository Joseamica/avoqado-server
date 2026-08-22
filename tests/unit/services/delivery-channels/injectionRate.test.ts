/**
 * La tasa de inyección: el número con el que Uber decide si te deja seguir integrado.
 *
 * 🔴 Uber exige 99.9% y por debajo de 99% "can be subject to revoked API access and/or
 * removal or disabling of restaurant stores". No es un indicador de calidad: es el
 * interruptor de apagado. Con 1000 pedidos al mes, el margen entre el 100% y la revocación
 * son DIEZ pedidos.
 */
jest.mock('@/services/delivery-channels/core/adapterRegistry', () => ({
  hasAdapter: jest.fn(() => true),
  // El núcleo NO conoce los nombres de evento del proveedor: se los pide al adaptador.
  adapterFor: jest.fn(() => ({ orderEventTypes: () => ['orders.notification', 'orders.scheduled.notification'] })),
}))

import { DeliveryProvider } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { hasAdapter } from '@/services/delivery-channels/core/adapterRegistry'
import { calcularTasaInyeccion, UMBRAL_OBJETIVO, UMBRAL_REVOCACION } from '@/services/delivery-channels/core/injectionRate.service'

const mockCount = (prisma as any).deliveryOrderEvent.count as jest.Mock
const mockFind = (prisma as any).deliveryOrderEvent.findMany as jest.Mock

/** El servicio hace count(recibidos), count(aceptados) y findMany(fallidos) en paralelo. */
const conDatos = (recibidos: number, aceptados: number, fallidos: unknown[] = []) => {
  mockCount.mockResolvedValueOnce(recibidos).mockResolvedValueOnce(aceptados)
  mockFind.mockResolvedValueOnce(fallidos)
}

describe('tasa de inyección', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 SIN pedidos NO reporta 0%: reporta SIN_DATOS', async () => {
    // Reportar 0% cuando no llegó nada dispararía alarma en cada negocio que todavía no
    // vende por ahí — y las alarmas falsas enseñan a la gente a ignorarlas, justo antes de
    // la que sí importa.
    conDatos(0, 0)
    const t = await calcularTasaInyeccion({ provider: DeliveryProvider.UBER_EATS })

    expect(t.estado).toBe('SIN_DATOS')
    expect(t.porcentaje).toBeNull()
  })

  it('todo aceptado ⇒ 100% y OK', async () => {
    conDatos(200, 200)
    const t = await calcularTasaInyeccion({ provider: DeliveryProvider.UBER_EATS })
    expect(t.porcentaje).toBe(100)
    expect(t.estado).toBe('OK')
  })

  it(`🔴 debajo de ${UMBRAL_REVOCACION}% es CRÍTICO: es el umbral de REVOCACIÓN`, async () => {
    conDatos(100, 98) // 98%
    const t = await calcularTasaInyeccion({ provider: DeliveryProvider.UBER_EATS })
    expect(t.porcentaje).toBe(98)
    expect(t.estado).toBe('CRITICO')
  })

  it(`entre ${UMBRAL_REVOCACION}% y ${UMBRAL_OBJETIVO}% es ALERTA: todavía hay margen para reaccionar`, async () => {
    conDatos(1000, 995) // 99.5%
    const t = await calcularTasaInyeccion({ provider: DeliveryProvider.UBER_EATS })
    expect(t.porcentaje).toBe(99.5)
    expect(t.estado).toBe('ALERTA')
  })

  it('🔴 devuelve los MOTIVOS de los que fallaron, no sólo el número', async () => {
    // Saber que va mal sin saber por qué obliga a investigar desde cero justo cuando hay
    // prisa. El motivo es la diferencia entre una alarma y una acción.
    conDatos(10, 8, [
      { externalOrderId: 'abc', error: 'PEDIDO_YA_NO_ACTIVO', receivedAt: new Date() },
      { externalOrderId: 'def', error: 'INSTRUCCIONES_NO_TRANSMITIDAS', receivedAt: new Date() },
    ])
    const t = await calcularTasaInyeccion({ provider: DeliveryProvider.UBER_EATS })

    expect(t.fallidos.map(f => f.motivo)).toEqual(['PEDIDO_YA_NO_ACTIVO', 'INSTRUCCIONES_NO_TRANSMITIDAS'])
  })

  it('🔴 sólo cuenta avisos de PEDIDO, y los nombres los da el ADAPTADOR', async () => {
    // Dos cosas en una:
    //  · Un cambio de estado de tienda no es un pedido que se pudo aceptar o no. Meterlo
    //    diluiría la tasa hasta volverla mentira: 500 eventos de tienda harían parecer sano
    //    un canal que está rechazando la mitad de sus pedidos.
    //  · Los NOMBRES no se escriben en el núcleo. El guardrail de `adapterRegistry.test.ts`
    //    lo prohíbe y me atrapó escribiendo 'orders.notification' aquí — el mismo error que
    //    ya causó tres bugs en este módulo.
    conDatos(50, 50)
    await calcularTasaInyeccion({ provider: DeliveryProvider.UBER_EATS })

    expect(mockCount.mock.calls[0][0].where.eventType).toEqual({
      in: ['orders.notification', 'orders.scheduled.notification'],
    })
  })

  it('un proveedor SIN adaptador no tiene tasa: devolver 0% sería alarma falsa', async () => {
    ;(hasAdapter as jest.Mock).mockReturnValueOnce(false)
    const t = await calcularTasaInyeccion({ provider: DeliveryProvider.DELIVERECT })

    expect(t.estado).toBe('SIN_DATOS')
    expect(mockCount).not.toHaveBeenCalled()
  })

  it('🔴 "aceptado" exige que exista la VENTA, no sólo que el evento diga PROCESSED', async () => {
    // Un evento marcado procesado sin `orderId` no produjo nada que la cocina pudiera
    // preparar. Contarlo como aceptado inflaría la tasa justo en los casos que Uber
    // considera fallidos.
    conDatos(10, 10)
    await calcularTasaInyeccion({ provider: DeliveryProvider.UBER_EATS })

    expect(mockCount.mock.calls[1][0].where.orderId).toEqual({ not: null })
  })
})
