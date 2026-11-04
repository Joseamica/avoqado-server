import {
  decidirCarril,
  memoriaEstimadaMb,
  admitePorMemoria,
  estadoVisible,
  EXPORT_LIMITS,
  MENSAJE_GET_VIEJO_GRANDE,
} from '@/services/exports/exportPolicy'

describe('exportPolicy', () => {
  it('chico va directo', () => {
    expect(decidirCarril({ filas: 1_000, columnas: 13, formato: 'xlsx' })).toEqual({ carril: 'directo', formato: 'xlsx' })
  })
  it('frontera: 20,000 celdas exactas ya es segundo plano', () => {
    expect(decidirCarril({ filas: 2_000, columnas: 10, formato: 'csv' }).carril).toBe('segundoPlano')
    expect(decidirCarril({ filas: 1_999, columnas: 10, formato: 'csv' }).carril).toBe('directo')
  })
  it('Testarudo octubre (4,224 cobros × 13) va a segundo plano en xlsx', () => {
    expect(decidirCarril({ filas: 4_224, columnas: 13, formato: 'xlsx' })).toEqual({ carril: 'segundoPlano', formato: 'xlsx' })
  })
  it('xlsx que no cabe en memoria pasa a csv y lo dice', () => {
    expect(decidirCarril({ filas: 150_000, columnas: 13, formato: 'xlsx' })).toEqual({
      carril: 'segundoPlano',
      formato: 'csv',
      cambioAFormato: 'csv',
    })
  })
  it('más del máximo de filas se rechaza con el número', () => {
    expect(decidirCarril({ filas: 200_001, columnas: 3, formato: 'csv' })).toEqual({
      carril: 'rechazo',
      motivo: 'demasiadasFilas',
      filas: 200_001,
      maximo: EXPORT_LIMITS.FILAS_MAX_SEGUNDO_PLANO,
    })
  })
  it('cero filas va directo (archivo sólo con encabezados)', () => {
    expect(decidirCarril({ filas: 0, columnas: 13, formato: 'xlsx' }).carril).toBe('directo')
  })
  it('csv casi no pide memoria; xlsx pide ~460 B por celda con holgura', () => {
    expect(memoriaEstimadaMb({ filas: 100_000, columnas: 13, formato: 'csv' })).toBeLessThan(50)
    const mb = memoriaEstimadaMb({ filas: 100_000, columnas: 13, formato: 'xlsx' })
    expect(mb).toBeGreaterThan(550)
    expect(mb).toBeLessThan(800)
  })
  it('admite sólo si rss + estimado cabe en el límite', () => {
    expect(admitePorMemoria({ estimadoMb: 300, rssMb: 600, limiteMb: 1_200 })).toBe(true)
    expect(admitePorMemoria({ estimadoMb: 700, rssMb: 600, limiteMb: 1_200 })).toBe(false)
  })
  it('el mensaje del GET viejo para lo grande es el del ruling', () => {
    expect(MENSAJE_GET_VIEJO_GRANDE).toBe('Este archivo es grande: recarga la página para descargarlo en segundo plano')
  })
  it('estado visible: un READY vencido es EXPIRED aunque la limpieza no haya pasado; lo demás, igual', () => {
    const ahora = new Date('2026-11-10T18:00:00Z')
    expect(estadoVisible({ status: 'READY', expiresAt: new Date('2026-11-10T17:59:59Z') }, ahora)).toBe('EXPIRED')
    expect(estadoVisible({ status: 'READY', expiresAt: new Date('2026-11-10T18:00:01Z') }, ahora)).toBe('READY')
    expect(estadoVisible({ status: 'FAILED', expiresAt: new Date('2026-11-01T00:00:00Z') }, ahora)).toBe('FAILED')
    expect(estadoVisible({ status: 'RUNNING', expiresAt: new Date('2026-11-01T00:00:00Z') }, ahora)).toBe('RUNNING')
  })
})
