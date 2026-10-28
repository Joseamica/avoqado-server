// tests/unit/services/mobile/precioQueVioElCliente.test.ts
import {
  CATALOGO_MAS_VIEJO_POSIBLE,
  VENTANA_DEL_CATALOGO_MS,
  cambiosDeOrdenExistente,
  clasificarLinea,
  horaDeLaVenta,
  precioDeExtraMostrado,
  precioMostradoValido,
  ventanaDeLaLinea,
} from '@/services/mobile/precioQueVioElCliente'

/**
 * La regla pura del «más bajo» (spec 2026-10-17-precio-que-vio-el-cliente): sin base, sin reloj falso. La búsqueda en el
 * historial (`preciosQueFueronVigentes`) se prueba contra Postgres en tests/integration/mobile/precioQueVioElCliente.historial.test.ts.
 */
describe('precio que vio el cliente — regla pura', () => {
  const llegada = new Date('2026-10-17T18:00:00.000Z')
  const hace = (ms: number) => new Date(llegada.getTime() - ms)
  const base = { actualCents: 5000, horaDeLaVenta: llegada }

  describe('clasificarLinea', () => {
    it('sin precio mostrado: como hoy', () => expect(clasificarLinea({ ...base, mostradoCents: null, catalogAt: null })).toBe('COMO_HOY'))
    it('mostró el mismo precio: como hoy', () =>
      expect(clasificarLinea({ ...base, mostradoCents: 5000, catalogAt: hace(3_600_000) })).toBe('COMO_HOY'))
    it('el dueño bajó el precio: el actual, sin historial', () =>
      expect(clasificarLinea({ ...base, mostradoCents: 5500, catalogAt: null })).toBe('BAJO'))
    it('subió y el catálogo es de hace 71 h: se busca', () =>
      expect(clasificarLinea({ ...base, mostradoCents: 4500, catalogAt: hace(71 * 3_600_000) })).toBe('BUSCAR'))
    it('subió y el catálogo es de hace 72 h justas: se busca', () =>
      expect(clasificarLinea({ ...base, mostradoCents: 4500, catalogAt: hace(VENTANA_DEL_CATALOGO_MS) })).toBe('BUSCAR'))
    it('subió y el catálogo es de hace 72 h + 1 ms: no se reconoce', () =>
      expect(clasificarLinea({ ...base, mostradoCents: 4500, catalogAt: hace(VENTANA_DEL_CATALOGO_MS + 1) })).toBe('NO_RECONOCIDO'))
    it('subió y no trae catálogo: no se reconoce', () =>
      expect(clasificarLinea({ ...base, mostradoCents: 4500, catalogAt: null })).toBe('NO_RECONOCIDO'))
    it('subió y el catálogo es ilegible (fecha inválida): no se reconoce', () =>
      expect(clasificarLinea({ ...base, mostradoCents: 4500, catalogAt: new Date('zzz') })).toBe('NO_RECONOCIDO'))
    it('catálogo 61 s POSTERIOR a la venta: no se reconoce', () =>
      expect(clasificarLinea({ ...base, mostradoCents: 4500, catalogAt: new Date(llegada.getTime() + 61_000) })).toBe('NO_RECONOCIDO'))
    it('catálogo 30 s posterior (reloj del aparato atrasado): se busca', () =>
      expect(clasificarLinea({ ...base, mostradoCents: 4500, catalogAt: new Date(llegada.getTime() + 30_000) })).toBe('BUSCAR'))
    it('venta de la cola de hace 10 días con catálogo 1 h antes: se busca (sincronizar tarde no cambia nada)', () => {
      const venta = horaDeLaVenta({ isOfflineReplay: true, createdAtLocal: hace(10 * 86_400_000).getTime() }, llegada)
      expect(venta).toEqual(hace(10 * 86_400_000))
      expect(
        clasificarLinea({ ...base, horaDeLaVenta: venta, mostradoCents: 4500, catalogAt: new Date(venta.getTime() - 3_600_000) }),
      ).toBe('BUSCAR')
    })
    // Sin historial antes de la migración, el veredicto es el mismo; y nunca llegan a Postgres (ni a toISOString) fechas
    // que no sabe leer.
    it.each([
      ['1999', new Date('1999-06-01T12:00:00.000Z')],
      ['año 0', new Date('0000-12-31T12:00:00.000Z')],
    ])('catálogo anterior a 2020 (%s) con la venta 1 h después: no se reconoce', (_, catalogAt) =>
      expect(clasificarLinea({ ...base, horaDeLaVenta: new Date(catalogAt.getTime() + 3_600_000), mostradoCents: 4500, catalogAt })).toBe(
        'NO_RECONOCIDO',
      ),
    )
    it('catálogo justo en el piso (2020-01-01T00:00:00.000Z): se busca', () =>
      expect(
        clasificarLinea({
          ...base,
          horaDeLaVenta: new Date(CATALOGO_MAS_VIEJO_POSIBLE + 3_600_000),
          mostradoCents: 4500,
          catalogAt: new Date(CATALOGO_MAS_VIEJO_POSIBLE),
        }),
      ).toBe('BUSCAR'))
  })

  /**
   * Reloj del aparato (Review Focus 1; Codex plan-r2 #9): `catalogAt` lo sella el SERVIDOR y `createdAtLocal` el aparato. De
   * la cola, la venta no pudo ser antes de que el aparato leyera ese catálogo ni después de llegar: la ventana de la línea es
   * `[catalogAt − 60 s, min(llegada, max(horaDeLaVenta, catalogAt))]`, y un catálogo posterior a la llegada no se reconoce.
   * 🔴 Codex servidor r1 #5: si la hora capturada cae claramente ANTES del catálogo (más que la holgura), el reloj del aparato está
   * mal y esa hora no dice nada: la línea se mide hasta la LLEGADA (si no, la edad salía 0 y la regla de 72 h desaparecía).
   */
  describe('cola: reloj del aparato adelantado o atrasado', () => {
    const catalogAt = hace(30 * 60_000) // el servidor lo selló hace 30 min
    const ventaReal = hace(29 * 60_000) // un minuto después de leerlo
    const linea = (horaDeLaVentaLinea: Date, cat = catalogAt) => ({
      ...base,
      mostradoCents: 4500,
      catalogAt: cat,
      horaDeLaVenta: horaDeLaVentaLinea,
      llegada,
    })
    const desdeLaCola = (capturadaMs: number) => horaDeLaVenta({ isOfflineReplay: true, createdAtLocal: capturadaMs }, llegada)

    it('catalogAt del servidor y createdAtLocal con reloj +5 min ⇒ se busca, hasta la hora capturada', () => {
      const venta = desdeLaCola(ventaReal.getTime() + 5 * 60_000)
      expect(clasificarLinea(linea(venta))).toBe('BUSCAR')
      expect(ventanaDeLaLinea(catalogAt, venta, llegada)).toEqual({ desde: new Date(catalogAt.getTime() - 60_000), hasta: venta })
    })

    it('reloj +5 min y la venta llega enseguida: la hora se topa en la llegada', () => {
      const cat = hace(60_000)
      const venta = desdeLaCola(llegada.getTime() + 4 * 60_000)
      expect(venta).toEqual(llegada)
      expect(clasificarLinea(linea(venta, cat))).toBe('BUSCAR')
      expect(ventanaDeLaLinea(cat, venta, llegada).hasta).toEqual(llegada)
    })

    it('catalogAt del servidor y createdAtLocal con reloj ATRASADO 5 min (catálogo fresco) ⇒ se busca, con la ventana hasta la llegada', () => {
      const venta = desdeLaCola(ventaReal.getTime() - 5 * 60_000) // 4 min ANTES del catálogo, según el aparato
      expect(clasificarLinea(linea(venta))).toBe('BUSCAR')
      expect(ventanaDeLaLinea(catalogAt, venta, llegada)).toEqual({ desde: new Date(catalogAt.getTime() - 60_000), hasta: llegada })
    })

    it('hora capturada dentro de la holgura antes del catálogo (30 s) ⇒ la ventana termina en el catálogo, como antes', () => {
      const venta = desdeLaCola(catalogAt.getTime() - 30_000)
      expect(clasificarLinea(linea(venta))).toBe('BUSCAR')
      expect(ventanaDeLaLinea(catalogAt, venta, llegada).hasta).toEqual(catalogAt)
    })

    it('reloj atrasado días con un catálogo de 30 min: la edad se mide hasta la llegada ⇒ se busca', () =>
      expect(clasificarLinea(linea(hace(10 * 86_400_000)))).toBe('BUSCAR'))

    it('🔴 catálogo de 96 h con el reloj del aparato ANTES del catálogo ⇒ NO se reconoce (la regla de 72 h sigue viva)', () => {
      const cat = hace(96 * 3_600_000)
      expect(clasificarLinea(linea(new Date(cat.getTime() - 86_400_000), cat))).toBe('NO_RECONOCIDO')
      expect(clasificarLinea(linea(new Date(cat.getTime() - 5 * 60_000), cat))).toBe('NO_RECONOCIDO')
    })

    it('catalogAt posterior a la llegada ⇒ no se reconoce, aunque esté dentro de la holgura', () => {
      const cat = new Date(llegada.getTime() + 30_000)
      expect(clasificarLinea(linea(hace(10_000), cat))).toBe('NO_RECONOCIDO')
    })

    it('la regla de las 72 h sigue contando desde el catálogo hasta la hora de la línea', () => {
      const cat = hace(VENTANA_DEL_CATALOGO_MS + 60_000)
      expect(clasificarLinea(linea(hace(VENTANA_DEL_CATALOGO_MS + 30_000), cat))).toBe('BUSCAR') // 30 s después del catálogo
      expect(clasificarLinea(linea(llegada, cat))).toBe('NO_RECONOCIDO')
    })
  })

  describe('ventanaDeLaLinea', () => {
    it('la ventana termina en la venta, nunca después', () =>
      expect(ventanaDeLaLinea(hace(5_000), hace(1_000))).toEqual({ desde: hace(65_000), hasta: hace(1_000) }))
  })

  describe('horaDeLaVenta', () => {
    it('en línea la hora de la venta es la llegada', () =>
      expect(horaDeLaVenta({ createdAtLocal: hace(3_600_000).getTime() }, llegada)).toEqual(llegada))
    it('de la cola con reloj adelantado: la llegada', () =>
      expect(horaDeLaVenta({ isOfflineReplay: true, createdAtLocal: llegada.getTime() + 3_600_000 }, llegada)).toEqual(llegada))
    it('de la cola, la hora capturada aunque llegue como texto numérico', () =>
      expect(horaDeLaVenta({ isOfflineReplay: true, createdAtLocal: String(hace(60_000).getTime()) }, llegada)).toEqual(hace(60_000)))
    it.each([null, undefined, '', '  ', 'zzz', Number.NaN, Number.POSITIVE_INFINITY, 9e15, '0x10', '1e12', ' 123 '])(
      'de la cola ilegible (%p): la llegada',
      x => expect(horaDeLaVenta({ isOfflineReplay: true, createdAtLocal: x as any }, llegada)).toEqual(llegada),
    )
    it('de la cola en el extremo de Date (-8.64e15): una fecha válida, nunca una que haga lanzar a toISOString', () => {
      const venta = horaDeLaVenta({ isOfflineReplay: true, createdAtLocal: -8.64e15 }, llegada)
      expect(Number.isNaN(venta.getTime())).toBe(false)
      expect(() => venta.toISOString()).not.toThrow()
    })
  })

  describe('precioMostradoValido', () => {
    it.each([-1, 45.5, Number.NaN, '4500', 2_147_483_648, null])('precio mostrado basura %p ⇒ null', x =>
      expect(precioMostradoValido(x)).toBeNull(),
    )
    it.each([0, 100_000_000, 2_147_483_647])('precio legítimo %p se conserva', x => expect(precioMostradoValido(x)).toBe(x))
  })

  describe('precioDeExtraMostrado', () => {
    it('lee el precio del extra en centavos', () => expect(precioDeExtraMostrado({ m1: 1000, m2: 0 }, 'm1')).toBe(1000))
    it('cero es un precio legítimo', () => expect(precioDeExtraMostrado({ m2: 0 }, 'm2')).toBe(0))
    it.each([
      ['sin el extra', { m2: 1000 }],
      ['negativo', { m1: -1 }],
      ['decimal', { m1: 10.5 }],
      ['texto', { m1: '1000' }],
      ['null', { m1: null }],
    ])('entrada basura (%s) ⇒ null', (_, x) => expect(precioDeExtraMostrado(x, 'm1')).toBeNull())
    it.each([undefined, null, 'x', 42, [1000], true])('displayedModifierPrices que no es objeto (%p) ⇒ null', x =>
      expect(precioDeExtraMostrado(x, '0')).toBeNull(),
    )
    it('una llave heredada no cuenta como precio mostrado', () => {
      expect(precioDeExtraMostrado({}, 'constructor')).toBeNull()
      expect(precioDeExtraMostrado(Object.create({ m1: 1000 }), 'm1')).toBeNull()
    })
  })

  describe('cambiosDeOrdenExistente', () => {
    it('reintento con dos precios del mismo producto: se correlaciona por línea', () =>
      expect(
        cambiosDeOrdenExistente(
          [
            { externalId: 'e1', productId: 'p1', displayedUnitPrice: 4500, catalogAt: 'C2' },
            { externalId: 'e2', productId: 'p1', displayedUnitPrice: 5500, catalogAt: 'C2' },
          ],
          [
            { externalId: 'e1', productId: 'p1', productName: 'Café', unitPrice: 45 },
            { externalId: 'e2', productId: 'p1', productName: 'Café', unitPrice: 50 },
          ],
        ),
      ).toEqual([
        { externalId: 'e2', productId: 'p1', productName: 'Café', catalogAt: 'C2', displayedUnitPriceCents: 5500, unitPriceCents: 5000 },
      ]))

    it('reintento: línea sin externalId o sin guardado ⇒ nada', () =>
      expect(
        cambiosDeOrdenExistente(
          [
            { externalId: null, productId: 'p1', displayedUnitPrice: 4500, catalogAt: 'C2' },
            { productId: 'p1', displayedUnitPrice: 4500, catalogAt: 'C2' },
            { externalId: 'e9', productId: 'p1', displayedUnitPrice: 4500, catalogAt: 'C2' },
          ],
          [
            { externalId: null, productId: 'p1', productName: 'Café', unitPrice: 50 },
            { externalId: 'e1', productId: 'p1', productName: 'Café', unitPrice: 50 },
          ],
        ),
      ).toEqual([]))

    it('reintento: precio mostrado basura ⇒ nada', () =>
      expect(
        cambiosDeOrdenExistente(
          [{ externalId: 'e1', productId: 'p1', displayedUnitPrice: 'x', catalogAt: 'C2' }],
          [{ externalId: 'e1', productId: 'p1', productName: 'Café', unitPrice: 50 }],
        ),
      ).toEqual([]))

    it('centavos «feos»: $8.20 guardado = 820 mostrado, sin cambio', () =>
      expect(
        cambiosDeOrdenExistente(
          [{ externalId: 'e1', productId: 'p1', displayedUnitPrice: 820, catalogAt: 'C2' }],
          [{ externalId: 'e1', productId: 'p1', productName: 'Galleta', unitPrice: 8.2 }],
        ),
      ).toEqual([]))

    it('reintento con extras: cada extra mostrado distinto de lo GUARDADO sale con su modifierId', () =>
      expect(
        cambiosDeOrdenExistente(
          [
            {
              externalId: 'e1',
              productId: 'p1',
              displayedUnitPrice: 5000,
              catalogAt: 'C2',
              modifierIds: ['m1', 'm2', 'm1'],
              displayedModifierPrices: { m1: 1000, m2: 500, mX: 1 },
            },
          ],
          [
            {
              externalId: 'e1',
              productId: 'p1',
              productName: 'Café',
              unitPrice: 50,
              modifiers: [
                { modifierId: 'm1', price: 15 },
                { modifierId: 'm2', price: 5 },
                { modifierId: 'm1', price: 15 },
              ],
            },
          ],
        ),
      ).toEqual([
        {
          externalId: 'e1',
          productId: 'p1',
          productName: 'Café',
          modifierId: 'm1',
          catalogAt: 'C2',
          displayedUnitPriceCents: 1000,
          unitPriceCents: 1500,
        },
      ]))

    it('reintento: extras mostrados sin catalogAt no cuentan (igual que en la creación)', () =>
      expect(
        cambiosDeOrdenExistente(
          [{ externalId: 'e1', productId: 'p1', modifierIds: ['m1'], displayedModifierPrices: { m1: 1000 } }],
          [{ externalId: 'e1', productId: 'p1', productName: 'Café', unitPrice: 50, modifiers: [{ modifierId: 'm1', price: 15 }] }],
        ),
      ).toEqual([]))

    // Un importe libre no es una línea de catálogo: la creación nunca reporta un cambio suyo, el reintento tampoco.
    it('reintento: el guardado sin producto («Otro importe») ⇒ nada, aunque el cliente mande un productId', () =>
      expect(
        cambiosDeOrdenExistente(
          [{ externalId: 'e1', productId: 'p1', displayedUnitPrice: 4500, catalogAt: 'C2' }],
          [{ externalId: 'e1', productId: null, productName: 'Otro importe', unitPrice: 50 }],
        ),
      ).toEqual([]))
  })
})
