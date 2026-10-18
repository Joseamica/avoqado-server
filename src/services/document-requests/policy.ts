import { createHash, timingSafeEqual } from 'crypto'
import { BadRequestError, ConflictError, GoneError, NotFoundError } from '../../errors/AppError'

export const LIMITS = { maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxFiles: 24, maxUploadAttempts: 40 }
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
export function assertAccess(request: { tokenHash: string; status: string; expiresAt: Date } | null, token: string, write: boolean) {
  if (!request || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(hashToken(token)), Buffer.from(request.tokenHash)))
    throw new NotFoundError('Enlace no disponible')
  if (request.status === 'REVOKED' || request.expiresAt.getTime() <= Date.now()) throw new GoneError('Enlace no disponible')
  if (write && request.status !== 'OPEN') throw new ConflictError('Este expediente ya fue enviado')
}
const requirement = (key: string, label: string, description: string, maxFiles = 1) => ({
  key,
  label,
  description,
  required: true,
  maxFiles,
})
export function getRequirements(provider: string, entityType: string) {
  const rows = [
    requirement(
      'identification',
      entityType === 'PERSONA_MORAL' ? 'Identificación del representante' : 'Identificación oficial',
      provider === 'BLUMON'
        ? 'INE vigente por ambos lados o pasaporte vigente únicamente en formato libro.'
        : 'INE vigente por ambos lados o pasaporte vigente.',
      2,
    ),
    requirement(
      'address',
      'Comprobante de domicilio',
      provider === 'BLUMON'
        ? 'Comprobante de domicilio de entrega por cada sucursal, con antigüedad máxima de 3 meses.'
        : 'Comprobante de domicilio con antigüedad máxima de 3 meses.',
      provider === 'BLUMON' ? 8 : 1,
    ),
    requirement(
      'bank_cover',
      'Carátula bancaria',
      provider === 'BLUMON'
        ? 'Carátula con antigüedad máxima de 3 meses que muestre CLABE y nombre del titular; no transcribas números bancarios.'
        : 'Carátula a nombre del titular; no transcribas números bancarios.',
    ),
    requirement(
      'tax_certificate',
      'Constancia de situación fiscal',
      provider === 'ANGELPAY' && entityType === 'PERSONA_MORAL'
        ? 'Constancia reciente emitida por el SAT; nunca compartas tu contraseña.'
        : 'Constancia emitida por el SAT con antigüedad máxima de 3 meses; nunca compartas tu contraseña.',
    ),
  ]
  if (provider === 'ANGELPAY' && entityType === 'PERSONA_FISICA')
    rows.push(requirement('tax_opinion', 'Opinión de cumplimiento positiva', 'Opinión positiva emitida por el SAT.'))
  if (provider === 'BLUMON')
    rows.push(requirement('general_information', 'Generales del comercio', 'Información general del comercio requerida por Blumon.'))
  if (entityType === 'PERSONA_MORAL') {
    rows.push(
      requirement(
        'incorporation',
        'Acta constitutiva y modificaciones',
        'Acta constitutiva completa, todas sus modificaciones y protocolos correspondientes.',
        8,
      ),
    )
    if (provider === 'ANGELPAY')
      rows.push(
        requirement('public_registry', 'Registro Público', 'Inscripción en el Registro Público.'),
        requirement('powers', 'Poderes del representante', 'Poderes vigentes del representante legal.', 8),
      )
  }
  return rows
}
export function validateFile(file: { originalname: string; mimetype: string; buffer: Buffer; size: number }) {
  if (!file.size || file.size > LIMITS.maxFileBytes || file.size !== file.buffer.length)
    throw new BadRequestError('Archivo vacío o mayor de 8 MiB')
  const ext = file.originalname.split('.').pop()?.toLowerCase()
  const b = file.buffer
  const pdf = b.subarray(0, 5).toString() === '%PDF-'
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9
  const png = b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && b.subarray(-8, -4).toString() === 'IEND'
  if (
    !(
      (pdf && ext === 'pdf' && file.mimetype === 'application/pdf') ||
      (jpeg && ['jpg', 'jpeg'].includes(ext || '') && file.mimetype === 'image/jpeg') ||
      (png && ext === 'png' && file.mimetype === 'image/png')
    )
  )
    throw new BadRequestError('Sólo se aceptan archivos PDF, JPEG y PNG válidos')
  if (pdf) {
    const content = b.toString('latin1').replace(/#([a-f0-9]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    // shortcut: detects visible active names; compressed malicious payloads need a dedicated scanner.
    if (!/%%EOF\s*$/.test(content) || /\/(JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile|Filespec|RichMedia|XFA|Encrypt)\b/i.test(content))
      throw new BadRequestError('Este PDF tiene contenido activo, adjuntos o una estructura no admitida; exporta un PDF simple')
  }
  return {
    mimeType: file.mimetype,
    fileName: file.originalname
      .split(/[\\/]/)
      .pop()!
      // eslint-disable-next-line no-control-regex -- Uploaded filenames must not contain control characters.
      .replace(/[\x00-\x1f\x7f]/g, '')
      .slice(0, 180),
  }
}
export function assertComplete(
  provider: string,
  entityType: string,
  identificationType: string,
  documents: Array<{ key: string; mimeType: string }>,
) {
  for (const requirement of getRequirements(provider, entityType)) {
    if (!documents.some(d => d.key === requirement.key)) throw new BadRequestError(`Falta: ${requirement.label}`)
  }
  const ids = documents.filter(d => d.key === 'identification')
  if (identificationType === 'PASSPORT' && ids.length !== 1) throw new BadRequestError('Sube un solo archivo de pasaporte')
  if (provider === 'ANGELPAY' && identificationType === 'INE' && !ids.some(d => d.mimeType === 'application/pdf') && ids.length < 2)
    throw new BadRequestError('Sube ambos lados de la INE o un PDF que los incluya')
}
