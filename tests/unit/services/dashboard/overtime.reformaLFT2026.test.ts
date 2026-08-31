/**
 * La reforma laboral del 1-MAY-2026 (DOF) cambió el artículo 66, y el módulo la ignoraba.
 *
 * 🔴 Cómo se coló: estas reglas se escribieron el 29-ago-2026 de MEMORIA en vez de buscarlas.
 * La reforma es de mayo — justo el corte de conocimiento del modelo que las escribió, así que
 * "recordaba" la ley anterior con total confianza. Lo cazó la 3ª auditoría de Codex y se
 * confirmó buscando el texto vigente.
 *
 * Lo que cambió:
 *
 *   | | antes | desde el 1-may-2026 |
 *   |---|---|---|
 *   | horas extra al día | 3 | **4** |
 *   | días a la semana   | 3 | **4** |
 *   | tope semanal       | 9 h fijas | **9 h (2026-27) · 10 (2028) · 11 (2029) · 12 (2030+)** |
 *
 * 🔑 Y lo que lo vuelve DINERO: el artículo 68 vigente paga al 200 % lo que «supere lo
 * establecido en el artículo 66». O sea que el corte doble→triple NO es un número fijo: es el
 * tope del 66, que sube por año. Congelarlo en 540 hace que en 2028 se pague al triple una
 * hora que la ley manda pagar al doble.
 */
import {
  agruparPorSemana,
  topeSemanalMinutos,
  TOPE_DIARIO_MINUTOS,
  TOPE_DIAS_CON_EXTRA,
} from '@/services/dashboard/overtime'

describe('reforma LFT 2026 · los topes del artículo 66', () => {
  it('🔴 el tope diario es de CUATRO horas, no tres', () => {
    expect(TOPE_DIARIO_MINUTOS).toBe(240)
  })

  it('🔴 y el máximo es de CUATRO días a la semana, no tres', () => {
    expect(TOPE_DIAS_CON_EXTRA).toBe(4)
  })

  describe('el tope SEMANAL sube por año (cuarto transitorio del decreto)', () => {
    it.each([
      ['2026-05-04', 540],
      ['2026-12-28', 540],
      ['2027-06-07', 540],
      ['2028-01-03', 600],
      ['2028-11-06', 600],
      ['2029-02-05', 660],
      ['2030-01-07', 720],
      ['2035-04-02', 720],
    ])('la semana que empieza el %s tiene tope %i min', (lunes, esperado) => {
      expect(topeSemanalMinutos(lunes)).toBe(esperado)
    })
  })
})

describe('reforma LFT 2026 · el corte doble/triple se mueve con el tope', () => {
  const semana = (lunes: string, minutos: number) =>
    agruparPorSemana([{ date: lunes, minutos }], { startDate: lunes, endDate: lunes })[0]

  it('en 2026, 540 minutos van todos al doble', () => {
    const s = semana('2026-08-24', 540)
    expect(s.minutosDobles).toBe(540)
    expect(s.minutosTriples).toBe(0)
  })

  it('en 2026, el minuto 541 ya es triple', () => {
    const s = semana('2026-08-24', 600)
    expect(s.minutosDobles).toBe(540)
    expect(s.minutosTriples).toBe(60)
  })

  it('🔴 en 2028 esos MISMOS 600 minutos van completos al doble — el tope subió a 10 h', () => {
    const s = semana('2028-01-03', 600)
    expect(s.minutosDobles).toBe(600)
    expect(s.minutosTriples).toBe(0)
  })

  it('en 2029 el tope es 11 h: 660 al doble, lo de encima al triple', () => {
    const s = semana('2029-01-01', 720)
    expect(s.minutosDobles).toBe(660)
    expect(s.minutosTriples).toBe(60)
  })

  it('desde 2030 el tope es 12 h y ahí se queda', () => {
    const s = semana('2030-01-07', 780)
    expect(s.minutosDobles).toBe(720)
    expect(s.minutosTriples).toBe(60)
  })
})

