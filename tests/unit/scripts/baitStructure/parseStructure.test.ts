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

/**
 * Formato de agosto 2026 — Isaac cambió los encabezados del archivo sin avisar
 * (Asana 1217743599033214, 31-ago). Con el parser anterior este archivo abortaba
 * entero con "No encontré el encabezado", así que estas pruebas fijan las cuatro
 * diferencias reales, medidas contra el archivo que mandó:
 *
 *   ID                  → ID Promotoría
 *   ID de Tienda        → ID único Tienda
 *   Estado + Ciudad     → desaparecen, y entra "Reporta"
 *   Nombre de la tienda → "Nombre"  (🔴 COLISIONA con el "Nombre" de la persona)
 *
 * Y un puesto nuevo: "Excelencia Ventas".
 */
const HEADER_AGO = ['ID Promotoría', 'Nombre', 'Posición', 'Reporta', 'ID único Tienda', 'Formato', 'Nombre']

function wbAgo(rows: unknown[][]): XLSX.WorkBook {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[], [], HEADER_AGO, ...rows]), 'Hoja1')
  return book
}

describe('parseStructure — formato de agosto 2026', () => {
  it('lee el encabezado nuevo y NO confunde el "Nombre" de la tienda con el de la persona', () => {
    const rows = parseStructure(
      wbAgo([
        ['WMQMEAE8008', 'Elias Medina Alarcón', 'Supervisor', 'Isaac Mayoral', DASH, DASH, DASH],
        ['BEQJURR8002', 'Ricardo Juárez Rivera', 'Promotor', 'Elias Medina Alarcón', '2978', 'BAE', 'RANCHO SAN PEDRO'],
      ]),
    )

    expect(rows).toHaveLength(2)
    // Las dos columnas se llaman "Nombre": la de la tienda es la que sigue a "Formato".
    expect(rows[1].fullName).toBe('Ricardo Juárez Rivera')
    expect(rows[1].storeName).toBe('RANCHO SAN PEDRO')
    expect(rows[1].storeId).toBe('2978')
  })

  it('reconoce el puesto nuevo "Excelencia Ventas" y lo trata como promotor', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const rows = parseStructure(
        wbAgo([
          ['BSSLPHUGO01', 'Hugo Raul Gonzalez Gonzalez', 'Supervisor', 'Isaac Mayoral', DASH, DASH, 'ACTIVACIONES'],
          ['BSSUPBRA01', 'Braulio Rodrigo Niño Burgos', 'Excelencia Ventas', 'Hugo Raul Gonzalez Gonzalez', DASH, DASH, 'ACTIVACIONES'],
        ]),
      )

      // Sin esto la fila se descartaba y Braulio desaparecía del plan en silencio.
      expect(rows).toHaveLength(2)
      expect(rows[1]).toMatchObject({ puesto: 'PROMOTOR', employeeCode: 'BSSUPBRA01', supervisorCode: 'BSSLPHUGO01' })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('🔴 "Reporta" MANDA sobre el orden de las filas', () => {
    // Yolanda aparece impresa bajo Elias pero reporta a Juan. Confiar en el orden
    // la colgaría del supervisor equivocado sin un solo error — que es justo la
    // clase de defecto que Isaac reportó ("quita a Yolanda de la estructura de Hugo").
    const rows = parseStructure(
      wbAgo([
        ['WMSNAOJ8201', 'Juan Joel Nájera Ortiz', 'Supervisor', 'Isaac Mayoral', DASH, DASH, DASH],
        ['WMQMEAE8008', 'Elias Medina Alarcón', 'Supervisor', 'Isaac Mayoral', DASH, DASH, DASH],
        ['BSSMRYOL08', 'Yolanda Gonzalez Zavala', 'Promotor', 'Juan Joel Nájera Ortiz', '2939', 'BAE', 'SEMINARIO'],
      ]),
    )

    expect(rows[2].supervisorCode).toBe('WMSNAOJ8201')
  })

  it('un "Reporta" que no es ningún supervisor del archivo cae al orden, sin perder la fila', () => {
    const rows = parseStructure(
      wbAgo([
        ['WMQMEAE8008', 'Elias Medina Alarcón', 'Supervisor', 'Isaac Mayoral', DASH, DASH, DASH],
        ['BEQJURR8002', 'Ricardo Juárez Rivera', 'Promotor', 'Alguien Que No Existe', '2978', 'BAE', 'RANCHO SAN PEDRO'],
      ]),
    )

    expect(rows).toHaveLength(2)
    expect(rows[1].supervisorCode).toBe('WMQMEAE8008')
  })

  it('resuelve "Reporta" sin importar acentos ni espacios de más', () => {
    const rows = parseStructure(
      wbAgo([
        ['WMQMEAE8008', 'Elías  Medina Alarcón', 'Supervisor', 'Isaac Mayoral', DASH, DASH, DASH],
        ['BEQJURR8002', 'Ricardo Juárez Rivera', 'Promotor', 'elias medina alarcon', '2978', 'BAE', 'RANCHO SAN PEDRO'],
      ]),
    )

    expect(rows[1].supervisorCode).toBe('WMQMEAE8008')
  })

  it('sin columna "Reporta" (formato viejo) sigue mandando el orden de las filas', () => {
    const rows = parseStructure(
      wb([
        ['WMQMEAE8008', 'Elias Medina Alarcón', 'Supervisor', 'Querétaro', 'Querétaro', DASH, DASH, DASH],
        ['BEQJURR8002', 'Ricardo Juárez Rivera', 'Promotor', 'Querétaro', 'Querétaro', '2978', 'BAE', 'RANCHO SAN PEDRO'],
      ]),
    )

    expect(rows[1].supervisorCode).toBe('WMQMEAE8008')
  })
})
