import type { Register, RenderChildren, SessionCost, SessionRateLimit } from 'claude-code'

// Cells in each progress bar
const CELLS = 10

// Cells each label takes, so the bars line up down the rows
const LABEL_WIDTH = 8

// Turn a percentage into a bar such as ████░░░░░░
function bar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clamped / 100) * CELLS)
  return '█'.repeat(filled) + '░'.repeat(CELLS - filled)
}

// Green until 60%, yellow until 80%, then red
function colorFor(percent: number): string {
  if (percent >= 80) return 'red'
  if (percent >= 60) return 'yellow'
  return 'green'
}

// "resets 2h 15m", "resets 3d 4h", "resets now", or "" from a reset time and the current time
function countdown(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'resets now'
  const minutes = Math.floor(ms / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `resets ${days}d ${hours}h`
  if (hours > 0) return `resets ${hours}h ${mins}m`
  return `resets ${mins}m`
}

// Where the latest release's manifest lives
const REMOTE_MANIFEST = 'https://raw.githubusercontent.com/rabbit-ninja/usage-bar/main/.claude-plugin/plugin.json'

const LABELS: Record<string, string> = {
  five_hour: 'Session',
  seven_day: 'Week',
  spend_limit: 'Spend',
}

export const register: Register = on => {
  // The windows and session cost from the last reading, shared by the hooks below
  let limits: SessionRateLimit[] = []
  let cost: SessionCost | undefined
  // Context window fill, undefined until the first response reports one
  let ctx: number | undefined
  // True while a compaction started from the band runs
  let compacting = false
  // A newer released version, once the check at start finds one
  let latest: string | undefined

  // Keep only the windows worth showing, session first
  const keep = (all: SessionRateLimit[]) =>
    all
      .filter(l => l.kind in LABELS)
      .sort((a, b) => (a.kind === 'five_hour' ? -1 : b.kind === 'five_hour' ? 1 : 0))

  // Read the current figures when the mod loads, and redraw once a minute
  // so the reset countdowns stay current
  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    limits = keep(usage.rateLimits)
    cost = usage.cost
    ctx = usage.context.percent
    $.clock.every(60000, () => $.ui.invalidate('ui.render'))
    $.ui.invalidate('ui.render')

    // Look for a newer release in the background, so a slow network never
    // holds up the session; any failure (offline, blocked by policy) stays silent
    ;(async () => {
      const local = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)).version
      const res = await $.http.fetch(REMOTE_MANIFEST)
      if (!res.ok) return
      const remote = JSON.parse(res.text).version
      // Numeric compare, so 0.10.0 counts as newer than 0.9.0
      if (typeof remote === 'string' && typeof local === 'string' && remote.localeCompare(local, undefined, { numeric: true }) > 0) {
        latest = remote
        $.ui.invalidate('ui.render')
      }
    })().catch(() => {})

    return next(e)
  })

  // Refresh whenever a turn ends, a window's percent changes or the cost grows
  on('session.measure', async ($, e, next) => {
    limits = keep(e.rateLimits)
    cost = e.cost
    ctx = e.context.percent
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Draw the band above the prompt: limits on the first row, context on the second
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Nothing to show before the first reading or an update
    if (e.props.hasSurvey) return next(e)
    // A cost only counts where it is a real charge: on a subscription it is always
    // $0, and before the first reading a Pro session has no windows yet either
    const charged = limits.length === 0 && cost !== undefined && cost.usd > 0 ? cost : undefined
    const hasFirstRow = limits.length > 0 || charged !== undefined
    if (!hasFirstRow && ctx === undefined && latest === undefined) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()

    // One item: a fixed-width label, then the rest. It never shrinks, so a narrow
    // band moves whole items onto the next row instead of breaking their text
    const item = (key: string, label: string, rest: RenderChildren) => (
      <Box key={key} flexDirection="row" flexShrink={0} columnGap={1} alignItems="center">
        <Box width={LABEL_WIDTH}>
          <Text dimColor>{label}</Text>
        </Box>
        {rest}
      </Box>
    )
    const meter = (percent: number) => [
      <Text key="bar" color={colorFor(percent)}>{bar(percent)}</Text>,
      <Text key="pct">{Math.round(percent)}%</Text>,
    ]

    const compact = async () => {
      if (compacting) return
      compacting = true
      $.ui.invalidate('ui.render')
      try {
        // The same path as typing /compact: queued until the session is idle
        await $.command.run({ command: 'compact' })
      } catch (err) {
        $.ui.toast(`Couldn't compact: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        compacting = false
        $.ui.invalidate('ui.render')
      }
    }

    return (
      // rowGap "sm": breathing room around the desktop's taller native button; the terminal draws it as 0 rows
      <Box flexDirection="column" rowGap="sm">
        {hasFirstRow && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={4}>
            {/* No limit windows (API key, Team or Enterprise usage-based seat): the session's cost instead */}
            {charged && item('cost', 'Session', [<Text key="usd">~${charged.usd.toFixed(2)}</Text>])}
            {limits.map(l =>
              item(l.kind, LABELS[l.kind] ?? l.kind, [
                ...meter(l.percentUsed),
                <Text key="reset" dimColor>{countdown(l.resetsAt, now)}</Text>,
              ]),
            )}
          </Box>
        )}
        {(ctx !== undefined || latest !== undefined) && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {ctx !== undefined &&
              item('context', 'Context', [
                ...meter(ctx),
                compacting ? (
                  <Text key="compacting">Compacting…</Text>
                ) : (
                  <Button key="compact" label="Compact" onPress={compact} />
                ),
              ])}
            {latest !== undefined && (
              <Button
                key="update"
                onPress={() =>
                  $.ui.toast(`usage-bar v${latest} is out. Update it under + → Plugins → Manage plugins, or run /plugin in a terminal.`, {
                    timeoutMs: 8000,
                  })
                }
              >
                <Text color="green">↑ v{latest}</Text>
              </Button>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
