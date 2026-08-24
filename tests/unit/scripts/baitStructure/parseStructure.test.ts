import * as XLSX from 'xlsx'
import { parseStructure } from '../../../../scripts/lib/baitStructure/parseStructure'

const HEADER = ['ID', 'Nombre', 'Posición', 'Estado', 'Ciudad', 'ID de Tienda', 'Formato', 'Nombre de la tienda']
const DASH = '----------------'

function wb(rows: unknown[][]): XLSX.WorkBook {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[], [], HEADER, ...rows]), 'Estructura')
  return book
}

describe('parseStructure', () => {
  it('cuelga cada promotor del último supervisor leído', () => {
    const rows = parseStructure(
      wb([
        ['WMQMEAE8008', 'Elias Medina Alarcón', 'Supervisor', 'Querétaro', 'Querétaro', DASH, DASH, DASH],
        ['BEQJURR8002', 'Ricardo Juárez Rivera', 'Promotor', 'Querétaro', 'Querétaro', '2978', 'BAE', 'RANCHO SAN PEDRO'],
        ['WMSNAOJ8201', 'Juan Joel Nájera Ortiz', 'Supervisor', 'SLP', 'SLP', DASH, DASH, DASH],
        ['BESCACM7905', 'Martha Paola Candelaria Cortes', 'Promotor', 'SLP', 'SLP', '3984', 'BAE', 'BAE LOMA DEL PEDREGAL'],
      ]),
    )

    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({ puesto: 'SUPERVISOR', supervisorCode: null, storeId: null })
    expect(rows[1]).toMatchObject({ puesto: 'PROMOTOR', supervisorCode: 'WMQMEAE8008', storeId: '2978', formato: 'BAE' })
    expect(rows[3]).toMatchObject({ puesto: 'PROMOTOR', supervisorCode: 'WMSNAOJ8201', storeId: '3984' })
  })

  it('marca las vacantes y deja su tienda intacta', () => {
    const rows = parseStructure(
      wb([
        ['WMQMEAE8008', 'Elias Medina Alarcón', 'Supervisor', 'Querétaro', 'Querétaro', DASH, DASH, DASH],
        ['VacantePROMO6QRO1', 'VacantePROMO6QRO1', 'Promotor', 'Querétaro', 'Querétaro', '3636', 'BAE', 'PUERTA DEL SOL'],
      ]),
    )

    expect(rows[1]).toMatchObject({ isVacante: true, storeId: '3636' })
  })

  it('convierte los rellenos en null y reconoce cubre descanso y activaciones', () => {
    const rows = parseStructure(
      wb([
        ['BSSLPRECU02', 'Rene Osbaldo Cubos Alvarez', 'Supervisor', 'SLP', 'SLP', DASH, DASH, DASH],
        ['BSCBJOSE04', 'José Lopes', 'Cubre descanso', 'SLP', 'SLP', 'Variable', 'Variable', 'Variable'],
        ['BSSUPBRA01', 'Braulio Rodrigo Niño Burgos', 'Promotor', 'SLP', 'SLP', DASH, DASH, 'ACTIVACIONES'],
      ]),
    )

    expect(rows[1]).toMatchObject({ puesto: 'CUBRE_DESCANSO', storeId: null, formato: null, storeName: null })
    expect(rows[2]).toMatchObject({ puesto: 'PROMOTOR', storeId: null, storeName: 'ACTIVACIONES' })
  })

  it('ignora filas totalmente vacías', () => {
    expect(parseStructure(wb([[null, null, null, null, null, null, null, null]]))).toHaveLength(0)
  })

  it('descarta fila con Posición desconocida y avisa en console.warn', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const rows = parseStructure(
        wb([
          ['WMQMEAE8008', 'Elias Medina Alarcón', 'Supervisor', 'Querétaro', 'Querétaro', DASH, DASH, DASH],
          ['BSCCOORD01', 'Juan Coordinador', 'Coordinador', 'Querétaro', 'Querétaro', DASH, DASH, DASH],
        ]),
      )

      expect(rows).toHaveLength(1)
      expect(rows[0].employeeCode).toBe('WMQMEAE8008')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('puesto no reconocido'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Coordinador'))
    } finally {
      warn.mockRestore()
    }
  })

  it('ignora fila totalmente vacía SIN avisar en console.warn', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const rows = parseStructure(
        wb([
          ['WMQMEAE8008', 'Elias Medina Alarcón', 'Supervisor', 'Querétaro', 'Querétaro', DASH, DASH, DASH],
          [null, null, null, null, null, null, null, null],
        ]),
      )

      expect(rows).toHaveLength(1)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
