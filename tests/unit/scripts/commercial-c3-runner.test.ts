import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('commercial C3 isolated runner dependency safety', () => {
  it('executes the Prisma and Jest versions declared by the repository instead of letting npx download tools', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/commercial/run-c3-integration-tests.cjs'),
      'utf8',
    )

    expect(source).toContain("require.resolve('prisma/build/index.js')")
    expect(source).toContain("require.resolve('jest/bin/jest')")
    expect(source).toContain('COMMERCIAL_C3_NODE_MODULES')
    expect(source).toContain("symlinkSync(target, destination, 'dir')")
    expect(source).not.toContain("run('npx'")
  })
})
