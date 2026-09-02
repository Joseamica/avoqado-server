const { copyFileSync, mkdirSync, readdirSync, statSync } = require('node:fs')
const { dirname, extname, join, relative, resolve, sep } = require('node:path')

function destinationArgument(arguments_) {
  if (arguments_.length === 0) return resolve(process.cwd(), 'dist', 'src', 'contracts', 'commercial')
  if (arguments_.length === 2 && arguments_[0] === '--destination') return resolve(arguments_[1])
  throw new Error('Usage: copy-commercial-contract-json.js [--destination PATH]')
}

function commercialJsonFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    .flatMap(entry => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return commercialJsonFiles(root, path)
      return entry.isFile() && extname(entry.name) === '.json' ? [relative(root, path)] : []
    })
}

function main() {
  const source = resolve(process.cwd(), 'src', 'contracts', 'commercial')
  const destination = destinationArgument(process.argv.slice(2))
  if (!statSync(source).isDirectory()) throw new Error(`Commercial contract source is not a directory: ${source}`)
  if (destination === source || destination.startsWith(`${source}${sep}`)) {
    throw new Error('Commercial contract destination must be outside its source directory')
  }

  const files = commercialJsonFiles(source)
  for (const relativePath of files) {
    const target = join(destination, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(source, relativePath), target)
  }
  process.stdout.write(`Copied ${files.length} raw commercial contract JSON files to ${destination}\n`)
}

main()
