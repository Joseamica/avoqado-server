import fs from 'fs'
import path from 'path'
import { motivoParaRechazarBaseDePruebas } from '../../__helpers__/baseDePruebasPermitida'

// 8-oct-2026: una suite de integración cuya guarda de base falló siguió a su afterEach con venueId undefined, y
// `deleteMany({ where: { venueId } })` borró TABLAS ENTERAS (en una base de ensayo: 33,361 pagos → 0). El patrón está
// en ~660 limpiezas. Esta guarda impide que cualquier suite de integración arranque contra la base compartida de
// todas las sesiones (av-db-25) o contra un host que no sea local.
describe('las pruebas de integración no corren contra la base compartida ni contra un host remoto', () => {
  it.each([
    'postgresql://u:p@localhost:5432/av-db-25',
    'postgresql://u:p@127.0.0.1:5432/AV-DB-25',
    'postgresql://u:p@localhost:5432/av-db-25?schema=public',
    'postgresql://u:p@localhost:5432/av%2Ddb%2D25',
    'postgresql://u:p@localhost:5432/%20av-db-25%20',
    'postgresql://u:p@dpg-x.oregon-postgres.render.com:5432/avoqado_h1a_test_1',
    'postgresql://u:p@localhost:5432/',
    'https://localhost/avoqado_h1a_test_1',
    'no es una url',
  ])('rechaza %s', url => {
    expect(motivoParaRechazarBaseDePruebas(url)).not.toBeNull()
  })

  it.each([
    'postgresql://postgres:postgres@localhost:5432/avoqado_h1a_test_20260808', // la del CI
    'postgres://u:p@localhost:5432/avoqado_h1a_test_20260808',
    'postgresql://u:p@localhost:5432/av-db-25-pago-f3', // base propia de una fase
    'postgresql://u:p@127.0.0.1:5432/avoqado_ftgraves_test_20261008',
  ])('acepta %s', url => {
    expect(motivoParaRechazarBaseDePruebas(url)).toBeNull()
  })

  it('el motivo nunca repite la URL (puede traer la contraseña)', () => {
    const motivo = motivoParaRechazarBaseDePruebas('postgresql://u:secreta@localhost:5432/av-db-25')
    expect(motivo).not.toBeNull()
    expect(motivo).not.toContain('secreta')
  })

  it('el setup de integración aplica la guarda antes de cargar cualquier prueba', () => {
    const setup = fs.readFileSync(path.join(__dirname, '../../__helpers__/integration-setup.ts'), 'utf8')
    expect(setup).toMatch(/motivoParaRechazarBaseDePruebas\(testDatabaseUrlFromCaller\)/)
  })
})
