import { Command } from 'commander'
import chalk from 'chalk'
import { ListLogsInputSchema } from '../../types.js'
import {
  listLogsHandler,
  showLogHandler,
  exportLogsHandler,
  countLogsHandler,
  listActionsHandler,
  followLogsHandler,
  blameHandler,
  diffHandler,
  verifyHandler,
  federatedListHandler,
  searchLogsHandler,
  clearLogsHandler,
  DEFAULT_LIMIT,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
} from '../../handlers/node-log-handlers.js'
import { type OutputFormat, parseOutputFormat, parseTimeExpr, relativeTime } from '../../output.js'

export function logCommands(): Command {
  const log = new Command('log').description('View action log entries')

  // -------------------------------------------------------------------------
  // node log list
  // -------------------------------------------------------------------------
  log
    .command('list')
    .description('List action log entries from the journal')
    .option('--after <seq>', 'Show entries after this sequence number')
    .option('--limit <n>', `Maximum number of entries to show`, String(DEFAULT_LIMIT))
    .option('--action <type>', 'Filter by action type (e.g., local:peer:create)')
    .option('--since <time>', 'Show entries since time (e.g., 2h, 30m, 2026-03-24T00:00)')
    .option('--until <time>', 'Show entries until time (e.g., now, 1h, ISO timestamp)')
    .option('--all', 'Include system events (system:tick, keepalives)')
    .option('--federated', 'Query all connected peers (depth 1)')
    .option('-f, --follow', 'Follow new entries in real time')
    .option(
      '--interval <ms>',
      `Poll interval in ms for --follow mode (min ${MIN_POLL_INTERVAL_MS})`,
      String(DEFAULT_POLL_INTERVAL_MS)
    )
    .option('--output <format>', 'Output format: table, json, or jsonl', 'table')
    .option('--token <token>', 'Auth token')
    .action(async (options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const fmt = parseOutputFormat(options)
      const validation = ListLogsInputSchema.safeParse({
        afterSeq: options.after !== undefined ? Number(options.after) : undefined,
        limit: Number(options.limit),
        action: options.action,
        token: options.token || globals.token || process.env.CATALYST_AUTH_TOKEN,
        orchestratorUrl: globals.orchestratorUrl,
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`))
        })
        process.exit(1)
      }

      let since: string | undefined
      let until: string | undefined
      if (options.since) {
        const d = parseTimeExpr(options.since)
        if (!d) {
          console.error(chalk.red(`Invalid --since value: ${options.since}`))
          process.exit(1)
        }
        since = d.toISOString()
      }
      if (options.until) {
        const d = parseTimeExpr(options.until)
        if (!d) {
          console.error(chalk.red(`Invalid --until value: ${options.until}`))
          process.exit(1)
        }
        until = d.toISOString()
      }

      const input = { ...validation.data, includeSystem: !!options.all, since, until }

      if (options.federated && options.all) {
        console.error(
          chalk.red(
            '--federated --all is not supported (prevents pulling system ticks from all peers)'
          )
        )
        process.exit(1)
      }

      if (options.federated && options.follow) {
        console.error(
          chalk.red('--federated --follow is not supported. Use --follow on individual nodes.')
        )
        process.exit(1)
      }

      if (options.federated) {
        federatedMode(input, fmt)
      } else if (options.follow) {
        const interval = Number(options.interval)
        if (!Number.isFinite(interval) || interval < MIN_POLL_INTERVAL_MS) {
          console.error(chalk.red(`--interval must be a number >= ${MIN_POLL_INTERVAL_MS}`))
          process.exit(1)
        }
        followMode(input, interval, fmt)
      } else {
        oneShot(input, fmt)
      }
    })

  // -------------------------------------------------------------------------
  // node log show <seq>
  // -------------------------------------------------------------------------
  log
    .command('show <seq>')
    .description('Show full detail for a single log entry by sequence number')
    .option('--output <format>', 'Output format: table, json, or jsonl', 'table')
    .option('--token <token>', 'Auth token')
    .action(async (seq, options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const fmt = parseOutputFormat(options)
      const seqNum = Number(seq)

      if (!Number.isInteger(seqNum) || seqNum < 1) {
        console.error(chalk.red('Invalid sequence number. Must be a positive integer.'))
        process.exit(1)
      }

      const token = options.token || globals.token || process.env.CATALYST_AUTH_TOKEN

      try {
        const result = await showLogHandler({
          seq: seqNum,
          token,
          orchestratorUrl: globals.orchestratorUrl,
        })

        if (result.success) {
          const e = result.data.entry
          if (fmt === 'json' || fmt === 'jsonl') {
            console.log(JSON.stringify(e, null, fmt === 'json' ? 2 : undefined))
          } else {
            console.log(chalk.bold('Log Entry'))
            console.log(chalk.gray('─'.repeat(50)))
            console.log(`  ${chalk.dim('Seq:')}      ${e.seq}`)
            console.log(
              `  ${chalk.dim('Time:')}     ${e.recorded_at} ${chalk.dim(`(${relativeTime(e.recorded_at)})`)}`
            )
            console.log(`  ${chalk.dim('Action:')}   ${chalk.cyan(e.action.action)}`)
            console.log(`  ${chalk.dim('NodeId:')}   ${e.nodeId}`)
            if (e.traceId) {
              console.log(`  ${chalk.dim('TraceId:')}  ${chalk.blue(e.traceId)}`)
            }
            console.log(`  ${chalk.dim('Data:')}`)
            if (e.action.data !== undefined && e.action.data !== null) {
              console.log(
                chalk.white(JSON.stringify(e.action.data, null, 2).replace(/^/gm, '    '))
              )
            } else {
              console.log(chalk.yellow('    (none)'))
            }
          }
          process.exit(0)
        } else {
          console.error(chalk.red(`[error] ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  // -------------------------------------------------------------------------
  // node log export
  // -------------------------------------------------------------------------
  log
    .command('export')
    .description('Export action log entries to a JSON file for offline analysis')
    .requiredOption('-o, --output-file <path>', 'Output file path')
    .option('--after <seq>', 'Export entries after this sequence number')
    .option('--limit <n>', `Maximum entries to export (default: ${DEFAULT_LIMIT})`)
    .option('--action <type>', 'Filter by action type')
    .option('--since <time>', 'Export entries since time (e.g., 2h, 30m, ISO timestamp)')
    .option('--until <time>', 'Export entries until time')
    .option('--all', 'Include system events (system:tick, keepalives)')
    .option('--token <token>', 'Auth token')
    .action(async (options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const token = options.token || globals.token || process.env.CATALYST_AUTH_TOKEN

      // Validate numeric inputs
      const afterSeq = options.after !== undefined ? Number(options.after) : undefined
      const limit = options.limit !== undefined ? Number(options.limit) : DEFAULT_LIMIT

      if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
        console.error(chalk.red('--after must be a non-negative integer'))
        process.exit(1)
      }
      if (!Number.isInteger(limit) || limit < 1) {
        console.error(chalk.red('--limit must be a positive integer'))
        process.exit(1)
      }

      let sinceParsed: string | undefined
      let untilParsed: string | undefined
      if (options.since) {
        const d = parseTimeExpr(options.since)
        if (!d) {
          console.error(chalk.red(`Invalid --since value: ${options.since}`))
          process.exit(1)
        }
        sinceParsed = d.toISOString()
      }
      if (options.until) {
        const d = parseTimeExpr(options.until)
        if (!d) {
          console.error(chalk.red(`Invalid --until value: ${options.until}`))
          process.exit(1)
        }
        untilParsed = d.toISOString()
      }

      try {
        const result = await exportLogsHandler({
          outputPath: options.outputFile,
          afterSeq,
          limit,
          action: options.action,
          token,
          orchestratorUrl: globals.orchestratorUrl,
          logLevel: globals.logLevel ?? 'info',
          includeSystem: !!options.all,
          since: sinceParsed,
          until: untilParsed,
        })

        if (result.success) {
          console.log(chalk.green(`Exported ${result.data.count} entries to ${result.data.path}`))
          process.exit(0)
        } else {
          console.error(chalk.red(`[error] Failed to export logs: ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  // -------------------------------------------------------------------------
  // node log count
  // -------------------------------------------------------------------------
  log
    .command('count')
    .description('Count journal entries (minimal bandwidth — returns one number)')
    .option('--after <seq>', 'Count entries after this sequence number')
    .option('--action <type>', 'Count only entries matching this action type')
    .option('--output <format>', 'Output format: table, json, or jsonl', 'table')
    .option('--token <token>', 'Auth token')
    .action(async (options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const fmt = parseOutputFormat(options)
      const token = options.token || globals.token || process.env.CATALYST_AUTH_TOKEN

      // Validate numeric input
      const afterSeq = options.after !== undefined ? Number(options.after) : undefined
      if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
        console.error(chalk.red('--after must be a non-negative integer'))
        process.exit(1)
      }

      try {
        const result = await countLogsHandler({
          afterSeq,
          action: options.action,
          token,
          orchestratorUrl: globals.orchestratorUrl,
        })

        if (result.success) {
          const { count, lastSeq } = result.data
          if (fmt === 'json' || fmt === 'jsonl') {
            console.log(
              JSON.stringify({ count, lastSeq, ...(options.action && { action: options.action }) })
            )
          } else {
            console.log(
              `${chalk.bold(String(count))} entries${options.action ? ` matching ${chalk.cyan(options.action)}` : ''}${options.after ? ` after seq ${options.after}` : ''} (last seq: ${lastSeq})`
            )
          }
          process.exit(0)
        } else {
          console.error(chalk.red(`[error] ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  // -------------------------------------------------------------------------
  // node log actions
  // -------------------------------------------------------------------------
  log
    .command('actions')
    .description('List distinct action types in the journal with counts')
    .option('--output <format>', 'Output format: table, json, or jsonl', 'table')
    .option('--token <token>', 'Auth token')
    .action(async (options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const fmt = parseOutputFormat(options)
      const token = options.token || globals.token || process.env.CATALYST_AUTH_TOKEN

      try {
        const result = await listActionsHandler({
          token,
          orchestratorUrl: globals.orchestratorUrl,
        })

        if (result.success) {
          if (fmt === 'json') {
            console.log(JSON.stringify(result.data.actions, null, 2))
          } else if (fmt === 'jsonl') {
            for (const a of result.data.actions) {
              console.log(JSON.stringify(a))
            }
          } else {
            if (result.data.actions.length === 0) {
              console.log(chalk.yellow('No actions in the journal.'))
            } else {
              console.table(
                result.data.actions.map((a) => ({
                  Action: a.action,
                  Count: a.count,
                }))
              )
            }
          }
          process.exit(0)
        } else {
          console.error(chalk.red(`[error] ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  // -------------------------------------------------------------------------
  // node log tui
  // -------------------------------------------------------------------------
  log
    .command('tui')
    .description('Interactive terminal UI for browsing the journal')
    .option(
      '--interval <ms>',
      `Poll interval in ms for live mode (min ${MIN_POLL_INTERVAL_MS})`,
      String(DEFAULT_POLL_INTERVAL_MS)
    )
    .option('--token <token>', 'Auth token')
    .action(async (options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const token = options.token || globals.token || process.env.CATALYST_AUTH_TOKEN
      if (!token) {
        console.error(chalk.red('Auth token required. Use --token or set CATALYST_AUTH_TOKEN.'))
        process.exit(1)
      }
      const { launchTui } = await import('../../tui/log-tui.js')
      await launchTui({
        token,
        orchestratorUrl: globals.orchestratorUrl,
        interval: Number(options.interval),
      })
    })

  // -------------------------------------------------------------------------
  // node log blame <name>
  // -------------------------------------------------------------------------
  log
    .command('blame <name>')
    .description('Show all journal entries related to a specific peer or route')
    .option('--after <seq>', 'Show entries after this sequence number')
    .option('--limit <n>', `Maximum entries to show (default: ${DEFAULT_LIMIT})`)
    .option('--since <time>', 'Filter entries since time (e.g., 2h, 30m, ISO timestamp)')
    .option('--until <time>', 'Filter entries until time')
    .option('--output <format>', 'Output format: table, json, or jsonl', 'table')
    .option('--token <token>', 'Auth token')
    .action(async (name, options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const fmt = parseOutputFormat(options)
      const token = options.token || globals.token || process.env.CATALYST_AUTH_TOKEN

      const afterSeq = options.after !== undefined ? Number(options.after) : undefined
      const limit = options.limit !== undefined ? Number(options.limit) : DEFAULT_LIMIT

      let since: string | undefined
      let until: string | undefined
      if (options.since) {
        const d = parseTimeExpr(options.since)
        if (!d) {
          console.error(chalk.red(`Invalid --since value: ${options.since}`))
          process.exit(1)
        }
        since = d.toISOString()
      }
      if (options.until) {
        const d = parseTimeExpr(options.until)
        if (!d) {
          console.error(chalk.red(`Invalid --until value: ${options.until}`))
          process.exit(1)
        }
        until = d.toISOString()
      }

      try {
        const result = await blameHandler({
          name,
          afterSeq,
          limit,
          since,
          until,
          token,
          orchestratorUrl: globals.orchestratorUrl,
        })

        if (result.success) {
          const entries = result.data.entries
          if (entries.length === 0 && fmt === 'table') {
            console.log(chalk.yellow(`No journal entries found for "${name}".`))
          } else if (fmt === 'json') {
            console.log(JSON.stringify(entries, null, 2))
          } else if (fmt === 'jsonl') {
            for (const e of entries) console.log(JSON.stringify(e))
          } else {
            console.log(chalk.bold(`History for "${name}" (${entries.length} entries)\n`))
            for (const e of entries) {
              const age = chalk.dim(relativeTime(e.recorded_at))
              const action = chalk.cyan(e.action.action)
              console.log(`  ${chalk.gray(`[${e.seq}]`)} ${age} ${action}`)
            }
          }
          process.exit(0)
        } else {
          console.error(chalk.red(`[error] ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  // -------------------------------------------------------------------------
  // node log diff <from> <to>
  // -------------------------------------------------------------------------
  log
    .command('diff <from> <to>')
    .description('Show shift-handover summary between two sequence numbers')
    .option('--output <format>', 'Output format: table, json, or jsonl', 'table')
    .option('--token <token>', 'Auth token')
    .action(async (from, to, options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const fmt = parseOutputFormat(options)
      const token = options.token || globals.token || process.env.CATALYST_AUTH_TOKEN

      const fromSeq = Number(from)
      const toSeq = Number(to)

      if (!Number.isInteger(fromSeq) || fromSeq < 0) {
        console.error(chalk.red('Invalid <from> sequence number'))
        process.exit(1)
      }
      if (!Number.isInteger(toSeq) || toSeq < 1 || toSeq <= fromSeq) {
        console.error(chalk.red('<to> must be a positive integer greater than <from>'))
        process.exit(1)
      }

      try {
        const result = await diffHandler({
          fromSeq,
          toSeq,
          token,
          orchestratorUrl: globals.orchestratorUrl,
        })

        if (result.success) {
          const d = result.data
          if (fmt === 'json') {
            console.log(JSON.stringify(d, null, 2))
          } else if (fmt === 'jsonl') {
            console.log(JSON.stringify(d))
          } else {
            console.log(chalk.bold('Shift Handover Summary'))
            console.log(chalk.gray('─'.repeat(60)))
            console.log(`  ${chalk.dim('Period:')}  ${d.fromTime} → ${d.toTime} (${d.duration})`)
            console.log(
              `  ${chalk.dim('Entries:')} ${d.totalEntries} total (${d.operatorEntries} operator, ${d.systemEntries} system)`
            )
            console.log()
            console.log(
              `  ${chalk.dim('Peers:')}   ${chalk.green(`+${d.peersCreated.length} created`)}, ${chalk.red(`-${d.peersDeleted.length} deleted`)}`
            )
            console.log(
              `  ${chalk.dim('Routes:')}  ${chalk.green(`+${d.routesCreated.length} created`)}, ${chalk.red(`-${d.routesDeleted.length} deleted`)}`
            )

            if (d.operatorActions.length > 0) {
              console.log()
              console.log(`  ${chalk.dim('Operator actions:')}`)
              for (const a of d.operatorActions) {
                console.log(
                  `    ${chalk.gray(`[${a.seq}]`)} ${chalk.cyan(a.action.padEnd(25))} ${a.entity}`
                )
              }
            }
          }
          process.exit(0)
        } else {
          console.error(chalk.red(`[error] ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  // -------------------------------------------------------------------------
  // node log verify
  // -------------------------------------------------------------------------
  log
    .command('verify')
    .description('Verify journal consistency against the live route table')
    .option('--output <format>', 'Output format: table, json, or jsonl', 'table')
    .option('--token <token>', 'Auth token')
    .action(async (options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const fmt = parseOutputFormat(options)
      const token = options.token || globals.token || process.env.CATALYST_AUTH_TOKEN

      try {
        const result = await verifyHandler({ token, orchestratorUrl: globals.orchestratorUrl })

        if (result.success) {
          const v = result.data
          if (fmt === 'json' || fmt === 'jsonl') {
            console.log(JSON.stringify(v, null, fmt === 'json' ? 2 : undefined))
          } else if (v.consistent) {
            console.log(chalk.green(`✓ Route table consistent with journal at seq ${v.journalSeq}`))
          } else {
            console.log(
              chalk.red(`✗ ${v.mismatches.length} mismatch(es) found at seq ${v.journalSeq}:`)
            )
            for (const m of v.mismatches) {
              const icon =
                m.issue === 'missing_in_journal' ? '?' : m.issue === 'missing_in_state' ? '!' : '≠'
              console.log(
                chalk.yellow(
                  `  ${icon} ${m.type} "${m.name}" — ${m.issue.replace(/_/g, ' ')}${m.details ? ` (${m.details})` : ''}`
                )
              )
            }
          }
          process.exit(v.consistent ? 0 : 1)
        } else {
          console.error(chalk.red(`[error] ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  // -------------------------------------------------------------------------
  // node log search
  // -------------------------------------------------------------------------
  log
    .command('search <query>')
    .description('Search journal entries by text (matches action types and data payloads)')
    .option('--limit <n>', 'Maximum results', String(DEFAULT_LIMIT))
    .option('--after <seq>', 'Only search entries after this sequence number')
    .option('--since <time>', 'Only search entries since this time (e.g., 2h, 30m, ISO timestamp)')
    .option('--output <format>', 'Output format: table, json, or jsonl', 'table')
    .option('--token <token>', 'Auth token')
    .action(async (query, options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const fmt = parseOutputFormat(options)
      const token = options.token || globals.token || process.env.CATALYST_AUTH_TOKEN

      const limit = Number(options.limit)
      if (!Number.isInteger(limit) || limit < 1) {
        console.error(chalk.red('--limit must be a positive integer'))
        process.exit(1)
      }

      let since: string | undefined
      if (options.since) {
        const d = parseTimeExpr(options.since)
        if (!d) {
          console.error(chalk.red(`Invalid --since value: ${options.since}`))
          process.exit(1)
        }
        since = d.toISOString()
      }

      try {
        const result = await searchLogsHandler({
          query,
          limit,
          afterSeq: options.after ? Number(options.after) : undefined,
          since,
          token,
          orchestratorUrl: globals.orchestratorUrl,
        })

        if (result.success) {
          const { entries } = result.data
          if (entries.length === 0 && fmt === 'table') {
            console.log(chalk.yellow(`No entries matching "${query}"`))
          } else if (fmt === 'json') {
            console.log(JSON.stringify(entries))
          } else if (fmt === 'jsonl') {
            for (const e of entries) console.log(JSON.stringify(e))
          } else {
            console.log(
              chalk.dim(
                `${entries.length} match${entries.length === 1 ? '' : 'es'} for "${query}":\n`
              )
            )
            const pattern = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
            for (const e of entries) {
              const data = summarizeData(e.action.data)
              const highlighted = data.replace(pattern, chalk.bgYellow.black('$1'))
              const action = e.action.action.replace(pattern, chalk.bgYellow.black('$1'))
              console.log(
                `  ${chalk.dim(String(e.seq).padStart(4))}  ${chalk.dim(relativeTime(e.recorded_at).padEnd(8))}  ${action}  ${highlighted}`
              )
            }
          }
          process.exit(0)
        } else {
          console.error(chalk.red(`[error] ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  // -------------------------------------------------------------------------
  // node log clear
  // -------------------------------------------------------------------------
  log
    .command('clear')
    .description('Clear all journal entries (requires ADMIN role)')
    .option('--token <token>', 'Auth token')
    .option('--output <format>', 'Output format: table, json', 'table')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const fmt = parseOutputFormat(options)
      const token = options.token || globals.token || process.env.CATALYST_AUTH_TOKEN

      if (!options.yes && fmt === 'table') {
        const readline = await import('readline')
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            chalk.yellow('Clear all journal entries? This cannot be undone. [y/N] '),
            resolve
          )
        })
        rl.close()
        if (answer.toLowerCase() !== 'y') {
          console.log('Cancelled.')
          process.exit(0)
        }
      }

      try {
        const result = await clearLogsHandler({
          token,
          orchestratorUrl: globals.orchestratorUrl,
        })

        if (result.success) {
          if (fmt === 'json' || fmt === 'jsonl') {
            console.log(JSON.stringify({ pruned: result.data.pruned }))
          } else {
            if (result.data.pruned === 0) {
              console.log(chalk.dim('Journal is already empty.'))
            } else {
              console.log(chalk.green(`Cleared ${result.data.pruned} journal entries.`))
            }
          }
          process.exit(0)
        } else {
          console.error(chalk.red(`[error] ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  return log
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function oneShot(input: Parameters<typeof listLogsHandler>[0], fmt: OutputFormat) {
  try {
    const result = await listLogsHandler(input)

    if (result.success) {
      if (result.data.entries.length === 0 && fmt === 'table') {
        console.log(chalk.yellow('No log entries found.'))
      } else if (fmt === 'json') {
        console.log(JSON.stringify(result.data.entries, null, 2))
      } else if (fmt === 'jsonl') {
        for (const e of result.data.entries) {
          console.log(JSON.stringify(e))
        }
      } else {
        console.table(
          result.data.entries.map((e) => ({
            Seq: e.seq,
            Age: relativeTime(e.recorded_at),
            Action: e.action.action,
            NodeId: e.nodeId,
            Data: summarizeData(e.action.data),
          }))
        )
      }
      process.exit(0)
    } else {
      console.error(chalk.red(`[error] Failed to list logs: ${result.error}`))
      process.exit(1)
    }
  } catch (error) {
    console.error(chalk.red(`[error] ${error instanceof Error ? error.message : error}`))
    process.exit(1)
  }
}

async function followMode(
  input: Parameters<typeof followLogsHandler>[0],
  interval: number,
  fmt: OutputFormat
) {
  if (fmt === 'table') {
    console.log(chalk.dim('Following action log (Ctrl-C to stop)...\n'))
  }

  const stop = await followLogsHandler(
    { ...input, interval },
    (entries) => {
      for (const e of entries) {
        if (fmt === 'json' || fmt === 'jsonl') {
          console.log(JSON.stringify(e))
        } else {
          const age = chalk.dim(relativeTime(e.recorded_at))
          const action = chalk.cyan(e.action.action)
          const data = chalk.white(summarizeData(e.action.data))
          console.log(`${chalk.gray(`[${e.seq}]`)} ${age} ${action} ${data}`)
        }
      }
    },
    (error) => {
      console.error(chalk.red(`[error] ${error}`))
      process.exit(1)
    }
  )

  const shutdown = () => {
    stop()
    if (fmt === 'table') {
      console.log(chalk.dim('\nStopped following.'))
    }
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function federatedMode(input: Parameters<typeof federatedListHandler>[0], fmt: OutputFormat) {
  try {
    const result = await federatedListHandler(input)

    if (result.success) {
      const { entries, unreachable } = result.data

      if (entries.length === 0 && fmt === 'table') {
        console.log(chalk.yellow('No log entries found across the mesh.'))
      } else if (fmt === 'json') {
        console.log(JSON.stringify({ entries, unreachable }, null, 2))
      } else if (fmt === 'jsonl') {
        for (const e of entries) {
          console.log(JSON.stringify(e))
        }
      } else {
        console.table(
          entries.map((e) => ({
            Seq: e.seq,
            Age: relativeTime(e.recorded_at),
            Action: e.action.action,
            Node: e.sourceNode,
            Data: summarizeData(e.action.data),
          }))
        )
      }

      if (unreachable.length > 0 && fmt === 'table') {
        console.log(
          chalk.yellow(
            `\n\u26a0 ${unreachable.length} node(s) unreachable: ${unreachable.join(', ')}`
          )
        )
      }

      process.exit(0)
    } else {
      console.error(chalk.red(`[error] ${result.error}`))
      process.exit(1)
    }
  } catch (error) {
    console.error(chalk.red(`[error] ${error instanceof Error ? error.message : error}`))
    process.exit(1)
  }
}

/**
 * Produce a short summary string from an action's data payload.
 */
function summarizeData(data: unknown): string {
  if (data === undefined || data === null) return '-'
  if (typeof data !== 'object') return String(data)

  const obj = data as Record<string, unknown>

  // Peer/route actions — show name
  if ('name' in obj && typeof obj.name === 'string') {
    return obj.name
  }

  // Protocol actions with peerInfo
  if ('peerInfo' in obj && typeof obj.peerInfo === 'object' && obj.peerInfo !== null) {
    const peerInfo = obj.peerInfo as Record<string, unknown>
    if ('name' in peerInfo && typeof peerInfo.name === 'string') {
      return peerInfo.name
    }
  }

  // Fallback: compact JSON, truncated
  const json = JSON.stringify(data)
  return json.length > 60 ? json.slice(0, 57) + '...' : json
}
