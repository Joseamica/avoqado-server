import {
  hashToken,
  assertAccess,
  getRequirements,
  validateFile,
  assertComplete,
  LIMITS,
} from '../../../src/services/document-requests/policy'

describe('document requests security policy', () => {
  const token = 'ab'.repeat(32)
  const request = () => ({ tokenHash: hashToken(token), status: 'OPEN', expiresAt: new Date(Date.now() + 60000) })
  test('only a valid invitation can read; submitted invitations cannot write', () => {
    expect(() => assertAccess(request(), token, false)).not.toThrow()
    expect(() => assertAccess(request(), '00'.repeat(32), false)).toThrow()
    expect(() => assertAccess({ ...request(), status: 'REVOKED' }, token, false)).toThrow()
    expect(() => assertAccess({ ...request(), expiresAt: new Date(0) }, token, false)).toThrow()
    expect(() => assertAccess({ ...request(), status: 'SUBMITTED' }, token, true)).toThrow()
    expect(() => assertAccess({ ...request(), status: 'SUBMITTED' }, token, false)).not.toThrow()
  })
  test.each(['ANGELPAY', 'BLUMON'])('%s has distinct physical/moral requirements', provider => {
    const pf = getRequirements(provider, 'PERSONA_FISICA')
    const pm = getRequirements(provider, 'PERSONA_MORAL')
    expect(pf.some(r => r.key === 'identification')).toBe(true)
    expect(pm.some(r => r.key === 'incorporation')).toBe(true)
    expect(pf.some(r => r.key === 'incorporation')).toBe(false)
  })
  test('validates content, extension, MIME, size and active PDFs', () => {
    const pdf = (content: string, name = 'a.pdf', mime = 'application/pdf') => ({
      originalname: name,
      mimetype: mime,
      buffer: Buffer.from(content),
      size: Buffer.byteLength(content),
    })
    expect(() => validateFile(pdf('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF'))).not.toThrow()
    expect(() => validateFile(pdf('<html>bad</html>'))).toThrow()
    expect(() => validateFile(pdf('%PDF-1.7\n/JavaScript (evil)\n%%EOF'))).toThrow()
    expect(() => validateFile(pdf('%PDF-1.7\n/Jav#61Script (evil)\n%%EOF'))).toThrow()
    expect(() => validateFile(pdf('%PDF-1.7\n%%EOF', 'a.svg'))).toThrow()
    expect(() => validateFile({ ...pdf('%PDF-1.7\n%%EOF'), size: LIMITS.maxFileBytes + 1 })).toThrow()
  })
  test('AngelPay INE requires both sides unless a PDF; passport requires one', () => {
    const rows = getRequirements('ANGELPAY', 'PERSONA_FISICA').map(r => ({ key: r.key, mimeType: 'application/pdf' }))
    const images = rows.map(r => (r.key === 'identification' ? { ...r, mimeType: 'image/jpeg' } : r))
    expect(() => assertComplete('ANGELPAY', 'PERSONA_FISICA', 'INE', rows)).not.toThrow()
    expect(() => assertComplete('ANGELPAY', 'PERSONA_FISICA', 'INE', images)).toThrow()
    expect(() =>
      assertComplete('ANGELPAY', 'PERSONA_FISICA', 'INE', [...images, { key: 'identification', mimeType: 'image/jpeg' }]),
    ).not.toThrow()
    expect(() => assertComplete('ANGELPAY', 'PERSONA_FISICA', 'PASSPORT', images)).not.toThrow()
  })
})