describe('reforma LFT 2026 · qué se marca como infracción', () => {
  const semana = (lunes: string, dias: Array<[string, number]>) =>
    agruparPorSemana(
      dias.map(([date, minutos]) => ({ date, minutos })),
      { startDate: dias[0][0], endDate: dias[dias.length - 1][0] },
    )[0]

  it('🔴 CUATRO días con extra ya NO son infracción: la ley los permite', () => {
    const s = semana('2026-08-24', [
      ['2026-08-24', 30],
      ['2026-08-25', 30],
      ['2026-08-26', 30],
      ['2026-08-27', 30],
    ])
    expect(s.excedeDiasPermitidos).toBe(false)
  })

  it('cinco días sí lo son', () => {
    const s = semana('2026-08-24', [
      ['2026-08-24', 30],
      ['2026-08-25', 30],
      ['2026-08-26', 30],
      ['2026-08-27', 30],
      ['2026-08-28', 30],
    ])
    expect(s.excedeDiasPermitidos).toBe(true)
  })

  it('🔴 CUATRO horas en un día ya NO son infracción', () => {
    const s = semana('2026-08-24', [['2026-08-24', 240]])
    expect(s.diasSobreTopeDiario).toEqual([])
  })

  it('cuatro horas y un minuto sí', () => {
    const s = semana('2026-08-24', [['2026-08-24', 241]])
    expect(s.diasSobreTopeDiario).toEqual(['2026-08-24'])
  })
})

/**
 * 🔴 P1 #2 de la 4ª auditoría de Codex: el tope SEMANAL es el límite legal, y sólo se usaba
 * para repartir el pago — nunca para juzgar. Una semana de 14 horas pagaba 300 minutos al
 * TRIPLE y a la vez declaraba «sin infracción», porque ninguno de sus días pasaba de 4 h y
 * eran sólo cuatro días.
 */
describe('reforma LFT 2026 · pasarse del tope SEMANAL también es infracción', () => {
  const semana = (lunes: string, dias: Array<[string, number]>) =>
    agruparPorSemana(
      dias.map(([date, minutos]) => ({ date, minutos })),
      { startDate: lunes, endDate: dias[dias.length - 1][0] },
    )[0]

  it('🔴 14 h en cuatro días legales SIGUEN siendo infracción: pasan el tope de 9 h', () => {
    const s = semana('2026-08-24', [
      ['2026-08-24', 240],
      ['2026-08-25', 240],
      ['2026-08-26', 180],
      ['2026-08-27', 180],
    ])
    expect(s.minutosTriples).toBe(300)
    expect(s.diasSobreTopeDiario).toEqual([]) // ningún día pasa de 4 h
    expect(s.excedeDiasPermitidos).toBe(false) // son cuatro días, permitidos
    expect(s.excedeTopeSemanal).toBe(true) // …y aun así la semana rompe la ley
  })

  it('exactamente 9 h no lo son', () => {
    const s = semana('2026-08-24', [['2026-08-24', 240], ['2026-08-25', 240], ['2026-08-26', 60]])
    expect(s.minutosTotal).toBe(540)
    expect(s.excedeTopeSemanal).toBe(false)
  })

  it('🔴 y el tope que se juzga es el del AÑO: 10 h en 2028 ya no son infracción', () => {
    const s = semana('2028-01-03', [['2028-01-03', 240], ['2028-01-04', 240], ['2028-01-05', 120]])
    expect(s.minutosTotal).toBe(600)
    expect(s.excedeTopeSemanal).toBe(false)
  })

  it('pero 11 h en 2028 sí', () => {
    const s = semana('2028-01-03', [['2028-01-03', 240], ['2028-01-04', 240], ['2028-01-05', 180]])
    expect(s.excedeTopeSemanal).toBe(true)
  })
})

