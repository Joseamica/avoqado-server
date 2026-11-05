/**
 * D5 (4-nov-2026): armar y firmar la credencial de Apple Wallet retenía el hilo del servidor 0.3-0.9 s por
 * credencial en producción (1.4-1.9 s el 2-nov), según `[event-loop] hilo retenido` en Better Stack. La firma
 * PKCS#7 de passkit-generator va con node-forge, en JavaScript puro. Mientras tanto ningún cobro avanza.
 *
 * Aquí se firma DE VERDAD (passkit-generator real en el hilo aparte, certificado de juguete) y se amarra:
 * 1. que en el hilo principal NO se arma ni se firma el pase: su passkit-generator está remplazado por uno que
 *    truena (los mocks de jest no llegan al hilo aparte, que carga el real);
 * 2. que el archivo sigue siendo un .pkpass completo: los archivos, su manifiesto con la huella de cada uno y la firma.
 * (Con una llave de 4096 bits la firma en el hilo principal tardó 17.8 s sin soltarlo: por eso importa.)
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
// @ts-expect-error node-forge no trae tipos (passkit-generator lo usa por dentro); no se instala @types sólo para esta prueba
import forge from 'node-forge'

const envMock: Record<string, string | undefined> = {}
const mockPkpassEnHiloPrincipal = jest.fn(() => {
  throw new Error('el pase se armó en el hilo principal')
})
jest.mock('passkit-generator', () => ({ PKPass: mockPkpassEnHiloPrincipal }))
jest.mock('../../../../src/config/env', () => ({
  get env() {
    return envMock
  },
}))

import { signPass } from '../../../../src/services/wallet/applePassSigner.service'

/** La clave de la llave de juguete se inventa en cada corrida: nada que parezca una contraseña queda escrito en el código. */
const CLAVE_DE_JUGUETE = randomBytes(12).toString('hex')

function certificadoDeJuguete() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const llavePem = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: CLAVE_DE_JUGUETE }) as string
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }) as string)
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 86_400_000)
  const nombre = [{ name: 'commonName', value: 'd5-juguete' }]
  cert.setSubject(nombre)
  cert.setIssuer(nombre)
  cert.sign(forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string), forge.md.sha256.create())
  return { certPem: forge.pki.certificateToPem(cert), llavePem }
}

/** Lee las entradas de un zip sin comprimir (passkit-generator usa do-not-zip). */
function entradasDelZip(zip: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {}
  let i = 0
  while (zip.readUInt32LE(i) === 0x04034b50) {
    const tamano = zip.readUInt32LE(i + 18)
    const largoNombre = zip.readUInt16LE(i + 26)
    const largoExtra = zip.readUInt16LE(i + 28)
    const nombre = zip.subarray(i + 30, i + 30 + largoNombre).toString()
    const inicio = i + 30 + largoNombre + largoExtra
    out[nombre] = zip.subarray(inicio, inicio + tamano)
    i = inicio + tamano
  }
  return out
}

describe('signPass arma y firma la credencial en un hilo aparte (D5)', () => {
  beforeAll(() => {
    const { certPem, llavePem } = certificadoDeJuguete()
    Object.assign(envMock, {
      APPLE_PASS_TYPE_ID: 'pass.io.avoqado.prueba',
      APPLE_TEAM_ID: 'TEAM123',
      APPLE_PASS_CERT_PEM_BASE64: Buffer.from(certPem).toString('base64'),
      APPLE_PASS_KEY_PEM_BASE64: Buffer.from(llavePem).toString('base64'),
      APPLE_PASS_KEY_PASSWORD: CLAVE_DE_JUGUETE,
      APPLE_WWDR_PEM_BASE64: Buffer.from(certPem).toString('base64'),
    })
  })

  it('el hilo principal no arma ni firma el pase, y sale un .pkpass completo', async () => {
    const passJson = {
      formatVersion: 1,
      passTypeIdentifier: 'pass.io.avoqado.prueba',
      teamIdentifier: 'TEAM123',
      serialNumber: 'AVQ-prueba',
      organizationName: 'Negocio de prueba',
      description: 'Tarjeta de lealtad',
      storeCard: {},
    }

    const pase = await signPass(passJson, { brandColor: '#123456', stamps: { earned: 3, required: 10 } })

    expect(mockPkpassEnHiloPrincipal).not.toHaveBeenCalled()
    const archivos = entradasDelZip(pase)
    expect(Object.keys(archivos)).toEqual(
      expect.arrayContaining([
        'pass.json',
        'icon.png',
        'icon@2x.png',
        'logo.png',
        'logo@2x.png',
        'strip.png',
        'strip@2x.png',
        'manifest.json',
        'signature',
      ]),
    )
    expect(JSON.parse(archivos['pass.json'].toString()).serialNumber).toBe('AVQ-prueba')
    const manifiesto = JSON.parse(archivos['manifest.json'].toString()) as Record<string, string>
    for (const [nombre, huella] of Object.entries(manifiesto)) {
      expect(huella).toBe(createHash('sha1').update(archivos[nombre]).digest('hex'))
    }
    expect(archivos['signature'].length).toBeGreaterThan(500)
  }, 60_000)
})
