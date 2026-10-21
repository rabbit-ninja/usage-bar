import type { Register, SessionCost, SessionRateLimit } from 'claude-code'

// Cells in each progress bar
const CELLS = 10

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

// "2h 15m", "3d 4h", or "now" from a reset time and the current time
function countdown(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'now'
  const minutes = Math.floor(ms / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

const LABELS: Record<string, string> = {
  five_hour: 'Session',
  seven_day: 'Week',
  spend_limit: 'Spend',
}

export const register: Register = on => {
  // The windows and session cost from the last reading, shared by the hooks below
  let limits: SessionRateLimit[] = []
  let cost: SessionCost | undefined

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
    $.clock.every(60000, () => $.ui.invalidate('ui.render'))
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Refresh whenever a turn ends, a window's percent changes or the cost grows
  on('session.measure', async ($, e, next) => {
    limits = keep(e.rateLimits)
    cost = e.cost
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Draw the band above the prompt
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)

    // No limit windows (API key, Team or Enterprise usage-based seat): show the session's cost instead
    if (limits.length === 0) {
      if (!cost) return next(e)
      return (
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>Session</Text>
          <Text>${cost.usd.toFixed(2)}</Text>
        </Box>
      )
    }

    const now = await $.clock.now()

    return (
      <Box flexDirection="row" columnGap={3}>
        {limits.map(l => (
          <Box key={l.kind} flexDirection="row" columnGap={1}>
            <Text dimColor>{LABELS[l.kind]}</Text>
            <Text color={colorFor(l.percentUsed)}>{bar(l.percentUsed)}</Text>
            <Text>{Math.round(l.percentUsed)}%</Text>
            <Text dimColor>{countdown(l.resetsAt, now) ? `resets ${countdown(l.resetsAt, now)}` : ''}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
