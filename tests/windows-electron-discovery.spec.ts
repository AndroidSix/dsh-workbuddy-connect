import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  electronDiscoveryFor,
  WorkBuddyAtRestKeyProvider,
  WORKBUDDY_ELECTRON_BIN_ENV,
  deriveProtectorKey,
} from '../src/desktop-credential-protection.ts'
import type { WorkBuddyWindowsDiscoveryTools } from '../src/desktop-credential-protection.ts'
import { CN_VARIANT, AI_VARIANT } from '../src/variants.ts'

const SECRET = Buffer.alloc(32, 9).toString('base64')
const PAYLOAD_TEXT = JSON.stringify({ version: 1, atRestSecretKey: SECRET })
const KEY = deriveProtectorKey(SECRET)
const KEY_ID = createHash('sha256').update(KEY).digest('hex').slice(0, 16)

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-windows-electron-discovery-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

async function windowsCandidate(name = 'WorkBuddy.exe', options: {
  version?: string
  appAsar?: boolean
  installRoot?: string
} = {}): Promise<string> {
  const installRoot = options.installRoot ?? join(root, name.replace(/\.exe$/iu, ''))
  const electronPath = join(installRoot, name)
  await mkdir(join(installRoot, 'resources'), { recursive: true })
  await writeFile(electronPath, '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(join(installRoot, 'version'), options.version ?? '37.10.3-24')
  if (options.appAsar !== false) await writeFile(join(installRoot, 'resources', 'app.asar'), '')
  return electronPath
}

function registryOutput(entries: readonly { name: string, icon: string, installLocation?: string }[]): string {
  return entries.map((entry, index) => [
    `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{TEST-${String(index)}}`,
    `    DisplayName    REG_SZ    ${entry.name}`,
    `    DisplayIcon    REG_SZ    ${entry.icon}`,
    `    InstallLocation REG_SZ    ${entry.installLocation ?? ''}`,
    '    UninstallString REG_SZ    "C:\\Program Files\\WorkBuddy\\Uninstall WorkBuddy.exe" /currentuser',
  ].join('\r\n')).join('\r\n')
}

function fakeWindowsTools(
  output: string,
  options: { fail?: boolean, calls?: string[] } = {},
): WorkBuddyWindowsDiscoveryTools {
  return {
    queryUninstallRoot: async rootName => {
      options.calls?.push(rootName)
      if (options.fail === true) throw new Error('registry unavailable')
      return output
    },
  }
}

function provider(tools: WorkBuddyWindowsDiscoveryTools, defaultElectronPath = join(root, 'missing', 'WorkBuddy.exe')): WorkBuddyAtRestKeyProvider {
  return new WorkBuddyAtRestKeyProvider({
    discovery: 'windows-workbuddy',
    platform: 'win32',
    defaultElectronPath,
    windowsTools: tools,
    spawnHelper: async () => PAYLOAD_TEXT,
  })
}

describe('issue #53 discovery routing', () => {
  it('routes CN by platform and leaves Global disabled everywhere', () => {
    expect(electronDiscoveryFor(CN_VARIANT, 'darwin')).toBe('macos-workbuddy')
    expect(electronDiscoveryFor(CN_VARIANT, 'win32')).toBe('windows-workbuddy')
    expect(electronDiscoveryFor(CN_VARIANT, 'linux')).toBe('none')
    expect(electronDiscoveryFor(CN_VARIANT, 'freebsd')).toBe('none')
    expect(electronDiscoveryFor(AI_VARIANT, 'darwin')).toBe('none')
    expect(electronDiscoveryFor(AI_VARIANT, 'win32')).toBe('none')
    expect(electronDiscoveryFor(AI_VARIANT, 'linux')).toBe('none')
  })

  it('routes CN Linux to the existing unavailable path without discovery', async () => {
    const calls: string[] = []
    const keyProvider = new WorkBuddyAtRestKeyProvider({
      discovery: electronDiscoveryFor(CN_VARIANT, 'linux'),
      platform: 'linux',
      windowsTools: fakeWindowsTools('', { calls }),
    })
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-unavailable' })
    expect(calls).toEqual([])
  })
})

describe('Windows default and registry discovery', () => {
  it('uses the LOCALAPPDATA default without querying the registry', async () => {
    vi.stubEnv('LOCALAPPDATA', root)
    const defaultPath = join(root, 'Programs', 'WorkBuddy', 'WorkBuddy.exe')
    await mkdir(dirname(defaultPath), { recursive: true })
    await writeFile(defaultPath, '#!/bin/sh\n', { mode: 0o755 })
    const calls: string[] = []
    const keyProvider = new WorkBuddyAtRestKeyProvider({
      discovery: 'windows-workbuddy',
      platform: 'win32',
      windowsTools: fakeWindowsTools('', { calls, fail: true }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(keyProvider.helperPath()).toBe(defaultPath)
    expect(calls).toEqual([])
  })

  it('does not guess a path when LOCALAPPDATA is missing', async () => {
    vi.stubEnv('LOCALAPPDATA', '')
    const calls: string[] = []
    const keyProvider = new WorkBuddyAtRestKeyProvider({
      discovery: 'windows-workbuddy',
      platform: 'win32',
      windowsTools: fakeWindowsTools('', { calls }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-not-found' })
    expect(keyProvider.helperPath()).toBeUndefined()
    expect(calls).toHaveLength(3)
    expect((keyProvider.helperPath() ?? '')).not.toMatch(/Users|AppData/iu)
  })

  it('falls back to registry DisplayIcon after the default path fails', async () => {
    const candidate = await windowsCandidate()
    const tools = fakeWindowsTools(registryOutput([{ name: 'WorkBuddy 5.6.2', icon: `"${candidate},0"` }]))
    const keyProvider = provider(tools)
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(keyProvider.helperPath()).toBe(candidate)
  })

  it('ignores empty InstallLocation and uses a quoted DisplayIcon with an icon index', async () => {
    const candidate = await windowsCandidate()
    const keyProvider = provider(fakeWindowsTools(registryOutput([
      { name: 'WorkBuddy', icon: `"${candidate},12"`, installLocation: '' },
    ])))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(keyProvider.helperPath()).toBe(candidate)
  })

  it('accepts an unquoted DisplayIcon path containing spaces', async () => {
    const candidate = await windowsCandidate('WorkBuddy.exe', {
      installRoot: join(root, 'Program Files', 'WorkBuddy'),
    })
    const keyProvider = provider(fakeWindowsTools(registryOutput([
      { name: 'WorkBuddy', icon: `${candidate},0` },
    ])))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(keyProvider.helperPath()).toBe(candidate)
  })

  it('excludes WorkBuddy AI and non-primary RepairApp/Uninstall candidates', async () => {
    const ai = await windowsCandidate('WorkBuddy AI.exe')
    const repair = await windowsCandidate('RepairApp.exe')
    const uninstall = await windowsCandidate('Uninstall WorkBuddy.exe')
    const output = registryOutput([
      { name: 'WorkBuddy AI', icon: `"${ai},0"` },
      { name: 'WorkBuddy', icon: `"${repair},0"` },
      { name: 'WorkBuddy', icon: `"${uninstall},0"` },
    ])
    const keyProvider = provider(fakeWindowsTools(output))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-not-found' })
  })
})

describe('Windows candidate identity and failure semantics', () => {
  const invalidCandidates: readonly [string, { version?: string, appAsar?: boolean }, boolean][] = [
    ['missing version', {}, true],
    ['invalid version', { version: 'not-an-electron-version' }, false],
    ['missing resources/app.asar', { appAsar: false }, false],
  ]

  it.each(invalidCandidates)('rejects a candidate with %s', async (_label, options, removeVersion) => {
    const candidate = await windowsCandidate('WorkBuddy.exe', options)
    if (removeVersion) await rm(join(dirname(candidate), 'version'))
    const keyProvider = provider(fakeWindowsTools(registryOutput([{ name: 'WorkBuddy', icon: `"${candidate},0"` }])))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-not-found' })
  })

  it('folds duplicate and realpath aliases into one candidate', async () => {
    const candidate = await windowsCandidate()
    const aliasRoot = join(root, 'Alias')
    await symlink(dirname(candidate), aliasRoot, 'junction')
    const alias = join(aliasRoot, 'WorkBuddy.exe')
    const output = registryOutput([
      { name: 'WorkBuddy', icon: `"${candidate},0"` },
      { name: 'WorkBuddy', icon: `"${alias},0"` },
    ])
    const keyProvider = provider(fakeWindowsTools(output))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
  })

  it('reports incomplete when a good candidate sits beside an unresolved registry candidate', async () => {
    const candidate = await windowsCandidate()
    const output = registryOutput([
      { name: 'WorkBuddy', icon: `"${candidate},0"` },
      { name: 'WorkBuddy', icon: '"\u0000uninspectable/WorkBuddy.exe,0"' },
    ])
    const keyProvider = provider(fakeWindowsTools(output))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-discovery-incomplete' })
  })

  it.each(['missing', 'malformed'])('reports incomplete when a matching registry entry has a %s DisplayIcon', async kind => {
    const good = await windowsCandidate()
    const goodEntry = registryOutput([{ name: 'WorkBuddy', icon: `"${good},0"` }])
    const brokenEntry = kind === 'missing'
      ? registryOutput([{ name: 'WorkBuddy', icon: '' }]).replace(/^    DisplayIcon.*\r?\n/gmu, '')
      : registryOutput([{ name: 'WorkBuddy', icon: '"unterminated/WorkBuddy.exe,0' }])
    const keyProvider = provider(fakeWindowsTools(`${goodEntry}\r\n${brokenEntry.replace('{TEST-0}', '{TEST-1}')}`))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-discovery-incomplete' })
  })

  it('reports incomplete for registry failures instead of not-found', async () => {
    const keyProvider = provider(fakeWindowsTools('', { fail: true }))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-discovery-incomplete' })
  })

  it('reports incomplete when a registry query times out', async () => {
    let first = true
    const tools: WorkBuddyWindowsDiscoveryTools = {
      queryUninstallRoot: async (_rootName, signal) => {
        if (!first) return ''
        first = false
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('timed out')) }, { once: true })
        })
        return ''
      },
    }
    const keyProvider = new WorkBuddyAtRestKeyProvider({
      discovery: 'windows-workbuddy',
      platform: 'win32',
      defaultElectronPath: join(root, 'missing', 'WorkBuddy.exe'),
      windowsTools: tools,
      discoveryBudgetMs: 10,
    })
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-discovery-incomplete' })
  })

  it('reports not-found after all registry roots complete with no legal candidate', async () => {
    const keyProvider = provider(fakeWindowsTools(''))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-not-found' })
  })

  it('reports ambiguous when two legal candidates remain', async () => {
    // Build two legal roots with the exact basename required by the candidate
    // validator; the registry strings exercise independent install roots.
    const firstRoot = join(root, 'First')
    const secondRoot = join(root, 'Second')
    await mkdir(join(firstRoot, 'resources'), { recursive: true })
    await mkdir(join(secondRoot, 'resources'), { recursive: true })
    await writeFile(join(firstRoot, 'WorkBuddy.exe'), '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(join(secondRoot, 'WorkBuddy.exe'), '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(join(firstRoot, 'version'), '37.10.3-24')
    await writeFile(join(secondRoot, 'version'), '37.10.3-24')
    await writeFile(join(firstRoot, 'resources', 'app.asar'), '')
    await writeFile(join(secondRoot, 'resources', 'app.asar'), '')
    const legalOutput = registryOutput([
      { name: 'WorkBuddy', icon: `"${join(firstRoot, 'WorkBuddy.exe')},0"` },
      { name: 'WorkBuddy', icon: `"${join(secondRoot, 'WorkBuddy.exe')},0"` },
    ])
    const keyProvider = provider(fakeWindowsTools(legalOutput))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-ambiguous' })
  })
})

describe('Windows priority, cache, and explicit paths', () => {
  it('does not fall back after an explicit option or env path fails', async () => {
    const candidate = await windowsCandidate()
    const calls: string[] = []
    const tools = fakeWindowsTools(registryOutput([{ name: 'WorkBuddy', icon: `"${candidate},0"` }]), { calls })
    const optionProvider = new WorkBuddyAtRestKeyProvider({
      electronPath: join(root, 'missing-option.exe'),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      defaultElectronPath: candidate,
      windowsTools: tools,
    })
    await expect(optionProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-path-invalid' })

    vi.stubEnv(WORKBUDDY_ELECTRON_BIN_ENV, join(root, 'missing-env.exe'))
    const envProvider = provider(tools, candidate)
    await expect(envProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-path-invalid' })
    expect(calls).toEqual([])
  })

  it('caches a successful discovery and re-discovers after the path disappears', async () => {
    const candidate = await windowsCandidate()
    const calls: string[] = []
    const keyProvider = provider(fakeWindowsTools(registryOutput([{ name: 'WorkBuddy', icon: `"${candidate},0"` }]), { calls }))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(calls).toHaveLength(3)
    await rm(candidate)
    await expect(keyProvider.protectorKeyFor(['ffffffffffffffff'])).rejects.toMatchObject({ reasonCode: 'electron-binary-not-found' })
    expect(calls).toHaveLength(6)
  })
})
