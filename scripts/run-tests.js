import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const files = findTestFiles('test')
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
})

process.exit(result.status || 0)

function findTestFiles(root) {
  if (!fs.existsSync(root)) {
    return []
  }

  const files = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...findTestFiles(absolute))
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(absolute)
    }
  }

  return files.sort()
}
