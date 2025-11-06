#!/usr/bin/env node
/**
 * Auto-update .unimportedrc.json to ignore files marked with @pending-implementation
 *
 * This script scans the src/ directory for files containing the @pending-implementation
 * marker and automatically adds them to the ignoreUnimported list in .unimportedrc.json
 *
 * Usage:
 *   node scripts/update-unused-ignore.js
 */

const fs = require('fs')
const path = require('path')
const glob = require('glob')

const CONFIG_FILE = path.join(__dirname, '..', '.unimportedrc.json')
const MARKER = '@pending-implementation'

async function findPendingFiles() {
  // Find all .ts and .js files in src/
  const files = glob.sync('src/**/*.{ts,js}', {
    cwd: path.join(__dirname, '..'),
    ignore: ['**/*.test.ts', '**/*.spec.ts', '**/node_modules/**'],
  })

  const pendingFiles = []

  for (const file of files) {
    const fullPath = path.join(__dirname, '..', file)
    const content = fs.readFileSync(fullPath, 'utf-8')

    // Check first 500 characters for the marker
    if (content.substring(0, 500).includes(MARKER)) {
      pendingFiles.push(file)
    }
  }

  return pendingFiles
}

async function updateConfig() {
  try {
    console.log('🔍 Scanning for @pending-implementation markers...')

    const pendingFiles = await findPendingFiles()

    if (pendingFiles.length === 0) {
      console.log('✅ No files with @pending-implementation marker found')
      return
    }

    console.log(`📝 Found ${pendingFiles.length} files with @pending-implementation:`)
    pendingFiles.forEach(file => console.log(`   - ${file}`))

    // Read current config
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))

    // Get existing ignoreUnimported (excluding pending files to refresh the list)
    const existingIgnores = (config.ignoreUnimported || []).filter(
      item => !item.includes('src/') || item.includes('.d.ts') || item.includes('ecosystem.config.js'),
    )

    // Add pending files
    config.ignoreUnimported = [...existingIgnores, ...pendingFiles.sort()]

    // Write updated config
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')

    console.log('✅ Updated .unimportedrc.json with pending files')
  } catch (error) {
    console.error('❌ Error updating config:', error.message)
    process.exit(1)
  }
}

updateConfig()
