import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

it('keeps legacy help byte-identical while copying four products into a separate corpus', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-help-sync-'))
  try {
    const server = path.join(root, 'server'),
      help = path.join(root, 'landing/src/content/help')
    fs.mkdirSync(path.join(server, 'scripts'), { recursive: true })
    fs.copyFileSync(path.resolve('scripts/sync-mcp-help.sh'), path.join(server, 'scripts/sync-mcp-help.sh'))
    const manual = path.join(server, 'src/assets/mcp-knowledge/help/_overview.md')
    fs.mkdirSync(path.dirname(manual), { recursive: true })
    fs.writeFileSync(manual, 'Manual legacy sin cambio')
    for (const product of ['dashboard', 'android', 'windows', 'tpv']) {
      const filename = path.join(help, product, 'inicio/entrar.md')
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      fs.writeFileSync(filename, `Artículo de ${product}\n`)
    }
    execFileSync('bash', [path.join(server, 'scripts/sync-mcp-help.sh'), path.join(help, 'dashboard')])
    expect(fs.readFileSync(manual, 'utf8')).toBe('Manual legacy sin cambio')
    expect(fs.readFileSync(path.join(server, 'src/assets/mcp-knowledge/help/inicio/entrar.md'), 'utf8')).toBe('Artículo de dashboard\n')
    expect(fs.readdirSync(path.join(server, 'src/assets/mcp-knowledge/help')).sort()).toEqual(['_overview.md', 'inicio'])
    fs.writeFileSync(path.join(help, 'dashboard/inicio/entrar.md'), 'Nueva revisión de soporte\n')
    execFileSync('bash', [path.join(server, 'scripts/sync-mcp-help.sh'), path.join(help, 'dashboard'), '--support-only'])
    expect(fs.readFileSync(path.join(server, 'src/assets/mcp-knowledge/help/inicio/entrar.md'), 'utf8')).toBe('Artículo de dashboard\n')
    for (const product of ['dashboard', 'android', 'windows', 'tpv']) {
      expect(fs.readFileSync(path.join(server, 'src/assets/mcp-support-help', product, 'inicio/entrar.md'), 'utf8')).toBe(
        product === 'dashboard' ? 'Nueva revisión de soporte\n' : `Artículo de ${product}\n`,
      )
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
