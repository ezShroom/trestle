import path from 'node:path'
import { fileURLToPath } from 'node:url'
import packageJson from '../package.json'

const packageName = String(packageJson.name)
const packageVersion = String(packageJson.version)
const packageRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..')
const packageCommand = packageName.replace(/^@[^/]+\//, '')
const serviceSlug = packageCommand.replace(/[^a-zA-Z0-9_.-]/g, '-')
const serviceLabel = `com.${serviceSlug}.daemon`
const defaultMcpPort = 7653
const defaultMcpHost = '127.0.0.1'
const defaultMcpPath = '/mcp'
const defaultTerminalCommandTimeoutMs = 60_000
const maxTerminalCommandTimeoutMs = 10 * 60_000
const defaultTerminalResponseBytes = 16 * 1024
const maxTerminalResponseBytes = 64 * 1024
const maxTerminalBatchCommands = 32
const maxTerminalEnvironmentEntries = 64
const maxTerminalEnvironmentBytes = 16 * 1024
const maxTerminalRetentionBytes = 512 * 1024
const maxTerminalSessionIdleMs = 30 * 60_000
const terminalKillGraceMs = 2_000
const defaultFileReadOffset = 1
const defaultFileReadLimit = 200
const maxFileReadLimit = 1_000
const defaultFileListLimit = 200
const maxFileListLimit = 1_000
const defaultFileGrepLimit = 200
const maxFileGrepLimit = 1_000
const defaultFileSnapshotTtlMs = 60 * 60_000
const maxFileSnapshots = 1_000
const maxVisionImageBytes = 10 * 1024 * 1024
const maxScreenshotDisplays = 8

export {
	defaultMcpHost,
	defaultMcpPath,
	defaultMcpPort,
	defaultFileGrepLimit,
	defaultFileListLimit,
	defaultFileReadLimit,
	defaultFileReadOffset,
	defaultFileSnapshotTtlMs,
	defaultTerminalCommandTimeoutMs,
	defaultTerminalResponseBytes,
	maxScreenshotDisplays,
	maxFileGrepLimit,
	maxFileListLimit,
	maxFileReadLimit,
	maxFileSnapshots,
	maxTerminalBatchCommands,
	maxTerminalCommandTimeoutMs,
	maxTerminalEnvironmentBytes,
	maxTerminalEnvironmentEntries,
	maxTerminalResponseBytes,
	maxTerminalRetentionBytes,
	maxTerminalSessionIdleMs,
	packageCommand,
	packageName,
	packageRoot,
	packageVersion,
	serviceLabel,
	serviceSlug,
	maxVisionImageBytes,
	terminalKillGraceMs
}
