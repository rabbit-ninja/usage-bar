import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'usage-bar',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

const LIMITS = [
  { kind: 'five_hour', percentUsed: 42, resetsAt: '2099-01-01T00:00:00Z' },
  { kind: 'seven_day', percentUsed: 10, resetsAt: '2099-01-01T00:00:00Z' },
]

// Stands for the engine; hooks go in before the test's first call on $
const engine = (on: any) => {
  on('clock.now', () => ({ value: Date.parse('2026-01-01T00:00:00Z') }))
  on('session.measure', (_: unknown, e: unknown) => e)
}

// Reports one measurement to the mod, as the engine does after a turn
const measure = ($: any, percent: number | undefined, rateLimits: unknown[] = LIMITS) =>
  $.session.measure({ context: { window: 200000, percent }, rateLimits, changed: ['context'] })

test('nothing is drawn before the first reading', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  }
})

test('limits on the left, context and Compact on the right', async ($, on) => {
  engine(on)
  await measure($, 55)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'Session' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Week' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^resets \d+d \d+h$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^55%$/ }))?.text).toBe('55%')
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
    await ui.unmount()
  }
})

test('on an API key the band shows context alone', async ($, on) => {
  engine(on)
  await measure($, 20, [])

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Session' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
  await ui.unmount()
})

test('Compact is disabled while it runs, then comes back', async ($, on) => {
  engine(on)
  let calls = 0
  let finish!: () => void
  on('session.compact', () => {
    calls++
    return new Promise(resolve => {
      finish = () => resolve({ skip: 'test' })
    })
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000, percent: 12 }, rateLimits: LIMITS },
  }))
  await measure($, 90)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const pressed = ui.press({ key: 'compact' })

  await settle()
  expect(calls).toBe(1)
  expect(await ui.find({ type: 'Button', key: 'compact' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Compacting/ })).toBeDefined()

  finish()
  await pressed
  expect(calls).toBe(1)
  expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^12%$/ })).toBeDefined()
  await ui.unmount()
})

test('a refused compaction shows a toast and keeps the button', async ($, on) => {
  engine(on)
  const toasts: string[] = []
  on('session.compact', () => {
    throw new Error('a turn is running')
  })
  on('ui.toast', (_, e: any) => {
    toasts.push(typeof e === 'string' ? e : e.text)
    return { value: undefined }
  })
  await measure($, 90)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'compact' })
  expect(toasts).toEqual(['Compact once the current turn finishes'])
  expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
  await ui.unmount()
})

// Starts the session with the given installed and released versions
const start = async ($: any, on: any, local: string, remote: { ok: boolean; text: string } | 'offline') => {
  engine(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: LIMITS } }))
  // Refusing the first period ends the minute timer, which this test has no use for
  on('clock.every', () => {
    throw new Error('no timers here')
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: JSON.stringify({ name: 'usage-bar', version: local }) }))
  on('http.fetch', () => {
    if (remote === 'offline') throw new Error('offline')
    return { value: { status: remote.ok ? 200 : 404, headers: {}, ...remote } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

// Gives the background check time to finish
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

test('a newer release shows an update button that explains how', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(typeof e === 'string' ? e : e.text)
    return { value: undefined }
  })
  await start($, on, '0.9.0', { ok: true, text: JSON.stringify({ version: '0.10.0' }) })
  await settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Button', key: 'update' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Session' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'update' })
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('v0.10.0')
  await ui.unmount()
})

for (const [name, local, remote] of [
  ['the same version', '0.2.0', { ok: true, text: '{"version":"0.2.0"}' }],
  ['an older release', '0.2.0', { ok: true, text: '{"version":"0.1.9"}' }],
  ['a failed fetch', '0.2.0', { ok: false, text: 'Not Found' }],
  ['a garbled manifest', '0.2.0', { ok: true, text: '<html>' }],
  ['no network', '0.2.0', 'offline'],
] as const) {
  test(`no update button for ${name}`, async ($, on) => {
    await start($, on, local, remote)
    await settle()
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Button', key: 'update' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Session' })).toBeDefined()
    await ui.unmount()
  })
}

test('on an API key the session cost sits left, context and Compact right', async ($, on) => {
  engine(on)
  await $.session.measure({
    context: { window: 200000, percent: 30 },
    rateLimits: [],
    cost: { usd: 1.234 },
    changed: ['cost'],
  } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '$1.23' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
    await ui.unmount()
  }
})

test('a gateway spend limit draws a Spend bar', async ($, on) => {
  engine(on)
  await measure($, 40, [{ kind: 'spend_limit', percentUsed: 85, resetsAt: '2099-01-01T00:00:00Z' }])

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Spend' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^85%$/ })).toBeDefined()
  await ui.unmount()
})
