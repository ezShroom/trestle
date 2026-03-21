import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
	defaultTerminalCommandTimeoutMs,
	defaultTerminalResponseBytes,
	maxTerminalBatchCommands,
	maxTerminalCommandTimeoutMs,
	maxTerminalEnvironmentBytes,
	maxTerminalEnvironmentEntries,
	maxTerminalResponseBytes,
	maxTerminalRetentionBytes,
	maxTerminalSessionIdleMs,
	terminalKillGraceMs
} from './constants'
import { ensureAppDirs } from './fs_state'
import { terminalLogDir } from './paths'

type SessionStatus = 'idle' | 'running' | 'closing' | 'closed' | 'failed'
type CommandStatus = 'queued' | 'running' | 'completed' | 'timed_out' | 'interrupted' | 'failed'

interface TerminalSessionRecord {
	id: string
	label?: string
	cwd: string
	shell: string
	platform: NodeJS.Platform
	status: SessionStatus
	createdAt: string
	lastActivityAt: string
	lastExitCode?: number | null
	lastCommandId?: string
	child: ChildProcessWithoutNullStreams
	commands: Map<string, TerminalCommandRecord>
	activeCommandId?: string
	sessionLogFile: string
}

interface TerminalCommandRecord {
	id: string
	sessionId: string
	input: string
	status: CommandStatus
	waitMode: 'blocking' | 'async'
	createdAt: string
	startedAt: string
	endedAt?: string
	timeoutMs: number
	markerToken: string
	outputFile: string
	outputByteCount: number
	archivedBytes: number
	truncatedInMemory: boolean
	exitCode?: number | null
	resolve?: (value: TerminalExecResult) => void
	reject?: (error: Error) => void
	timer?: ReturnType<typeof setTimeout>
	visibleOutput: string
	pendingScanBuffer: string
}

interface CreateSessionInput {
	cwd?: string
	env?: Record<string, string>
	shell?: string
	label?: string
}

interface ExecInput {
	sessionId: string
	command?: string
	commands?: string[]
	wait?: boolean
	timeoutMs?: number
	maxOutputBytes?: number
	label?: string
}

interface ReadInput {
	sessionId: string
	commandId?: string
	cursor?: number
	limitBytes?: number
}

interface SearchInput {
	sessionId: string
	commandId?: string
	query: string
	limit?: number
	regex?: boolean
	before?: number
	after?: number
}

interface InterruptInput {
	sessionId: string
	commandId?: string
}

interface TerminalExecResult {
	sessionId: string
	commandId: string
	status: CommandStatus
	waitMode: 'blocking' | 'async'
	exitCode?: number | null
	output: string
	cursor: number
	outputHandle: string
	truncated: boolean
	totalBytes: number
	returnedBytes: number
	startedAt: string
	endedAt?: string
	timeoutMs: number
}

function normalizeReadLimit(limitBytes?: number) {
	if (!limitBytes || Number.isNaN(limitBytes)) return defaultTerminalResponseBytes
	return Math.max(1, Math.min(limitBytes, maxTerminalResponseBytes))
}

function sanitizeEnv(overrides?: Record<string, string>) {
	if (!overrides) return {}
	const entries = Object.entries(overrides).filter(([key]) => key.length > 0)
	if (entries.length > maxTerminalEnvironmentEntries) {
		throw new Error(`Too many environment overrides. Max is ${String(maxTerminalEnvironmentEntries)}.`)
	}

	let totalBytes = 0
	for (const [key, value] of entries) {
		totalBytes += Buffer.byteLength(key) + Buffer.byteLength(value)
	}
	if (totalBytes > maxTerminalEnvironmentBytes) {
		throw new Error(`Environment overrides exceed ${String(maxTerminalEnvironmentBytes)} bytes.`)
	}

	return Object.fromEntries(entries)
}

function buildPosixShellArgs() {
	return ['-s']
}

