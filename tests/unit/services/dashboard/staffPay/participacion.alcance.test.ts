import { alcanceDelPeriodo, sedesConVentana } from '@/services/dashboard/staffPay/participacion'
import { TOPE_SEDES_CON_MODULO } from '@/services/dashboard/staffPay/acceso'

// Alcance de un periodo con participación por sede (fase 3, B10; diseño r5.2): función PURA, todo llega resuelto.
// CERRADO ⇒ su alcance congelado; sin activar o antes del inicio ⇒ la regla D2 de la fase 2 (guardadas ∪ activas);
// desde el inicio ⇒ también las sedes con ventana (su historia); un periodo que cruza el inicio no debería existir y truena.
describe('alcanceDelPeriodo (B10, r5.2)', () => {
  const base = { guardadas: ['b', 'a'], activas: ['c', 'a'], conVentana: ['d', 'c'], startDate: '2026-09-01' as string | null }
  const periodo = (start: string, end: string, estado: 'OPEN' | 'CLOSED' = 'OPEN') => ({ start, end, estado })

  it('un periodo CERRADO usa su alcance congelado, sin activas ni ventanas', () => {
    expect(alcanceDelPeriodo({ ...base, periodo: periodo('2026-10-01', '2026-10-31', 'CLOSED') })).toEqual(['a', 'b'])
    // También uno cerrado antes del inicio (fase 2).
    expect(alcanceDelPeriodo({ ...base, periodo: periodo('2026-08-01', '2026-08-31', 'CLOSED') })).toEqual(['a', 'b'])
  })

  it('sin activar: la regla D2 (guardadas ∪ activas), sin ampliar por ventanas', () => {
    expect(alcanceDelPeriodo({ ...base, startDate: null, periodo: periodo('2026-10-01', '2026-10-31') })).toEqual(['a', 'b', 'c'])
  })

  it('un periodo que termina antes del inicio: D2 sin las sedes con ventana', () => {
    expect(alcanceDelPeriodo({ ...base, periodo: periodo('2026-08-01', '2026-08-31') })).toEqual(['a', 'b', 'c'])
    expect(alcanceDelPeriodo({ ...base, periodo: periodo('2026-08-16', '2026-08-31') })).toEqual(['a', 'b', 'c'])
  })

  it('desde el inicio: guardadas ∪ activas ∪ con ventana, ordenada y sin repetidos', () => {
    expect(alcanceDelPeriodo({ ...base, periodo: periodo('2026-09-01', '2026-09-30') })).toEqual(['a', 'b', 'c', 'd'])
    expect(alcanceDelPeriodo({ ...base, periodo: periodo('2026-10-01', '2026-10-31') })).toEqual(['a', 'b', 'c', 'd'])
    expect(
      alcanceDelPeriodo({
        guardadas: [],
        activas: [],
        conVentana: ['z', 'y', 'z'],
        startDate: '2026-09-01',
        periodo: periodo('2026-11-01', '2026-11-15'),
      }),
    ).toEqual(['y', 'z'])
  })

  it('un periodo ABIERTO que cruza el inicio truena en vez de adivinar: 409 en español (revisión de B11 #2), nunca un 500', () => {
    const error = (f: () => unknown) => {
      try {
        f()
      } catch (e) {
        return e
      }
      throw new Error('no tronó')
    }
    const cruza = {
      statusCode: 409,
      code: 'STAFF_PAY_PERIODO_CRUZA_EL_INICIO',
      details: { periodo: { start: '2026-08-16', end: '2026-09-15' }, inicio: '2026-09-01' },
    }
    const e = error(() => alcanceDelPeriodo({ ...base, periodo: periodo('2026-08-16', '2026-09-15') }))
    expect(e).toMatchObject(cruza)
    expect((e as Error).message).toBe(
      'El periodo cruza el inicio de pago al personal; el periodo del 16 ago 2026 al 15 sep 2026 empieza antes del 1 sep 2026 y termina después. Pide ayuda a Avoqado para corregirlo.',
    )
    expect(
      error(() => alcanceDelPeriodo({ ...base, startDate: '2026-09-16', periodo: periodo('2026-09-01', '2026-09-30') })),
    ).toMatchObject({
      statusCode: 409,
      code: 'STAFF_PAY_PERIODO_CRUZA_EL_INICIO',
    })
  })
})

// `sedesConVentana` (r4.2): DISTINCT de las sedes con ventana, con el MISMO tope de sedes que `sedesConServicePay`; pasado el
// tope truena (un recorte dejaría fuera del alcance —y sin descontar sus devoluciones— a la sede 501).
describe('sedesConVentana — tope de sedes («nada se trunca»)', () => {
  const db = (n: number) => ({
    $queryRaw: jest.fn().mockResolvedValue(Array.from({ length: n }, (_, i) => ({ venueId: `v${String(i).padStart(4, '0')}` }))),
  })

  it('pide una más que el tope de sedes y, si llega, truena', async () => {
    const d = db(TOPE_SEDES_CON_MODULO + 1)
    await expect(sedesConVentana(d as any, 'org')).rejects.toMatchObject({ statusCode: 400, code: 'DEMASIADAS_SEDES' })
    const sql = d.$queryRaw.mock.calls[0][0]
    expect(sql.values).toEqual(['org', TOPE_SEDES_CON_MODULO + 1])
  })

  it('justo en el tope las devuelve todas', async () => {
    await expect(sedesConVentana(db(TOPE_SEDES_CON_MODULO) as any, 'org')).resolves.toHaveLength(TOPE_SEDES_CON_MODULO)
  })
})
