import fs from 'node:fs'
import path from 'node:path'
import { MASTER_ADMIN_PRINCIPAL_ID } from '@/lib/authPrincipals'

const SRC_ROOT = path.join(process.cwd(), 'src')
const PRINCIPAL_MODULE = path.join(SRC_ROOT, 'lib', 'authPrincipals.ts')

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(target)
    return entry.isFile() && entry.name.endsWith('.ts') ? [target] : []
  })
}

describe('MASTER_ADMIN protocol identity', () => {
  it('has one immutable production literal so auth and audit classification cannot drift silently', () => {
    expect(MASTER_ADMIN_PRINCIPAL_ID).toBe('MASTER_ADMIN')

    const duplicated = sourceFiles(SRC_ROOT)
      .filter(file => file !== PRINCIPAL_MODULE)
      .filter(file => /['"]MASTER_ADMIN['"]/.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(process.cwd(), file))

    expect(duplicated).toEqual([])
  })
})