function buildWindowsShellArgs(shell: string) {
	if (shell.toLowerCase().includes('powershell')) {
		return ['-NoLogo', '-NoExit', '-Command', '-']
	}
	return ['/Q', '/K']
}

function nowIso() {
	return new Date().toISOString()
}

function ensureDirectory(dirPath: string) {
	fs.mkdirSync(dirPath, { recursive: true })
}

function escapeRegex(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeCommandInput(command?: string, commands?: string[]) {
	const normalizedCommands = commands?.filter((entry) => entry.length > 0) ?? []
	if (normalizedCommands.length > 0 && command) {
		throw new Error('Provide either command or commands, not both.')
	}
	if (normalizedCommands.length > maxTerminalBatchCommands) {
		throw new Error(`Too many commands in batch. Max is ${String(maxTerminalBatchCommands)}.`)
	}
	if (normalizedCommands.length > 0) return normalizedCommands.join('\n')
	if (command && command.length > 0) return command
	throw new Error('A command is required.')
}

function pickShell(shellOverride?: string) {
	if (shellOverride) return shellOverride
	if (process.platform === 'win32') return 'powershell.exe'
	return process.env.SHELL || '/bin/bash'
}

function resolveSessionCwd(cwd?: string) {
	return path.resolve(cwd ?? process.cwd())
}

function outputHandle(sessionId: string, commandId: string) {
	return `${sessionId}:${commandId}`
}

function readBufferSlice(filePath: string, cursor: number, limitBytes: number) {
	if (!fs.existsSync(filePath)) {
		return {
			text: '',
			nextCursor: 0,
			totalBytes: 0,
			returnedBytes: 0
		}
	}

	const fileBuffer = fs.readFileSync(filePath)
	const safeCursor = Math.max(0, Math.min(cursor, fileBuffer.length))
	const end = Math.min(fileBuffer.length, safeCursor + limitBytes)
	const slice = fileBuffer.subarray(safeCursor, end)
	return {
		text: slice.toString('utf8'),
		nextCursor: end,
		totalBytes: fileBuffer.length,
		returnedBytes: slice.length
	}
}

function trimVisibleOutput(value: string) {
	const buffer = Buffer.from(value, 'utf8')
	if (buffer.length <= maxTerminalRetentionBytes) return { text: value, truncated: false }

	const trimmed = buffer.subarray(buffer.length - maxTerminalRetentionBytes)
	return {
		text: trimmed.toString('utf8'),
		truncated: true
	}
}

class TerminalManager {
	private readonly sessions = new Map<string, TerminalSessionRecord>()
	private readonly cleanupTimer: ReturnType<typeof setInterval>

	constructor() {
		ensureAppDirs()
		this.cleanupTimer = setInterval(() => {
			void this.reapIdleSessions()
		}, 60_000)
		this.cleanupTimer.unref()
	}

	summary() {
		let activeCommands = 0
		for (const session of this.sessions.values()) {
			if (session.activeCommandId) activeCommands += 1
		}

		return {
			sessionCount: this.sessions.size,
			activeCommands
		}
	}

	async createSession(input: CreateSessionInput) {
		const cwd = resolveSessionCwd(input.cwd)
		if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
			throw new Error(`Working directory does not exist: ${cwd}`)
		}

		const shell = pickShell(input.shell)
		const env = { ...process.env, ...sanitizeEnv(input.env) }
		const sessionId = randomUUID()
		const sessionDir = path.join(terminalLogDir, sessionId)
		ensureDirectory(sessionDir)
		const sessionLogFile = path.join(sessionDir, 'session.log')

		const child = spawn(shell, process.platform === 'win32' ? buildWindowsShellArgs(shell) : buildPosixShellArgs(), {
			cwd,
			env,
			stdio: 'pipe',
			detached: process.platform !== 'win32'
		})

		child.stdin.setDefaultEncoding('utf8')

		const session: TerminalSessionRecord = {
			id: sessionId,
			label: input.label,
			cwd,
			shell,
			platform: process.platform,
			status: 'idle',
			createdAt: nowIso(),
			lastActivityAt: nowIso(),
			child,
			commands: new Map(),
			sessionLogFile
		}

		this.sessions.set(sessionId, session)

		const onData = (chunk: Buffer | string, source: 'stdout' | 'stderr') => {
			this.handleSessionOutput(sessionId, typeof chunk === 'string' ? chunk : chunk.toString('utf8'), source)
		}

		child.stdout.on('data', (chunk) => onData(chunk, 'stdout'))
		child.stderr.on('data', (chunk) => onData(chunk, 'stderr'))
		child.on('exit', (code, signal) => {
			this.handleSessionExit(sessionId, code, signal)
		})
		child.on('error', (error) => {
			this.failSession(sessionId, error)
		})

		return {
			sessionId,
			label: input.label ?? null,
			cwd,
			shell,
			platform: process.platform,
			status: session.status,
			createdAt: session.createdAt
		}
	}

	async exec(input: ExecInput) {
		const session = this.requireSession(input.sessionId)
		if (session.status !== 'idle') {
			throw new Error(`Session ${session.id} is busy.`)
		}

		const commandText = normalizeCommandInput(input.command, input.commands)
		const wait = input.wait ?? true
		const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? defaultTerminalCommandTimeoutMs, maxTerminalCommandTimeoutMs))
		const commandId = randomUUID()
		const markerToken = randomUUID()
		const sessionDir = path.dirname(session.sessionLogFile)
		const commandOutputFile = path.join(sessionDir, `${commandId}.log`)
		fs.writeFileSync(commandOutputFile, '')

		const commandRecord: TerminalCommandRecord = {
			id: commandId,
			sessionId: session.id,
			input: commandText,
			status: 'queued',
			waitMode: wait ? 'blocking' : 'async',
			createdAt: nowIso(),
			startedAt: nowIso(),
			timeoutMs,
			markerToken,
			outputFile: commandOutputFile,
			outputByteCount: 0,
			archivedBytes: 0,
			truncatedInMemory: false,
			visibleOutput: '',
			pendingScanBuffer: ''
		}

		session.commands.set(commandId, commandRecord)
		session.activeCommandId = commandId
		session.lastCommandId = commandId
		session.status = 'running'
		session.lastActivityAt = nowIso()
		commandRecord.status = 'running'

		const completionPromise = new Promise<TerminalExecResult>((resolve, reject) => {
			commandRecord.resolve = resolve
			commandRecord.reject = reject
		})

		commandRecord.timer = setTimeout(() => {
			void this.timeoutCommand(session.id, commandId)
		}, timeoutMs)

		this.writeToSession(session, this.wrapCommandForShell(commandText, markerToken))

		if (!wait) {
			return {
				sessionId: session.id,
				commandId,
				status: commandRecord.status,
				waitMode: commandRecord.waitMode,
				output: '',
				cursor: 0,
				outputHandle: outputHandle(session.id, commandId),
				truncated: false,
				totalBytes: 0,
				returnedBytes: 0,
				startedAt: commandRecord.startedAt,
				timeoutMs
			} satisfies TerminalExecResult
		}

		const maxOutputBytes = normalizeReadLimit(input.maxOutputBytes)
		const result = await completionPromise
		return this.limitExecResult(result, maxOutputBytes)
	}

	read(input: ReadInput) {
		const session = this.requireSession(input.sessionId)
		const command = this.resolveCommand(session, input.commandId)
		const limitBytes = normalizeReadLimit(input.limitBytes)
		const cursor = input.cursor ?? 0
		const payload = readBufferSlice(command.outputFile, cursor, limitBytes)

		return {
			sessionId: session.id,
			commandId: command.id,
			status: command.status,
			exitCode: command.exitCode ?? null,
			output: payload.text,
			cursor: payload.nextCursor,
			totalBytes: payload.totalBytes,
			returnedBytes: payload.returnedBytes,
			outputHandle: outputHandle(session.id, command.id),
			truncated: payload.nextCursor < payload.totalBytes,
			startedAt: command.startedAt,
			endedAt: command.endedAt ?? null
		}
	}

	search(input: SearchInput) {
		const session = this.requireSession(input.sessionId)
		const command = this.resolveCommand(session, input.commandId)
		const text = fs.existsSync(command.outputFile) ? fs.readFileSync(command.outputFile, 'utf8') : ''
		const lines = text.split(/\r?\n/)
		const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
		const before = Math.max(0, input.before ?? 0)
		const after = Math.max(0, input.after ?? 0)
		const matcher = input.regex ? new RegExp(input.query, 'i') : null
		const matches: Array<{ lineNumber: number; line: string; before: string[]; after: string[] }> = []

		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index] ?? ''
			const matched = matcher ? matcher.test(line) : line.includes(input.query)
			if (!matched) continue
			matches.push({
				lineNumber: index + 1,
				line,
				before: lines.slice(Math.max(0, index - before), index),
				after: lines.slice(index + 1, index + 1 + after)
			})
			if (matches.length >= limit) break
		}

		return {
			sessionId: session.id,
			commandId: command.id,
			outputHandle: outputHandle(session.id, command.id),
			matchCount: matches.length,
			matches
		}
	}

	status(sessionId: string) {
		const session = this.requireSession(sessionId)
		const activeCommand = session.activeCommandId ? session.commands.get(session.activeCommandId) : undefined
		return {
			sessionId: session.id,
			label: session.label ?? null,
			status: session.status,
			platform: session.platform,
			shell: session.shell,
			cwd: session.cwd,
			createdAt: session.createdAt,
			lastActivityAt: session.lastActivityAt,
			lastExitCode: session.lastExitCode ?? null,
			activeCommand: activeCommand
				? {
						commandId: activeCommand.id,
						status: activeCommand.status,
						startedAt: activeCommand.startedAt,
						timeoutMs: activeCommand.timeoutMs,
						outputHandle: outputHandle(session.id, activeCommand.id)
					}
				: null,
			commandCount: session.commands.size
		}
	}

	async interrupt(input: InterruptInput) {
		const session = this.requireSession(input.sessionId)
		const commandId = input.commandId ?? session.activeCommandId
		if (!commandId) {
			return {
				sessionId: session.id,
				interrupted: false,
				reason: 'No active command.'
			}
		}

		const command = this.resolveCommand(session, commandId)
		await this.signalSession(session, 'SIGINT')
		command.status = 'interrupted'
		command.endedAt = nowIso()
		this.finishCommand(session, command, command.exitCode ?? null, 'interrupted')
		return {
			sessionId: session.id,
			commandId,
			interrupted: true,
			status: command.status
		}
	}

	async closeSession(sessionId: string) {
		const session = this.requireSession(sessionId)
		session.status = 'closing'
		await this.terminateSession(session)
		this.sessions.delete(sessionId)
		return {
			sessionId,
			closed: true
		}
	}

	async shutdown() {
		clearInterval(this.cleanupTimer)
		const sessionIds = [...this.sessions.keys()]
		for (const sessionId of sessionIds) {
			try {
				await this.closeSession(sessionId)
			} catch {}
		}
	}

	private limitExecResult(result: TerminalExecResult, maxOutputBytes: number) {
		const buffer = Buffer.from(result.output, 'utf8')
		if (buffer.length <= maxOutputBytes) return result

		const slice = buffer.subarray(buffer.length - maxOutputBytes)
		return {
			...result,
			output: slice.toString('utf8'),
			cursor: Math.max(0, result.totalBytes - maxOutputBytes),
			returnedBytes: slice.length,
			truncated: true
		}
	}

	private requireSession(sessionId: string) {
		const session = this.sessions.get(sessionId)
		if (!session) throw new Error(`Unknown session: ${sessionId}`)
		return session
	}

	private resolveCommand(session: TerminalSessionRecord, commandId?: string) {
		const resolvedCommandId = commandId ?? session.lastCommandId
		if (!resolvedCommandId) {
			throw new Error(`Session ${session.id} does not have any commands yet.`)
		}
		const command = session.commands.get(resolvedCommandId)
		if (!command) {
			throw new Error(`Unknown command: ${resolvedCommandId}`)
		}
		return command
	}

	private wrapCommandForShell(commandText: string, markerToken: string) {
		if (process.platform === 'win32') {
			return `& {\n${commandText}\n}\n$__outpost_exit = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }\nWrite-Output \"\"\nWrite-Output \"__OUTPOST_CMD_DONE__${markerToken}__$__outpost_exit\"\n`
		}

		return `{ \n${commandText}\n}\n__outpost_exit_code=$?\nprintf '\\n__OUTPOST_CMD_DONE__${markerToken}__%s\\n' \"$__outpost_exit_code\"\n`
	}

	private writeToSession(session: TerminalSessionRecord, payload: string) {
		if (!session.child.stdin.writable) {
			throw new Error(`Session ${session.id} is not writable.`)
		}
		session.child.stdin.write(payload)
	}

	private handleSessionOutput(sessionId: string, chunk: string, _source: 'stdout' | 'stderr') {
		const session = this.sessions.get(sessionId)
		if (!session) return

		session.lastActivityAt = nowIso()
		fs.appendFileSync(session.sessionLogFile, chunk)

		const activeCommandId = session.activeCommandId
		if (!activeCommandId) return
		const command = session.commands.get(activeCommandId)
		if (!command) return

		fs.appendFileSync(command.outputFile, chunk)
		command.outputByteCount += Buffer.byteLength(chunk)
		command.archivedBytes = command.outputByteCount

		const mergedVisible = `${command.visibleOutput}${chunk}`
		const trimmed = trimVisibleOutput(mergedVisible)
		command.visibleOutput = trimmed.text
		command.truncatedInMemory = command.truncatedInMemory || trimmed.truncated
		command.pendingScanBuffer = `${command.pendingScanBuffer}${chunk}`

		const completionRegex = new RegExp(`(?:\\r?\\n)__OUTPOST_CMD_DONE__${escapeRegex(command.markerToken)}__(-?\\d+)\\r?\\n`)
		const match = completionRegex.exec(command.pendingScanBuffer)
		if (!match || match.index === undefined) return

		const matchText = match[0]
		const markerIndex = match.index
		const trailing = command.pendingScanBuffer.slice(markerIndex + matchText.length)

		const currentFileText = fs.readFileSync(command.outputFile, 'utf8')
		const trimmedFileText = currentFileText.replace(matchText, '')
		fs.writeFileSync(command.outputFile, trimmedFileText)
		command.outputByteCount = Buffer.byteLength(trimmedFileText)
		command.archivedBytes = command.outputByteCount
		command.visibleOutput = trimVisibleOutput(command.visibleOutput.replace(matchText, '')).text

		command.pendingScanBuffer = trailing
		this.completeCommand(session, command, Number.parseInt(match[1] ?? '0', 10), 'completed')
	}

	private handleSessionExit(sessionId: string, code: number | null, signal: NodeJS.Signals | null) {
		const session = this.sessions.get(sessionId)
		if (!session) return
		session.lastActivityAt = nowIso()
		session.lastExitCode = code
		if (session.status === 'closing' || session.status === 'closed') {
			session.status = 'closed'
			return
		}

		const activeCommand = session.activeCommandId ? session.commands.get(session.activeCommandId) : undefined
		if (activeCommand) {
			activeCommand.status = activeCommand.status === 'interrupted' ? 'interrupted' : 'failed'
			activeCommand.endedAt = nowIso()
			this.finishCommand(session, activeCommand, code, activeCommand.status)
		}

		session.status = signal ? 'failed' : 'closed'
	}

	private failSession(sessionId: string, error: Error) {
		const session = this.sessions.get(sessionId)
		if (!session) return
		session.status = 'failed'
		const activeCommand = session.activeCommandId ? session.commands.get(session.activeCommandId) : undefined
		if (activeCommand) {
			activeCommand.status = 'failed'
			activeCommand.endedAt = nowIso()
			this.finishCommand(session, activeCommand, null, 'failed', error)
		}
	}

	private completeCommand(
		session: TerminalSessionRecord,
		command: TerminalCommandRecord,
		exitCode: number | null,
		status: CommandStatus
	) {
		command.status = status
		command.exitCode = exitCode
		command.endedAt = nowIso()
		session.lastExitCode = exitCode
		this.finishCommand(session, command, exitCode, status)
	}

	private finishCommand(
		session: TerminalSessionRecord,
		command: TerminalCommandRecord,
		exitCode: number | null,
		status: CommandStatus,
		error?: Error
	) {
		if (command.timer) {
			clearTimeout(command.timer)
			command.timer = undefined
		}

		session.activeCommandId = undefined
		if (session.status !== 'closing' && session.status !== 'closed' && session.status !== 'failed') {
			session.status = 'idle'
		}

		const result: TerminalExecResult = {
			sessionId: session.id,
			commandId: command.id,
			status,
			waitMode: command.waitMode,
			exitCode,
			output: fs.existsSync(command.outputFile) ? fs.readFileSync(command.outputFile, 'utf8') : command.visibleOutput,
			cursor: 0,
			outputHandle: outputHandle(session.id, command.id),
			truncated: command.truncatedInMemory,
			totalBytes: command.outputByteCount,
			returnedBytes: command.outputByteCount,
			startedAt: command.startedAt,
			endedAt: command.endedAt,
			timeoutMs: command.timeoutMs
		}

		if (error) {
			command.reject?.(error)
			return
		}
		command.resolve?.(result)
	}

	private async timeoutCommand(sessionId: string, commandId: string) {
		const session = this.sessions.get(sessionId)
		if (!session || session.activeCommandId !== commandId) return
		const command = session.commands.get(commandId)
		if (!command || command.status !== 'running') return

		command.status = 'timed_out'
		command.endedAt = nowIso()
		await this.signalSession(session, 'SIGINT')

		setTimeout(() => {
			if (session.activeCommandId !== commandId) return
			void this.signalSession(session, 'SIGTERM')
		}, terminalKillGraceMs).unref()

		this.finishCommand(session, command, command.exitCode ?? null, 'timed_out')
	}

	private async signalSession(session: TerminalSessionRecord, signal: NodeJS.Signals) {
		if (session.child.killed) return
		if (process.platform !== 'win32' && session.child.pid) {
			process.kill(-session.child.pid, signal)
			return
		}
		session.child.kill(signal)
	}

	private async terminateSession(session: TerminalSessionRecord) {
		const activeCommand = session.activeCommandId ? session.commands.get(session.activeCommandId) : undefined
		if (activeCommand) {
			activeCommand.status = 'interrupted'
			activeCommand.endedAt = nowIso()
		}

		session.status = 'closing'

		try {
			await this.signalSession(session, 'SIGTERM')
		} catch {}

		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				try {
					void this.signalSession(session, 'SIGKILL')
				} catch {}
				resolve()
			}, terminalKillGraceMs)
			timer.unref()

			session.child.once('exit', () => {
				clearTimeout(timer)
				resolve()
			})
		})

		session.status = 'closed'
	}

	private async reapIdleSessions() {
		const now = Date.now()
		for (const [sessionId, session] of this.sessions.entries()) {
			if (session.status !== 'idle') continue
			const idleMs = now - new Date(session.lastActivityAt).getTime()
			if (idleMs < maxTerminalSessionIdleMs) continue
			await this.closeSession(sessionId).catch(() => {})
		}
	}
}

export type { ExecInput, SearchInput, TerminalExecResult }
export { TerminalManager }
