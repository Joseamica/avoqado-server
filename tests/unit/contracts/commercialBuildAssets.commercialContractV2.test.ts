import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

function jsonFiles(root: string, directory: string = root): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return jsonFiles(root, path)
      return entry.isFile() && entry.name.endsWith('.json') ? [relative(root, path)] : []
    })
    .sort()
}

describe('commercial contract production assets', () => {
  it('copies every raw commercial JSON file byte-for-byte through the package command', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'avoqado-commercial-contract-copy-'))
    const destination = join(temporaryRoot, 'dist', 'src', 'contracts', 'commercial')
    const source = join(process.cwd(), 'src', 'contracts', 'commercial')
    try {
      const result = spawnSync('npm', ['run', 'copy:commercial-contracts', '--', '--destination', destination], {
        cwd: process.cwd(),
        encoding: 'utf8',
      })
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })

      const expectedFiles = jsonFiles(source)
      expect(expectedFiles).toHaveLength(34)
      expect(expectedFiles).toEqual(
        expect.arrayContaining([
          'commercial-billing-v1.schema.json',
          'commercial-offer-v3.schema.json',
          'commercial-offer-resolution-v2.schema.json',
          'commercial-quote-v3.schema.json',
          'fixtures/v3/commercial-offer-v3.json',
          'fixtures/v3/commercial-offer-resolution-v2.json',
          'fixtures/v3/commercial-quote-v3-anonymous-preview.json',
          'fixtures/v3/commercial-quote-v3-bridged.json',
          'fixtures/v3/commercial-quote-v3-direct.json',
        ]),
      )
      expect(jsonFiles(destination)).toEqual(expectedFiles)
      for (const relativePath of expectedFiles) {
        expect(readFileSync(join(destination, relativePath))).toEqual(readFileSync(join(source, relativePath)))
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  })
})
