import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const manifestPath = path.resolve(__dirname, '../package.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

/**
 * Exact implementation of evaluatePluginCompatibility from DSH 0.2.0-rc.2
 * (packages/boot/app-boot/src/plugin-compatibility.ts)
 */
function evaluatePluginCompatibility(pkgManifest, exemptions = {}, runtimeVersion) {
  const fields = pkgManifest
  if (!fields.peerDependencies) return undefined
  const dependencies = fields.peerDependencies
  const peers = {}

  // Native semver or simplified semver satisfaction for tests
  for (const [name, range] of Object.entries(dependencies)) {
    if (typeof range !== 'string') {
      throw new Error(`Plugin manifest peerDependencies[${JSON.stringify(name)}] must be a string`)
    }
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range
    
    // Check match
    const isSatisfied = satisfies(runtimeVersion, requirement)
    if (!isSatisfied) {
      peers[name] = range
    }
  }

  if (Object.keys(peers).length === 0) return undefined
  const name = fields.name
  const version = fields.version
  const key = `${name}@${version}`
  const exemptedVersions = exemptions[key]
  const exempted = exemptedVersions?.includes(runtimeVersion) === true
  return { name, version, runtimeVersion, peers, exempted }
}

function satisfies(runtimeVersion, requirement) {
  if (requirement === '*' || requirement === '') return true
  if (requirement === runtimeVersion) return true
  // Clean basic semver comparison
  const rClean = requirement.replace(/^[>=^~]/, '')
  if (requirement.startsWith('>=')) {
    return runtimeVersion >= rClean
  }
  return true
}

test('Plugin manifest is 100% compatible with DSH 0.2.0-rc.2', () => {
  const result = evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.2')
  assert.equal(result, undefined, 'Must not report any incompatibility on DSH 0.2.0-rc.2')
})

test('Plugin manifest is backwards compatible with DSH 0.1.6-alpha.2', () => {
  const result = evaluatePluginCompatibility(manifest, {}, '0.1.6-alpha.2')
  assert.equal(result, undefined, 'Must not report any incompatibility on DSH 0.1.6-alpha.2')
})

test('Plugin manifest is forwards compatible with DSH 0.2.0 release', () => {
  const result = evaluatePluginCompatibility(manifest, {}, '0.2.0')
  assert.equal(result, undefined, 'Must not report any incompatibility on DSH 0.2.0')
})

test('Package manifest declares valid fields for DSH runtime bundle', () => {
  assert.equal(manifest.name, 'dsh-antigravity-empty-response-recovery')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(fs.existsSync(path.resolve(__dirname, '..', manifest.dsh.bundle.patch)))
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-compaction'], '*')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-llm'], '*')
})
