import crypto from 'crypto'

/**
 * Huella SHA-256 (pública) del certificado de la llave PROPIA de la app de campo (`:campo`, creada el 11-nov-2026;
 * docs/audit/2026-11-11-app-de-campo-bloque-3/llave-de-firma.md). Va en claro a propósito: es el candado, y un número en el
 * código no se cambia sin que se vea en el diff.
 */
export const HUELLA_DE_FIRMA_DE_CAMPO = 'd9d5375f270a0910c4ecf07080b33744aabf1d2366283771cf8340eaa6c91079'

/**
 * Huella SHA-256 (hex, minúsculas) del primer certificado del primer firmante que DECLARA el bloque de firma v2 de un APK
 * (https://source.android.com/docs/security/features/apksigning/v2), o `null` si no hay bloque v2 o el archivo no se
 * entiende.
 *
 * 🔴 NO es una verificación criptográfica: no comprueba la firma ni el contenido. Sólo frena el ACCIDENTE de subir a
 * producción un APK de la app de campo firmado con otra llave (la de debug), que dejaría a los celulares nuevos con una
 * firma que nunca podrá actualizarse. La verificación de verdad la hacen el celular antes de instalar y Android al
 * instalar; subir versiones es sólo de SUPERADMIN.
 */
export function huellaDelCertificadoDeclarado(apk: Buffer): string | null {
  try {
    const cd = inicioDelDirectorioCentral(apk)
    if (cd === null || cd < 32) return null
    if (apk.toString('latin1', cd - 16, cd) !== 'APK Sig Block 42') return null
    const tamano = Number(apk.readBigUInt64LE(cd - 24)) // no incluye su propio primer campo de 8 bytes
    const inicio = cd - tamano - 8
    if (inicio < 0 || Number(apk.readBigUInt64LE(inicio)) !== tamano) return null

    // Pares (uint64 largo, uint32 id, valor) entre el primer tamaño y el segundo tamaño + magia.
    let p = inicio + 8
    const fin = cd - 24
    while (p + 12 <= fin) {
      const largo = Number(apk.readBigUInt64LE(p))
      if (largo < 4 || p + 8 + largo > fin) return null
      if (apk.readUInt32LE(p + 8) === 0x7109871a) return huellaDelValorV2(apk.subarray(p + 12, p + 8 + largo))
      p += 8 + largo
    }
    return null
  } catch {
    return null
  }
}

/** Valor v2: firmantes → firmante → datos firmados → (resúmenes, certificados) → primer certificado. */
function huellaDelValorV2(v: Buffer): string | null {
  const firmantes = conPrefijo(v, 0)
  const firmante = conPrefijo(firmantes, 0)
  const datosFirmados = conPrefijo(firmante, 0)
  const resumenes = conPrefijo(datosFirmados, 0)
  const certificados = conPrefijo(datosFirmados, 4 + resumenes.length)
  const certificado = conPrefijo(certificados, 0)
  if (certificado.length === 0) return null
  return crypto.createHash('sha256').update(certificado).digest('hex')
}

/** Secuencia con prefijo uint32 de largo que empieza en `en`; lanza si se sale del buffer (el llamador da null). */
function conPrefijo(b: Buffer, en: number): Buffer {
  const largo = b.readUInt32LE(en)
  if (en + 4 + largo > b.length) throw new RangeError('largo fuera del bloque')
  return b.subarray(en + 4, en + 4 + largo)
}

/** Offset del directorio central según el registro de fin (EOCD), buscado desde el final (comentario ≤ 65535). */
function inicioDelDirectorioCentral(apk: Buffer): number | null {
  for (let i = apk.length - 22; i >= Math.max(0, apk.length - 22 - 65535); i--) {
    if (apk.readUInt32LE(i) === 0x06054b50) return apk.readUInt32LE(i + 16)
  }
  return null
}
