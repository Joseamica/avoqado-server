/**
 * App de campo, bloque 3: el alta de versiones de producción de la app de campo frena el ACCIDENTE de subir un APK firmado
 * con otra llave. Lee la huella del certificado que el bloque de firma v2 declara (no verifica la firma: eso lo hacen el
 * celular y Android al instalar). El fixture es un zip mínimo firmado con apksigner y una llave de prueba desechable.
 */
import fs from 'fs'
import path from 'path'
import { huellaDelCertificadoDeclarado } from '@/services/apk/certificadoDeclarado'

const fixture = (n: string) => fs.readFileSync(path.join(__dirname, '../../../fixtures/apk', n))

it('lee la huella del certificado de un archivo firmado con apksigner (v2)', () => {
  // keytool -list -v del almacén de prueba: SHA256 del certificado «CN=Prueba Fixture, O=Avoqado QA, C=MX»
  expect(huellaDelCertificadoDeclarado(fixture('firmado-v2.zip'))).toBe('a69aa430401c0466883309aa7b35f8709e63a0beec6a8bb074b2f8cef6cc6068')
})

it('devuelve null para un zip sin bloque de firma', () => {
  expect(huellaDelCertificadoDeclarado(fixture('base.zip'))).toBeNull()
})

it('devuelve null para basura o un archivo truncado, sin lanzar', () => {
  expect(huellaDelCertificadoDeclarado(Buffer.from('no soy un zip'))).toBeNull()
  const firmado = fixture('firmado-v2.zip')
  expect(huellaDelCertificadoDeclarado(firmado.subarray(0, firmado.length - 30))).toBeNull()
})
