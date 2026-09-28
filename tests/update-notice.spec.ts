import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import TestRenderer from 'react-test-renderer'
import type { ReactTestRendererJSON } from 'react-test-renderer'
import { WorkBuddyUpdateOverlay } from '../src/client/WorkBuddyUpdateNotice.tsx'
import { en } from '../src/client/locales.ts'
import type { WorkBuddySettingsKey } from '../src/client/locales.ts'
import { WorkBuddyUpdateStore } from '../src/client/update-store.ts'
import type { WorkBuddyUpdateSnapshot } from '../src/client/update-store.ts'

/**
 * What the floating seat renders — pinned at the style level, because the
 * host contract it must honour (click-through overlay, bottom-anchored
 * panel) is exactly what a DOM-less render can still prove.
 */

const t = (key: WorkBuddySettingsKey, params?: Record<string, unknown>): string => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

function baseSnapshot(): WorkBuddyUpdateSnapshot {
  return {
    status: 'update-available',
    currentVersion: '0.6.1',
    latestVersion: '0.6.4',
    releaseUrl: 'https://github.com/corrinehu/dsh-workbuddy-connect/releases/tag/v0.6.4',
    versionsBehind: 1,
    releases: [{ version: 'v0.6.4', name: 'v0.6.4 summary' }],
  }
}

function render(snapshot: WorkBuddyUpdateSnapshot): ReactTestRendererJSON | null {
  const updater = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    refresh: async () => {},
    dismiss: () => {},
  }
  const json = TestRenderer.create(createElement(WorkBuddyUpdateOverlay, { t, updater: updater as unknown as WorkBuddyUpdateStore })).toJSON()
  return Array.isArray(json) ? (json[0] ?? null) : json
}

describe('the floating update seat', () => {
  it('opts into pointer events and caps its height at the viewport', () => {
    const root = render(baseSnapshot())
    expect(root).not.toBeNull()
    const style = (root as ReactTestRendererJSON).props['style'] as Record<string, unknown>
    // The shell.overlay seat is click-through by contract; without this the
    // buttons cannot be clicked at all.
    expect(style['pointerEvents']).toBe('auto')
    // Bottom-anchored with an unbounded list: the panel must stay on screen.
    expect(style['maxHeight']).toBe('calc(100vh - 32px)')
    expect(style['overflowY']).toBe('auto')
    expect(style['bottom']).toBe(16)
    expect(style['right']).toBe(20)
  })

  it('renders nothing without an update, when dismissed, or on failure', () => {
    expect(render({ ...baseSnapshot(), status: 'up-to-date', latestVersion: '0.6.1' })).toBeNull()
    expect(render({ ...baseSnapshot(), status: 'unavailable' })).toBeNull()
    expect(render({ ...baseSnapshot(), dismissedNotice: '0.6.1:0.6.4' })).toBeNull()
  })

  it('shows one collapsed row per in-range release, not the notes', () => {
    const html = JSON.stringify(render({
      ...baseSnapshot(),
      versionsBehind: 2,
      releases: [
        { version: 'v0.6.4', name: 'v0.6.4 summary' },
        { version: 'v0.6.3', name: 'v0.6.3 summary', notes: 'hidden until opened' },
      ],
    }))
    expect(html).toContain('v0.6.4 summary')
    expect(html).toContain('v0.6.3 summary')
    expect(html).not.toContain('hidden until opened')
  })
})
