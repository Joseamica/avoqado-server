import { resolverHoraDelCelular } from '@/services/tpv/campo/horaDelCelular'

describe('resolverHoraDelCelular', () => {
  const ahora = new Date('2026-11-08T15:00:00Z')
  const r = (iso?: string, origen?: 'RELOJ_ANCLADO' | 'RELOJ_DEL_CELULAR') =>
    resolverHoraDelCelular({ ocurrioAt: iso ? new Date(iso) : undefined, origen }, ahora)

  it('sin ocurrioAt usa la hora del servidor', () => {
    expect(r()).toEqual({ hora: ahora, origen: 'SERVIDOR' })
  })
  it('acepta una hora pasada con su origen', () => {
    expect(r('2026-11-08T14:58:00Z', 'RELOJ_ANCLADO')).toEqual({ hora: new Date('2026-11-08T14:58:00Z'), origen: 'RELOJ_ANCLADO' })
  })
  it('acepta hasta 2 min en el futuro', () => {
    expect(r('2026-11-08T15:01:59Z', 'RELOJ_ANCLADO').origen).toBe('RELOJ_ANCLADO')
  })
  it('más de 2 min en el futuro usa servidor', () => {
    expect(r('2026-11-08T15:09:00Z', 'RELOJ_DEL_CELULAR')).toEqual({ hora: ahora, origen: 'SERVIDOR' })
  })
  it('más de 7 días atrás usa servidor', () => {
    expect(r('2026-11-01T14:59:00Z', 'RELOJ_ANCLADO')).toEqual({ hora: ahora, origen: 'SERVIDOR' })
  })
  it('justo dentro de 7 días se acepta', () => {
    expect(r('2026-11-01T15:01:00Z', 'RELOJ_ANCLADO').origen).toBe('RELOJ_ANCLADO')
  })
  it('sin origen se asume RELOJ_DEL_CELULAR', () => {
    expect(r('2026-11-08T14:58:00Z').origen).toBe('RELOJ_DEL_CELULAR')
  })
})
