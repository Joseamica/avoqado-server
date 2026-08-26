/**
 * El contenido del pase es donde se cometen los errores caros de esta integración:
 * filtrar un identificador de cliente en un código de barras que cualquiera puede
 * leer con la cámara, o mandar un color en #hex que Apple ignora en silencio y deja
 * la tarjeta gris.
 *
 * Por eso el constructor es lógica PURA: no firma, no lee certificados, no toca
 * disco. Se puede probar entero sin tener un .p12 a la mano, que es justo lo que
 * permite que estas pruebas corran en CI y en la máquina de cualquiera.
 */
import { buildStoreCardPass, hexToRgbCss } from '../../../../src/services/wallet/applePassBuilder.service'

const brand = {
  name: 'Testarudo Café',
  logo: 'https://cdn.avoqado.io/logo.png',
  primaryColor: '#7ADD2C',
  secondaryColor: '#111111',
}
const content = { stampsEarned: 3, stampsRequired: 10, rewardLabel: 'Un café gratis' }
const base = {
  brand,
  content,
  serialNumber: 'AVQ-PASS-001',
  authToken: 'tok-auth-largo',
  qrToken: 'tok-qr-opaco',
  passTypeIdentifier: 'pass.io.avoqado.loyalty',
  teamIdentifier: 'TEAM123',
}

describe('buildStoreCardPass', () => {
  it('la tarjeta es del NEGOCIO, no de Avoqado', () => {
    const pass = buildStoreCardPass(base) as any
    // Marca blanca: el cliente guarda la tarjeta de su cafetería, no la de su
    // proveedor de punto de venta. Es la razón de que este producto se venda.
    expect(pass.organizationName).toBe('Testarudo Café')
    expect(pass.description).toContain('Testarudo Café')
    expect(pass.formatVersion).toBe(1)
    expect(pass.storeCard).toBeDefined()
  })

  it('🔴 el QR lleva el token opaco y NUNCA un dato del cliente', () => {
    const pass = buildStoreCardPass(base) as any
    expect(pass.barcodes[0].message).toBe('tok-qr-opaco')
    expect(pass.barcodes[0].format).toBe('PKBarcodeFormatQR')
    // El código de barras de un pase lo lee cualquiera que vea la pantalla del
    // cliente. Un customerId o un teléfono ahí es una fuga, no un detalle.
    const serializado = JSON.stringify(pass).toLowerCase()
    expect(serializado).not.toContain('customerid')
    expect(serializado).not.toContain('phone')
  })

  it('muestra el avance en lenguaje de persona, no de programador', () => {
    const pass = buildStoreCardPass(base) as any
    expect(pass.storeCard.headerFields[0].value).toBe('3/10')
    expect(pass.storeCard.secondaryFields[0].value).toBe('Un café gratis')
    // La etiqueta NO puede repetir el valor: con el placeholder por defecto salía
    // "Tu premio / Tu premio" en la tarjeta real, y se lee como un error.
    expect(pass.storeCard.secondaryFields[0].label).toBe('PREMIO')
  })

  it('🔴 NO usa primaryFields: taparían la banda de sellos', () => {
    const pass = buildStoreCardPass(base) as any
    // En un storeCard con banda, los campos primarios se dibujan ENCIMA de ella.
    // Poner ahí el conteo taparía justo los círculos, que son lo único que el
    // cliente mira. El conteo va al encabezado, arriba a la derecha.
    expect(pass.storeCard.primaryFields).toBeUndefined()
    expect(pass.storeCard.headerFields).toHaveLength(1)
  })

  it('el reverso explica cómo funciona, sin que el cliente pregunte', () => {
    const pass = buildStoreCardPass(base) as any
    const reverso = JSON.stringify(pass.storeCard.backFields)
    expect(reverso).toContain('10 sellos')
    expect(reverso).toContain('un café gratis')
    // Y dice quién emite la tarjeta y cómo deshacerse de ella: es marca blanca,
    // pero el cliente tiene derecho a saber de dónde salió.
    expect(reverso).toContain('Avoqado')
  })

  it('convierte el color de marca a rgb, que es lo único que Apple entiende', () => {
    // Un #hex no revienta: Apple lo ignora y pinta la tarjeta gris. El fallo es
    // invisible hasta que alguien la abre en un iPhone.
    expect(hexToRgbCss('#7ADD2C', 'rgb(0,0,0)')).toBe('rgb(122,221,44)')
    expect(hexToRgbCss('7ADD2C', 'rgb(0,0,0)')).toBe('rgb(122,221,44)')
    expect(isRgbBackground(buildStoreCardPass(base))).toBe(true)
  })

  it('un negocio sin colores configurados produce una tarjeta legible, no una rota', () => {
    const sinMarca = { ...base, brand: { ...brand, primaryColor: null, secondaryColor: null } }
    const pass = buildStoreCardPass(sinMarca) as any
    expect(pass.backgroundColor).toMatch(/^rgb\(\d+,\d+,\d+\)$/)
  })

  it('un color basura cae al de respaldo en vez de romper el pase', () => {
    expect(hexToRgbCss('no-es-un-color', 'rgb(1,2,3)')).toBe('rgb(1,2,3)')
    expect(hexToRgbCss('#ZZZ', 'rgb(1,2,3)')).toBe('rgb(1,2,3)')
  })

  it('el serial y el token de autenticación viajan dentro del pase', () => {
    const pass = buildStoreCardPass(base) as any
    // Apple usa el par (passTypeIdentifier, serialNumber) para reemplazar un pase
    // por su versión nueva. Si cambian, el iPhone instala una tarjeta duplicada.
    expect(pass.serialNumber).toBe('AVQ-PASS-001')
    expect(pass.passTypeIdentifier).toBe('pass.io.avoqado.loyalty')
    expect(pass.teamIdentifier).toBe('TEAM123')
    expect(pass.authenticationToken).toBe('tok-auth-largo')
  })
})

function isRgbBackground(pass: Record<string, unknown>): boolean {
  return /^rgb\(\d+,\d+,\d+\)$/.test(String((pass as any).backgroundColor))
}
