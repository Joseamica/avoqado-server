#!/usr/bin/env node
/**
 * Build step: copy the docs allowlisted in src/mcp/knowledge/internal-docs.json into dist/docs so
 * the SUPERADMIN-only `avoqado_internal_docs` MCP tool can read them in production (the Docker
 * image ships dist/ only — never the repo's docs/). Only the allowlist is copied: nothing else
 * from docs/ (support tickets, handoffs, plans) ever enters the image.
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const { docs } = JSON.parse(fs.readFileSync(path.join(root, 'src/mcp/knowledge/internal-docs.json'), 'utf8'))
const outDir = path.join(root, 'dist/docs')
fs.mkdirSync(outDir, { recursive: true })

let copied = 0
const missing = []
for (const name of docs) {
  const src = path.join(root, 'docs', `${name}.md`)
  if (!fs.existsSync(src)) {
    missing.push(name)
    continue
  }
  fs.copyFileSync(src, path.join(outDir, `${name}.md`))
  copied++
}
console.log(`copy-mcp-internal-docs: ${copied}/${docs.length} docs → dist/docs${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`)
