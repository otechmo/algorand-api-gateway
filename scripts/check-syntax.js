import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const roots = ['src', 'test', 'scripts']
const files = roots.flatMap((root) => findJavaScriptFiles(root))
let failed = false

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    failed = true
  }
}

process.exit(failed ? 1 : 0)

function findJavaScriptFiles(root) {
  if (!fs.existsSync(root)) {
    return []
  }

  const files = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...findJavaScriptFiles(absolute))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(absolute)
    }
  }

  return files
}
