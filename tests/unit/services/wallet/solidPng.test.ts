/**
 * 🔴 Por qué existe este módulo, y por qué costó una prueba en un iPhone real:
 *
 * Apple EXIGE `icon.png` en todo `.pkpass`. Sin él, el pase se firma bien, la
 * cadena de certificados valida, y aun así el iPhone NO lo abre en Wallet: lo
 * degrada a una vista previa de archivo genérica ("Pass · 4 KB"). No hay mensaje
 * de error, no hay pista. Sólo se descubre abriéndolo en el teléfono.
 *
 * Generar el icono con el COLOR del negocio, en vez de meter uno de Avoqado,
 * mantiene la marca blanca: en las notificaciones el cliente ve el color de su
 * cafetería, no el de su proveedor de punto de venta.
 *
 * Se hace con zlib —que ya viene en Node— en vez de agregar una librería de
 * imágenes de la que dependería el camino de emisión.
 */
import { solidPng } from '../../../../src/services/wallet/solidPng'

const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function leerIHDR(png: Buffer) {
  // firma(8) + longitud(4) + "IHDR"(4) → ancho(4) alto(4)
  return { ancho: png.readUInt32BE(16), alto: png.readUInt32BE(20) }
}

describe('solidPng', () => {
  it('produce un PNG que empieza con la firma que Apple espera', () => {
    const png = solidPng(29, 29, '#7ADD2C')
    expect(png.subarray(0, 8).equals(FIRMA_PNG)).toBe(true)
  })

  it('lleva los tres bloques obligatorios de un PNG', () => {
    const png = solidPng(29, 29, '#7ADD2C')
    const s = png.toString('latin1')
    // Sin cualquiera de los tres, el archivo no es un PNG y Apple rechaza el pase
    // entero, no sólo el icono.
    expect(s).toContain('IHDR')
    expect(s).toContain('IDAT')
    expect(s).toContain('IEND')
  })

  it('respeta el tamaño pedido', () => {
    expect(leerIHDR(solidPng(29, 29, '#000000'))).toEqual({ ancho: 29, alto: 29 })
    // @2x es el que usan las pantallas Retina, o sea todas las actuales.
    expect(leerIHDR(solidPng(58, 58, '#000000'))).toEqual({ ancho: 58, alto: 58 })
  })

  it('un negocio sin color no rompe el icono: cae al de respaldo', () => {
    // Caso real: "Restaurante El Atole" tiene primaryColor = "" (cadena vacía).
    const vacio = solidPng(29, 29, '')
    const nulo = solidPng(29, 29, null)
    expect(vacio.subarray(0, 8).equals(FIRMA_PNG)).toBe(true)
    expect(nulo.subarray(0, 8).equals(FIRMA_PNG)).toBe(true)
    expect(vacio.length).toBeGreaterThan(50)
  })

  it('un color basura tampoco lo rompe', () => {
    expect(solidPng(29, 29, 'no-soy-un-color').subarray(0, 8).equals(FIRMA_PNG)).toBe(true)
  })

  it('colores distintos producen archivos distintos', () => {
    // Si salieran idénticos, el color simplemente no se estaría aplicando.
    expect(solidPng(29, 29, '#7ADD2C').equals(solidPng(29, 29, '#FF0000'))).toBe(false)
  })
})
