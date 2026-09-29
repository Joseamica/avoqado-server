/**
 * 🔴 DINERO FISCAL — la regla única de una devolución (`ivaDeDevolucion`) y, desde el plan 4b, el saldo en libros y el
 * reparto que se congela, por tratamiento.
 */
import logger from '@/config/logger'
import { congelarPorTratamiento, enLibrosPorTratamiento, ivaDeDevolucion } from '../../../../src/services/fiscal/deliveryFiscalDelta'
import type { MezclaPorTratamiento } from '../../../../src/services/fiscal/ivaMath'

describe('ivaDeDevolucion — el 🚨 sólo lo da la póliza', () => {
  const mezcla: MezclaPorTratamiento = [{ tratamiento: 'IVA_16', tasa: 0.16, grossCents: 10000 }]
  const malformado = { provenance: 'PROVIDER_ADJUSTMENT', fiscalByRateCents: 'x' }
  const fueraDeRango = { provenance: 'PROVIDER_ADJUSTMENT', fiscalByRateCents: { '0.16': -1 } }
  beforeEach(() => jest.clearAllMocks())

  it('por defecto (autoPosting) grita con el id y usa la mezcla de la orden', () => {
    expect(ivaDeDevolucion('pay-1', 5000, malformado, mezcla).taxCents).toBe(690)
    expect(ivaDeDevolucion('pay-2', 5000, fueraDeRango, mezcla).taxCents).toBe(690)
    expect((logger.error as jest.Mock).mock.calls.map(([m]) => String(m))).toEqual([
      expect.stringMatching(/🚨.*pay-1/),
      expect.stringMatching(/🚨.*pay-2/),
    ])
  })

  it('en modo silencioso (estado de resultados) da la MISMA cifra sin gritar', () => {
    expect(ivaDeDevolucion('pay-1', 5000, malformado, mezcla, { avisar: false }).taxCents).toBe(690)
    expect(ivaDeDevolucion('pay-2', 5000, fueraDeRango, mezcla, { avisar: false }).taxCents).toBe(690)
    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe('plan 4b · ivaDeDevolucion lee las DOS formas del mapa congelado', () => {
  const mezcla: MezclaPorTratamiento = [
    { tratamiento: 'IVA_16', tasa: 0.16, grossCents: 10000 },
    { tratamiento: 'IVA_0', tasa: 0, grossCents: 10000 },
  ]
  beforeEach(() => jest.clearAllMocks())

  it('manual: la mezcla ACTUAL de la orden, por tratamiento', () => {
    expect(ivaDeDevolucion('m', 10000, { provenance: 'MANUAL' }, mezcla)).toEqual({
      netCents: 9310,
      taxCents: 690,
      taxByRate: { '0.16': 690 },
      porTratamiento: { IVA_16: { baseCents: 4310, ivaCents: 690 }, IVA_0: { baseCents: 5000, ivaCents: 0 } },
    })
  })

  it('forma vieja (llaves de tasa, sólo IVA): la cifra de hoy; toda la base va a IVA_16 (Ruling 4b-R3)', () => {
    expect(ivaDeDevolucion('v', 10000, { provenance: 'PROVIDER_ADJUSTMENT', fiscalByRateCents: { '0.16': 1379 } }, mezcla)).toEqual({
      netCents: 8621,
      taxCents: 1379,
      taxByRate: { '0.16': 1379 },
      porTratamiento: { IVA_16: { baseCents: 8621, ivaCents: 1379 } },
    })
    expect(ivaDeDevolucion('v0', 5000, { provenance: 'PROVIDER_ADJUSTMENT', fiscalByRateCents: {} }, mezcla).porTratamiento).toEqual({
      IVA_16: { baseCents: 5000, ivaCents: 0 },
    })
    expect(
      ivaDeDevolucion('v8', 10800, { provenance: 'PROVIDER_ADJUSTMENT', fiscalByRateCents: { '0.08': 800 } }, mezcla).porTratamiento,
    ).toEqual({
      IVA_16: { baseCents: 10000, ivaCents: 0 },
      IVA_8: { baseCents: 0, ivaCents: 800 },
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('forma nueva (v2): ESE reparto, base e IVA por tratamiento', () => {
    const porTratamiento = { IVA_16: { baseCents: 4310, ivaCents: 690 }, EXENTO: { baseCents: 5000, ivaCents: 0 } }
    expect(ivaDeDevolucion('n', 10000, { provenance: 'PROVIDER_ADJUSTMENT', fiscalByRateCents: { v: 2, porTratamiento } }, mezcla)).toEqual(
      {
        netCents: 9310,
        taxCents: 690,
        taxByRate: { '0.16': 690 },
        porTratamiento,
      },
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it.each([
    ['base + IVA no suma la venta devuelta', { v: 2, porTratamiento: { IVA_16: { baseCents: 4310, ivaCents: 690 } } }],
    ['tratamiento sin tasa de catálogo (BLOQUEADO)', { v: 2, porTratamiento: { BLOQUEADO_03: { baseCents: 9310, ivaCents: 690 } } }],
    ['montos no enteros', { v: 2, porTratamiento: { IVA_16: { baseCents: 9309.5, ivaCents: 690.5 } } }],
    ['IVA negativo', { v: 2, porTratamiento: { IVA_16: { baseCents: 10001, ivaCents: -1 } } }],
    // Un tratamiento sin tasa no causa IVA: con IVA, `tasasDe` inventaría la llave "0" que el contrato dice que nunca aparece.
    ['tasa 0 con IVA', { v: 2, porTratamiento: { IVA_0: { baseCents: 9310, ivaCents: 690 } } }],
    ['exento con IVA', { v: 2, porTratamiento: { EXENTO: { baseCents: 9310, ivaCents: 690 } } }],
    ['no objeto con IVA', { v: 2, porTratamiento: { NO_OBJETO: { baseCents: 9310, ivaCents: 690 } } }],
    // Una versión que este servidor no conoce no se lee como un mapa viejo de tasas (su `v` contaría como IVA).
    ['versión desconocida', { v: 3, '0.16': 690 }],
  ])('forma nueva inválida (%s): 🚨 con el id y la mezcla de la orden', (_caso, f) => {
    expect(ivaDeDevolucion('bad', 10000, { provenance: 'PROVIDER_ADJUSTMENT', fiscalByRateCents: f }, mezcla).taxCents).toBe(690)
    expect((logger.error as jest.Mock).mock.calls.map(([m]) => String(m))).toEqual([expect.stringMatching(/🚨.*bad/)])
  })
})

describe('plan 4b · el mapa que se congela en un ajuste nuevo', () => {
  it('con todo al 16 %, la base es la venta devuelta menos el IVA (lo que la forma vieja daba implícito)', () => {
    expect(congelarPorTratamiento({ IVA_16: { baseCents: 2, ivaCents: 0 } }, 1)).toEqual({
      v: 2,
      porTratamiento: { IVA_16: { baseCents: 1, ivaCents: 0 } },
    })
    expect(congelarPorTratamiento({ IVA_16: { baseCents: 8620, ivaCents: 1380 } }, 10000)).toEqual({
      v: 2,
      porTratamiento: { IVA_16: { baseCents: 8620, ivaCents: 1380 } },
    })
  })

  it('quita lo que no devuelve nada y manda el resto a la base del tratamiento de mayor importe', () => {
    expect(
      congelarPorTratamiento(
        { IVA_16: { baseCents: 0, ivaCents: 0 }, IVA_0: { baseCents: 4999, ivaCents: 0 }, EXENTO: { baseCents: 10, ivaCents: 0 } },
        5010,
      ),
    ).toEqual({ v: 2, porTratamiento: { IVA_0: { baseCents: 5000, ivaCents: 0 }, EXENTO: { baseCents: 10, ivaCents: 0 } } })
  })

  it('sin nada que repartir y con venta devuelta: todo a la base de IVA_16', () => {
    expect(congelarPorTratamiento({}, 3)).toEqual({ v: 2, porTratamiento: { IVA_16: { baseCents: 3, ivaCents: 0 } } })
    // Sin renglones retirados con importe (ninguno, o todos en cero), el mismo respaldo de siempre.
    expect(congelarPorTratamiento({}, 3, [])).toEqual({ v: 2, porTratamiento: { IVA_16: { baseCents: 3, ivaCents: 0 } } })
    expect(congelarPorTratamiento({}, 3, [{ tratamiento: 'EXENTO', tasa: 0, grossCents: 0 }])).toEqual({
      v: 2,
      porTratamiento: { IVA_16: { baseCents: 3, ivaCents: 0 } },
    })
  })

  // Ruling F-2: tras un reembolso independiente que vació los libros (N-6), el Δ sale en cero y TODA la venta devuelta es
  // faltante; va a la base del tratamiento de lo retirado, nunca a la gravable por omisión.
  it('faltante con renglones retirados: a la BASE de sus tratamientos, sin IVA; con todo al 16 %, lo de siempre', () => {
    const exento3000: MezclaPorTratamiento = [{ tratamiento: 'EXENTO', tasa: 0, grossCents: 3000 }]
    expect(congelarPorTratamiento({ EXENTO: { baseCents: 0, ivaCents: 0 } }, 3000, exento3000)).toEqual({
      v: 2,
      porTratamiento: { EXENTO: { baseCents: 3000, ivaCents: 0 } },
    })
    expect(
      congelarPorTratamiento({ IVA_16: { baseCents: 862, ivaCents: 138 } }, 4000, [
        { tratamiento: 'IVA_0', tasa: 0, grossCents: 2000 },
        { tratamiento: 'EXENTO', tasa: 0, grossCents: 1000 },
        { tratamiento: 'NO_OBJETO', tasa: 0, grossCents: -500 },
      ]),
    ).toEqual({
      v: 2,
      porTratamiento: {
        IVA_16: { baseCents: 862, ivaCents: 138 },
        IVA_0: { baseCents: 2000, ivaCents: 0 },
        EXENTO: { baseCents: 1000, ivaCents: 0 },
      },
    })
    expect(
      congelarPorTratamiento({ IVA_16: { baseCents: 2, ivaCents: 0 } }, 1, [{ tratamiento: 'IVA_16', tasa: 0.16, grossCents: 5000 }]),
    ).toEqual({
      v: 2,
      porTratamiento: { IVA_16: { baseCents: 1, ivaCents: 0 } },
    })
  })

  it('enLibrosPorTratamiento: venta − devoluciones, cada una en su forma', () => {
    const mezcla: MezclaPorTratamiento = [
      { tratamiento: 'IVA_16', tasa: 0.16, grossCents: 10000 },
      { tratamiento: 'IVA_0', tasa: 0, grossCents: 10000 },
    ]
    expect(
      enLibrosPorTratamiento(
        [
          { id: 'v', type: 'REGULAR', amountCents: 20000, processorData: null },
          {
            id: 'a',
            type: 'REFUND',
            amountCents: -10000,
            processorData: {
              provenance: 'PROVIDER_ADJUSTMENT',
              fiscalByRateCents: { v: 2, porTratamiento: { IVA_0: { baseCents: 10000, ivaCents: 0 } } },
            },
          },
          { id: 'm', type: 'REFUND', amountCents: -2000, processorData: { provenance: 'MANUAL' } },
        ],
        mezcla,
      ),
    ).toEqual({ IVA_16: { baseCents: 7759, ivaCents: 1241 }, IVA_0: { baseCents: -1000, ivaCents: 0 } })
  })
})
