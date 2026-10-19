// tests/unit/services/mobile/precioQueVioElCliente.test.ts
import {
  CATALOGO_MAS_VIEJO_POSIBLE,
  VENTANA_DEL_CATALOGO_MS,
  cambiosDeOrdenExistente,
  clasificarLinea,
  horaDeLaVenta,
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
