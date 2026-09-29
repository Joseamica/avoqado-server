import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
  })

// The dashboard has no /dashboard/* route: an email or redirect built that way lands on its error page (28-sep).
const BROKEN = /FRONTEND_URL(?:\s*\|\|\s*'[^']*')?\}\/dashboard\b/

it('no link to the dashboard is built under /dashboard/*', () => {
  const offenders = files(join(__dirname, '../../../src')).filter(file => BROKEN.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})
